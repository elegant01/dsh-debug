/**
 * Phase 0 acceptance: drive the session layer directly (no DSH host) against
 * real Delve and real fixture programs.
 *
 *   node test/run-phase0.mjs
 *
 * Verifies: launch → breakpoint stop → locals/expressions → continue → exit;
 * no-breakpoint run exits cleanly; conditional breakpoints; a timed-out run
 * reports `running` and debug_stop leaves no orphan; a bad target comes back
 * as a structured error instead of a crash.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DebugSessionManager } from '../lib/session.js'
import { findDelve } from '../lib/delve.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELLO = path.join(HERE, 'fixtures', 'go', 'hello')
const SLEEPER = path.join(HERE, 'fixtures', 'go', 'sleeper')

/** Find the 1-based line of `// BP: <name>` inside a fixture source. */
function breakpointLine(file, name) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  const index = lines.findIndex((line) => line.includes(`// BP: ${name}`))
  assert.notEqual(index, -1, `marker '// BP: ${name}' not found in ${file}`)
  return index + 1
}

const results = []
async function test(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push({ name, ok: true, ms: Date.now() - started })
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`)
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, error: err })
    console.error(`  ✗ ${name}\n    ${err?.message ?? err}`)
  }
}

async function main() {
  const dlv = findDelve()
  console.log(`dlv: ${dlv}`)

  const manager = new DebugSessionManager({
    dlvPath: dlv,
    idleTtlMs: 600_000,
    onAudit: (entry) => console.log(`    [audit] ${entry.event}`),
  })

  const helloMain = path.join(HELLO, 'main.go')
  const greetLine = breakpointLine(helloMain, 'greet')
  const printLine = breakpointLine(helloMain, 'print')
  console.log(`fixtures: greet line ${greetLine}, print line ${printLine}`)

  await test('run stops at a breakpoint with locals and expressions, then continues to exit', async () => {
    const session = await manager.get(HELLO)
    const snapshot = await session.run({
      mode: 'debug',
      breakpoints: [{ file: 'main.go', line: greetLine }],
      expressions: ['count * 2', 'name'],
      timeoutMs: 120_000,
    })
    assert.equal(snapshot.status, 'paused', JSON.stringify(snapshot, null, 2))
    assert.match(snapshot.location?.path ?? '', /main\.go$/)
    assert.equal(snapshot.location?.line, greetLine)
    assert.equal(snapshot.locals?.count, '42')
    assert.equal(snapshot.locals?.name, '"ada"')
    assert.equal(snapshot.expressions?.['count * 2'], '84')
    assert.ok(snapshot.stack.length >= 2, 'stack should contain greet and main')

    const resumed = await session.continue('continue', 120_000)
    assert.ok(['exited', 'terminated'].includes(resumed.status), JSON.stringify(resumed, null, 2))
    assert.match(resumed.outputTail ?? '', /hello ada x42/)
    assert.match(resumed.outputTail ?? '', /done/)
  })

  await test('run without breakpoints exits with code 0', async () => {
    const session = await manager.get(HELLO)
    const snapshot = await session.run({ mode: 'debug', timeoutMs: 120_000 })
    assert.equal(snapshot.status, 'exited', JSON.stringify(snapshot, null, 2))
    assert.equal(snapshot.exitCode, 0)
    assert.match(snapshot.outputTail ?? '', /done/)
  })

  await test('conditional breakpoint fires only when the condition holds', async () => {
    const session = await manager.get(HELLO)
    const miss = await session.run({
      mode: 'debug',
      breakpoints: [{ file: 'main.go', line: greetLine, condition: 'count == 1' }],
      timeoutMs: 120_000,
    })
    assert.equal(miss.status, 'exited', JSON.stringify(miss, null, 2))

    const matches = await session.run({
      mode: 'debug',
      breakpoints: [{ file: 'main.go', line: greetLine, condition: 'count == 42' }],
      timeoutMs: 120_000,
    })
    assert.equal(matches.status, 'paused', JSON.stringify(matches, null, 2))
    await session.stop()
  })

  await test('a still-running program reports running, and stop leaves nothing behind', async () => {
    const session = await manager.get(SLEEPER)
    const snapshot = await session.run({ mode: 'debug', timeoutMs: 15_000 })
    assert.equal(snapshot.status, 'running', JSON.stringify(snapshot, null, 2))
    const pid = session.child?.pid
    assert.ok(pid, 'expected a live adapter process')

    const output = await session.readOutput()
    assert.match(output.output, /tick 0/)

    await manager.stop(SLEEPER)
    assert.equal(session.state, 'terminated')

    // The adapter (and its debuggee tree) must be gone.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    assert.equal(alive, false, `dlv process ${pid} should be dead`)
  })

  await test('a nonexistent target comes back as a structured error', async () => {
    const session = await manager.get(HELLO)
    const snapshot = await session.run({ mode: 'debug', program: './does-not-exist', timeoutMs: 30_000 })
    assert.equal(snapshot.status, 'error')
    assert.ok(snapshot.error?.message, 'expected an error message')
  })

  await test('evaluating while not paused is a structured error', async () => {
    const session = await manager.get(HELLO)
    let threw = false
    try {
      await session.evaluate('1 + 1')
    } catch (err) {
      threw = true
      assert.match(err.message, /not paused|no debug session/)
    }
    assert.equal(threw, true)
  })

  await manager.dispose()

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  if (failed.length > 0) {
    for (const f of failed) console.error(`FAILED: ${f.name}`)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
