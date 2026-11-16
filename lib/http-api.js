/**
 * Browser-facing HTTP API for the Debug sidebar tab.
 *
 * Routes (all under the registered /dsh-debug/api prefix):
 *   GET  /list                          → { sessions: [...] }
 *   POST /run      {workspace, language, program?, mode?, args?, breakpoints?, expressions?, timeoutMs?, attach?, port?, host?, pathMappings?}
 *   POST /continue {workspace, language, action?, timeoutMs?}
 *   GET  /state    ?workspace&language  → snapshot
 *   POST /eval     {workspace, language, expression}
 *   GET  /output   ?workspace&language&maxChars
 *   POST /stop     {workspace, language?}
 *
 * req/res are the host web server's node-style objects (req.url, req.method,
 * res.writeHead/res.end). The trust fence is the host's own
 * `connection.requestRejection` — the same one every built-in route uses.
 *
 * @module dsh-debug/lib/http-api
 */

import path from 'node:path'
import { redactText } from './redact.js'

/** The host's own fence: undefined means the request is trusted. */
export function trustFence(ctx) {
  return (req) => ctx.connection?.requestRejection?.(req) === undefined
}

function writeJson(res, code, value) {
  const body = JSON.stringify(value)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

async function readJson(req) {
  const text = await readBody(req)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('request body is not valid JSON')
  }
}

function requireWorkspace(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw Object.assign(new Error('workspace must be an absolute path'), { argument: 'workspace' })
  }
  return path.resolve(value)
}

function requireLanguage(value) {
  return value === 'php' ? 'php' : value === 'node' ? 'node' : 'go'
}

/**
 * @param {import('./session.js').DebugSessionManager} manager
 * @param {object} opts
 * @param {(req: object) => boolean} opts.fence
 * @param {(entry: object) => void} opts.audit
 */
export function makeApiHandler(manager, { fence, audit }) {
  return async (req, res) => {
    if (!fence(req)) {
      writeJson(res, 403, { ok: false, error: { code: 'forbidden', message: 'forbidden' } })
      return
    }
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const action = url.pathname.replace(/^\/dsh-debug\/api\/?/, '').replace(/\/+$/, '')

    try {
      switch (action) {
        case 'list': {
          if (req.method !== 'GET') throw Object.assign(new Error('GET only'), { status: 405 })
          writeJson(res, 200, { ok: true, sessions: manager.list() })
          return
        }
        case 'run': {
          const body = await readJson(req)
          const workspace = requireWorkspace(body.workspace)
          const language = requireLanguage(body.language)
          const session = await manager.get(workspace, language)
          audit({ time: new Date().toISOString(), event: 'api-run', workspace, language })
          const snapshot = await session.run({
            program: body.program,
            mode: body.mode,
            args: Array.isArray(body.args) ? body.args.map(String) : undefined,
            nodeArgs: Array.isArray(body.nodeArgs) ? body.nodeArgs.map(String) : undefined,
            breakpoints: body.breakpoints,
            expressions: body.expressions,
            timeoutMs: body.timeoutMs,
            attach: body.attach === true,
            port: body.port,
            host: body.host,
            pathMappings: body.pathMappings,
          })
          writeJson(res, 200, { ok: true, snapshot })
          return
        }
        case 'continue': {
          const body = await readJson(req)
          const session = await manager.get(requireWorkspace(body.workspace), requireLanguage(body.language))
          const snapshot = await session.continue(body.action ?? 'continue', body.timeoutMs ?? 60_000)
          writeJson(res, 200, { ok: true, snapshot })
          return
        }
        case 'state': {
          const workspace = requireWorkspace(url.searchParams.get('workspace'))
          const language = requireLanguage(url.searchParams.get('language'))
          const session = manager.sessions.get(`${language}:${workspace}`)
          if (!session) {
            writeJson(res, 200, { ok: true, snapshot: { status: 'no-session', workspace, language } })
            return
          }
          writeJson(res, 200, { ok: true, snapshot: await session.snapshotState([]) })
          return
        }
        case 'eval': {
          const body = await readJson(req)
          const session = await manager.get(requireWorkspace(body.workspace), requireLanguage(body.language))
          writeJson(res, 200, { ok: true, result: await session.evaluate(body.expression) })
          return
        }
        case 'output': {
          const workspace = requireWorkspace(url.searchParams.get('workspace'))
          const language = requireLanguage(url.searchParams.get('language'))
          const session = manager.sessions.get(`${language}:${workspace}`)
          if (!session) {
            writeJson(res, 200, { ok: true, output: '', state: 'no-session' })
            return
          }
          const maxChars = Number(url.searchParams.get('maxChars')) || undefined
          writeJson(res, 200, { ok: true, ...session.readOutput(maxChars) })
          return
        }
        case 'stop': {
          const body = await readJson(req)
          const language = ['php', 'node', 'go'].includes(body.language) ? body.language : undefined
          const result = await manager.stop(requireWorkspace(body.workspace), language)
          writeJson(res, 200, { ok: true, ...result })
          return
        }
        default:
          writeJson(res, 404, { ok: false, error: { code: 'not-found', message: `unknown route: ${action || '(root)'}` } })
      }
    } catch (err) {
      const status = err?.status ?? (err?.argument ? 400 : 500)
      writeJson(res, status, { ok: false, error: { code: err?.code ?? 'api-error', message: redactText(err?.message ?? String(err)), ...(err?.argument ? { argument: err.argument } : {}) } })
    }
  }
}
