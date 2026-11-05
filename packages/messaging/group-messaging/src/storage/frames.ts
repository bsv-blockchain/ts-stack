import { concat } from '../bytes.js'
import { GroupMessagingError } from '../errors.js'

export class FramingError extends GroupMessagingError {
  override name = 'FramingError'
}

/**
 * Pack a list of byte strings into one value, so an ordered queue can live in a
 * store that only understands single values.
 *
 * Each frame is a big-endian u32 length followed by its bytes.
 */
export const encodeFrames = (frames: readonly Uint8Array[]): Uint8Array => {
  const parts: Uint8Array[] = []
  for (const frame of frames) {
    const header = new Uint8Array(4)
    new DataView(header.buffer).setUint32(0, frame.length, false)
    parts.push(header, frame)
  }
  return concat(...parts)
}

export const decodeFrames = (bytes: Uint8Array | undefined): Uint8Array[] => {
  if (bytes === undefined || bytes.length === 0) return []
  const frames: Uint8Array[] = []
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 0
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new FramingError('Truncated frame header')
    const length = view.getUint32(offset, false)
    offset += 4
    if (offset + length > bytes.length) throw new FramingError('Truncated frame body')
    frames.push(bytes.slice(offset, offset + length))
    offset += length
  }
  return frames
}
