import { describe, expect, it } from '@jest/globals'
import {
  assetBasket,
  assetTag,
  colorProtocolID,
  ISSUE,
  parseAssetBasket,
  parseBalanceSelector,
  parseColorProtocolID
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
})
