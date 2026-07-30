/**
 * Wire constants for the air-gap transport.
 *
 * Everything here is part of the wire contract except `DEFAULT_BLOCK_BYTES`,
 * which is only a sensible starting point: the block size is *not* carried in
 * the header, so each application is free to trade symbol density against part
 * count. Deliberately absent is any notion of display cadence — how fast parts
 * are rendered is the application's business, not the transport's.
 */

/** ASCII prefix every wire part starts with. */
export const AIR_GAP_PREFIX = 'air-gap:'

/**
 * Default source-block size in bytes.
 *
 * A 1,200-byte block yields a 1,214-byte part, which is 1,619 unpadded
 * base64url characters plus the 8-character prefix — comfortably inside the
 * alphanumeric capacity of a version-40 QR symbol at low error correction,
 * with margin for a scanner that is not looking at the screen straight on.
 */
export const DEFAULT_BLOCK_BYTES = 1200

/**
 * Sanity ceiling on a whole message.
 *
 * At five parts per second with 1,200-byte blocks, 64 KiB is roughly 55 source
 * blocks — some 15 to 30 seconds of two people holding phones together, which
 * is already the practical limit of the medium. A larger payload means the
 * layer above should be sending a reference rather than the bytes themselves.
 */
export const MAX_MESSAGE_BYTES = 65536

/** Fixed header size in bytes: `seq` u32 ‖ `K` u16 ‖ `msgLen` u32 ‖ `crc32` u32. */
export const HEADER_BYTES = 14

/**
 * Largest source-block count the header can express, since `K` is a u16.
 *
 * Reachable only with a pathologically small `blockBytes`; the encoder rejects
 * such a configuration rather than silently truncating `K` on the wire.
 */
export const MAX_BLOCK_COUNT = 0xffff

/** Exclusive upper bound on `seq`, which the header carries as a u32. */
export const MAX_SEQ_EXCLUSIVE = 2 ** 32
