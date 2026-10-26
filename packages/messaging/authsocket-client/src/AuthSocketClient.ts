import {
  io as realIo,
  Socket as IoClientSocket,
  ManagerOptions,
  SocketOptions
} from 'socket.io-client'
import { Peer } from '@bsv/sdk/auth/Peer'
import { SessionManager } from '@bsv/sdk/auth/SessionManager'
import type { AsyncSessionManager } from '@bsv/sdk/auth/SessionManager'
import type { RequestedCertificateSet } from '@bsv/sdk/auth/types'
import type {
  WalletInterface,
  OriginatorDomainNameStringUnder250Bytes
} from '@bsv/sdk/wallet/Wallet.interfaces'
import { SocketClientTransport } from './SocketClientTransport.js'
import {
  DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
  encodeAuthSocketEventPayload,
  parseAuthSocketEventPayload,
  resolveMaxEventPayloadBytes
} from './eventPayload.js'

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
    return parseAuthSocketEventPayload(payload, DEFAULT_MAX_EVENT_PAYLOAD_BYTES)
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
  /** Maximum encoded bytes in one authenticated application event. Defaults to 1 MiB. */
  maxEventPayloadBytes?: number
  /** Optional canonical BRC-103 identity pin for the expected server wallet. */
  expectedServerIdentityKey?: string
  /** Receives contained transport and application errors without exposing remote payloads. */
  onError?: AuthSocketClientErrorHandler
}

/**
 * Internal class that wraps a Socket.IO client connection with BRC-103 mutual authentication,
 * enabling secure and identity-aware communication with a server.
 */
class AuthSocketClientImpl {
  /** Underlying Socket.IO transport state; this is not a BRC-103 authorization verdict. */
  public connected = false
  public id: string = ''
  /** Verified BRC-103 server identity, or the configured pin before verification. */
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
    private readonly onError: AuthSocketClientErrorHandler = () => {},
    private readonly maxEventPayloadBytes: number = DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
    private readonly expectedServerIdentityKey?: string
  ) {
    this.serverIdentityKey = expectedServerIdentityKey
    // Listen for 'connect' and 'disconnect' from underlying Socket.IO
    this.ioSocket.on('connect', () => {
      this.connected = true
      this.id = this.ioSocket.id ?? ''
      this.serverIdentityKey = this.expectedServerIdentityKey
      // Re-dispatch to dev if they've called "socket.on('connect', ...)"
      void this.fireEventCallbacks('connect')
    })

    this.ioSocket.on('disconnect', reason => {
      this.connected = false
      this.serverIdentityKey = this.expectedServerIdentityKey
      // Re-dispatch
      void this.fireEventCallbacks('disconnect', reason)
    })

    // Also listen for BRC-103 "general" messages
    // We'll rely on peer.listenForGeneralMessages
    this.peer.listenForGeneralMessages(async (senderKey, payload) => {
      let eventName: string | undefined
      try {
        if (
          this.expectedServerIdentityKey !== undefined &&
          senderKey !== this.expectedServerIdentityKey
        ) {
          throw new Error('Authenticated server identity does not match the configured pin')
        }
        if (this.serverIdentityKey == null) this.serverIdentityKey = senderKey
        else if (senderKey !== this.serverIdentityKey) {
          throw new Error('Authenticated server identity changed during the connection')
        }
        const decoded = parseAuthSocketEventPayload(payload, this.maxEventPayloadBytes)
        eventName = decoded.eventName
        await this.fireEventCallbacks(eventName, decoded.data)
      } catch (error) {
        this.reportError(error, {
          phase: 'application',
          socketId: this.ioSocket.id ?? this.id,
          eventName
        })
        this.disconnectSafely()
      }
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
    this.serverIdentityKey = this.expectedServerIdentityKey
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
    return encodeAuthSocketEventPayload(eventName, data, this.maxEventPayloadBytes)
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
  if (opts == null || typeof opts !== 'object' || opts.wallet == null) {
    throw new TypeError('AuthSocketClient requires a wallet options object')
  }
  const validatedUrl = validateSocketUrl(url)
  const maxEventPayloadBytes = resolveMaxEventPayloadBytes(opts.maxEventPayloadBytes)
  const expectedServerIdentityKey = validateExpectedIdentityKey(opts.expectedServerIdentityKey)
  validateManagerOptions(opts.managerOptions)
  // 1) Create real socket.io-client connection
  const socket = realIo(validatedUrl, opts.managerOptions)

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
  return new AuthSocketClientImpl(
    socket,
    peer,
    (error, context) => {
      reportErrorSafely(opts.onError, error, context)
    },
    maxEventPayloadBytes,
    expectedServerIdentityKey
  )
}

function validateSocketUrl(value: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) {
    throw new TypeError('AuthSocket server URL must be a bounded absolute URL')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new TypeError('AuthSocket server URL must be a valid absolute URL')
  }
  if (url.username !== '' || url.password !== '' || url.hash !== '') {
    throw new TypeError('AuthSocket server URL must not contain credentials or a fragment')
  }
  const secure = url.protocol === 'https:' || url.protocol === 'wss:'
  const loopback =
    url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  const localCleartext = loopback && (url.protocol === 'http:' || url.protocol === 'ws:')
  if (!secure && !localCleartext) {
    throw new TypeError('AuthSocket requires HTTPS/WSS except on exact loopback hosts')
  }
  return url.toString()
}

function validateExpectedIdentityKey(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^(02|03)[0-9a-f]{64}$/u.test(value)) {
    throw new TypeError('expectedServerIdentityKey must be a canonical compressed public key')
  }
  return value
}

function validateManagerOptions(value: unknown): void {
  if (value === undefined) return
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('managerOptions must be an object')
  }

  const validateTransportSecurity = (candidate: unknown, path: string): void => {
    if (candidate == null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new TypeError(`${path} must be an object`)
    }
    for (const key of ['host', 'hostname', 'port', 'secure']) {
      if (Object.hasOwn(candidate, key)) {
        throw new TypeError(`${path}.${key} cannot override the authenticated server URL`)
      }
    }
    const rejectUnauthorized = Object.getOwnPropertyDescriptor(candidate, 'rejectUnauthorized')
    if (rejectUnauthorized != null) {
      if (!Object.hasOwn(rejectUnauthorized, 'value')) {
        throw new TypeError(`${path}.rejectUnauthorized must not be an accessor`)
      }
      if (rejectUnauthorized.value === false) {
        throw new TypeError(`${path}.rejectUnauthorized cannot disable TLS certificate validation`)
      }
    }
  }

  validateTransportSecurity(value, 'managerOptions')
  const transportOptions = Object.getOwnPropertyDescriptor(value, 'transportOptions')
  if (transportOptions != null) {
    if (!Object.hasOwn(transportOptions, 'value')) {
      throw new TypeError('managerOptions.transportOptions must not be an accessor')
    }
    const transports = transportOptions.value
    if (transports == null || typeof transports !== 'object' || Array.isArray(transports)) {
      throw new TypeError('managerOptions.transportOptions must be an object')
    }
    for (const [transportName, transport] of Object.entries(transports)) {
      validateTransportSecurity(transport, `managerOptions.transportOptions.${transportName}`)
    }
  }
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
