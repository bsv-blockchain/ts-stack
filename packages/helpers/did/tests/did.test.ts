import { PrivateKey } from '@bsv/sdk'
import { BsvDid, decodeDidKey, publicKeyFromDid } from '../src/index.js'

describe('BsvDid', () => {
  test('creates a secp256k1 did:key and DID Document', () => {
    const privateKey = PrivateKey.fromHex('0000000000000000000000000000000000000000000000000000000000000001')
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
})
