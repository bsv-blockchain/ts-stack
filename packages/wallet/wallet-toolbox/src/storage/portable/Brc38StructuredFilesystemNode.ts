import { requirePrivatePath, requirePrivateDescriptor } from './Brc38PrivateFilesystemNode'
import { constants } from 'node:fs'
import { open, opendir, realpath, statfs, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'

/** Fresh physical measurement DATA only. The caller separately proves its
 * actual source/profile/SQL actor. Retained descriptors and current paths must
 * agree; neither a pathname nor an earlier measurement authorizes a source. */
export async function measureBrc38StructuredFilesystem(
  directory: string,
  allowedNames: readonly string[],
  maximumPhysicalBytes: number,
  reservedScratchBytes: number,
  signal?: AbortSignal
): Promise<number> {
  if (
    !isAbsolute(directory) ||
    resolve(directory) !== directory ||
    Buffer.byteLength(directory) > 4096 ||
    allowedNames.length < 1 ||
    allowedNames.length > 16 ||
    allowedNames.some(name => !/^[a-z0-9_-]+\.sqlite(?:-(?:journal|wal|shm))?$/.test(name)) ||
    !Number.isSafeInteger(maximumPhysicalBytes) ||
    maximumPhysicalBytes < 1048576 ||
    !Number.isSafeInteger(reservedScratchBytes) ||
    reservedScratchBytes < 0 ||
    reservedScratchBytes > maximumPhysicalBytes
  )
    throw new RangeError('Invalid structured filesystem admission')
  signal?.throwIfAborted()
  const files: FileHandle[] = [],
    directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  files.push(directoryHandle)
  let failed = false,
    cause: unknown,
    total = 0
  try {
    const original = await requirePrivateDescriptor(directoryHandle, true),
      filesystem = await statfs(directory),
      unit = filesystem.bsize,
      same = (a: { dev: bigint; ino: bigint }, b: { dev: bigint; ino: bigint }) => a.dev === b.dev && a.ino === b.ino,
      currentDirectory = async () => {
        signal?.throwIfAborted()
        const path = await requirePrivatePath(directory, true),
          held = await requirePrivateDescriptor(directoryHandle, true)
        if (!same(path, original) || !same(held, original) || (await realpath(directory)) !== directory)
          throw new Error('Structured filesystem directory identity changed')
      },
      extent = (size: bigint, blocks: bigint) => {
        if (
          size < 0n ||
          size > BigInt(Number.MAX_SAFE_INTEGER) ||
          blocks < 0n ||
          blocks > BigInt(Number.MAX_SAFE_INTEGER) / 512n
        )
          throw new Error('Structured filesystem extent differs')
        const bytes = Math.max(Math.ceil(Number(size) / unit) * unit, Number(blocks * 512n))
        if (!Number.isSafeInteger(bytes)) throw new SnapshotResourceLimitError('Structured physical extent overflows')
        return bytes
      }
    if (!Number.isSafeInteger(unit) || unit < 512 || unit > 1048576)
      throw new Error('Unsupported structured filesystem allocation unit')
    await currentDirectory()
    // Keep separate namespace/inode headroom; file length is never the only
    // physical measure. Platform qualification must verify the chosen margin.
    total = extent(original.size, original.blocks) + 2 * (allowedNames.length + 2) * Math.max(4096, unit)
    const entries = await opendir(directory)
    let amount = 0
    for await (const entry of entries) {
      signal?.throwIfAborted()
      if (
        ++amount > allowedNames.length ||
        !allowedNames.includes(entry.name) ||
        !entry.isFile() ||
        entry.isSymbolicLink()
      )
        throw new Error('Unexpected structured source filesystem member')
      const name = join(directory, entry.name),
        handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW)
      files.push(handle)
      const held = await requirePrivateDescriptor(handle),
        path = await requirePrivatePath(name, false)
      if (!same(held, path)) throw new Error('Structured source filesystem member changed')
      total += extent(held.size, held.blocks)
      if (!Number.isSafeInteger(total) || total > maximumPhysicalBytes - reservedScratchBytes)
        throw new SnapshotResourceLimitError('Structured source and scratch exceed their physical admission')
      const after = await requirePrivateDescriptor(handle),
        current = await requirePrivatePath(name, false)
      if (
        !same(after, held) ||
        !same(current, held) ||
        after.size !== held.size ||
        after.blocks !== held.blocks ||
        current.size !== after.size ||
        current.blocks !== after.blocks
      )
        throw new Error('Structured source physical extent changed during measurement')
    }
    if (amount === 0 || total > maximumPhysicalBytes - reservedScratchBytes)
      throw new SnapshotResourceLimitError('Structured source physical admission is unavailable')
    const actualFilesystem = await statfs(directory),
      available = actualFilesystem.bavail * actualFilesystem.bsize
    if (actualFilesystem.bsize !== unit || !Number.isSafeInteger(available) || available < reservedScratchBytes)
      throw new SnapshotResourceLimitError('Structured scratch filesystem capacity is unavailable')
    await currentDirectory()
  } catch (error) {
    failed = true
    cause = error
  }
  const retained = new Set(files),
    cleanup = async (): Promise<void> => {
      const failures: unknown[] = []
      for (const file of [...retained].reverse()) {
        try {
          await file.close()
          retained.delete(file)
        } catch (error) {
          failures.push(error)
        }
      }
      if (failures.length !== 0)
        throw new Brc38StagingCleanupError(failures, 'Structured physical measurement retains descriptors', cleanup)
    }
  try {
    await cleanup()
  } catch (error) {
    throw new Brc38StagingCleanupError(
      [...(failed ? [cause] : []), error],
      'Structured physical measurement descriptor cleanup failed',
      cleanup
    )
  }
  if (failed) throw cause
  return total
}
