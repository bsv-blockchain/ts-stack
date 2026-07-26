import { mapVerifyFlags, BDK_FLAG_BITS } from '../flags.js'

describe('mapVerifyFlags', () => {
  it('returns 0 for undefined', () => {
    expect(mapVerifyFlags()).toBe(0)
  })

  it('maps a single string flag to its bit', () => {
    expect(mapVerifyFlags('P2SH')).toBe(BDK_FLAG_BITS.P2SH)
  })

  it('ORs comma-separated string flags', () => {
    expect(mapVerifyFlags('P2SH,MINIMALDATA')).toBe(BDK_FLAG_BITS.P2SH | BDK_FLAG_BITS.MINIMALDATA)
  })

  it('ignores empty comma-separated entries', () => {
    expect(mapVerifyFlags(' , P2SH, ')).toBe(BDK_FLAG_BITS.P2SH)
  })

  it('ORs an array of flags and trims whitespace', () => {
    expect(mapVerifyFlags([' P2SH ', 'LOW_S'])).toBe(BDK_FLAG_BITS.P2SH | BDK_FLAG_BITS.LOW_S)
  })

  it('maps the post-Genesis and Chronicle bits exactly', () => {
    expect(mapVerifyFlags(['MINIMALIF', 'NULLFAIL', 'CHRONICLE', 'UTXO_AFTER_CHRONICLE'])).toBe(
      BDK_FLAG_BITS.MINIMALIF |
        BDK_FLAG_BITS.NULLFAIL |
        BDK_FLAG_BITS.CHRONICLE |
        BDK_FLAG_BITS.UTXO_AFTER_CHRONICLE
    )
  })

  it('rejects unknown flags instead of silently weakening validation', () => {
    expect(() => mapVerifyFlags('P2SH,NOT_A_REAL_FLAG')).toThrow('NOT_A_REAL_FLAG')
  })
})
