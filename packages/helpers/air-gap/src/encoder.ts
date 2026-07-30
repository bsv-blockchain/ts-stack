import { toB64url } from './base64url'
import { blocksForPart, xorInto } from './coding'
import {
  AIR_GAP_PREFIX,
  DEFAULT_BLOCK_BYTES,
  HEADER_BYTES,
  MAX_BLOCK_COUNT,
  MAX_MESSAGE_BYTES,
  MAX_SEQ_EXCLUSIVE
} from './constants'
import { crc32 } from './crc32'
import { AirGapError } from './errors'

/**
 * Turns one message into an endless, deterministic sequence of wire parts.
 *
 * An encoder is immutable and holds no cursor: `partAt(seq)` is a pure function
 * of `(message, blockBytes, seq)`. The caller owns the sequence number and the
 * cadence, which is what lets a static single-part display, a 5 fps animation
 * and a frozen conformance vector all be the same code path.
 *
 * @example
 * ```ts
 * const encoder = new AirGapEncoder(payload)
 * let seq = 0
 * setInterval(() => render(encoder.partAt(seq++)), 200) // the app owns timing
 * ```
 */
export class AirGapEncoder {
  /** Views into one zero-padded backing buffer, `blockBytes` each. */
  private readonly blocks: readonly Uint8Array[]
  private readonly crc: number

  /** Source block count, `ceil(messageLength / blockBytes)`. Sent as `K`. */
  readonly blockCount: number
  /** Bytes per source block, and therefore per part payload. */
  readonly blockBytes: number
  /** Length of the original message in bytes. */
  readonly messageLength: number

  /**
   * @param message - The bytes to transmit. Copied, so later mutation by the
   *   caller cannot break the determinism contract.
   * @param blockBytes - Payload bytes per part. Not carried on the wire; pick
   *   it from the symbol capacity the receiving camera can actually resolve.
   * @throws {AirGapError} when `message` is empty or larger than
   *   {@link MAX_MESSAGE_BYTES}, or when `blockBytes` is not a positive integer
   *   or would need more than 65,535 source blocks.
   */
  constructor(message: Uint8Array, blockBytes: number = DEFAULT_BLOCK_BYTES) {
    if (message.length === 0) throw new AirGapError('cannot encode an empty message')
    if (message.length > MAX_MESSAGE_BYTES) {
      throw new AirGapError(
        `message of ${message.length} bytes exceeds the ${MAX_MESSAGE_BYTES}-byte maximum`
      )
    }
    if (!Number.isInteger(blockBytes) || blockBytes < 1) {
      throw new AirGapError(`blockBytes must be a positive integer, received ${blockBytes}`)
    }
    const blockCount = Math.ceil(message.length / blockBytes)
    if (blockCount > MAX_BLOCK_COUNT) {
      throw new AirGapError(
        `blockBytes of ${blockBytes} needs ${blockCount} blocks, over the ${MAX_BLOCK_COUNT} the header can carry`
      )
    }
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

  /**
   * Part `seq`, ready to render.
   *
   * `seq < blockCount` returns source block `seq` verbatim — the systematic
   * prefix, so an unlucky-free receiver finishes in exactly `blockCount` reads.
   * Past that, parts are XOR mixes and are interchangeable: any `blockCount + ε`
   * distinct parts reconstruct the message, so `seq` may grow without bound and
   * a missed frame costs almost nothing.
   *
   * @throws {AirGapError} when `seq` is not a u32.
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
    view.setUint32(0, seq)
    view.setUint16(4, k)
    view.setUint32(6, this.messageLength)
    view.setUint32(10, this.crc)
    return AIR_GAP_PREFIX + toB64url(out)
  }
}
