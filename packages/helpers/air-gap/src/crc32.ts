/**
 * CRC-32 (IEEE 802.3), the standard table-driven implementation.
 *
 * This is an *integrity* check on the reassembled payload, not a cryptographic
 * one: it catches the failure this transport actually has — a camera read that
 * decoded to the wrong bits, or two encoders whose parts got interleaved — for
 * four bytes on every frame. Authenticating the payload is the caller's job,
 * and belongs in the payload.
 */

/** Reversed polynomial 0xedb88320, one entry per possible low byte. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * The IEEE CRC-32 of `bytes`, as an unsigned 32-bit number.
 *
 * @example
 * ```ts
 * crc32(new TextEncoder().encode('123456789')) // 0xcbf43926
 * ```
 */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
