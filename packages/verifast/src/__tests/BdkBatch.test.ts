import { BdkErrorDomain, BdkVerificationError } from '../BdkVerifierTypes.js'
import { decodeResults, flagsForInputCount, packArrays, verdict } from '../BdkBatch.js'

describe('BDK batch helpers', () => {
  it('normalizes explicit and named flag sets for every input', () => {
    expect(flagsForInputCount(2, undefined, [1, 2])).toEqual(Uint32Array.of(1, 2))
    expect(flagsForInputCount(2, undefined, [])).toEqual(new Uint32Array())
    expect(flagsForInputCount(2)).toEqual(new Uint32Array())
    expect(flagsForInputCount(2, 'P2SH')).toEqual(Uint32Array.of(1, 1))
    expect(() => flagsForInputCount(2, undefined, [1])).toThrow(
      'Custom flag count must be zero or match the input count'
    )
  })

  it('packs typed arrays and records every boundary', () => {
    const packed = packArrays(
      [Uint8Array.of(1, 2), Uint8Array.of(), Uint8Array.of(3)],
      length => new Uint8Array(length)
    )

    expect(packed.values).toEqual(Uint8Array.of(1, 2, 3))
    expect(packed.offsets).toEqual(Uint32Array.of(0, 2, 2, 3))
  })

  it('decodes flat result pairs and rejects malformed output', () => {
    expect(decodeResults(Int32Array.of(0, 0, 1, 7), 2)).toEqual([
      { domain: 0, code: 0 },
      { domain: 1, code: 7 }
    ])
    expect(() => decodeResults(Int32Array.of(0), 1)).toThrow(BdkVerificationError)
  })

  it('maps structured domains to success, rejection, or an exception', () => {
    expect(verdict({ domain: BdkErrorDomain.OK, code: 0 })).toBe(true)
    expect(verdict({ domain: BdkErrorDomain.SCRIPT, code: 1 })).toBe(false)
    expect(verdict({ domain: BdkErrorDomain.DOS, code: 1 })).toBe(false)
    expect(() => verdict({ domain: BdkErrorDomain.EXCEPTION, code: 1 })).toThrow(
      BdkVerificationError
    )
  })
})
