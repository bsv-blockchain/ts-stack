import { describe, expect, it } from '@jest/globals'
import {
  assetBasket,
  assetTag,
  colorProtocolID,
  ISSUE,
  parseAssetBasket,
  parseBalanceSelector,
  parseColorProtocolID,
  parseOutpoint,
  validateIdentityKey
} from '../identifiers.js'

const TXID = 'ab'.repeat(32)

describe('BRC-207 identifiers', () => {
  it('encodes the 207 example ISSUE protocol name', () => {
    expect(colorProtocolID(ISSUE, 'AQ==', 'Ag==')).toEqual([2, 'p color issue 41513d3d 41673d3d'])
    expect(parseColorProtocolID([2, 'p color issue 41513d3d 41673d3d'])).toEqual({
      assetId: ISSUE,
      derivationPrefix: 'AQ==',
      derivationSuffix: 'Ag=='
    })
  })

  it('maps asset IDs to tags and per-asset baskets', () => {
    expect(assetTag(`${TXID}_7`)).toBe(`${TXID}v7`)
    expect(assetBasket(`${TXID}_0`, 'value')).toBe(`p color ${TXID}v0`)
    expect(assetBasket(`${TXID}_0`, 'authority')).toBe(`p color ${TXID}v0 authority`)
    expect(parseAssetBasket(`p color ${TXID}v0 authority`)).toEqual({
      assetId: `${TXID}_0`,
      role: 'authority'
    })
    expect(parseAssetBasket('p color assets')).toBeUndefined()
    expect(parseBalanceSelector(`p color balance ${TXID}v0`)).toEqual({
      assetId: `${TXID}_0`,
      role: 'value'
    })
    expect(() => assetBasket(ISSUE, 'value')).toThrow('invalid asset ID')
  })

  it.each([
    ['uppercase hex', `${TXID.toUpperCase()}_0`],
    ['a leading-zero index', `${TXID}_01`],
    ['a dot separator', `${TXID}.0`],
    ['an index above uint32', `${TXID}_4294967296`]
  ])('rejects an asset ID with %s', (_name, assetId) => {
    expect(() => assetTag(assetId)).toThrow('invalid asset ID')
  })

  it('rejects malformed protocol IDs and remittance strings before derivation', () => {
    expect(() => parseColorProtocolID([1, 'p color issue 41 41'])).toThrow('security level 2')
    expect(() => parseColorProtocolID([2, 'p color issue 4 41'])).toThrow('remittance tags')
    expect(() => parseColorProtocolID([2, `p color ${TXID}_0 41 41`])).toThrow('invalid asset tag')
    expect(() => parseColorProtocolID([2, 'p color issue 2041 41'])).toThrow('without whitespace')
    expect(() => colorProtocolID(ISSUE, '\ud800', 'x')).toThrow('strict UTF-8')
    expect(() => colorProtocolID(`${TXID}_0`, 'a'.repeat(110), 'b')).toThrow('280 characters')
  })

  it('parses canonical dot-form outpoints and rejects every other form', () => {
    expect(parseOutpoint(`${TXID}.4294967295`)).toEqual({ txid: TXID, vout: 4294967295 })
    for (const outpoint of [
      7,
      undefined,
      `${TXID}_0`,
      `${TXID.toUpperCase()}.0`,
      `${TXID}.01`,
      `${TXID}.4294967296`
    ]) {
      expect(() => parseOutpoint(outpoint)).toThrow('BRC-207: invalid outpoint')
    }
  })

  it('accepts only on-curve compressed public keys in lowercase hex', () => {
    const key = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
    expect(validateIdentityKey(key, 'senderIdentityKey')).toBe(key)
    for (const value of [
      undefined,
      key.toUpperCase(),
      `04${key.slice(2)}`,
      key.slice(0, -2),
      `${key}00`
    ]) {
      expect(() => validateIdentityKey(value, 'senderIdentityKey')).toThrow(
        'BRC-207: senderIdentityKey must be a compressed public key in lowercase hex'
      )
    }
    // Matches the lowercase compressed form, but x = 0 is not on secp256k1.
    expect(() => validateIdentityKey(`02${'00'.repeat(32)}`, 'senderIdentityKey')).toThrow(
      'BRC-207: senderIdentityKey is not a valid public key (Invalid point)'
    )
  })

  it.each([
    ['a non-string name', [2, 7]],
    ['too few words', [2, 'p color issue 41']],
    ['too many words', [2, 'p color issue 41 41 41']],
    ['another protocol', [2, 'q color issue 41 41']],
    ['another namespace', [2, 'p colour issue 41 41']],
    ['a name above 280 characters', [2, `p color issue ${'41'.repeat(133)} 41`]]
  ])('rejects a p color protocol ID with %s', (_name, protocolID) => {
    expect(() => parseColorProtocolID(protocolID)).toThrow('BRC-207: invalid p color protocol name')
  })

  it('accepts a protocol name of exactly 280 characters', () => {
    const name = `p color ${TXID}v0 ${'41'.repeat(100)} 4141`
    expect(name).toHaveLength(280)
    expect(parseColorProtocolID([2, name])).toEqual({
      assetId: `${TXID}_0`,
      derivationPrefix: 'A'.repeat(100),
      derivationSuffix: 'AA'
    })
    expect(() => parseColorProtocolID([2, `${name}41`])).toThrow(
      'BRC-207: invalid p color protocol name'
    )
  })

  it('has no stored basket or balance selector for issue', () => {
    expect(() => parseAssetBasket('p color issue')).toThrow('BRC-207: issue is not a stored basket')
    expect(() => parseAssetBasket('p color issue authority')).toThrow(
      'BRC-207: issue is not a stored basket'
    )
    expect(() => parseBalanceSelector('p color balance issue')).toThrow(
      'BRC-207: issue is not a stored basket'
    )
  })
})
