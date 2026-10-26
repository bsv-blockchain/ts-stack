import type { FileHandle } from 'node:fs/promises'

/**
 * Write an entire buffer even when the operating system reports a successful
 * partial write. FileHandle.write is permitted to consume fewer bytes than it
 * was given, so content-addressed storage must not treat one call as proof that
 * the complete chunk reached disk.
 */
export async function writeBytesFully(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0
  while (offset < bytes.byteLength) {
    const remaining = bytes.byteLength - offset
    const result = await handle.write(bytes, offset, remaining)
    if (
      !Number.isSafeInteger(result.bytesWritten) ||
      result.bytesWritten < 1 ||
      result.bytesWritten > remaining
    ) {
      throw new Error('Filesystem write made no progress.')
    }
    offset += result.bytesWritten
  }
}
