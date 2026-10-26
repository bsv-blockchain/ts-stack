import { jest } from '@jest/globals'
import fc from 'fast-check'
import { PrivateKey } from '@bsv/sdk/primitives'
import {
  BRC52MemoryNonceStore,
  produceBRC52Disclosure,
  receiveBRC52Disclosure,
  type BRC52DisclosureAuthorization,
  type BRC52AuthenticationPort
} from '../src/brc52/disclosure.js'
import { exportBRC52Envelope } from '../src/brc52/envelope.js'
import { createSyntheticBRC52Binary } from './fixtures/brc52-synthetic.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(requestedSeed) ? { seed: requestedSeed } : {}),
  ...(replayPath !== undefined && replayPath !== '' ? { path: replayPath } : {})
})
jest.setTimeout(60_000)

describe('BRC-203 bounded disclosure replay properties', () => {
  test('binds even empty revelation to the exact recipient/purpose permission before wallet access', async () => {
    const binary = createSyntheticBRC52Binary([['field', Buffer.alloc(48).toString('base64')]])
    const original = exportBRC52Envelope(binary)
    const subject = new PrivateKey(2).toPublicKey().toString()
    const otherRecipient = new PrivateKey(101).toPublicKey().toString()
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 100 }),
        fc.boolean(),
        fc.boolean(),
        fc.stringMatching(/^[A-Za-z0-9]{1,24}$/),
        async (scalar, allowed, substituteRecipient, purpose) => {
          // Public small test scalars only; these mock ports perform no wallet/provider operation.
          const verifier = new PrivateKey(scalar).toPublicKey().toString()
          const getPublicKey = jest.fn(async () => ({ publicKey: subject }))
          const proveCertificate = jest.fn(async () => ({
            keyringForVerifier: {},
            verifier: substituteRecipient ? otherRecipient : verifier
          }))
          const authorize = jest.fn(async (request: BRC52DisclosureAuthorization) => {
            expect(request).toEqual({
              certificateBinary: original.certificateBinary,
              subject,
              verifier,
              purpose,
              fieldsToReveal: []
            })
            expect(Object.isFrozen(request)).toBe(true)
            return allowed
          })
          const result = produceBRC52Disclosure({
            certificateBinary: binary,
            wallet: { getPublicKey, proveCertificate },
            verifier,
            purpose,
            fieldsToReveal: [],
            authorize
          })
          if (!allowed) {
            await expect(result).rejects.toThrow('authorization denied')
            expect(getPublicKey).not.toHaveBeenCalled()
            expect(proveCertificate).not.toHaveBeenCalled()
          } else if (substituteRecipient) {
            await expect(result).rejects.toThrow('different verifier')
          } else {
            const disclosed = await result
            expect(disclosed.certificateBinary).toBe(original.certificateBinary)
            expect(disclosed.credential).toEqual(original.credential)
            expect(disclosed.disclosure).toEqual({ subject, verifier, keyring: {} })
            expect(proveCertificate).toHaveBeenCalledWith({
              certificate: expect.objectContaining({
                subject,
                fields: original.credential.credentialSubject.encryptedFields
              }),
              verifier,
              fieldsToReveal: []
            })
          }
          expect(authorize).toHaveBeenCalledTimes(1)
        }
      )
    )
  })

  test('rejects nonce replays and keeps authenticated operation scopes distinct', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{1,16}$/),
        fc.integer({ min: 1000, max: 10_000 }),
        (nonce, now) => {
          const store = new BRC52MemoryNonceStore(2)
          expect(store.consume('authenticated-operation-1', nonce, now + 100, now)).toBe(true)
          expect(store.consume('authenticated-operation-1', nonce, now + 100, now)).toBe(false)
          expect(store.consume('authenticated-operation-2', nonce, now + 100, now)).toBe(true)
          expect(store.consume('authenticated-operation-3', nonce, now + 100, now)).toBe(false)
          expect(store.consume('authenticated-operation-1', nonce, now + 200, now + 101)).toBe(true)
        }
      )
    )
  })

  test('accepts exact authenticated payloads and rejects every generated same-length byte substitution', async () => {
    const binary = createSyntheticBRC52Binary([['field', Buffer.alloc(48).toString('base64')]])
    const original = exportBRC52Envelope(binary)
    const subject = new PrivateKey(2).toPublicKey().toString()
    const verifier = new PrivateKey(4).toPublicKey().toString()
    const payload = new TextEncoder().encode(
      JSON.stringify({
        ...original,
        disclosure: { subject, verifier, keyring: {} }
      })
    )
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: payload.length - 1 }),
        fc.boolean(),
        fc.integer({ min: 1, max: 255 }),
        async (index, substitute, mask) => {
          const getPublicKey = jest.fn(async () => ({ publicKey: verifier }))
          const decrypt = jest.fn(async () => ({ plaintext: [] as number[] }))
          const authenticate: BRC52AuthenticationPort['authenticate'] = async request => {
            const authenticated = request.payload.slice()
            if (substitute) authenticated[index] ^= mask
            return {
              ...request,
              payload: authenticated,
              peer: subject,
              nonce: `synthetic-${index}-${mask}`,
              authenticatedAt: 100,
              sessionId: 'synthetic-session'
            }
          }
          const result = receiveBRC52Disclosure({
            inputData: payload,
            wallet: { getPublicKey, decrypt },
            receivingVerifier: verifier,
            operation: 'POST /synthetic-display',
            purpose: 'show encrypted source',
            authentication: { authenticate },
            nonceStore: new BRC52MemoryNonceStore(),
            now: () => 100,
            maxRequestAgeMs: 1,
            assessReliance: async () => ({
              authorized: true,
              status: {
                status: 'disabled',
                outpoint: original.credential.revocationOutpoint,
                network: 'synthetic-offline',
                privacy: {
                  mode: 'local-chain-view',
                  retrievalAttempted: false,
                  protection: 'No chain query',
                  thirdPartyCorrelation: 'none'
                }
              }
            })
          })
          if (substitute) {
            await expect(result).rejects.toThrow(
              'Authenticated payload does not match exact incoming envelope bytes'
            )
            expect(getPublicKey).not.toHaveBeenCalled()
          } else {
            const received = await result
            expect(received.verifiedDocument).toEqual(original.credential)
            expect(received.disclosedFields).toEqual({})
            expect(received.source.certificateBinary).toBe(original.certificateBinary)
          }
          expect(decrypt).not.toHaveBeenCalled()
        }
      )
    )
  })
})
