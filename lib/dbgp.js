/**
 * DBGp client — the wire protocol Xdebug speaks.
 *
 * Unlike DAP, the debugger (Xdebug, inside PHP) connects TO us: we listen on
 * a TCP port, PHP dials in when a script starts with debugging armed, and the
 * first frame on the connection is Xdebug's `<init>` packet. After that the
 * protocol is synchronous request/response: `command -i <txn> [args]\0` in,
 * `<response transaction_id="txn" .../>\0` out.
 *
 * `run` / `step_*` responses arrive when the script pauses or ends, so "wait
 * for the next stop" is simply "wait for that command's response".
 *
 * @module dsh-debug/lib/dbgp
 */

import net from 'node:net'
import { EventEmitter } from 'node:events'
import { parseXml } from './xml.js'

/**
 * Read length-prefixed DBGp frames from a buffer.
 * Wire format: `<length>\0<xml>\0` — the length counts the XML bytes only.
 * Returns { frame, rest } or null when incomplete.
 */
function readFrame(buffer) {
  const headerEnd = buffer.indexOf(0)
  if (headerEnd === -1) return null
  const length = Number(buffer.subarray(0, headerEnd).toString('ascii'))
  if (!Number.isInteger(length) || length < 0) {
    throw new Error(`bad DBGp length prefix: ${JSON.stringify(buffer.subarray(0, headerEnd).toString('ascii'))}`)
  }
  const frameEnd = headerEnd + 1 + length
  if (buffer.length < frameEnd + 1) return null // wait for more bytes (and the trailing \0)
  return { frame: buffer.subarray(headerEnd + 1, frameEnd), rest: buffer.subarray(frameEnd + 1) }
}

/**
 * One accepted DBGp connection (one PHP process being debugged).
 */
export class DbgpConnection extends EventEmitter {
  /**
   * @param {net.Socket} socket
   * @param {object} init - parsed <init> packet (attrs + appid/idekey/fileuri)
   */
  constructor(socket, init) {
    super()
    this.socket = socket
    this.init = init
    this._txn = 0
    this._pending = new Map()
    this._buffer = Buffer.alloc(0)
    this._closed = false

    socket.on('data', (chunk) => this._feed(chunk))
    socket.on('error', (err) => this._failAll(err))
    socket.on('close', () => {
      this._closed = true
      this.emit('disconnected')
      this._failAll(new Error('DBGp connection closed'))
    })
  }

  /**
   * Send a DBGp command and wait for its response element.
   * @param {string} command - e.g. 'breakpoint_set'
   * @param {object} [opts]
   * @param {Record<string, string|number>} [opts.args] - flag args, e.g. { t: 'line', f: uri, n: 5 }
   * @param {string} [opts.data] - raw payload, sent base64-encoded after `--`
   * @param {number} [opts.timeoutMs] - default 30s; pass more for run/step (they block until a stop)
   * @returns {Promise<{attrs: object, children: object[], text: string}>} the <response> element
   */
  command(command, { args = {}, data, timeoutMs = 30_000 } = {}) {
    if (this._closed) return Promise.reject(new Error('DBGp connection is closed'))
    const txn = ++this._txn
    let frame = `${command} -i ${txn}`
    for (const [flag, value] of Object.entries(args)) {
      frame += ` -${flag} ${String(value)}`
    }
    if (data !== undefined) frame += ` -- ${Buffer.from(data, 'utf8').toString('base64')}`
    frame += '\0'

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(txn)
        reject(new Error(`${command}: no response from Xdebug within ${timeoutMs}ms`))
      }, timeoutMs)
      this._pending.set(txn, {
        command,
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (err) => { clearTimeout(timer); reject(err) },
      })
    })
    this.socket.write(frame)
    return promise
  }

  /** The command's <error> child, if the response carries one. */
  static errorOf(response) {
    const error = response.children.find((c) => c.name === 'error')
    if (!error) return null
    const message = error.children.find((c) => c.name === 'message')
    return message?.text ?? error.text ?? 'unknown DBGp error'
  }

  _feed(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk])
    for (;;) {
      let parsed
      try {
        parsed = readFrame(this._buffer)
      } catch (err) {
        this.emit('protocolError', err)
        this._buffer = Buffer.alloc(0)
        return
      }
      if (!parsed) return
      this._buffer = parsed.rest
      let root
      try {
        root = parseXml(parsed.frame.toString('utf8'))
      } catch (err) {
        this.emit('protocolError', err)
        continue
      }
      if (root.name === 'response') {
        const txn = Number(root.attrs.transaction_id)
        const pending = this._pending.get(txn)
        if (pending) {
          this._pending.delete(txn)
          const error = DbgpConnection.errorOf(root)
          if (error) {
            const err = new Error(error)
            err.command = pending.command
            pending.reject(err)
          } else {
            pending.resolve(root)
          }
        }
        this.emit('response', root)
      } else if (root.name === 'notify') {
        this.emit('notify', root)
      } else if (root.name === 'stream') {
        this.emit('stream', root)
      }
    }
  }

  _failAll(err) {
    for (const { reject } of this._pending.values()) reject(err)
    this._pending.clear()
  }

  close() {
    if (this._closed) return
    this._closed = true
    try { this.socket.destroy() } catch { /* gone */ }
    this._failAll(new Error('DBGp connection closed'))
    this.removeAllListeners()
  }
}

/**
 * DBGp listener: accepts Xdebug connections and hands each to a callback as a
 * DbgpConnection after the <init> packet.
 */
export class DbgpServer extends EventEmitter {
  constructor() {
    super()
    this.server = null
    this.port = null
  }

  /** Start listening; port 0 (default) picks an ephemeral port. Bind 0.0.0.0 only when remote debuggees (VM/container) must dial in. */
  async listen(port = 0, host = '127.0.0.1') {
    this.server = net.createServer((socket) => this._onSocket(socket))
    this.server.on('error', (err) => this.emit('error', err))
    await new Promise((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen({ port, host }, resolve)
    })
    this.port = this.server.address().port
    this.host = host
    return this.port
  }

  _onSocket(socket) {
    socket.setNoDelay(true)
    let buffer = Buffer.alloc(0)
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      let parsed
      try {
        parsed = readFrame(buffer)
      } catch (err) {
        socket.destroy()
        this.emit('badInit', err)
        return
      }
      if (!parsed) return
      socket.off('data', onData)
      let init
      try {
        const root = parseXml(parsed.frame.toString('utf8'))
        init = { appid: root.attrs.appid, idekey: root.attrs.idekey, fileuri: root.attrs.fileuri, language: root.attrs.language }
      } catch (err) {
        socket.destroy()
        this.emit('badInit', err)
        return
      }
      const connection = new DbgpConnection(socket, init)
      this.emit('connection', connection)
      if (parsed.rest.length > 0) connection._feed(parsed.rest)
    }
    socket.on('data', onData)
    socket.on('error', () => { /* peer vanishing before init is uninteresting */ })
  }

  /** Wait for the next connection, rejecting on timeout. */
  waitForConnection(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off('connection', onConnection)
        reject(new Error(`no debugger connected within ${timeoutMs}ms — is Xdebug armed (mode=debug, start_with_request=yes, client_host/port pointing here)?`))
      }, timeoutMs)
      const onConnection = (connection) => {
        clearTimeout(timer)
        resolve(connection)
      }
      this.once('connection', onConnection)
    })
  }

  async close() {
    if (!this.server) return
    await new Promise((resolve) => this.server.close(resolve))
    this.server = null
  }
}
