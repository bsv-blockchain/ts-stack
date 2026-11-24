import { jest } from '@jest/globals'
import type { AuthMessage, PeerSession, RequestedCertificateSet, Transport } from '../types.js'
import type { WalletInterface } from '../../wallet/Wallet.interfaces.js'
import type { VerifiableCertificate } from '../certificates/VerifiableCertificate.js'
import { SessionManager, type AsyncSessionManager } from '../SessionManager.js'

import { Peer } from '../Peer.js'
import { validateCertificates } from '../utils/validateCertificates.js'
import { verifyNonce as verifyNonceFunction } from '../utils/verifyNonce.js'
import PrivateKey from '../../primitives/PrivateKey.js'
import * as Utils from '../../primitives/utils.js'

jest.mock('../utils/createNonce.js', () => ({
  createNonce: async () => 'generated-session'
}))
jest.mock('../utils/verifyNonce.js', () => ({
  verifyNonce: jest.fn(async () => true)
}))
jest.mock('../utils/getVerifiableCertificates.js', () => ({
  getVerifiableCertificates: async () => []
}))
jest.mock('../utils/validateCertificates.js', () => ({
  validateCertificates: jest.fn(async () => {})
}))
const validate = jest.mocked(validateCertificates)
const verifyNonce = jest.mocked(verifyNonceFunction)

const labels = [
  'local',
  'remote',
  'initial',
  'different',
  'dynamic',
  'first',
  'second',
  'certifier',
  'another-peer',
  'unproven-peer',
  'unrelated-peer'
]
const identity = (label: string): string =>
  new PrivateKey(labels.indexOf(label) + 40).toPublicKey().toString()
const certificateType = (label: string): string =>
  Utils.toBase64(
    Array.from(
      { length: 32 },
      (_value, index) => (label.charCodeAt(index % label.length) + index) % 256
    )
  )
const REMOTE = identity('remote')

const policy = (certifier: string, type: string): RequestedCertificateSet => ({
  certifiers: [identity(certifier)],
  types: { [certificateType(type)]: ['name'] }
})
const cert = (
  certifier: string,
  type: string,
  fields: string[] = ['name']
): VerifiableCertificate =>
  ({
    certifier: identity(certifier),
    type: certificateType(type),
    subject: REMOTE,
    keyring: Object.fromEntries(fields.map(field => [field, 'AQ==']))
  }) as VerifiableCertificate

let responseNonce = 0

function response(certificates: VerifiableCertificate[], session = 'session'): AuthMessage {
  return {
    version: '0.1',
    messageType: 'certificateResponse',
    identityKey: REMOTE,
    nonce: `response-nonce-${++responseNonce}`,
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
    },
    async claimMessageNonce(sessionNonce, messageNonce) {
      return backing.claimMessageNonce(sessionNonce, messageNonce)
    },
    async claimInitialRequestNonce(identityKey, initialNonce) {
      return backing.claimInitialRequestNonce(identityKey, initialNonce)
    }
  }
  const transport: Transport = { send: jest.fn(async () => {}), async onData() {} }
  const wallet = {
    getPublicKey: jest.fn(async () => ({ publicKey: identity('local') })),
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
    peerIdentityKey: REMOTE,
    lastUpdate: Date.now(),
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
    'app.example',
    false
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
    peer.requestCertificates(first, REMOTE),
    peer.requestCertificates(policy('second', 'second'), REMOTE)
  ])
  first.certifiers[0] = 'changed-by-caller'
  first.types[certificateType('first')].push('changed-by-caller')
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

test('matches otherwise identical pending policies by the exact revealed field set', async () => {
  const { peer, backing } = await setup()
  const certifier = identity('dynamic')
  const type = certificateType('dynamic')
  const first = { certifiers: [certifier], types: { [type]: ['name'] } }
  const second = { certifiers: [certifier], types: { [type]: ['email'] } }
  await peer.requestCertificates(first, REMOTE)
  await peer.requestCertificates(second, REMOTE)

  await (peer as any).processCertificateResponse(response([cert('dynamic', 'dynamic', ['email'])]))

  expect(validate).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.anything(),
    second,
    'app.example',
    false
  )
  expect(Object.values(backing.getSession('session')!.pendingCertificateRequests!)).toEqual([first])
})

test('does not combine permissions from separate requests or another session', async () => {
  const { peer, backing } = await setup()
  await peer.requestCertificates(policy('first', 'first'), REMOTE)
  await peer.requestCertificates(policy('second', 'second'), REMOTE)
  await expect(
    (peer as any).processCertificateResponse(response([cert('first', 'second')]))
  ).rejects.toThrow('locally requested set')
  backing.addSession({
    isAuthenticated: true,
    sessionNonce: 'other',
    peerIdentityKey: REMOTE,
    lastUpdate: Date.now() + 1,
    certificatePolicy: policy('initial', 'initial')
  })
  await expect(
    (peer as any).processCertificateResponse(response([cert('first', 'first')], 'other'))
  ).rejects.toThrow('locally requested set')
  expect(validate).not.toHaveBeenCalled()
})

test('preserves a pending request after failed validation and removes it after a valid retry', async () => {
  const { peer, backing } = await setup()
  await peer.requestCertificates(policy('dynamic', 'dynamic'), REMOTE)
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
  await peer.requestCertificates(policy('dynamic', 'dynamic'), REMOTE)
  expect(backing.getSession('session')?.pendingCertificateRequests).toEqual({})
  ;(transport.send as jest.MockedFunction<Transport['send']>).mockRejectedValueOnce(
    new Error('offline')
  )
  await expect(peer.requestCertificates(policy('dynamic', 'dynamic'), REMOTE)).rejects.toThrow(
    'offline'
  )
  expect(backing.getSession('session')?.pendingCertificateRequests).toEqual({})
})

test('observers receive the exact validated session and cannot roll validation back', async () => {
  const { peer, backing } = await setup()
  const later = jest.fn()
  peer.listenForCertificatesReceived(async (_sender, _certificates, sessionNonce, peerNonce) => {
    expect(backing.getSession('session')?.certificatesValidated).toBe(true)
    expect(sessionNonce).toBe('session')
    expect(peerNonce).toBe('remote-session')
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
      identityKey: identity('another-peer')
    })
  ).rejects.toThrow('identity does not match')
  expect(validate).not.toHaveBeenCalled()
})

test('rejects initial-response identity substitution for a targeted handshake', async () => {
  const { peer, wallet } = await setup()
  await expect(
    (peer as any).authenticateInitialResponse({
      ...response([]),
      messageType: 'initialResponse',
      identityKey: identity('another-peer')
    })
  ).rejects.toThrow('requested peer identity')
  expect(wallet.verifySignature).not.toHaveBeenCalled()
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
      identityKey: identity('unrelated-peer'),
      payload: [1]
    })
  ).rejects.toThrow('identity does not match')

  expect(delivered).not.toHaveBeenCalled()
  expect((peer as any).lastInteractedWithPeer).not.toBe(identity('unrelated-peer'))
})

test('dispatches a signed general nonce once and rejects an exact replay', async () => {
  const { peer, backing } = await setup()
  const session = backing.getSession('session')!
  session.certificatesRequired = false
  session.certificatesValidated = true
  backing.updateSession(session)
  const delivered = jest.fn()
  peer.listenForGeneralMessages(delivered)
  const message = {
    ...response([]),
    messageType: 'general' as const,
    payload: [1, 2, 3]
  }

  await (peer as any).processGeneralMessage(message)
  await expect((peer as any).processGeneralMessage(message)).rejects.toThrow('Replayed general')

  expect(delivered).toHaveBeenCalledTimes(1)
  expect(delivered).toHaveBeenCalledWith(REMOTE, [1, 2, 3])
})

test('keeps an unsigned initial-request session unauthenticated', async () => {
  const { peer, backing } = await setup()
  await (peer as any).processInitialRequest({
    version: '0.1',
    messageType: 'initialRequest',
    identityKey: identity('unproven-peer'),
    initialNonce: 'unproven-nonce'
  })

  expect(backing.getSession('generated-session')).toMatchObject({
    isAuthenticated: false,
    peerIdentityKey: identity('unproven-peer'),
    peerNonce: 'unproven-nonce'
  })
  await expect(
    (peer as any).processInitialRequest({
      version: '0.1',
      messageType: 'initialRequest',
      identityKey: identity('unproven-peer'),
      initialNonce: 'unproven-nonce'
    })
  ).rejects.toThrow('Replayed initialRequest')
})

test('does not dispatch a certificate request under transport-supplied identity metadata', async () => {
  const { peer, transport } = await setup()
  const delivered = jest.fn()
  peer.listenForCertificatesRequested(delivered)

  await expect(
    (peer as any).processCertificateRequest({
      ...response([]),
      messageType: 'certificateRequest',
      identityKey: identity('unrelated-peer'),
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

test('times out an unanswered initial handshake and releases callback and session state', async () => {
  jest.useFakeTimers()
  try {
    const { peer, backing } = await setup()
    const handshake = (peer as any).initiateHandshake(REMOTE) as Promise<string>
    const rejection = expect(handshake).rejects.toThrow('initial response')
    await Promise.resolve()
    await Promise.resolve()
    await jest.advanceTimersByTimeAsync(30_000)

    await rejection
    expect((peer as any).onInitialResponseReceivedCallbacks.size).toBe(0)
    expect(backing.getSession('generated-session')).toBeUndefined()
  } finally {
    jest.useRealTimers()
  }
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
    expect(delivered).toHaveBeenCalledWith(REMOTE, [1])
    throw new Error('observer cannot veto delivery')
  })
  await expect(
    (peer as any).processCertificateResponse(response([cert('initial', 'initial')]))
  ).rejects.toThrow('observer cannot veto delivery')
  expect(backing.getSession('session')?.certificatesValidated).toBe(true)
})

test('concurrent general messages share one certificate-validation gate', async () => {
  const { peer, backing } = await setup(undefined, true)
  const delivered = jest.fn()
  peer.listenForGeneralMessages(delivered)
  const firstMessage = {
    ...response([]),
    messageType: 'general' as const,
    payload: [1]
  }
  const secondMessage = {
    ...response([]),
    messageType: 'general' as const,
    payload: [2]
  }

  const first = (peer as any).processGeneralMessage(firstMessage) as Promise<void>
  const second = (peer as any).processGeneralMessage(secondMessage) as Promise<void>
  for (
    let attempt = 0;
    attempt < 20 && !(peer as any).certificateValidationPromises.has('session');
    attempt++
  ) {
    await Promise.resolve()
  }
  expect((peer as any).certificateValidationPromises.size).toBe(1)

  await (peer as any).processCertificateResponse(response([cert('initial', 'initial')]))
  await Promise.all([first, second])

  expect(backing.getSession('session')?.certificatesValidated).toBe(true)
  expect(delivered.mock.calls).toEqual([
    [REMOTE, [1]],
    [REMOTE, [2]]
  ])
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
  const request = peer.requestCertificates(policy('dynamic', 'dynamic'), REMOTE)
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
  expect(transport.send).not.toHaveBeenCalled()
  release()
  await Promise.all([initial, request])
  const session = backing.getSession('session')!
  expect(session.certificatesValidated).toBe(true)
  expect(Object.values(session.pendingCertificateRequests!)).toEqual([policy('dynamic', 'dynamic')])
})
