import { SessionManager, AsyncSessionManager } from './SessionManager.js'
import { createNonce } from './utils/createNonce.js'
import { verifyNonce } from './utils/verifyNonce.js'
import { getVerifiableCertificates } from './utils/getVerifiableCertificates.js'
import { validateCertificates } from './utils/validateCertificates.js'
import {
  AuthMessage,
  AuthMessageValidationOptions,
  PeerSession,
  RequestedCertificateSet,
  Transport
} from './types.js'
import { VerifiableCertificate } from './certificates/VerifiableCertificate.js'
import {
  assertAuthIdentityKey,
  assertAuthPeerTarget,
  assertGeneralPayloadByteLimit,
  assertRequestedCertificateSet,
  copyAuthByteArray,
  snapshotAuthMessage,
  snapshotBoundedAuthData,
  MAX_AUTH_MESSAGE_BYTES
} from './AuthMessageValidation.js'
import Random from '../primitives/Random.js'
import { toArray, toBase64, toSafeString } from '../primitives/utils.js'
import { utf8Bytes } from '../primitives/UTF8.js'
import {
  OriginatorDomainNameStringUnder250Bytes,
  WalletInterface
} from '../wallet/Wallet.interfaces.js'

const AUTH_VERSION = '0.1'
const INITIAL_RESPONSE_TIMEOUT_MS = 30_000
const BufferCtor = typeof globalThis === 'undefined' ? undefined : (globalThis as any).Buffer

/**
 * Represents a peer capable of performing mutual authentication.
 * Manages sessions, handles authentication handshakes, certificate requests and responses,
 * and sending and receiving general messages over a transport layer.
 *
 * This version supports multiple concurrent sessions per peer identityKey.
 * Signed message nonces are accepted once per session and an unsigned initial
 * request remains partially authenticated until a signed follow-up proves the
 * claimed identity. BRC-103 does not encrypt the transport; callers must add
 * confidentiality and authorize the authenticated identity separately.
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
  readonly #transport: Transport
  readonly #wallet: WalletInterface
  readonly #maxGeneralPayloadBytes: number | null | undefined
  certificatesToRequest: RequestedCertificateSet
  private readonly certificateSessionUpdates = new Map<string, Promise<void>>()
  private readonly onGeneralMessageReceivedCallbacks: Map<
    number,
    (senderPublicKey: string, payload: number[]) => void | Promise<void>
  > = new Map()

  private readonly onCertificatesReceivedCallbacks: Map<
    number,
    (
      senderPublicKey: string,
      certs: VerifiableCertificate[],
      sessionNonce: string,
      peerNonce?: string
    ) => void | Promise<void>
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
    { callback: (sessionNonce: string) => void; sessionNonce: string }
  > = new Map()
  readonly #initialResponseTimeouts = new Map<number, ReturnType<typeof setTimeout>>()

  // Promise-based mechanism for waiting on certificate validation
  private readonly certificateValidationPromises: Map<
    string,
    { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void }
  > = new Map()

  // Single shared counter for all callback types
  #callbackIdCounter: number = 0

  // Whether to auto-persist the session with the last-interacted-with peer
  readonly #autoPersistLastSession: boolean = true

  // Last peer established by a locally initiated handshake. Inbound traffic never
  // changes this implicit destination, so an authenticated sender cannot retarget
  // a later parameterless outbound message.
  private lastInteractedWithPeer: string | undefined

  readonly #originator?: OriginatorDomainNameStringUnder250Bytes
  #identityPublicKey?: string

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
   * @param {RequestedCertificateSet} [certificatesToRequest] - Optional v0.1 certificate allowlist/request. Validation does not prove that every listed type or field was supplied; inspect received decrypted fields before authorization.
   * @param {SessionManager | AsyncSessionManager} [sessionManager] - Optional session store. Pass an {@link AsyncSessionManager} with atomic `claimMessageNonce` and `claimInitialRequestNonce` for shared/durable storage in load-balanced deployments; otherwise the bounded default in-process {@link SessionManager} is used.
   * @param {boolean} [autoPersistLastSession] - Whether to auto-persist the session with the last-interacted-with peer. Defaults to true.
   * @param {OriginatorDomainNameStringUnder250Bytes} [originator] - Optional originator domain name.
   * @param {AuthMessageValidationOptions} [messageValidation] - Local policy; set maxGeneralPayloadBytes to null to delegate capacity to the transport. Omission preserves existing limits.
   */
  constructor(
    wallet: WalletInterface,
    transport: Transport,
    certificatesToRequest?: RequestedCertificateSet,
    sessionManager?: SessionManager | AsyncSessionManager,
    autoPersistLastSession?: boolean,
    originator?: OriginatorDomainNameStringUnder250Bytes,
    messageValidation: AuthMessageValidationOptions = {}
  ) {
    const maxGeneralPayloadBytes = messageValidation.maxGeneralPayloadBytes
    assertGeneralPayloadByteLimit(maxGeneralPayloadBytes)
    this.#maxGeneralPayloadBytes = maxGeneralPayloadBytes
    this.#wallet = wallet
    this.#originator = originator
    this.#transport = transport
    const certificatePolicy = certificatesToRequest ?? {
      certifiers: [],
      types: {}
    }
    assertRequestedCertificateSet(certificatePolicy)
    this.certificatesToRequest = this.#snapshotCertificatePolicy(certificatePolicy)
    // Cast keeps the public field typed as the synchronous `SessionManager`
    // for back-compat. When an `AsyncSessionManager` is injected, the actual
    // runtime methods return Promises — Peer awaits them internally below.
    this.sessionManager = (sessionManager ?? new SessionManager()) as SessionManager
    this.ready = this.#transport.onData(this.#handleIncomingMessage.bind(this)) // NOSONAR(typescript:S7059): listener must register synchronously — see ready field comment
    if (autoPersistLastSession === false) {
      this.#autoPersistLastSession = false
    } else {
      this.#autoPersistLastSession = true
    }
  }

  /**
   * Sends a general message to a peer, and initiates a handshake if necessary.
   *
   * @param {number[]} message - The message payload to send.
   * @param {string} [identityKey] - The identity public key of the peer, or an exact session nonce for a transport response. If not provided, uses the peer from the most recent locally initiated handshake (if any). Inbound messages never select this implicit destination.
   * @returns {Promise<void>}
   * @throws Will throw an error if the message fails to send.
   */
  async toPeer(message: number[], identityKey?: string): Promise<void> {
    message = copyAuthByteArray(
      message,
      'general.payload',
      this.#maxGeneralPayloadBytes === null
        ? Number.MAX_SAFE_INTEGER
        : (this.#maxGeneralPayloadBytes ?? MAX_AUTH_MESSAGE_BYTES),
      true
    )
    if (identityKey !== undefined) assertAuthPeerTarget(identityKey)
    if (
      this.#autoPersistLastSession &&
      typeof this.lastInteractedWithPeer === 'string' &&
      typeof identityKey !== 'string'
    ) {
      identityKey = this.lastInteractedWithPeer
    }

    const peerSession = await this.getAuthenticatedSession(identityKey)

    if (peerSession.peerIdentityKey == null) {
      throw new Error('Peer identity is not established')
    }

    if (peerSession.certificatesRequired === true && peerSession.certificatesValidated !== true) {
      throw new Error('Cannot send general message before certificate validation is complete')
    }

    const requestNonce = toBase64(Random(32))
    const { signature: signatureResult } = await this.#wallet.createSignature(
      {
        data: message,
        protocolID: [2, 'auth message signature'],
        keyID: `${requestNonce} ${peerSession.peerNonce ?? ''}`,
        counterparty: peerSession.peerIdentityKey
      },
      this.#originator
    )
    const signature = copyAuthByteArray(signatureResult, 'general.signature', 1024)

    const generalMessage: AuthMessage = {
      version: AUTH_VERSION,
      messageType: 'general',
      identityKey: await this.#getIdentityPublicKey(),
      nonce: requestNonce,
      yourNonce: peerSession.peerNonce,
      payload: message,
      signature
    }

    await this.#touchSession(peerSession.sessionNonce as string)

    try {
      const outbound =
        this.#maxGeneralPayloadBytes === undefined
          ? snapshotBoundedAuthData(generalMessage)
          : snapshotAuthMessage(generalMessage, {
              maxGeneralPayloadBytes: this.#maxGeneralPayloadBytes
            })
      await this.#transport.send(outbound)
    } catch (error: unknown) {
      this.propagateTransportError(peerSession.peerIdentityKey, error)
    }
  }

  async #touchSession(sessionNonce: string): Promise<void> {
    await this.updateCertificateSession(sessionNonce, async session => {
      session.lastUpdate = Date.now()
    })
  }

  async #markSessionAuthenticated(sessionNonce: string): Promise<void> {
    await this.updateCertificateSession(sessionNonce, async session => {
      session.isAuthenticated = true
      session.lastUpdate = Date.now()
    })
  }

  async #claimIncomingMessageNonce(
    sessionNonce: string,
    messageNonce: string,
    messageType: AuthMessage['messageType']
  ): Promise<void> {
    const manager = this.sessionManager as SessionManager | AsyncSessionManager
    if (typeof manager.claimMessageNonce !== 'function') {
      throw new Error(
        'AsyncSessionManager must implement atomic claimMessageNonce for BRC-103 replay protection.'
      )
    }
    const claimed = await manager.claimMessageNonce(sessionNonce, messageNonce)
    if (claimed !== true) {
      throw new Error(`Replayed ${messageType} message nonce.`)
    }
  }

  private async claimInitialRequestNonce(identityKey: string, initialNonce: string): Promise<void> {
    const manager = this.sessionManager as SessionManager | AsyncSessionManager
    if (typeof manager.claimInitialRequestNonce !== 'function') {
      throw new Error(
        'AsyncSessionManager must implement atomic claimInitialRequestNonce for BRC-103 replay protection.'
      )
    }
    const claimed = await manager.claimInitialRequestNonce(identityKey, initialNonce)
    if (claimed !== true) throw new Error('Replayed initialRequest nonce.')
  }

  async #waitForCertificateValidation(
    sessionNonce: string,
    peerIdentityKey: string | undefined
  ): Promise<void> {
    const existing = this.certificateValidationPromises.get(sessionNonce)
    if (existing != null) return await existing.promise

    let resolvePromise!: () => void
    let rejectPromise!: (error: Error) => void
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const timeoutId = setTimeout(() => {
      const entry = this.certificateValidationPromises.get(sessionNonce)
      if (entry == null || entry.promise !== promise) return
      this.certificateValidationPromises.delete(sessionNonce)
      entry.reject(
        new Error(
          `Timeout waiting for certificate validation from peer ${peerIdentityKey ?? 'unknown'}`
        )
      )
    }, 30000)
    if (typeof timeoutId === 'object' && 'unref' in timeoutId) timeoutId.unref()

    this.certificateValidationPromises.set(sessionNonce, {
      promise,
      resolve: () => {
        clearTimeout(timeoutId)
        if (this.certificateValidationPromises.get(sessionNonce)?.promise === promise) {
          this.certificateValidationPromises.delete(sessionNonce)
        }
        resolvePromise()
      },
      reject: (error: Error) => {
        clearTimeout(timeoutId)
        if (this.certificateValidationPromises.get(sessionNonce)?.promise === promise) {
          this.certificateValidationPromises.delete(sessionNonce)
        }
        rejectPromise(error)
      }
    })
    return await promise
  }

  #snapshotCertificatePolicy(policy: RequestedCertificateSet): RequestedCertificateSet {
    assertRequestedCertificateSet(policy)
    return {
      certifiers: [...policy.certifiers],
      types: Object.fromEntries(
        Object.entries(policy.types).map(([type, fields]) => [type, [...fields]])
      )
    }
  }

  #restoreOwnedCertificates(message: AuthMessage): void {
    if (!Array.isArray(message.certificates)) return
    message.certificates = message.certificates.map(
      certificate =>
        new VerifiableCertificate(
          certificate.type,
          certificate.serialNumber,
          certificate.subject,
          certificate.certifier,
          certificate.revocationOutpoint,
          certificate.fields,
          certificate.keyring,
          certificate.signature,
          certificate.decryptedFields
        )
    )
  }

  #matchesCertificatePolicy(
    certificates: VerifiableCertificate[],
    policy: RequestedCertificateSet
  ): boolean {
    return certificates.every(certificate => {
      const requestedFields = policy.types[certificate.type]
      if (!policy.certifiers.includes(certificate.certifier) || !Array.isArray(requestedFields)) {
        return false
      }
      if (
        certificate.keyring == null ||
        typeof certificate.keyring !== 'object' ||
        Array.isArray(certificate.keyring)
      ) {
        return false
      }
      const disclosedFields = Reflect.ownKeys(certificate.keyring)
      if (disclosedFields.length === 0 || disclosedFields.length > requestedFields.length) {
        return false
      }
      return disclosedFields.every(field => {
        if (typeof field !== 'string' || !requestedFields.includes(field)) return false
        const descriptor = Object.getOwnPropertyDescriptor(certificate.keyring, field)
        return (
          descriptor != null &&
          Object.hasOwn(descriptor, 'value') &&
          typeof descriptor.value === 'string'
        )
      })
    })
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
   * @param {RequestedCertificateSet} certificatesToRequest - Specifies allowed certifiers, types, and fields to request. Under the legacy v0.1 contract, success does not prove that every listed type or field was supplied.
   * @param {string} [identityKey] - The identity public key of the peer. If not provided, the current or last session identity is used.
   * @returns {Promise<void>} Resolves if the certificate request message is successfully sent.
   * @throws Will throw an error if the peer session is not authenticated or if sending the request fails.
   */
  async requestCertificates(
    certificatesToRequest: RequestedCertificateSet,
    identityKey?: string
  ): Promise<void> {
    assertRequestedCertificateSet(certificatesToRequest)
    if (identityKey !== undefined) assertAuthIdentityKey(identityKey)
    if (
      this.#autoPersistLastSession &&
      typeof this.lastInteractedWithPeer === 'string' &&
      typeof identityKey !== 'string'
    ) {
      identityKey = this.lastInteractedWithPeer
    }

    const peerSession = await this.getAuthenticatedSession(identityKey)

    const policy = this.#snapshotCertificatePolicy(certificatesToRequest)
    const sessionNonce = peerSession.sessionNonce as string

    // Prepare the message
    const requestNonce = toBase64(Random(32))
    const { signature: signatureResult } = await this.#wallet.createSignature(
      {
        data: Peer.#utf8ToBytes(JSON.stringify(policy)),
        protocolID: [2, 'auth message signature'],
        keyID: `${requestNonce} ${peerSession.peerNonce ?? ''}`,
        counterparty: peerSession.peerIdentityKey
      },
      this.#originator
    )
    const signature = copyAuthByteArray(signatureResult, 'certificateRequest.signature', 1024)

    const certRequestMessage: AuthMessage = {
      version: AUTH_VERSION,
      messageType: 'certificateRequest',
      identityKey: await this.#getIdentityPublicKey(),
      nonce: requestNonce,
      initialNonce: peerSession.sessionNonce,
      yourNonce: peerSession.peerNonce,
      requestedCertificates: policy,
      signature
    }

    // Store our policy before send: an in-memory transport may respond synchronously.
    await this.updateCertificateSession(sessionNonce, async session => {
      session.pendingCertificateRequests ??= {}
      session.pendingCertificateRequests[requestNonce] = this.#snapshotCertificatePolicy(policy)
      session.lastUpdate = Date.now()
    })

    try {
      await this.#transport.send(snapshotBoundedAuthData(certRequestMessage))
    } catch (error: unknown) {
      await this.updateCertificateSession(sessionNonce, async session => {
        delete session.pendingCertificateRequests?.[requestNonce]
      })
      this.propagateTransportError(peerSession.peerIdentityKey, error)
    }
  }

  /**
   * Retrieves a transport-authenticated session for a given peer identity. If no session exists
   * or the session is not authenticated, initiates a handshake to create or authenticate the session.
   *
   * - If `identityKey` is provided, we look up any existing session for that identity key.
   * - If none is found or not authenticated, we do a new handshake.
   * - If `identityKey` is not provided, only the peer selected by the most recent
   *   successfully completed locally initiated handshake may be used. Inbound
   *   messages never select this implicit destination.
   *
   * `isAuthenticated` proves control of the session identity key. It does not
   * grant application authorization. When certificates are configured, also
   * inspect `certificatesValidated` and the actual received/decrypted fields;
   * v0.1 allowlist validation does not prove complete policy fulfillment.
   *
   * @param {string} [identityKey] - The identity public key of the peer.
   * @returns {Promise<PeerSession>} - A promise that resolves with an authenticated `PeerSession`.
   */
  async getAuthenticatedSession(identityKey?: string): Promise<PeerSession> {
    if (this.#transport === undefined) {
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
  listenForGeneralMessages(
    callback: (senderPublicKey: string, payload: number[]) => void | Promise<void>
  ): number {
    const callbackID = this.#callbackIdCounter++
    this.onGeneralMessageReceivedCallbacks.set(callbackID, callback)
    return callbackID
  }

  /**
   * Removes a general message listener.
   *
   * @param {number} callbackID - The ID of the callback to remove.
   */
  stopListeningForGeneralMessages(callbackID: number): void {
    this.onGeneralMessageReceivedCallbacks.delete(callbackID)
  }

  /**
   * Registers an observer for certificates received from peers, not an acceptance hook.
   * Local certificate validation is committed and its waiters are released before observers
   * run. Throwing rejects message handling and stops subsequent observers; it does not
   * roll back validation or revoke the session. Apply acceptance policy through the locally
   * requested certificate set and explicit application authorization before protected work.
   *
   * @param {(senderPublicKey: string, certs: VerifiableCertificate[], sessionNonce: string, peerNonce?: string) => void | Promise<void>} callback - The function to call when certificates are received. The local and peer session nonces identify the exact validated exchange; callbacks that do not need them remain compatible.
   * @returns {number} The ID of the callback listener.
   */
  listenForCertificatesReceived(
    callback: (
      senderPublicKey: string,
      certs: VerifiableCertificate[],
      sessionNonce: string,
      peerNonce?: string
    ) => void | Promise<void>
  ): number {
    const callbackID = this.#callbackIdCounter++
    this.onCertificatesReceivedCallbacks.set(callbackID, callback)
    return callbackID
  }

  /**
   * Cancels and unsubscribes a certificatesReceived listener.
   *
   * @param {number} callbackID - The ID of the certificates received callback to cancel.
   */
  stopListeningForCertificatesReceived(callbackID: number): void {
    this.onCertificatesReceivedCallbacks.delete(callbackID)
  }

  /**
   * Registers a callback to listen for certificates requested from peers.
   *
   * This callback can run for an unsigned initial request, where
   * `senderPublicKey` is only a claimed destination key. Do not treat the
   * callback as an authentication/authorization event and do not disclose
   * plaintext fields from it. Use wallet-backed certificate proving so revealed
   * keys are encrypted to the claimed identity; later signed protocol messages
   * establish whether the requester controls that key.
   *
   * @param {(senderPublicKey: string, requestedCertificates: RequestedCertificateSet) => void | Promise<void>} callback - The function to call when a certificate request is received.
   * @returns {number} The ID of the callback listener.
   */
  listenForCertificatesRequested(
    callback: (
      senderPublicKey: string,
      requestedCertificates: RequestedCertificateSet
    ) => void | Promise<void>
  ): number {
    const callbackID = this.#callbackIdCounter++
    this.onCertificateRequestReceivedCallbacks.set(callbackID, callback)
    return callbackID
  }

  /**
   * Cancels and unsubscribes a certificatesRequested listener.
   *
   * @param {number} callbackID - The ID of the requested certificates callback to cancel.
   */
  stopListeningForCertificatesRequested(callbackID: number): void {
    this.onCertificateRequestReceivedCallbacks.delete(callbackID)
  }

  /**
   * Initiates the mutual authentication handshake with a peer.
   *
   * @private
   * @param {string} [identityKey] - The identity public key of the peer.
   * @returns {Promise<string>} A promise that resolves to the session nonce.
   */
  private async initiateHandshake(identityKey?: string): Promise<string> {
    const sessionNonce = await createNonce(this.#wallet, undefined, this.#originator)

    const certificatePolicy = this.#snapshotCertificatePolicy(this.certificatesToRequest)
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
      identityKey: await this.#getIdentityPublicKey(),
      initialNonce: sessionNonce,
      requestedCertificates: this.#snapshotCertificatePolicy(certificatePolicy)
    }

    // Register before sending: an in-memory or otherwise synchronous transport
    // can deliver the response before send() resolves.
    const initialResponse = this.waitForInitialResponse(sessionNonce)
    try {
      await this.#transport.send(snapshotBoundedAuthData(initialRequest))
      return await initialResponse
    } catch (error) {
      this.stopListeningForInitialResponsesByNonce(sessionNonce)
      const failedSession = await this.sessionManager.getSession(sessionNonce)
      if (failedSession != null) await this.sessionManager.removeSession(failedSession)
      throw error
    }
  }

  /**
   * Waits for the initial response from the peer after sending an initial handshake request message.
   *
   * @param {string} sessionNonce - The session nonce created in the initial request.
   * @returns {Promise<string>} A promise that resolves with the session nonce when the initial response is received.
   */
  private async waitForInitialResponse(sessionNonce: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.#stopListeningForInitialResponses(callbackID)
        reject(new Error('Timeout waiting for the BRC-103 initial response.'))
      }, INITIAL_RESPONSE_TIMEOUT_MS)
      if (typeof timeoutId === 'object' && 'unref' in timeoutId) timeoutId.unref()
      const callbackID = this.#listenForInitialResponse(sessionNonce, nonce => {
        this.#stopListeningForInitialResponses(callbackID)
        resolve(nonce)
      })
      this.#initialResponseTimeouts.set(callbackID, timeoutId)
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
  #listenForInitialResponse(
    sessionNonce: string,
    callback: (sessionNonce: string) => void
  ): number {
    const callbackID = this.#callbackIdCounter++
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
  #stopListeningForInitialResponses(callbackID: number): void {
    const timeoutId = this.#initialResponseTimeouts.get(callbackID)
    if (timeoutId !== undefined) clearTimeout(timeoutId)
    this.#initialResponseTimeouts.delete(callbackID)
    this.onInitialResponseReceivedCallbacks.delete(callbackID)
  }

  private stopListeningForInitialResponsesByNonce(sessionNonce: string): void {
    for (const [callbackID, entry] of this.onInitialResponseReceivedCallbacks) {
      if (entry.sessionNonce === sessionNonce) {
        this.#stopListeningForInitialResponses(callbackID)
      }
    }
  }

  private propagateTransportError(peerIdentityKey: string | undefined, error: unknown): never {
    if (error instanceof Error) {
      if (peerIdentityKey != null) {
        const existingDetails = (error as any).details
        if (existingDetails != null && typeof existingDetails === 'object') {
          existingDetails.peerIdentityKey ??= peerIdentityKey
        } else {
          ;(error as any).details = { peerIdentityKey }
        }
      }
      throw error
    }

    const message = `Failed to send message to peer ${peerIdentityKey ?? 'unknown'}: ${toSafeString(error)}`
    throw new Error(message)
  }

  #requireMatchingSessionIdentity(
    peerSession: PeerSession,
    claimedIdentityKey: string,
    messageType: AuthMessage['messageType']
  ): string {
    const verifiedIdentityKey = peerSession.peerIdentityKey
    if (typeof verifiedIdentityKey !== 'string' || verifiedIdentityKey.length === 0) {
      throw new Error(`Peer identity is not established for ${messageType} message.`)
    }
    if (claimedIdentityKey !== verifiedIdentityKey) {
      throw new Error(`${messageType} identity does not match the authenticated session.`)
    }
    return verifiedIdentityKey
  }

  /**
   * Handles incoming messages from the transport.
   *
   * @param {AuthMessage} message - The incoming message to process.
   * @returns {Promise<void>}
   */
  async #handleIncomingMessage(message: AuthMessage): Promise<void> {
    message = snapshotAuthMessage(message, { maxGeneralPayloadBytes: this.#maxGeneralPayloadBytes })
    this.#restoreOwnedCertificates(message)

    switch (message.messageType) {
      case 'initialRequest':
        await this.processInitialRequest(message)
        break
      case 'initialResponse':
        await this.#processInitialResponse(message)
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
  private async processInitialRequest(message: AuthMessage): Promise<void> {
    if (
      typeof message.identityKey !== 'string' ||
      typeof message.initialNonce !== 'string' ||
      message.initialNonce === ''
    ) {
      throw new Error('Missing required fields in initialRequest message.')
    }
    await this.claimInitialRequestNonce(message.identityKey, message.initialNonce)

    const sessionNonce = await createNonce(this.#wallet, undefined, this.#originator)
    const certificatePolicy = this.#snapshotCertificatePolicy(this.certificatesToRequest)
    const now = Date.now()

    const certificatesRequired =
      Array.isArray(certificatePolicy.certifiers) && certificatePolicy.certifiers.length > 0

    await this.sessionManager.addSession({
      // The initial request has no requester signature. The requester becomes
      // authenticated only after a signed follow-up proves this claimed key.
      isAuthenticated: false,
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
          this.#wallet,
          message.requestedCertificates,
          message.identityKey,
          this.#originator
        )
      }
    }

    const { signature: signatureResult } = await this.#wallet.createSignature(
      {
        data: [...Peer.#base64ToBytes(message.initialNonce), ...Peer.#base64ToBytes(sessionNonce)],
        protocolID: [2, 'auth message signature'],
        keyID: `${message.initialNonce} ${sessionNonce}`,
        counterparty: message.identityKey
      },
      this.#originator
    )
    const signature = copyAuthByteArray(signatureResult, 'initialResponse.signature', 1024)

    const initialResponseMessage: AuthMessage = {
      version: AUTH_VERSION,
      messageType: 'initialResponse',
      identityKey: await this.#getIdentityPublicKey(),
      initialNonce: sessionNonce,
      yourNonce: message.initialNonce,
      certificates: certificatesToInclude,
      requestedCertificates: this.#snapshotCertificatePolicy(certificatePolicy),
      signature
    }

    await this.#transport.send(snapshotBoundedAuthData(initialResponseMessage))
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
      this.#wallet,
      undefined,
      this.#originator
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
    if (
      typeof peerSession.peerIdentityKey === 'string' &&
      peerSession.peerIdentityKey !== message.identityKey
    ) {
      throw new Error('initialResponse identity does not match the requested peer identity.')
    }

    const dataToVerify = [
      ...Peer.#base64ToBytes(peerSession.sessionNonce ?? ''),
      ...Peer.#base64ToBytes(message.initialNonce ?? '')
    ]

    const { valid } = await this.#wallet.verifySignature(
      {
        data: dataToVerify,
        signature: message.signature as number[],
        protocolID: [2, 'auth message signature'],
        keyID: `${peerSession.sessionNonce ?? ''} ${message.initialNonce ?? ''}`,
        counterparty: message.identityKey
      },
      this.#originator
    )

    if (valid !== true) {
      throw new Error(
        `Unable to verify initial response signature for peer: ${message.identityKey}`
      )
    }

    if (typeof message.initialNonce !== 'string' || message.initialNonce.length === 0) {
      throw new Error('Initial response message nonce is required.')
    }
    await this.#claimIncomingMessageNonce(
      peerSession.sessionNonce as string,
      message.initialNonce,
      message.messageType
    )

    // --- Transport authentication complete ---
    peerSession.peerNonce = message.initialNonce
    peerSession.peerIdentityKey = message.identityKey
    peerSession.isAuthenticated = true

    peerSession.certificatePolicy ??= this.#snapshotCertificatePolicy(this.certificatesToRequest)
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
        this.#wallet,
        message,
        session.certificatePolicy ?? this.certificatesToRequest,
        this.#originator
      )
      session.certificatesValidated = true
      session.lastUpdate = Date.now()
    })
    this.#resolveCertificateValidation(sessionNonce)

    for (const callback of this.onCertificatesReceivedCallbacks.values()) {
      await callback(
        message.identityKey,
        message.certificates as VerifiableCertificate[],
        sessionNonce,
        peerSession.peerNonce
      )
    }
  }

  #releaseInitialResponseWaiters(peerSession: PeerSession): void {
    this.onInitialResponseReceivedCallbacks.forEach(entry => {
      if (entry.sessionNonce === peerSession.sessionNonce) {
        entry.callback(peerSession.sessionNonce)
      }
    })
  }

  async #answerInitialCertificateRequest(message: AuthMessage): Promise<void> {
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
      this.#wallet,
      message.requestedCertificates,
      message.identityKey,
      this.#originator
    )
    // An empty response has no value and can race with a subsequent request
    // that shares the same initial nonce.
    if (verifiableCertificates.length > 0) {
      await this.sendCertificateResponse(message.identityKey, verifiableCertificates)
    }
  }

  async #processInitialResponse(message: AuthMessage): Promise<void> {
    const peerSession = await this.authenticateInitialResponse(message)
    await this.validateInitialResponseCertificates(message, peerSession)
    this.lastInteractedWithPeer = message.identityKey
    this.#releaseInitialResponseWaiters(peerSession)
    await this.#answerInitialCertificateRequest(message)
  }

  /**
   * Processes an incoming certificate request message from a peer.
   * Verifies nonce/signature and then possibly sends a certificateResponse.
   *
   * @param {AuthMessage} message - The certificate request message received from the peer.
   * @throws {Error} if nonce or signature is invalid.
   */
  private async processCertificateRequest(message: AuthMessage): Promise<void> {
    const validNonce = await verifyNonce(
      message.yourNonce as string,
      this.#wallet,
      undefined,
      this.#originator
    )
    if (!validNonce) {
      throw new Error(
        `Unable to verify nonce for certificate request message from: ${message.identityKey}`
      )
    }
    const peerSession = await this.sessionManager.getSession(message.yourNonce as string)
    if (peerSession == null) {
      throw new Error(`Session not found for nonce: ${message.yourNonce as string}`)
    }
    const verifiedIdentityKey = this.#requireMatchingSessionIdentity(
      peerSession,
      message.identityKey,
      message.messageType
    )

    const { valid } = await this.#wallet.verifySignature(
      {
        data: Peer.#utf8ToBytes(JSON.stringify(message.requestedCertificates)),
        signature: message.signature as number[],
        protocolID: [2, 'auth message signature'],
        keyID: `${message.nonce ?? ''} ${peerSession.sessionNonce ?? ''}`,
        counterparty: verifiedIdentityKey
      },
      this.#originator
    )
    if (valid !== true) {
      throw new Error(
        `Invalid signature in certificate request message from ${verifiedIdentityKey}`
      )
    }

    if (typeof message.nonce !== 'string' || message.nonce.length === 0) {
      throw new Error('Certificate request message nonce is required.')
    }
    await this.#claimIncomingMessageNonce(
      peerSession.sessionNonce as string,
      message.nonce,
      message.messageType
    )
    await this.#markSessionAuthenticated(peerSession.sessionNonce as string)

    // Update usage

    if (
      message.requestedCertificates != null &&
      Array.isArray(message.requestedCertificates.certifiers) &&
      message.requestedCertificates.certifiers.length > 0
    ) {
      if (this.onCertificateRequestReceivedCallbacks.size > 0) {
        // Let the application handle it
        for (const callback of this.onCertificateRequestReceivedCallbacks.values()) {
          await callback(
            verifiedIdentityKey,
            message.requestedCertificates as RequestedCertificateSet
          )
        }
      } else {
        // Attempt auto
        const verifiableCertificates = await getVerifiableCertificates(
          this.#wallet,
          message.requestedCertificates,
          verifiedIdentityKey,
          this.#originator
        )
        await this.sendCertificateResponse(verifiedIdentityKey, verifiableCertificates)
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
  async sendCertificateResponse(
    verifierIdentityKey: string,
    certificates: VerifiableCertificate[]
  ): Promise<void> {
    assertAuthIdentityKey(verifierIdentityKey)
    if (!Array.isArray(certificates) || certificates.length > 100) {
      throw new TypeError('certificates must be an array of at most 100 entries')
    }
    certificates = snapshotBoundedAuthData(certificates)
    const peerSession = await this.getAuthenticatedSession(verifierIdentityKey)
    const requestNonce = toBase64(Random(32))
    const { signature: signatureResult } = await this.#wallet.createSignature(
      {
        data: Peer.#utf8ToBytes(JSON.stringify(certificates)),
        protocolID: [2, 'auth message signature'],
        keyID: `${requestNonce} ${peerSession.peerNonce ?? ''}`,
        counterparty: peerSession.peerIdentityKey
      },
      this.#originator
    )
    const signature = copyAuthByteArray(signatureResult, 'certificateResponse.signature', 1024)

    const certificateResponse: AuthMessage = {
      version: AUTH_VERSION,
      messageType: 'certificateResponse',
      identityKey: await this.#getIdentityPublicKey(),
      nonce: requestNonce,
      initialNonce: peerSession.sessionNonce,
      yourNonce: peerSession.peerNonce,
      certificates,
      signature
    }

    // Update usage
    await this.#touchSession(peerSession.sessionNonce as string)

    try {
      await this.#transport.send(snapshotBoundedAuthData(certificateResponse))
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
  private async processCertificateResponse(message: AuthMessage): Promise<void> {
    const validNonce = await verifyNonce(
      message.yourNonce as string,
      this.#wallet,
      undefined,
      this.#originator
    )
    if (!validNonce) {
      throw new Error(
        `Unable to verify nonce for certificate response from: ${message.identityKey}`
      )
    }

    const peerSession = await this.sessionManager.getSession(message.yourNonce as string)
    if (peerSession == null) {
      throw new Error(`Session not found for nonce: ${message.yourNonce as string}`)
    }
    const verifiedIdentityKey = this.#requireMatchingSessionIdentity(
      peerSession,
      message.identityKey,
      message.messageType
    )

    // Validate message signature
    const { valid } = await this.#wallet.verifySignature(
      {
        data: Peer.#utf8ToBytes(JSON.stringify(message.certificates)),
        signature: message.signature as number[],
        protocolID: [2, 'auth message signature'],
        keyID: `${message.nonce ?? ''} ${peerSession.sessionNonce ?? ''}`,
        counterparty: verifiedIdentityKey
      },
      this.#originator
    )
    if (valid !== true) {
      throw new Error(
        `Unable to verify certificate response signature for peer: ${message.identityKey}`
      )
    }

    if (typeof message.nonce !== 'string' || message.nonce.length === 0) {
      throw new Error('Certificate response message nonce is required.')
    }
    await this.#claimIncomingMessageNonce(
      peerSession.sessionNonce as string,
      message.nonce,
      message.messageType
    )
    await this.#markSessionAuthenticated(peerSession.sessionNonce as string)

    if (Array.isArray(message.certificates) && message.certificates.length > 0) {
      const sessionNonce = peerSession.sessionNonce as string
      const validated = await this.updateCertificateSession(sessionNonce, async session => {
        const certificates = message.certificates as VerifiableCertificate[]
        const handshakePolicy = session.certificatePolicy ?? this.certificatesToRequest
        // v0.1 responses do not echo the request nonce. Match one complete locally
        // recorded policy; never combine certifier/type permissions from separate requests.
        const requested = Object.entries(session.pendingCertificateRequests ?? {}).find(
          ([, policy]) => this.#matchesCertificatePolicy(certificates, policy)
        )
        const matchesHandshake = this.#matchesCertificatePolicy(certificates, handshakePolicy)
        const policy = requested?.[1] ?? (matchesHandshake ? handshakePolicy : undefined)
        if (policy == null) {
          throw new Error('Certificates do not match a locally requested set for this session.')
        }
        await validateCertificates(this.#wallet, message, policy, this.#originator)
        if (requested != null) delete session.pendingCertificateRequests?.[requested[0]]
        // A separate dynamic request cannot satisfy a different handshake requirement.
        if (matchesHandshake) session.certificatesValidated = true
        session.lastUpdate = Date.now()
        return session.certificatesValidated === true
      })
      if (validated) this.#resolveCertificateValidation(sessionNonce)
    }

    // Notify any listeners
    for (const callback of this.onCertificatesReceivedCallbacks.values()) {
      await callback(
        verifiedIdentityKey,
        message.certificates ?? [],
        peerSession.sessionNonce as string,
        peerSession.peerNonce
      )
    }
  }

  /**
   * Processes a general message from a peer.
   *
   * @private
   * @param {AuthMessage} message - The incoming general message.
   * @throws Will throw an error if nonce or signature verification fails.
   */
  private async processGeneralMessage(message: AuthMessage): Promise<void> {
    const validNonce = await verifyNonce(
      message.yourNonce as string,
      this.#wallet,
      undefined,
      this.#originator
    )

    if (!validNonce) {
      throw new Error(`Unable to verify nonce for general message from: ${message.identityKey}`)
    }

    const peerSession = await this.sessionManager.getSession(message.yourNonce as string)
    if (peerSession == null) {
      throw new Error(`Session not found for nonce: ${message.yourNonce as string}`)
    }
    const verifiedIdentityKey = this.#requireMatchingSessionIdentity(
      peerSession,
      message.identityKey,
      message.messageType
    )

    const { valid } = await this.#wallet.verifySignature(
      {
        data: message.payload,
        signature: message.signature as number[],
        protocolID: [2, 'auth message signature'],
        keyID: `${message.nonce ?? ''} ${peerSession.sessionNonce ?? ''}`,
        counterparty: verifiedIdentityKey
      },
      this.#originator
    )

    if (valid !== true) {
      throw new Error(`Invalid signature in generalMessage from ${verifiedIdentityKey}`)
    }

    if (typeof message.nonce !== 'string' || message.nonce.length === 0) {
      throw new Error('General message nonce is required.')
    }
    const sessionNonce = peerSession.sessionNonce
    if (sessionNonce == null) {
      throw new Error('Session nonce is required for general messages')
    }
    await this.#claimIncomingMessageNonce(sessionNonce, message.nonce, message.messageType)
    await this.#markSessionAuthenticated(sessionNonce)

    const currentSession = await this.sessionManager.getSession(sessionNonce)
    if (currentSession == null) throw new Error(`Session not found for nonce: ${sessionNonce}`)
    const certificatesRequired = currentSession.certificatesRequired === true
    const certificatesValidated = currentSession.certificatesValidated === true

    // Authenticate the signature first, then wait for any separate certificate
    // authorization requirement. An unsigned caller cannot occupy this wait.
    if (certificatesRequired && !certificatesValidated) {
      await this.#waitForCertificateValidation(sessionNonce, currentSession.peerIdentityKey)
    }

    // Dispatch callbacks
    for (const callback of this.onGeneralMessageReceivedCallbacks.values()) {
      await callback(verifiedIdentityKey, message.payload ?? [])
    }
  }

  /**
   * Resolves any pending certificate validation promises for the given session nonce.
   * This should be called when certificates have been successfully validated.
   *
   * @private
   * @param {string} sessionNonce - The session nonce to resolve promises for.
   */
  #resolveCertificateValidation(sessionNonce: string): void {
    const promise = this.certificateValidationPromises.get(sessionNonce)
    if (promise != null) {
      promise.resolve()
      this.certificateValidationPromises.delete(sessionNonce)
    }
  }

  async #getIdentityPublicKey(): Promise<string> {
    if (this.#identityPublicKey != null) {
      return this.#identityPublicKey
    }

    const { publicKey } = await this.#wallet.getPublicKey({ identityKey: true }, this.#originator)
    assertAuthIdentityKey(publicKey)
    this.#identityPublicKey = publicKey
    return publicKey
  }

  static #utf8ToBytes(data: string): number[] {
    if (BufferCtor != null) {
      return Array.from(BufferCtor.from(data, 'utf8'))
    }

    if (typeof TextEncoder !== 'undefined') {
      return Array.from(utf8Bytes(data))
    }

    return toArray(data, 'utf8')
  }

  static #base64ToBytes(data: string): number[] {
    if (BufferCtor != null) {
      return Array.from(BufferCtor.from(data, 'base64'))
    }

    return toArray(data, 'base64')
  }
}
