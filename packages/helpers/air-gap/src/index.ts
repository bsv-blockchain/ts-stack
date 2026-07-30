/**
 * `@bsv/air-gap` — one-directional optical air-gap transport.
 *
 * Encodes arbitrary bytes as a deterministic, endless sequence of fountain-coded
 * parts for display as QR codes (or any optical channel), and reassembles them
 * from a camera feed with no back-channel of any kind.
 *
 * The transport is payload-agnostic and stops at the byte array: rendering,
 * scanning, display cadence and payload semantics all belong to the layer above.
 *
 * @packageDocumentation
 */

export { AIR_GAP_PREFIX, DEFAULT_BLOCK_BYTES, MAX_MESSAGE_BYTES } from './constants'
export { AirGapError } from './errors'
export { crc32 } from './crc32'
export { AirGapEncoder } from './encoder'
export { AirGapDecoder, type AirGapProgress } from './decoder'
export { estimatePartCharLength, isAirGapPart } from './helpers'
