/**
 * PHP debug session: one script run driven through DBGp (Xdebug 3).
 *
 * Same public interface as the Go/Delve session (run / continue / state /
 * evaluate / readOutput / stop) so the tool layer cannot tell which protocol
 * is underneath. Differences that matter:
 *
 * - Xdebug dials IN: the session listens on 127.0.0.1, spawns PHP armed with
 *   `xdebug.start_with_request=yes`, and the script connects back.
 * - `run`/`step_*` responses arrive when the script pauses or ends, so
 *   waiting for a stop == awaiting that command's response.
 * - The debuggee's stdout/stderr come straight from the PHP child process
 *   pipes — no proxying needed.
 * - The exit code is the PHP child's exit code (DBGp has no such concept).
 *
 * @module dsh-debug/lib/php-session
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { DbgpServer } from './dbgp.js'
import { findPhp, findXdebugExtension, phpArguments, pathToFileUri } from './xdebug.js'
import { redactText, redactValue } from './redact.js'

const IS_WINDOWS = process.platform === 'win32'

const OUTPUT_RING_LIMIT = 64 * 1024
const MAX_VARIABLE_CHILDREN = 100
const MAX_VALUE_LENGTH = 2000
const MAX_STACK_FRAMES = 50
const MAX_EVAL_DEPTH = 2

function truncate(text, limit = MAX_VALUE_LENGTH) {
  if (typeof text !== 'string') return text
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit} chars]` : text
}

function killTree(child) {
  if (!child || child.pid === undefined || child.exitCode !== null) return
  if (IS_WINDOWS) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* best effort */ }
  } else {
    try { child.kill('SIGKILL') } catch { /* already dead */ }
  }
}

/** DBGp file URI → filesystem path. Keeps Unix roots (`file:///var/…` → `/var/…`); drops the extra slash only for Windows drives (`file:///F:/…` → `F:/…`). */
function fileUriToPath(uri) {
  if (typeof uri !== 'string') return uri
  let p = uri.replace(/^file:\/\//, '')
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
  try { p = decodeURIComponent(p) } catch { /* leave as-is */ }
  return p
}

/** Convert a DBGp <property> element into a plain snapshot value. */
function propertyToValue(property, depth = 0) {
  const type = property.attrs.type ?? ''
  const raw = property.attrs.encoding === 'base64'
    ? Buffer.from(property.text ?? '', 'base64').toString('utf8')
    : (property.text ?? '')
  const children = property.children.filter((c) => c.name === 'property')
  if (children.length > 0 && depth < MAX_EVAL_DEPTH) {
    const out = {}
    for (const child of children.slice(0, MAX_VARIABLE_CHILDREN)) {
      const key = (child.attrs.name ?? '').replace(/^\$/, '') || child.attrs.fullname || '?'
      out[key] = propertyToValue(child, depth + 1)
    }
    const header = type === 'array' ? `array(${property.attrs.numchildren ?? children.length})` : (property.attrs.classname ?? type)
    return { _type: header, ...out }
  }
  if (type === 'array') return `array(${property.attrs.numchildren ?? '?'})`
  if (type === 'object') return `object(${property.attrs.classname ?? '?'})`
  if (type === 'string') return `"${truncate(raw)}"`
  if (type === 'bool') return raw === '1' ? 'true' : 'false'
  if (type === 'null' || type === 'uninitialized') return 'null'
  return truncate(raw) // int, float, resource, …
}

export class PhpDebugSession {
  constructor({ workspace, phpPath, xdebugExt, onAudit }) {
    this.id = `dbg-${Math.random().toString(36).slice(2, 10)}`
    this.language = 'php'
    this.workspace = workspace
    this.phpPath = phpPath
    this.xdebugExt = xdebugExt
    this.onAudit = onAudit ?? (() => {})
    this.state = 'terminated'
    this.server = null
    this.conn = null
    this.child = null
    this.lastActivity = Date.now()
    this.output = ''
    this.exitCode = null
    this.stack = []
    this.currentStop = null
    this._generation = 0
    this._stopping = false
    /** @type {Promise|null} the in-flight run/step command */
    this._pendingRun = null
  }

  _touch() { this.lastActivity = Date.now() }

  _audit(event, detail = {}) {
    try {
      this.onAudit({ time: new Date().toISOString(), session: this.id, workspace: this.workspace, language: 'php', event, ...detail })
    } catch { /* audit must never break debugging */ }
  }

  _appendOutput(text) {
    if (!text) return
    this.output = (this.output + text).slice(-OUTPUT_RING_LIMIT)
  }

  /**
   * Run a PHP script under Xdebug (CLI) or, with `attach: true`, arm the
   * DBGp listener and wait for a web/CLI process to dial in (Xdebug
   * `start_with_request=trigger` + the XDEBUG_SESSION trigger).
   *
   * `pathMappings: [{local, remote}]` translates workspace-local paths to
   * the paths Xdebug reports (containers, remote hosts) and back.
   */
  async run(spec = {}) {
    const breakpoints = this._normalizeBreakpoints(spec.breakpoints ?? [])
    const expressions = Array.isArray(spec.expressions) ? spec.expressions.slice(0, 20) : []
    const timeoutMs = Number.isFinite(spec.timeoutMs) ? Math.min(Math.max(spec.timeoutMs, 1000), 300_000) : 60_000
    this._pathMappings = this._normalizeMappings(spec.pathMappings)

    await this.stop()
    this._generation += 1
    const generation = this._generation
    const stale = () => generation !== this._generation
    this._touch()

    this.state = 'launching'
    this._stopping = false
    this.exitCode = null
    this.output = ''
    this.stack = []
    this.currentStop = null
    this._attachResult = null

    if (spec.attach) {
      this._audit('attach', { breakpoints, expressions, port: spec.port ?? 0, host: spec.host ?? '127.0.0.1' })
      return this._attach({ breakpoints, expressions, timeoutMs, port: spec.port, host: spec.host, stale })
    }

    const program = spec.program ?? ''
    const script = path.isAbsolute(program) ? program : path.join(this.workspace, program)
    this._audit('run', { script, breakpoints, expressions })

    const php = findPhp(this.phpPath)
    const xdebugExt = findXdebugExtension(this.xdebugExt)

    this.server = new DbgpServer()
    const port = await this.server.listen()

    this.child = spawn(php, phpArguments({ php, xdebugExt, script, args: spec.args ?? [], port }), {
      cwd: this.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    })
    const child = this.child
    child.stdout.on('data', (chunk) => { if (!stale()) this._appendOutput(chunk.toString('utf8')) })
    child.stderr.on('data', (chunk) => { if (!stale()) this._appendOutput(`[stderr] ${chunk.toString('utf8')}`) })
    child.on('exit', (code) => {
      if (stale()) return
      // The PHP child's exit code IS the script's exit code.
      if (this.exitCode === null) this.exitCode = code
      if (this.state !== 'exited' && this.state !== 'terminated') {
        this.state = 'exited'
        this._drainAndRelease()
      }
    })

    try {
      // A script that fails to start (missing file, parse error, no Xdebug)
      // exits without ever dialing in — surface that fast instead of waiting
      // out the full connect timeout.
      const childExit = new Promise((_, reject) => {
        child.once('exit', (code) => reject(new Error(`php exited (code ${code}) before Xdebug connected: ${redactText(this.output.slice(-500)) || 'no output'}`)))
      })
      this.conn = await Promise.race([this.server.waitForConnection(15_000), childExit])
    } catch (err) {
      this._audit('run-error', { message: err.message })
      await this.stop()
      return {
        session: this.id,
        status: 'error',
        error: { code: 'CONNECT_TIMEOUT', message: redactText(err.message) },
        outputTail: redactText(this.output.slice(-4096)) || undefined,
      }
    }

    return this._engage(this.conn, { breakpoints, expressions, timeoutMs, stale })
  }

  /**
   * Attach mode: listen for Xdebug to dial in. Waits up to timeoutMs for the
   * first connection; if none arrives, the session stays armed — the trigger
   * info tells the caller exactly how to make a request connect, and
   * debug_state picks the session up once it does.
   */
  async _attach({ breakpoints, expressions, timeoutMs, port, host, stale }) {
    this.state = 'armed'
    this.server = new DbgpServer()
    // Remote debuggees (VM/container) need a non-loopback bind. That exposes
    // the DBGp port to the LAN — only do it when the caller asked.
    const bindHost = host ?? '127.0.0.1'
    const actualPort = await this.server.listen(port ?? 0, bindHost)
    this._triggerInfo = {
      idekey: 'dsh-debug',
      urlParam: 'XDEBUG_SESSION=dsh-debug',
      cookie: 'XDEBUG_SESSION=dsh-debug',
      listen: `${bindHost}:${actualPort}`,
      xdebugConfig: `xdebug.mode=debug xdebug.start_with_request=trigger xdebug.client_port=${actualPort} xdebug.client_host=<this machine>`,
      ...(bindHost !== '127.0.0.1' ? { warning: `DBGp listener is exposed on ${bindHost} — any host that can reach it can drive a debug session` } : {}),
    }
    this._audit('attach-armed', { port: actualPort })

    // A connection can also arrive AFTER the initial wait (the user fires
    // the request late) — handle it whenever it comes.
    this.server.on('connection', (conn) => {
      if (stale() || this.conn) return
      const pending = this._engage(conn, { breakpoints, expressions, timeoutMs, stale })
      this._attachResult = pending
      pending.then((snapshot) => { this._attachSnapshot = snapshot }, () => {})
    })

    const conn = await Promise.race([
      this.server.waitForConnection(timeoutMs).catch(() => null),
      delay(timeoutMs).then(() => null),
    ])
    if (!conn) {
      return {
        session: this.id,
        status: 'armed',
        trigger: this._triggerInfo,
        hint: 'listener armed, no debugger connected yet — fire the request with the trigger (URL param or cookie), then poll debug_state',
        ...(this._pathMappings.length ? { pathMappings: this._pathMappings } : {}),
      }
    }
    return this._engage(conn, { breakpoints, expressions, timeoutMs, stale })
  }

  /** Common path once a DBGp connection exists: configure, break, run, snapshot. */
  async _engage(conn, { breakpoints, expressions, timeoutMs, stale }) {
    this.conn = conn
    conn.on('disconnected', () => {
      if (stale()) return
      if (this.state !== 'exited' && this.state !== 'terminated' && this.state !== 'launching' && this.state !== 'armed') {
        this.state = this.exitCode !== null ? 'exited' : 'terminated'
        this._drainAndRelease()
      }
    })

    try {
      await conn.command('feature_set', { args: { n: 'max_depth', v: String(MAX_EVAL_DEPTH + 1) } })
      await conn.command('feature_set', { args: { n: 'max_children', v: String(MAX_VARIABLE_CHILDREN) } })
      await conn.command('feature_set', { args: { n: 'max_data', v: String(MAX_VALUE_LENGTH * 4) } })

      await this._setBreakpoints(breakpoints)

      this.state = 'running'
      const outcome = await this._runAndWait('run', timeoutMs)
      return this._snapshot(outcome, expressions)
    } catch (err) {
      this._audit('run-error', { message: err.message })
      await this.stop()
      return {
        session: this.id,
        status: 'error',
        error: { code: err.code ?? 'LAUNCH_FAILED', message: redactText(err.message) },
        outputTail: redactText(this.output.slice(-4096)) || undefined,
      }
    }
  }

  /** Continue / step the paused script and resolve on the next stop, exit, or timeout. */
  async continue(action = 'continue', timeoutMs = 60_000) {
    this._requirePaused()
    this._touch()
    this._audit('continue', { action })
    const command = { continue: 'run', stepOver: 'step_over', stepIn: 'step_into', stepOut: 'step_out' }[action]
    if (!command) {
      throw Object.assign(new Error(`action must be continue|stepOver|stepIn|stepOut, got ${JSON.stringify(action)}`), { code: 'INVALID_DEBUG_ARGUMENT', argument: 'action' })
    }
    this.state = 'running'
    const outcome = await this._runAndWait(command, timeoutMs)
    return this._snapshot(outcome, [])
  }

  /** Current snapshot without running anything. */
  async snapshotState(expressions = []) {
    this._touch()
    if (this.state === 'paused') return this._snapshot({ type: 'stopped', reason: this.currentStop?.reason }, expressions)
    // Attach mode: a request that connected late already produced (or is
    // producing) a snapshot through _engage.
    if (this._attachSnapshot) return this._attachSnapshot
    if (this._attachResult) {
      if (this.state === 'running') {
        return { session: this.id, status: 'running', workspace: this.workspace, hint: 'the triggered request connected and is running — poll again or debug_stop' }
      }
      return Promise.resolve(this._attachResult)
    }
    if (this.state === 'armed') {
      return {
        session: this.id,
        status: 'armed',
        workspace: this.workspace,
        trigger: this._triggerInfo,
        hint: 'listener armed, no debugger connected yet — fire the request with the trigger, then poll debug_state',
      }
    }
    return this._snapshot({ type: this.state === 'exited' ? 'exited' : this.state, code: this.exitCode }, [])
  }

  /** Evaluate a PHP expression in the top frame of the paused script. */
  async evaluate(expression) {
    this._requirePaused()
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw Object.assign(new Error('expression must be a non-empty string'), { code: 'INVALID_DEBUG_ARGUMENT', argument: 'expression' })
    }
    this._touch()
    this._audit('eval', { expression })
    try {
      const response = await this.conn.command('eval', { data: expression })
      const property = response.children.find((c) => c.name === 'property')
      return {
        session: this.id,
        expression,
        result: property ? redactValue(propertyToValue(property)) : undefined,
      }
    } catch (err) {
      return { session: this.id, expression, error: { code: 'EVAL_FAILED', message: redactText(err.message) } }
    }
  }

  readOutput(maxChars = 16_000) {
    this._touch()
    return { session: this.id, state: this.state, output: redactText(this.output.slice(-Math.min(maxChars, OUTPUT_RING_LIMIT))) }
  }

  /** Kill the script and close the listener. Idempotent. */
  async stop() {
    this._touch()
    this._stopping = true
    this._generation += 1
    const conn = this.conn
    const child = this.child
    const server = this.server
    this.conn = null
    this.child = null
    this.server = null
    this._attachResult = null
    this._attachSnapshot = null
    if (this.state !== 'terminated' && this.state !== 'exited') this._audit('stop')
    this.state = 'terminated'
    if (conn) {
      try { await Promise.race([conn.command('stop', { timeoutMs: 2000 }), delay(2000)]) } catch { /* gone */ }
      conn.close()
    }
    if (child) killTree(child)
    if (server) await server.close().catch(() => {})
    this._releaseWaiters({ type: 'terminated' })
    return { session: this.id, status: 'terminated' }
  }

  // --- internals ------------------------------------------------------------

  /** Normalize [{local, remote}] path mappings (containers/remote hosts). */
  _normalizeMappings(mappings) {
    if (!Array.isArray(mappings)) return []
    return mappings.slice(0, 20).map((m, i) => {
      if (!m || typeof m.local !== 'string' || typeof m.remote !== 'string') {
        throw Object.assign(new Error(`pathMappings[${i}] needs {local, remote} strings`), { code: 'INVALID_DEBUG_ARGUMENT', argument: 'pathMappings' })
      }
      const norm = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '')
      return { local: norm(m.local), remote: norm(m.remote) }
    })
  }

  /** Local absolute path → the path Xdebug sees (for breakpoint_set). */
  _toRemote(file) {
    const normalized = path.resolve(file).replace(/\\/g, '/')
    for (const m of this._pathMappings ?? []) {
      if (normalized === m.local || normalized.startsWith(m.local + '/')) {
        return m.remote + normalized.slice(m.local.length)
      }
    }
    return normalized
  }

  /** Path Xdebug reported → local absolute path (for display). */
  _toLocal(remotePath) {
    if (typeof remotePath !== 'string') return remotePath
    const normalized = remotePath.replace(/\\/g, '/')
    for (const m of this._pathMappings ?? []) {
      if (normalized === m.remote || normalized.startsWith(m.remote + '/')) {
        return m.local + normalized.slice(m.remote.length)
      }
    }
    return remotePath
  }

  _normalizeBreakpoints(breakpoints) {
    if (!Array.isArray(breakpoints)) {
      throw Object.assign(new Error('breakpoints must be an array of {file, line, condition?}'), { code: 'INVALID_DEBUG_ARGUMENT', argument: 'breakpoints' })
    }
    return breakpoints.slice(0, 50).map((bp, i) => {
      if (!bp || typeof bp.file !== 'string' || bp.file.trim() === '') {
        throw Object.assign(new Error(`breakpoints[${i}].file must be a non-empty string`), { code: 'INVALID_DEBUG_ARGUMENT', argument: 'breakpoints' })
      }
      if (!Number.isInteger(bp.line) || bp.line < 1) {
        throw Object.assign(new Error(`breakpoints[${i}].line must be a positive integer`), { code: 'INVALID_DEBUG_ARGUMENT', argument: 'breakpoints' })
      }
      const file = path.isAbsolute(bp.file) ? bp.file : path.join(this.workspace, bp.file)
      return { file, line: bp.line, ...(typeof bp.condition === 'string' && bp.condition !== '' ? { condition: bp.condition } : {}) }
    })
  }

  async _setBreakpoints(breakpoints) {
    const results = []
    for (const bp of breakpoints) {
      // Line breakpoints with an optional condition (base64 payload after --).
      // The URI must be the path as Xdebug sees it (remote/container side) —
      // an already-mapped Unix absolute path must NOT go through the local
      // (Windows) path.resolve again.
      const remote = this._toRemote(bp.file)
      const uri = remote.startsWith('/') ? `file://${remote}` : pathToFileUri(remote)
      const response = await this.conn.command('breakpoint_set', {
        args: { t: 'line', f: uri, n: bp.line },
        ...(bp.condition ? { data: bp.condition } : {}),
      })
      results.push({ file: bp.file, line: bp.line, id: response.attrs.id, verified: true })
    }
    this._audit('breakpoints', { results })
    return results
  }

  /**
   * Send run/step and wait for the script to break or end — or report
   * 'running' when the timeout passes. The command stays pending in the
   * background either way; a later stop/kill settles it.
   */
  async _runAndWait(command, timeoutMs) {
    const conn = this.conn
    this._pendingRun = conn.command(command, { timeoutMs: timeoutMs + 30_000 }).then(
      (response) => {
        this._pendingRun = null
        const status = response.attrs.status
        if (status === 'break') {
          this.state = 'paused'
          this.currentStop = { reason: response.attrs.reason === 'ok' ? 'breakpoint' : (response.attrs.reason ?? 'breakpoint') }
          return { type: 'stopped', reason: this.currentStop.reason }
        }
        // 'stopping' / 'stopped': the script is done; the exit line follows.
        this.state = 'stopping'
        return { type: 'stopping' }
      },
      (err) => {
        this._pendingRun = null
        if (this._stopping) return { type: 'terminated' }
        throw err
      },
    )

    const raced = await Promise.race([this._pendingRun, delay(timeoutMs).then(() => null)])
    if (raced === null) return { type: 'running', timeoutMs }
    if (raced.type === 'stopping') {
      // Xdebug holds the request open until the session is wound down —
      // without `stop`, an HTTP response would never reach the client.
      try { await this.conn?.command('stop', { timeoutMs: 3000 }) } catch { /* connection may already be closing */ }
      // CLI mode: the PHP child's exit code follows shortly. Attach mode has
      // no child — there is no exit code to wait for.
      if (this.child) {
        const deadline = Date.now() + 10_000
        while (this.exitCode === null && Date.now() < deadline && !this._stopping) await delay(100)
      }
      if (this.state !== 'exited' && !this._stopping) {
        this.state = this.exitCode !== null ? 'exited' : 'terminated'
      }
      return { type: this.exitCode !== null ? 'exited' : 'terminated', code: this.exitCode }
    }
    return raced
  }

  /** Give the child's remaining stdout a beat to arrive, then settle. */
  _drainAndRelease() {
    setTimeout(() => this._releaseWaiters({ type: 'exited', code: this.exitCode }), 200).unref?.()
  }

  _releaseWaiters(_outcome) { /* PHP sessions settle via _runAndWait's promise */ }

  _requirePaused() {
    if (!this.conn) throw new Error('no debug session is running — call debug_run first')
    if (this.state !== 'paused') {
      throw new Error(`the script is not paused (state: ${this.state}) — only paused scripts answer state/step/eval requests`)
    }
  }

  async _snapshot(outcome, expressions) {
    this._touch()
    const snapshot = {
      session: this.id,
      status: outcome.type === 'stopped' ? 'paused' : outcome.type,
      workspace: this.workspace,
      language: 'php',
    }
    if (outcome.reason) snapshot.reason = outcome.reason
    if (outcome.code !== undefined && outcome.code !== null) snapshot.exitCode = outcome.code
    if (outcome.type === 'running') {
      snapshot.hint = 'still running after the timeout — poll debug_state, or debug_stop to kill it'
    }

    if (outcome.type === 'stopped' && this.conn) {
      try {
        const stackResponse = await this.conn.command('stack_get')
        this.stack = stackResponse.children
          .filter((c) => c.name === 'stack')
          .slice(0, MAX_STACK_FRAMES)
          .map((frame) => ({
            name: frame.attrs.where ?? frame.attrs.name ?? '?',
            line: Number(frame.attrs.lineno ?? frame.attrs.line ?? 0),
            path: this._toLocal(fileUriToPath(frame.attrs.filename ?? frame.attrs.fileuri)),
          }))
        snapshot.stack = this.stack
        const top = this.stack[0]
        if (top) snapshot.location = { path: top.path, line: top.line, function: top.name }
        snapshot.locals = await this._readLocals()
        for (const expression of expressions.slice(0, 20)) {
          snapshot.expressions = snapshot.expressions ?? {}
          const evaluated = await this.evaluate(expression)
          snapshot.expressions[expression] = evaluated.error ? { error: evaluated.error.message } : evaluated.result
        }
      } catch (err) {
        snapshot.collectionError = redactText(err.message)
      }
    }

    const tail = this.output.slice(-4096)
    if (tail) snapshot.outputTail = redactText(tail)
    return redactValue(snapshot)
  }

  /** Locals (context 0) of the top frame, flattened to name → value. */
  async _readLocals() {
    const response = await this.conn.command('context_get', { args: { d: 0, c: 0 } })
    const locals = {}
    for (const property of response.children.filter((c) => c.name === 'property')) {
      const key = (property.attrs.name ?? '').replace(/^\$/, '') || property.attrs.fullname || '?'
      locals[key] = propertyToValue(property)
    }
    return locals
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
