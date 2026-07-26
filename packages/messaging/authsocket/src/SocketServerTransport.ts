import { Socket as IoSocket } from 'socket.io'
import { Transport, AuthMessage } from '@bsv/sdk'

/**
 * Implements the Transport interface for a specific client socket.
 *
 * This transport simply relays AuthMessages over 'authMessage'
 * in the underlying Socket.IO connection.
 */
export class SocketServerTransport implements Transport {
  constructor(private readonly socket: IoSocket) {}

  async send(message: AuthMessage): Promise<void> {
    // We'll emit with a special low-level event named: 'authMessage'
    this.socket.emit('authMessage', message)
  }

  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    // Listen for 'authMessage' from the client
    this.socket.on('authMessage', async (msg: AuthMessage) => {
      await callback(msg)
    })
  }
}
