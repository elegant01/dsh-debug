/**
 * Node.js debug session: one Node process driven through its built-in
 * inspector (CDP over WebSocket). No external debugger required —
 * `node --inspect-brk=0` pauses before user code, we set breakpoints, resume.
 *
 * Same public interface as the Go/PHP sessions (run / continue /
 * snapshotState / evaluate / readOutput / stop). TypeScript works when Node
 * executes it (--experimental-strip-types on modern Node, or tsx/ts-node via
 * `nodeArgs`); breakpoint lines are the runtime's lines either way.
 *
 * @module dsh-debug/lib/node-session
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { WsClient } from './ws.js'
import { CdpConnection } from './cdp.js'
import { redactText, redactValue } from './redact.js'

const IS_WINDOWS = process.platform === 'win32'

const OUTPUT_RING_LIMIT = 64 * 1024
const MAX_VARIABLE_CHILDREN = 100
const MAX_VARIABLE_DEPTH = 2
const MAX_VALUE_LENGTH = 2000
const MAX_STACK_FRAMES = 50

function truncate(text, limit = MAX_VALUE_LENGTH) {
  if (typeof text !== 'string') return text
  return text.length > limit ? `${text.slice(0, limit)}…[+${text.length - limit} chars]` : text
}

function killTree(child) {
  if (!child || child.pid === undefined || child.exitCode !== null) return
  if (IS_WINDOWS) {
    try { spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }) } catch { /* best effort */ }
  } else {
    try { child.kill('SIGKILL') } catch { /* already dead */ }
  }
}

/** Absolute local path → the file:// URL Node reports for its scripts. */
function pathToFileUrl(file) {
  const normalized = path.resolve(file).replace(/\\/g, '/')
  return `file:///${normalized.replace(/^\//, '')}`
}

/** file:// URL (as Node reports it) → local path. */
function fileUrlToPath(url) {
  if (typeof url !== 'string' || !url.startsWith('file://')) return url
  let p = url.slice('file://'.length)
  if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
  try { p = decodeURIComponent(p) } catch { /* leave as-is */ }
  return p
}

/** Format one CDP RemoteObject as a snapshot scalar, expanding shallow objects. */
async function remoteToValue(cdp, remote, depth = 0) {
  if (!remote) return undefined
  if (remote.type === 'string') return `"${truncate(remote.value ?? '')}"`
  if (remote.type === 'number' || remote.type === 'boolean' || remote.type === 'bigint') return String(remote.value ?? remote.description)
  if (remote.type === 'undefined') return 'undefined'
  if (remote.type === 'symbol') return remote.description ?? 'symbol'
  if (remote.type === 'function') return truncate(remote.description ?? 'function')
  if (remote.subtype === 'null') return 'null'
  if (remote.objectId && depth < MAX_VARIABLE_DEPTH) {
    try {
      const { result } = await cdp.call('Runtime.getProperties', { objectId: remote.objectId, ownProperties: true })
      const entries = (result ?? []).filter((p) => p.enumerable !== false).slice(0, MAX_VARIABLE_CHILDREN)
      if (entries.length > 0) {
        const out = { _type: truncate(remote.description ?? remote.className ?? remote.type) }
        for (const entry of entries) {
          out[entry.name] = await remoteToValue(cdp, entry.value, depth + 1)
        }
        return out
      }
    } catch { /* fall through to description */ }
  }
  return truncate(remote.description ?? remote.className ?? remote.type ?? '?')
}

export class NodeDebugSession {
  constructor({ workspace, nodePath, onAudit }) {
    this.id = `dbg-${Math.random().toString(36).slice(2, 10)}`
    this.language = 'node'
    this.workspace = workspace
    this.nodePath = nodePath
    this.onAudit = onAudit ?? (() => {})
    this.state = 'terminated'
    this.child = null
    this.cdp = null
    this.lastActivity = Date.now()
    this.output = ''
    this.exitCode = null
    this.stack = []
    this.callFrames = []
    this.currentStop = null
    this._generation = 0
    this._stopping = false
    this._pendingRun = null
  }

  _touch() { this.lastActivity = Date.now() }

  _audit(event, detail = {}) {
    try {
      this.onAudit({ time: new Date().toISOString(), session: this.id, workspace: this.workspace, language: 'node', event, ...detail })
    } catch { /* audit must never break debugging */ }
  }

  _appendOutput(text) {
    if (!text) return
    this.output = (this.output + text).slice(-OUTPUT_RING_LIMIT)
  }

  /**
   * Launch a Node entry script under the inspector and resolve on the first
   * stop, exit, or timeout. `program` is the entry .js/.ts file.
   */
  async run(spec = {}) {
    if (!spec.program || typeof spec.program !== 'string') {
      throw Object.assign(new Error('Node debugging needs `program`: the entry .js/.ts file (absolute or relative to the workspace).'), { code: 'INVALID_DEBUG_ARGUMENT', argument: 'program' })
    }
    const script = path.isAbsolute(spec.program) ? spec.program : path.join(this.workspace, spec.program)
    const breakpoints = this._normalizeBreakpoints(spec.breakpoints ?? [])
    const expressions = Array.isArray(spec.expressions) ? spec.expressions.slice(0, 20) : []
    const timeoutMs = Number.isFinite(spec.timeoutMs) ? Math.min(Math.max(spec.timeoutMs, 1000), 300_000) : 60_000

    await this.stop()
    this._generation += 1
    const generation = this._generation
    const stale = () => generation !== this._generation
    this._touch()
    this._audit('run', { script, breakpoints, expressions })

    this.state = 'launching'
    this._stopping = false
    this.exitCode = null
    this.output = ''
    this.stack = []
    this.callFrames = []
    this.currentStop = null

    const node = this.nodePath ?? process.execPath
    // --inspect-brk=0: ephemeral port, pause before user code. The ws URL is
    // printed to stderr ("Debugger listening on ws://…").
    this.child = spawn(node, ['--inspect-brk=0', ...(Array.isArray(spec.nodeArgs) ? spec.nodeArgs.map(String) : []), script, ...(spec.args ?? [])], {
      cwd: this.workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    })
    const child = this.child
    child.stdout.on('data', (chunk) => { if (!stale()) this._appendOutput(chunk.toString('utf8')) })
    let stderrBuffer = ''
    let resolveWsUrl
    const wsUrl = new Promise((resolve, reject) => {
      resolveWsUrl = resolve
      const timer = setTimeout(() => reject(new Error('node did not print its inspector URL in time')), 15_000)
      child.stderr.on('data', (chunk) => {
        const text = chunk.toString('utf8')
        if (!stale()) this._appendOutput(`[stderr] ${text}`)
        stderrBuffer += text
        const match = /Debugger listening on (ws:\/\/[^\s]+)/.exec(stderrBuffer)
        if (match) {
          clearTimeout(timer)
          resolve(match[1])
        }
        // The program finished: modern Node keeps the process alive ONLY for
        // the attached inspector ("Waiting for the debugger to disconnect").
        // Let go — the child exit then delivers the real exit code.
        if (text.includes('Waiting for the debugger to disconnect') && !stale() && this.state === 'running') {
          this.cdp?.close()
        }
      })
      child.once('exit', (code) => reject(new Error(`node exited (code ${code}) before the inspector came up: ${redactText(stderrBuffer.slice(-500)) || 'no output'}`)))
    })

    child.on('exit', (code) => {
      if (stale()) return
      if (this.exitCode === null) this.exitCode = code
      if (this.state !== 'exited' && this.state !== 'terminated') {
        this.state = 'exited'
        this._drainAndRelease()
      }
    })

    try {
      const ws = await WsClient.connect(await wsUrl)
      this.cdp = new CdpConnection(ws)

      // Modern Node reports callFrames with an empty `url` and only a
      // scriptId — keep the scriptId → url map from scriptParsed events.
      this._scripts = new Map()
      this.cdp.on('event:Debugger.scriptParsed', (params) => {
        if (stale() || !params?.scriptId) return
        this._scripts.set(String(params.scriptId), params.url ?? '')
      })

      this.cdp.on('event:Debugger.paused', (params) => {
        if (stale() || this._stopping) return
        this.state = 'paused'
        this.callFrames = params.callFrames ?? []
        this.currentStop = { reason: params.reason ?? 'pause' }
        this._releaseWaiters({ type: 'stopped', reason: this.currentStop.reason, params })
      })
      this.cdp.on('event:Inspector.targetCrashed', () => {
        if (stale()) return
        this.state = 'terminated'
        this._releaseWaiters({ type: 'terminated' })
      })

      // `Debugger.enable` is what releases the --inspect-brk startup pause.
      const breakOnStart = this._waitForEvent('Debugger.paused', 30_000)
      breakOnStart.catch(() => {})
      // A script that fails to load exits before the startup pause lands.
      const childExit = new Promise((_, reject) => {
        child.once('exit', (code) => reject(new Error(`node exited (code ${code}) before the startup pause: ${redactText(this.output.slice(-500)) || 'no output'}`)))
      })
      await this.cdp.call('Runtime.enable')
      await this.cdp.call('Debugger.enable')
      // Modern Node holds the process in "waiting for debugger" until told
      // to run; the startup pause fires right after this.
      await this.cdp.call('Runtime.runIfWaitingForDebugger')
      await Promise.race([breakOnStart, childExit])

      await this._setBreakpoints(breakpoints)

      this.state = 'running'
      this._waiters = []
      const outcomePromise = this._waitStopOrExit(timeoutMs)
      await this.cdp.call('Debugger.resume')
      const outcome = await outcomePromise
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

  /** Continue / step the paused process and resolve on the next stop, exit, or timeout. */
  async continue(action = 'continue', timeoutMs = 60_000) {
    this._requirePaused()
    this._touch()
    this._audit('continue', { action })
    const command = { continue: 'Debugger.resume', stepOver: 'Debugger.stepOver', stepIn: 'Debugger.stepInto', stepOut: 'Debugger.stepOut' }[action]
    if (!command) {
      throw Object.assign(new Error(`action must be continue|stepOver|stepIn|stepOut, got ${JSON.stringify(action)}`), { code: 'INVALID_DEBUG_ARGUMENT', argument: 'action' })
    }
    this.state = 'running'
    const outcomePromise = this._waitStopOrExit(timeoutMs)
    await this.cdp.call(command)
    const outcome = await outcomePromise
    return this._snapshot(outcome, [])
  }

  /** Current snapshot without running anything. */
  async snapshotState(expressions = []) {
    this._touch()
    if (this.state === 'paused') return this._snapshot({ type: 'stopped', reason: this.currentStop?.reason }, expressions)
    return this._snapshot({ type: this.state === 'exited' ? 'exited' : this.state, code: this.exitCode }, [])
  }

  /** Evaluate a JS expression in the top frame of the paused process. */
  async evaluate(expression) {
    this._requirePaused()
    if (typeof expression !== 'string' || expression.trim() === '') {
      throw Object.assign(new Error('expression must be a non-empty string'), { code: 'INVALID_DEBUG_ARGUMENT', argument: 'expression' })
    }
    this._touch()
    this._audit('eval', { expression })
    const frameId = this.callFrames[0]?.callFrameId
    try {
      const { result, exceptionDetails } = await this.cdp.call('Debugger.evaluateOnCallFrame', {
        callFrameId: frameId,
        expression,
        generatePreview: false,
        returnByValue: false,
      })
      if (exceptionDetails) {
        return { session: this.id, expression, error: { code: 'EVAL_FAILED', message: redactText(exceptionDetails.text ?? exceptionDetails.exception?.description ?? 'evaluation failed') } }
      }
      return { session: this.id, expression, result: redactValue(await remoteToValue(this.cdp, result)) }
    } catch (err) {
      return { session: this.id, expression, error: { code: 'EVAL_FAILED', message: redactText(err.message) } }
    }
  }

  readOutput(maxChars = 16_000) {
    this._touch()
    return { session: this.id, state: this.state, output: redactText(this.output.slice(-Math.min(maxChars, OUTPUT_RING_LIMIT))) }
  }

  /** Kill the process and close the inspector. Idempotent. */
  async stop() {
    this._touch()
    this._stopping = true
    this._generation += 1
    const cdp = this.cdp
    const child = this.child
    this.cdp = null
    this.child = null
    if (this.state !== 'terminated' && this.state !== 'exited') this._audit('stop')
    this.state = 'terminated'
    if (cdp) cdp.close()
    if (child) killTree(child)
    this._releaseWaiters({ type: 'terminated' })
    return { session: this.id, status: 'terminated' }
  }

  // --- internals ------------------------------------------------------------

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
      const response = await this.cdp.call('Debugger.setBreakpointByUrl', {
        url: pathToFileUrl(bp.file),
        lineNumber: bp.line - 1, // CDP is 0-based
        ...(bp.condition ? { condition: bp.condition } : {}),
      })
      const locations = response.locations ?? []
      results.push({
        file: bp.file,
        line: bp.line,
        id: response.breakpointId,
        verified: locations.length > 0,
        ...(locations[0]?.lineNumber !== undefined ? { actualLine: locations[0].lineNumber + 1 } : {}),
      })
    }
    this._audit('breakpoints', { results })
    return results
  }

  _requirePaused() {
    if (!this.cdp) throw new Error('no debug session is running — call debug_run first')
    if (this.state !== 'paused') {
      throw new Error(`the process is not paused (state: ${this.state}) — only paused processes answer state/step/eval requests`)
    }
  }

  _waitForEvent(name, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.cdp?.off(`event:${name}`, onEvent)
        reject(new Error(`timed out waiting for '${name}'`))
      }, timeoutMs)
      const onEvent = (params) => {
        clearTimeout(timer)
        resolve(params)
      }
      this.cdp.once(`event:${name}`, onEvent)
    })
  }

  /** Resolve on the next pause/exit, immediately if already there, or with {type:'running'} on timeout. */
  _waitStopOrExit(timeoutMs) {
    if (this.state === 'paused') return Promise.resolve({ type: 'stopped', reason: this.currentStop?.reason })
    if (this.state === 'exited') return Promise.resolve({ type: 'exited', code: this.exitCode })
    if (this.state === 'terminated') return Promise.resolve({ type: 'terminated' })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this._waiters = (this._waiters ?? []).filter((w) => w !== waiter)
        resolve({ type: 'running', timeoutMs })
      }, timeoutMs)
      const waiter = (outcome) => { clearTimeout(timer); resolve(outcome) }
      this._waiters = [...(this._waiters ?? []), waiter]
    })
  }

  _drainAndRelease() {
    setTimeout(() => this._releaseWaiters({ type: 'exited', code: this.exitCode }), 200).unref?.()
  }

  _releaseWaiters(outcome) {
    const waiters = this._waiters ?? []
    this._waiters = []
    for (const waiter of waiters) waiter(outcome)
  }

  async _snapshot(outcome, expressions) {
    this._touch()
    const snapshot = {
      session: this.id,
      status: outcome.type === 'stopped' ? 'paused' : outcome.type,
      workspace: this.workspace,
      language: 'node',
    }
    if (outcome.reason) snapshot.reason = outcome.reason
    if (outcome.code !== undefined && outcome.code !== null) snapshot.exitCode = outcome.code
    if (outcome.type === 'running') {
      snapshot.hint = 'still running after the timeout — poll debug_state, or debug_stop to kill it'
    }

    if (outcome.type === 'stopped' && this.cdp && this.callFrames.length > 0) {
      try {
        this.stack = this.callFrames.slice(0, MAX_STACK_FRAMES).map((frame) => ({
          name: frame.functionName || '(anonymous)',
          line: (frame.location?.lineNumber ?? -1) + 1,
          path: fileUrlToPath(frame.url || this._scripts?.get(String(frame.location?.scriptId)) || ''),
        }))
        snapshot.stack = this.stack
        const top = this.stack[0]
        if (top) snapshot.location = { path: top.path, line: top.line, function: top.name }
        snapshot.locals = await this._readLocals(this.callFrames[0])
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

  /** Local + closure scopes of one call frame, flattened to name → value. */
  async _readLocals(callFrame) {
    const locals = {}
    for (const scope of (callFrame.scopeChain ?? [])) {
      if (scope.type !== 'local' && scope.type !== 'closure') continue
      try {
        const { result } = await this.cdp.call('Runtime.getProperties', { objectId: scope.object.objectId, ownProperties: true })
        for (const property of (result ?? []).slice(0, MAX_VARIABLE_CHILDREN)) {
          if (property.name === 'this' || property.name.startsWith('$')) continue
          locals[property.name] = await remoteToValue(this.cdp, property.value)
        }
      } catch { /* scope may be gone */ }
    }
    return locals
  }
}
