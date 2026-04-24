import { Server as HttpServer } from 'http'
import { ServerOptions, Server as IoServer, Socket as IoSocket } from 'socket.io'
import { WalletInterface, Peer, SessionManager } from '@bsv/sdk'
import { SocketServerTransport } from './SocketServerTransport.js'

export interface AuthSocketServerOptions extends Partial<ServerOptions> {
  wallet: WalletInterface // The server's wallet for signing
  requestedCertificates?: any // e.g. RequestedCertificateSet
  sessionManager?: SessionManager
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
  private realIo: IoServer

  /** 
   * Map from socket.id -> peer info 
   * 
   * Once we discover the identity key, we store `identityKey` 
   * for that connection to skip re-handshaking.
   */
  private peers = new Map<string, PeerInfo>()
  private connectionCallbacks: Array<(socket: AuthSocket) => void> = []

  /**
   * @param httpServer - The underlying HTTP server
   * @param options - Contains both standard Socket.IO server config and BRC-103 config.
   */
  constructor(
    httpServer: HttpServer,
    private options: AuthSocketServerOptions
  ) {
    this.realIo = new IoServer(httpServer, options)

    // Listen for new connections
    this.realIo.on('connection', (socket: IoSocket) => {
      this.handleNewConnection(socket)
    })
  }

  /**
   * A direct pass-through to `io.on('connection', cb)`, 
   * but the callback is invoked with an AuthSocket instead.
   */
  public on(eventName: 'connection', callback: (socket: AuthSocket) => void): void
  public on(eventName: string, callback: (data: any) => void): void {
    // We only override the 'connection' event. For other events, pass them through
    if (eventName === 'connection') {
      this.connectionCallbacks.push(callback as (socket: AuthSocket) => void)
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
    this.peers.forEach(({ peer, authSocket, identityKey }) => {
      const payload = this.encodeEventPayload(eventName, data)
      peer.toPeer(payload, identityKey).catch(err => {
        // log or handle error
        console.error(err)
      })
    })
  }

  /**
   * If the developer needs direct access to the underlying raw Socket.IO server,
   * we can provide a getter.
   */
  // public rawIo(): IoServer {
  //   return this.realIo
  // }

  private async handleNewConnection(socket: IoSocket) {
    const transport = new SocketServerTransport(socket)

    // Create a new Peer for this client
    const peer = new Peer(
      this.options.wallet,
      transport,
      this.options.requestedCertificates,
      this.options.sessionManager
    )

    const authSocket = new AuthSocket(socket, peer, (sockId, identityKey) => {
      // Callback: once the AuthSocket learns identityKey from a 'general' message, store it
      const info = this.peers.get(sockId)
      if (info) {
        info.identityKey = identityKey
      }
    })

    this.peers.set(socket.id, { peer, authSocket, identityKey: undefined })

    // Handle disconnection
    socket.on('disconnect', () => {
      this.peers.delete(socket.id)
    })

    // Fire any onConnection callbacks
    this.connectionCallbacks.forEach(cb => cb(authSocket))
  }

  private encodeEventPayload(eventName: string, data: any): number[] {
    const obj = { eventName, data }
    return Array.from(Buffer.from(JSON.stringify(obj), 'utf8'))
  }
}


/**
 * A wrapper around a real `IoSocket` used by a server that performs BRC-103
 * signing and verification via the Peer class. 
 */
export class AuthSocket {
  // We store event callbacks for re-dispatch
  private eventCallbacks: Map<string, Array<(data: any) => void>> = new Map()

  /**
   * Current known identity key of the server, if discovered 
   * (i.e. after the handshake yields a general message or 
   * or we've forced a getAuthenticatedSession). 
   */
  private peerIdentityKey?: string

  constructor(
    public readonly ioSocket: IoSocket,
    private peer: Peer,
    /**
     * A function the server passes in so we can 
     * notify it once we discover the peer's identity key.
     */
    private onIdentityKeyDiscovered: (socketId: string, identityKey: string) => void
  ) {
    // Listen for 'general' messages from the Peer
    this.peer.listenForGeneralMessages((senderPublicKey, payload) => {
      // Capture the newly discovered identity key if not known yet
      if (!this.peerIdentityKey) {
        this.peerIdentityKey = senderPublicKey
        this.onIdentityKeyDiscovered(this.ioSocket.id, senderPublicKey)
      }

      // The payload is a number[] representing JSON for { eventName, data }
      const { eventName, data } = this.decodeEventPayload(payload)
      const cbs = this.eventCallbacks.get(eventName)
      if (!cbs) return
      for (const cb of cbs) {
        cb(data)
      }
    })
  }

  /**
   * Register a callback for an event name, just like `socket.on(...)`.
   */
  public on(eventName: string, callback: (data: any) => void) {
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
    const json = JSON.stringify({ eventName, data })
    return Array.from(Buffer.from(json, 'utf8'))
  }

  private decodeEventPayload(payload: number[]): { eventName: string, data: any } {
    try {
      const str = Buffer.from(payload).toString('utf8')
      return JSON.parse(str)
    } catch {
      return { eventName: '_unknown', data: null }
    }
  }
}
