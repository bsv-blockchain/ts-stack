import { Utils } from '@bsv/sdk'
import type {
  ActionBatchPackEncoding,
  ActionBatchPackItem
} from '../sdk/ActionBatch.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../sdk/WERR_errors'
import { asUint8Array } from './utilityHelpers.noBuffer'

const PACK_MAGIC = Uint8Array.of(0x41, 0x42, 0x50, 0x31)
const PACK_HEADER_BYTES = 8
const ITEM_HEADER_BYTES = 36
export const ACTION_BATCH_PACK_ENCODING_HEADER = 'X-BSV-Action-Batch-Encoding'

type ExtendedCompressionStreamConstructor = new (
  format: CompressionFormat | 'brotli'
) => CompressionStream

type ExtendedDecompressionStreamConstructor = new (
  format: CompressionFormat | 'brotli'
) => DecompressionStream

function makeCompressionStream (encoding: Exclude<ActionBatchPackEncoding, 'identity'>): CompressionStream {
  const Constructor = globalThis.CompressionStream as ExtendedCompressionStreamConstructor
  return new Constructor(encoding)
}

function makeDecompressionStream (encoding: Exclude<ActionBatchPackEncoding, 'identity'>): DecompressionStream {
  const Constructor = globalThis.DecompressionStream as ExtendedDecompressionStreamConstructor
  return new Constructor(encoding)
}

function arrayBufferView (bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer
    ? bytes as Uint8Array<ArrayBuffer>
    : Uint8Array.from(bytes)
}

export function actionBatchPackLength (items: ActionBatchPackItem[]): number {
  let length = PACK_HEADER_BYTES
  for (const item of items) {
    length += ITEM_HEADER_BYTES + item.bytes.length
    if (!Number.isSafeInteger(length)) {
      throw new WERR_INVALID_OPERATION('action batch pack exceeds this runtime’s addressable memory')
    }
  }
  return length
}

function validatePackShape (
  items: ActionBatchPackItem[],
  maxBytes: number,
  maxItems: number
): number {
  if (items.length === 0 || items.length > maxItems) {
    throw new WERR_INVALID_PARAMETER('items', `between 1 and ${String(maxItems)} blobs`)
  }
  const length = actionBatchPackLength(items)
  if (length > maxBytes) throw new WERR_INVALID_PARAMETER('items', 'within the provider pack limit')
  return length
}

function packHeader (itemCount: number): Uint8Array {
  const bytes = new Uint8Array(PACK_HEADER_BYTES)
  bytes.set(PACK_MAGIC)
  new DataView(bytes.buffer).setUint32(4, itemCount, true)
  return bytes
}

function packItemHeader (item: ActionBatchPackItem): Uint8Array {
  const digest = Utils.toUint8Array(item.digest, 'hex')
  if (digest.length !== 32) {
    throw new WERR_INVALID_PARAMETER('digest', 'a 32-byte hexadecimal SHA-256 digest')
  }
  const bytes = new Uint8Array(ITEM_HEADER_BYTES)
  bytes.set(digest)
  new DataView(bytes.buffer).setUint32(32, item.bytes.length, true)
  return bytes
}

/** Encode independently content-addressed blobs into one transport frame. */
export function encodeActionBatchPack (
  items: ActionBatchPackItem[],
  maxBytes: number,
  maxItems: number
): Uint8Array {
  const length = validatePackShape(items, maxBytes, maxItems)
  const bytes = new Uint8Array(length)
  bytes.set(packHeader(items.length))
  let offset = PACK_HEADER_BYTES
  for (const item of items) {
    const header = packItemHeader(item)
    const value = asUint8Array(item.bytes)
    bytes.set(header, offset)
    offset += header.length
    bytes.set(value, offset)
    offset += value.length
  }
  return bytes
}

/** Decode a transport frame without copying its individual blob payloads. */
export function decodeActionBatchPack (
  bytes: Uint8Array,
  maxBytes: number,
  maxItems: number
): ActionBatchPackItem[] {
  if (bytes.length < PACK_HEADER_BYTES || bytes.length > maxBytes ||
    !PACK_MAGIC.every((value, index) => bytes[index] === value)) {
    throw new WERR_INVALID_PARAMETER('pack', 'a bounded action batch pack')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const itemCount = view.getUint32(4, true)
  if (itemCount < 1 || itemCount > maxItems) {
    throw new WERR_INVALID_PARAMETER('pack', `between 1 and ${String(maxItems)} blobs`)
  }
  const items: ActionBatchPackItem[] = []
  let offset = PACK_HEADER_BYTES
  for (let index = 0; index < itemCount; index++) {
    if (offset + ITEM_HEADER_BYTES > bytes.length) {
      throw new WERR_INVALID_PARAMETER('pack', 'complete item headers')
    }
    const digest = Utils.toHex(bytes.subarray(offset, offset + 32))
    offset += 32
    const length = view.getUint32(offset, true)
    offset += 4
    if (offset + length > bytes.length) throw new WERR_INVALID_PARAMETER('pack', 'complete item bytes')
    items.push({ digest, bytes: bytes.subarray(offset, offset + length) })
    offset += length
  }
  if (offset !== bytes.length) throw new WERR_INVALID_PARAMETER('pack', 'no trailing bytes')
  return items
}

function supportsTransform (encoding: ActionBatchPackEncoding, decompress: boolean): boolean {
  if (encoding === 'identity') return true
  try {
    if (decompress) {
      if (typeof globalThis.DecompressionStream !== 'function') return false
      makeDecompressionStream(encoding)
    } else {
      if (typeof globalThis.CompressionStream !== 'function') return false
      makeCompressionStream(encoding)
    }
    return true
  } catch {
    return false
  }
}

export function supportedActionBatchPackEncodings (): ActionBatchPackEncoding[] {
  const encodings: ActionBatchPackEncoding[] = []
  // CompressionStream does not expose Brotli quality controls. Its runtime
  // default can favor density at substantially higher latency, so prefer the
  // broadly available low-latency gzip lane unless a caller orders otherwise.
  for (const encoding of ['gzip', 'brotli'] as const) {
    if (supportsTransform(encoding, false) && supportsTransform(encoding, true)) encodings.push(encoding)
  }
  encodings.push('identity')
  return encodings
}

async function collectStream (
  stream: ReadableStream<Uint8Array>,
  maxBytes?: number
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.length
    if (!Number.isSafeInteger(length) || (maxBytes != null && length > maxBytes)) {
      await reader.cancel()
      throw new WERR_INVALID_PARAMETER('pack', 'within the decompressed provider limit')
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

async function transform (
  bytes: Uint8Array,
  encoding: ActionBatchPackEncoding,
  decompress: boolean,
  maxBytes?: number
): Promise<Uint8Array> {
  if (encoding === 'identity') {
    if (maxBytes != null && bytes.length > maxBytes) {
      throw new WERR_INVALID_PARAMETER('pack', 'within the provider limit')
    }
    return bytes
  }
  if (!supportsTransform(encoding, decompress)) {
    throw new WERR_INVALID_OPERATION(`action batch ${encoding} compression is unavailable in this runtime`)
  }
  const codec = decompress
    ? makeDecompressionStream(encoding)
    : makeCompressionStream(encoding)
  const output = collectStream(codec.readable, maxBytes)
  const writer = codec.writable.getWriter()
  const input = (async () => {
    await writer.write(arrayBufferView(bytes))
    await writer.close()
  })()
  const [result] = await Promise.all([output, input])
  return result
}

export async function compressActionBatchPack (
  bytes: Uint8Array,
  encoding: ActionBatchPackEncoding
): Promise<Uint8Array> {
  return await transform(bytes, encoding, false)
}

/**
 * Compress a pack directly from its item views. Successful compression avoids
 * allocating and copying an additional uncompressed aggregate frame.
 */
export async function compressActionBatchPackItems (
  items: ActionBatchPackItem[],
  encoding: ActionBatchPackEncoding,
  maxBytes: number,
  maxItems: number
): Promise<Uint8Array> {
  validatePackShape(items, maxBytes, maxItems)
  if (encoding === 'identity') return encodeActionBatchPack(items, maxBytes, maxItems)
  if (!supportsTransform(encoding, false)) {
    throw new WERR_INVALID_OPERATION(`action batch ${encoding} compression is unavailable in this runtime`)
  }
  const codec = makeCompressionStream(encoding)
  const output = collectStream(codec.readable)
  const writer = codec.writable.getWriter()
  const input = (async () => {
    await writer.write(arrayBufferView(packHeader(items.length)))
    for (const item of items) {
      await writer.write(arrayBufferView(packItemHeader(item)))
      await writer.write(arrayBufferView(asUint8Array(item.bytes)))
    }
    await writer.close()
  })()
  const [result] = await Promise.all([output, input])
  return result
}

export async function decompressActionBatchPack (
  bytes: Uint8Array,
  encoding: ActionBatchPackEncoding,
  maxBytes: number
): Promise<Uint8Array> {
  return await transform(bytes, encoding, true, maxBytes)
}
