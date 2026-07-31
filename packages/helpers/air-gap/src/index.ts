/**
 * `@bsv/air-gap` — one-directional optical air-gap transport.
 *
 * Encodes arbitrary bytes as a deterministic sequence of fountain-coded parts
 * for display as QR codes (or any optical channel), and reassembles them from
 * a camera feed with no back-channel of any kind.
 *
 * The transport is payload-agnostic and stops at the byte array: rendering,
 * scanning, display cadence and payload semantics all belong to the layer
 * above. Wire protocol version 1 is specified in
 * `specs/transport/air-gap-optical.md` (BRC-141), with implementation-neutral
 * fixtures under `conformance/vectors/transport/`.
 *
 * @packageDocumentation
 */

export {
  AIR_GAP_PREFIX,
  AIR_GAP_WIRE_VERSION,
  DEFAULT_BLOCK_BYTES,
  MAX_BLOCK_BYTES,
  MAX_MESSAGE_BYTES,
  SESSION_ID_BYTES,
  SESSION_SWITCH_PARTS
} from './constants'
export { AirGapError } from './errors'
export { crc32 } from './crc32'
export { AirGapEncoder, type AirGapEncoderOptions } from './encoder'
export { AirGapDecoder, type AirGapProgress } from './decoder'
export { estimatePartCharLength, isAirGapPart } from './helpers'
