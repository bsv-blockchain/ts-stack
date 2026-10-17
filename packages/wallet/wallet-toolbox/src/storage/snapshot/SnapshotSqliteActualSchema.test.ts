import { knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { names } from '../schema/snapshotSqliteIndexGeneration'
import { legacyNames } from '../schema/snapshotSqliteMembership'
import type { Knex } from 'knex'
import { exact, replace, tables } from '../../../test/utils/snapshotSqliteFixtures'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { seedArchiveClosure } from '../../../test/utils/snapshotArchiveFixtures'
import { snapshotArchiveTables } from './archive/SnapshotArchive'
import { walletSnapshotSourceQuery } from './KnexWalletReadSnapshot'
import { openKnexSnapshotArchiveSource } from './archive/KnexSnapshotArchiveSource'
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

test.each([false, true])(
  'actual migrated wallet preserves replacement membership and both readers, recursive=%s',
  async recursive => {
    const directory = await mkdtemp(join(tmpdir(), 'snapshot-identity-actual-'))
    const k = knex({
      client: 'better-sqlite3',
      connection: { filename: join(directory, 'wallet.sqlite') },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
    const identities = ['02' + '11'.repeat(32), '03' + '22'.repeat(32)]
    try {
      await k.raw('PRAGMA journal_mode=WAL')
      await source.migrate('identity fixture', 'synthetic-identity-fixture')
      await source.makeAvailable()
      await k.raw('PRAGMA recursive_triggers=' + Number(recursive))
      const users = []
      for (const identity of identities) users.push((await source.findOrInsertUser(identity)).user.userId)
      await seedArchiveClosure(source, users[0], users[1])
      const originalSource = await k('sqlite_master')
        .whereIn('tbl_name', tables)
        .whereIn('type', ['table', 'index'])
        .orderBy('name')
      const mapping = new Map(
        Object.entries(legacyNames).map(([key, value]) => [value, names[key as keyof typeof names]])
      )
      const rebuilt = new Proxy(k, {
        apply(target, self, args: unknown[]) {
          if (typeof args[0] === 'string' && mapping.has(args[0])) args[0] = mapping.get(args[0])
          return Reflect.apply(target, self, args)
        }
      }) as Knex
      expect(
        await k('sqlite_master').whereIn('tbl_name', tables).whereIn('type', ['table', 'index']).orderBy('name')
      ).toEqual(originalSource)
      await exact(rebuilt)
      // Move both source rows of one profile, retaining all PKs and foreign keys.
      // Each REPLACE is legal with foreign_keys enabled; closure agrees at the end.
      for (const table of tables) {
        const rows = await k(table)
        for (const row of rows) {
          if ('userId' in row && row.userId === users[0]) row.userId = users[1]
          await replace(k, table, row)
          await exact(rebuilt)
        }
      }
      expect((await k.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(1)
      expect(await k.raw('PRAGMA foreign_key_check')).toEqual([])
      for (const [index, userId] of users.entries()) {
        for (const table of snapshotArchiveTables) {
          const name =
            (
              {
                provenTxs: 'proven_txs',
                provenTxReqs: 'proven_tx_reqs',
                outputBaskets: 'output_baskets',
                outputTags: 'output_tags',
                outputTagMaps: 'output_tags_map',
                txLabels: 'tx_labels',
                txLabelMaps: 'tx_labels_map',
                certificateFields: 'certificate_fields',
                syncStates: 'sync_states'
              } as Record<string, string>
            )[table] ?? table
          const direct = await walletSnapshotSourceQuery(k, table, userId).select(name + '.*')
          const indexed = await walletSnapshotSourceQuery(k, table, userId, 'v2', 'v2', 'v2', 'v2').select(name + '.*')
          const order = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort()
          expect(order(indexed)).toEqual(order(direct))
        }
        const ordinary = await pages(await source.openWalletReadSnapshot(identities[index]))
        const archive = await pages(await openKnexSnapshotArchiveSource(source, identities[index]))
        expect(Object.fromEntries(Object.entries(ordinary).map(([name, rows]) => [name, rows.length]))).toEqual(
          Object.fromEntries(Object.entries(archive).map(([name, rows]) => [name, rows.length]))
        )
      }
      // A secondary-unique conflict with no child rows may replace a different PK.
      const original = await k('sync_states').where('syncStateId', 1).first()
      await replace(k, 'sync_states', { ...original, syncStateId: 101 })
      expect(await k('sync_states').where('syncStateId', 1)).toEqual([])
      await exact(rebuilt)
    } finally {
      await source.destroy()
      await rm(directory, { recursive: true, force: true })
    }
  }
)
