import { utf16CodeUnitAt } from '../../utility/utf16CodeUnitAt'
import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

/** Strict streaming UTF-8 -> UTF-16LE storage bytes. No complete string/array is
 * retained. Input chunks and transferred output belong to the caller; the
 * caller must dispose transferred output after consumption. Encoding is DATA,
 * never JSON/source/semantic admission. The same original counter covers the
 * decoder string, one input window and the fixed output/copy window. */
export async function* brc38Utf16Chunks(
  source: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  selectedWorking: Brc38WorkingAllocation,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  const working = brc38WorkingAllocation(selectedWorking)
  if (working === undefined || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 1000000000)
    throw new RangeError('Invalid original UTF-16 staging resource admission')
  signal?.throwIfAborted()
  const allowance = working.claim(8192 + 12 * 65536),
    decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let buffer: Uint8Array | undefined,
    owned = true,
    used = 0,
    total = 0
  async function* append(text: string): AsyncGenerator<Uint8Array> {
    if (text.length > Math.floor((maximumBytes - total) / 2))
      throw new SnapshotResourceLimitError('UTF-16 staged text exceeds its original byte ceiling')
    total += 2 * text.length
    for (let index = 0; index < text.length; index++) {
      signal?.throwIfAborted()
      const unit = utf16CodeUnitAt(text, index)
      buffer![used++] = unit & 255
      buffer![used++] = unit >>> 8
      if (used === 65536) {
        owned = false
        yield Promise.resolve(buffer!)
        buffer = new Uint8Array(65536)
        owned = true
        used = 0
      }
    }
  }
  try {
    buffer = new Uint8Array(65536)
    for await (const bytes of source) {
      signal?.throwIfAborted()
      if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 65536)
        throw new RangeError('UTF-16 staging input exceeds its original window')
      yield* append(decoder.decode(bytes, { stream: true }))
    }
    yield* append(decoder.decode())
    signal?.throwIfAborted()
    if (used !== 0) yield buffer.slice(0, used)
  } finally {
    if (owned) buffer?.fill(0)
    allowance.close()
  }
}
