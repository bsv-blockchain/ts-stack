import {
  brc177NoSendExpiryStateRank,
  hasBrc177NoSendExpiryLabel,
  parseBrc177NoSendExpiryLabels
} from '../brc177NoSendExpiry'

describe('BRC-177 noSend expiry labels', () => {
  test.each([
    ['p nosend expiry seconds 30', 'seconds', 30],
    ['p nosend expiry timestamp 1788134400', 'timestamp', 1788134400],
    ['p nosend expiry blockheight 900000', 'blockheight', 900000]
  ] as const)('parses %s', (label, mode, value) => {
    expect(parseBrc177NoSendExpiryLabels([label, 'application label'])).toEqual({ label, mode, value })
    expect(hasBrc177NoSendExpiryLabel([label])).toBe(true)
  })

  test('ignores labels outside the reserved module', () => {
    expect(parseBrc177NoSendExpiryLabels(['application label'])).toBeUndefined()
    expect(hasBrc177NoSendExpiryLabel(['application label'])).toBe(false)
  })

  test.each([
    'p nosend expiry seconds 0',
    'p nosend expiry seconds 01',
    'p nosend expiry seconds -1',
    'p nosend expiry seconds 1.5',
    'p nosend expiry seconds  1',
    'p nosend expiry seconds 1 ',
    'p nosend expiry seconds',
    'p nosend expiry minutes 1',
    'p nosend unsupported payload',
    `p nosend expiry timestamp ${Number.MAX_SAFE_INTEGER + 1}`
  ])('rejects non-canonical or unsupported label %s', label => {
    expect(() => parseBrc177NoSendExpiryLabels([label])).toThrow()
  })

  test('rejects multiple labels in the reserved module', () => {
    expect(() =>
      parseBrc177NoSendExpiryLabels(['p nosend expiry seconds 30', 'p nosend expiry timestamp 1788134400'])
    ).toThrow('exactly one')
  })

  test('orders synchronized lifecycle states without allowing unsafe regression', () => {
    expect(brc177NoSendExpiryStateRank('cancelled')).toBeGreaterThan(brc177NoSendExpiryStateRank('unsigned'))
    expect(brc177NoSendExpiryStateRank('signed')).toBeGreaterThan(brc177NoSendExpiryStateRank('cancelled'))
    expect(brc177NoSendExpiryStateRank('revocation-requested')).toBeGreaterThan(brc177NoSendExpiryStateRank('signed'))
    expect(brc177NoSendExpiryStateRank('reclaiming')).toBeGreaterThan(brc177NoSendExpiryStateRank('broadcast'))
    expect(brc177NoSendExpiryStateRank('target-won')).toBeGreaterThan(brc177NoSendExpiryStateRank('reclaimed'))
  })
})
