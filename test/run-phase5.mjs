/**
 * Phase 5 acceptance: Node.js via the built-in inspector (CDP), driven
 * through the session layer against the local Node runtime.
 *
 *   node test/run-phase5.mjs
 *
 * Mirrors the Go/PHP suites: breakpoint pause with locals/expressions,
 * no-breakpoint exit with output, conditional breakpoints, timeout → running
 * → stop without orphans, and structured errors for bad targets.
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DebugSessionManager } from '../lib/session.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HELLO = path.join(HERE, 'fixtures', 'node', 'hello')
const SLEEPER = path.join(HERE, 'fixtures', 'node', 'sleeper')

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
    results.push({ name, ok: true })
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`)
  } catch (err) {
    results.push({ name, ok: false, error: err })
    console.error(`  ✗ ${name}\n    ${err?.message ?? err}`)
  }
}

async function main() {
  const manager = new DebugSessionManager({ idleTtlMs: 600_000, onAudit: (e) => console.log(`    [audit] ${e.event}`) })

  const helloFile = path.join(HELLO, 'hello.js')
  const greetLine = breakpointLine(helloFile, 'greet')
  const printLine = breakpointLine(helloFile, 'print')
  console.log(`node: ${process.execPath} ${process.version}`)
  console.log(`fixtures: greet line ${greetLine}, print line ${printLine}`)

  await test('node: run stops at a breakpoint with locals and expressions, then continues to exit', async () => {
    const session = await manager.get(HELLO, 'node')
    const snapshot = await session.run({
      program: 'hello.js',
      breakpoints: [{ file: 'hello.js', line: greetLine }],
      expressions: ['count * 2', 'name'],
      timeoutMs: 30_000,
    })
    assert.equal(snapshot.status, 'paused', JSON.stringify(snapshot, null, 2))
    assert.match(snapshot.location?.path ?? '', /hello\.js$/)
    assert.equal(snapshot.location?.line, greetLine)
    assert.equal(snapshot.locals?.count, '42')
    assert.equal(snapshot.locals?.name, '"ada"')
    assert.equal(snapshot.expressions?.['count * 2'], '84')
    assert.ok(snapshot.stack.length >= 2, 'stack should contain greet and the module scope')

    const resumed = await session.continue('continue', 30_000)
    assert.equal(resumed.status, 'exited', JSON.stringify(resumed, null, 2))
    assert.equal(resumed.exitCode, 0)
    assert.match(resumed.outputTail ?? '', /hello ada x42/)
    assert.match(resumed.outputTail ?? '', /done/)
  })

  await test('node: run without breakpoints exits with code 0 and full output', async () => {
    const session = await manager.get(HELLO, 'node')
    const snapshot = await session.run({ program: 'hello.js', timeoutMs: 30_000 })
    assert.equal(snapshot.status, 'exited', JSON.stringify(snapshot, null, 2))
    assert.equal(snapshot.exitCode, 0)
    assert.match(snapshot.outputTail ?? '', /done/)
  })

  await test('node: conditional breakpoint fires only when the condition holds', async () => {
    const session = await manager.get(HELLO, 'node')
    const miss = await session.run({
      program: 'hello.js',
      breakpoints: [{ file: 'hello.js', line: greetLine, condition: 'count === 1' }],
      timeoutMs: 30_000,
    })
    assert.equal(miss.status, 'exited', JSON.stringify(miss, null, 2))

    const hit = await session.run({
      program: 'hello.js',
      breakpoints: [{ file: 'hello.js', line: greetLine, condition: 'count === 42' }],
      timeoutMs: 30_000,
    })
    assert.equal(hit.status, 'paused', JSON.stringify(hit, null, 2))
    await session.stop()
  })

  await test('node: a still-running process reports running, and stop leaves nothing behind', async () => {
    const session = await manager.get(SLEEPER, 'node')
    const snapshot = await session.run({ program: 'sleeper.js', timeoutMs: 5_000 })
    assert.equal(snapshot.status, 'running', JSON.stringify(snapshot, null, 2))
    const pid = session.child?.pid
    assert.ok(pid, 'expected a live node process')

    const output = await session.readOutput()
    assert.match(output.output, /tick 0/)

    await manager.stop(SLEEPER, 'node')
    assert.equal(session.state, 'terminated')

    await new Promise((resolve) => setTimeout(resolve, 1500))
    let alive = true
    try { process.kill(pid, 0) } catch { alive = false }
    assert.equal(alive, false, `node process ${pid} should be dead`)
  })

  await test('node: a nonexistent script comes back as a structured error', async () => {
    const session = await manager.get(HELLO, 'node')
    const snapshot = await session.run({ program: 'does-not-exist.js', timeoutMs: 30_000 })
    assert.equal(snapshot.status, 'error')
    assert.ok(snapshot.error?.message, 'expected an error message')
  })

  await test('node: evaluating while not paused is a structured error', async () => {
    const session = await manager.get(HELLO, 'node')
    let threw = false
    try {
      await session.evaluate('count')
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
