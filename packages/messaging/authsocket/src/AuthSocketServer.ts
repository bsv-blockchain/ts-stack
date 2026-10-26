import { Server as HttpServer } from 'node:http'
import { ServerOptions, Server as IoServer, Socket as IoSocket } from 'socket.io'
import {
  WalletInterface,
  Peer,
  SessionManager,
  AsyncSessionManager,
  RequestedCertificateSet
} from '@bsv/sdk'
import { SocketServerTransport } from './SocketServerTransport.js'
import {
  DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
  encodeAuthSocketEventPayload,
  parseAuthSocketEventPayload,
  resolveMaxEventPayloadBytes
} from './eventPayload.js'

export type AuthSocketErrorPhase = 'authentication' | 'application' | 'connection' | 'send'

export interface AuthSocketErrorContext {
  phase: AuthSocketErrorPhase
  socketId?: string
  eventName?: string
}

export type AuthSocketErrorHandler = (
  error: unknown,
  context: AuthSocketErrorContext
) => void | Promise<void>

export function decodeAuthSocketEventPayload(payload: number[]): { eventName: string; data: any } {
  try {
    return parseAuthSocketEventPayload(payload, DEFAULT_MAX_EVENT_PAYLOAD_BYTES)
  } catch {
    return { eventName: '_unknown', data: null }
  }
}

export interface AuthSocketServerOptions extends Partial<ServerOptions> {
  wallet: WalletInterface // The server's wallet for signing
  /** SDK v0.1 certificate allowlist; not an application authorization verdict. */
  requestedCertificates?: RequestedCertificateSet
  /**
   * Optional shared BRC-103 session store. Use an AsyncSessionManager backed by
   * a shared database when more than one server replica handles connections.
   */
  sessionManager?: SessionManager | AsyncSessionManager
  /** Maximum authentication messages processed concurrently by each socket. Defaults to 32. */
  maxPendingAuthMessages?: number
  /** Maximum encoded bytes in one authenticated application event. Defaults to 1 MiB. */
  maxEventPayloadBytes?: number
  /** Receives contained transport and application errors without exposing remote payloads. */
  onError?: AuthSocketErrorHandler
}

interface PeerInfo {
  peer: Peer
  authSocket: AuthSocket
  identityKey?: string
}

/**
 * A server-side wrapper for Socket.IO that integrates BRC-103 mutual authentication
 * to ensure secure, identity-aware communication between clients and the server.
 *
 * This class functions as a drop-in replacement for the `Server` class from Socket.IO,
 * with added support for:
 * - Automatic BRC-103 handshake for secure client authentication.
 * - Management of authenticated client sessions, avoiding redundant handshakes.
 * - Event-based communication through signed and verified BRC-103 messages.
 *
 * Features:
 * - Tracks client connections and their associated `Peer` and `AuthSocket` instances.
 * - Allows broadcasting messages to all authenticated clients.
 * - Provides a seamless API for developers by wrapping Socket.IO functionality.
 **/
export class AuthSocketServer {
  // The real Socket.IO server underneath
  private readonly realIo: IoServer

  /**
   * Map from socket.id -> peer info
   *
   * Once we discover the identity key, we store `identityKey`
   * for that connection to skip re-handshaking.
   */
  private readonly peers = new Map<string, PeerInfo>()
  private readonly connectionCallbacks: Array<(socket: AuthSocket) => void | Promise<void>> = []
  private readonly maxEventPayloadBytes: number
  private readonly sessionManager: SessionManager | AsyncSessionManager
  private closePromise?: Promise<void>

  /**
   * @param httpServer - The underlying HTTP server
   * @param options - Contains both standard Socket.IO server config and BRC-103 config.
   */
  constructor(
    httpServer: HttpServer,
    private readonly options: AuthSocketServerOptions
  ) {
    this.maxEventPayloadBytes = resolveMaxEventPayloadBytes(options.maxEventPayloadBytes)
    // One server-wide store is required for cross-connection replay and total
    // session bounds. A store per raw socket would make both controls bypassable
    // merely by reconnecting.
    this.sessionManager = options.sessionManager ?? new SessionManager()
    const {
      wallet: _wallet,
      requestedCertificates: _requestedCertificates,
      sessionManager: _sessionManager,
      maxPendingAuthMessages: _maxPendingAuthMessages,
      maxEventPayloadBytes: _maxEventPayloadBytes,
      onError: _onError,
      ...serverOptions
    } = options
    this.realIo = new IoServer(httpServer, serverOptions)

    // Listen for new connections
    this.realIo.on('connection', (socket: IoSocket) => {
      try {
        this.handleNewConnection(socket)
      } catch (error) {
        this.reportError(error, { phase: 'connection', socketId: socket.id })
        this.disconnectSafely(socket)
      }
    })
  }

  /**
   * Register authenticated-connection setup. All callbacks complete before the
   * first or concurrently received application event is dispatched and before
   * the peer becomes eligible for server routing.
   */
  public on(eventName: 'connection', callback: (socket: AuthSocket) => void | Promise<void>): void
  public on(eventName: string, callback: (data: any) => void | Promise<void>): void
  public on(eventName: string, callback: (data: any) => void | Promise<void>): void {
    // We only override the 'connection' event. For other events, pass them through
    if (eventName === 'connection') {
      this.connectionCallbacks.push(callback as (socket: AuthSocket) => void | Promise<void>)
    } else {
      this.realIo.on(eventName, callback)
    }
  }

  /**
   * Provide a classic pass-through to `io.emit(...)`.
   *
   * Under the hood, we sign a separate BRC-103 AuthMessage for each
   * authenticated peer. We'll embed eventName + data in the payload.
   */
  public emit(eventName: string, data: any) {
    let payload: number[]
    try {
      payload = this.encodeEventPayload(eventName, data)
    } catch (error) {
      this.reportError(error, { phase: 'send', eventName })
      return
    }
    this.peers.forEach(({ peer, identityKey }) => {
      if (typeof identityKey !== 'string') return
      peer.toPeer(payload, identityKey).catch(err => {
        this.reportError(err, { phase: 'send', eventName })
      })
    })
  }

  /**
   * Emit only to connections whose cryptographically authenticated peer
   * identity matches the requested identity key.
   *
   * This is safer than application-level "room" names for private delivery:
   * a client cannot subscribe itself to another identity because the routing
   * decision uses the key discovered by the BRC-103 handshake.
   *
   * @returns the number of authenticated connections selected for delivery
   */
  public emitToIdentity(identityKey: string, eventName: string, data: any): number {
    let selected = 0
    let payload: number[]
    try {
      payload = this.encodeEventPayload(eventName, data)
    } catch (error) {
      this.reportError(error, { phase: 'send', eventName })
      return selected
    }
    this.peers.forEach(({ peer, identityKey: authenticatedIdentityKey }) => {
      if (authenticatedIdentityKey !== identityKey) return
      selected += 1
      peer.toPeer(payload, authenticatedIdentityKey).catch(err => {
        this.reportError(err, { phase: 'send', eventName })
      })
    })
    return selected
  }

  /**
   * Stops accepting connections, disconnects active sockets, and closes the
   * attached HTTP server. Repeated calls share the same shutdown operation.
   */
  public close(): Promise<void> {
    this.closePromise ??= this.realIo.close().then(() => {
      this.peers.clear()
      this.connectionCallbacks.length = 0
    })
    return this.closePromise
  }

  /**
   * If the developer needs direct access to the underlying raw Socket.IO server,
   * we can provide a getter.
   */
  // public rawIo(): IoServer {
  //   return this.realIo
  // }

  private handleNewConnection(socket: IoSocket): void {
    const transport = new SocketServerTransport(socket, {
      maxPendingMessages: this.options.maxPendingAuthMessages,
      onError: error => {
        this.reportError(error, { phase: 'authentication', socketId: socket.id })
      }
    })

    // Create a new Peer for this client
    const peer = new Peer(
      this.options.wallet,
      transport,
      this.options.requestedCertificates,
      this.sessionManager
    )

    const authSocket = new AuthSocket(
      socket,
      peer,
      (sockId, identityKey) => {
        const info = this.peers.get(sockId)
        if (info == null) return false
        return (async () => {
          try {
            for (const callback of this.connectionCallbacks) {
              await callback(authSocket)
            }
            if (this.peers.get(sockId) !== info) return false
            // Do not make this peer eligible for broadcast or identity routing
            // until every authenticated-connection callback has completed.
            info.identityKey = identityKey
            return true
          } catch (error) {
            this.reportError(error, { phase: 'connection', socketId: sockId })
            this.disconnectSafely(socket)
            return false
          }
        })()
      },
      (error, context) => {
        this.reportError(error, context)
      },
      this.maxEventPayloadBytes
    )

    this.peers.set(socket.id, { peer, authSocket, identityKey: undefined })

    // Handle disconnection
    socket.on('disconnect', () => {
      this.peers.delete(socket.id)
    })
  }

  private encodeEventPayload(eventName: string, data: any): number[] {
    return encodeAuthSocketEventPayload(eventName, data, this.maxEventPayloadBytes)
  }

  private reportError(error: unknown, context: AuthSocketErrorContext): void {
    void Promise.resolve()
      .then(async () => await this.options.onError?.(error, context))
      .catch(() => {})
  }

  private disconnectSafely(socket: IoSocket): void {
    try {
      socket.disconnect(true)
    } catch {
      // The original failure is already contained and reported.
    }
  }
}

/**
 * A wrapper around a real `IoSocket` used by a server that performs BRC-103
 * signing and verification via the Peer class.
 */
export class AuthSocket {
  // We store event callbacks for re-dispatch
  private readonly eventCallbacks: Map<string, Array<(data: any) => void | Promise<void>>> =
    new Map()

  /** Current cryptographically verified identity for this socket. */
  private peerIdentityKey?: string
  /** Shared gate for every concurrently delivered first-session message. */
  private activationPromise?: Promise<boolean>

  constructor(
    public readonly ioSocket: IoSocket,
    private readonly peer: Peer,
    private readonly onIdentityKeyDiscovered: (
      socketId: string,
      identityKey: string
    ) => boolean | void | Promise<boolean | void>,
    private readonly onError: AuthSocketErrorHandler = () => {},
    private readonly maxEventPayloadBytes: number = DEFAULT_MAX_EVENT_PAYLOAD_BYTES
  ) {
    this.peer.listenForGeneralMessages(async (senderPublicKey, payload) => {
      let eventName: string | undefined
      try {
        if (this.peerIdentityKey == null) {
          this.peerIdentityKey = senderPublicKey
          this.activationPromise = Promise.resolve().then(async () => {
            const activated = await this.onIdentityKeyDiscovered(this.ioSocket.id, senderPublicKey)
            return activated !== false
          })
        } else if (senderPublicKey !== this.peerIdentityKey) {
          throw new Error('Authenticated socket identity changed during the connection')
        }

        // Socket transports may process more than one signed message at once.
        // Every message must wait for the same one-time application activation;
        // merely observing peerIdentityKey is not sufficient authorization.
        const activated = await this.activationPromise
        if (activated !== true) return

        const decoded = parseAuthSocketEventPayload(payload, this.maxEventPayloadBytes)
        eventName = decoded.eventName
        const cbs = this.eventCallbacks.get(eventName)
        if (!cbs) return
        for (const cb of cbs) {
          const result = cb(decoded.data)
          if (result != null && typeof (result as PromiseLike<void>).then === 'function') {
            await result
          }
        }
      } catch (error) {
        this.reportError(error, { phase: 'application', socketId: this.id, eventName })
        this.disconnectSafely()
      }
    })

    this.ioSocket.on('disconnect', reason => {
      if (this.peerIdentityKey == null) return
      void this.fireLifecycleEvent('disconnect', reason)
    })
  }

  /**
   * Register a callback for an event name, just like `socket.on(...)`.
   */
  public on(eventName: string, callback: (data: any) => void | Promise<void>) {
    const arr = this.eventCallbacks.get(eventName) || []
    arr.push(callback)
    this.eventCallbacks.set(eventName, arr)
  }

  /**
   * Emulate `socket.emit(eventName, data)`.
   * We'll sign a BRC-103 `general` message via Peer,
   * embedding the event name & data in the payload.
   *
   * If we do not yet have the peer's identity key (handshake not done?),
   * the Peer will attempt the handshake. Once known, subsequent calls
   * will pass identityKey to skip the initial handshake.
   */
  public async emit(eventName: string, data: any): Promise<void> {
    const encoded = this.encodeEventPayload(eventName, data)
    await this.peer.toPeer(encoded, this.peerIdentityKey)
  }

  /**
   * The Socket.IO 'id'
   */
  get id(): string {
    return this.ioSocket.id
  }

  /**
   * The client's identity key, if discovered
   */
  get identityKey(): string | undefined {
    return this.peerIdentityKey
  }

  /////////////////////////////
  // Internal
  /////////////////////////////

  private encodeEventPayload(eventName: string, data: any): number[] {
    return encodeAuthSocketEventPayload(eventName, data, this.maxEventPayloadBytes)
  }

  private async fireLifecycleEvent(eventName: string, data: unknown): Promise<void> {
    const callbacks = this.eventCallbacks.get(eventName)
    if (callbacks == null) return
    try {
      for (const callback of callbacks) await callback(data)
    } catch (error) {
      this.reportError(error, { phase: 'application', socketId: this.id, eventName })
    }
  }

  private reportError(error: unknown, context: AuthSocketErrorContext): void {
    void Promise.resolve()
      .then(async () => await this.onError(error, context))
      .catch(() => {})
  }

  private disconnectSafely(): void {
    try {
      this.ioSocket.disconnect(true)
    } catch {
      // The original failure is already contained and reported.
    }
  }
}
