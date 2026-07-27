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

  test('normalizes hexadecimal and byte-array public-key inputs', () => {
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

  test('hashes both text and byte-array values', () => {
    expect(sha256Base64Url('abc')).toBe(sha256Base64Url(new TextEncoder().encode('abc')))
  })
})
