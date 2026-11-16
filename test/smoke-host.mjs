/**
 * Host smoke test: run the plugin's apply() against a stub host context, then
 * drive the registered HTTP API through a real PHP debug run — no DSH needed.
 *
 *   node test/smoke-host.mjs
 */

import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as plugin from '../index.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const HELLO = path.join(HERE, 'fixtures', 'php', 'hello')
const PHP = path.join(ROOT, '.tools', 'php74', 'php.exe')

process.env.DSH_DEBUG_PHP = PHP
process.env.DSH_DEBUG_XDEBUG = path.join(ROOT, '.tools', 'php74', 'ext_xdebug', 'php_xdebug.dll')

// --- fake host context -------------------------------------------------------

const registeredTools = []
const registeredRoutes = []
const effects = []

const ctx = {
  logger: { warn: (...a) => console.log('[warn]', ...a) },
  get(name) {
    return name === 'tools' ? toolsService : undefined
  },
  plugin() { throw new Error('unexpected: tools service should be direct') },
  effect(fn, label) { effects.push({ fn, label }) },
  connection: { requestRejection: () => undefined },
  webServer: {
    register(route) {
      registeredRoutes.push(route)
      return () => {}
    },
  },
}
const toolsService = { register: (def) => { registeredTools.push(def); return () => {} } }

// --- fake req/res ------------------------------------------------------------

function fakeReq(method, url, body) {
  const listeners = {}
  return {
    method,
    url,
    on(event, fn) { listeners[event] = fn },
    destroy() {},
    send() {
      if (body !== undefined) {
        listeners.data?.(Buffer.from(JSON.stringify(body)))
      }
      listeners.end?.()
    },
  }
}

function fakeRes() {
  return {
    statusCode: 0,
    body: '',
    writeHead(code) { this.statusCode = code },
    end(chunk) { this.body = chunk ?? '' },
    json() { return JSON.parse(this.body) },
  }
}

async function callApi(route, method, url, body) {
  const req = fakeReq(method, url, body)
  const res = fakeRes()
  const done = route.handler(req, res)
  req.send()
  await done
  return res
}

// --- run -----------------------------------------------------------------------

await plugin.apply(ctx)
console.log('tools registered:', registeredTools.map((t) => t.name).join(', '))
assert.equal(registeredTools.length, 7)
assert.equal(registeredRoutes.length, 1)
assert.equal(registeredRoutes[0].kind, 'prefix')

const api = registeredRoutes[0]

const runRes = await callApi(api, 'POST', '/dsh-debug/api/run', {
  workspace: HELLO,
  language: 'php',
  program: 'hello.php',
  breakpoints: [{ file: 'hello.php', line: 5 }],
  expressions: ['$count * 10'],
  timeoutMs: 30_000,
})
assert.equal(runRes.statusCode, 200, runRes.body)
const snap = runRes.json().snapshot
assert.equal(snap.status, 'paused', runRes.body)
assert.equal(snap.locals?.count, '42')
assert.equal(snap.expressions?.['$count * 10'], '420')
console.log('api run → paused at', snap.location.path + ':' + snap.location.line)

const contRes = await callApi(api, 'POST', '/dsh-debug/api/continue', { workspace: HELLO, language: 'php', action: 'continue' })
assert.equal(contRes.statusCode, 200, contRes.body)
assert.equal(contRes.json().snapshot.status, 'exited', contRes.body)
assert.match(contRes.json().snapshot.outputTail ?? '', /done/)
console.log('api continue → exited, output captured')

const listRes = await callApi(api, 'GET', '/dsh-debug/api/list')
assert.equal(listRes.statusCode, 200)
assert.ok(listRes.json().sessions.length >= 1)
console.log('api list →', JSON.stringify(listRes.json().sessions.map((s) => `${s.language}:${s.state}`)))

const stopRes = await callApi(api, 'POST', '/dsh-debug/api/stop', { workspace: HELLO })
assert.equal(stopRes.json().status, 'terminated')
console.log('api stop → terminated')

// lifecycle disposer
for (const e of effects) await e.fn()
console.log('\nhost smoke: all good')
process.exit(0)
