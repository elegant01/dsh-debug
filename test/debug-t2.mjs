/** Diagnostic: reuse one session for two runs, like the acceptance suite does. */
import { DebugSessionManager } from '../lib/session.js'
import { DapClient } from '../lib/dap-client.js'

const t0 = Date.now()
const stamp = () => `${String(Date.now() - t0).padStart(6)}ms`

// Log every DAP message the session layer receives.
const origDispatch = DapClient.prototype._dispatch
DapClient.prototype._dispatch = function (m) {
  console.log(stamp(), '[dap-in]', m.type, m.event ?? m.command ?? '', m.success === false ? 'FAIL' : '', m.message ?? '')
  return origDispatch.call(this, m)
}

const m = new DebugSessionManager({ onAudit: (e) => console.log(stamp(), '[audit]', e.event) })
const s = await m.get('F:/centos/dsh-debug/test/fixtures/go/hello')
const orig = s._appendOutput.bind(s)
s._appendOutput = (text) => { console.log(stamp(), '[ring]', JSON.stringify(text.slice(0, 80))); orig(text) }

console.log(stamp(), '--- run 1: breakpoint, then continue to exit')
const snap1 = await s.run({ mode: 'debug', breakpoints: [{ file: 'main.go', line: 14 }], timeoutMs: 60000 })
console.log(stamp(), 'run1:', snap1.status)
const cont = await s.continue('continue', 60000)
console.log(stamp(), 'continue:', cont.status, 'exitCode:', cont.exitCode)

console.log(stamp(), '--- run 2: no breakpoints')
const snap2 = await s.run({ mode: 'debug', timeoutMs: 60000 })
console.log(stamp(), 'run2:', snap2.status, 'exitCode:', snap2.exitCode)
console.log(stamp(), 'run2 outputTail:', JSON.stringify(snap2.outputTail))

await m.dispose()
process.exit(0)
