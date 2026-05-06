import { DID } from '../did'

const TXID = 'a'.repeat(64)
const PUBKEY = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'

describe('DID utilities', () => {
  it('parses txid-based did:bsv identifiers', () => {
    expect(DID.parse(`did:bsv:${TXID}`)).toEqual({
      method: 'bsv',
      identifier: TXID
    })
  })

  it('parses legacy public-key-based did:bsv identifiers', () => {
    expect(DID.parse(`did:bsv:${PUBKEY}`)).toEqual({
      method: 'bsv',
      identifier: PUBKEY
    })
  })

  it('rejects invalid DID strings', () => {
    expect(() => DID.parse('did:example:abc')).toThrow('Invalid DID')
    expect(() => DID.parse('did:bsv:not-hex')).toThrow('identifier must be')
  })

  it('validates DID strings without throwing', () => {
    expect(DID.isValid(`did:bsv:${TXID}`)).toBe(true)
    expect(DID.isValid('did:bsv:not-hex')).toBe(false)
  })

  it('creates DID strings from lowercase txids', () => {
    expect(DID.fromTxid(TXID)).toBe(`did:bsv:${TXID}`)
  })

  it('rejects malformed txids', () => {
    expect(() => DID.fromTxid('A'.repeat(64))).toThrow('Invalid txid')
    expect(() => DID.fromTxid('a'.repeat(63))).toThrow('Invalid txid')
  })

  it('builds a W3C DID document with optional controller and services', () => {
    const service = {
      id: `did:bsv:${TXID}#message-box`,
      type: 'MessageBox',
      serviceEndpoint: 'https://example.com/messages'
    }

    const doc = DID.buildDocument(TXID, PUBKEY, 'did:bsv:controller', [service])

    expect(doc.id).toBe(`did:bsv:${TXID}`)
    expect(doc.controller).toBe('did:bsv:controller')
    expect(doc.service).toEqual([service])
    expect(doc.verificationMethod[0]).toMatchObject({
      id: `did:bsv:${TXID}#subject-key`,
      type: 'JsonWebKey2020',
      controller: `did:bsv:${TXID}`
    })
    expect(doc.verificationMethod[0].publicKeyJwk).toMatchObject({
      kty: 'EC',
      crv: 'secp256k1'
    })
    expect(doc.authentication).toEqual([`did:bsv:${TXID}#subject-key`])
  })

  it('omits optional DID document fields when not provided', () => {
    const doc = DID.buildDocument(TXID, PUBKEY)

    expect(doc.controller).toBeUndefined()
    expect(doc.service).toBeUndefined()
  })

  it('builds legacy DID documents from identity keys', () => {
    const doc = DID.fromIdentityKey(PUBKEY)

    expect(doc.id).toBe(`did:bsv:${PUBKEY}`)
    expect(doc.controller).toBe(`did:bsv:${PUBKEY}`)
    expect(doc.verificationMethod[0]).toEqual({
      id: `did:bsv:${PUBKEY}#key-1`,
      type: 'EcdsaSecp256k1VerificationKey2019',
      controller: `did:bsv:${PUBKEY}`,
      publicKeyHex: PUBKEY
    })
    expect(doc.authentication).toEqual([`did:bsv:${PUBKEY}#key-1`])
    expect(doc.assertionMethod).toEqual([`did:bsv:${PUBKEY}#key-1`])
  })

  it('rejects invalid legacy identity keys', () => {
    expect(() => DID.fromIdentityKey('')).toThrow('Invalid identity key')
    expect(() => DID.fromIdentityKey('abcd')).toThrow('Invalid identity key')
  })

  it('returns the DID certificate type', () => {
    expect(DID.getCertificateType()).toBe('ZGlkOmJzdg==')
  })
})
