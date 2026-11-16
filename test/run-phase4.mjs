/**
 * Phase 4 acceptance: remote Xdebug on the VM (appwork-l13, php83 on the VM
 * host) dials into a listener on this Windows machine via the host-only
 * network (192.168.33.x). Requires: VM up, xdebug installed on php83,
 * Windows firewall allowing 9003.
 *
 *   node test/run-phase4.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { DebugSessionManager } from '../lib/session.js'

const exec = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))

const REMOTE_ROOT = '/var/www/html/appwork-l13'
const LOCAL_ROOT = 'F:/centos/appwork-l13'

async function ssh(script) {
  const { stdout, stderr } = await exec('ssh', ['goServer', script], { timeout: 60_000 })
  return { stdout, stderr }
}

async function main() {
  console.log('arming listener on 0.0.0.0:9003 (windows firewall must allow it)…')
  const manager = new DebugSessionManager({ idleTtlMs: 600_000, onAudit: () => {} })
  const session = await manager.get(LOCAL_ROOT, 'php')

  // Write a fixture script into the shared directory (visible on both sides).
  const fixtureLocal = path.join(LOCAL_ROOT, 'storage', 'app', '_dsh_debug_probe.php')
  fs.mkdirSync(path.dirname(fixtureLocal), { recursive: true })
  fs.writeFileSync(fixtureLocal, `<?php
$name = getenv('WHO') ?: 'vm';
$answer = 6 * 7; // BP: probe
echo "probe: $name $answer\\n";
`)
  const probeLine = 3
  const remoteScript = `${REMOTE_ROOT}/storage/app/_dsh_debug_probe.php`

  const armed = await session.run({
    attach: true,
    host: '0.0.0.0',
    port: 9003,
    pathMappings: [{ local: 'F:/centos/appwork-l13', remote: REMOTE_ROOT }],
    breakpoints: [{ file: path.join(LOCAL_ROOT, 'storage', 'app', '_dsh_debug_probe.php'), line: probeLine }],
    expressions: ['$answer + 1'],
    timeoutMs: 5000,
  })
  assert.equal(armed.status, 'armed', JSON.stringify(armed, null, 2))
  console.log('armed:', JSON.stringify(armed.trigger.listen))

  console.log('triggering on the VM (CLI, trigger env)…')
  const cliPromise = ssh(`cd ${REMOTE_ROOT} && XDEBUG_SESSION=dsh-debug /usr/local/php83/bin/php ${remoteScript}`).then(
    (r) => r,
    (e) => ({ stdout: '', stderr: String(e) }),
  )

  const deadline = Date.now() + 20_000
  while (!session._attachResult && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
  assert.ok(session._attachResult, 'VM Xdebug never connected to 192.168.33.1:9003 — check the windows firewall')
  const snap = await session._attachResult
  console.log('snapshot:', JSON.stringify({ status: snap.status, location: snap.location, locals: snap.locals, expressions: snap.expressions }, null, 2))
  assert.equal(snap.status, 'paused', JSON.stringify(snap, null, 2))
  // Path mapping: remote /var/www/html/… must come back as local F:/…
  assert.match(snap.location?.path ?? '', /^F:\/centos\/appwork-l13\//)
  assert.equal(snap.locals?.answer, '42')
  assert.equal(snap.expressions?.['$answer + 1'], '43')

  const resumed = await session.continue('continue', 15_000)
  assert.ok(['exited', 'terminated'].includes(resumed.status), JSON.stringify(resumed, null, 2))
  const cli = await cliPromise
  console.log('vm script output:', cli.stdout.trim())
  assert.match(cli.stdout, /probe: vm 42/)

  await manager.dispose()
  await ssh(`rm -f ${remoteScript}`).catch(() => {})
  fs.unlinkSync(fixtureLocal)
  console.log('\n1/1 passed')
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
