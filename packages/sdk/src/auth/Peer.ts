import { SessionManager, AsyncSessionManager } from './SessionManager.js'
import {
  createNonce,
  verifyNonce,
  getVerifiableCertificates,
  validateCertificates
} from './utils/index.js'
import {
  AuthMessage,
  PeerSession,
  RequestedCertificateSet,
  Transport
} from './types.js'
import { VerifiableCertificate } from './certificates/VerifiableCertificate.js'
import Random from '../primitives/Random.js'
import * as Utils from '../primitives/utils.js'
import { OriginatorDomainNameStringUnder250Bytes, WalletInterface } from '../wallet/Wallet.interfaces.js'

const AUTH_VERSION = '0.1'
const BufferCtor =
  typeof globalThis === 'undefined' ? undefined : (globalThis as any).Buffer

/**
 * Represents a peer capable of performing mutual authentication.
 * Manages sessions, handles authentication handshakes, certificate requests and responses,
 * and sending and receiving general messages over a transport layer.
 *
 * This version supports multiple concurrent sessions per peer identityKey.
 */
export class Peer {
  // Declared as the synchronous {@link SessionManager} for back-compat with
  // pre-existing consumers that read `peer.sessionManager.getSession(...)`
  // and friends as synchronous calls. The constructor also accepts an
  // {@link AsyncSessionManager}; in that case the runtime value's methods
  // return Promises. Peer always awaits internal calls so both work, but
  // external code that reaches in directly should match the implementation
  // it injected. See `AsyncSessionManager` for the opt-in async contract.
  public sessionManager: SessionManager
  private readonly transport: Transport
  private readonly wallet: WalletInterface
  certificatesToRequest: RequestedCertificateSet
  private readonly certificateSessionUpdates = new Map<string, Promise<void>>()
  private readonly onGeneralMessageReceivedCallbacks: Map<
  number,
  (senderPublicKey: string, payload: number[]) => void | Promise<void>
  > = new Map()

  private readonly onCertificatesReceivedCallbacks: Map<
  number,
  (senderPublicKey: string, certs: VerifiableCertificate[]) => void | Promise<void>
  > = new Map()

  private readonly onCertificateRequestReceivedCallbacks: Map<
  number,
  (
    senderPublicKey: string,
    requestedCertificates: RequestedCertificateSet
  ) => void | Promise<void>
  > = new Map()

  private readonly onInitialResponseReceivedCallbacks: Map<
  number,
  { callback: (sessionNonce: string) => void, sessionNonce: string }
  > = new Map()

  // Promise-based mechanism for waiting on certificate validation
  private readonly certificateValidationPromises: Map<
  string,
  { resolve: () => void, reject: (error: Error) => void }
  > = new Map()

  // Single shared counter for all callback types
  private callbackIdCounter: number = 0

  // Whether to auto-persist the session with the last-interacted-with peer
  private readonly autoPersistLastSession: boolean = true

  // Last-interacted-with peer identity key (if the user calls toPeer with no identityKey)
  private lastInteractedWithPeer: string | undefined

  private readonly originator?: OriginatorDomainNameStringUnder250Bytes
  private identityPublicKey?: string

  /**
   * Resolves when the transport's `onData` listener has been registered and
   * the peer is ready to send and receive messages.  Await this after
   * construction before calling `toPeer` or any other method that requires
   * the transport to be listening.
   *
   * @example
   * const peer = new Peer(wallet, transport)
   * await peer.ready
   * await peer.toPeer(payload)
   */
  /*
   * Listener must register synchronously so paired-peer mocks/transports see
   * onDataCallback set immediately. The returned Promise resolves once registration
   * is fully acknowledged. A lazy getter pattern would break paired-peer test mocks.
   */
  readonly ready: Promise<void>

  /**
   * Creates a new Peer instance
   *
   * @param {WalletInterface} wallet - The wallet instance used for cryptographic operations.
   * @param {Transport} transport - The transport mechanism used for sending and receiving messages.
   * @param {RequestedCertificateSet} [certificatesToRequest] - Optional set of certificates to request from a peer during the initial handshake.
   * @param {SessionManager | AsyncSessionManager} [sessionManager] - Optional session store. Pass an {@link AsyncSessionManager} for shared/durable storage in load-balanced deployments; otherwise the default in-process {@link SessionManager} is used.
   * @param {boolean} [autoPersistLastSession] - Whether to auto-persist the session with the last-interacted-with peer. Defaults to true.
   * @param {OriginatorDomainNameStringUnder250Bytes} [originator] - Optional originator domain name.
   */
  constructor (
    wallet: WalletInterface,
    transport: Transport,
    certificatesToRequest?: RequestedCertificateSet,
    sessionManager?: SessionManager | AsyncSessionManager,
    autoPersistLastSession?: boolean,
    originator?: OriginatorDomainNameStringUnder250Bytes
  ) {
    this.wallet = wallet
    this.originator = originator
    this.transport = transport
    this.certificatesToRequest = certificatesToRequest ?? {
      certifiers: [],
      types: {}
    }
    this.ready = this.transport.onData(this.handleIncomingMessage.bind(this)) // NOSONAR(typescript:S7059): listener must register synchronously — see ready field comment
    // Cast keeps the public field typed as the synchronous `SessionManager`
    // for back-compat. When an `AsyncSessionManager` is injected, the actual
    // runtime methods return Promises — Peer awaits them internally below.
    this.sessionManager =
      (sessionManager ?? new SessionManager()) as SessionManager
    if (autoPersistLastSession === false) {
      this.autoPersistLastSession = false
    } else {
      this.autoPersistLastSession = true
    }
  }

  /**
   * Sends a general message to a peer, and initiates a handshake if necessary.
   *
   * @param {number[]} message - The message payload to send.
   * @param {string} [identityKey] - The identity public key of the peer. If not provided, uses lastInteractedWithPeer (if any).
   * @returns {Promise<void>}
   * @throws Will throw an error if the message fails to send.
   */
  async toPeer (
    message: number[],
    identityKey?: string
  ): Promise<void> {
    if (
      this.autoPersistLastSession &&
      typeof this.lastInteractedWithPeer === 'string' &&
      typeof identityKey !== 'string'
    ) {
      identityKey = this.lastInteractedWithPeer
    }

    const peerSession = await this.getAuthenticatedSession(identityKey)

    if (peerSession.peerIdentityKey == null) {
      throw new Error('Peer identity is not established')
    }

    if (peerSession.certificatesRequired === true &&
      peerSession.certificatesValidated !== true) {
      throw new Error(
        'Cannot send general message before certificate validation is complete'
      )
    }

    const requestNonce = Utils.toBase64(Random(32))
    const { signature } = await this.wallet.createSignature({
      data: message,
      protocolID: [2, 'auth message signature'],
      keyID: `${requestNonce} ${peerSession.peerNonce ?? ''}`,
      counterparty: peerSession.peerIdentityKey
    }, this.originator)

    const generalMessage: AuthMessage = {
      version: AUTH_VERSION,
      messageType: 'general',
      identityKey: await this.getIdentityPublicKey(),
      nonce: requestNonce,
      yourNonce: peerSession.peerNonce,
      payload: message,
      signature
    }

    await this.touchSession(peerSession.sessionNonce as string)

    try {
      await this.transport.send(generalMessage)
    } catch (error: unknown) {
      this.propagateTransportError(peerSession.peerIdentityKey, error)
    }
  }

  private async touchSession(sessionNonce: string): Promise<void> {
    await this.updateCertificateSession(sessionNonce, async session => {
      session.lastUpdate = Date.now()
    })
  }

  private snapshotCertificatePolicy(policy: RequestedCertificateSet): RequestedCertificateSet {
    return {
      certifiers: [...policy.certifiers],
      types: Object.fromEntries(
        Object.entries(policy.types).map(([type, fields]) => [type, [...fields]])
      )
    }
  }

  private matchesCertificatePolicy(
    certificates: VerifiableCertificate[],
    policy: RequestedCertificateSet
  ): boolean {
    return certificates.every(
      certificate =>
        policy.certifiers.includes(certificate.certifier) &&
        Object.hasOwn(policy.types, certificate.type)
    )
  }

  // Serialize local read-modify-write operations even when a session store returns copies.
  // Transport sends and observer callbacks run outside this section to allow loopback delivery.
  private async updateCertificateSession<T>(
    sessionNonce: string,
    update: (session: PeerSession) => Promise<T>
  ): Promise<T> {
    const manager = this.sessionManager as SessionManager | AsyncSessionManager
    const previous = this.certificateSessionUpdates.get(sessionNonce) ?? Promise.resolve()
    const pending = previous.then(async () => {
      const session = await manager.getSession(sessionNonce)
      if (session == null) throw new Error(`Session not found for nonce: ${sessionNonce}`)
      const result = await update(session)
      await manager.updateSession(session)
      return result
    })
    const settled = pending.then(
      () => {},
      () => {}
    )
    this.certificateSessionUpdates.set(sessionNonce, settled)
    try {
      return await pending
    } finally {
      if (this.certificateSessionUpdates.get(sessionNonce) === settled) {
        this.certificateSessionUpdates.delete(sessionNonce)
      }
    }
  }

  /**
   * Sends a request for certificates to a peer.
   * This method allows a peer to dynamically request specific certificates after
   * an initial handshake or message has been exchanged.
   *
   * @param {RequestedCertificateSet} certificatesToRequest - Specifies the certifiers and types of certificates required from the peer.
   * @param {string} [identityKey] - The identity public key of the peer. If not provided, the current or last session identity is used.
   * @returns {Promise<void>} Resolves if the certificate request message is successfully sent.
   * @throws Will throw an error if the peer session is not authenticated or if sending the request fails.
   */
  async requestCertificates (
    certificatesToRequest: RequestedCertificateSet,
    identityKey?: string
  ): Promise<void> {
    if (
      this.autoPersistLastSession &&
      typeof this.lastInteractedWithPeer === 'string' &&
      typeof identityKey !== 'string'
    ) {
      identityKey = this.lastInteractedWithPeer
    }

    const peerSession = await this.getAuthenticatedSession(identityKey)

    const policy = this.snapshotCertificatePolicy(certificatesToRequest)
    const sessionNonce = peerSession.sessionNonce as string

    // Prepare the message
    const requestNonce = Utils.toBase64(Random(32))
    const { signature } = await this.wallet.createSignature({
      data: Peer.utf8ToBytes(JSON.stringify(policy)),
      protocolID: [2, 'auth message signature'],
      keyID: `${requestNonce} ${peerSession.peerNonce ?? ''}`,
      counterparty: peerSession.peerIdentityKey
    }, this.originator)

    const certRequestMessage: AuthMessage = {
      version: AUTH_VERSION,
      messageType: 'certificateRequest',
      identityKey: await this.getIdentityPublicKey(),
      nonce: requestNonce,
      initialNonce: peerSession.sessionNonce,
      yourNonce: peerSession.peerNonce,
      requestedCertificates: policy,
      signature
    }

    // Store our policy before send: an in-memory transport may respond synchronously.
    await this.updateCertificateSession(sessionNonce, async session => {
      session.pendingCertificateRequests ??= {}
      session.pendingCertificateRequests[requestNonce] = this.snapshotCertificatePolicy(policy)
      session.lastUpdate = Date.now()
    })

    try {
      await this.transport.send(certRequestMessage)
    } catch (error: unknown) {
      await this.updateCertificateSession(sessionNonce, async session => {
        delete session.pendingCertificateRequests?.[requestNonce]
      })
      this.propagateTransportError(peerSession.peerIdentityKey, error)
    }
  }

  /**
   * Retrieves an authenticated session for a given peer identity. If no session exists
   * or the session is not authenticated, initiates a handshake to create or authenticate the session.
   *
   * - If `identityKey` is provided, we look up any existing session for that identity key.
   * - If none is found or not authenticated, we do a new handshake.
   * - If `identityKey` is not provided, but we have a `lastInteractedWithPeer`, we try that key.
   *
   * @param {string} [identityKey] - The identity public key of the peer.
   * @returns {Promise<PeerSession>} - A promise that resolves with an authenticated `PeerSession`.
   */
  async getAuthenticatedSession (
    identityKey?: string
  ): Promise<PeerSession> {
    if (this.transport === undefined) {
      throw new Error('Peer transport is not connected!')
    }

    let peerSession: PeerSession | undefined
    if (typeof identityKey === 'string') {
      peerSession = await this.sessionManager.getSession(identityKey)
    }

    // If that session doesn't exist or isn't authenticated, initiate handshake
    if (peerSession?.isAuthenticated !== true) {
      // This will create a brand-new session
      const sessionNonce = await this.initiateHandshake(identityKey)
      // Now retrieve it by the sessionNonce
      peerSession = await this.sessionManager.getSession(sessionNonce)
      if (peerSession?.isAuthenticated !== true) {
        throw new Error('Unable to establish mutual authentication with peer!')
      }
    }

    return peerSession
  }

  /**
   * Registers a callback to listen for general messages from peers.
   *
   * @param {(senderPublicKey: string, payload: number[]) => void | Promise<void>} callback - The function to call when a general message is received.
   * @returns {number} The ID of the callback listener.
   */
  listenForGeneralMessages (
    callback: (senderPublicKey: string, payload: number[]) => void | Promise<void>
  ): number {
    const callbackID = this.callbackIdCounter++
    this.onGeneralMessageReceivedCallbacks.set(callbackID, callback)
    return callbackID
  }

  /**
   * Removes a general message listener.
   *
   * @param {number} callbackID - The ID of the callback to remove.
   */
  stopListeningForGeneralMessages (callbackID: number): void {
    this.onGeneralMessageReceivedCallbacks.delete(callbackID)
  }

  /**
   * Registers an observer for certificates received from peers, not an acceptance hook.
   * Local certificate validation is committed and its waiters are released before observers
   * run. Throwing rejects message handling and stops subsequent observers; it does not
   * roll back validation or revoke the session. Apply acceptance policy through the locally
   * requested certificate set and explicit application authorization before protected work.
   *
   * @param {(senderPublicKey: string, certs: VerifiableCertificate[]) => void | Promise<void>} callback - The function to call when certificates are received.
   * @returns {number} The ID of the callback listener.
   */
  listenForCertificatesReceived (
    callback: (senderPublicKey: string, certs: VerifiableCertificate[]) => void | Promise<void>
  ): number {
    const callbackID = this.callbackIdCounter++
    this.onCertificatesReceivedCallbacks.set(callbackID, callback)
    return callbackID
  }

  /**
   * Cancels and unsubscribes a certificatesReceived listener.
   *
   * @param {number} callbackID - The ID of the certificates received callback to cancel.
   */
  stopListeningForCertificatesReceived (callbackID: number): void {
    this.onCertificatesReceivedCallbacks.delete(callbackID)
  }

  /**
   * Registers a callback to listen for certificates requested from peers.
   *
   * @param {(senderPublicKey: string, requestedCertificates: RequestedCertificateSet) => void | Promise<void>} callback - The function to call when a certificate request is received
   * @returns {number} The ID of the callback listener.
   */
  listenForCertificatesRequested (
    callback: (
      senderPublicKey: string,
      requestedCertificates: RequestedCertificateSet
    ) => void | Promise<void>
  ): number {
    const callbackID = this.callbackIdCounter++
    this.onCertificateRequestReceivedCallbacks.set(callbackID, callback)
    return callbackID
  }

  /**
   * Cancels and unsubscribes a certificatesRequested listener.
   *
   * @param {number} callbackID - The ID of the requested certificates callback to cancel.
   */
  stopListeningForCertificatesRequested (callbackID: number): void {
    this.onCertificateRequestReceivedCallbacks.delete(callbackID)
  }

  /**
   * Initiates the mutual authentication handshake with a peer.
   *
   * @private
   * @param {string} [identityKey] - The identity public key of the peer.
   * @returns {Promise<string>} A promise that resolves to the session nonce.
   */
  private async initiateHandshake (
    identityKey?: string
  ): Promise<string> {
    const sessionNonce = await createNonce(this.wallet, undefined, this.originator)

    const certificatePolicy = this.snapshotCertificatePolicy(this.certificatesToRequest)
    const now = Date.now()
    const certificatesRequired = certificatePolicy.certifiers.length > 0

    await this.sessionManager.addSession({
      isAuthenticated: false,
      sessionNonce,
      peerIdentityKey: identityKey,
      lastUpdate: now,
      certificatePolicy,
      certificatesRequired,
      certificatesValidated: !certificatesRequired
    })

    const initialRequest: AuthMessage = {
      version: AUTH_VERSION,
      messageType: 'initialRequest',
      identityKey: await this.getIdentityPublicKey(),
      initialNonce: sessionNonce,
      requestedCertificates: this.snapshotCertificatePolicy(certificatePolicy)
    }

    // Register before sending: an in-memory or otherwise synchronous transport
    // can deliver the response before send() resolves.
    const initialResponse = this.waitForInitialResponse(sessionNonce)
    try {
      await this.transport.send(initialRequest)
      return await initialResponse
    } catch (error) {
      this.stopListeningForInitialResponsesByNonce(sessionNonce)
      throw error
    }
  }

  /**
   * Waits for the initial response from the peer after sending an initial handshake request message.
   *
   * @param {string} sessionNonce - The session nonce created in the initial request.
   * @returns {Promise<string>} A promise that resolves with the session nonce when the initial response is received.
   */
  private async waitForInitialResponse (
    sessionNonce: string
  ): Promise<string> {
    return await new Promise(resolve => {
      const callbackID = this.listenForInitialResponse(sessionNonce, nonce => {
        this.stopListeningForInitialResponses(callbackID)
        resolve(nonce)
      })
    })
  }

  /**
   * Adds a listener for an initial response message matching a specific initial nonce.
   *
   * @private
   * @param {string} sessionNonce - The session nonce to match.
   * @param {(sessionNonce: string) => void} callback - The callback to invoke when the initial response is received.
   * @returns {number} The ID of the callback listener.
   */
  private listenForInitialResponse (
    sessionNonce: string,
    callback: (sessionNonce: string) => void
  ): number {
    const callbackID = this.callbackIdCounter++
    this.onInitialResponseReceivedCallbacks.set(callbackID, {
      callback,
      sessionNonce
    })
    return callbackID
  }

  /**
   * Removes a listener for initial responses.
   *
   * @private
   * @param {number} callbackID - The ID of the callback to remove.
   */
  private stopListeningForInitialResponses (callbackID: number): void {
    this.onInitialResponseReceivedCallbacks.delete(callbackID)
  }

  private stopListeningForInitialResponsesByNonce (sessionNonce: string): void {
    for (const [callbackID, entry] of this.onInitialResponseReceivedCallbacks) {
      if (entry.sessionNonce === sessionNonce) {
        this.stopListeningForInitialResponses(callbackID)
      }
    }
  }

  private propagateTransportError (peerIdentityKey: string | undefined, error: unknown): never {
    if (error instanceof Error) {
      if (peerIdentityKey != null) {
        const existingDetails = (error as any).details
        if (existingDetails != null && typeof existingDetails === 'object') {
          existingDetails.peerIdentityKey ??= peerIdentityKey
        } else {
          (error as any).details = { peerIdentityKey }
        }
      }
      throw error
    }

    const message = `Failed to send message to peer ${peerIdentityKey ?? 'unknown'}: ${Utils.toSafeString(error)}`
    throw new Error(message)
  }

  /**
   * Handles incoming messages from the transport.
   *
   * @param {AuthMessage} message - The incoming message to process.
   * @returns {Promise<void>}
   */
  private async handleIncomingMessage (message: AuthMessage): Promise<void> {
    if (message == null || typeof message !== 'object' || Array.isArray(message)) {
      throw new Error('Invalid authentication message.')
    }
    if (typeof message.version !== 'string' || message.version !== AUTH_VERSION) {
      throw new Error(
        `Invalid or unsupported message auth version! Received: ${message.version}, expected: ${AUTH_VERSION}`
      )
    }

    switch (message.messageType) {
      case 'initialRequest':
        await this.processInitialRequest(message)
        break
      case 'initialResponse':
        await this.processInitialResponse(message)
        break
      case 'certificateRequest':
        await this.processCertificateRequest(message)
        break
      case 'certificateResponse':
        await this.processCertificateResponse(message)
        break
      case 'general':
        await this.processGeneralMessage(message)
        break
      default:
        throw new Error(
          `Unknown message type of ${String(message.messageType)} from ${String(
            message.identityKey
          )}`
        )
    }
  }

  /**
   * Processes an initial request message from a peer.
   *
   * @param {AuthMessage} message - The incoming initial request message.
   */
  private async processInitialRequest (message: AuthMessage): Promise<void> {
    if (
      typeof message.identityKey !== 'string' ||
      typeof message.initialNonce !== 'string' ||
      message.initialNonce === ''
    ) {
      throw new Error('Missing required fields in initialRequest message.')
    }

    const sessionNonce = await createNonce(this.wallet, undefined, this.originator)
    const certificatePolicy = this.snapshotCertificatePolicy(this.certificatesToRequest)
    const now = Date.now()

    const certificatesRequired =
      Array.isArray(certificatePolicy.certifiers) && certificatePolicy.certifiers.length > 0

    await this.sessionManager.addSession({
      isAuthenticated: true,
      sessionNonce,
      peerNonce: message.initialNonce,
      peerIdentityKey: message.identityKey,
      lastUpdate: now,
      certificatePolicy,
      certificatesRequired,
      certificatesValidated: !certificatesRequired
    })

    let certificatesToInclude: VerifiableCertificate[] | undefined

    // Handle THEIR certificate request (if any)
    if (
      Array.isArray(message.requestedCertificates?.certifiers) &&
      message.requestedCertificates.certifiers.length > 0
    ) {
      if (this.onCertificateRequestReceivedCallbacks.size > 0) {
        for (const callback of this.onCertificateRequestReceivedCallbacks.values()) {
          await callback(
            message.identityKey,
            message.requestedCertificates as RequestedCertificateSet
          )
        }
      } else {
        certificatesToInclude = await getVerifiableCertificates(
          this.wallet,
          message.requestedCertificates,
          message.identityKey,
          this.originator
        )
      }
    }

    const { signature } = await this.wallet.createSignature({
      data: [
        ...Peer.base64ToBytes(message.initialNonce),
        ...Peer.base64ToBytes(sessionNonce)
      ],
      protocolID: [2, 'auth message signature'],
      keyID: `${message.initialNonce} ${sessionNonce}`,
      counterparty: message.identityKey
    }, this.originator)

    const initialResponseMessage: AuthMessage = {
      version: AUTH_VERSION,
      messageType: 'initialResponse',
      identityKey: await this.getIdentityPublicKey(),
      initialNonce: sessionNonce,
      yourNonce: message.initialNonce,
      certificates: certificatesToInclude,
      requestedCertificates: this.snapshotCertificatePolicy(certificatePolicy),
      signature
    }

    this.lastInteractedWithPeer ??= message.identityKey

    await this.transport.send(initialResponseMessage)
  }

  /**
   * Processes an initial response message from a peer.
   *
   * @private
   * @param {AuthMessage} message - The incoming initial response message.
   * @throws Will throw an error if nonce or signature verification fails.
   */
  private async authenticateInitialResponse(message: AuthMessage): Promise<PeerSession> {
    const validNonce = await verifyNonce(
      message.yourNonce as string,
      this.wallet,
      undefined,
      this.originator
    )
    if (!validNonce) {
      throw new Error(
        `Initial response nonce verification failed from peer: ${message.identityKey}`
      )
    }

    const peerSession = await this.sessionManager.getSession(message.yourNonce as string)
    if (peerSession == null) {
      throw new Error(`Peer session not found for peer: ${message.identityKey}`)
    }

    const dataToVerify = Peer.base64ToBytes(
      (peerSession.sessionNonce ?? '') + (message.initialNonce ?? '')
    )

    const { valid } = await this.wallet.verifySignature({
      data: dataToVerify,
      signature: message.signature as number[],
      protocolID: [2, 'auth message signature'],
      keyID: `${peerSession.sessionNonce ?? ''} ${message.initialNonce ?? ''}`,
      counterparty: message.identityKey
    }, this.originator)

    if (!valid) {
      throw new Error(
        `Unable to verify initial response signature for peer: ${message.identityKey}`
      )
    }

    // --- Transport authentication complete ---
    peerSession.peerNonce = message.initialNonce
    peerSession.peerIdentityKey = message.identityKey
    peerSession.isAuthenticated = true

    peerSession.certificatePolicy ??= this.snapshotCertificatePolicy(this.certificatesToRequest)
    peerSession.certificatesRequired = peerSession.certificatePolicy.certifiers.length > 0

    // IMPORTANT: validation defaults to false if certs are required
    peerSession.certificatesValidated = !peerSession.certificatesRequired

    peerSession.lastUpdate = Date.now()
    await this.sessionManager.updateSession(peerSession)
    return peerSession
  }

  private async validateInitialResponseCertificates(
    message: AuthMessage,
    peerSession: PeerSession
  ): Promise<void> {
    if (
      !peerSession.certificatesRequired ||
      !Array.isArray(message.certificates) ||
      message.certificates.length === 0
    ) {
      return
    }
    const sessionNonce = peerSession.sessionNonce as string
    await this.updateCertificateSession(sessionNonce, async session => {
      await validateCertificates(
        this.wallet,
        message,
        session.certificatePolicy ?? this.certificatesToRequest,
        this.originator
      )
      session.certificatesValidated = true
      session.lastUpdate = Date.now()
    })
    this.resolveCertificateValidation(sessionNonce)

    for (const callback of this.onCertificatesReceivedCallbacks.values()) {
      await callback(message.identityKey, message.certificates as VerifiableCertificate[])
    }
  }

  private releaseInitialResponseWaiters(peerSession: PeerSession): void {
    this.onInitialResponseReceivedCallbacks.forEach(entry => {
      if (entry.sessionNonce === peerSession.sessionNonce) {
        entry.callback(peerSession.sessionNonce)
      }
    })
  }

  private async answerInitialCertificateRequest(message: AuthMessage): Promise<void> {
    if (
      message.requestedCertificates == null ||
      !Array.isArray(message.requestedCertificates.certifiers) ||
      message.requestedCertificates.certifiers.length === 0
    ) {
      return
    }
    if (this.onCertificateRequestReceivedCallbacks.size > 0) {
      for (const callback of this.onCertificateRequestReceivedCallbacks.values()) {
        await callback(
          message.identityKey,
          message.requestedCertificates as RequestedCertificateSet
        )
      }
      return
    }
    const verifiableCertificates = await getVerifiableCertificates(
      this.wallet,
      message.requestedCertificates,
      message.identityKey,
      this.originator
    )
    // An empty response has no value and can race with a subsequent request
    // that shares the same initial nonce.
    if (verifiableCertificates.length > 0) {
      await this.sendCertificateResponse(message.identityKey, verifiableCertificates)
    }
  }

  private async processInitialResponse(message: AuthMessage): Promise<void> {
    const peerSession = await this.authenticateInitialResponse(message)
    await this.validateInitialResponseCertificates(message, peerSession)
    this.lastInteractedWithPeer = message.identityKey
    this.releaseInitialResponseWaiters(peerSession)
    await this.answerInitialCertificateRequest(message)
  }

  /**
   * Processes an incoming certificate request message from a peer.
   * Verifies nonce/signature and then possibly sends a certificateResponse.
   *
   * @param {AuthMessage} message - The certificate request message received from the peer.
   * @throws {Error} if nonce or signature is invalid.
   */
  private async processCertificateRequest (message: AuthMessage): Promise<void> {
    const validNonce = await verifyNonce(message.yourNonce as string, this.wallet, undefined, this.originator)
    if (!validNonce) {
      throw new Error(
        `Unable to verify nonce for certificate request message from: ${message.identityKey}`
      )
    }
    const peerSession = await this.sessionManager.getSession(message.yourNonce as string)
    if (peerSession == null) {
      throw new Error(`Session not found for nonce: ${message.yourNonce as string}`)
    }

    const { valid } = await this.wallet.verifySignature({
      data: Peer.utf8ToBytes(JSON.stringify(message.requestedCertificates)),
      signature: message.signature as number[],
      protocolID: [2, 'auth message signature'],
      keyID: `${message.nonce ?? ''} ${peerSession.sessionNonce ?? ''}`,
      counterparty: peerSession.peerIdentityKey
    }, this.originator)
    if (!valid) {
      throw new Error(
        `Invalid signature in certificate request message from ${peerSession.peerIdentityKey as string}`
      )
    }

    // Update usage
    await this.touchSession(peerSession.sessionNonce as string)

    if (
      message.requestedCertificates != null &&
      Array.isArray(message.requestedCertificates.certifiers) &&
      message.requestedCertificates.certifiers.length > 0
    ) {
      if (this.onCertificateRequestReceivedCallbacks.size > 0) {
        // Let the application handle it
        for (const callback of this.onCertificateRequestReceivedCallbacks.values()) {
          await callback(
            message.identityKey,
            message.requestedCertificates as RequestedCertificateSet
          )
        }
      } else {
        // Attempt auto
        const verifiableCertificates = await getVerifiableCertificates(
          this.wallet,
          message.requestedCertificates,
          message.identityKey,
          this.originator
        )
        await this.sendCertificateResponse(message.identityKey, verifiableCertificates)
      }
    }
  }

  /**
   * Sends a certificate response message containing the specified certificates to a peer.
   *
   * @param {string} verifierIdentityKey - The identity key of the peer requesting the certificates.
   * @param {VerifiableCertificate[]} certificates - The list of certificates to include in the response.
   * @throws Will throw an error if the transport fails to send the message.
   */
  async sendCertificateResponse (
    verifierIdentityKey: string,
    certificates: VerifiableCertificate[]
  ): Promise<void> {
    const peerSession = await this.getAuthenticatedSession(verifierIdentityKey)
    const requestNonce = Utils.toBase64(Random(32))
    const { signature } = await this.wallet.createSignature({
      data: Peer.utf8ToBytes(JSON.stringify(certificates)),
      protocolID: [2, 'auth message signature'],
      keyID: `${requestNonce} ${peerSession.peerNonce ?? ''}`,
      counterparty: peerSession.peerIdentityKey
    }, this.originator)

    const certificateResponse: AuthMessage = {
      version: AUTH_VERSION,
      messageType: 'certificateResponse',
      identityKey: await this.getIdentityPublicKey(),
      nonce: requestNonce,
      initialNonce: peerSession.sessionNonce,
      yourNonce: peerSession.peerNonce,
      certificates,
      signature
    }

    // Update usage
    await this.touchSession(peerSession.sessionNonce as string)

    try {
      await this.transport.send(certificateResponse)
    } catch (error: unknown) {
      this.propagateTransportError(peerSession.peerIdentityKey, error)
    }
  }

  /**
   * Processes a certificate response message from a peer.
   *
   * @private
   * @param {AuthMessage} message - The incoming certificate response message.
   * @throws Will throw an error if nonce verification or signature verification fails.
   */
  private async processCertificateResponse (message: AuthMessage): Promise<void> {
    const validNonce = await verifyNonce(message.yourNonce as string, this.wallet, undefined, this.originator)
    if (!validNonce) {
      throw new Error(
        `Unable to verify nonce for certificate response from: ${message.identityKey}`
      )
    }

    const peerSession = await this.sessionManager.getSession(message.yourNonce as string)
    if (peerSession == null) {
      throw new Error(`Session not found for nonce: ${message.yourNonce as string}`)
    }

    if (
      typeof peerSession.peerIdentityKey === 'string' &&
      peerSession.peerIdentityKey !== message.identityKey
    ) {
      throw new Error('Certificate response identity does not match the authenticated session.')
    }

    // Validate message signature
    const { valid } = await this.wallet.verifySignature({
      data: Peer.utf8ToBytes(JSON.stringify(message.certificates)),
      signature: message.signature as number[],
      protocolID: [2, 'auth message signature'],
      keyID: `${message.nonce ?? ''} ${peerSession.sessionNonce ?? ''}`,
      counterparty: message.identityKey
    }, this.originator)
    if (!valid) {
      throw new Error(
        `Unable to verify certificate response signature for peer: ${message.identityKey}`
      )
    }

    if (Array.isArray(message.certificates) && message.certificates.length > 0) {
      const sessionNonce = peerSession.sessionNonce as string
      const validated = await this.updateCertificateSession(sessionNonce, async session => {
        const certificates = message.certificates as VerifiableCertificate[]
        const handshakePolicy = session.certificatePolicy ?? this.certificatesToRequest
        // v0.1 responses do not echo the request nonce. Match one complete locally
        // recorded policy; never combine certifier/type permissions from separate requests.
        const requested = Object.entries(session.pendingCertificateRequests ?? {}).find(
          ([, policy]) => this.matchesCertificatePolicy(certificates, policy)
        )
        const matchesHandshake = this.matchesCertificatePolicy(certificates, handshakePolicy)
        const policy = requested?.[1] ?? (matchesHandshake ? handshakePolicy : undefined)
        if (policy == null) {
          throw new Error('Certificates do not match a locally requested set for this session.')
        }
        await validateCertificates(this.wallet, message, policy, this.originator)
        if (requested != null) delete session.pendingCertificateRequests?.[requested[0]]
        // A separate dynamic request cannot satisfy a different handshake requirement.
        if (matchesHandshake) session.certificatesValidated = true
        session.lastUpdate = Date.now()
        return session.certificatesValidated === true
      })
      if (validated) this.resolveCertificateValidation(sessionNonce)
    }

    // Notify any listeners
    for (const callback of this.onCertificatesReceivedCallbacks.values()) {
      await callback(message.identityKey, message.certificates ?? [])
    }
  }

  /**
   * Processes a general message from a peer.
   *
   * @private
   * @param {AuthMessage} message - The incoming general message.
   * @throws Will throw an error if nonce or signature verification fails.
   */
  private async processGeneralMessage (message: AuthMessage): Promise<void> {
    const validNonce = await verifyNonce(
      message.yourNonce as string,
      this.wallet,
      undefined,
      this.originator
    )

    if (!validNonce) {
      throw new Error(
        `Unable to verify nonce for general message from: ${message.identityKey}`
      )
    }

    const peerSession = await this.sessionManager.getSession(message.yourNonce as string)
    if (peerSession == null) {
      throw new Error(`Session not found for nonce: ${message.yourNonce as string}`)
    }

    const certificatesRequired = peerSession.certificatesRequired === true
    const certificatesValidated = peerSession.certificatesValidated === true

    // If certificates are required but not yet validated, wait for them with a timeout
    if (certificatesRequired && !certificatesValidated) {
      const CERTIFICATE_WAIT_TIMEOUT_MS = 30000
      const sessionNonce = peerSession.sessionNonce

      if (sessionNonce == null) {
        throw new Error('Session nonce is required for certificate validation')
      }

      await new Promise<void>((resolve, reject) => {
        // Set timeout to reject if certificates don't arrive
        const timeoutId = setTimeout(() => {
          const promise = this.certificateValidationPromises.get(sessionNonce)
          if (promise != null) {
            this.certificateValidationPromises.delete(sessionNonce)
            reject(new Error(
              `Timeout waiting for certificate validation from peer ${peerSession.peerIdentityKey ?? 'unknown'
              }`
            ))
          }
        }, CERTIFICATE_WAIT_TIMEOUT_MS)
        // Ensure the timer doesn't prevent process exit during tests
        if (typeof timeoutId === 'object' && 'unref' in timeoutId) {
          timeoutId.unref()
        }

        // Store the promise resolvers with timeout cleanup
        this.certificateValidationPromises.set(sessionNonce, {
          resolve: () => {
            clearTimeout(timeoutId)
            resolve()
          },
          reject: (error: Error) => {
            clearTimeout(timeoutId)
            reject(error)
          }
        })
      })
    }

    const { valid } = await this.wallet.verifySignature({
      data: message.payload,
      signature: message.signature as number[],
      protocolID: [2, 'auth message signature'],
      keyID: `${message.nonce ?? ''} ${peerSession.sessionNonce ?? ''}`,
      counterparty: peerSession.peerIdentityKey
    }, this.originator)

    if (!valid) {
      throw new Error(
        `Invalid signature in generalMessage from ${peerSession.peerIdentityKey as string}`
      )
    }

    // Mark last usage
    await this.touchSession(peerSession.sessionNonce as string)

    // Update lastInteractedWithPeer
    this.lastInteractedWithPeer = message.identityKey

    // Dispatch callbacks
    for (const callback of this.onGeneralMessageReceivedCallbacks.values()) {
      await callback(message.identityKey, message.payload ?? [])
    }
  }

  /**
   * Resolves any pending certificate validation promises for the given session nonce.
   * This should be called when certificates have been successfully validated.
   *
   * @private
   * @param {string} sessionNonce - The session nonce to resolve promises for.
   */
  private resolveCertificateValidation (sessionNonce: string): void {
    const promise = this.certificateValidationPromises.get(sessionNonce)
    if (promise != null) {
      promise.resolve()
      this.certificateValidationPromises.delete(sessionNonce)
    }
  }

  private async getIdentityPublicKey (): Promise<string> {
    if (this.identityPublicKey != null) {
      return this.identityPublicKey
    }

    const { publicKey } = await this.wallet.getPublicKey(
      { identityKey: true },
      this.originator
    )

    this.identityPublicKey = publicKey
    return publicKey
  }

  private static utf8ToBytes (data: string): number[] {
    if (BufferCtor != null) {
      return Array.from(BufferCtor.from(data, 'utf8'))
    }

    if (typeof TextEncoder !== 'undefined') {
      return Array.from(new TextEncoder().encode(data))
    }

    return Utils.toArray(data, 'utf8')
  }

  private static base64ToBytes (data: string): number[] {
    if (BufferCtor != null) {
      return Array.from(BufferCtor.from(data, 'base64'))
    }

    return Utils.toArray(data, 'base64')
  }
}
