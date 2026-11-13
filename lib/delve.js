/**
 * Delve adapter: executable discovery and DAP launch arguments for Go.
 *
 * `dlv dap` without `--listen` speaks DAP over its own stdin/stdout, which is
 * exactly what the session layer spawns. The adapter never forks the debuggee
 * itself — Delve builds and runs it (`mode: debug`), or runs tests
 * (`mode: test`), or attaches to an already-built binary (`mode: exec`).
 *
 * @module dsh-debug/lib/delve
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const IS_WINDOWS = process.platform === 'win32'

/**
 * Resolve the dlv executable.
 * Order: explicit argument → DSH_DEBUG_DLV env → PATH → GOPATH/bin → GOBIN.
 * @param {string} [explicit]
 * @returns {string} absolute path
 */
export function findDelve(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.DSH_DEBUG_DLV) candidates.push(process.env.DSH_DEBUG_DLV)
  candidates.push(IS_WINDOWS ? 'dlv.exe' : 'dlv') // PATH lookup by spawn
  try {
    const gopath = process.env.GOPATH || execFileSync('go', ['env', 'GOPATH'], { encoding: 'utf8' }).trim()
    if (gopath) candidates.push(path.join(gopath, 'bin', IS_WINDOWS ? 'dlv.exe' : 'dlv'))
  } catch { /* go not on PATH; PATH lookup above may still work */ }
  if (process.env.GOBIN) candidates.push(path.join(process.env.GOBIN, IS_WINDOWS ? 'dlv.exe' : 'dlv'))

  for (const candidate of candidates) {
    if (candidate.includes(path.sep) || candidate.includes('/')) {
      if (fs.existsSync(candidate)) return path.resolve(candidate)
      continue
    }
    // Bare name: probe PATH.
    const pathEnv = process.env.PATH || ''
    for (const dir of pathEnv.split(path.delimiter)) {
      const full = path.join(dir, candidate)
      if (fs.existsSync(full)) return full
    }
  }
  throw new Error(
    'dlv (Delve) was not found. Install it with `go install github.com/go-delve/delve/cmd/dlv@latest` '
    + 'or point DSH_DEBUG_DLV at the binary.',
  )
}

/**
 * Build the DAP `launch` arguments for a Go target.
 * @param {object} spec
 * @param {'debug'|'test'|'exec'} spec.mode
 * @param {string} spec.program - package dir (debug/test) or binary (exec)
 * @param {string[]} [spec.args] - debuggee argv
 * @param {string} [spec.cwd] - debuggee working directory
 * @param {Record<string,string>} [spec.env] - extra environment
 */
export function launchArguments(spec) {
  const args = {
    request: 'launch',
    mode: spec.mode,
    program: spec.program,
  }
  if (spec.args?.length) args.args = spec.args
  if (spec.cwd) args.cwd = spec.cwd
  if (spec.env && Object.keys(spec.env).length > 0) args.env = spec.env
  if (spec.mode === 'debug' || spec.mode === 'test') {
    // Disable optimizations/inlining so locals are actually readable.
    args.buildFlags = '-gcflags=all=-N -l'
  }
  return args
}
