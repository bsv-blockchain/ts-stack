/**
 * A client-side transport for BRC-103 using Socket.IO client.
 *
 * The BRC-103 `Peer` uses `transport.send()` to send an `AuthMessage`,
 * which is forwarded via `this.socket.emit('authMessage', message)`.
 *
 * This class also listens for `'authMessage'` events from the server.
 */
import { Socket as IoClientSocket } from 'socket.io-client'
import { AuthMessage, Transport } from '@bsv/sdk'

export class SocketClientTransport implements Transport {
  private onDataCallback?: (message: AuthMessage) => Promise<void>

  constructor (private readonly socket: IoClientSocket) {
    // Subscribe to the 'authMessage' event from the server
    this.socket.on('authMessage', async (msg: AuthMessage) => {
      if (this.onDataCallback !== undefined) {
        await this.onDataCallback(msg)
      }
    })
  }

  /**
   * Send an AuthMessage to the server.
   */
  async send (message: AuthMessage): Promise<void> {
    this.socket.emit('authMessage', message)
  }

  /**
   * Register a callback to handle incoming AuthMessages.
   */
  async onData (callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.onDataCallback = callback
  }
}
