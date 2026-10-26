import { PrivateKey } from '@bsv/sdk'
import {
  BsvDid,
  decodeDidKey,
  publicKeyFromDid,
  publicKeyToDidKey,
  publicKeyToJwk,
  verificationMethodForDid
} from '../src/index.js'
import { sha256Base64Url } from '../src/utils/crypto.js'
import {
  didFromVerificationMethod,
  encodeBase58Multibase,
  SECP256K1_PUB_MULTICODEC_PREFIX
} from '../src/utils/multibase.js'

describe('BsvDid', () => {
  test('creates a secp256k1 did:key and DID Document', () => {
    const privateKey = PrivateKey.fromHex(
      '0000000000000000000000000000000000000000000000000000000000000001'
    )
    const publicKey = privateKey.toPublicKey().toDER() as number[]
    const did = BsvDid.fromPublicKey(publicKey)
    const decoded = decodeDidKey(did)
    const document = BsvDid.toDidDocument(did)

    expect(did).toMatch(/^did:key:z/)
    expect(decoded.publicKeyBytes).toEqual(publicKey)
    expect(publicKeyFromDid(did).toDER()).toEqual(publicKey)
    expect(document.id).toBe(did)
    expect(document.verificationMethod[0].publicKeyMultibase).toBe(decoded.multibaseValue)
    expect(document.assertionMethod).toEqual([`${did}#${decoded.multibaseValue}`])
  })

  test('accepts compressed hexadecimal, byte-array and public-key object inputs', () => {
    const publicKeyObject = PrivateKey.fromRandom().toPublicKey()
    const publicKey = publicKeyObject.toDER() as number[]
    const publicKeyHex = publicKey.map(byte => byte.toString(16).padStart(2, '0')).join('')
    const publicKeyBytes = new Uint8Array(publicKey)

    expect(publicKeyToDidKey(publicKeyHex)).toBe(publicKeyToDidKey(publicKeyBytes))
    expect(publicKeyToDidKey(publicKeyObject)).toBe(publicKeyToDidKey(publicKeyBytes))
    expect(publicKeyToJwk(publicKeyHex)).toEqual(publicKeyToJwk(publicKeyBytes))
  })

  test('round-trips the canonical verification method and rejects forged fragments', () => {
    const did = publicKeyToDidKey(new PrivateKey(1).toPublicKey())
    const verificationMethod = verificationMethodForDid(did)

    expect(didFromVerificationMethod(verificationMethod)).toBe(did)
    expect(() => didFromVerificationMethod(did)).toThrow('with a fragment')
    expect(() => didFromVerificationMethod(`${did}#`)).toThrow('with a fragment')
    expect(() => didFromVerificationMethod(`${did}#wrong`)).toThrow('does not match')
  })

  test('rejects malformed DID grammar, multicodecs, key lengths, and curve points', () => {
    const validKey = new PrivateKey(1).toPublicKey().toDER() as number[]
    const invalidInputs = [
      'did:key',
      'did:web:example.com',
      'did:key:not-multibase',
      `did:key:${encodeBase58Multibase([0xe8, 0x01, ...validKey])}`,
      `did:key:${encodeBase58Multibase([...SECP256K1_PUB_MULTICODEC_PREFIX, ...validKey.slice(1)])}`,
      `did:key:${encodeBase58Multibase([
        ...SECP256K1_PUB_MULTICODEC_PREFIX,
        ...Array.from({ length: 33 }, () => 0)
      ])}`
    ]

    for (const did of invalidInputs) expect(() => decodeDidKey(did)).toThrow()
  })

  test('rejects each malformed DID component with its precise boundary error', () => {
    const validKey = new PrivateKey(1).toPublicKey().toDER() as number[]
    const multibase = encodeBase58Multibase([...SECP256K1_PUB_MULTICODEC_PREFIX, ...validKey])
    const malformedGrammar = [
      'did:key',
      `web:key:${multibase}`,
      `did:web:${multibase}`,
      `did:key:${multibase}:extra`
    ]

    expect(() => decodeDidKey(1 as unknown as string)).toThrow(
      'did:key identifier must be a string'
    )
    for (const did of malformedGrammar) {
      expect(() => decodeDidKey(did)).toThrow('Invalid did:key identifier')
    }
    expect(() =>
      decodeDidKey(`did:key:${encodeBase58Multibase([0xe8, 0x01, ...validKey])}`)
    ).toThrow('Unsupported did:key multicodec')
    expect(() =>
      decodeDidKey(`did:key:${encodeBase58Multibase([0xe7, 0x02, ...validKey])}`)
    ).toThrow('Unsupported did:key multicodec')
    expect(() =>
      decodeDidKey(
        `did:key:${encodeBase58Multibase([
          ...SECP256K1_PUB_MULTICODEC_PREFIX,
          ...validKey.slice(1)
        ])}`
      )
    ).toThrow('Invalid secp256k1 public key length')
  })

  test('rejects malformed verification-method bounds and extra fragments precisely', () => {
    const did = publicKeyToDidKey(new PrivateKey(1).toPublicKey())
    const verificationMethod = verificationMethodForDid(did)

    expect(() => didFromVerificationMethod(1 as unknown as string)).toThrow(
      'Verification method must be a string'
    )
    expect(() => didFromVerificationMethod('x'.repeat(4_097))).toThrow(
      'Verification method has an invalid length'
    )
    expect(() => didFromVerificationMethod('x'.repeat(1_025))).toThrow(
      'Verification method must be a DID URL with a fragment'
    )
    expect(() => didFromVerificationMethod(`${verificationMethod}#extra`)).toThrow(
      'Verification method must be a DID URL with a fragment'
    )
  })

  test('hashes both text and byte-array values', () => {
    expect(sha256Base64Url('abc')).toBe(sha256Base64Url(new TextEncoder().encode('abc')))
  })
})
