/** Phase 4 listener (dev2 / old appwork): arm attach on 127.0.0.1:9003.
 *  Needs the tunnels up:
 *    ssh -N -R 9003:127.0.0.1:9003 goServer          (VM loopback → Windows)
 *    python3 /tmp/vm-dbgp-forward.py  (on the VM: docker0:9004 → loopback:9003)
 *  See docs/remote-debugging.md. */
import { DebugSessionManager } from '../lib/session.js'

const manager = new DebugSessionManager({ idleTtlMs: 600_000, onAudit: (e) => console.log('[audit]', e.event) })
const session = await manager.get('F:/centos/appwork', 'php')

const armed = await session.run({
  attach: true,
  port: 9003,
  pathMappings: [{ local: 'F:/centos/appwork', remote: '/data/app/app_default/wwwroot/appwork' }],
  breakpoints: [{ file: 'F:/centos/appwork/public/index.php', line: 24 }],
  expressions: ['LARAVEL_START > 0', 'phpversion()'],
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
const resumed = await session.continue('continue', 60_000)
console.log('RESUMED:', JSON.stringify({ status: resumed.status }))
await manager.dispose()
process.exit(0)
