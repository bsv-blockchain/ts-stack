import { detach } from './CanonicalPortableValue'
import { parts } from './CanonicalPortableParts'

export interface CanonicalPortableChunkOptions {
  /** Allocation charge for one detached value, not the whole wallet. */
  maximumValueBytes: number
  /** A bounded output buffer; defaults to 65,536 bytes. */
  maximumChunkBytes?: number
  signal?: AbortSignal
}
/** Serialization of ONE bounded, detached portable value. This does
 * not capture a coherent source, establish table closure, normalize stored
 * histories, stream native blobs or produce a complete BRC-38 archive alone.
 * No full escaped string or document byte array is retained. Callers must not
 * publish partially consumed output as a completed archive.
 */
export function* canonicalPortableChunks(
  input: unknown,
  options: CanonicalPortableChunkOptions
): Generator<Uint8Array> {
  const { maximumValueBytes, maximumChunkBytes = 65536, signal } = options
  if (!Number.isSafeInteger(maximumValueBytes) || maximumValueBytes < 1 || maximumValueBytes > 16777216)
    throw new RangeError('maximumValueBytes must be an integer from 1 to 16777216')
  if (!Number.isSafeInteger(maximumChunkBytes) || maximumChunkBytes < 64 || maximumChunkBytes > 65536)
    throw new RangeError('maximumChunkBytes must be an integer from 64 to 65536')
  const value = detach(input, 0, { remaining: maximumValueBytes, active: new Set(), signal }).value
  const encoder = new TextEncoder()
  let buffer = new Uint8Array(maximumChunkBytes),
    used = 0
  for (const part of parts(value, Math.floor(maximumChunkBytes / 6) - 1)) {
    signal?.throwIfAborted()
    const bytes = encoder.encode(part)
    let offset = 0
    while (offset < bytes.length) {
      const count = Math.min(bytes.length - offset, maximumChunkBytes - used)
      buffer.set(bytes.subarray(offset, offset + count), used)
      used += count
      offset += count
      if (used === maximumChunkBytes) {
        yield buffer
        signal?.throwIfAborted()
        buffer = new Uint8Array(maximumChunkBytes)
        used = 0
      }
    }
  }
  signal?.throwIfAborted()
  if (used !== 0) yield buffer.slice(0, used)
}
