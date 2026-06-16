import { mapVerifyFlags, BDK_FLAG_BITS } from '../flags.js'

describe('mapVerifyFlags', () => {
  it('returns 0 for undefined', () => {
    expect(mapVerifyFlags()).toBe(0)
  })

  it('maps a single string flag to its bit', () => {
    expect(mapVerifyFlags('P2SH')).toBe(BDK_FLAG_BITS.P2SH)
  })

  it('ORs comma-separated string flags', () => {
    expect(mapVerifyFlags('P2SH,MINIMALDATA')).toBe(
      BDK_FLAG_BITS.P2SH | BDK_FLAG_BITS.MINIMALDATA
    )
  })

  it('ORs an array of flags and trims whitespace', () => {
    expect(mapVerifyFlags([' P2SH ', 'LOW_S'])).toBe(
      BDK_FLAG_BITS.P2SH | BDK_FLAG_BITS.LOW_S
    )
  })

  it('ignores unknown flags', () => {
    expect(mapVerifyFlags('P2SH,NOT_A_REAL_FLAG')).toBe(BDK_FLAG_BITS.P2SH)
  })
})
