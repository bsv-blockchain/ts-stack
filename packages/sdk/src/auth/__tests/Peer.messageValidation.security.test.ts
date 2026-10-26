import { jest } from '@jest/globals'
import PrivateKey from '../../primitives/PrivateKey.js'
import * as Utils from '../../primitives/utils.js'
import { Peer } from '../Peer.js'
import {
  assertRequestedCertificateSet,
  assertValidAuthMessage,
  snapshotAuthMessage,
  MAX_AUTH_MESSAGE_BYTES
} from '../AuthMessageValidation.js'
import { SessionManager } from '../SessionManager.js'
import type { AuthMessage } from '../types.js'

const identityKey = new PrivateKey(40).toPublicKey().toString()
const sessionNonce = Utils.toBase64(Array(48).fill(1))
const messageNonce = Utils.toBase64(Array(32).fill(2))

function general(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: '0.1',
    messageType: 'general',
    identityKey,
    nonce: messageNonce,
    yourNonce: sessionNonce,
    payload: [],
    signature: [1],
    ...overrides
  }
}

describe('BRC-103 untrusted message validation', () => {
  test.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid local general payload budget %s',
    maxGeneralPayloadBytes => {
      expect(() => snapshotAuthMessage(general(), { maxGeneralPayloadBytes })).toThrow(
        'positive safe integer'
      )
      expect(
        () =>
          new Peer({} as never, {} as never, undefined, undefined, undefined, undefined, {
            maxGeneralPayloadBytes
          })
      ).toThrow('positive safe integer')
    }
  )

  test('enforces a separate payload budget and retains metadata and byte validation', () => {
    const options = { maxGeneralPayloadBytes: 2 }
    expect(snapshotAuthMessage(general({ payload: [1, 2] }), options).payload).toEqual([1, 2])
    expect(() => snapshotAuthMessage(general({ payload: [1, 2, 3] }), options)).toThrow(
      'array exceeds'
    )
    for (const payload of [[256], [-1], [1.5], Object.assign(Array(2), { 1: 1 })]) {
      expect(() =>
        snapshotAuthMessage(general({ payload }), { maxGeneralPayloadBytes: null })
      ).toThrow()
    }
    expect(() =>
      snapshotAuthMessage(general({ signature: Array(1025).fill(1) }), {
        maxGeneralPayloadBytes: null
      })
    ).toThrow('signature')
    const getter = jest.fn(() => [1])
    const message = general()
    Object.defineProperty(message, 'payload', { get: getter })
    expect(() => snapshotAuthMessage(message, { maxGeneralPayloadBytes: null })).toThrow(
      'accessors'
    )
    expect(getter).not.toHaveBeenCalled()
  })

  test('delegates only general payload bytes while preserving the legacy default', () => {
    const payload = Array.from({ length: MAX_AUTH_MESSAGE_BYTES / 4 }, () => 1)
    const message = general({ payload })
    expect(() => snapshotAuthMessage(message)).toThrow('byte limit')
    const copied = snapshotAuthMessage(message, { maxGeneralPayloadBytes: null })
    expect(copied.payload).not.toBe(payload)
    expect(copied.payload).toHaveLength(payload.length)
    payload[0] = 9
    expect(copied.payload![0]).toBe(1)
    expect(() =>
      snapshotAuthMessage(general({ payload: [], extra: payload }), {
        maxGeneralPayloadBytes: null
      })
    ).toThrow('byte limit')
    expect(() =>
      snapshotAuthMessage(
        {
          version: '0.1',
          messageType: 'initialRequest',
          identityKey,
          initialNonce: sessionNonce,
          payload
        },
        { maxGeneralPayloadBytes: null }
      )
    ).toThrow('byte limit')
  }, 30000)

  test.each(['general', 'initialRequest'])(
    'captures a changing %s message type only once',
    firstType => {
      let reads = 0
      const message = new Proxy(
        general({ initialNonce: sessionNonce, payload: Array(MAX_AUTH_MESSAGE_BYTES / 4).fill(1) }),
        {
          getOwnPropertyDescriptor(target, key) {
            const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
            if (key === 'messageType') {
              reads += 1
              return { ...descriptor, value: reads === 1 ? firstType : 'certificateResponse' }
            }
            return descriptor
          }
        }
      )
      if (firstType === 'general') {
        const snapshot = snapshotAuthMessage(message, { maxGeneralPayloadBytes: null })
        expect(snapshot.messageType).toBe('general')
        expect(snapshot.payload).toHaveLength(MAX_AUTH_MESSAGE_BYTES / 4)
        expect(snapshot).not.toBe(message)
      } else {
        expect(() => snapshotAuthMessage(message, { maxGeneralPayloadBytes: null })).toThrow(
          'byte limit'
        )
      }
      expect(reads).toBe(1)
    },
    30000
  )

  test('a finite Peer budget rejects outgoing and incoming excess before wallet work', async () => {
    let receive!: (message: AuthMessage) => Promise<void>
    const transport = {
      onData: async (callback: (message: AuthMessage) => Promise<void>) => {
        receive = callback
      },
      send: jest.fn()
    }
    const wallet = {
      createSignature: jest.fn(),
      verifyHmac: jest.fn(),
      verifySignature: jest.fn()
    }
    const peer = new Peer(wallet as never, transport, undefined, undefined, undefined, undefined, {
      maxGeneralPayloadBytes: 1
    })
    await peer.ready
    await expect(peer.toPeer([1, 2], identityKey)).rejects.toThrow('at most 1 bytes')
    await expect(receive(general({ payload: [1, 2] }) as unknown as AuthMessage)).rejects.toThrow(
      'array exceeds'
    )
    expect(wallet.createSignature).not.toHaveBeenCalled()
    expect(wallet.verifyHmac).not.toHaveBeenCalled()
    expect(wallet.verifySignature).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()
  })

  test('a delegated Peer sends and receives above the legacy envelope budget', async () => {
    let receive!: (message: AuthMessage) => Promise<void>
    const transport = {
      onData: async (callback: (message: AuthMessage) => Promise<void>) => {
        receive = callback
      },
      send: jest.fn(async (message: AuthMessage) => {
        await receive(message)
      })
    }
    const wallet = {
      getPublicKey: jest.fn(async () => ({ publicKey: identityKey })),
      createSignature: jest.fn(async () => ({ signature: [1] })),
      verifyHmac: jest.fn(async () => ({ valid: true })),
      verifySignature: jest.fn(async () => ({ valid: true }))
    }
    const sessions = new SessionManager()
    sessions.addSession({
      isAuthenticated: true,
      sessionNonce,
      peerNonce: sessionNonce,
      peerIdentityKey: identityKey,
      lastUpdate: Date.now(),
      certificatesRequired: false,
      certificatesValidated: true
    })
    const peer = new Peer(wallet as never, transport, undefined, sessions, undefined, undefined, {
      maxGeneralPayloadBytes: null
    })
    const payload = Array.from({ length: MAX_AUTH_MESSAGE_BYTES / 4 }, () => 7)
    const delivered = jest.fn((_identity: string, bytes: number[]) => {
      expect(bytes).toHaveLength(payload.length)
      expect(bytes[0]).toBe(7)
      expect(bytes[bytes.length - 1]).toBe(7)
      expect(bytes).not.toBe(payload)
    })
    peer.listenForGeneralMessages(delivered)
    await peer.toPeer(payload, identityKey)
    expect(wallet.createSignature).toHaveBeenCalledTimes(1)
    expect(wallet.verifySignature).toHaveBeenCalledTimes(1)
    expect(delivered).toHaveBeenCalledTimes(1)
  }, 30000)

  test('accepts a canonical general-message shape', () => {
    expect(() => assertValidAuthMessage(general())).not.toThrow()
  })

  test.each([
    ['invalid identity', { identityKey: `02${'00'.repeat(32)}` }],
    ['noncanonical message nonce', { nonce: `${messageNonce}\n` }],
    ['wrong session nonce width', { yourNonce: messageNonce }],
    ['sparse payload', { payload: Object.assign(Array(2), { 1: 1 }) }],
    ['oversized signature', { signature: Array(1025).fill(1) }],
    ['non-byte signature', { signature: [1, 256] }]
  ])('rejects %s before wallet processing', (_label, override) => {
    expect(() => assertValidAuthMessage(general(override))).toThrow()
  })

  test('rejects deep and prototype-sensitive object graphs without invoking accessors', () => {
    let deep: Record<string, unknown> = {}
    const root = deep
    for (let index = 0; index < 65; index++) {
      deep.next = {}
      deep = deep.next as Record<string, unknown>
    }
    expect(() => assertValidAuthMessage(general({ extra: root }))).toThrow('structure')

    const getter = jest.fn(() => '0.1')
    const message = general()
    Object.defineProperty(message, 'extra', { enumerable: true, get: getter })
    expect(() => assertValidAuthMessage(message)).toThrow('accessors')
    expect(getter).not.toHaveBeenCalled()

    const unsafe = JSON.parse(
      `{"version":"0.1","messageType":"general","identityKey":"${identityKey}","nonce":"${messageNonce}","yourNonce":"${sessionNonce}","payload":[],"signature":[1],"__proto__":true}`
    )
    expect(() => assertValidAuthMessage(unsafe)).toThrow('unsafe')

    const { version: _version, ...withoutOwnVersion } = general()
    const inheritedVersion = Object.assign(
      Object.create({ version: '0.1' }) as Record<string, unknown>,
      withoutOwnVersion
    )
    expect(() => assertValidAuthMessage(inheritedVersion)).toThrow('version')
  })

  test.each([undefined, null, 1])(
    'owns incoming data with payload policy %s before signature verification',
    async maxGeneralPayloadBytes => {
      let receive!: (message: AuthMessage) => Promise<void>
      let verificationStarted!: () => void
      let releaseVerification!: () => void
      const started = new Promise<void>(resolve => {
        verificationStarted = resolve
      })
      const blocked = new Promise<void>(resolve => {
        releaseVerification = resolve
      })
      const transport = {
        send: jest.fn(async () => {}),
        onData: jest.fn((callback: (message: AuthMessage) => Promise<void>) => {
          receive = callback
          return Promise.resolve()
        })
      }
      const wallet = {
        verifyHmac: jest.fn(async () => ({ valid: true })),
        verifySignature: jest.fn(async ({ data }: { data: number[] }) => {
          expect(data).toEqual([1])
          verificationStarted()
          await blocked
          return { valid: true }
        })
      }
      const sessions = new SessionManager()
      sessions.addSession({
        isAuthenticated: true,
        sessionNonce,
        peerNonce: sessionNonce,
        peerIdentityKey: identityKey,
        lastUpdate: Date.now(),
        certificatesRequired: false,
        certificatesValidated: true
      })
      const policy = { maxGeneralPayloadBytes }
      const peer = new Peer(
        wallet as never,
        transport as never,
        undefined,
        sessions,
        undefined,
        undefined,
        policy
      )
      policy.maxGeneralPayloadBytes = 0
      await peer.ready
      const locallySelectedPeer = new PrivateKey(42).toPublicKey().toString()
      ;(peer as any).lastInteractedWithPeer = locallySelectedPeer
      const delivered = jest.fn()
      peer.listenForGeneralMessages(delivered)
      const message = general({ payload: [1] }) as unknown as AuthMessage

      const processing = receive(message)
      await started
      message.payload![0] = 9
      releaseVerification()
      await processing

      expect(delivered).toHaveBeenCalledWith(identityKey, [1])
      expect((peer as any).lastInteractedWithPeer).toBe(locallySelectedPeer)
    }
  )

  test.each([undefined, null, 1])(
    'owns outgoing data with payload policy %s before signing',
    async maxGeneralPayloadBytes => {
      let signingStarted!: () => void
      let releaseSigning!: () => void
      const started = new Promise<void>(resolve => {
        signingStarted = resolve
      })
      const blocked = new Promise<void>(resolve => {
        releaseSigning = resolve
      })
      const transport = { onData: jest.fn(() => Promise.resolve()), send: jest.fn(async () => {}) }
      const wallet = {
        createSignature: jest.fn(async ({ data }: { data: number[] }) => {
          expect(data).toEqual([1])
          signingStarted()
          await blocked
          return { signature: [1] }
        }),
        getPublicKey: jest.fn(async () => ({ publicKey: identityKey }))
      }
      const sessions = new SessionManager()
      const counterparty = new PrivateKey(41).toPublicKey().toString()
      sessions.addSession({
        isAuthenticated: true,
        sessionNonce,
        peerNonce: sessionNonce,
        peerIdentityKey: counterparty,
        lastUpdate: Date.now(),
        certificatesRequired: false,
        certificatesValidated: true
      })
      const policy = { maxGeneralPayloadBytes }
      const peer = new Peer(
        wallet as never,
        transport as never,
        undefined,
        sessions,
        undefined,
        undefined,
        policy
      )
      policy.maxGeneralPayloadBytes = 0
      await peer.ready
      const payload = [1]

      const sending = peer.toPeer(payload, counterparty)
      await started
      payload[0] = 9
      releaseSigning()
      await sending

      expect(transport.send).toHaveBeenCalledWith(expect.objectContaining({ payload: [1] }))
    }
  )

  test('rejects unsafe local policies and payloads before transport or wallet work', async () => {
    const transport = { onData: jest.fn(() => Promise.resolve()), send: jest.fn() }
    const wallet = { createSignature: jest.fn() }
    const peer = new Peer(wallet as never, transport as never)

    await expect(peer.toPeer([1, 256])).rejects.toThrow('dense byte array')
    expect(wallet.createSignature).not.toHaveBeenCalled()
    expect(transport.send).not.toHaveBeenCalled()

    const duplicatedCertifierPolicy = {
      certifiers: [identityKey, identityKey],
      types: {}
    }
    expect(() => assertRequestedCertificateSet(duplicatedCertifierPolicy)).toThrow('unique')
    expect(() => new Peer(wallet as never, transport as never, duplicatedCertifierPolicy)).toThrow(
      'unique'
    )

    const inheritedPolicy = Object.create({ inherited: true }) as Record<string, unknown>
    inheritedPolicy.certifiers = []
    inheritedPolicy.types = {}
    expect(() => assertRequestedCertificateSet(inheritedPolicy)).toThrow('plain object')
  })
})
