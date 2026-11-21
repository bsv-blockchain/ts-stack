import { promiseFromSync } from '../../utility/promiseFromSync'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { runInSeries } from '../../utility/runInSeries'
import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { knex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import {
  historicalSnapshotJournalMigrations,
  migrateBeforeSnapshotJournal
} from '../../../test/utils/snapshotJournalHistoricalFixture'
import { StorageProvider } from '../StorageProvider'
import {
  installSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration
} from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import { copySnapshotJournalBootstrapPage } from '../snapshot/journal/SnapshotJournalBootstrap'
import { MAX_SNAPSHOT_JOURNAL_REVISION, snapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  authenticatedStageOptions,
  authenticatedStagePassword,
  encrypted
} from './Brc38AuthenticatedPrivateStageFixture'
import { stageAuthenticatedBrc39PrivateImport } from './Brc38AuthenticatedPrivateStageNode'
import { Brc38StagingAdmissionNode, type Brc38StagingReservation } from './Brc38StagingAdmissionNode'
import { semanticStageFixture } from './Brc38SemanticStageFixture'

export const previewReceiptPolicy = { receiptLimit: 128, receiptLifetimeMs: 2592000000 }
export async function previewDestinationFixture(beforeGeneration?: (trx: Knex.Transaction) => Promise<void>) {
  const directory = await fs.mkdtemp(join(tmpdir(), 'brc38-destination-preview-')),
    filename = join(directory, 'target.sqlite'),
    config = {
      client: 'better-sqlite3',
      connection: { filename },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    },
    k = knex(config),
    writer = knex(config),
    storage = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  try {
    await k.raw('PRAGMA journal_mode=WAL')
    await k.raw('PRAGMA synchronous=FULL')
    await writer.raw('PRAGMA busy_timeout=0')
    if (beforeGeneration === undefined)
      await migrateBeforeSnapshotJournal(storage, 'synthetic import preview', 'synthetic target')
    else {
      // Fresh-wallet component proof only. Existing bound generations need a
      // separately qualified forward migration; their metadata is never edited.
      const migrationSource = historicalSnapshotJournalMigrations(
        storage,
        'synthetic import preview',
        'synthetic target'
      )
      migrationSource.migrations['2026-10-01-999 private import indexes fixture'] = {
        up: async transaction => await beforeGeneration(transaction as Knex.Transaction),
        down: () => {
          return promiseFromSync(() => {
            throw new Error('Fresh import fixture indexes require forward migration')
          })
        }
      }
      await migrateBeforeSnapshotJournal(storage, 'synthetic import preview', 'synthetic target', migrationSource)
    }
    await storage.makeAvailable()
    await installSnapshotJournalSqliteGeneration(
      k,
      snapshotJournalRevision(MAX_SNAPSHOT_JOURNAL_REVISION),
      previewReceiptPolicy
    )
    // This bounded fresh fixture installs a real owned generation on an empty
    // wallet; no historical SourceBootstrap crash campaign is selected/replayed.
    let finished = false
    await runInSeries(Array.from({ length: 20 }), async () => {
      if (!finished) finished = (await copySnapshotJournalBootstrapPage(k, 1000)).complete
    })
    if (!finished) throw new Error('Fresh empty preview fixture bootstrap did not finish')
    await completeSnapshotJournalSqliteGeneration(k, previewReceiptPolicy)
    return {
      directory,
      k,
      writer,
      storage,
      async close() {
        const results = await Promise.allSettled([storage.destroy(), writer.destroy()])
        const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
        if (failures.length !== 0) throw new AggregateError(failures, 'Preview target retains physical cleanup')
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  } catch (cause) {
    const results = await Promise.allSettled([storage.destroy(), writer.destroy()])
    const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length !== 0)
      throw new AggregateError([cause, ...failures], 'Preview fixture opening and cleanup failed')
    await fs.rm(directory, { recursive: true, force: true })
    throw cause
  }
}
export async function previewPrivateFixture(
  identityKey?: string,
  transform?: (data: ReturnType<typeof semanticStageFixture>) => void,
  maximumRowBytes = 65536,
  maximumPhysicalBytes = 4194304,
  maximumRowAllocationBytes = maximumRowBytes,
  streamedStructured = false
) {
  if (!Number.isSafeInteger(maximumPhysicalBytes) || maximumPhysicalBytes < 1048576 || maximumPhysicalBytes > 16777216)
    throw new RangeError('Preview fixture requires an explicit bounded physical allowance')
  if (
    !Number.isSafeInteger(maximumRowAllocationBytes) ||
    maximumRowAllocationBytes < 1 ||
    maximumRowAllocationBytes > 16777216
  )
    throw new RangeError('Preview fixture requires an explicit bounded allocation allowance')
  const directory = await fs.mkdtemp(join(tmpdir(), 'brc38-private-preview-')),
    root = await Brc38StagingAdmissionNode.create(directory, {
      maximumImports: 1,
      maximumPhysicalBytes: 3145728 + maximumPhysicalBytes,
      maximumLogicalBytes: 1048576
    }),
    held: Brc38StagingReservation[] = []
  try {
    const data = semanticStageFixture()
    transform?.(data)
    if (identityKey !== undefined) data.user.identityKey = identityKey
    const bytes = await encrypted(data),
      selected = authenticatedStageOptions(bytes)
    if (identityKey !== undefined) selected.binding = { ...selected.binding, identityKey }
    // A single original fixed deadline permits the whole bounded fixture. It
    // is established before admission and never renewed by preview/resume.
    selected.limits = {
      ...selected.limits,
      maximumPhysicalBytes,
      maximumRowBytes,
      maximumRowAllocationBytes,
      expiresAt: Date.now() + 180000
    }
    if (streamedStructured) {
      selected.streamedStructuredFields = {
        fields: { maximumStructuredBytes: 65536, maximumChunkBytes: 1024 },
        staging: {
          privateIndexParent: directory,
          maximumTemporaryIndexBytes: 2097152,
          maximumIndexMembers: 10000,
          maximumStructuredBytes: 65536,
          maximumCanonicalBytes: 65536,
          maximumReadBytes: 1024,
          workingAllocation: new Brc38WorkingAllocation(maximumRowAllocationBytes)
        }
      }
    }
    async function* chunks() {
      for (let offset = 0; offset < bytes.length; offset += 137)
        yield Promise.resolve(bytes.slice(offset, offset + 137))
    }
    const value = await stageAuthenticatedBrc39PrivateImport(chunks(), authenticatedStagePassword, root, selected)
    held.push(value.reservation)
    return {
      directory,
      root,
      value,
      selected,
      held,
      async close() {
        const results = await Promise.allSettled(held.map(reservation => reservation.store.close()))
        results.push(...(await Promise.allSettled([root.close()])))
        const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
        if (failures.length !== 0)
          throw new AggregateError(failures, 'Private preview fixture retains physical cleanup')
        await fs.rm(directory, { recursive: true, force: true })
      }
    }
  } catch (cause) {
    const results = await Promise.allSettled(held.map(reservation => reservation.store.close()))
    results.push(...(await Promise.allSettled([root.close()])))
    const failures = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (failures.length !== 0)
      throw new AggregateError([cause, ...failures], 'Private preview opening and cleanup failed')
    await fs.rm(directory, { recursive: true, force: true })
    throw cause
  }
}
