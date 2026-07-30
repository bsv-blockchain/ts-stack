import { AIR_GAP_PREFIX, DEFAULT_BLOCK_BYTES, HEADER_BYTES } from './constants'
import { AirGapError } from './errors'

/**
 * Whether `text` looks like an air-gap part.
 *
 * A prefix test and nothing more — cheap enough to run on every barcode a
 * camera reports, so a scanner can route reads without paying for base64
 * decoding. Say nothing about whether the part is well formed; only
 * {@link AirGapDecoder.accept} can answer that.
 */
export function isAirGapPart(text: string): boolean {
  return typeof text === 'string' && text.startsWith(AIR_GAP_PREFIX)
}

/**
 * Exact character length of every part produced for a given `blockBytes`.
 *
 * All parts are the same length by construction — the header is fixed and the
 * last source block is zero-padded — so this is a sizing aid for choosing
 * `blockBytes` against a QR version's alphanumeric capacity *before* building
 * an encoder, not an estimate that needs a safety margin.
 *
 * @throws {AirGapError} when `blockBytes` is not a positive integer.
 */
export function estimatePartCharLength(blockBytes: number = DEFAULT_BLOCK_BYTES): number {
  if (!Number.isInteger(blockBytes) || blockBytes < 1) {
    throw new AirGapError(`blockBytes must be a positive integer, received ${blockBytes}`)
  }
  const bytes = HEADER_BYTES + blockBytes
  const remainder = bytes % 3
  // Unpadded base64url: 4 characters per whole 3-byte group, then one character
  // per 6 bits of the tail (2 for 1 byte, 3 for 2 bytes).
  const body = Math.floor(bytes / 3) * 4 + (remainder === 0 ? 0 : remainder + 1)
  return AIR_GAP_PREFIX.length + body
}
