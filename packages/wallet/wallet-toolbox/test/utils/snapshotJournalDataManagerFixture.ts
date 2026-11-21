import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../../src/storage/StorageKnex'
import { StorageProvider } from '../../src/storage/StorageProvider'
import { WalletStorageManager } from '../../src/storage/WalletStorageManager'
import { snapshotHttpFixture } from './snapshotArchiveHttpFixtures'

export async function snapshotJournalDataManagerFixture() {
  const remote = await snapshotHttpFixture(true, false, 'test', 'remote-journal-data'),
    directory = await mkdtemp(join(tmpdir(), 'manager-journal-data-'))
  const storage = new StorageKnex({
    ...StorageProvider.createStorageBaseOptions('test'),
    knex: knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'local.sqlite') },
      useNullAsDefault: true,
      pool: { min: 0, max: 1 }
    })
  })
  const close = async () => {
    const results = await Promise.allSettled([remote.close(), storage.destroy()])
    await rm(directory, { recursive: true, force: true })
    const errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Actual manager DATA fixture cleanup failed')
  }
  try {
    await storage.knex.raw('PRAGMA journal_mode=WAL')
    await storage.migrate('local journal DATA', 'local-journal-data')
    await storage.makeAvailable()
    await storage.findOrInsertUser(remote.identityKey)
    const manager = new WalletStorageManager(remote.identityKey, storage)
    await manager.makeAvailable()
    await manager.setActive('local-journal-data')
    const served = await remote.serve()
    return { remote, storage, manager, served, close }
  } catch (error) {
    await close()
    throw error
  }
}
