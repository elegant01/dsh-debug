/**
 * Debug session: one debuggee process driven through DAP, plus the manager
 * that owns sessions per workspace and reaps idle ones.
 *
 * State machine per session:
 *
 *     launching → running ⇄ paused → terminated
 *                     └──────────→ exited (code known)
 *
 * `run()` is the workhorse: (re)spawns the adapter, applies breakpoints,
 * launches the target and resolves on the first stop, on exit, or on timeout
 * with the target still running. Everything the model needs to see is folded
 * into one structured snapshot so "run until this line and tell me what the
 * variables are" is a single tool call.
 *
 * @module dsh-debug/lib/session
 */

import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { once } from 'node:events'
import { DapClient, initialize } from './dap-client.js'
import { findDelve, launchArguments } from './delve.js'
import { redactText, redactValue } from './redact.js'

const IS_WINDOWS = process.platform === 'win32'

const OUTPUT_RING_LIMIT = 64 * 1024
const MAX_VARIABLE_CHILDREN = 100
const MAX_VARIABLE_DEPTH = 3
const MAX_VALUE_LENGTH = 2000
const MAX_STACK_FRAMES = 50

/** Argument mistake: the caller should fix the input, nothing ran. */
export class DebugArgumentError extends Error {
  constructor(message, argument) {
    super(message)
    this.code = 'INVALID_DEBUG_ARGUMENT'
    this.argument = argument
  }
}

/** Kill a process and (on Windows) its whole tree — the debuggee is a child of the adapter. */
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

function truncate(text, limit = MAX_VALUE_LENGTH) {
  if (typeof text !== 'string') return text
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit} chars]` : text
}

export class DebugSession {
  /**
   * @param {object} opts
   * @param {string} opts.workspace - absolute workspace directory
   * @param {string} [opts.dlvPath] - explicit dlv binary
   * @param {(entry: object) => void} [opts.onAudit] - audit sink
   */
  constructor({ workspace, dlvPath, onAudit }) {
    this.id = `dbg-${Math.random().toString(36).slice(2, 10)}`
    this.workspace = workspace
    this.dlvPath = dlvPath
    this.onAudit = onAudit ?? (() => {})
    this.state = 'terminated'
    /** @type {DapClient|null} */
    this.client = null
    this.child = null
    this.capabilities = {}
    this.lastActivity = Date.now()
    this.output = ''
    this.exitCode = null
    this._waiters = []
    /** @type {{id:number, name:string, line:number, column:number}[]} */
    this.stack = []
    this.currentThreadId = null
    this.currentStop = null
  }

  _touch() { this.lastActivity = Date.now() }

  _audit(event, detail = {}) {
    try {
      this.onAudit({ time: new Date().toISOString(), session: this.id, workspace: this.workspace, event, ...detail })
    } catch { /* audit must never break debugging */ }
  }

  /** Append adapter/debuggee output to the ring buffer. */
  _appendOutput(text) {
    if (!text) return
    this.output = (this.output + text).slice(-OUTPUT_RING_LIMIT)
  }

  /**
   * Launch (or relaunch) the debuggee and resolve on the first stop, exit, or timeout.
   *
   * @param {object} spec
   * @param {string} [spec.program] - package dir relative to the workspace, or absolute
   * @param {'debug'|'test'|'exec'} [spec.mode]
   * @param {string[]} [spec.args]
   * @param {{file:string, line:number, condition?:string}[]} [spec.breakpoints]
   * @param {string[]} [spec.expressions] - evaluated in the top frame at the first stop
   * @param {number} [spec.timeoutMs] - default 60s
   * @returns {Promise<object>} snapshot
   */
  async run(spec = {}) {
    const mode = spec.mode ?? 'debug'
    if (!['debug', 'test', 'exec'].includes(mode)) {
      throw new DebugArgumentError(`mode must be one of debug|test|exec, got ${JSON.stringify(mode)}`, 'mode')
    }
    const program = spec.program
      ? (path.isAbsolute(spec.program) ? spec.program : path.join(this.workspace, spec.program))
      : this.workspace
    const breakpoints = this._normalizeBreakpoints(spec.breakpoints ?? [])
    const expressions = Array.isArray(spec.expressions) ? spec.expressions.slice(0, 20) : []
    const timeoutMs = Number.isFinite(spec.timeoutMs) ? Math.min(Math.max(spec.timeoutMs, 1000), 300_000) : 60_000

    await this.stop() // a session runs one debuggee at a time
    this._generation = (this._generation ?? 0) + 1 // invalidate async leftovers from the previous run
    this._touch()
    this._audit('run', { program, mode, breakpoints, expressions })

    const dlv = findDelve(this.dlvPath)
    // `dlv dap` is TCP-only: it listens on an ephemeral port and prints
    // "DAP server listening at: 127.0.0.1:<port>" to stdout. We parse the
    // banner, then speak DAP over the socket.
    this.child = spawn(dlv, ['dap', '--listen=127.0.0.1:0'], {
      cwd: this.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    })
    let stderr = ''
    this.child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-8192)
    })
    this.state = 'launching'
    this._stopping = false
    this._finalizing = false
    this.exitCode = null
    this.output = ''
    this.stack = []
    this.currentStop = null

    // Everything below is bound to THIS run: handlers capture the child /
    // generation and refuse to act once a newer run (or stop()) has replaced
    // them. Without the guard, the previous adapter's death — taskkill is
    // asynchronous — lands in the middle of the next launch.
    const child = this.child
    const generation = this._generation
    const stale = () => generation !== this._generation || this.child !== child

    child.on('exit', () => {
      // This is the ADAPTER (dlv) exiting, not the debuggee — its code is
      // meaningless for the target. The session is over either way.
      if (stale()) return
      if (this.state !== 'terminated' && this.state !== 'exited') {
        this.state = this.exitCode !== null ? 'exited' : 'terminated'
        this._releaseWaiters({ type: this.state, code: this.exitCode })
      }
    })

    try {
      const port = await this._waitForListening(30_000)
      const socket = net.createConnection({ port, host: '127.0.0.1' })
      await once(socket, 'connect')
      const client = new DapClient({ stdin: socket, stdout: socket })
      this.client = client
      this.socket = socket

      // DAP runs over the socket, so everything dlv prints to stdout after
      // the banner is the debuggee's own output (the debuggee inherits it).
      child.stdout.on('data', (chunk) => {
        if (stale()) return
        this._appendOutput(`[process] ${chunk.toString('utf8')}`)
      })

      client.on('event:output', (body) => {
        if (stale()) return
        const category = body.category ?? 'stdout'
        const text = body.output ?? ''
        // Delve reports the debuggee's exit status as a console line, and
        // (in 1.24) often INSTEAD of an `exited` event — learn it from here.
        const exitMatch = /has exited with status (-?\d+)/.exec(text)
        if (exitMatch) this.exitCode = Number(exitMatch[1])
        this._appendOutput(`[${category}] ${text}`)
      })
      client.on('event:stopped', (body) => {
        if (stale() || this._stopping) return // teardown in progress — a late stop is noise
        this.state = 'paused'
        this.currentThreadId = body.threadId ?? this.currentThreadId
        this.currentStop = { reason: body.reason ?? 'unknown', threadId: this.currentThreadId }
        this._releaseWaiters({ type: 'stopped', reason: body.reason })
      })
      client.on('event:terminated', () => {
        if (stale() || this._stopping || this._finalizing || this.state === 'exited') return
        void this._finalizeTermination()
      })
      client.on('event:exited', (body) => {
        if (stale() || this._finalizing) return
        this.exitCode = body.exitCode ?? this.exitCode
        // The debuggee's last stdout chunks travel on dlv's own stdout pipe
        // and can land a beat after this event — drain before answering.
        setTimeout(() => {
          if (stale() || this._stopping) return
          this.state = 'exited'
          this._releaseWaiters({ type: 'exited', code: this.exitCode })
        }, 300).unref?.()
      })

      this.capabilities = await initialize(this.client)

      // `dlv dap` emits `initialized` once it is ready for breakpoint
      // configuration, before the debuggee starts. `launch` answers only
      // after the target is built — a cold `-gcflags=all=-N -l` build
      // recompiles the world, so this gets the generous timeout.
      const initialized = this._waitForEvent('initialized', 30_000)
      await this.client.request('launch', launchArguments({ mode, program, args: spec.args, cwd: this.workspace, env: spec.env }), 300_000)
      await initialized

      await this._setBreakpoints(breakpoints)
      // The waiter is registered before `configurationDone`: a fast debuggee
      // can hit a breakpoint or exit between the response and the wait, and
      // an event nobody listens for is a lost stop.
      const wait = this._waitStopOrEnd(timeoutMs)
      if (this.capabilities.supportsConfigurationDoneRequest !== false) {
        await this.client.request('configurationDone')
      }
      const outcome = await wait
      return await this._snapshot(outcome, expressions)
    } catch (err) {
      this._audit('run-error', { message: err.message })
      await this.stop()
      return {
        session: this.id,
        status: 'error',
        error: { code: err.code ?? 'LAUNCH_FAILED', message: redactText(err.message), stderr: redactText(stderr.slice(-2000)) },
      }
    }
  }

  /**
   * Continue / step the paused debuggee and resolve on the next stop, exit, or timeout.
   * @param {'continue'|'next'|'stepIn'|'stepOut'} action
   * @param {number} [timeoutMs]
   */
  async continue(action = 'continue', timeoutMs = 60_000) {
    this._requirePaused()
    const threadId = this.currentThreadId
    if (threadId === null) throw new Error('no stopped thread to continue')
    this._touch()
    this._audit('continue', { action })

    const command = { continue: 'continue', stepOver: 'next', stepIn: 'stepIn', stepOut: 'stepOut' }[action]
    if (!command) throw new DebugArgumentError(`action must be continue|stepOver|stepIn|stepOut, got ${JSON.stringify(action)}`, 'action')

    // Transition BEFORE arming the waiter: _waitStopOrEnd resolves
    // immediately when the state is already terminal/paused, and here the
    // pause being continued from must not satisfy the new wait.
    this.state = 'running'
    const wait = this._waitStopOrEnd(timeoutMs)
    await this.client.request(command, { threadId })
    const outcome = await wait
    return this._snapshot(outcome, [])
  }

  /** Current snapshot without running anything (poll while `running`). */
  async state(expressions = []) {
    this._touch()
    if (this.state === 'paused') return this._snapshot({ type: 'stopped', reason: this.currentStop?.reason }, expressions)
    return this._snapshot({ type: this.state === 'exited' ? 'exited' : this.state, code: this.exitCode }, [])
  }

  /** Evaluate an expression in the top stack frame of the paused debuggee. */
  async evaluate(expression) {
    this._requirePaused()
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw new DebugArgumentError('expression must be a non-empty string', 'expression')
    }
    this._touch()
    this._audit('eval', { expression })
    const frameId = this.stack[0]?.id
    try {
      const body = await this.client.request('evaluate', {
        expression,
        ...(frameId !== undefined ? { frameId } : {}),
        context: 'watch',
      })
      return {
        session: this.id,
        expression,
        result: truncate(body.result),
        type: body.type,
        variables: await this._expandVariables(body.variablesReference, 1),
      }
    } catch (err) {
      return { session: this.id, expression, error: { code: 'EVAL_FAILED', message: redactText(err.message) } }
    }
  }

  /** Read (and by default clear nothing from) the captured output tail. */
  readOutput(maxChars = 16_000) {
    this._touch()
    return { session: this.id, state: this.state, output: redactText(this.output.slice(-Math.min(maxChars, OUTPUT_RING_LIMIT))) }
  }

  /** Terminate the debuggee and the adapter. Idempotent. */
  async stop() {
    this._touch()
    this._stopping = true
    this._generation = (this._generation ?? 0) + 1
    const client = this.client
    const child = this.child
    const socket = this.socket
    this.client = null
    this.child = null
    this.socket = null
    if (this.state !== 'terminated' && this.state !== 'exited') {
      this._audit('stop')
    }
    this.state = 'terminated'
    if (client) {
      try { await Promise.race([client.request('disconnect', { terminateDebuggee: true }), delay(3000)]) } catch { /* adapter may be gone */ }
      client.close()
    }
    if (socket) { try { socket.destroy() } catch { /* gone */ } }
    if (child) killTree(child)
    this._releaseWaiters({ type: 'terminated' })
    return { session: this.id, status: 'terminated' }
  }

  // --- internals ------------------------------------------------------------

  _normalizeBreakpoints(breakpoints) {
    if (!Array.isArray(breakpoints)) {
      throw new DebugArgumentError('breakpoints must be an array of {file, line, condition?}', 'breakpoints')
    }
    return breakpoints.slice(0, 50).map((bp, i) => {
      if (!bp || typeof bp.file !== 'string' || bp.file.trim() === '') {
        throw new DebugArgumentError(`breakpoints[${i}].file must be a non-empty string`, 'breakpoints')
      }
      if (!Number.isInteger(bp.line) || bp.line < 1) {
        throw new DebugArgumentError(`breakpoints[${i}].line must be a positive integer`, 'breakpoints')
      }
      const file = path.isAbsolute(bp.file) ? bp.file : path.join(this.workspace, bp.file)
      return { file, line: bp.line, ...(typeof bp.condition === 'string' && bp.condition !== '' ? { condition: bp.condition } : {}) }
    })
  }

  async _setBreakpoints(breakpoints) {
    const byFile = new Map()
    for (const bp of breakpoints) {
      if (!byFile.has(bp.file)) byFile.set(bp.file, [])
      byFile.get(bp.file).push(bp)
    }
    const results = []
    for (const [file, bps] of byFile) {
      const body = await this.client.request('setBreakpoints', {
        source: { path: file },
        breakpoints: bps.map((bp) => ({ line: bp.line, ...(bp.condition ? { condition: bp.condition } : {}) })),
      })
      for (const [i, verified] of (body.breakpoints ?? []).entries()) {
        results.push({
          file, line: bps[i].line,
          verified: verified.verified === true,
          ...(verified.verified !== true && verified.message ? { message: redactText(verified.message) } : {}),
          ...(verified.line !== undefined && verified.line !== bps[i].line ? { actualLine: verified.line } : {}),
        })
      }
    }
    this._audit('breakpoints', { results })
    return results
  }

  _requirePaused() {
    if (!this.client) throw new Error('no debug session is running — call debug_run first')
    if (this.state !== 'paused') {
      throw new Error(`the debuggee is not paused (state: ${this.state}) — only paused debuggees answer state/step/eval requests`)
    }
  }

  /** Wait for the adapter's "DAP server listening at: 127.0.0.1:<port>" banner; resolve with the port. */
  _waitForListening(timeoutMs) {
    return new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error('dlv dap did not print its listening address in time'))
      }, timeoutMs)
      const onData = (chunk) => {
        buffer += chunk.toString('utf8')
        const match = /DAP server listening at:\s*[\w.]+:(\d+)/.exec(buffer)
        if (match) {
          cleanup()
          resolve(Number(match[1]))
        } else if (buffer.length > 16_384) {
          cleanup()
          reject(new Error(`unexpected dlv dap banner: ${redactText(buffer.slice(0, 500))}`))
        }
      }
      const onExit = (code) => {
        cleanup()
        reject(new Error(`dlv dap exited (code ${code}) before printing its listening address`))
      }
      const onError = (err) => {
        cleanup()
        reject(err)
      }
      const cleanup = () => {
        clearTimeout(timer)
        this.child?.stdout.off('data', onData)
        this.child?.off('exit', onExit)
        this.child?.off('error', onError)
      }
      this.child.stdout.on('data', onData)
      this.child.once('exit', onExit)
      this.child.once('error', onError)
    })
  }

  _waitForEvent(name, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.client?.off(`event:${name}`, onEvent)
        reject(new Error(`timed out waiting for the adapter's '${name}' event`))
      }, timeoutMs)
      const onEvent = (body) => {
        clearTimeout(timer)
        resolve(body)
      }
      this.client.once(`event:${name}`, onEvent)
    })
  }

  /** Resolve on the next stop/exit/termination, immediately if already there, or with {type:'running'} on timeout. */
  _waitStopOrEnd(timeoutMs) {
    if (this.state === 'paused') return Promise.resolve({ type: 'stopped', reason: this.currentStop?.reason })
    if (this.state === 'exited') return Promise.resolve({ type: 'exited', code: this.exitCode })
    if (this.state === 'terminated') return Promise.resolve({ type: 'terminated' })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter((w) => w !== waiter)
        resolve({ type: 'running', timeoutMs })
      }, timeoutMs)
      const waiter = (outcome) => { clearTimeout(timer); resolve(outcome) }
      this._waiters.push(waiter)
    })
  }

  /**
   * Wind down after a `terminated` event: ask the adapter to disconnect,
   * which makes Delve flush the "Process N has exited with status C" console
   * line (often sent lazily), then report the end with the exit code when
   * known. A debuggee that terminated has nothing left to pause or evaluate,
   * so the adapter is disposable here.
   */
  async _finalizeTermination() {
    this._finalizing = true
    // Capture the generation and the handles of THIS run — run()/stop()
    // replace this.client/this.child, and a stale finalizer must never touch
    // the next run's adapter.
    const generation = this._generation
    const client = this.client
    const child = this.child
    try {
      if (client) {
        try { await client.request('disconnect', { terminateDebuggee: true }, 3000) } catch { /* adapter may already be gone */ }
      }
      const deadline = Date.now() + 1500
      while (this.exitCode === null && Date.now() < deadline) await delay(100)
      if (generation !== this._generation || this._stopping) return // a new run or stop() took over
      this.state = this.exitCode !== null ? 'exited' : 'terminated'
      this._releaseWaiters({ type: this.state, code: this.exitCode })
      if (child) killTree(child)
    } finally {
      this._finalizing = false
    }
  }

  _releaseWaiters(outcome) {
    const waiters = this._waiters
    this._waiters = []
    for (const waiter of waiters) waiter(outcome)
  }

  /** Build the structured snapshot returned to tools. */
  async _snapshot(outcome, expressions) {
    this._touch()
    const snapshot = {
      session: this.id,
      status: outcome.type === 'stopped' ? 'paused' : outcome.type,
      workspace: this.workspace,
    }
    if (outcome.reason) snapshot.reason = outcome.reason
    if (outcome.code !== undefined && outcome.code !== null) snapshot.exitCode = outcome.code
    if (outcome.type === 'running') {
      snapshot.hint = 'still running after the timeout — poll debug_state, or debug_stop to kill it'
    }

    if (outcome.type === 'stopped' && this.client && this.currentThreadId !== null) {
      try {
        const { threads } = await this.client.request('threads')
        const threadId = this.currentThreadId ?? threads?.[0]?.id
        const { stackFrames } = await this.client.request('stackTrace', { threadId, startFrame: 0, levels: MAX_STACK_FRAMES })
        this.stack = (stackFrames ?? []).map((f) => ({ id: f.id, name: f.name, line: f.line, column: f.column, path: f.source?.path }))
        snapshot.stack = this.stack.map(({ name, line, path: p }) => ({ name, line, path: p }))
        const top = this.stack[0]
        if (top) {
          snapshot.location = { path: top.path, line: top.line, function: top.name }
          snapshot.locals = await this._readLocals(top.id)
        }
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

  /** Local + argument scopes of one frame, expanded within limits. */
  async _readLocals(frameId) {
    const body = await this.client.request('scopes', { frameId })
    const locals = {}
    for (const scope of (body.scopes ?? [])) {
      if (!/local|argument/i.test(scope.name ?? '')) continue
      const values = await this._expandVariables(scope.variablesReference, MAX_VARIABLE_DEPTH)
      if (values && typeof values === 'object') Object.assign(locals, values)
    }
    return locals
  }

  /** Expand a variablesReference into a plain value tree, bounded. */
  async _expandVariables(reference, depth) {
    if (!reference || reference === 0 || depth > MAX_VARIABLE_DEPTH) return undefined
    try {
      const body = await this.client.request('variables', { variablesReference: reference })
      const variables = (body.variables ?? []).slice(0, MAX_VARIABLE_CHILDREN)
      const out = {}
      for (const variable of variables) {
        if (variable.variablesReference > 0 && depth < MAX_VARIABLE_DEPTH && variable.type && !/^(string|int|uint|float|bool|complex|uintptr|error)/.test(variable.type)) {
          const children = await this._expandVariables(variable.variablesReference, depth + 1)
          out[variable.name] = children !== undefined && Object.keys(children).length > 0
            ? { _value: truncate(variable.value), ...children }
            : truncate(variable.value)
        } else {
          out[variable.name] = truncate(variable.value)
        }
      }
      return out
    } catch {
      return undefined
    }
  }
}

/**
 * Owns one session per workspace and reaps idle ones so a forgotten debuggee
 * never outlives its usefulness.
 */
export class DebugSessionManager {
  /**
   * @param {object} [opts]
   * @param {number} [opts.idleTtlMs] - default 10 minutes
   * @param {(entry: object) => void} [opts.onAudit]
   * @param {string} [opts.dlvPath]
   */
  constructor({ idleTtlMs = 600_000, onAudit, dlvPath } = {}) {
    this.idleTtlMs = idleTtlMs
    this.onAudit = onAudit ?? (() => {})
    this.dlvPath = dlvPath
    /** @type {Map<string, DebugSession>} workspace → session */
    this.sessions = new Map()
    this._reaper = setInterval(() => this._reap(), 30_000)
    this._reaper.unref?.()
  }

  /**
   * @param {string} workspace - absolute path
   * @returns {Promise<DebugSession>}
   */
  async get(workspace) {
    if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) {
      throw new DebugArgumentError('workspace must be an absolute path', 'workspace')
    }
    const key = path.resolve(workspace)
    let session = this.sessions.get(key)
    if (!session) {
      session = new DebugSession({ workspace: key, dlvPath: this.dlvPath, onAudit: this.onAudit })
      this.sessions.set(key, session)
    }
    return session
  }

  async stop(workspace) {
    const key = path.resolve(workspace)
    const session = this.sessions.get(key)
    if (!session) return { status: 'no-session', workspace: key }
    await session.stop()
    this.sessions.delete(key)
    return { status: 'terminated', workspace: key, session: session.id }
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      session: s.id, workspace: s.workspace, state: s.state,
      idleMs: Date.now() - s.lastActivity,
      ...(s.currentStop ? { stop: s.currentStop } : {}),
    }))
  }

  async _reap() {
    const now = Date.now()
    for (const [key, session] of this.sessions) {
      // Only a paused debuggee is ever idle-reaped: reaping a launching or
      // running one would kill a build/execution mid-flight. Terminated
      // entries hold no process and are just dropped from the map.
      if (session.state === 'terminated') {
        this.sessions.delete(key)
        continue
      }
      if (session.state !== 'paused') continue
      if (now - session.lastActivity > this.idleTtlMs) {
        this.onAudit({ time: new Date().toISOString(), session: session.id, workspace: key, event: 'idle-reap', idleMs: now - session.lastActivity })
        await session.stop()
        this.sessions.delete(key)
      }
    }
  }

  async dispose() {
    clearInterval(this._reaper)
    for (const [key, session] of this.sessions) {
      await session.stop()
      this.sessions.delete(key)
    }
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
