import createKnex from 'knex'
import type { Knex } from 'knex'
import { readBrc38ImportSchemaFamily } from './Brc38ImportJournalSchemaBody'
import { isBrc38PublishedCopyInspection } from './Brc38PublishedProfileNode'
import { importJournalFixture } from './Brc38ImportJournalFixture'
import { verifyBrc38PublishedWallet } from './Brc38PublishedWalletNode'
import type { FixedProfile } from './Brc38PublishedProfileReceiptNode'

// Independently authored comparison DATA for the generic family verifier.
// A real SQLite transaction cannot manufacture published-copy membership.
const budget =
    'CREATE TABLE copy_fixture_budget (slot TEXT NOT NULL PRIMARY KEY, bytes INTEGER NOT NULL CHECK(bytes >= 0))',
  items = 'CREATE TABLE copy_fixture_items (id INTEGER PRIMARY KEY, value TEXT NOT NULL)',
  trigger =
    "CREATE TRIGGER copy_fixture_guard BEFORE UPDATE ON copy_fixture_budget BEGIN SELECT RAISE(ABORT, 'immutable'); END",
  legacy = new Map<string, { type: string; sql: string | null }>([
    ['copy_fixture_budget', { type: 'table', sql: budget }],
    ['copy_fixture_items', { type: 'table', sql: items }],
    ['sqlite_autoindex_copy_fixture_budget_1', { type: 'index', sql: null }],
    ['copy_fixture_guard', { type: 'trigger', sql: trigger }]
  ]),
  compact = ['copy_fixture_budget'],
  error = 'Exact copied metadata family differs'

async function database(work: (trx: Knex.Transaction) => Promise<void>): Promise<void> {
  const db = createKnex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await db.transaction(work)
  } finally {
    await db.destroy()
  }
}

test('an ordinary real SQLite owner cannot claim an occupied native compact family or copy actor', async () => {
  await database(async trx => {
    await trx.raw(budget + ' WITHOUT ROWID')
    await trx.raw(items)
    await trx.raw(trigger)
    expect(isBrc38PublishedCopyInspection(trx)).toBe(false)
    const before = await trx('main.sqlite_schema').select('*').orderBy('name')
    for (const fresh of [false, true])
      await expect(readBrc38ImportSchemaFamily(trx, legacy, compact, error, fresh)).rejects.toThrow(error)
    expect(await trx('main.sqlite_schema').select('*').orderBy('name')).toEqual(before)
  })
})

test.each(['missing-trigger', 'altered-trigger', 'extra-object', 'temporary-shadow'] as const)(
  'an exact legacy family still refuses %s without repairing or accepting its metadata',
  async kind => {
    await database(async trx => {
      await trx.raw(budget)
      await trx.raw(items)
      await trx.raw(trigger)
      expect(await readBrc38ImportSchemaFamily(trx, legacy, compact, error)).toEqual(legacy)
      if (kind === 'temporary-shadow') await trx.raw('CREATE TEMP TABLE copy_fixture_budget (shadow INTEGER)')
      else if (kind === 'extra-object') await trx.raw('CREATE INDEX copy_fixture_extra ON copy_fixture_items(value)')
      else {
        await trx.raw('DROP TRIGGER copy_fixture_guard')
        if (kind === 'altered-trigger') await trx.raw(trigger.replace("'immutable'", "'changed'"))
      }
      const main = await trx('main.sqlite_schema').select('*').orderBy('name'),
        temporary = await trx('sqlite_temp_schema').select('*').orderBy('name')
      await expect(readBrc38ImportSchemaFamily(trx, legacy, compact, error)).rejects.toThrow(error)
      expect(await trx('main.sqlite_schema').select('*').orderBy('name')).toEqual(main)
      expect(await trx('sqlite_temp_schema').select('*').orderBy('name')).toEqual(temporary)
      expect(isBrc38PublishedCopyInspection(trx)).toBe(false)
    })
  }
)

test('published wallet verification keeps the actual supplied transaction without opening a nested actor', async () => {
  const fixture = await importJournalFixture(0)
  try {
    await fixture.k.schema.createTable('users', table => {
      table.integer('userId')
      table.text('identityKey')
      table.text('activeStorage')
    })
    await fixture.k.schema.createTable('settings', table => {
      table.text('chain')
      table.text('storageIdentityKey')
    })
    await fixture.k('users').insert({ userId: 7, identityKey: 'synthetic identity', activeStorage: '' })
    await fixture.k('settings').insert({ chain: 'test', storageIdentityKey: 'synthetic target' })
    await fixture.prepare()
    const limits = JSON.parse(fixture.admission.originalLimitsJson) as number[],
      fixed: FixedProfile = {
        protocol: 'brc38-published-profile/v1',
        binding: {
          archiveSha256: 'b'.repeat(64),
          identityKey: 'synthetic identity',
          chain: 'test',
          sourceStorageIdentityKey: 'synthetic source',
          targetStorageIdentityKey: 'synthetic target',
          targetGeneration: 0
        },
        bindingSha256: fixture.admission.scope.bindingSha256,
        limits: {
          maximumRows: limits[0],
          maximumLogicalBytes: limits[1],
          maximumPhysicalBytes: limits[2],
          maximumRowBytes: limits[3],
          maximumRowAllocationBytes: limits[4],
          expiresAt: limits[5]
        },
        admission: fixture.admission
      }
    await fixture.k.transaction(async trx => {
      let nestedActors = 0
      const observe = (query: { sql: string }): void => {
        if (/^SAVEPOINT\b/i.test(query.sql)) nestedActors++
      }
      trx.on('query', observe)
      try {
        const before = await trx('brc38_import_journal').select('*')
        await verifyBrc38PublishedWallet(trx, fixed, 'READY')
        expect(nestedActors).toBe(0)
        expect(trx.isCompleted()).toBe(false)
        expect(await trx('brc38_import_journal').select('*')).toEqual(before)
      } finally {
        trx.removeListener('query', observe)
      }
    })
  } finally {
    await fixture.close()
  }
})
