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

const DEFAULT_MAX_PENDING_MESSAGES = 32

export interface SocketClientTransportOptions {
  /** Maximum authentication messages that may be processed concurrently per socket. */
  maxPendingMessages?: number
  /** Receives contained authentication failures. The hook is never allowed to throw outward. */
  onError?: (error: unknown) => void | Promise<void>
}

export class SocketClientTransport implements Transport {
  private onDataCallback?: (message: AuthMessage) => Promise<void>
  private readonly maxPendingMessages: number
  private readonly onError?: (error: unknown) => void | Promise<void>
  private pendingMessages = 0
  private failed = false

  constructor(
    private readonly socket: IoClientSocket,
    options: SocketClientTransportOptions = {}
  ) {
    const maxPendingMessages = options.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES
    if (!Number.isSafeInteger(maxPendingMessages) || maxPendingMessages < 1) {
      throw new RangeError('maxPendingMessages must be a positive safe integer')
    }
    this.maxPendingMessages = maxPendingMessages
    this.onError = options.onError

    // Subscribe to the 'authMessage' event from the server
    this.socket.on('authMessage', (msg: AuthMessage) => {
      return this.processMessage(msg)
    })
  }

  /**
   * Send an AuthMessage to the server.
   */
  async send(message: AuthMessage): Promise<void> {
    this.socket.emit('authMessage', message)
  }

  /**
   * Register a callback to handle incoming AuthMessages.
   */
  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.onDataCallback = callback
  }

  private async processMessage(message: AuthMessage): Promise<void> {
    if (this.failed || this.onDataCallback === undefined) return
    if (this.pendingMessages >= this.maxPendingMessages) {
      this.fail(new Error('Authentication message concurrency limit exceeded'))
      return
    }

    this.pendingMessages += 1
    try {
      await this.onDataCallback(message)
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
      this.socket.disconnect()
    } catch {
      // A transport failure is already contained; disconnect errors are non-actionable here.
    }
  }
}
