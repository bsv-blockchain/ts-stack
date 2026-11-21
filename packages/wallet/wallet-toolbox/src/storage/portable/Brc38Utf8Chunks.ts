import { brc38WorkingAllocation, type Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

/** Bounded UTF-16LE -> UTF-8, with the established TextEncoder replacement
 * semantics for unpaired surrogates. A BOM is ordinary content. Input windows
 * may split a code unit or surrogate pair. The consumer owns yielded bytes;
 * this component retains no complete string, field or output queue. */
export async function* brc38Utf8Chunks(
  source: AsyncIterable<Uint8Array>,
  maximumBytes: number,
  selectedWorking: Brc38WorkingAllocation,
  signal?: AbortSignal
): AsyncGenerator<Uint8Array> {
  const working = brc38WorkingAllocation(selectedWorking)
  if (working === undefined || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > 1000000000)
    throw new RangeError('Invalid original UTF-8 staging resource admission')
  signal?.throwIfAborted()
  const allowance = working.claim(8192 + 4 * 65536)
  let buffer: Uint8Array | undefined,
    used = 0,
    total = 0,
    low: number | undefined,
    high: number | undefined
  function append(point: number): Uint8Array | undefined {
    const length = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4
    if (length > maximumBytes - total)
      throw new SnapshotResourceLimitError('UTF-8 staged text exceeds its original byte ceiling')
    let previous: Uint8Array | undefined
    if (used + length > 65536) {
      previous = buffer!.subarray(0, used)
      buffer = new Uint8Array(65536)
      used = 0
    }
    if (length === 1) buffer![used++] = point
    else {
      buffer![used++] = (length === 2 ? 0xc0 : length === 3 ? 0xe0 : 0xf0) | (point >>> (6 * (length - 1)))
      for (let shift = 6 * (length - 2); shift >= 0; shift -= 6) buffer![used++] = 0x80 | ((point >>> shift) & 0x3f)
    }
    total += length
    return previous
  }
  try {
    buffer = new Uint8Array(65536)
    for await (const bytes of source) {
      signal?.throwIfAborted()
      if (!(bytes instanceof Uint8Array) || bytes.length < 1 || bytes.length > 65536)
        throw new RangeError('UTF-8 staging input exceeds its original window')
      for (const byte of bytes) {
        signal?.throwIfAborted()
        if (low === undefined) low = byte
        else {
          const value = low | (byte << 8)
          low = undefined
          if (high !== undefined) {
            const previous = high
            high = undefined
            if (value >= 0xdc00 && value <= 0xdfff) {
              const output = append(0x10000 + (previous - 0xd800) * 0x400 + value - 0xdc00)
              if (output !== undefined) yield output
              continue
            }
            const output = append(0xfffd)
            if (output !== undefined) yield output
          }
          if (value >= 0xd800 && value <= 0xdbff) high = value
          else {
            const output = append(value >= 0xdc00 && value <= 0xdfff ? 0xfffd : value)
            if (output !== undefined) yield output
          }
        }
      }
    }
    if (low !== undefined) throw new TypeError('UTF-16 source ended inside a code unit')
    if (high !== undefined) {
      high = undefined
      const output = append(0xfffd)
      if (output !== undefined) yield output
    }
    signal?.throwIfAborted()
    if (used !== 0) yield buffer!.slice(0, used)
  } finally {
    buffer?.fill(0)
    allowance.close()
  }
}
