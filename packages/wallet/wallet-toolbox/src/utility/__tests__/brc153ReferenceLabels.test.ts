import { Utils } from '@bsv/sdk'
import { makeBrc153ReferenceLabel, parseBrc153ReferenceLabel } from '../brc153ReferenceLabels'

describe('brc153ReferenceLabels', () => {
  it('round-trips base64 reference through the synthetic hex label', () => {
    const reference = Utils.toBase64([0x01, 0xab, 0xcd, 0xef, 0x00, 0xff, 0x10, 0x20, 0x30, 0x40, 0x50, 0x60])
    const label = makeBrc153ReferenceLabel(reference)
    expect(label).toBe(`reference ${Utils.toHex(Utils.toArray(reference, 'base64'))}`)
    expect(label).toMatch(/^reference [0-9a-f]+$/)
    expect(parseBrc153ReferenceLabel(label)).toBe(reference)
  })

  it('returns undefined for non-reference labels', () => {
    expect(parseBrc153ReferenceLabel('payment')).toBeUndefined()
    expect(parseBrc153ReferenceLabel('reference ')).toBeUndefined()
    expect(parseBrc153ReferenceLabel('reference xyz')).toBeUndefined()
    expect(parseBrc153ReferenceLabel('reference ab')).toBe('qw==')
  })
})
