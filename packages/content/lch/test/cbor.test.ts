import { describe, expect, it } from '@jest/globals'
import { decodeDeterministicCbor, encodeDeterministicCbor, LCHError } from '../src/index.js'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

function expectCborError(bytes: Uint8Array, message: string): void {
  try {
    decodeDeterministicCbor(bytes)
    throw new Error('Expected CBOR decoding to fail')
  } catch (error) {
    expect(error).toBeInstanceOf(LCHError)
    expect(error).toMatchObject({ code: 'ERR_LCH_CBOR', message })
  }
}

describe('deterministic LCH CBOR', () => {
  it('orders keys by encoded bytes and round trips uint64 values', () => {
    const value = { longer: 0x20_0000_0000_0000n, a: Uint8Array.of(1, 2), z: [true, null, 'é'] }
    const encoded = encodeDeterministicCbor(value)
    expect(Array.from(encoded.slice(0, 4))).toEqual([0xa3, 0x61, 0x61, 0x42])
    expect(decodeDeterministicCbor(encoded)).toEqual(value)
  })

  it.each([
    [0n, '00'],
    [23n, '17'],
    [24n, '1818'],
    [255n, '18ff'],
    [256n, '190100'],
    [65_535n, '19ffff'],
    [65_536n, '1a00010000'],
    [0xffff_ffffn, '1affffffff'],
    [0x1_0000_0000n, '1b0000000100000000'],
    [0xffff_ffff_ffff_ffffn, '1bffffffffffffffff']
  ])('encodes uint boundary %s with its shortest head', (value, expected) => {
    const encoded = encodeDeterministicCbor(value)
    expect(hex(encoded)).toBe(expected)
    expect(decodeDeterministicCbor(encoded)).toBe(
      value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
    )
  })

  it('sorts map keys by their complete encoded bytes, including different lengths', () => {
    const encoded = encodeDeterministicCbor({ aa: 2, b: 1, a: 0 })
    expect(hex(encoded)).toBe('a361610061620162616102')
    expect(decodeDeterministicCbor(encoded)).toEqual(
      Object.assign(Object.create(null) as Record<string, number>, { a: 0, b: 1, aa: 2 })
    )
  })

  it.each([
    [Uint8Array.of(0x18, 0x17), 'Non-shortest CBOR length'],
    [Uint8Array.of(0x19, 0x00, 0xff), 'Non-shortest CBOR length'],
    [Uint8Array.of(0x1a, 0x00, 0x00, 0xff, 0xff), 'Non-shortest CBOR length'],
    [
      Uint8Array.of(0x1b, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff),
      'Non-shortest CBOR length'
    ],
    [Uint8Array.of(0x9f, 0xff), 'Indefinite-length or reserved CBOR item'],
    [
      Uint8Array.of(0xa2, 0x61, 0x61, 0x00, 0x61, 0x61, 0x01),
      'CBOR map keys are duplicated or unordered'
    ],
    [
      Uint8Array.of(0xa2, 0x61, 0x62, 0x00, 0x61, 0x61, 0x01),
      'CBOR map keys are duplicated or unordered'
    ],
    [Uint8Array.of(0xa1, 0x00, 0x00), 'LCH CBOR map keys must be text'],
    [Uint8Array.of(0xc0, 0x00), 'Unsupported CBOR major type 6'],
    [Uint8Array.of(0xf9, 0x00, 0x00), 'Unsupported CBOR simple or floating-point value'],
    [Uint8Array.of(0x61, 0xff), 'CBOR text is not valid UTF-8'],
    [Uint8Array.of(0x00, 0x00), 'Trailing bytes after CBOR value']
  ])('rejects non-canonical input with its stable protocol error', (bytes, message) => {
    expectCborError(bytes, message)
  })

  it('rejects uints outside the BRC-170 data model', () => {
    expect(() => encodeDeterministicCbor(-1n)).toThrow(
      expect.objectContaining({ code: 'ERR_LCH_CBOR', message: 'CBOR uint exceeds uint64' })
    )
    expect(() => encodeDeterministicCbor(0x1_0000_0000_0000_0000n)).toThrow(
      expect.objectContaining({ code: 'ERR_LCH_CBOR', message: 'CBOR uint exceeds uint64' })
    )
  })

  it('rejects undefined map members before signing or hashing', () => {
    expect(() =>
      encodeDeterministicCbor({ missing: undefined } as unknown as Record<string, null>)
    ).toThrow(
      expect.objectContaining({
        code: 'ERR_LCH_CBOR',
        message: 'Undefined CBOR map value: missing'
      })
    )
  })
})
