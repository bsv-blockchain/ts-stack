import { jest } from '@jest/globals'
import type { AuthMessage, PeerSession, RequestedCertificateSet, Transport } from '../types.js'
import type { WalletInterface } from '../../wallet/Wallet.interfaces.js'
import type { VerifiableCertificate } from '../certificates/VerifiableCertificate.js'
import { SessionManager, type AsyncSessionManager } from '../SessionManager.js'

import { Peer } from '../Peer.js'
import { validateCertificates, verifyNonce as verifyNonceFunction } from '../utils/index.js'

jest.mock('../utils/index.js', () => ({
  createNonce: async () => 'generated-session',
  verifyNonce: jest.fn(async () => true),
  getVerifiableCertificates: async () => [],
  validateCertificates: jest.fn(async () => {})
}))
const validate = jest.mocked(validateCertificates)
const verifyNonce = jest.mocked(verifyNonceFunction)

const policy = (certifier: string, type: string): RequestedCertificateSet => ({
  certifiers: [certifier],
  types: { [type]: ['name'] }
})
const cert = (certifier: string, type: string): VerifiableCertificate =>
  ({ certifier, type, subject: 'remote' }) as VerifiableCertificate

function response(certificates: VerifiableCertificate[], session = 'session'): AuthMessage {
  return {
    version: '0.1',
    messageType: 'certificateResponse',
    identityKey: 'remote',
    nonce: 'response-nonce',
    initialNonce: 'remote-session',
    yourNonce: session,
    certificates,
    signature: [1]
  }
}

async function setup(requested = policy('initial', 'initial'), copyStore = false) {
  const backing = new SessionManager()
  const store: AsyncSessionManager = {
    async addSession(session) {
      backing.addSession(structuredClone(session))
    },
    async updateSession(session) {
      backing.updateSession(structuredClone(session))
    },
    async getSession(id) {
      return structuredClone(backing.getSession(id))
    },
    async removeSession(session) {
      backing.removeSession(session)
    },
    async hasSession(id) {
      return backing.hasSession(id)
    }
  }
  const transport: Transport = { send: jest.fn(async () => {}), async onData() {} }
  const wallet = {
    getPublicKey: jest.fn(async () => ({ publicKey: 'local' })),
    createSignature: jest.fn(async () => ({ signature: [1] })),
    verifySignature: jest.fn(async () => ({ valid: true }))
  } as unknown as WalletInterface
  const peer = new Peer(
    wallet,
    transport,
    requested,
    copyStore ? store : backing,
    true,
    'app.example'
  )
  await peer.ready
  const session: PeerSession = {
    isAuthenticated: true,
    sessionNonce: 'session',
    peerNonce: 'remote-session',
    peerIdentityKey: 'remote',
    lastUpdate: 1,
    certificatePolicy: structuredClone(requested),
    certificatesRequired: true,
    certificatesValidated: false
  }
  backing.addSession(session)
  return { peer, backing, transport, wallet }
}

beforeEach(() => {
  validate.mockReset()
  verifyNonce.mockReset()
  verifyNonce.mockResolvedValue(true)
})

test('uses the locally stored handshake policy without requiring a new response field', async () => {
  const { peer, backing } = await setup()
  const message = response([cert('initial', 'initial')])
  await (peer as any).processCertificateResponse(message)
  expect(validate).toHaveBeenCalledWith(
    expect.anything(),
    message,
    policy('initial', 'initial'),
    'app.example'
  )
  expect(backing.getSession('session')?.certificatesValidated).toBe(true)
  expect(message).not.toHaveProperty('requestedCertificates')
})

test('ignores inbound policy claims and keeps unmatched certificates unvalidated', async () => {
  const { peer, backing } = await setup()
  const message = {
    ...response([cert('different', 'different')]),
    requestedCertificates: policy('different', 'different')
  }
  await expect((peer as any).processCertificateResponse(message)).rejects.toThrow(
    'locally requested set'
  )
  expect(validate).not.toHaveBeenCalled()
  expect(backing.getSession('session')?.certificatesValidated).toBe(false)
})

test('records dynamic policy snapshots and accepts out-of-order responses on an async copy store', async () => {
  const { peer, backing, transport } = await setup(undefined, true)
  const first = policy('first', 'first')
  await Promise.all([
    peer.requestCertificates(first, 'remote'),
    peer.requestCertificates(policy('second', 'second'), 'remote')
  ])
  first.certifiers[0] = 'changed-by-caller'
  first.types.first.push('changed-by-caller')
  expect(Object.keys(backing.getSession('session')!.pendingCertificateRequests!)).toHaveLength(2)
  await (peer as any).processCertificateResponse(response([cert('second', 'second')]))
  await (peer as any).processCertificateResponse(response([cert('first', 'first')]))
  expect(validate.mock.calls.map(call => call[2])).toEqual([
    policy('second', 'second'),
    policy('first', 'first')
  ])
  expect(backing.getSession('session')?.pendingCertificateRequests).toEqual({})
  expect(backing.getSession('session')?.certificatesValidated).toBe(false)
  for (const [message] of (transport.send as jest.MockedFunction<Transport['send']>).mock.calls) {
    expect(Object.keys(message).sort()).toEqual([
      'identityKey',
      'initialNonce',
      'messageType',
      'nonce',
      'requestedCertificates',
      'signature',
      'version',
      'yourNonce'
    ])
  }
})

test('does not combine permissions from separate requests or another session', async () => {
  const { peer, backing } = await setup()
  await peer.requestCertificates(policy('first', 'first'), 'remote')
  await peer.requestCertificates(policy('second', 'second'), 'remote')
  await expect(
    (peer as any).processCertificateResponse(response([cert('first', 'second')]))
  ).rejects.toThrow('locally requested set')
  backing.addSession({
    isAuthenticated: true,
    sessionNonce: 'other',
    peerIdentityKey: 'remote',
    lastUpdate: 2,
    certificatePolicy: policy('initial', 'initial')
  })
  await expect(
    (peer as any).processCertificateResponse(response([cert('first', 'first')], 'other'))
  ).rejects.toThrow('locally requested set')
  expect(validate).not.toHaveBeenCalled()
})

test('preserves a pending request after failed validation and removes it after a valid retry', async () => {
  const { peer, backing } = await setup()
  await peer.requestCertificates(policy('dynamic', 'dynamic'), 'remote')
  validate.mockRejectedValueOnce(new Error('certificate validation failed'))
  await expect(
    (peer as any).processCertificateResponse(response([cert('dynamic', 'dynamic')]))
  ).rejects.toThrow('certificate validation failed')
  expect(Object.keys(backing.getSession('session')!.pendingCertificateRequests!)).toHaveLength(1)
  await (peer as any).processCertificateResponse(response([cert('dynamic', 'dynamic')]))
  expect(backing.getSession('session')?.pendingCertificateRequests).toEqual({})
})

test('records requests before synchronous transport delivery and cleans failed sends', async () => {
  const { peer, backing, transport } = await setup()
  ;(transport.send as jest.MockedFunction<Transport['send']>).mockImplementationOnce(async () => {
    await (peer as any).processCertificateResponse(response([cert('dynamic', 'dynamic')]))
  })
  await peer.requestCertificates(policy('dynamic', 'dynamic'), 'remote')
  expect(backing.getSession('session')?.pendingCertificateRequests).toEqual({})
  ;(transport.send as jest.MockedFunction<Transport['send']>).mockRejectedValueOnce(
    new Error('offline')
  )
  await expect(peer.requestCertificates(policy('dynamic', 'dynamic'), 'remote')).rejects.toThrow(
    'offline'
  )
  expect(backing.getSession('session')?.pendingCertificateRequests).toEqual({})
})

test('observers run after validation and cannot roll it back when they reject', async () => {
  const { peer, backing } = await setup()
  const later = jest.fn()
  peer.listenForCertificatesReceived(async () => {
    expect(backing.getSession('session')?.certificatesValidated).toBe(true)
    throw new Error('observer failed')
  })
  peer.listenForCertificatesReceived(later)
  await expect(
    (peer as any).processCertificateResponse(response([cert('initial', 'initial')]))
  ).rejects.toThrow('observer failed')
  expect(backing.getSession('session')?.certificatesValidated).toBe(true)
  expect(later).not.toHaveBeenCalled()
})

test('rejects a mismatched session identity before certificate processing', async () => {
  const { peer } = await setup()
  await expect(
    (peer as any).processCertificateResponse({
      ...response([cert('initial', 'initial')]),
      identityKey: 'another-peer'
    })
  ).rejects.toThrow('identity does not match')
  expect(validate).not.toHaveBeenCalled()
})

test('does not dispatch a general message under transport-supplied identity metadata', async () => {
  const { peer, backing } = await setup()
  const session = backing.getSession('session')!
  session.certificatesRequired = false
  session.certificatesValidated = true
  backing.updateSession(session)
  const delivered = jest.fn()
  peer.listenForGeneralMessages(delivered)

  await expect(
    (peer as any).processGeneralMessage({
      ...response([]),
      messageType: 'general',
      identityKey: 'unrelated-peer',
      payload: [1]
    })
  ).rejects.toThrow('identity does not match')

  expect(delivered).not.toHaveBeenCalled()
  expect((peer as any).lastInteractedWithPeer).not.toBe('unrelated-peer')
})

test('does not dispatch a certificate request under transport-supplied identity metadata', async () => {
  const { peer, transport } = await setup()
  const delivered = jest.fn()
  peer.listenForCertificatesRequested(delivered)

  await expect(
    (peer as any).processCertificateRequest({
      ...response([]),
      messageType: 'certificateRequest',
      identityKey: 'unrelated-peer',
      requestedCertificates: policy('certifier', 'type')
    })
  ).rejects.toThrow('identity does not match')

  expect(delivered).not.toHaveBeenCalled()
  expect(transport.send).not.toHaveBeenCalled()
})

test('uses configured policy for older sessions, and leaves empty responses unvalidated', async () => {
  const { peer, backing } = await setup()
  delete backing.getSession('session')!.certificatePolicy
  await (peer as any).processCertificateResponse(response([]))
  expect(backing.getSession('session')?.certificatesValidated).toBe(false)
  await (peer as any).processCertificateResponse(response([cert('initial', 'initial')]))
  expect(backing.getSession('session')?.certificatesValidated).toBe(true)
})

test('initial-response observers also observe committed validation', async () => {
  const { peer, backing } = await setup()
  peer.listenForCertificatesReceived(() => {
    expect(backing.getSession('session')?.certificatesValidated).toBe(true)
    throw new Error('initial observer failed')
  })
  await expect(
    (peer as any).validateInitialResponseCertificates(
      response([cert('initial', 'initial')]),
      backing.getSession('session')
    )
  ).rejects.toThrow('initial observer failed')
  expect(backing.getSession('session')?.certificatesValidated).toBe(true)
})

test('missing-session updates reject and release their serialization queue', async () => {
  const { peer } = await setup()
  await expect((peer as any).updateCertificateSession('missing', async () => {})).rejects.toThrow(
    'Session not found'
  )
  expect((peer as any).certificateSessionUpdates.size).toBe(0)
})

test('an awaiting general message cannot restore stale validation state in a copy store', async () => {
  const { peer, backing } = await setup(undefined, true)
  const delivered = jest.fn()
  peer.listenForGeneralMessages(delivered)
  const general = (peer as any).processGeneralMessage({
    ...response([]),
    messageType: 'general',
    payload: [1]
  }) as Promise<void>
  for (
    let attempt = 0;
    attempt < 20 && !(peer as any).certificateValidationPromises.has('session');
    attempt++
  ) {
    await Promise.resolve()
  }
  expect((peer as any).certificateValidationPromises.has('session')).toBe(true)
  peer.listenForCertificatesReceived(async () => {
    await general
    expect(delivered).toHaveBeenCalledWith('remote', [1])
    throw new Error('observer cannot veto delivery')
  })
  await expect(
    (peer as any).processCertificateResponse(response([cert('initial', 'initial')]))
  ).rejects.toThrow('observer cannot veto delivery')
  expect(backing.getSession('session')?.certificatesValidated).toBe(true)
})

test('initial-response validation preserves concurrent dynamic requests in an async copy store', async () => {
  const { peer, backing, transport } = await setup(undefined, true)
  let release!: () => void
  let started!: () => void
  const blocked = new Promise<void>(resolve => {
    release = resolve
  })
  const validating = new Promise<void>(resolve => {
    started = resolve
  })
  validate.mockImplementationOnce(async () => {
    started()
    await blocked
  })
  const initial = (peer as any).validateInitialResponseCertificates(
    response([cert('initial', 'initial')]),
    structuredClone(backing.getSession('session'))
  ) as Promise<void>
  await validating
  const request = peer.requestCertificates(policy('dynamic', 'dynamic'), 'remote')
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  expect(transport.send).not.toHaveBeenCalled()
  release()
  await Promise.all([initial, request])
  const session = backing.getSession('session')!
  expect(session.certificatesValidated).toBe(true)
  expect(Object.values(session.pendingCertificateRequests!)).toEqual([policy('dynamic', 'dynamic')])
})
