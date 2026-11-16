/** Phase 4 listener: arm attach on 127.0.0.1:9003 (SSH -R brings the VM in).
 *  Manual helper — needs the tunnel up:  ssh -N -R 9003:127.0.0.1:9003 goServer
 *  See docs/remote-debugging.md. */
import { DebugSessionManager } from '../lib/session.js'

const manager = new DebugSessionManager({ idleTtlMs: 600_000, onAudit: (e) => console.log('[audit]', e.event) })
const session = await manager.get('F:/centos/appwork-l13', 'php')

const armed = await session.run({
  attach: true,
  port: 9003,
  pathMappings: [{ local: 'F:/centos/appwork-l13', remote: '/var/www/html/appwork-l13' }],
  breakpoints: [{ file: 'F:/centos/appwork-l13/storage/app/_dsh_debug_probe.php', line: 4 }],
  expressions: ['$answer + 1', '$name'],
  timeoutMs: 5000,
})
console.log('armed:', JSON.stringify(armed.trigger))

const deadline = Date.now() + 120_000
while (!session._attachResult && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200))
if (!session._attachResult) {
  console.log('TIMEOUT: nothing connected')
  process.exit(1)
}
const snap = await session._attachResult
console.log('SNAPSHOT:', JSON.stringify({ status: snap.status, location: snap.location, locals: snap.locals, expressions: snap.expressions }, null, 2))
const resumed = await session.continue('continue', 15_000)
console.log('RESUMED:', JSON.stringify({ status: resumed.status, exitCode: resumed.exitCode }))
await manager.dispose()
process.exit(0)
