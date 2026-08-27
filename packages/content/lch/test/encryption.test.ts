import { describe, expect, it } from '@jest/globals'
import {
  decryptSegmented,
  encryptSegmented,
  LCHError,
  recordRange,
  validateKeyGrantsForSelection
} from '../src/index.js'

function deterministicRandom(): (length: number) => Uint8Array {
  let call = 0
  return length => {
    call += 1
    return Uint8Array.from({ length }, (_, index) => (index * 17 + length + call) & 0xff)
  }
}

describe('segmented AES-GCM', () => {
  it('decrypts all records and selected key periods', async () => {
    const plaintext = new TextEncoder().encode('0123456789abcdefghijklmnopqrstuvwxyz')
    const encrypted = await encryptSegmented(plaintext, {
      segmentSize: 8,
      keyPeriodSegments: 2,
      random: deterministicRandom()
    })
    expect(
      await decryptSegmented(encrypted.ciphertext, encrypted.descriptor, encrypted.keys)
    ).toEqual(plaintext)
    const firstPeriod = new Map([...encrypted.keys].slice(0, 1))
    expect(
      new TextDecoder().decode(
        await decryptSegmented(encrypted.ciphertext, encrypted.descriptor, firstPeriod, {
          type: 'segments',
          ranges: [[0, 2]]
        })
      )
    ).toBe('0123456789abcdef')
    expect(() => recordRange(encrypted.descriptor, 5)).toThrow(LCHError)
    const grants = encrypted.descriptor.keyPeriods.map(period => ({ keyId: period.keyId }))
    expect(() =>
      validateKeyGrantsForSelection(encrypted.descriptor, { type: 'all' }, grants.slice(0, 1))
    ).toThrow(LCHError)
    expect(() =>
      validateKeyGrantsForSelection(encrypted.descriptor, { type: 'all' }, grants)
    ).not.toThrow()
  })

  it('authenticates before releasing plaintext', async () => {
    const encrypted = await encryptSegmented(Uint8Array.of(1, 2, 3), {
      segmentSize: 2,
      random: deterministicRandom()
    })
    encrypted.ciphertext[0] ^= 1
    await expect(
      decryptSegmented(encrypted.ciphertext, encrypted.descriptor, encrypted.keys)
    ).rejects.toMatchObject({ code: 'ERR_LCH_AUTHENTICATION' })
  })

  it('represents empty content as one authentication tag', async () => {
    const encrypted = await encryptSegmented(new Uint8Array(), { random: deterministicRandom() })
    expect(encrypted.ciphertext).toHaveLength(16)
    expect(
      await decryptSegmented(encrypted.ciphertext, encrypted.descriptor, encrypted.keys)
    ).toHaveLength(0)
  })

  it('rejects CEK reuse across key periods', async () => {
    await expect(
      encryptSegmented(new Uint8Array(8), {
        segmentSize: 2,
        keyPeriodSegments: 1,
        random: length => new Uint8Array(length).fill(7)
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_KEY' })
  })
})
