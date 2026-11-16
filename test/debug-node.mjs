/** Diagnostic: dump raw CDP paused params for a Node breakpoint. */
import { DebugSessionManager } from '../lib/session.js'
import { CdpConnection } from '../lib/cdp.js'

// Print raw paused frames.
const origEmit = CdpConnection.prototype.emit
CdpConnection.prototype.emit = function (name, ...args) {
  if (name === 'event:Debugger.paused') {
    console.log('[paused]', JSON.stringify(args[0], null, 2).slice(0, 3000))
  }
  return origEmit.call(this, name, ...args)
}

const m = new DebugSessionManager({ onAudit: () => {} })
const s = await m.get('F:/centos/dsh-debug/test/fixtures/node/hello', 'node')
const snap = await s.run({
  program: 'hello.js',
  breakpoints: [{ file: 'hello.js', line: 2 }],
  timeoutMs: 30000,
})
console.log('SNAPSHOT:', JSON.stringify({ status: snap.status, location: snap.location, stack: snap.stack?.slice(0, 3), locals: snap.locals, collectionError: snap.collectionError }, null, 2))
await m.dispose()
process.exit(0)
