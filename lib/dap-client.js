/**
 * Minimal DAP (Debug Adapter Protocol) client over stdio.
 *
 * Speaks the wire format with the debug adapter's stdin/stdout:
 *
 *     Content-Length: <bytes>\r\n\r\n<json>
 *
 * Only what a launch-style session needs: request/response correlation by
 * `seq`, `request_seq` matching, and an EventEmitter surface for adapter
 * events (`stopped`, `output`, `terminated`, `exited`, `initialized`, …).
 *
 * The client is deliberately small: no capabilities negotiation beyond what
 * callers ask for, no reverse requests (adapters like `dlv dap` do not use
 * them in stdio mode; unknown reverse requests are answered with an error so
 * the adapter never hangs waiting for us).
 *
 * @module dsh-debug/lib/dap-client
 */

import { EventEmitter } from 'node:events'

const HEADER_TERMINATOR = Buffer.from('\r\n\r\n')

export class DapClient extends EventEmitter {
  /**
   * @param {object} io
   * @param {import('node:stream').Writable} io.stdin - adapter's stdin
   * @param {import('node:stream').Readable} io.stdout - adapter's stdout
   */
  constructor({ stdin, stdout }) {
    super()
    this._stdin = stdin
    this._seq = 0
    /** @type {Map<number, {resolve: Function, reject: Function, command: string}>} */
    this._pending = new Map()
    this._buffer = Buffer.alloc(0)
    this._closed = false

    stdout.on('data', (chunk) => this._feed(chunk))
    stdout.on('error', (err) => this._failAll(err))
    stdout.on('end', () => this._failAll(new Error('adapter stdout ended')))
  }

  /**
   * Send a DAP request and wait for its response.
   * Rejects on transport failure or when the adapter answers `success:false`.
   * @param {string} command
   * @param {object} [args]
   * @returns {Promise<object>} the response `body` (or `{}` when absent)
   */
  async request(command, args = undefined) {
    if (this._closed) throw new Error('DAP client is closed')
    const seq = ++this._seq
    const message = { seq, type: 'request', command }
    if (args !== undefined) message.arguments = args
    const body = Buffer.from(JSON.stringify(message), 'utf8')
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
      body,
    ])
    const promise = new Promise((resolve, reject) => {
      this._pending.set(seq, { resolve, reject, command })
    })
    this._stdin.write(frame)
    return promise
  }

  /** Close the transport; pending requests reject. */
  close() {
    if (this._closed) return
    this._closed = true
    this._failAll(new Error('DAP client closed'))
    try { this._stdin.end() } catch { /* already gone */ }
  }

  _feed(chunk) {
    this._buffer = Buffer.concat([this._buffer, chunk])
    for (;;) {
      const headerEnd = this._buffer.indexOf(HEADER_TERMINATOR)
      if (headerEnd === -1) return
      const header = this._buffer.subarray(0, headerEnd).toString('utf8')
      const match = /Content-Length:\s*(\d+)/i.exec(header)
      if (!match) {
        // Malformed frame; drop one byte to avoid an infinite loop.
        this._buffer = this._buffer.subarray(1)
        continue
      }
      const length = Number(match[1])
      const frameEnd = headerEnd + 4 + length
      if (this._buffer.length < frameEnd) return
      const payload = this._buffer.subarray(headerEnd + 4, frameEnd)
      this._buffer = this._buffer.subarray(frameEnd)
      let message
      try {
        message = JSON.parse(payload.toString('utf8'))
      } catch (err) {
        this.emit('protocolError', err)
        continue
      }
      this._dispatch(message)
    }
  }

  _dispatch(message) {
    if (message.type === 'response') {
      const pending = this._pending.get(message.request_seq)
      if (!pending) return
      this._pending.delete(message.request_seq)
      if (message.success === false) {
        const err = new Error(message.message || `${pending.command} failed`)
        err.command = pending.command
        err.body = message.body
        pending.reject(err)
      } else {
        pending.resolve(message.body ?? {})
      }
      return
    }
    if (message.type === 'event') {
      this.emit('event', message)
      this.emit(`event:${message.event}`, message.body ?? {})
      return
    }
    if (message.type === 'request') {
      // Reverse request we do not implement — answer so the adapter proceeds.
      const answer = {
        seq: ++this._seq,
        type: 'response',
        request_seq: message.seq,
        command: message.command,
        success: false,
        message: 'reverse requests are not supported by this client',
      }
      const body = Buffer.from(JSON.stringify(answer), 'utf8')
      try {
        this._stdin.write(Buffer.concat([
          Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
          body,
        ]))
      } catch { /* transport gone */ }
    }
  }

  _failAll(err) {
    if (this._pending.size === 0 && this._closed) return
    for (const { reject } of this._pending.values()) reject(err)
    this._pending.clear()
  }
}

/**
 * Run the DAP `initialize` handshake and return the adapter capabilities.
 * @param {DapClient} client
 */
export async function initialize(client) {
  const body = await client.request('initialize', {
    clientID: 'dsh-debug',
    clientName: 'DSH Debug',
    adapterID: 'delve',
    locale: 'en',
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: false,
    supportsVariablePaging: false,
    supportsRunInTerminalRequest: false,
    supportsMemoryReferences: false,
    supportsProgressReporting: false,
    supportsInvalidatedEvent: false,
    supportsMemoryEvent: false,
  })
  return body.capabilities ?? {}
}
