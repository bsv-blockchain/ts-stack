/**
 * Wire constants for the air-gap transport, protocol version 1.
 *
 * Everything here is part of the wire contract except `DEFAULT_BLOCK_BYTES`,
 * which is only a sensible starting point: the block size is *not* carried in
 * the header, so each application is free to trade symbol density against part
 * count within the `MAX_BLOCK_BYTES` ceiling. Deliberately absent is any notion
 * of display cadence — how fast parts are rendered is the application's
 * business, not the transport's.
 *
 * The normative definition of these values is `specs/transport/air-gap-optical.md`
 * (BRC-141); the implementation-neutral fixtures live under
 * `conformance/vectors/transport/`.
 */

/** ASCII prefix every wire part starts with. */
export const AIR_GAP_PREFIX = 'air-gap:'

/**
 * Wire protocol version carried in the first header byte.
 *
 * A decoder MUST reject any other value: the version byte is what lets the
 * header layout, RNG, or degree distribution change later without silently
 * mis-decoding old parts.
 */
export const AIR_GAP_WIRE_VERSION = 1

/** Bytes in the session identifier that names one encoder's stream. */
export const SESSION_ID_BYTES = 8

/**
 * Fixed header size in bytes:
 * `ver` u8 ‖ `sessionId` 8 bytes ‖ `seq` u32 ‖ `K` u16 ‖ `msgLen` u32 ‖ `crc32` u32.
 */
export const HEADER_BYTES = 23

/**
 * Default source-block size in bytes.
 *
 * base64url text contains lowercase letters, `-` and `_`, so QR encoders store
 * it in **byte mode** (one symbol byte per character), not alphanumeric mode.
 * A 1,200-byte block yields a 1,223-byte part body, which is 1,631 unpadded
 * base64url characters plus the 8-character prefix: 1,639 bytes in a QR
 * symbol. That fits a version-40 symbol in byte mode at every error-correction
 * level up to Q (1,663 bytes) and leaves 44% headroom at level L (2,953), for
 * a scanner that is not looking at the screen straight on.
 */
export const DEFAULT_BLOCK_BYTES = 1200

/**
 * Ceiling on the source-block size, enforced by encoder and decoder alike.
 *
 * Sized to the largest single optical symbol in practical use: a 2,048-byte
 * block renders as a 2,770-character part, inside the 2,953-byte byte-mode
 * capacity of a version-40 QR symbol at error-correction level L. On the
 * decoder this is a resource bound: a scanned string longer than
 * `estimatePartCharLength(MAX_BLOCK_BYTES)` is rejected before any base64
 * decoding or allocation happens.
 */
export const MAX_BLOCK_BYTES = 2048

/**
 * Sanity ceiling on a whole message.
 *
 * At five parts per second with 1,200-byte blocks, 64 KiB is roughly 55 source
 * blocks — some 15 to 30 seconds of two people holding phones together, which
 * is already the practical limit of the medium. A larger payload means the
 * layer above should be sending a reference rather than the bytes themselves.
 */
export const MAX_MESSAGE_BYTES = 65536

/**
 * Largest source-block count the header can express, since `K` is a u16.
 *
 * Reachable only with a pathologically small `blockBytes`; the encoder rejects
 * such a configuration rather than silently truncating `K` on the wire.
 */
export const MAX_BLOCK_COUNT = 0xffff

/** Exclusive upper bound on `seq`, which the header carries as a u32. */
export const MAX_SEQ_EXCLUSIVE = 2 ** 32

/**
 * Consecutive parts of one foreign session it takes to switch the decoder.
 *
 * The decoder locks onto the first session it accepts; a single well-formed
 * stray frame from another sender is rejected instead of erasing progress.
 * Only this many *consecutive* parts of the same new session — the camera
 * really is pointed at a different sender now — adopt it.
 */
export const SESSION_SWITCH_PARTS = 3

/**
 * Decoder resource budgets. Receiver-local policy, not wire format: they bound
 * the memory and work one `AirGapDecoder` can be driven to by a hostile or
 * broken sender, and are documented (with the reject/evict semantics) in the
 * spec. Honest sessions stay far below all three.
 */

/** Most distinct sequence numbers remembered for duplicate suppression. */
export const MAX_TRACKED_SEQS = 65536

/** Most unsolved multi-block parts buffered for peeling. */
export const MAX_PENDING_PARTS = 1024

/**
 * Most unresolved block references across all buffered parts.
 *
 * Bounds the Set memory a hostile sender can pin with high-degree mixes.
 * Practical sessions (K ≤ ~55 at the default block size) keep this in the
 * dozens; only a sender whose parts cannot peel — hostile or badly broken —
 * approaches either pending budget, and rejecting its mixes loses nothing
 * because systematic and degree-1 parts are always accepted.
 */
export const MAX_PENDING_INDICES = 4096
