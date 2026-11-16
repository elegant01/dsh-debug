/**
 * Xdebug/PHP side of the world: find the PHP binary, arm Xdebug for one
 * script run, and translate paths to the file:// URIs DBGp wants.
 *
 * @module dsh-debug/lib/xdebug
 */

import fs from 'node:fs'
import path from 'node:path'

const IS_WINDOWS = process.platform === 'win32'

/**
 * Resolve the PHP executable.
 * Order: explicit argument → DSH_DEBUG_PHP env → PATH.
 * @param {string} [explicit]
 * @returns {string}
 */
export function findPhp(explicit) {
  const candidates = []
  if (explicit) candidates.push(explicit)
  if (process.env.DSH_DEBUG_PHP) candidates.push(process.env.DSH_DEBUG_PHP)
  candidates.push(IS_WINDOWS ? 'php.exe' : 'php')
  for (const candidate of candidates) {
    if (candidate.includes(path.sep) || candidate.includes('/')) {
      if (fs.existsSync(candidate)) return path.resolve(candidate)
      continue
    }
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      const full = path.join(dir, candidate)
      if (fs.existsSync(full)) return full
    }
  }
  throw new Error('php was not found. Put it on PATH or point DSH_DEBUG_PHP at the binary.')
}

/**
 * Resolve the Xdebug extension DLL/.so to load via -d zend_extension=…
 * Only needed when the PHP build does not already load Xdebug.
 * Order: explicit argument → DSH_DEBUG_XDEBUG env → undefined (assume loaded).
 * @param {string} [explicit]
 * @returns {string|undefined}
 */
export function findXdebugExtension(explicit) {
  const candidate = explicit ?? process.env.DSH_DEBUG_XDEBUG
  if (candidate && fs.existsSync(candidate)) return path.resolve(candidate)
  return undefined
}

/**
 * Absolute filesystem path → DBGp file URI.
 * Xdebug 3 compares breakpoint URIs against real paths; on Windows the drive
 * letter keeps its case and separators become slashes.
 * @param {string} file - absolute path
 */
export function pathToFileUri(file) {
  const normalized = path.resolve(file).replace(/\\/g, '/')
  return `file:///${normalized.replace(/^\//, '')}`
}

/**
 * Build the argv for one armed CLI run.
 * @param {object} spec
 * @param {string} spec.php
 * @param {string} [spec.xdebugExt]
 * @param {string} spec.script - absolute path of the entry script
 * @param {string[]} [spec.args]
 * @param {number} spec.port - DBGp listener port Xdebug should dial
 * @param {string} [spec.idekey]
 */
export function phpArguments({ php, xdebugExt, script, args = [], port, idekey = 'dsh-debug' }) {
  const argv = []
  if (xdebugExt) argv.push('-d', `zend_extension=${xdebugExt}`)
  argv.push(
    '-d', 'xdebug.mode=debug',
    '-d', 'xdebug.start_with_request=yes',
    '-d', 'xdebug.client_host=127.0.0.1',
    '-d', `xdebug.client_port=${port}`,
    '-d', `xdebug.idekey=${idekey}`,
    script,
    ...args,
  )
  return argv
}
