import type { Decoder } from 'ts-mls'
import { GroupMessagingError } from '../errors.js'

/**
 * Run a `ts-mls` decoder over a whole buffer.
 *
 * The decoders report how many bytes they consumed; discarding that count
 * silently accepts anything appended after an otherwise valid structure, so
 * this demands the input be consumed exactly.
 *
 * A truncated structure makes `ts-mls` throw its own `CodecError` rather than
 * return `undefined`. Callers here sit on wire input they did not author, so it
 * is translated: every malformed input leaves as a `GroupMessagingError`.
 */
export const decodeExactly = <T>(decoder: Decoder<T>, bytes: Uint8Array, what: string): T => {
  let decoded: ReturnType<Decoder<T>>
  try {
    decoded = decoder(bytes, 0)
  } catch (cause) {
    throw new GroupMessagingError(`Could not decode ${what}`, { cause })
  }
  if (decoded === undefined) throw new GroupMessagingError(`Could not decode ${what}`)
  const [value, consumed] = decoded
  if (consumed !== bytes.length) {
    throw new GroupMessagingError(`${bytes.length - consumed} trailing bytes after ${what}`)
  }
  return value
}
