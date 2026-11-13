// Enter through the public migration owner first to exercise its real circular
// import graph before private migration configuration is requested.
import {
  KnexMigrations,
  SNAPSHOT_PROFILE_INDEX_MIGRATION,
  SNAPSHOT_RELATION_INDEX_MIGRATION,
  SNAPSHOT_CERTIFICATE_INDEX_MIGRATION,
  SNAPSHOT_GLOBAL_INDEX_MIGRATION,
  SNAPSHOT_SQLITE_INDEX_MIGRATION,
  SNAPSHOT_JOURNAL_SOURCE_MIGRATION,
  INTERNALIZE_RECEIPT_MIGRATION,
  SNAPSHOT_SYNC_CONTENT_RECEIPT_MIGRATION,
  SNAPSHOT_JOURNAL_DATA_RECEIPT_MIGRATION
} from '../schema/KnexMigrations'
import { SNAPSHOT_JOURNAL_FIELD_CACHE_MIGRATION } from '../schema/snapshotSqlMigration'
import { knex } from 'knex'
import {
  nativeSnapshotJournalMappingDdl,
  readNativeSnapshotJournalMappingRevision,
  installNativeSnapshotJournalMappingSchema
} from '../snapshot/NativeSnapshotSyncMappingSchemaNode'
import { snapshotJournalIdentityLedgerDdl } from '../snapshot/journal/SnapshotJournalIdentityLedger'
import { snapshotJournalCapturedIdentitiesDdl } from '../snapshot/journal/SnapshotJournalCapturedIdentities'
import { brc38NativeLocalPackedLayoutMigration } from './Brc38NativeLocalPackedLayout'
import type { Knex } from 'knex'
import { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { createBrc38PrivateSchemaMigrationSource } from './Brc38PrivateSchemaMigrationNode'
import { previewPrivateFixture } from './Brc38ImportPreviewFixture'
import { runInSeries } from '../../utility/runInSeries'

const selectedMigrations = [
  SNAPSHOT_JOURNAL_FIELD_CACHE_MIGRATION,
  SNAPSHOT_JOURNAL_DATA_RECEIPT_MIGRATION,
  SNAPSHOT_SYNC_CONTENT_RECEIPT_MIGRATION,
  SNAPSHOT_PROFILE_INDEX_MIGRATION,
  SNAPSHOT_RELATION_INDEX_MIGRATION,
  SNAPSHOT_CERTIFICATE_INDEX_MIGRATION,
  SNAPSHOT_GLOBAL_INDEX_MIGRATION
]
function originalSource(store: KnexBrc38StagingStore) {
  return new KnexMigrations('test', 'Private schema proof', store.binding!.binding.targetStorageIdentityKey, 1024)
}
async function definitions(database: Knex) {
  return await database('sqlite_master').select('type', 'name', 'tbl_name', 'sql').orderBy('type').orderBy('name')
}
async function migrate(store: KnexBrc38StagingStore, source: KnexMigrations, adapted = true) {
  return await store.withAuthenticatedPrivateDestination(async () => {
    await store.knex.raw('PRAGMA foreign_keys = OFF')
    try {
      return await store.knex.migrate.latest({
        migrationSource: adapted ? createBrc38PrivateSchemaMigrationSource(store, source) : source,
        disableTransactions: false
      })
    } finally {
      await store.knex.raw('PRAGMA foreign_keys = ON')
    }
  })
}

describe('private native migration configuration preserves canonical schema and recovery', () => {
  let cleanup: Array<() => Promise<void>>
  beforeEach(() => {
    cleanup = []
  })
  afterEach(async () => {
    const results = await Promise.allSettled(cleanup.map(close => close())),
      errors = results.flatMap(result => (result.status === 'rejected' ? [result.reason] : []))
    if (errors.length) throw new AggregateError(errors, 'Private migration proof retains physical cleanup')
  })
  async function fixture() {
    // The complete canonical schema includes its journal triggers and migration ledger.
    // Keep the small default fixture for bounded exhaustion controls.
    const staged = await previewPrivateFixture(undefined, undefined, 65536, 8388608)
    cleanup.push(async () => await staged.close())
    return staged
  }
  test('only five copied configs change; callback identities, v2 and all public source configs stay original', async () => {
    const staged = await fixture(),
      store = staged.value.reservation.store,
      source = originalSource(store),
      original = { ...source.migrations },
      adapter = createBrc38PrivateSchemaMigrationSource(store, source),
      names = await source.getMigrations()
    expect(await adapter.getMigrations([])).toEqual(names)
    await runInSeries(names, async name => {
      const before = await source.getMigration(name),
        after = await adapter.getMigration(name)
      expect(adapter.getMigrationName(name)).toBe(source.getMigrationName(name))
      if (selectedMigrations.includes(name)) {
        expect(after).not.toBe(before)
        expect(after.up).toBe(before.up)
        expect(after.down).toBe(before.down)
        expect(Reflect.get(after, 'config')).toEqual({ ...before.config, transaction: true })
        expect(before.config).toEqual({ transaction: false })
      } else expect(after).toBe(before)
      expect(source.migrations[name]).toBe(original[name])
    })
    expect(source.migrations[SNAPSHOT_SQLITE_INDEX_MIGRATION].config).toEqual({
      transaction: false
    })
    await store.close()
    await expect(adapter.getMigrations([])).rejects.toThrow()
    await expect(adapter.getMigration(SNAPSHOT_PROFILE_INDEX_MIGRATION)).rejects.toThrow()
  })
  test('real fresh native databases retain exact DDL, migration names and empty standard-table rows', async () => {
    const baseline = await fixture(),
      candidate = await fixture(),
      previous = baseline.value.reservation.store,
      next = candidate.value.reservation.store,
      original = originalSource(previous),
      adapted = originalSource(next)
    await migrate(previous, original, false)
    await migrate(next, adapted)
    expect(await definitions(next.knex)).toEqual(await definitions(previous.knex))
    expect(await next.knex('knex_migrations').select('id', 'name', 'batch').orderBy('id')).toEqual(
      await previous.knex('knex_migrations').select('id', 'name', 'batch').orderBy('id')
    )
    await runInSeries(
      [
        'users',
        'transactions',
        'outputs',
        'certificates',
        'tx_labels',
        'output_baskets',
        'output_tags',
        'commissions',
        'sync_states',
        'snapshot_sync_content_receipts',
        'snapshot_sync_journal_data_receipts'
      ],
      async table => {
        expect(await next.knex(table)).toEqual(await previous.knex(table))
      }
    )
    expect((await next.knex.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(1)
    expect((await previous.knex.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(1)
  })
  test('private journal binds the original owned root across the actual Knex migration facade', async () => {
    const staged = await fixture(),
      store = staged.value.reservation.store,
      source = originalSource(store),
      original = await source.getMigration(SNAPSHOT_JOURNAL_SOURCE_MIGRATION),
      observed: Knex[] = []
    source.migrations[SNAPSHOT_JOURNAL_SOURCE_MIGRATION] = {
      ...original,
      up: async database => {
        observed.push(database)
        expect(database).toBe(store.knex)
        expect(database.isTransaction).not.toBe(true)
        await database.transaction(async trx => {
          await trx.schema.createTable('private_journal_root_proof', table => table.integer('id').primary())
          await trx('private_journal_root_proof').insert({ id: 1 })
        })
      }
    }
    const adapter = createBrc38PrivateSchemaMigrationSource(store, source, true),
      adapted = await adapter.getMigration(SNAPSHOT_JOURNAL_SOURCE_MIGRATION)
    expect(adapted.config).toEqual(original.config)
    expect(adapted.up).not.toBe(source.migrations[SNAPSHOT_JOURNAL_SOURCE_MIGRATION].up)
    const names = await adapter.getMigrations([])
    expect(names[names.length - 1]).toBe(SNAPSHOT_JOURNAL_SOURCE_MIGRATION)
    await store.withAuthenticatedPrivateDestination(async () => {
      await store.knex.raw('PRAGMA foreign_keys = OFF')
      try {
        await store.knex.migrate.latest({ migrationSource: adapter, disableTransactions: false })
      } finally {
        await store.knex.raw('PRAGMA foreign_keys = ON')
      }
    })
    expect(observed).toEqual([store.knex])
    expect(await store.knex('private_journal_root_proof')).toEqual([{ id: 1 }])
    expect((await store.knex('knex_migrations').select('name').orderBy('id')).map(row => row.name)).toEqual(names)
    await store.close()
    await expect(adapted.up(store.knex)).rejects.toThrow('Private import ownership is unavailable or expired')
    expect(observed).toHaveLength(1)
  })
  test('fresh local layout receives the original named receipt migration before its table check', async () => {
    const staged = await fixture()
    const store = staged.value.reservation.store
    const source = originalSource(store)
    const receipt = source.migrations[INTERNALIZE_RECEIPT_MIGRATION]
    const layout = {
      up: async (database: Knex) => {
        expect(await database.schema.hasTable('internalize_receipts')).toBe(true)
        expect(await database('internalize_receipts')).toEqual([])
      },
      down: async () => {
        throw new Error('Independent fresh-layout fixture requires forward cleanup')
      }
    }
    source.migrations[brc38NativeLocalPackedLayoutMigration] = layout
    source.migrations[SNAPSHOT_JOURNAL_SOURCE_MIGRATION] = {
      ...source.migrations[SNAPSHOT_JOURNAL_SOURCE_MIGRATION],
      up: async () => {}
    }
    const originalNames = await source.getMigrations()
    expect(originalNames.indexOf(INTERNALIZE_RECEIPT_MIGRATION)).toBeGreaterThan(
      originalNames.indexOf(brc38NativeLocalPackedLayoutMigration)
    )
    const ordinary = createBrc38PrivateSchemaMigrationSource(store, source)
    expect(await ordinary.getMigrations([])).toEqual(originalNames)
    const adapted = createBrc38PrivateSchemaMigrationSource(store, source, true)
    const names = await adapted.getMigrations([])
    expect(names.indexOf(INTERNALIZE_RECEIPT_MIGRATION)).toBe(names.indexOf(brc38NativeLocalPackedLayoutMigration) - 1)
    expect(names.filter(name => name === INTERNALIZE_RECEIPT_MIGRATION)).toHaveLength(1)
    expect(names.at(-1)).toBe(SNAPSHOT_JOURNAL_SOURCE_MIGRATION)
    expect(await adapted.getMigration(INTERNALIZE_RECEIPT_MIGRATION)).toBe(receipt)
    expect(await adapted.getMigration(brc38NativeLocalPackedLayoutMigration)).toBe(layout)
    expect(await source.getMigrations()).toEqual(originalNames)
    await store.withAuthenticatedPrivateDestination(async () => {
      await store.knex.raw('PRAGMA foreign_keys=OFF')
      try {
        await store.knex.migrate.latest({ migrationSource: adapted, disableTransactions: false })
      } finally {
        await store.knex.raw('PRAGMA foreign_keys=ON')
      }
    })
    expect((await store.knex('knex_migrations').select('name').orderBy('id')).map(row => row.name)).toEqual(names)
  })
  test('missing receipt dependency refuses before a fresh layout migration can run', async () => {
    const staged = await fixture()
    const store = staged.value.reservation.store
    const source = originalSource(store)
    const layout = jest.fn(async () => {})
    source.migrations[brc38NativeLocalPackedLayoutMigration] = { up: layout }
    delete source.migrations[INTERNALIZE_RECEIPT_MIGRATION]
    const before = await definitions(store.knex)
    await expect(createBrc38PrivateSchemaMigrationSource(store, source, true).getMigrations([])).rejects.toThrow(
      'Fresh private local layout requires the durable receipt migration'
    )
    expect(layout).not.toHaveBeenCalled()
    expect(await definitions(store.knex)).toEqual(before)
  })
  test.each(selectedMigrations)(
    '%s rolls back its own DDL and progress, then native replacement retries the original journal',
    async selected => {
      const staged = await fixture(),
        store = staged.value.reservation.store,
        source = originalSource(store),
        original = await source.getMigration(selected),
        cause = new Error('Synthetic selected migration rollback'),
        names = await source.getMigrations(),
        earlier = names.slice(0, names.indexOf(selected))
      let before: Awaited<ReturnType<typeof definitions>> | undefined
      source.migrations[selected] = {
        ...original,
        up: async database => {
          before = await definitions(database)
          await original.up(database)
          throw cause
        }
      }
      await expect(migrate(store, source)).rejects.toBe(cause)
      expect(before).toBeDefined()
      expect(await definitions(store.knex)).toEqual(before)
      const journal = await store.knex('knex_migrations').select('id', 'name', 'batch').orderBy('id')
      expect(journal.map(row => row.name)).toEqual(earlier)
      expect((await store.knex('knex_migrations_lock').first()).is_locked).toBe(0)
      expect((await store.knex.raw('PRAGMA foreign_keys'))[0].foreign_keys).toBe(1)
      const admittedExpiry = staged.selected.limits.expiresAt
      await store.close()
      const resumed = await staged.root.resume(
        staged.value.reservation.id,
        staged.selected.limits,
        staged.selected.binding
      )
      staged.held.push(resumed)
      expect(resumed.store.knex).not.toBe(store.knex)
      expect(resumed.store.binding).toEqual(store.binding)
      expect(staged.selected.limits.expiresAt).toBe(admittedExpiry)
      expect(await definitions(resumed.store.knex)).toEqual(before)
      expect(await resumed.store.knex('knex_migrations').select('id', 'name', 'batch').orderBy('id')).toEqual(journal)
      const replacementSource = originalSource(resumed.store)
      await migrate(resumed.store, replacementSource)
      expect((await resumed.store.knex('knex_migrations').select('name').orderBy('id')).map(row => row.name)).toEqual(
        names
      )
      expect(
        await resumed.store.knex('knex_migrations').whereIn('name', earlier).select('id', 'name', 'batch').orderBy('id')
      ).toEqual(journal)
      await expect(migrate(resumed.store, replacementSource)).resolves.toEqual([2, []])
      expect(replacementSource.migrations[selected].config).toEqual({ transaction: false })
    }
  )
  test('fake, unclaimed, non-native and transactional inputs refuse before consulting migration metadata', async () => {
    const staged = await fixture(),
      store = staged.value.reservation.store,
      source = originalSource(store),
      getMigrations = jest.spyOn(source, 'getMigrations'),
      unowned = await KnexBrc38StagingStore.create(staged.directory, staged.selected.limits)
    cleanup.unshift(async () => await unowned.close())
    expect(() => createBrc38PrivateSchemaMigrationSource({} as KnexBrc38StagingStore, source)).toThrow(
      'actual private staging store'
    )
    expect(() => createBrc38PrivateSchemaMigrationSource(unowned, source)).toThrow('actual claimed private stage')
    const config = store.knex.client.config,
      client = config.client
    config.client = 'mysql2'
    try {
      expect(() => createBrc38PrivateSchemaMigrationSource(store, source)).toThrow('original native SQLite pool')
    } finally {
      config.client = client
    }
    const transaction = Object.getOwnPropertyDescriptor(store.knex, 'isTransaction')
    Object.defineProperty(store.knex, 'isTransaction', { configurable: true, value: true })
    try {
      expect(() => createBrc38PrivateSchemaMigrationSource(store, source)).toThrow('original native SQLite pool')
    } finally {
      if (transaction === undefined) Reflect.deleteProperty(store.knex, 'isTransaction')
      else Object.defineProperty(store.knex, 'isTransaction', transaction)
    }
    expect(getMigrations).not.toHaveBeenCalled()
  })

  test('complete canonical schema fits an explicit physical allowance measured above the small fixture', async () => {
    const staged = await fixture(),
      small = await previewPrivateFixture(),
      store = staged.value.reservation.store
    cleanup.push(async () => await small.close())
    await migrate(store, originalSource(store))
    const pageSize = Number((await store.knex.raw('PRAGMA page_size'))[0].page_size),
      pageCount = Number((await store.knex.raw('PRAGMA page_count'))[0].page_count),
      maximumPageCount = Number((await store.knex.raw('PRAGMA max_page_count'))[0].max_page_count),
      mainDatabaseBytes = pageSize * pageCount,
      smallMaximumPageCount = Number(
        (await small.value.reservation.store.knex.raw('PRAGMA max_page_count'))[0].max_page_count
      ),
      smallMainDatabaseLimitBytes = pageSize * smallMaximumPageCount,
      physicalAllowance = staged.selected.limits.maximumPhysicalBytes
    expect(Number.isSafeInteger(mainDatabaseBytes)).toBe(true)
    expect(mainDatabaseBytes).toBeGreaterThan(smallMainDatabaseLimitBytes)
    expect(mainDatabaseBytes).toBeLessThanOrEqual(physicalAllowance)
    expect(maximumPageCount * pageSize * 3).toBeLessThanOrEqual(physicalAllowance)
    expect(mainDatabaseBytes).toBeLessThan(maximumPageCount * pageSize)
    expect(small.selected.limits.maximumPhysicalBytes).toBe(4194304)
    expect(staged.selected.limits.maximumRowBytes).toBe(65536)
    expect(staged.selected.limits.maximumRowAllocationBytes).toBe(65536)
    process.stdout.write(
      JSON.stringify({
        stage: 'private-migration-full-schema-capacity',
        pageSize,
        pageCount,
        maximumPageCount,
        mainDatabaseBytes,
        smallMaximumPageCount,
        smallMainDatabaseLimitBytes,
        physicalAllowance,
        mainPageCeilingBytes: maximumPageCount * pageSize,
        remainingMainFileBytes: maximumPageCount * pageSize - mainDatabaseBytes,
        productionQualification: false
      }) + '\n'
    )
  })
})

test('journal mapping DDL observes real parent/capture changes, rollback and exhaustion without financial events or native admission', async () => {
  const database = knex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    }),
    clock = 'brc38_journal_mapping_clock',
    maps = 'snapshot_reconciliation_identity_maps',
    captured = 'snapshot_reconciliation_captured_identities',
    frames = 'snapshot_reconciliation_identity_frames',
    parent = {
      userId: 1,
      lineage: 'a'.repeat(64),
      tableId: 9,
      incomingId: 17,
      generation: '1',
      naturalIdentity: 'b'.repeat(64),
      localId: 71,
      sourceGeneration: 'c'.repeat(64),
      seenSession: 'd'.repeat(64)
    },
    identity = {
      userId: 1,
      sourceStorageIdentity: 'source',
      sessionId: 'd'.repeat(64),
      binding: 'e'.repeat(64),
      frameDigest: 'f'.repeat(64),
      changeIndex: 0,
      tableId: 0,
      incomingId: 17,
      generation: '1',
      naturalIdentity: 'b'.repeat(64),
      naturalKeyJson: '{}',
      required: 1
    },
    frame = {
      userId: 1,
      sourceStorageIdentity: 'source',
      sessionId: 'd'.repeat(64),
      binding: 'e'.repeat(64),
      frameDigest: 'f'.repeat(64),
      windowSequence: 1,
      identities: 1,
      sealed: 1,
      changes: 1
    },
    revision = async (): Promise<string> =>
      String((await database(clock).first(database.raw('CAST(revision AS TEXT) AS revision'))).revision)
  try {
    for (const sql of [
      ...snapshotJournalIdentityLedgerDdl(database),
      ...snapshotJournalCapturedIdentitiesDdl(database),
      ...nativeSnapshotJournalMappingDdl
    ])
      await database.raw(sql)
    await database(clock).insert({ id: 1, revision: 0 })
    await database.raw('CREATE TABLE snapshot_journal_clock(id INTEGER PRIMARY KEY,ceiling INTEGER NOT NULL)')
    await database('snapshot_journal_clock').insert({ id: 1, ceiling: 37 })
    // Stock SQLite can test DDL semantics but cannot enroll as the actual native reader or installer.
    await database.transaction(async trx => {
      await expect(readNativeSnapshotJournalMappingRevision(trx)).rejects.toThrow()
      await expect(installNativeSnapshotJournalMappingSchema(trx)).rejects.toThrow()
    })
    await database(maps).insert(parent)
    expect(await revision()).toBe('0')
    await database(maps).update({ tableId: 0 })
    expect(await revision()).toBe('1')
    await database(maps).update({ localId: 72 })
    expect(await revision()).toBe('2')
    await database(maps).update({ tableId: 9 })
    expect(await revision()).toBe('3')
    await database(maps).update({ localId: 73 })
    await database(maps).delete()
    expect(await revision()).toBe('3')
    await database(maps).insert({ ...parent, tableId: 0 })
    await database(maps).delete()
    expect(await revision()).toBe('5')
    await database(maps).insert({ ...parent, tableId: 8 })
    await database(maps).update({ localId: 74 })
    await database(maps).delete()
    expect(await revision()).toBe('8')
    await database(captured).insert(identity)
    await database(captured).update({ naturalKeyJson: '{"changed":true}' })
    await database(captured).delete()
    expect(await revision()).toBe('11')
    await database(frames).insert(frame)
    await database(frames).update({ sealed: 0 })
    await database(frames).delete()
    expect(await revision()).toBe('14')
    const rollback = new Error('Independent mapping transaction rollback')
    await expect(
      database.transaction(async trx => {
        await trx(maps).insert({ ...parent, tableId: 0 })
        const row = await trx(clock).first(trx.raw('CAST(revision AS TEXT) AS revision'))
        expect(row.revision).toBe('15')
        throw rollback
      })
    ).rejects.toBe(rollback)
    expect(await revision()).toBe('14')
    expect(await database(maps)).toHaveLength(0)
    await database(clock).delete()
    await expect(database(maps).insert({ ...parent, tableId: 0 })).rejects.toThrow('exhausted or absent')
    expect(await database(maps)).toHaveLength(0)
    await database(clock).insert({ id: 1, revision: database.raw('9223372036854775806') })
    await database(maps).insert({ ...parent, tableId: 0 })
    expect(await revision()).toBe('9223372036854775807')
    await expect(database(maps).update({ localId: 75 })).rejects.toThrow('exhausted or absent')
    expect((await database(maps).first()).localId).toBe(71)
    expect((await database('snapshot_journal_clock').first()).ceiling).toBe(37)
  } finally {
    await database.destroy()
  }
})
