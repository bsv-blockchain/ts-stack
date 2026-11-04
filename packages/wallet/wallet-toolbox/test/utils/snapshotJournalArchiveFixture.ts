import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StorageKnex } from '../../src/storage/StorageKnex'
import { StorageProvider } from '../../src/storage/StorageProvider'
import { KnexSnapshotArchiveStore } from '../../src/storage/snapshot/archive/KnexSnapshotArchiveStore'
import type { SnapshotJournalReconciliationSource } from '../../src/storage/snapshot/journal/SnapshotJournalProvider'
import { runInSeries } from '../../src/utility/runInSeries'
import { seedArchiveClosure } from './snapshotArchiveFixtures'

export const journalArchiveIdentity = '02' + '11'.repeat(32),
  journalArchiveForeign = '03' + '22'.repeat(32)

/** Genuine ordinary WAL source/store, with the same original populated closure
 * fixture. No native/platform/proof-validation qualification is implied. */
export async function snapshotJournalArchiveFixture(fullClosure = false) {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-journal-archive-')),
    storage = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: join(directory, 'wallet.sqlite') },
        useNullAsDefault: true,
        pool: { min: 0, max: 1 }
      })
    }),
    sources: SnapshotJournalReconciliationSource[] = []
  const close = async () => {
    await runInSeries(sources, async source => {
      await source.close()
      await source.closed
    })
    await storage.destroy()
    await rm(directory, { recursive: true, force: true })
  }
  try {
    await storage.knex.raw('PRAGMA journal_mode=WAL')
    await storage.migrate('journal archive fixture', 'source')
    await storage.makeAvailable()
    const { user } = await storage.findOrInsertUser(journalArchiveIdentity),
      { user: foreign } = await storage.findOrInsertUser(journalArchiveForeign)
    await storage.updateUser(user.userId, { activeStorage: 'source' })
    if (fullClosure) await seedArchiveClosure(storage, user.userId, foreign.userId)
    const original = await storage.findOrInsertTxLabel(user.userId, 'original label')
    await storage.findOrInsertTxLabel(foreign.userId, 'foreign label')
    const own = (source: SnapshotJournalReconciliationSource) => {
      sources.push(source)
      return source
    }
    return {
      storage,
      user,
      original,
      foreign,
      store: new KnexSnapshotArchiveStore(storage.knex),
      close,
      own,
      open: async () => own(await storage.openCurrentSnapshotJournalSource(journalArchiveIdentity))
    }
  } catch (error) {
    try {
      await close()
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Journal archive fixture and physical cleanup failed', {
        cause: error
      })
    }
    throw error
  }
}
