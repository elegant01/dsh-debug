// @yxzpro/dsh-debug — host half.
//
// Registers the debug_* tool family. Sessions, adapters and process cleanup
// live in lib/; this file only wires the manager to the host: workspace
// resolution through the live `workingDirectory` service (with an explicit
// `cwd` escape hatch), audit trail under ~/.dsh, and disposal with the
// plugin's lifecycle so no debuggee outlives the host.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DebugSessionManager, DebugArgumentError } from './lib/session.js'
import { makeDebugTools } from './lib/tools.js'

export const name = 'dsh-debug'

const AUDIT_PATH = path.join(os.homedir(), '.dsh', 'dsh-debug-audit.jsonl')

function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true })
    fs.appendFileSync(AUDIT_PATH, JSON.stringify(entry) + '\n', 'utf8')
  } catch {
    /* audit is best-effort */
  }
}

export function apply(ctx) {
  const manager = new DebugSessionManager({ onAudit: audit })

  const resolveWorkspace = async (exec, cwd) => {
    if (typeof cwd === 'string' && cwd.trim() !== '') {
      if (!path.isAbsolute(cwd)) throw new DebugArgumentError('cwd must be an absolute path', 'cwd')
      return path.resolve(cwd)
    }
    const service = ctx.get?.('workingDirectory')
    if (service && exec?.agent) {
      const resolved = await service.ensure(exec.agent, exec?.signal)
      if (typeof resolved === 'string' && path.isAbsolute(resolved)) return path.resolve(resolved)
    }
    throw new DebugArgumentError(
      'could not resolve the session workspace — pass an absolute `cwd`, or run inside a DSH session',
      'cwd',
    )
  }

  const tools = makeDebugTools(manager, resolveWorkspace)

  const registerAll = (toolsService) => {
    const disposers = []
    for (const definition of tools) {
      try {
        disposers.push(toolsService.register(definition))
      } catch (error) {
        ctx.logger?.warn?.(`dsh-debug: failed to register ${definition.name}: ${error?.message ?? error}`)
      }
    }
    return () => { for (const dispose of disposers) { try { dispose?.() } catch { /* gone */ } } }
  }

  // Prefer the service directly; fall back to an injected sub-context on
  // hosts that only expose `tools` through dependency injection.
  let unregister
  const toolsService = ctx.get?.('tools')
  if (toolsService) {
    unregister = registerAll(toolsService)
  } else {
    ctx.plugin({
      inject: ['tools'],
      apply(scoped) {
        unregister = registerAll(scoped.get('tools'))
      },
    })
  }

  ctx.effect(() => async () => {
    unregister?.()
    await manager.dispose()
  }, 'dsh-debug: lifecycle')

  audit({ time: new Date().toISOString(), event: 'plugin-loaded', tools: tools.map((t) => t.name) })
}
