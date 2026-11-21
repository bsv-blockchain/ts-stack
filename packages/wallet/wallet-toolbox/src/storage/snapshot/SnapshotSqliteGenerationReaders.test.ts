import { migrateBeforeSqliteGeneration } from '../../../test/utils/snapshotHistoricalMigrations'
import { retireGenerationPage } from '../schema/snapshotSqliteIndexRetirement'
import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installGeneration } from '../schema/snapshotSqliteIndexGeneration'
import { copyGenerationPage } from '../schema/snapshotSqliteIndexBootstrap'
import { readGenerationIndexState, migration } from '../schema/snapshotSqliteIndexState'
import { replace } from '../../../test/utils/snapshotSqliteFixtures'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { seedArchiveClosure } from '../../../test/utils/snapshotArchiveFixtures'
import { snapshotArchiveTables } from './archive/SnapshotArchive'
import { openKnexSnapshotArchiveSource } from './archive/KnexSnapshotArchiveSource'
import { readSnapshotProfileIndexState } from '../schema/snapshotProfileIndexMigration'
import type { WalletReadSnapshot, WalletSnapshotCursor } from './WalletReadSnapshot'
import type { SnapshotArchiveSource } from './archive/KnexSnapshotArchiveSource'

async function pages(view: WalletReadSnapshot | SnapshotArchiveSource) {
  const result: Record<string, unknown[]> = {}
  try {
    if ('validateClosure' in view) await view.validateClosure()
    for (const table of snapshotArchiveTables) {
      let cursor: WalletSnapshotCursor | undefined
      const rows: unknown[] = []
      for (let n = 0; n < 30; n++) {
        const page = await view.readPage(table, cursor, { maxRows: 1, maxBytes: 131072 })
        rows.push(...page.rows)
        if (page.done) {
          result[table] = rows
          break
        }
        cursor = page.cursor
      }
      expect(result[table]).toBeDefined()
    }
    return result
  } finally {
    await view.close()
  }
}

test.each(['ordinary', 'archive'])(
  '%s pins legacy, pending and completed generations across independent WAL writes',
  async kind => {
    const directory = await mkdtemp(join(tmpdir(), 'snapshot-generation-reader-'))
    const options = {
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    }
    const k = knex(options),
      writer = knex(options)
    const legacySource = new StorageKnex({
      ...StorageProvider.createStorageBaseOptions('test'),
      knex: knex(options)
    })
    let oldest: WalletReadSnapshot | SnapshotArchiveSource | undefined
    const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
    const identity = '02' + '11'.repeat(32)
    let pinned: WalletReadSnapshot | SnapshotArchiveSource | undefined
    const open = async () =>
      kind === 'ordinary'
        ? await source.openWalletReadSnapshot(identity)
        : await openKnexSnapshotArchiveSource(source, identity)
    try {
      await k.raw('PRAGMA journal_mode=WAL')
      await migrateBeforeSqliteGeneration(source, 'generation-reader', 'synthetic-generation-reader')
      await source.makeAvailable()
      const user = (await source.findOrInsertUser(identity)).user.userId
      const other = (await source.findOrInsertUser('03' + '22'.repeat(32))).user.userId
      await seedArchiveClosure(source, user, other)
      const baseline = await pages(await open())
      pinned = await open()
      await legacySource.makeAvailable()
      oldest =
        kind === 'ordinary'
          ? await legacySource.openWalletReadSnapshot(identity)
          : await openKnexSnapshotArchiveSource(legacySource, identity)
      const plan = await installGeneration(writer)
      const original = await writer('sync_states').where('syncStateId', 1).first()
      await replace(writer, 'sync_states', { ...original, syncStateId: 101 })
      expect(await pages(pinned)).toEqual(baseline)
      pinned = undefined
      await expect(readSnapshotProfileIndexState(writer)).rejects.toThrow('incomplete')
      expect(await readGenerationIndexState(writer)).toBe(false)
      const pending = await pages(await open())
      expect(pending.syncStates.map(row => (row as { syncStateId: number }).syncStateId)).toEqual([3, 101])
      pinned = await open()
      for (let i = 0; i < 50; i++) if ((await copyGenerationPage(writer, plan)).complete) break
      // Complete local copy is not published as an indexed source before journaling.
      expect(await readGenerationIndexState(writer)).toBe(false)
      await writer('knex_migrations').insert({
        name: migration,
        batch: 99,
        migration_time: new Date()
      })
      expect(await readGenerationIndexState(writer)).toBe('v2')
      let retired = false
      for (let i = 0; i < 100; i++)
        if ((await retireGenerationPage(writer, plan)).complete) {
          retired = true
          break
        }
      expect(retired).toBe(true)
      expect(await pages(oldest!)).toEqual(baseline)
      oldest = undefined
      await writer('sync_states').insert({
        ...original,
        syncStateId: 102,
        refNum: 'new-independent-state'
      })
      expect(await pages(pinned)).toEqual(pending)
      pinned = undefined
      const queries: string[] = []
      const listen = (query: { sql: string }) => {
        if (query.sql.includes('cross join') && query.sql.includes('_v2')) queries.push(query.sql)
      }
      k.on('query', listen)
      try {
        const readyView = await open()
        if ('sourceSchema' in readyView) expect(readyView.sourceSchema).toBe(migration)
        const ready = await pages(readyView)
        expect(ready.syncStates.map(row => (row as { syncStateId: number }).syncStateId)).toEqual([3, 101, 102])
        expect(queries.length).toBeGreaterThan(0)
        for (const table of snapshotArchiveTables.filter(table => table !== 'syncStates'))
          expect(ready[table]).toEqual(baseline[table])
      } finally {
        k.off('query', listen)
      }
    } finally {
      if (oldest) await oldest.close()
      if (pinned) await pinned.close()
      await legacySource.destroy()
      await writer.destroy()
      await source.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
