import fc from 'fast-check'
import { PrivateKey } from '@bsv/sdk/primitives'
import { BsvDid } from '../src/did/BsvDid.js'
import { decodeDidKey } from '../src/utils/multibase.js'
import type { DidResolutionOptions } from '../src/types.js'

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

/** Independent base58btc reference: no adapter codec creates the expected DID. */
function referenceDid(bytes: number[]): string {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
  let value = [0xe7, 0x01, ...bytes].reduce((sum, byte) => (sum << 8n) + BigInt(byte), 0n)
  let encoded = ''
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded
    value /= 58n
  }
  return `did:key:z${encoded}`
}

describe('BRC-202 bounded identity-key resolution properties', () => {
  test('validates exact method grammar and percent escapes before method dispatch', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]{1,12}$/),
        fc.constantFrom('00', '41', 'aF', 'F0'),
        (label, escape) => {
          for (const did of [
            `did:example:${label}%${escape}`,
            `did:example:${label}%${escape}tail`
          ]) {
            expect(BsvDid.resolve(did)).toEqual({
              didResolutionMetadata: { error: 'methodNotSupported' },
              didDocument: null,
              didDocumentMetadata: {}
            })
          }
          for (const did of [
            `prefixdid:example:${label}`,
            `did:example:${label}/path`,
            `did:example:${label}?query`,
            `did:example:${label}%Zz`,
            `did:example:${label}%4`,
            `did:example:${label}%4tail`,
            `did:example:${label}%Zztail`
          ]) {
            expect(BsvDid.resolve(did)).toEqual({
              didResolutionMetadata: { error: 'invalidDid' },
              didDocument: null,
              didDocumentMetadata: {}
            })
            expect(BsvDid.resolveRepresentation(did)).toEqual({
              didResolutionMetadata: { error: 'invalidDid' },
              didDocumentStream: null,
              didDocumentMetadata: {}
            })
          }
        }
      )
    )
  })

  test('resolves compressed public test points to the exact static profile without trust metadata', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100 }), scalar => {
        // Public small scalars are synthetic test points only: no wallets/signing/credentials.
        const publicBytes = new PrivateKey(scalar).toPublicKey().toDER() as number[]
        const did = referenceDid(publicBytes)
        expect(BsvDid.fromPublicKey(publicBytes)).toBe(did)
        expect(decodeDidKey(did).publicKeyBytes).toEqual(publicBytes)
        const multibase = did.slice('did:key:'.length)
        const method = {
          id: `${did}#${multibase}`,
          type: 'Multikey',
          controller: did,
          publicKeyMultibase: multibase
        }
        const document = {
          '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
          id: did,
          verificationMethod: [method],
          authentication: [method.id],
          assertionMethod: [method.id],
          capabilityInvocation: [method.id],
          capabilityDelegation: [method.id]
        }
        expect(BsvDid.resolve(did)).toEqual({
          didResolutionMetadata: {},
          didDocument: document,
          didDocumentMetadata: {}
        })
        expect(BsvDid.toDidDocument(did)).toEqual(document)
        expect(BsvDid.dereference(method.id)).toEqual({
          dereferencingMetadata: {},
          contentStream: method,
          contentMetadata: {}
        })
        const represented = BsvDid.resolveRepresentation(did, { accept: 'application/did+ld+json' })
        expect(represented.didResolutionMetadata).toEqual({
          contentType: 'application/did+ld+json'
        })
        expect(represented.didDocumentStream).toEqual(
          new TextEncoder().encode(JSON.stringify(document))
        )
        const first = BsvDid.resolve(did)
        first.didDocument!.authentication.push('unsigned-addition')
        expect(BsvDid.resolve(did).didDocument).toEqual(document)
      })
    )
  })

  test('rejects malformed compression and DID URL components rather than resolving a fallback', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.constantFrom(0, 1, 4, 5, 6, 7, 255),
        fc.constantFrom('#other', '/path', '?query', ':extra', '\n'),
        (scalar, invalidPrefix, suffix) => {
          const bytes = new PrivateKey(scalar).toPublicKey().toDER() as number[]
          expect(() => BsvDid.fromPublicKey([invalidPrefix, ...bytes.slice(1)])).toThrow()
          const did = referenceDid(bytes)
          expect(BsvDid.resolve(`${did}${suffix}`)).toMatchObject({
            didDocument: null,
            didResolutionMetadata: { error: 'invalidDid' }
          })
          expect(BsvDid.resolveRepresentation(`${did}${suffix}`).didDocumentStream).toBeNull()
          expect(BsvDid.dereference(`${did}#other`)).toMatchObject({
            contentStream: null,
            dereferencingMetadata: { error: 'notFound' }
          })
        }
      )
    )
  })

  test('rejects unsigned remote-document options and unsupported representation/method requests', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100 }),
        fc.stringMatching(/^[A-Za-z0-9]{1,24}$/),
        (scalar, label) => {
          const did = referenceDid(new PrivateKey(scalar).toPublicKey().toDER() as number[])
          const unsigned = {
            didDocument: { id: `did:key:${label}` }
          } as unknown as DidResolutionOptions
          expect(BsvDid.resolve(did, unsigned)).toMatchObject({
            didDocument: null,
            didResolutionMetadata: { error: 'representationNotSupported' }
          })
          expect(
            BsvDid.resolveRepresentation(did, { accept: `application/${label}` })
          ).toMatchObject({
            didDocumentStream: null,
            didResolutionMetadata: { error: 'representationNotSupported' }
          })
          const unsupported = `did:example:${label}`
          expect(BsvDid.resolve(unsupported)).toMatchObject({
            didDocument: null,
            didResolutionMetadata: { error: 'methodNotSupported' }
          })
          expect(BsvDid.dereference(`${unsupported}#key`)).toMatchObject({
            contentStream: null,
            dereferencingMetadata: { error: 'methodNotSupported' }
          })
          for (const operation of [
            BsvDid.update,
            BsvDid.rotate,
            BsvDid.recover,
            BsvDid.deactivate
          ]) {
            expect(operation()).toEqual({ supported: false, error: 'operationNotSupported' })
          }
        }
      )
    )
  })
})
