import { DEFAULTS } from '../types.js'
import { utf8Decode, utf8Encode } from '../util/bytes.js'
import { WebRTPayError } from '../util/errors.js'

/**
 * Data channel frame layout:
 *
 * ```
 * [version u8 = 1][flags u8, bit0 = final][message sequence u32 big-endian][payload]
 * ```
 *
 * Every chunk of one message carries that message's sequence number. A message is the
 * UTF-8 JSON text of one object, split into chunks; the chunk with the final bit set
 * completes it.
 */

/** Bytes before the payload in every frame. */
export const FRAME_HEADER_BYTES = 6

/**
 * Deepest nesting of objects and arrays a received message may have: the number of
 * containers open at once, so `{"a":1}` is 1 and `{"a":[{}]}` is 3. Wire messages are
 * shallow (the spec's deepest is about 5; a payment's transaction is one string). The
 * decoder rejects anything deeper as a `protocol` error before parsing it, because
 * `JSON.parse` spends memory in proportion to depth, not just byte count: a 16 MiB run of
 * `[` and `]` costs over 1 GiB and a second of blocked event loop.
 */
export const MAX_JSON_DEPTH = 32

/**
 * Most structural tokens a received message may have: every `{`, `[`, `,` and `:` outside
 * strings. `JSON.parse` builds at most about one value per token, so this bounds what a
 * message can make the parser allocate to roughly the size of its strings. Width costs
 * memory like depth does: a 16 MiB array of empty objects builds 5.6 million objects (over
 * 300 MiB). Wire messages have a few dozen tokens; a payment's transaction is one string.
 */
export const MAX_JSON_TOKENS = 4096

const FRAME_VERSION = 1
const FLAG_FINAL = 0x01
const MAX_SEQ = 0xffffffff
const EMPTY = new Uint8Array(0)

/**
 * Split one JSON message into frames of at most `chunkBytes` bytes each, header included.
 *
 * Always returns at least one frame; only the last has the final bit, and a payload that
 * is an exact multiple of the chunk size does not get a trailing empty frame. Each frame
 * owns its buffer, so it can be passed to `RTCDataChannel.send` as is. Receivers reject a
 * top-level value that is not a JSON object.
 *
 * @param seq - The message's sequence number (0 for the first message on a channel, then
 * one more for each message), an integer in `[0, 2^32)`.
 * @param json - The message; anything `JSON.stringify` can represent.
 * @param chunkBytes - Largest frame including the 6-byte header; defaults to 16 KiB.
 * @throws `RangeError` for a `seq` or `chunkBytes` out of range and `TypeError` for a
 * value JSON cannot represent. These are caller bugs, not peer input.
 */
export function encodeMessage(
  seq: number,
  json: unknown,
  chunkBytes: number = DEFAULTS.chunkBytes
): Uint8Array[] {
  if (!Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) {
    throw new RangeError(`Invalid message sequence number: ${seq}`)
  }
  if (!Number.isInteger(chunkBytes) || chunkBytes <= FRAME_HEADER_BYTES) {
    throw new RangeError(`Chunk size must leave room for payload: ${chunkBytes}`)
  }
  const text = JSON.stringify(json)
  if (typeof text !== 'string') throw new TypeError('Message is not JSON-serialisable')

  const body = utf8Encode(text)
  const perFrame = chunkBytes - FRAME_HEADER_BYTES
  const count = Math.max(1, Math.ceil(body.length / perFrame))
  const frames: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const start = i * perFrame
    const end = Math.min(start + perFrame, body.length)
    const frame = new Uint8Array(FRAME_HEADER_BYTES + end - start)
    frame[0] = FRAME_VERSION
    frame[1] = i === count - 1 ? FLAG_FINAL : 0
    new DataView(frame.buffer).setUint32(2, seq, false)
    frame.set(body.subarray(start, end), FRAME_HEADER_BYTES)
    frames.push(frame)
  }
  return frames
}

function protocolError(message: string, cause?: unknown): WebRTPayError {
  return new WebRTPayError('protocol', message, cause === undefined ? undefined : { cause })
}

/**
 * Bound what `JSON.parse` may be asked to build, without allocating anything: require a
 * top-level object, no more than {@link MAX_JSON_DEPTH} containers open at once and no more
 * than {@link MAX_JSON_TOKENS} structural tokens (`{`, `[`, `,`, `:`).
 *
 * It tracks string and escape state, so structural characters inside strings do not count,
 * and it works on the raw bytes: every structural character is ASCII, and UTF-8 never uses a
 * byte below 0x80 inside a multi-byte sequence. It validates nothing else; `JSON.parse`
 * still decides whether the text is JSON. On valid JSON the counts are exact, and on invalid
 * JSON they agree with the parser up to the point where the parser gives up, so whatever the
 * parser builds is within the bounds.
 */
function assertBoundedObject(bytes: Uint8Array): void {
  let i = skipJsonWhitespace(bytes)
  if (i === bytes.length || bytes[i] !== 0x7b) throw protocolError('Message is not a JSON object')

  const counts = new StructureCounts()
  while (i < bytes.length) {
    if (bytes[i] === 0x22) {
      i = closingQuote(bytes, i) + 1
    } else {
      counts.add(bytes[i])
      i++
    }
  }
}

/** The index of the first byte that is not JSON whitespace (space, tab, LF, CR), or the length. */
function skipJsonWhitespace(bytes: Uint8Array): number {
  let i = 0
  while (
    i < bytes.length &&
    (bytes[i] === 0x20 || bytes[i] === 0x09 || bytes[i] === 0x0a || bytes[i] === 0x0d)
  ) {
    i++
  }
  return i
}

/**
 * The index of the quote that closes the string opened by the quote at `open`; the length or
 * more when the string never closes. The byte after a backslash is data, even a quote or
 * another backslash.
 */
function closingQuote(bytes: Uint8Array, open: number): number {
  let i = open + 1
  while (i < bytes.length && bytes[i] !== 0x22) {
    i += bytes[i] === 0x5c ? 2 : 1
  }
  return i
}

/** The running counts of {@link assertBoundedObject}, fed every byte outside strings. */
class StructureCounts {
  /** Containers open now. */
  private depth = 0
  /** Structural tokens so far. */
  private tokens = 0

  /**
   * Count byte `b`. An opener is a token first and a container second, so a byte that passes
   * both bounds reports the token bound.
   */
  add(b: number): void {
    if (b === 0x2c || b === 0x3a) {
      this.token()
    } else if (b === 0x7b || b === 0x5b) {
      this.token()
      if (++this.depth > MAX_JSON_DEPTH) {
        throw protocolError(`Message nests deeper than ${MAX_JSON_DEPTH} levels`)
      }
    } else if (b === 0x7d || b === 0x5d) {
      // More closers than openers is never JSON, and must not let the count sink below
      // zero and hide the nesting that follows.
      if (--this.depth < 0) throw protocolError('Message has unbalanced brackets')
    }
  }

  private token(): void {
    if (++this.tokens > MAX_JSON_TOKENS) {
      throw protocolError(`Message has more than ${MAX_JSON_TOKENS} structural tokens`)
    }
  }
}

function checkCap(maxMessageBytes: number): number {
  if (!Number.isSafeInteger(maxMessageBytes) || maxMessageBytes < 0) {
    throw new RangeError(`Invalid message size cap: ${maxMessageBytes}`)
  }
  return maxMessageBytes
}

function parseMessage(bytes: Uint8Array): unknown {
  assertBoundedObject(bytes)
  const text = utf8Decode(bytes)
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    throw protocolError('Message is not valid JSON', cause)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw protocolError('Message is not a JSON object')
  }
  return value
}

/**
 * Reassembles framed messages from one peer, enforcing the wire rules.
 *
 * Feed it every frame received on a channel, in arrival order. Any violation throws a
 * {@link WebRTPayError} and leaves the decoder failed: later `push` calls rethrow the same
 * error, since a stream that lost sync cannot be trusted again. The caller closes the
 * channel.
 */
export class FrameDecoder {
  private maxMessageBytes: number
  /** Sequence number the next frame must carry; advances when a message completes. */
  private nextSeq = 0
  /** Payload bytes of the message in progress: `buffer[0, length)`. */
  private buffer: Uint8Array = EMPTY
  private length = 0
  private failure: WebRTPayError | undefined

  /**
   * @param opts.maxMessageBytes - Largest reassembled message (the JSON text, header
   * bytes excluded) the decoder accepts; a message of exactly this size is accepted.
   */
  constructor(opts: { maxMessageBytes: number }) {
    this.maxMessageBytes = checkCap(opts.maxMessageBytes)
  }

  /**
   * Change the cap for every frame accepted from now on, including the rest of a message
   * in progress: a raised cap lets that message grow to the new size, a lowered one
   * rejects it once its reassembled length passes the new cap. A session raises the cap
   * once its peer is authenticated.
   *
   * @param maxMessageBytes - New largest reassembled message, as for the constructor.
   * @throws `RangeError` for a value that is not a non-negative safe integer.
   */
  setMaxMessageBytes(maxMessageBytes: number): void {
    this.maxMessageBytes = checkCap(maxMessageBytes)
  }

  /**
   * Accept one received frame.
   *
   * @returns The parsed message when this frame completes one; `undefined` when the frame
   * is a chunk of a message still incomplete.
   * @throws `WebRTPayError('protocol')` for a frame shorter than the header, an unknown
   * version or reserved flag bit, a sequence number other than the expected one (first
   * message 0, then +1; every chunk of a message repeats its number), text that is not
   * UTF-8 JSON, a top level that is not an object, objects and arrays nested more than
   * {@link MAX_JSON_DEPTH} deep or more than {@link MAX_JSON_TOKENS} structural tokens (both
   * rejected before parsing). `WebRTPayError('too_large')` when
   * the reassembled message would pass the cap, checked before the frame is buffered.
   */
  push(frame: Uint8Array): unknown {
    if (this.failure) throw this.failure
    try {
      return this.accept(frame)
    } catch (e) {
      this.buffer = EMPTY
      this.length = 0
      this.failure =
        e instanceof WebRTPayError ? e : protocolError('Frame could not be processed', e)
      throw this.failure
    }
  }

  /** {@link push} without the failure latch: the message, or `undefined` mid-message. */
  private accept(input: Uint8Array): unknown {
    if (!ArrayBuffer.isView(input)) throw protocolError('Frame is not binary')
    const frame = new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
    if (frame.length < FRAME_HEADER_BYTES) throw protocolError('Frame shorter than header')
    if (frame[0] !== FRAME_VERSION) throw protocolError(`Unsupported frame version ${frame[0]}`)
    const flags = frame[1]
    if ((flags & ~FLAG_FINAL) !== 0) throw protocolError('Reserved frame flag set')
    const seq = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(2, false)
    if (seq !== this.nextSeq) {
      throw protocolError(`Unexpected message sequence ${seq}, expected ${this.nextSeq}`)
    }

    const payload = frame.subarray(FRAME_HEADER_BYTES)
    if (this.length + payload.length > this.maxMessageBytes) {
      throw new WebRTPayError('too_large', `Message exceeds ${this.maxMessageBytes} bytes`)
    }

    if ((flags & FLAG_FINAL) === 0) {
      this.append(payload)
      return undefined
    }

    // Common case: a message that fits one frame is parsed straight from the frame.
    let bytes = payload
    if (this.length > 0) {
      this.append(payload)
      bytes = this.buffer.subarray(0, this.length)
    }
    this.buffer = EMPTY
    this.length = 0
    const message = parseMessage(bytes)
    this.nextSeq = seq + 1
    return message
  }

  /**
   * Copy `payload` into the growing buffer. One buffer rather than a list of chunks: the
   * cost is bounded by the cap however many frames a peer sends, including empty ones.
   */
  private append(payload: Uint8Array): void {
    const needed = this.length + payload.length
    if (needed > this.buffer.length) {
      const grown = new Uint8Array(
        Math.min(this.maxMessageBytes, Math.max(needed, this.buffer.length * 2))
      )
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    this.buffer.set(payload, this.length)
    this.length = needed
  }
}
