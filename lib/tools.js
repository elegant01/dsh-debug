/**
 * Tool definitions registered with the host. Every tool validates its own
 * arguments (the host validates only `output.schema`; arguments reach
 * `execute` verbatim) and returns a structured object; `output.render`
 * serializes it for the model.
 *
 * Workspace resolution: an explicit `cwd` wins (useful for multi-root
 * workspaces), otherwise the host's live `workingDirectory` service answers
 * for the calling agent's session. Tools that need a paused debuggee say so
 * in their error, never in a crash.
 *
 * @module dsh-debug/lib/tools
 */

import path from 'node:path'
import { DebugArgumentError } from './session.js'
import { redactText } from './redact.js'

const OBJECT = { type: 'object' }
const RENDER_LIMIT = 48 * 1024

function render(_args, value) {
  let text
  try { text = JSON.stringify(value, null, 2) } catch { text = String(value) }
  if (text.length > RENDER_LIMIT) text = `${text.slice(0, RENDER_LIMIT)}\n…[+${text.length - RENDER_LIMIT} chars truncated]`
  return [{ type: 'text', text }]
}

/** Wrap an executor with uniform error folding: argument mistakes and runtime failures both come back as values. */
function fold(fn) {
  return async (args, exec) => {
    try {
      return await fn(args ?? {}, exec)
    } catch (err) {
      if (err instanceof DebugArgumentError || err?.code === 'INVALID_DEBUG_ARGUMENT') {
        return { status: 'error', error: { code: 'INVALID_ARGUMENT', message: err.message, ...(err.argument ? { argument: err.argument } : {}) } }
      }
      return { status: 'error', error: { code: err?.code ?? 'DEBUG_FAILED', message: redactText(err?.message ?? String(err)) } }
    }
  }
}

const BREAKPOINT_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Source file, absolute or relative to the workspace root.' },
      line: { type: 'integer', minimum: 1 },
      condition: { type: 'string', description: 'Optional expression; the breakpoint only fires when it is true.' },
    },
    required: ['file', 'line'],
    additionalProperties: false,
  },
}

/**
 * @param {import('./session.js').DebugSessionManager} manager
 * @param {(exec: object, cwd?: string) => Promise<string>} resolveWorkspace
 */
export function makeDebugTools(manager, resolveWorkspace) {
  const sessionFor = async (args, exec) => manager.get(await resolveWorkspace(exec, args.cwd))

  return [
    {
      name: 'debug_run',
      description: [
        'Launch the workspace program under the debugger (Go via Delve) and wait for the first breakpoint,',
        'program exit, or timeout. One call = set breakpoints + run + collect stack/locals/expressions.',
        'Returns a snapshot: status (paused|exited|terminated|running), location, stack, locals, requested',
        'expressions and output tail. When paused, use debug_eval / debug_continue / debug_state on the same',
        'workspace, and debug_stop when done. Never leaves an orphan: idle sessions are reaped automatically.',
      ].join(' '),
      parameters: {
        type: 'object',
        properties: {
          program: { type: 'string', description: 'Go package dir (mode debug/test) or binary (mode exec). Relative to the workspace root; defaults to the root.' },
          mode: { type: 'string', enum: ['debug', 'test', 'exec'], description: 'debug = build & run the package; test = run go test; exec = run a prebuilt binary.' },
          args: { type: 'array', items: { type: 'string' }, description: 'Argv for the debuggee.' },
          breakpoints: BREAKPOINT_SCHEMA,
          expressions: { type: 'array', items: { type: 'string' }, description: 'Expressions evaluated in the top frame at the first stop.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, description: 'How long to wait for a stop/exit before reporting still-running. Default 60000.' },
          cwd: { type: 'string', description: 'Workspace override (absolute). Defaults to the calling session\'s workspace.' },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT, render },
      execute: fold(async (args, exec) => {
        const session = await sessionFor(args, exec)
        return session.run({
          program: args.program,
          mode: args.mode,
          args: Array.isArray(args.args) ? args.args.map(String) : undefined,
          breakpoints: args.breakpoints,
          expressions: args.expressions,
          timeoutMs: args.timeoutMs,
        })
      }),
    },
    {
      name: 'debug_continue',
      description: 'Continue or step the paused debuggee (continue | stepOver | stepIn | stepOut) and return the snapshot at the next stop, exit, or timeout.',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['continue', 'stepOver', 'stepIn', 'stepOut'], description: 'Default: continue.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000 },
          cwd: { type: 'string', description: 'Workspace override (absolute).' },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT, render },
      execute: fold(async (args, exec) => {
        const session = await sessionFor(args, exec)
        return session.continue(args.action ?? 'continue', args.timeoutMs ?? 60_000)
      }),
    },
    {
      name: 'debug_state',
      description: 'Read the current debug session state without running anything: paused location, stack, locals, optionally extra expressions; or running/exited status. Safe to poll.',
      parameters: {
        type: 'object',
        properties: {
          expressions: { type: 'array', items: { type: 'string' } },
          cwd: { type: 'string', description: 'Workspace override (absolute).' },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT, render },
      execute: fold(async (args, exec) => {
        const workspace = await resolveWorkspace(exec, args.cwd)
        const existing = manager.sessions.get(path.resolve(workspace))
        if (!existing) return { status: 'no-session', workspace }
        return existing.state(Array.isArray(args.expressions) ? args.expressions.slice(0, 20) : [])
      }),
    },
    {
      name: 'debug_eval',
      description: 'Evaluate one expression in the top frame of the paused debuggee (e.g. `$order->status`, `len(items)`, `req.URL.Path`). The expression runs inside the debuggee process.',
      parameters: {
        type: 'object',
        properties: {
          expression: { type: 'string' },
          cwd: { type: 'string', description: 'Workspace override (absolute).' },
        },
        required: ['expression'],
        additionalProperties: false,
      },
      output: { schema: OBJECT, render },
      execute: fold(async (args, exec) => {
        const session = await sessionFor(args, exec)
        return session.evaluate(args.expression)
      }),
    },
    {
      name: 'debug_output',
      description: 'Read the debuggee\'s captured stdout/stderr tail without disturbing it.',
      parameters: {
        type: 'object',
        properties: {
          maxChars: { type: 'integer', minimum: 100, maximum: 65536 },
          cwd: { type: 'string', description: 'Workspace override (absolute).' },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT, render },
      execute: fold(async (args, exec) => {
        const session = await sessionFor(args, exec)
        return session.readOutput(args.maxChars)
      }),
    },
    {
      name: 'debug_stop',
      description: 'Terminate the debug session for the workspace: kills the debuggee and the adapter. Idempotent.',
      parameters: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Workspace override (absolute).' },
        },
        additionalProperties: false,
      },
      output: { schema: OBJECT, render },
      execute: fold(async (args, exec) => {
        const workspace = await resolveWorkspace(exec, args.cwd)
        return manager.stop(workspace)
      }),
    },
    {
      name: 'debug_list',
      description: 'List live debug sessions (workspace, state, idle time). Read-only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: OBJECT, render },
      execute: fold(async () => ({ sessions: manager.list() })),
    },
  ]
}
