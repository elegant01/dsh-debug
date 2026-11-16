/**
 * Minimal WebSocket client (RFC 6455), just enough for CDP:
 * text frames in both directions, client masking, fragmentation, ping/pong,
 * close. No extensions — Node's inspector speaks plain WS without them.
 *
 * @module dsh-debug/lib/ws
 */

import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import { EventEmitter } from 'node:events'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export class WsClient extends EventEmitter {
  /**
   * @param {net.Socket} socket - established TCP socket
   * @param {object} handshake - the parsed 101 response headers
   */
  constructor(socket, handshake) {
    super()
    this.socket = socket
    this._buffer = Buffer.alloc(0)
    /** @type {Buffer[]} fragments of the message being assembled */
    this._fragments = []
    this._fragmentOpcode = 0
    this._closed = false

    socket.on('data', (chunk) => this._feed(chunk))
    socket.on('error', (err) => { this._closed = true; this.emit('error', err) })
    socket.on('close', () => { this._closed = true; this.emit('close') })
    // Baseline so a socket-level error in the window before the consumer
    // attaches its own handler cannot crash the process with an unhandled
    // 'error' event.
    this.on('error', () => {})
  }

  /**
   * HTTP-upgrade handshake. Resolves with the connected client.
   * @param {string} url - ws://host:port/path
   * @param {number} [timeoutMs]
   */
  static connect(url, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const target = new URL(url)
      const key = crypto.randomBytes(16).toString('base64')
      const timer = setTimeout(() => {
        req.destroy(new Error(`websocket handshake timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      const req = http.get({
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        headers: {
          connection: 'Upgrade',
          upgrade: 'websocket',
          'sec-websocket-key': key,
          'sec-websocket-version': '13',
        },
        timeout: timeoutMs,
      })
      req.on('upgrade', (res, socket) => {
        clearTimeout(timer)
        const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
        const accept = res.headers['sec-websocket-accept']
        if (accept !== expected) {
          socket.destroy()
          reject(new Error(`bad Sec-WebSocket-Accept: expected ${expected}, got ${accept}`))
          return
        }
        socket.setNoDelay(true)
        resolve(new WsClient(socket, res.headers))
      })
      req.on('error', (err) => { clearTimeout(timer); reject(err) })
      req.on('response', (res) => {
        clearTimeout(timer)
        reject(new Error(`websocket upgrade refused: HTTP ${res.statusCode}`))
      })
    })
  }

  /** Send a text message (client frames are masked per spec). */
  send(text) {
    if (this._closed) return
    this._write(encodeFrame(0x1, Buffer.from(text, 'utf8')))
  }

  /** Write guarded against a half-dead socket (write-after-end arrives async on modern Node). */
  _write(frame) {
    if (this.socket.destroyed || this.socket.writableEnded) return
    try { this.socket.write(frame) } catch { /* gone */ }
  }

  close() {
    if (this._closed) return
    this._closed = true
    this._write(encodeFrame(0x8, Buffer.alloc(0)))
    try { this.socket.end() } catch { /* gone */ }
    this.removeAllListeners()
  }

  _feed(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk])
    for (;;) {
      const frame = decodeFrame(this._buffer)
      if (!frame) return
      this._buffer = frame.rest
      if (frame.opcode === 0x9) { // ping → pong
        this._write(encodeFrame(0xA, frame.payload))
        continue
      }
      if (frame.opcode === 0x8) { // close
        this._closed = true
        this._write(encodeFrame(0x8, Buffer.alloc(0)))
        this.emit('close')
        continue
      }
      if (frame.opcode === 0xA) continue // pong
      if (frame.opcode === 0x0) { // continuation
        this._fragments.push(frame.payload)
      } else { // new message start (text 0x1 or binary 0x2)
        this._fragmentOpcode = frame.opcode
        this._fragments = [frame.payload]
      }
      if (frame.fin) {
        const message = Buffer.concat(this._fragments)
        this._fragments = []
        if (this._fragmentOpcode === 0x1) this.emit('message', message.toString('utf8'))
        else if (this._fragmentOpcode === 0x2) this.emit('messageBinary', message)
      }
    }
  }
}

function encodeFrame(opcode, payload) {
  const mask = crypto.randomBytes(4)
  const length = payload.length
  let header
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, 0x80 | length])
  } else if (length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 126
    header.writeUInt16BE(length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 0x80 | 127
    header.writeBigUInt64BE(BigInt(length), 2)
  }
  const masked = Buffer.allocUnsafe(length)
  for (let i = 0; i < length; i++) masked[i] = payload[i] ^ mask[i % 4]
  return Buffer.concat([header, mask, masked])
}

/** Parse one frame; returns { fin, opcode, payload, rest } or null when incomplete. */
function decodeFrame(buffer) {
  if (buffer.length < 2) return null
  const fin = (buffer[0] & 0x80) !== 0
  const opcode = buffer[0] & 0x0f
  const masked = (buffer[1] & 0x80) !== 0
  let length = buffer[1] & 0x7f
  let offset = 2
  if (length === 126) {
    if (buffer.length < 4) return null
    length = buffer.readUInt16BE(2)
    offset = 4
  } else if (length === 127) {
    if (buffer.length < 10) return null
    length = Number(buffer.readBigUInt64BE(2))
    offset = 10
  }
  const maskLength = masked ? 4 : 0
  if (buffer.length < offset + maskLength + length) return null
  let payload = buffer.subarray(offset + maskLength, offset + maskLength + length)
  if (masked) {
    const mask = buffer.subarray(offset, offset + 4)
    payload = Buffer.from(payload)
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
  }
  return { fin, opcode, payload, rest: buffer.subarray(offset + maskLength + length) }
}
