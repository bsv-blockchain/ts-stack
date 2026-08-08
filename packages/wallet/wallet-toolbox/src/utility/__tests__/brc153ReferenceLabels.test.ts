import { Utils } from '@bsv/sdk'
import {
  applyBrc153ReferenceLabel,
  makeBrc153ReferenceLabel,
  parseBrc153ReferenceLabel,
  rejectBrc153ReferenceLabels
} from '../brc153ReferenceLabels'

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

  it('overwrites any reserved reference labels with the wallet-authored value', () => {
    const reference = Utils.toBase64([0xde, 0xad, 0xbe, 0xef])
    const forged = 'reference 00000000'
    const labels = applyBrc153ReferenceLabel(['payment', forged, 'personal'], reference)
    expect(labels).toEqual(['payment', 'personal', makeBrc153ReferenceLabel(reference)])
  })

  it('drops caller-supplied reserved labels on create/internalize', () => {
    expect(rejectBrc153ReferenceLabels(['a', 'reference deadbeef', 'b'])).toEqual(['a', 'b'])
  })
})
