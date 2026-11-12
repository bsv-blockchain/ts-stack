import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { runInSeries } from '../../utility/runInSeries'
import { createPrivateFile, requirePrivateDescriptor } from './Brc38PrivateFilesystemNode'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { assertBrc38ProfileFileDescriptor, type Brc38ProfileFileIdentity } from './Brc38ProfilePhysicalIdentityNode'

const chunkBytes = 262144
function* offsets(size: number) {
  for (let position = 0; position < size; position += chunkBytes) yield position
}
function check(signal: AbortSignal | undefined, expiresAt: number): void {
  signal?.throwIfAborted()
  if (Date.now() >= expiresAt) throw new Error('Original private publication deadline expired')
}
async function closeFiles(files: FileHandle[], cause?: unknown): Promise<void> {
  const retained = new Set(files)
  const cleanup = async (): Promise<void> => {
    const results = await Promise.allSettled([
      ...(cause instanceof Brc38StagingCleanupError ? [cause.retryCleanup()] : []),
      ...[...retained].map(async file => {
        await file.close()
        retained.delete(file)
      })
    ])
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Publication file cleanup failed')
  }
  try {
    await cleanup()
  } catch (error_) {
    throw new Brc38StagingCleanupError(
      cause === undefined ? [error_] : [cause, error_],
      'Publication retains original file descriptors',
      cleanup
    )
  }
}
/** Internal copy primitive. Its caller keeps the independent source kernel
 * claim after physically closing every database connection. One fixed buffer,
 * no-follow source descriptor and exclusive target creation bound the copy. */
export async function copyBrc38OwnedDatabase(
  sourceName: string,
  targetName: string,
  maximumBytes: number,
  expiresAt: number,
  assertOwner: () => void,
  signal?: AbortSignal,
  assertSource?: (file: FileHandle) => Promise<void>
): Promise<Readonly<{ bytes: number; sha256: string }>> {
  const held: FileHandle[] = []
  let failed = false
  let original: unknown
  try {
    check(signal, expiresAt)
    assertOwner()
    const source = await open(sourceName, constants.O_RDONLY | constants.O_NOFOLLOW)
    held.push(source)
    await assertSource?.(source)
    check(signal, expiresAt)
    assertOwner()
    const before = await requirePrivateDescriptor(source)
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 4096 ||
      before.size < 4096n ||
      before.size > BigInt(maximumBytes)
    )
      throw new Error('Publication source file exceeds its owned physical policy')
    const size = Number(before.size),
      target = await createPrivateFile(targetName)
    held.push(target)
    const buffer = Buffer.alloc(Math.min(chunkBytes, size)),
      hash = createHash('sha256')
    await runInSeries(offsets(size), async position => {
      check(signal, expiresAt)
      assertOwner()
      const length = Math.min(buffer.length, size - position)
      const read = await source.read(buffer, 0, length, position)
      if (read.bytesRead !== length) throw new Error('Publication source changed during bounded copy')
      hash.update(buffer.subarray(0, length))
      const written = await target.write(buffer, 0, length, position)
      if (written.bytesWritten !== length) throw new Error('Publication target write was incomplete')
    })
    await target.sync()
    await assertSource?.(source)
    const after = await requirePrivateDescriptor(source),
      targetStat = await requirePrivateDescriptor(target)
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      targetStat.size !== before.size
    )
      throw new Error('Publication file identity changed during copy')
    check(signal, expiresAt)
    assertOwner()
    return Object.freeze({ bytes: size, sha256: hash.digest('hex') })
  } catch (cause) {
    failed = true
    original = cause
    throw cause
  } finally {
    await closeFiles(held, failed ? original : undefined)
  }
}

export async function hashBrc38PublishedDatabase(
  filename: string,
  maximumBytes: number,
  expected?: Brc38ProfileFileIdentity,
  assertCurrent?: () => void
): Promise<string> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  let failed = false,
    original: unknown
  try {
    assertCurrent?.()
    if (expected !== undefined) await assertBrc38ProfileFileDescriptor(file, expected)
    const before = await requirePrivateDescriptor(file)
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 4096 ||
      before.size < 4096n ||
      before.size > BigInt(maximumBytes)
    )
      throw new Error('Published profile file exceeds its physical policy')
    const size = Number(before.size),
      buffer = Buffer.alloc(Math.min(chunkBytes, size)),
      hash = createHash('sha256')
    await runInSeries(offsets(size), async position => {
      assertCurrent?.()
      const length = Math.min(buffer.length, size - position)
      if ((await file.read(buffer, 0, length, position)).bytesRead !== length)
        throw new Error('Published profile read was incomplete')
      hash.update(buffer.subarray(0, length))
      assertCurrent?.()
    })
    const after = await requirePrivateDescriptor(file)
    assertCurrent?.()
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    )
      throw new Error('Published profile changed during verification')
    return hash.digest('hex')
  } catch (cause) {
    failed = true
    original = cause
    throw cause
  } finally {
    await closeFiles([file], failed ? original : undefined)
  }
}
