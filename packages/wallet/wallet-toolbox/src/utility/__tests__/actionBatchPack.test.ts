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

function item(bytes: Uint8Array): { digest: string; bytes: Uint8Array } {
  return { digest: actionBatchBlobDigest(bytes), bytes }
}

function expectInvalidParameter(operation: () => unknown, parameter: string, mustBe: string): void {
  try {
    operation()
    throw new Error('Expected operation to reject an invalid parameter')
  } catch (error) {
    expect(error).toMatchObject({
      name: 'WERR_INVALID_PARAMETER',
      parameter,
      message: `The ${parameter} parameter must be ${mustBe}`
    })
  }
}

function setTransformConstructors(compression: unknown, decompression: unknown): void {
  Object.defineProperty(globalThis, 'CompressionStream', {
    configurable: true,
    writable: true,
    value: compression
  })
  Object.defineProperty(globalThis, 'DecompressionStream', {
    configurable: true,
    writable: true,
    value: decompression
  })
}

describe('action batch pack transport', () => {
  const maxBytes = 2 * 1024 * 1024
  const maxItems = 16
  const repetitive = Uint8Array.from({ length: 512 * 1024 }, (_, index) => index % 37)
  const items = [item(repetitive), item(Uint8Array.from({ length: 4096 }, (_, index) => index & 0xff))]

  test('round-trips a bounded frame with zero-copy item views', () => {
    const encoded = encodeActionBatchPack(items, maxBytes, maxItems)
    expect(encoded).toHaveLength(actionBatchPackLength(items))

    const decoded = decodeActionBatchPack(encoded, maxBytes, maxItems)
    expect(decoded.map(value => value.digest)).toEqual(items.map(value => value.digest))
    expect(decoded.map(value => Array.from(value.bytes))).toEqual(items.map(value => Array.from(value.bytes)))
    expect(decoded.every(value => value.bytes.buffer === encoded.buffer)).toBe(true)
  })

  test.each(supportedActionBatchPackEncodings())('round-trips the %s transport encoding', async encoding => {
    const encoded = encodeActionBatchPack(items, maxBytes, maxItems)
    const compressed = await compressActionBatchPack(encoded, encoding)
    const decoded = await decompressActionBatchPack(compressed, encoding, maxBytes)
    expect(decoded).toEqual(encoded)
    const streamed = await compressActionBatchPackItems(items, encoding, maxBytes, maxItems)
    expect(await decompressActionBatchPack(streamed, encoding, maxBytes)).toEqual(encoded)
    if (encoding !== 'identity') expect(compressed.length).toBeLessThan(encoded.length)
  })

  test('rejects malformed, truncated, oversized, and trailing frames', () => {
    const encoded = encodeActionBatchPack(items, maxBytes, maxItems)
    expectInvalidParameter(
      () => decodeActionBatchPack(encoded.subarray(0, encoded.length - 1), maxBytes, maxItems),
      'pack',
      'complete item bytes'
    )
    expectInvalidParameter(
      () => decodeActionBatchPack(Uint8Array.from([...encoded, 0]), maxBytes + 1, maxItems),
      'pack',
      'no trailing bytes'
    )
    expectInvalidParameter(
      () => decodeActionBatchPack(encoded, encoded.length - 1, maxItems),
      'pack',
      'a bounded action batch pack'
    )
    expectInvalidParameter(
      () => decodeActionBatchPack(encoded.subarray(0, 7), maxBytes, maxItems),
      'pack',
      'a bounded action batch pack'
    )
    expectInvalidParameter(
      () => encodeActionBatchPack([], maxBytes, maxItems),
      'items',
      `between 1 and ${String(maxItems)} blobs`
    )
    expectInvalidParameter(
      () => encodeActionBatchPack([item(Uint8Array.of(1))], maxBytes, 0),
      'items',
      'between 1 and 0 blobs'
    )
    const oneItem = [item(Uint8Array.of(1))]
    expectInvalidParameter(
      () => encodeActionBatchPack(oneItem, actionBatchPackLength(oneItem) - 1, maxItems),
      'items',
      'within the provider pack limit'
    )
    expectInvalidParameter(
      () => encodeActionBatchPack([{ digest: '00', bytes: new Uint8Array() }], maxBytes, maxItems),
      'digest',
      'a 32-byte hexadecimal SHA-256 digest'
    )

    const wrongMagic = encoded.slice()
    wrongMagic[0] ^= 0xff
    expectInvalidParameter(
      () => decodeActionBatchPack(wrongMagic, maxBytes, maxItems),
      'pack',
      'a bounded action batch pack'
    )

    const zeroItems = encoded.slice(0, 8)
    new DataView(zeroItems.buffer).setUint32(4, 0, true)
    expectInvalidParameter(
      () => decodeActionBatchPack(zeroItems, maxBytes, maxItems),
      'pack',
      `between 1 and ${String(maxItems)} blobs`
    )

    const tooManyItems = encoded.slice(0, 8)
    new DataView(tooManyItems.buffer).setUint32(4, maxItems + 1, true)
    expectInvalidParameter(
      () => decodeActionBatchPack(tooManyItems, maxBytes, maxItems),
      'pack',
      `between 1 and ${String(maxItems)} blobs`
    )

    const missingItemHeader = encoded.slice(0, 8)
    new DataView(missingItemHeader.buffer).setUint32(4, 1, true)
    expectInvalidParameter(
      () => decodeActionBatchPack(missingItemHeader, maxBytes, maxItems),
      'pack',
      'complete item headers'
    )
  })

  test('reports only encodings with both transform directions available', () => {
    const compressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CompressionStream')
    const decompressionDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'DecompressionStream')
    class AvailableTransform {
      constructor(_format: string) {}
    }
    class UnavailableTransform {
      constructor(_format: string) {
        throw new Error('unsupported transform')
      }
    }

    try {
      setTransformConstructors(undefined, AvailableTransform)
      expect(supportedActionBatchPackEncodings()).toEqual(['identity'])

      setTransformConstructors(AvailableTransform, undefined)
      expect(supportedActionBatchPackEncodings()).toEqual(['identity'])

      setTransformConstructors(UnavailableTransform, AvailableTransform)
      expect(supportedActionBatchPackEncodings()).toEqual(['identity'])

      setTransformConstructors(AvailableTransform, UnavailableTransform)
      expect(supportedActionBatchPackEncodings()).toEqual(['identity'])

      setTransformConstructors(AvailableTransform, AvailableTransform)
      expect(supportedActionBatchPackEncodings()).toEqual(['gzip', 'brotli', 'identity'])
    } finally {
      if (compressionDescriptor === undefined) delete (globalThis as Partial<typeof globalThis>).CompressionStream
      else Object.defineProperty(globalThis, 'CompressionStream', compressionDescriptor)
      if (decompressionDescriptor === undefined) delete (globalThis as Partial<typeof globalThis>).DecompressionStream
      else Object.defineProperty(globalThis, 'DecompressionStream', decompressionDescriptor)
    }
  })

  test('rejects a mathematically unaddressable aggregate before allocation', () => {
    const impossible = [
      {
        digest: '00'.repeat(32),
        bytes: { length: Number.MAX_SAFE_INTEGER } as Uint8Array
      }
    ]
    expect(() => actionBatchPackLength(impossible)).toThrow('addressable memory')
  })

  test('bounds decompressed bytes before parsing a compression bomb', async () => {
    const encoded = encodeActionBatchPack(items, maxBytes, maxItems)
    const compressed = await compressActionBatchPack(encoded, 'gzip')
    await expect(decompressActionBatchPack(compressed, 'gzip', Math.floor(encoded.length / 2))).rejects.toThrow(
      'decompressed provider limit'
    )
  })
})
