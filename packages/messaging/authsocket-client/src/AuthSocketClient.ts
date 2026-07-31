import {
  io as realIo,
  Socket as IoClientSocket,
  ManagerOptions,
  SocketOptions
} from 'socket.io-client'
import {
  RequestedCertificateSet,
  SessionManager,
  AsyncSessionManager,
  Peer,
  WalletInterface,
  Utils,
  OriginatorDomainNameStringUnder250Bytes
} from '@bsv/sdk'
import { SocketClientTransport } from './SocketClientTransport.js'

export type AuthSocketClientErrorPhase = 'authentication' | 'application' | 'send'

export interface AuthSocketClientErrorContext {
  phase: AuthSocketClientErrorPhase
  socketId?: string
  eventName?: string
}

export type AuthSocketClientErrorHandler = (
  error: unknown,
  context: AuthSocketClientErrorContext
) => void | Promise<void>

export function decodeAuthSocketEventPayload(payload: number[]): { eventName: string; data: any } {
  try {
    const str = Utils.toUTF8(payload)
    const decoded: unknown = JSON.parse(str)
    if (
      decoded === null ||
      typeof decoded !== 'object' ||
      Array.isArray(decoded) ||
      typeof (decoded as { eventName?: unknown }).eventName !== 'string'
    ) {
      return { eventName: '_unknown', data: undefined }
    }
    return {
      eventName: (decoded as { eventName: string }).eventName,
      data: (decoded as { data?: unknown }).data
    }
  } catch {
    return { eventName: '_unknown', data: undefined }
  }
}

export interface AuthSocketClientOptions {
  wallet: WalletInterface
  requestedCertificates?: RequestedCertificateSet
  sessionManager?: SessionManager | AsyncSessionManager
  managerOptions?: Partial<ManagerOptions & SocketOptions>
  originator?: OriginatorDomainNameStringUnder250Bytes
  /** Maximum authentication messages processed concurrently. Defaults to 32. */
  maxPendingAuthMessages?: number
  /** Receives contained transport and application errors without exposing remote payloads. */
  onError?: AuthSocketClientErrorHandler
}

/**
 * Internal class that wraps a Socket.IO client connection with BRC-103 mutual authentication,
 * enabling secure and identity-aware communication with a server.
 */
class AuthSocketClientImpl {
  public connected = false
  public id: string = ''
  public serverIdentityKey: string | undefined
  private readonly eventCallbacks = new Map<string, Array<(data: any) => void | Promise<void>>>()

  /**
   * Creates an instance of AuthSocketClient.
   *
   * @param ioSocket - The underlying Socket.IO client socket instance.
   * @param peer - The BRC-103 Peer instance responsible for managing authenticated
   *               communication, including message signing and verification.
   */
  constructor(
    private readonly ioSocket: IoClientSocket,
    private readonly peer: Peer,
    private readonly onError: AuthSocketClientErrorHandler = () => {}
  ) {
    // Listen for 'connect' and 'disconnect' from underlying Socket.IO
    this.ioSocket.on('connect', () => {
      this.connected = true
      this.id = this.ioSocket.id ?? ''
      // Re-dispatch to dev if they've called "socket.on('connect', ...)"
      void this.fireEventCallbacks('connect')
    })

    this.ioSocket.on('disconnect', reason => {
      this.connected = false
      // Re-dispatch
      void this.fireEventCallbacks('disconnect', reason)
    })

    // Also listen for BRC-103 "general" messages
    // We'll rely on peer.listenForGeneralMessages
    this.peer.listenForGeneralMessages(async (senderKey, payload) => {
      this.serverIdentityKey = senderKey
      const { eventName, data } = this.decodeEventPayload(payload)
      await this.fireEventCallbacks(eventName, data)
    })
  }

  on(eventName: string, callback: (data?: any) => void | Promise<void>): this {
    let arr = this.eventCallbacks.get(eventName)
    if (arr === undefined) {
      arr = []
      this.eventCallbacks.set(eventName, arr)
    }
    arr.push(callback)
    return this
  }

  emit(eventName: string, data: any): this {
    // We sign a BRC-103 "general" message and send to the server
    // via peer.toPeer
    let encoded: number[]
    try {
      encoded = this.encodeEventPayload(eventName, data)
    } catch (error) {
      this.reportError(error, {
        phase: 'send',
        socketId: this.ioSocket.id ?? this.id,
        eventName
      })
      return this
    }
    this.peer.toPeer(encoded, this.serverIdentityKey).catch(err => {
      this.reportError(err, {
        phase: 'send',
        socketId: this.ioSocket.id ?? this.id,
        eventName
      })
    })
    return this
  }

  disconnect(): void {
    this.serverIdentityKey = undefined
    this.ioSocket.disconnect()
  }

  private async fireEventCallbacks(eventName: string, data?: any): Promise<void> {
    const cbs = this.eventCallbacks.get(eventName)
    if (cbs === undefined) return
    try {
      for (const cb of cbs) {
        const result = cb(data)
        if (result != null && typeof (result as PromiseLike<void>).then === 'function') {
          await result
        }
      }
    } catch (error) {
      this.reportError(error, {
        phase: 'application',
        socketId: this.ioSocket.id ?? this.id,
        eventName
      })
      if (eventName !== 'disconnect') this.disconnectSafely()
    }
  }

  private encodeEventPayload(eventName: string, data: any): number[] {
    const obj = { eventName, data }
    return Utils.toArray(JSON.stringify(obj), 'utf8')
  }

  private decodeEventPayload(payload: number[]): { eventName: string; data: any } {
    return decodeAuthSocketEventPayload(payload)
  }

  private reportError(error: unknown, context: AuthSocketClientErrorContext): void {
    void Promise.resolve()
      .then(async () => await this.onError(error, context))
      .catch(() => {})
  }

  private disconnectSafely(): void {
    try {
      this.ioSocket.disconnect()
    } catch {
      // The original failure is already contained and reported.
    }
  }
}

/**
 * Factory function for creating a new AuthSocketClientImpl instance.
 *
 * @param url  - The server URL
 * @param opts - Contains wallet, requested certificates, and other optional settings
 */
export function AuthSocketClient(url: string, opts: AuthSocketClientOptions): AuthSocketClientImpl {
  // 1) Create real socket.io-client connection
  const socket = realIo(url, opts.managerOptions)

  // 2) Create a BRC-103 transport for the new socket
  const transport = new SocketClientTransport(socket, {
    maxPendingMessages: opts.maxPendingAuthMessages,
    onError: error => {
      reportErrorSafely(opts.onError, error, {
        phase: 'authentication',
        socketId: socket.id
      })
    }
  })

  // 3) Create a Peer
  const peer = new Peer(
    opts.wallet,
    transport,
    opts.requestedCertificates,
    opts.sessionManager,
    undefined,
    opts.originator
  )

  // 4) Return our new AuthSocketClientImpl
  return new AuthSocketClientImpl(socket, peer, (error, context) => {
    reportErrorSafely(opts.onError, error, context)
  })
}

function reportErrorSafely(
  handler: AuthSocketClientErrorHandler | undefined,
  error: unknown,
  context: AuthSocketClientErrorContext
): void {
  void Promise.resolve()
    .then(async () => await handler?.(error, context))
    .catch(() => {})
}
