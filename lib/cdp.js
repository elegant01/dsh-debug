/**
 * CDP (Chrome DevTools Protocol) session over a WebSocket: JSON-RPC with
 * `id`-correlated responses and method-named events. Node's `--inspect` is
 * the only peer this ever talks to, but nothing here is Node-specific.
 *
 * @module dsh-debug/lib/cdp
 */

import { EventEmitter } from 'node:events'

export class CdpConnection extends EventEmitter {
  /**
   * @param {import('./ws.js').WsClient} ws
   */
  constructor(ws) {
    super()
    this.ws = ws
    this._id = 0
    /** @type {Map<number, {resolve, reject, method, timer}>} */
    this._pending = new Map()
    this._closed = false

    ws.on('message', (text) => {
      let message
      try { message = JSON.parse(text) } catch { return }
      if (message.id !== undefined) {
        const pending = this._pending.get(message.id)
        if (!pending) return
        this._pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) {
          const err = new Error(message.error.message ?? 'CDP error')
          err.code = message.error.code
          err.method = pending.method
          err.data = message.error.data
          pending.reject(err)
        } else {
          pending.resolve(message.result ?? {})
        }
        return
      }
      if (message.method) this.emit('event', message)
      if (message.method) this.emit(`event:${message.method}`, message.params ?? {})
    })
    ws.on('close', () => {
      this._closed = true
      this._failAll(new Error('CDP connection closed'))
      this.emit('disconnected')
    })
    ws.on('error', (err) => this._failAll(err))
  }

  /**
   * @param {string} method - e.g. 'Debugger.enable'
   * @param {object} [params]
   * @param {number} [timeoutMs] - default 30s
   */
  call(method, params = {}, timeoutMs = 30_000) {
    if (this._closed) return Promise.reject(new Error('CDP connection is closed'))
    const id = ++this._id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id)
        reject(new Error(`${method}: no response within ${timeoutMs}ms`))
      }, timeoutMs)
      this._pending.set(id, { resolve, reject, method, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  close() {
    this._closed = true
    this._failAll(new Error('CDP connection closed'))
    this.ws.close()
    this.removeAllListeners()
  }

  _failAll(err) {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer)
      reject(err)
    }
    this._pending.clear()
  }
}
