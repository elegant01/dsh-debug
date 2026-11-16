/**
 * Phase 3 acceptance: web attach. A real php -S server (Xdebug armed with
 * start_with_request=trigger) serves a fixture; the session attaches by
 * listening for Xdebug to dial in when a request carries the trigger.
 *
 *   node test/run-phase3.mjs
 *
 * Verifies: armed status + trigger info without a request; untriggered
 * requests never connect; a triggered request pauses at the breakpoint with
 * request-scoped locals; continue lets the HTTP response complete.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DebugSessionManager } from '../lib/session.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const WEB = path.join(HERE, 'fixtures', 'php', 'web')
const PHP = path.join(ROOT, '.tools', 'php74', 'php.exe')
const XDEBUG_EXT = path.join(ROOT, '.tools', 'php74', 'ext_xdebug', 'php_xdebug.dll')
const WEB_PORT = 18223

function breakpointLine(file, name) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const index = lines.findIndex((line) => line.includes(`// BP: ${name}`))
  assert.notEqual(index, -1, `marker '// BP: ${name}' not found in ${file}`)
  return index + 1
}

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, body }))
    })
    req.setTimeout(30_000, () => req.destroy(new Error('http timeout')))
    req.on('error', reject)
  })
}

const results = []
async function test(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`)
  } catch (err) {
    results.push({ name, ok: false, error: err })
    console.error(`  ✗ ${name}\n    ${err?.message ?? err}`)
  }
}

async function main() {
  assert.ok(fs.existsSync(PHP), `bundled PHP missing: ${PHP}`)
  assert.ok(fs.existsSync(XDEBUG_EXT), `bundled Xdebug missing: ${XDEBUG_EXT}`)
  const handleLine = breakpointLine(path.join(WEB, 'hello.php'), 'handle')
  console.log(`php: ${PHP}, web root: ${WEB}, handle line ${handleLine}`)

  const manager = new DebugSessionManager({ phpPath: PHP, xdebugExt: XDEBUG_EXT, idleTtlMs: 600_000, onAudit: () => {} })

  // Arm the listener first (attach with a short wait → status 'armed' + trigger info).
  const session = await manager.get(WEB, 'php')
  const armed = await session.run({ attach: true, breakpoints: [{ file: 'hello.php', line: handleLine }], timeoutMs: 3000 })
  assert.equal(armed.status, 'armed', JSON.stringify(armed, null, 2))
  const dbgpPort = Number(armed.trigger.listen.split(':')[1])
  assert.ok(dbgpPort > 0, `bad listener port in ${armed.trigger.listen}`)
  console.log(`  dbgp listener: ${armed.trigger.listen}`)

  // php -S with Xdebug armed in TRIGGER mode: nothing connects until a
  // request carries XDEBUG_SESSION.
  const phpServer = spawn(PHP, [
    '-d', `zend_extension=${XDEBUG_EXT}`,
    '-d', 'xdebug.mode=debug',
    '-d', 'xdebug.start_with_request=trigger',
    '-d', 'xdebug.client_host=127.0.0.1',
    '-d', `xdebug.client_port=${dbgpPort}`,
    '-S', `127.0.0.1:${WEB_PORT}`,
    '-t', WEB,
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  phpServer.stderr.on('data', () => {})
  await new Promise((r) => setTimeout(r, 1500))

  try {
    await test('web: untriggered request never connects', async () => {
      const res = await httpGet(`http://127.0.0.1:${WEB_PORT}/hello.php?name=plain`)
      assert.equal(res.status, 200)
      assert.match(res.body, /hello plain/)
      assert.equal(session.state, 'armed')
    })

    await test('web: triggered request pauses at the breakpoint, continue completes the response', async () => {
      const pending = httpGet(`http://127.0.0.1:${WEB_PORT}/hello.php?name=ada&XDEBUG_SESSION=dsh-debug`)
      const deadline = Date.now() + 10_000
      while (!session._attachResult && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
      assert.ok(session._attachResult, 'triggered request never connected to the listener')
      const snap = await session._attachResult
      assert.equal(snap.status, 'paused', JSON.stringify(snap, null, 2))
      assert.match(snap.location?.path ?? '', /hello\.php$/)
      assert.equal(snap.location?.line, handleLine)
      assert.equal(snap.locals?.name, '"ada"')

      const resumed = await session.continue('continue', 15_000)
      assert.ok(['exited', 'terminated'].includes(resumed.status), JSON.stringify(resumed, null, 2))
      const res = await pending
      assert.equal(res.status, 200)
      assert.match(res.body, /hello ada/)
    })
  } finally {
    phpServer.kill()
    await manager.dispose()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    for (const f of failed) console.error(`FAILED: ${f.name}`)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
