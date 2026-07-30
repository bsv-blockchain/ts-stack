import { toB64url } from './base64url'
import { blocksForPart, xorInto } from './coding'
import {
  AIR_GAP_PREFIX,
  AIR_GAP_WIRE_VERSION,
  DEFAULT_BLOCK_BYTES,
  HEADER_BYTES,
  MAX_BLOCK_BYTES,
  MAX_BLOCK_COUNT,
  MAX_MESSAGE_BYTES,
  MAX_SEQ_EXCLUSIVE,
  SESSION_ID_BYTES
} from './constants'
import { crc32 } from './crc32'
import { AirGapError } from './errors'

/** Construction options for {@link AirGapEncoder}. */
export interface AirGapEncoderOptions {
  /**
   * Payload bytes per part, `1..MAX_BLOCK_BYTES`. Not carried on the wire;
   * pick it from the byte-mode capacity of the symbol the receiving camera
   * can actually resolve. Defaults to {@link DEFAULT_BLOCK_BYTES}.
   */
  blockBytes?: number
  /**
   * Exactly {@link SESSION_ID_BYTES} bytes naming this encoder's stream on
   * the wire. Defaults to fresh random bytes, so two encoders — even of the
   * same message — are distinct sessions to a decoder. Pass an explicit value
   * to make part strings fully deterministic (conformance vectors do), or to
   * resume the same session across encoder instances.
   */
  sessionId?: Uint8Array
}

/**
 * Turns one message into a deterministic sequence of wire parts.
 *
 * An encoder is immutable and holds no cursor: `partAt(seq)` is a pure function
 * of `(message, blockBytes, sessionId, seq)`. The caller owns the sequence
 * number and the cadence, which is what lets a static single-part display, a
 * 5 fps animation and a frozen conformance vector all be the same code path.
 *
 * Senders SHOULD keep looping `seq` (wrapping back to 0 well before the u32
 * ceiling) until the receiver signals success out of band: recovery is
 * probabilistic, and the repeating systematic prefix is what guarantees every
 * receiver eventually finishes.
 *
 * @example
 * ```ts
 * const encoder = new AirGapEncoder(payload)
 * let seq = 0
 * setInterval(() => {
 *   render(encoder.partAt(seq))
 *   seq = (seq + 1) % (encoder.blockCount * 64) // the app owns timing & wrap
 * }, 200)
 * ```
 */
export class AirGapEncoder {
  /** Views into one zero-padded backing buffer, `blockBytes` each. */
  private readonly blocks: readonly Uint8Array[]
  private readonly crc: number
  private readonly session: Uint8Array

  /** Source block count, `ceil(messageLength / blockBytes)`. Sent as `K`. */
  readonly blockCount: number
  /** Bytes per source block, and therefore per part payload. */
  readonly blockBytes: number
  /** Length of the original message in bytes. */
  readonly messageLength: number

  /**
   * @param message - The bytes to transmit. Copied, so later mutation by the
   *   caller cannot break the determinism contract.
   * @param options - Block size and session identity; see
   *   {@link AirGapEncoderOptions}.
   * @throws {AirGapError} when `message` is empty or larger than
   *   {@link MAX_MESSAGE_BYTES}; when `blockBytes` is not an integer in
   *   `1..MAX_BLOCK_BYTES` or would need more than 65,535 source blocks; or
   *   when `sessionId` is not exactly {@link SESSION_ID_BYTES} bytes.
   */
  constructor(message: Uint8Array, options: AirGapEncoderOptions = {}) {
    const blockBytes = options.blockBytes ?? DEFAULT_BLOCK_BYTES
    if (message.length === 0) throw new AirGapError('cannot encode an empty message')
    if (message.length > MAX_MESSAGE_BYTES) {
      throw new AirGapError(
        `message of ${message.length} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte maximum`
      )
    }
    if (!Number.isInteger(blockBytes) || blockBytes < 1 || blockBytes > MAX_BLOCK_BYTES) {
      throw new AirGapError(
        `blockBytes must be an integer between 1 and ${MAX_BLOCK_BYTES}, received ${blockBytes}`
      )
    }
    const blockCount = Math.ceil(message.length / blockBytes)
    if (blockCount > MAX_BLOCK_COUNT) {
      throw new AirGapError(
        `blockBytes of ${blockBytes} needs ${blockCount} blocks, over the ${MAX_BLOCK_COUNT} the header can carry`
      )
    }
    if (options.sessionId !== undefined && options.sessionId.length !== SESSION_ID_BYTES) {
      throw new AirGapError(
        `sessionId must be exactly ${SESSION_ID_BYTES} bytes, received ${options.sessionId.length}`
      )
    }
    this.session =
      options.sessionId === undefined
        ? globalThis.crypto.getRandomValues(new Uint8Array(SESSION_ID_BYTES))
        : options.sessionId.slice()
    this.messageLength = message.length
    this.blockBytes = blockBytes
    this.blockCount = blockCount
    this.crc = crc32(message)
    // One allocation: `set` copies the message in and leaves the tail of the
    // last block zeroed, which is exactly the padding the wire format wants.
    const padded = new Uint8Array(blockCount * blockBytes)
    padded.set(message)
    this.blocks = Array.from({ length: blockCount }, (_, i) =>
      padded.subarray(i * blockBytes, (i + 1) * blockBytes)
    )
  }

  /** A copy of the 8-byte session identity every part of this encoder carries. */
  get sessionId(): Uint8Array {
    return this.session.slice()
  }

  /**
   * Part `seq`, ready to render.
   *
   * `seq < blockCount` returns source block `seq` verbatim — the systematic
   * prefix, so a receiver that catches one clean cycle finishes in exactly
   * `blockCount` reads. Past that, parts are XOR mixes and are interchangeable
   * *with high probability*: distinct mixes can be linearly dependent, so
   * `blockCount + ε` distinct parts complete the message almost always but not
   * with certainty (see the recovery-overhead table in the spec). A receiver
   * simply keeps scanning; a sender that loops back through the systematic
   * prefix makes eventual recovery deterministic.
   *
   * @throws {AirGapError} when `seq` is not a u32 — the header's `seq` field
   *   is finite, not unbounded.
   */
  partAt(seq: number): string {
    if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_SEQ_EXCLUSIVE) {
      throw new AirGapError(`part sequence must be a 32-bit unsigned integer, received ${seq}`)
    }
    const k = this.blockCount
    const out = new Uint8Array(HEADER_BYTES + this.blockBytes)
    // Mix straight into the output buffer; a part is header ‖ payload and the
    // payload never needs to exist on its own.
    const payload = out.subarray(HEADER_BYTES)
    if (seq < k) payload.set(this.blocks[seq])
    else for (const index of blocksForPart(seq, k)) xorInto(payload, this.blocks[index])
    const view = new DataView(out.buffer)
    view.setUint8(0, AIR_GAP_WIRE_VERSION)
    out.set(this.session, 1)
    view.setUint32(9, seq)
    view.setUint16(13, k)
    view.setUint32(15, this.messageLength)
    view.setUint32(19, this.crc)
    return AIR_GAP_PREFIX + toB64url(out)
  }
}
