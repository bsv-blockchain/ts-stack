import {
  actionBatchPackLength,
  compressActionBatchPack,
  compressActionBatchPackItems,
  decodeActionBatchPack,
  decompressActionBatchPack,
  encodeActionBatchPack,
  supportedActionBatchPackEncodings
} from '../actionBatchPack'
import { actionBatchBlobDigest } from '../actionBatchDigest'

function item (bytes: Uint8Array): { digest: string, bytes: Uint8Array } {
  return { digest: actionBatchBlobDigest(bytes), bytes }
}

describe('action batch pack transport', () => {
  const maxBytes = 2 * 1024 * 1024
  const maxItems = 16
  const repetitive = Uint8Array.from(
    { length: 512 * 1024 },
    (_, index) => index % 37
  )
  const items = [
    item(repetitive),
    item(Uint8Array.from({ length: 4096 }, (_, index) => index & 0xff))
  ]

  test('round-trips a bounded frame with zero-copy item views', () => {
    const encoded = encodeActionBatchPack(items, maxBytes, maxItems)
    expect(encoded).toHaveLength(actionBatchPackLength(items))

    const decoded = decodeActionBatchPack(encoded, maxBytes, maxItems)
    expect(decoded.map(value => value.digest)).toEqual(items.map(value => value.digest))
    expect(decoded.map(value => Array.from(value.bytes))).toEqual(items.map(value => Array.from(value.bytes)))
    expect(decoded.every(value => value.bytes.buffer === encoded.buffer)).toBe(true)
  })

  test.each(supportedActionBatchPackEncodings())(
    'round-trips the %s transport encoding',
    async encoding => {
      const encoded = encodeActionBatchPack(items, maxBytes, maxItems)
      const compressed = await compressActionBatchPack(encoded, encoding)
      const decoded = await decompressActionBatchPack(compressed, encoding, maxBytes)
      expect(decoded).toEqual(encoded)
      const streamed = await compressActionBatchPackItems(
        items,
        encoding,
        maxBytes,
        maxItems
      )
      expect(await decompressActionBatchPack(streamed, encoding, maxBytes)).toEqual(encoded)
      if (encoding !== 'identity') expect(compressed.length).toBeLessThan(encoded.length)
    }
  )

  test('rejects malformed, truncated, oversized, and trailing frames', () => {
    const encoded = encodeActionBatchPack(items, maxBytes, maxItems)
    expect(() => decodeActionBatchPack(encoded.subarray(0, encoded.length - 1), maxBytes, maxItems))
      .toThrow('complete item bytes')
    expect(() => decodeActionBatchPack(
      Uint8Array.from([...encoded, 0]),
      maxBytes + 1,
      maxItems
    )).toThrow('no trailing bytes')
    expect(() => decodeActionBatchPack(encoded, encoded.length - 1, maxItems))
      .toThrow('bounded action batch pack')
    expect(() => encodeActionBatchPack([], maxBytes, maxItems))
      .toThrow('between 1 and')
    expect(() => encodeActionBatchPack([
      { digest: '00', bytes: new Uint8Array() }
    ], maxBytes, maxItems)).toThrow('32-byte hexadecimal')
  })

  test('bounds decompressed bytes before parsing a compression bomb', async () => {
    const encoded = encodeActionBatchPack(items, maxBytes, maxItems)
    const compressed = await compressActionBatchPack(encoded, 'gzip')
    await expect(decompressActionBatchPack(
      compressed,
      'gzip',
      Math.floor(encoded.length / 2)
    )).rejects.toThrow('decompressed provider limit')
  })
})
