/** Phase 4 web: arm attach; the FPM request to dev3 triggers Xdebug through the SSH -R tunnel. */
import { DebugSessionManager } from '../lib/session.js'

const manager = new DebugSessionManager({ idleTtlMs: 600_000, onAudit: (e) => console.log('[audit]', e.event) })
const session = await manager.get('F:/centos/appwork-l13', 'php')

const armed = await session.run({
  attach: true,
  port: 9003,
  pathMappings: [{ local: 'F:/centos/appwork-l13', remote: '/var/www/html/appwork-l13' }],
  breakpoints: [{ file: 'F:/centos/appwork-l13/public/index.php', line: 14 }],
  expressions: ['LARAVEL_START > 0'],
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
console.log('SNAPSHOT:', JSON.stringify({ status: snap.status, location: snap.location, expressions: snap.expressions, localsCount: snap.locals ? Object.keys(snap.locals).length : 0 }, null, 2))
const resumed = await session.continue('continue', 30_000)
console.log('RESUMED:', JSON.stringify({ status: resumed.status }))
await manager.dispose()
process.exit(0)
