import { PrivateKey } from '@bsv/sdk'
import {
  BsvDid,
  decodeDidKey,
  publicKeyFromDid,
  publicKeyToDidKey,
  publicKeyToJwk
} from '../src/index.js'
import { sha256Base64Url } from '../src/utils/crypto.js'

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
    const publicKey = PrivateKey.fromRandom().toPublicKey().toDER() as number[]
    const publicKeyHex = publicKey.map(byte => byte.toString(16).padStart(2, '0')).join('')
    const publicKeyBytes = new Uint8Array(publicKey)

    expect(publicKeyToDidKey(publicKeyHex)).toBe(publicKeyToDidKey(publicKeyBytes))
    expect(publicKeyToJwk(publicKeyHex)).toEqual(publicKeyToJwk(publicKeyBytes))
  })

  test('hashes both text and byte-array values', () => {
    expect(sha256Base64Url('abc')).toBe(sha256Base64Url(new TextEncoder().encode('abc')))
  })
})
