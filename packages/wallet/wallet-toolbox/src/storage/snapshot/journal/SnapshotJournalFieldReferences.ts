import { realpath, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { Knex } from 'knex'
import { Brc38WorkingAllocation } from '../../portable/Brc38WorkingAllocation'
import { Brc38NodeJsonIndex } from '../../portable/Brc38NodeJsonIndex'
import { Brc38StagingCleanupError, Brc38CleanupScope } from '../../portable/Brc38StagingCleanupError'
import { createPrivateTemporaryDirectory, requirePrivatePath } from '../../portable/Brc38PrivateFilesystemNode'
import { visitBrc38StructuredJsonValues } from '../../portable/Brc38StructuredJson'
import type { SnapshotJournalHashedFieldDescriptor } from './SnapshotJournalFieldTypes'
import type { SnapshotJournalSourceIdentity } from './SnapshotJournalTypes'
import type { SnapshotJournalSourceIndexes } from './SnapshotJournalSourceGenerations'
import type { SnapshotJournalRevision } from './SnapshotJournalRevision'
import { readSnapshotJournalNotificationSourceIdentities } from './SnapshotJournalRowReferences'

/** This owns a temporary JSON index, not a source or writer grant. The actual
 * capture supplies its pinned extent reader, lifetime and private profile.
 * Every notification identity is filtered in that SAME real SQL view. */
export async function captureSnapshotJournalFieldNotifications(
  k: Knex,
  userId: number,
  high: SnapshotJournalRevision,
  descriptor: Readonly<SnapshotJournalHashedFieldDescriptor>,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  check: () => void,
  expiresAt: number,
  capture: (identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>) => void | Promise<void>,
  indexes: SnapshotJournalSourceIndexes
): Promise<void> {
  if (
    descriptor.kind !== 'utf8' ||
    descriptor.bytes < 1 ||
    descriptor.bytes > 1000000000 ||
    !/^[0-9a-f]{64}$/.test(descriptor.sha256)
  )
    throw new TypeError('Actual journal notification descriptor is required')
  const working = new Brc38WorkingAllocation(16777216),
    retained = working.claim(16384),
    owned = new Set<Brc38NodeJsonIndex>(),
    failures = new Set<Brc38StagingCleanupError>()
  let directory: string | undefined,
    identity: Awaited<ReturnType<typeof requirePrivatePath>> | undefined,
    cause: { error: unknown } | undefined
  const actualDirectory = async () => {
    if (directory === undefined || identity === undefined) throw new Error('Journal JSON directory is not owned')
    const current = await requirePrivatePath(directory, true)
    if (current.dev !== identity.dev || current.ino !== identity.ino || current.uid !== identity.uid)
      throw new Error('Journal JSON directory identity changed')
  }
  const cleanup = async () => {
    for (const error of failures) {
      await error.retryCleanup()
      failures.delete(error)
    }
    for (const index of owned) {
      await index.close()
      owned.delete(index)
    }
    if (directory !== undefined) {
      await actualDirectory()
      await rmdir(directory)
      directory = undefined
    }
    retained.close()
    if (working.used !== 0) throw new Error('Journal notification index retained a working reservation')
  }
  const scope = new Brc38CleanupScope(async () => {
    try {
      await cleanup()
    } catch (error) {
      throw new Brc38StagingCleanupError(
        [...(cause === undefined ? [] : [cause.error]), error],
        'Journal notification source retains actual temporary cleanup',
        cleanup
      )
    }
  })
  try {
    check()
    directory = await createPrivateTemporaryDirectory(join(await realpath(tmpdir()), 'journal-notify-'))
    identity = await requirePrivatePath(directory, true)
    check()
    let ids: number[] = []
    const flush = async () => {
      if (ids.length === 0) throw new Error('No actual notification batch to flush')
      check()
      const batch = ids
      ids = []
      const identities = await readSnapshotJournalNotificationSourceIdentities(k, userId, high, batch, indexes)
      if (identities.size !== 0) {
        const pending = capture(identities)
        if (pending !== undefined) await pending
      }
      check()
    }
    await visitBrc38StructuredJsonValues(
      {
        encoding: 'utf8',
        length: descriptor.bytes,
        sha256: descriptor.sha256,
        read: async (offset, length) => {
          check()
          await actualDirectory()
          const bytes = await read(offset, length)
          check()
          await actualDirectory()
          return bytes
        },
        openIndex: async () => {
          check()
          await actualDirectory()
          try {
            const index = await Brc38NodeJsonIndex.open({
              privateParent: directory!,
              sourceBytes: descriptor.bytes,
              maximumTemporaryFileBytes: 67108864,
              maximumTemporaryPhysicalBytes: 67108864,
              maximumMembers: 1000000,
              maximumAllocationBytes: 1048576,
              workingAllocation: working,
              expiresAt
            })
            owned.add(index)
            check()
            await actualDirectory()
            return index
          } catch (error) {
            if (error instanceof Brc38StagingCleanupError) failures.add(error)
            throw error
          }
        }
      },
      {
        maximumInputBytes: 1000000000,
        maximumOutputBytes: 1000000000,
        maximumChunkBytes: 16384,
        maximumAllocationBytes: 1048576,
        workingAllocation: working
      },
      {
        enter: (path, kind) => {
          check()
          if (
            (path.length === 0 && kind !== 'object') ||
            (path.length === 1 && path[0] === 'transactionIds' && kind !== 'array' && kind !== 'null')
          )
            throw new TypeError('Journal notification transactionIds must be an array or absent')
        },
        number: (path, value) => {
          if (path.length === 2 && path[0] === 'transactionIds' && Number.isSafeInteger(value) && value > 0) {
            ids.push(value)
            if (ids.length === 64) return flush()
          }
        }
      }
    )
    // Visitation verifies both EOF digests and physical index closure. Any
    // earlier flushed prefixes remain provisional until their frame commits.
    if (ids.length !== 0) await flush()
    check()
  } catch (error) {
    cause = { error }
    if (error instanceof Brc38StagingCleanupError) failures.add(error)
    await scope.close()
    throw error
  } finally {
    await scope.close()
  }
}
