import { DID } from '../did'

const PUBLIC_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const IDENTIFIER = 'did:key:zQ3shVc2UkAfJCdc1TR8E66J85h48P43r93q8jGPkPpjF9Ef9'

describe('Simple BRC-202 identity-key adapter', () => {
  it('encodes the independent proposed specification vector and resolves offline', () => {
    expect(DID.fromIdentityKey(PUBLIC_KEY)).toBe(IDENTIFIER)
    const result = DID.resolve(IDENTIFIER)
    expect(result.didResolutionMetadata).toEqual({})
    expect(result.didDocumentMetadata).toEqual({})
    expect(result.didDocument?.id).toBe(IDENTIFIER)
    expect(result.didDocument?.verificationMethod[0].publicKeyMultibase).toBe(IDENTIFIER.slice(8))
    expect(result.didDocument).not.toHaveProperty('service')
    expect(result.didDocument).not.toHaveProperty('keyAgreement')
  })

  it.each(['', 'abcd', '02fffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f'])(
    'rejects invalid compressed identity key %s',
    key => {
      expect(() => DID.fromIdentityKey(key)).toThrow()
    }
  )

  it.each([`${IDENTIFIER}#key`, `${IDENTIFIER}?version=1`, `${IDENTIFIER}/path`, ` ${IDENTIFIER}`])(
    'rejects non-profile identifier %s',
    value => {
      expect(DID.resolve(value)).toMatchObject({
        didResolutionMetadata: { error: 'invalidDid' },
        didDocument: null
      })
    }
  )

  it('does not invent an identity for a legacy transaction identifier', () => {
    expect(DID.resolve(`did:bsv:${'aa'.repeat(32)}`)).toMatchObject({
      didResolutionMetadata: { error: 'methodNotSupported' },
      didDocument: null
    })
  })
})
