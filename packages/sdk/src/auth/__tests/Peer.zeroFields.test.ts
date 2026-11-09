import { Peer } from '../Peer.js'
import { AuthMessage, PeerSession, Transport } from '../types.js'
import { AsyncSessionManager, SessionManager } from '../SessionManager.js'
import { MasterCertificate } from '../certificates/MasterCertificate.js'
import { VerifiableCertificate } from '../certificates/VerifiableCertificate.js'
import { CompletedProtoWallet } from '../certificates/__tests/CompletedProtoWallet.js'
import { PrivateKey, Utils } from '../../primitives/index.js'
import { createNonce } from '../utils/createNonce.js'
import { WalletInterface } from '../../wallet/Wallet.interfaces.js'

// Delivers JSON wire messages through the real Peer listener, with no mocked
// signatures, nonces, certificate validation, or getVerifiableCertificates.
class QueuedTransport implements Transport {
  rewrite?: (message: AuthMessage) => void
  private receive?: (message: AuthMessage) => Promise<void>
  private readonly messages: AuthMessage[] = []
  private waiter?: (message: AuthMessage) => void

  async send(message: AuthMessage): Promise<void> {
    this.rewrite?.(message)
    const wire: AuthMessage = JSON.parse(JSON.stringify(message))
    if (this.waiter !== undefined) {
      const resolve = this.waiter
      this.waiter = undefined
      resolve(wire)
    } else {
      this.messages.push(wire)
    }
  }

  async onData(callback: (message: AuthMessage) => Promise<void>): Promise<void> {
    this.receive = callback
  }

  async next(): Promise<AuthMessage> {
    const message = this.messages.shift()
    if (message !== undefined) return message
    return await new Promise(resolve => {
      this.waiter = resolve
    })
  }

  async deliver(message: AuthMessage): Promise<void> {
    if (this.receive === undefined) throw new Error('Transport is not listening')
    await this.receive(message)
  }
}

// Exercise an external-store-shaped round trip, rather than relying on shared
// object identity in the default SessionManager.
class SerializedSessionStore implements AsyncSessionManager {
  private readonly sessions = new SessionManager()

  constructor(private readonly dropSnapshot = false) {}

  private copy(session: PeerSession): PeerSession {
    const stored: PeerSession = JSON.parse(JSON.stringify(session))
    if (this.dropSnapshot) delete stored.certificatePolicy
    return stored
  }

  async addSession(session: PeerSession): Promise<void> {
    this.sessions.addSession(this.copy(session))
  }

  async updateSession(session: PeerSession): Promise<void> {
    this.sessions.updateSession(this.copy(session))
  }

  async getSession(identifier: string): Promise<PeerSession | undefined> {
    const session = this.sessions.getSession(identifier)
    return session === undefined ? undefined : JSON.parse(JSON.stringify(session))
  }

  async removeSession(session: PeerSession): Promise<void> {
    this.sessions.removeSession(session)
  }

  async hasSession(identifier: string): Promise<boolean> {
    return this.sessions.hasSession(identifier)
  }

  async claimMessageNonce(sessionNonce: string, messageNonce: string): Promise<boolean> {
    return this.sessions.claimMessageNonce(sessionNonce, messageNonce)
  }

  async claimInitialRequestNonce(identityKey: string, initialNonce: string): Promise<boolean> {
    return this.sessions.claimInitialRequestNonce(identityKey, initialNonce)
  }
}

async function peers(
  fields: string[] = [],
  store: 'sync' | 'async' | 'legacy' = 'sync',
  requireCertificates = true
) {
  const issuer = new CompletedProtoWallet(new PrivateKey(81))
  const holder = new CompletedProtoWallet(new PrivateKey(82))
  const verifier = new CompletedProtoWallet(new PrivateKey(83))
  const holderIdentity = (await holder.getPublicKey({ identityKey: true })).publicKey
  const verifierIdentity = (await verifier.getPublicKey({ identityKey: true })).publicKey
  const master = await MasterCertificate.issueCertificateForSubject(
    issuer,
    holderIdentity,
    { name: 'Synthetic peer' },
    Utils.toBase64(Array.from({ length: 32 }, () => 8)),
    async () => `${'34'.repeat(32)}.0`
  )
  if (master.signature === undefined) throw new Error('Expected an issuer-signed fixture')
  const signedMaster = Object.assign(master, { signature: master.signature })
  const requested = { certifiers: [master.certifier], types: { [master.type]: fields } }
  // Storage and permission are fixture doubles. The exact prove call remains
  // observable; production wallet-toolbox/DCAP integration is a separate test.
  const proveCertificate = jest.fn<
    ReturnType<WalletInterface['proveCertificate']>,
    Parameters<WalletInterface['proveCertificate']>
  >(async args => ({
    keyringForVerifier: await MasterCertificate.createKeyringForVerifier(
      holder,
      master.certifier,
      args.verifier,
      master.fields,
      args.fieldsToReveal,
      master.masterKeyring,
      master.serialNumber
    )
  }))
  const holderWallet: WalletInterface = Object.assign(holder, {
    listCertificates: jest.fn(async () => ({ totalCertificates: 1, certificates: [master] })),
    proveCertificate
  })
  const verifierTransport = new QueuedTransport()
  const holderTransport = new QueuedTransport()
  const verifierPeer = new Peer(
    verifier,
    verifierTransport,
    requireCertificates ? requested : undefined,
    store === 'sync' ? undefined : new SerializedSessionStore(store === 'legacy')
  )
  const holderPeer = new Peer(holderWallet, holderTransport)
  await Promise.all([verifierPeer.ready, holderPeer.ready])
  const certificatesReceived = jest.fn()
  verifierPeer.listenForCertificatesReceived(certificatesReceived)
  const decrypt = jest.spyOn(verifier, 'decrypt')
  return {
    verifierPeer,
    holderPeer,
    verifierTransport,
    holderTransport,
    holderIdentity,
    verifierIdentity,
    master: signedMaster,
    requested,
    proveCertificate,
    certificatesReceived,
    decrypt,
    issuer,
    holder
  }
}

describe('Peer zero-field certificate exchange', () => {
  afterEach(() => jest.restoreAllMocks())

  it('authenticates a signed metadata-only core in a real initial response and sends a general message', async () => {
    const f = await peers()
    const handshake = f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    const response = await f.holderTransport.next()
    expect(response.messageType).toBe('initialResponse')
    expect(response.certificates?.[0].keyring).toEqual({})
    await f.verifierTransport.deliver(response)
    await expect(handshake).resolves.toMatchObject({
      isAuthenticated: true,
      certificatesValidated: true,
      peerIdentityKey: f.holderIdentity
    })
    expect(f.proveCertificate).toHaveBeenCalledTimes(1)
    expect(f.proveCertificate).toHaveBeenCalledWith(
      {
        certificate: f.master,
        fieldsToReveal: [],
        verifier: f.verifierIdentity
      },
      undefined
    )
    expect(f.certificatesReceived).toHaveBeenCalledTimes(1)
    expect(f.decrypt).not.toHaveBeenCalled()
    const received = jest.fn()
    f.holderPeer.listenForGeneralMessages(received)
    await f.verifierPeer.toPeer([1, 2, 3], f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    expect(received).toHaveBeenCalledWith(f.verifierIdentity, [1, 2, 3])
  })

  it('uses an independent snapshot when the configured request changes in flight', async () => {
    const f = await peers()
    const handshake = f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    const request = await f.verifierTransport.next()
    // Mutate the live configuration, not the constructor input Peer copied.
    const live = f.verifierPeer.certificatesToRequest
    live.certifiers.length = 0
    live.types[f.master.type].push('name')
    await f.holderTransport.deliver(request)
    await f.verifierTransport.deliver(await f.holderTransport.next())
    await expect(handshake).resolves.toMatchObject({ certificatesValidated: true })
    expect(f.certificatesReceived).toHaveBeenCalledTimes(1)
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('does not let transport mutation alias the locally retained field request', async () => {
    const f = await peers(['name'])
    f.verifierTransport.rewrite = message => {
      if (message.messageType === 'initialRequest' && message.requestedCertificates !== undefined) {
        message.requestedCertificates.types[f.master.type].length = 0
      }
    }
    void f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    await expect(f.verifierTransport.deliver(await f.holderTransport.next())).rejects.toThrow(
      'A keyring is required'
    )
    expect(f.certificatesReceived).not.toHaveBeenCalled()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  // The 2.8.x port's toJSON-capture case is omitted: 4.0.x snapshots the
  // policy at construction (Peer.certificatePolicy.test.ts covers that).

  it('preserves the request snapshot through an asynchronous serialized session store', async () => {
    const f = await peers([], 'async')
    const handshake = f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    await f.verifierTransport.deliver(await f.holderTransport.next())
    await expect(handshake).resolves.toMatchObject({
      certificatesValidated: true,
      certificatePolicy: f.requested
    })
    expect(f.certificatesReceived).toHaveBeenCalledTimes(1)
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('refuses a same-type nonempty-to-empty downgrade despite mutated config and sender request', async () => {
    const f = await peers(['name'])
    void f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    const response = await f.holderTransport.next()
    const live = f.verifierPeer.certificatesToRequest
    live.types[f.master.type].length = 0
    response.requestedCertificates = live
    if (response.certificates === undefined) throw new Error('Expected a certificate')
    response.certificates[0].keyring = {}
    await expect(f.verifierTransport.deliver(response)).rejects.toThrow('A keyring is required')
    expect(f.certificatesReceived).not.toHaveBeenCalled()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('does not take zero-field authority from a changed live default after the snapshot is lost', async () => {
    const f = await peers(['name'])
    void f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    const response = await f.holderTransport.next()
    const session = f.verifierPeer.sessionManager.getSession(response.yourNonce ?? '')
    if (session === undefined) throw new Error('Expected a session')
    delete session.certificatePolicy
    f.verifierPeer.certificatesToRequest.types[f.master.type].length = 0
    if (response.certificates === undefined) throw new Error('Expected a certificate')
    response.certificates[0].keyring = {}
    await expect(f.verifierTransport.deliver(response)).rejects.toThrow('A keyring is required')
    expect(f.certificatesReceived).not.toHaveBeenCalled()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('fails closed if an external session store loses the local request snapshot', async () => {
    const f = await peers()
    void f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    const response = await f.holderTransport.next()
    const session = f.verifierPeer.sessionManager.getSession(response.yourNonce ?? '')
    if (session === undefined) throw new Error('Expected a session')
    delete session.certificatePolicy
    await expect(f.verifierTransport.deliver(response)).rejects.toThrow('A keyring is required')
    expect(f.certificatesReceived).not.toHaveBeenCalled()
  })

  it.each([
    { mode: 'no certificates', required: false, fields: [] },
    { mode: 'nonempty disclosure', required: true, fields: ['name'] },
    { mode: 'zero-field disclosure', required: true, fields: [] }
  ])('preserves legacy serialized-store behavior for $mode', async ({ required, fields }) => {
    const f = await peers(fields, 'legacy', required)
    const handshake = f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    const response = await f.holderTransport.next()
    if (required && fields.length === 0) {
      await expect(f.verifierTransport.deliver(response)).rejects.toThrow('A keyring is required')
      expect(f.certificatesReceived).not.toHaveBeenCalled()
      expect(f.decrypt).not.toHaveBeenCalled()
    } else {
      await f.verifierTransport.deliver(response)
      await expect(handshake).resolves.toMatchObject({
        isAuthenticated: true,
        certificatesValidated: true
      })
      expect(f.certificatesReceived).toHaveBeenCalledTimes(required ? 1 : 0)
      expect(f.decrypt).toHaveBeenCalledTimes(required ? 1 : 0)
    }
    expect(f.proveCertificate).toHaveBeenCalledTimes(required ? 1 : 0)
  })

  it.each(['nonce', 'signature'] as const)(
    'rejects an altered initial-response %s',
    async field => {
      const f = await peers()
      void f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
      await f.holderTransport.deliver(await f.verifierTransport.next())
      const response = await f.holderTransport.next()
      if (field === 'nonce') {
        // Keep the canonical 48-byte shape so the HMAC check, not schema
        // validation, is what refuses it.
        const nonce = Utils.toArray(response.yourNonce ?? '', 'base64')
        expect(nonce).toHaveLength(48)
        nonce[nonce.length - 1] ^= 1
        response.yourNonce = Utils.toBase64(nonce)
      }
      if (field === 'signature') {
        // A well-formed signature over other data reaches the signature check.
        response.signature = (
          await f.holder.createSignature({
            data: [1, 2, 3],
            protocolID: [2, 'auth message signature'],
            keyID: `${response.yourNonce ?? ''} ${response.initialNonce ?? ''}`,
            counterparty: f.verifierIdentity
          })
        ).signature
      }
      await expect(f.verifierTransport.deliver(response)).rejects.toThrow(
        field === 'nonce' ? 'Initial response nonce verification failed' : 'Signature is not valid'
      )
      expect(f.certificatesReceived).not.toHaveBeenCalled()
      expect(f.decrypt).not.toHaveBeenCalled()
    }
  )

  // A signed initialResponse built by the holder for the verifier's session.
  async function forgedInitialResponse(
    f: Awaited<ReturnType<typeof peers>>,
    yourNonce: string
  ): Promise<AuthMessage> {
    const initialNonce = await createNonce(f.holder)
    const { signature } = await f.holder.createSignature({
      data: [...Utils.toArray(yourNonce, 'base64'), ...Utils.toArray(initialNonce, 'base64')],
      protocolID: [2, 'auth message signature'],
      keyID: `${yourNonce} ${initialNonce}`,
      counterparty: f.verifierIdentity
    })
    return {
      version: '0.1',
      messageType: 'initialResponse',
      identityKey: f.holderIdentity,
      initialNonce,
      yourNonce,
      certificates: [VerifiableCertificate.fromCertificate(f.master, {})],
      signature
    }
  }

  it('refuses zero fields in an initialResponse sent to a responder session', async () => {
    const f = await peers()
    // The holder initiates, so the verifier is the responder here.
    void f.holderPeer.getAuthenticatedSession(f.verifierIdentity)
    await f.verifierTransport.deliver(await f.holderTransport.next())
    const verifierResponse = await f.verifierTransport.next()
    expect(verifierResponse.messageType).toBe('initialResponse')
    const forged = await forgedInitialResponse(f, verifierResponse.initialNonce ?? '')
    await expect(f.verifierTransport.deliver(forged)).rejects.toThrow('A keyring is required')
    expect(f.certificatesReceived).not.toHaveBeenCalled()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('refuses zero fields in a second initialResponse after the handshake', async () => {
    const f = await peers()
    const handshake = f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    const response = await f.holderTransport.next()
    await f.verifierTransport.deliver(response)
    await expect(handshake).resolves.toMatchObject({ certificatesValidated: true })
    f.certificatesReceived.mockClear()
    const forged = await forgedInitialResponse(f, response.yourNonce ?? '')
    await expect(f.verifierTransport.deliver(forged)).rejects.toThrow('A keyring is required')
    expect(f.certificatesReceived).not.toHaveBeenCalled()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it('rejects a correctly signed response relabeled to another holder identity', async () => {
    const f = await peers()
    void f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    const request = await f.verifierTransport.next()
    await f.holderTransport.deliver(request)
    const response = await f.holderTransport.next()
    const other = new CompletedProtoWallet(new PrivateKey(84))
    const identity = (await other.getPublicKey({ identityKey: true })).publicKey
    const master = await MasterCertificate.issueCertificateForSubject(
      f.issuer,
      identity,
      { name: 'Other synthetic holder' },
      f.master.type,
      async () => `${'56'.repeat(32)}.0`
    )
    response.identityKey = identity
    if (master.signature === undefined) throw new Error('Expected an issuer-signed fixture')
    response.certificates = [
      VerifiableCertificate.fromCertificate({ ...master, signature: master.signature }, {})
    ]
    const { signature } = await other.createSignature({
      data: [
        ...Utils.toArray(response.yourNonce ?? '', 'base64'),
        ...Utils.toArray(response.initialNonce ?? '', 'base64')
      ],
      protocolID: [2, 'auth message signature'],
      keyID: `${response.yourNonce ?? ''} ${response.initialNonce ?? ''}`,
      counterparty: f.verifierIdentity
    })
    response.signature = signature
    await expect(f.verifierTransport.deliver(response)).rejects.toThrow(
      'initialResponse identity does not match the requested peer identity'
    )
    expect(f.certificatesReceived).not.toHaveBeenCalled()
    expect(f.decrypt).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'refuses a standalone zero-field response, including sender authority=%s',
    async senderAuthority => {
      const f = await peers()
      const handshake = f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
      await f.holderTransport.deliver(await f.verifierTransport.next())
      await f.verifierTransport.deliver(await f.holderTransport.next())
      await handshake
      f.certificatesReceived.mockClear()
      // A new nonempty request cannot be downgraded by the holder's unsigned
      // requestedCertificates member on a separately signed certificateResponse.
      await f.verifierPeer.requestCertificates(
        {
          certifiers: [f.master.certifier],
          types: { [f.master.type]: ['name'] }
        },
        f.holderIdentity
      )
      // Deliver the signed request so the holder's session authenticates, but
      // let the application (this test) answer it instead of the auto-response.
      f.holderPeer.listenForCertificatesRequested(() => {})
      await f.holderTransport.deliver(await f.verifierTransport.next())
      await f.holderPeer.sendCertificateResponse(f.verifierIdentity, [
        VerifiableCertificate.fromCertificate(f.master, {})
      ])
      const response = await f.holderTransport.next()
      if (senderAuthority) response.requestedCertificates = f.requested
      // 4.0.x matches a standalone response against locally recorded requests
      // first, and an empty keyring matches none of them.
      await expect(f.verifierTransport.deliver(response)).rejects.toThrow(
        'Certificates do not match a locally requested set'
      )
      // Replaying the same standalone response cannot reach the new acceptance path.
      await expect(f.verifierTransport.deliver(response)).rejects.toThrow()
      expect(f.certificatesReceived).not.toHaveBeenCalled()
      expect(f.decrypt).not.toHaveBeenCalled()
    }
  )

  it('preserves the existing nonempty standalone certificate response path', async () => {
    const f = await peers()
    const handshake = f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    await f.verifierTransport.deliver(await f.holderTransport.next())
    await handshake
    f.certificatesReceived.mockClear()
    await f.verifierPeer.requestCertificates(
      {
        certifiers: [f.master.certifier],
        types: { [f.master.type]: ['name'] }
      },
      f.holderIdentity
    )
    await f.holderTransport.deliver(await f.verifierTransport.next())
    await f.verifierTransport.deliver(await f.holderTransport.next())
    expect(f.certificatesReceived).toHaveBeenCalledTimes(1)
    expect(f.decrypt).toHaveBeenCalledTimes(1)
  })

  it('refuses a standalone answer to a locally recorded zero-field request', async () => {
    const f = await peers()
    const handshake = f.verifierPeer.getAuthenticatedSession(f.holderIdentity)
    await f.holderTransport.deliver(await f.verifierTransport.next())
    await f.verifierTransport.deliver(await f.holderTransport.next())
    await handshake
    f.certificatesReceived.mockClear()
    // Zero fields stay an initial-response proof even when the local standalone
    // request itself listed no fields: the policy matcher needs a disclosed field.
    await f.verifierPeer.requestCertificates(
      { certifiers: [f.master.certifier], types: { [f.master.type]: [] } },
      f.holderIdentity
    )
    await f.holderTransport.deliver(await f.verifierTransport.next())
    const response = await f.holderTransport.next()
    expect(response.messageType).toBe('certificateResponse')
    expect(response.certificates?.[0].keyring).toEqual({})
    await expect(f.verifierTransport.deliver(response)).rejects.toThrow(
      'Certificates do not match a locally requested set'
    )
    expect(f.certificatesReceived).not.toHaveBeenCalled()
    expect(f.decrypt).not.toHaveBeenCalled()
  })
})
