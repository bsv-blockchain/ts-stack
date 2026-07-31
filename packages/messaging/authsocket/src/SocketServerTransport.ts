import { Socket as IoSocket } from 'socket.io'
import { Transport, AuthMessage } from '@bsv/sdk'

const DEFAULT_MAX_PENDING_MESSAGES = 32

export interface SocketServerTransportOptions {
  /** Maximum authentication messages that may be processed concurrently per socket. */
  maxPendingMessages?: number
  /** Receives contained authentication failures. The hook is never allowed to throw outward. */
  onError?: (error: unknown) => void | Promise<void>
}

/**
 * Implements the Transport interface for a specific client socket.
 *
 * This transport simply relays AuthMessages over 'authMessage'
 * in the underlying Socket.IO connection.
 */
export class SocketServerTransport implements Transport {
  private readonly maxPendingMessages: number
  private readonly onError?: (error: unknown) => void | Promise<void>
  private pendingMessages = 0
  private failed = false

  constructor(
    private readonly socket: IoSocket,
    options: SocketServerTransportOptions = {}
  ) {
    const maxPendingMessages = options.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES
    if (!Number.isSafeInteger(maxPendingMessages) || maxPendingMessages < 1) {
      throw new RangeError('maxPendingMessages must be a positive safe integer')
    }
    this.maxPendingMessages = maxPendingMessages
    this.onError = options.onError
  }

  async send(message: AuthMessage): Promise<void> {
    // We'll emit with a special low-level event named: 'authMessage'
    this.socket.emit('authMessage', message)
  }

  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    // Listen for 'authMessage' from the client
    this.socket.on('authMessage', (msg: AuthMessage) => {
      return this.processMessage(msg, callback)
    })
  }

  private async processMessage(
    message: AuthMessage,
    callback: (message: AuthMessage) => Promise<void>
  ): Promise<void> {
    if (this.failed) return
    if (this.pendingMessages >= this.maxPendingMessages) {
      this.fail(new Error('Authentication message concurrency limit exceeded'))
      return
    }

    this.pendingMessages += 1
    try {
      await callback(message)
    } catch (error) {
      this.fail(error)
    } finally {
      this.pendingMessages -= 1
    }
  }

  private fail(error: unknown): void {
    if (this.failed) return
    this.failed = true
    void Promise.resolve()
      .then(async () => await this.onError?.(error))
      .catch(() => {})
    try {
      this.socket.disconnect(true)
    } catch {
      // A transport failure is already contained; disconnect errors are non-actionable here.
    }
  }
}
