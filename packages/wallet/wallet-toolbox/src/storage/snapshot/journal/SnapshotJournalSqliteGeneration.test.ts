import { migrateBeforeSnapshotJournal } from '../../../../test/utils/snapshotJournalHistoricalFixture'
import * as observers from './SnapshotJournalSqliteObservers'
import { knex, type Knex } from 'knex'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { seedArchiveClosure } from '../../../../test/utils/snapshotArchiveFixtures'
import {
  installSnapshotJournalSqliteGeneration,
  readSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration,
  readBoundedSnapshotJournalSqliteSchema,
  SNAPSHOT_JOURNAL_SQLITE_GENERATION as metadata
} from './SnapshotJournalSqliteGeneration'
import { copySnapshotJournalBootstrapPage } from './SnapshotJournalBootstrap'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'

const journalReceiptPolicy = { receiptLimit: 128, receiptLifetimeMs: 2592000000 }

test('bounded schema reads preserve complete UTF-8, literal whitespace, null SQL and order', async () => {
  const k = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await k.raw('CREATE TABLE users(id INTEGER PRIMARY KEY, identityKey TEXT UNIQUE)')
    for (let index = 0; index < 3; index++) {
      const prefix = `CREATE TRIGGER unicode_${index} AFTER INSERT ON users BEGIN SELECT '`
      await k.raw(
        prefix + 'a'.repeat(16383 - Buffer.byteLength(prefix, 'utf8')) + `🙂\n a  b ${'é'.repeat(21000)}'; END`
      )
    }
    const expected = await k('sqlite_master')
      .where('tbl_name', 'users')
      .select('type', 'name', 'tbl_name', 'sql')
      .orderBy(['type', 'name'])
    expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBeGreaterThan(131072)
    expect(expected.some(row => row.sql === null)).toBe(true)
    await k.transaction(async trx => {
      expect(await readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).toEqual(expected)
      const rollback = new Error('independent schema rollback')
      await expect(
        trx.transaction(async nested => {
          await nested.raw('DROP TRIGGER unicode_1')
          expect(await readBoundedSnapshotJournalSqliteSchema(nested, ['users'])).toEqual(
            expected.filter(row => row.name !== 'unicode_1')
          )
          throw rollback
        })
      ).rejects.toBe(rollback)
      expect(await readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).toEqual(expected)
    })
    await expect(readBoundedSnapshotJournalSqliteSchema(k as Knex.Transaction, ['users'])).rejects.toThrow(
      'Invalid or unowned'
    )
  } finally {
    await k.destroy()
  }
})

test.each([65536, 65537])('bounded schema retains the original %i-byte definition boundary', async bytes => {
  const k = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await k.raw('CREATE TABLE users(id INTEGER)')
    const prefix = "CREATE TRIGGER byte_boundary AFTER INSERT ON users BEGIN SELECT '🙂",
      suffix = "'; END",
      sql = prefix + 'x'.repeat(bytes - Buffer.byteLength(prefix + suffix, 'utf8')) + suffix
    await k.raw(sql)
    await k.transaction(async trx => {
      if (bytes === 65536)
        expect(
          (await readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).find(row => row.name === 'byte_boundary')?.sql
        ).toBe(sql)
      else await expect(readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).rejects.toThrow('Invalid or unowned')
    })
  } finally {
    await k.destroy()
  }
})

let ceiling: SnapshotJournalRevision
beforeEach(() => {
  ceiling = snapshotJournalRevision('1000000')
})
async function fixture() {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  try {
    await migrateBeforeSnapshotJournal(source, 'journal lifecycle', 'synthetic-journal-lifecycle')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32)),
      { user: foreign } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(source, user.userId, foreign.userId)
    return { k, source }
  } catch (error) {
    await source.destroy()
    throw error
  }
}
async function finish(k: Knex) {
  for (let page = 0; page < 80; page++) if ((await copySnapshotJournalBootstrapPage(k, 1000000)).complete) return
  throw new Error('bootstrap did not finish')
}

test('atomic installation resumes its epoch and publishes only completed durable bootstrap', async () => {
  const { k, source } = await fixture()
  try {
    const rows = await k('transactions'),
      installed = await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
    expect(installed).toMatchObject({ complete: false, enabled: true, ceiling })
    expect(installed.epoch).toMatch(/^[0-9a-f-]{36}$/)
    await expect(completeSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).rejects.toThrow('Invalid or unowned')
    await copySnapshotJournalBootstrapPage(k, 1000000)
    const progress = await k('snapshot_journal_bootstrap').first()
    expect(await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).toEqual(installed)
    expect(await k('snapshot_journal_bootstrap').first()).toEqual(progress)
    await finish(k)
    expect(await readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).toEqual(installed)
    expect(await completeSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).toEqual({
      ...installed,
      complete: true
    })
    expect(await readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).toEqual({ ...installed, complete: true })
    expect(await k('transactions')).toEqual(rows)
  } finally {
    await source.destroy()
  }
})
test.each([
  'CREATE TABLE snapshot_journal_clock(id INTEGER)',
  'CREATE VIEW snapshot_journal_scope_0_INSERT AS SELECT 1',
  'CREATE INDEX snapshot_journal_foreign ON users(identityKey)',
  "CREATE TRIGGER snapshot_journal_foreign AFTER INSERT ON users BEGIN SELECT 'foreign'; END"
])('first installation refuses unrelated reserved objects: %s', async ddl => {
  const { k, source } = await fixture()
  try {
    await k.raw(ddl)
    const before = await k('sqlite_master').orderBy(['type', 'name'])
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).rejects.toThrow(
      'Invalid or unowned'
    )
    expect(await k('sqlite_master').orderBy(['type', 'name'])).toEqual(before)
  } finally {
    await source.destroy()
  }
})
test.each(['observer', 'index', 'same-name view', 'unknown reserved'])(
  'resume refuses %s ownership drift without source mutation',
  async kind => {
    const { k, source } = await fixture()
    try {
      await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
      if (kind === 'observer') await k.raw('DROP TRIGGER snapshot_journal_scope_0_INSERT')
      if (kind === 'index') await k.raw('DROP INDEX snapshot_journal_scope_page')
      if (kind === 'same-name view') await k.raw('CREATE VIEW snapshot_journal_scope_0_INSERT AS SELECT 1')
      if (kind === 'unknown reserved') await k.raw('CREATE TABLE snapshot_journal_foreign(id INTEGER)')
      const before = await k('sqlite_master').orderBy(['type', 'name']),
        rows = await k('transactions')
      await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).rejects.toThrow(
        'Invalid or unowned'
      )
      expect(await k('sqlite_master').orderBy(['type', 'name'])).toEqual(before)
      expect(await k('transactions')).toEqual(rows)
    } finally {
      await source.destroy()
    }
  }
)
test('complete source binding includes user observers and preserves literal whitespace', async () => {
  const { k, source } = await fixture()
  try {
    await k.raw("CREATE TRIGGER application_user AFTER INSERT ON users BEGIN SELECT 'a  b'; END")
    await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
    await k.raw('DROP TRIGGER application_user')
    await k.raw("CREATE TRIGGER application_user AFTER INSERT ON users BEGIN SELECT 'a b'; END")
    await expect(readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).rejects.toThrow('Invalid or unowned')
  } finally {
    await source.destroy()
  }
})
test.each([
  'metadata missing',
  'metadata epoch',
  'metadata source',
  'metadata ceiling',
  'clock missing',
  'clock ceiling',
  'bootstrap missing',
  'bootstrap extra',
  'bootstrap cursor',
  'false completion'
])('persisted %s damage refuses', async kind => {
  const { k, source } = await fixture()
  try {
    await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
    if (kind === 'metadata missing') await k(metadata).delete()
    if (kind === 'metadata epoch') await k(metadata).update({ epoch: 'foreign' })
    if (kind === 'metadata source') await k(metadata).update({ source: '0'.repeat(64) })
    if (kind === 'metadata ceiling') await k(metadata).update({ ceiling: '01' })
    if (kind === 'clock missing') await k('snapshot_journal_clock').delete()
    if (kind === 'clock ceiling') await k('snapshot_journal_clock').update({ ceiling: 999 })
    if (kind === 'bootstrap missing') await k('snapshot_journal_bootstrap').delete()
    if (kind === 'bootstrap extra') await k('snapshot_journal_bootstrap').update({ stream: 0.5 })
    if (kind === 'bootstrap cursor') await k('snapshot_journal_bootstrap').update({ cursor: 'x'.repeat(2049) })
    if (kind === 'false completion') await k(metadata).update({ complete: 1 })
    await expect(readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).rejects.toThrow()
  } finally {
    await source.destroy()
  }
})
test('configured event exhaustion preserves source writes and refuses completion', async () => {
  const { k, source } = await fixture()
  try {
    const installed = await installSnapshotJournalSqliteGeneration(
      k,
      snapshotJournalRevision('1'),
      journalReceiptPolicy
    )
    await k('tx_labels').where('txLabelId', 1).update({ label: 'first' })
    await k('tx_labels').where('txLabelId', 1).update({ label: 'ordinary after exhaustion' })
    expect((await k('tx_labels').where('txLabelId', 1).first()).label).toBe('ordinary after exhaustion')
    expect(await readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).toEqual({ ...installed, enabled: false })
    await k('snapshot_journal_bootstrap').update({ stream: 17, cursor: null, rowLimit: 1000000 })
    await expect(completeSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).rejects.toThrow('Invalid or unowned')
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).rejects.toThrow(
      'Invalid or unowned'
    )
  } finally {
    await source.destroy()
  }
})
test.each([
  'CREATE TABLE snapshot_journal_scope',
  'CREATE TRIGGER snapshot_journal_physical_12_DELETE',
  'insert into `snapshot_journal_generation`'
])('failure during %s rolls back every installation object', async point => {
  const { k, source } = await fixture()
  try {
    const before = await k('sqlite_master').orderBy(['type', 'name']),
      failure = new Error('synthetic installation failure')
    const listener = (query: { sql: string }) => {
      if (query.sql.startsWith(point)) throw failure
    }
    k.on('query', listener)
    try {
      await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).rejects.toBe(failure)
    } finally {
      k.off('query', listener)
    }
    expect(await k('sqlite_master').orderBy(['type', 'name'])).toEqual(before)
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).resolves.toMatchObject({
      complete: false,
      enabled: true
    })
  } finally {
    await source.destroy()
  }
})
test('completion rollback retains the unfinished generation and can resume', async () => {
  const { k, source } = await fixture()
  try {
    const installed = await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
    await finish(k)
    const failure = new Error('synthetic completion failure'),
      listener = (query: { sql: string }) => {
        if (query.sql.startsWith('update `snapshot_journal_generation`')) throw failure
      }
    k.on('query', listener)
    try {
      await expect(completeSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).rejects.toBe(failure)
    } finally {
      k.off('query', listener)
    }
    expect(await readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).toEqual(installed)
    await expect(completeSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).resolves.toMatchObject({
      complete: true
    })
  } finally {
    await source.destroy()
  }
})
test('unsupported client and missing published SQLite prerequisites refuse before installation', async () => {
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  try {
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).rejects.toThrow(
      'Invalid or unowned'
    )
    expect(await k('sqlite_master')).toEqual([])
    k.client.config.client = 'mysql2'
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).rejects.toThrow(
      'Invalid or unowned'
    )
  } finally {
    await k.destroy()
  }
})

test.each(['zero ceiling', 'invalid clock reason', 'replaced observer'])(
  'owned generation refuses incompatible persisted %s',
  async kind => {
    const { k, source } = await fixture()
    try {
      await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
      if (kind === 'zero ceiling') await k(metadata).update({ ceiling: '0' })
      if (kind === 'invalid clock reason') {
        await k.raw('PRAGMA ignore_check_constraints=ON')
        await k('snapshot_journal_clock').update({ reason: 'unexpected' })
        await k.raw('PRAGMA ignore_check_constraints=OFF')
      }
      if (kind === 'replaced observer') {
        await k.raw('DROP TRIGGER snapshot_journal_scope_0_INSERT')
        await k.raw('CREATE TRIGGER snapshot_journal_scope_0_INSERT AFTER INSERT ON transactions BEGIN SELECT 1; END')
      }
      const before = await k('transactions')
      await expect(readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).rejects.toThrow('Invalid or unowned')
      expect(await k('transactions')).toEqual(before)
    } finally {
      await source.destroy()
    }
  }
)
test.each(['rows', 'definition', 'aggregate'])('source binding refuses an oversized native schema %s', async kind => {
  const { k, source } = await fixture()
  try {
    if (kind === 'rows') {
      for (let i = 0; i < 513; i++) await k.raw('CREATE INDEX ?? ON users(identityKey)', ['application_index_' + i])
    } else {
      const count = kind === 'aggregate' ? 20 : 1
      const literal = 'x'.repeat(kind === 'aggregate' ? 60000 : 65536)
      for (let i = 0; i < count; i++)
        await k.raw(
          'CREATE TRIGGER application_observer_' + i + " AFTER UPDATE ON users BEGIN SELECT '" + literal + "'; END"
        )
    }
    const before = await k('sqlite_master').select('type', 'name', 'sql').orderBy(['type', 'name'])
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).rejects.toThrow(
      'Invalid or unowned'
    )
    await k.transaction(async trx => {
      await expect(readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).rejects.toThrow('Invalid or unowned')
    })
    expect(await k('sqlite_master').select('type', 'name', 'sql').orderBy(['type', 'name'])).toEqual(before)
  } finally {
    await source.destroy()
  }
})

test('invalid generated DDL cannot enter the persisted SQLite ownership plan', async () => {
  const { k, source } = await fixture()
  const spy = jest
    .spyOn(observers, 'snapshotJournalSqliteObserverSql')
    .mockResolvedValue(['CREATE TABLE application_table(id INTEGER)'])
  try {
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).rejects.toThrow(
      'Invalid or unowned'
    )
    expect(await k('sqlite_master').where('name', 'application_table')).toEqual([])
  } finally {
    spy.mockRestore()
    await source.destroy()
  }
})
test.each(['users', 'settings'])('source metadata must include %s in the ownership binding', async table => {
  const { k, source } = await fixture()
  let altered = false
  const listener = (rows: Array<{ type: string; name: string }>, query: { sql: string }) => {
    if (query.sql.includes('substr(sql,1,65537) AS sql') && query.sql.includes('where `tbl_name` in')) {
      const index = rows.findIndex(row => row.type === 'table' && row.name === table)
      expect(index).toBeGreaterThanOrEqual(0)
      rows.splice(index, 1)
      altered = true
    }
  }
  k.on('query-response', listener)
  try {
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)).rejects.toThrow(
      'Invalid or unowned'
    )
    expect(altered).toBe(true)
  } finally {
    k.off('query-response', listener)
    await source.destroy()
  }
})

test('legacy SQLite alias preserves installation identity through completion', async () => {
  const { k, source } = await fixture()
  k.client.config.client = 'sqlite3'
  try {
    const installed = await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
    await finish(k)
    expect(await completeSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).toEqual({
      ...installed,
      complete: true
    })
    expect(await readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).toEqual({ ...installed, complete: true })
  } finally {
    await source.destroy()
  }
})

test.each(['install', 'read', 'complete'])(
  'SQLite generation %s refuses a foreign client before I/O',
  async operation => {
    const transaction = jest.fn(),
      raw = jest.fn()
    const k = { client: { config: { client: 'mysql2' } }, transaction, raw } as unknown as Knex
    const operations = {
      install: () => installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy),
      read: () => readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy),
      complete: () => completeSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)
    }
    const result = operations[operation as keyof typeof operations]()
    await expect(result).rejects.toThrow('Invalid or unowned SQLite snapshot journal generation')
    expect(transaction).not.toHaveBeenCalled()
    expect(raw).not.toHaveBeenCalled()
  }
)

test('empty SQLite generation event window refuses before transaction admission', async () => {
  const transaction = jest.fn(),
    k = { client: { config: { client: 'sqlite3' } }, transaction } as unknown as Knex
  await expect(
    installSnapshotJournalSqliteGeneration(k, snapshotJournalRevision('0'), journalReceiptPolicy)
  ).rejects.toThrow('Invalid or unowned SQLite snapshot journal generation')
  expect(transaction).not.toHaveBeenCalled()
})

test.each(['prefix', 'suffix'])(
  'SQLite generation rejects an epoch with a valid UUID only as a %s substring',
  async side => {
    const { k, source } = await fixture()
    try {
      const installed = await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
      await k(metadata).update({
        epoch: side === 'prefix' ? installed.epoch + 'x' : 'x' + installed.epoch
      })
      await expect(readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).rejects.toThrow(
        'Invalid or unowned SQLite snapshot journal generation'
      )
    } finally {
      await source.destroy()
    }
  }
)

test.each(['revision-exhausted', 'key-out-of-range'])(
  'SQLite %s state remains readable but cannot publish completion',
  async reason => {
    const { k, source } = await fixture()
    try {
      const installed = await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
      await k('snapshot_journal_clock').update({ enabled: 0, reason })
      expect(await readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).toEqual({
        ...installed,
        enabled: false
      })
      await expect(completeSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).rejects.toThrow(
        'Invalid or unowned SQLite snapshot journal generation'
      )
    } finally {
      await source.destroy()
    }
  }
)

test('receipt policy is explicit, detached and immutable throughout generation resume', async () => {
  const { k, source } = await fixture()
  try {
    const policy = { receiptLimit: 2, receiptLifetimeMs: 1000 }
    const opening = installSnapshotJournalSqliteGeneration(k, ceiling, policy)
    policy.receiptLimit = 3
    const installed = await opening
    const original = { receiptLimit: 2, receiptLifetimeMs: 1000 }
    expect(await k('snapshot_journal_retention').first()).toEqual({ id: 1, floor: '0', ...original })
    expect(await installSnapshotJournalSqliteGeneration(k, ceiling, original)).toEqual(installed)
    for (const changed of [policy, { ...original, receiptLifetimeMs: 1001 }]) {
      await expect(installSnapshotJournalSqliteGeneration(k, ceiling, changed)).rejects.toThrow('Invalid or unowned')
      await expect(readSnapshotJournalSqliteGeneration(k, changed)).rejects.toThrow('Invalid or unowned')
      await expect(completeSnapshotJournalSqliteGeneration(k, changed)).rejects.toThrow('Invalid or unowned')
    }
    expect(await k('snapshot_journal_retention').first()).toEqual({ id: 1, floor: '0', ...original })
  } finally {
    await source.destroy()
  }
})

test.each([
  null,
  undefined,
  [],
  {},
  { receiptLimit: 0, receiptLifetimeMs: 1 },
  { receiptLimit: 129, receiptLifetimeMs: 1 },
  { receiptLimit: 1.5, receiptLifetimeMs: 1 },
  { receiptLimit: 1, receiptLifetimeMs: 0 },
  { receiptLimit: 1, receiptLifetimeMs: 2592000001 },
  { receiptLimit: 1, receiptLifetimeMs: NaN }
])('invalid receipt installation policy %p fails before source access', async policy => {
  const k = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  const queries: string[] = []
  k.on('query', (query: { sql: string }) => queries.push(query.sql))
  try {
    await expect(
      installSnapshotJournalSqliteGeneration(k, ceiling, policy as typeof journalReceiptPolicy)
    ).rejects.toThrow()
    await expect(readSnapshotJournalSqliteGeneration(k, policy as typeof journalReceiptPolicy)).rejects.toThrow()
    await expect(completeSnapshotJournalSqliteGeneration(k, policy as typeof journalReceiptPolicy)).rejects.toThrow()
    expect(queries).toEqual([])
  } finally {
    await k.destroy()
  }
})

test('generation validates the receipt floor and capacity with bounded metadata reads', async () => {
  const { k, source } = await fixture(),
    policy = { receiptLimit: 2, receiptLifetimeMs: 1000 }
  try {
    await installSnapshotJournalSqliteGeneration(k, ceiling, policy)
    const baseline = await k('transactions')
    for (const floor of ['01', '9223372036854775807']) {
      await k('snapshot_journal_retention').update({ floor })
      await expect(readSnapshotJournalSqliteGeneration(k, policy)).rejects.toThrow()
    }
    await k('snapshot_journal_retention').update({ floor: '0' })
    await k('snapshot_journal_receipts').insert(
      [1, 2, 3].map(id => ({
        requestId: id.toString(16).padStart(64, '0'),
        binding: 'a'.repeat(64),
        highWater: '1',
        floor: '0',
        expiresAt: 1
      }))
    )
    await expect(readSnapshotJournalSqliteGeneration(k, policy)).rejects.toThrow('Invalid or unowned')
    await k('snapshot_journal_receipts').where('requestId', '3'.padStart(64, '0')).delete()
    expect((await readSnapshotJournalSqliteGeneration(k, policy)).enabled).toBe(true)
    expect(await k('transactions')).toEqual(baseline)
  } finally {
    await source.destroy()
  }
})

test.each(['clock-shared', 'effects-shared', 'events-shared', 'sources-shared'] as const)(
  '%s journal SQL preserves all thirteen physical streams, owner moves, clock exhaustion and rollback',
  async layout => {
    const legacy = await fixture()
    let compact: Awaited<ReturnType<typeof fixture>> | undefined
    const { SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL } = await import('./SnapshotJournalSqliteClock')
    const tables = [
      'transactions',
      'outputs',
      'certificates',
      'tx_labels',
      'output_baskets',
      'output_tags',
      'commissions',
      'sync_states',
      'proven_txs',
      'proven_tx_reqs',
      'tx_labels_map',
      'output_tags_map',
      'certificate_fields'
    ]
    const snapshot = async (k: Knex) => ({
      clock: await k('snapshot_journal_clock').first(),
      physical: await k('snapshot_journal_physical').orderBy(['tableId', 'id1', 'id2', 'exactText']),
      scope: await k('snapshot_journal_scope').orderBy(['tableId', 'userId', 'id1', 'id2', 'exactText'])
    })
    try {
      compact = await fixture()
      const databases = [legacy.k, compact.k]
      for (const [index, k] of databases.entries()) {
        // SQL event inputs only: these ordinary tables do not model packed
        // payload/quota/lifetime storage or grant owned-native admission.
        for (const table of ['brc38_native_binary_fields', 'brc38_native_text_fields'])
          await k.raw(
            `CREATE TABLE ${table}(tableId INTEGER NOT NULL,rowId INTEGER NOT NULL,fieldId INTEGER NOT NULL,PRIMARY KEY(tableId,rowId,fieldId))`
          )
        await k.raw(SNAPSHOT_JOURNAL_SQLITE_CLOCK_DDL)
        await k('snapshot_journal_clock').insert({ id: 1, revision: 0, ceiling: 1000000, enabled: 1, reason: null })
        for (const ddl of index === 0
          ? observers.SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL
          : observers.SNAPSHOT_JOURNAL_SQLITE_COMPACT_METADATA_DDL)
          await k.raw(ddl)
        const shared = index !== 0 && layout !== 'clock-shared',
          events = index !== 0 && (layout === 'events-shared' || layout === 'sources-shared'),
          projectedSources = index !== 0 && layout === 'sources-shared',
          original = [
            ...(await observers.snapshotJournalSqliteObserverSql(k, shared, events)),
            ...observers.snapshotJournalPackedPointerObserverSql(false, shared, events),
            ...observers.snapshotJournalPackedPointerObserverSql(true, shared, events)
          ]
        if (shared) for (const ddl of observers.SNAPSHOT_JOURNAL_SQLITE_SHARED_EFFECT_DDL) await k.raw(ddl)
        const installed =
          index === 0 ? original : observers.snapshotJournalSharedClockObserverSql(original, events, projectedSources)
        if (events) {
          for (const ddl of projectedSources
            ? observers.SNAPSHOT_JOURNAL_SQLITE_SHARED_SOURCE_EVENT_DDL
            : observers.SNAPSHOT_JOURNAL_SQLITE_SHARED_EVENT_DDL)
            expect(Buffer.byteLength(ddl, 'utf8')).toBeLessThanOrEqual(16384)
          const previous = observers.snapshotJournalSharedClockObserverSql([
            ...(await observers.snapshotJournalSqliteObserverSql(k, true)),
            ...observers.snapshotJournalPackedPointerObserverSql(false, true),
            ...observers.snapshotJournalPackedPointerObserverSql(true, true)
          ])
          const bytes = (definitions: readonly string[]) =>
            definitions.reduce((total, sql) => total + Buffer.byteLength(sql, 'utf8'), 0)
          expect(bytes(installed)).toBeLessThan(bytes(previous))
        }
        if (projectedSources) {
          const previous = observers.snapshotJournalSharedClockObserverSql(original, true)
          expect(installed.reduce((sum, ddl) => sum + Buffer.byteLength(ddl), 0)).toBeLessThan(
            previous.reduce((sum, ddl) => sum + Buffer.byteLength(ddl), 0)
          )
        }
        for (const ddl of installed) await k.raw(ddl)
        if (projectedSources) {
          // Every UNION branch retains a SEARCH point path. The certificate
          // field branch stays in its original collation-bearing statement.
          for (const tableId of [0, 10, 11]) {
            const steps: Array<{ detail: string }> = await k.raw(
              'EXPLAIN QUERY PLAN SELECT 1 FROM snapshot_journal_source_rows s WHERE s.tableId=? AND s.id1=? AND s.id2=? AND s.exactText=? AND CAST(s.id1 AS BLOB)=CAST(? AS BLOB) AND CAST(s.id2 AS BLOB)=CAST(? AS BLOB) AND CAST(s.exactText AS BLOB)=CAST(? AS BLOB)',
              [tableId, 1, 0, '', 1, 0, '']
            )
            expect(
              steps.some(step =>
                /SCAN (?:transactions|outputs|certificates|tx_labels|output_baskets|output_tags|commissions|sync_states|proven_txs|proven_tx_reqs|tx_labels_map|output_tags_map)(?:\b|$)/.test(
                  step.detail
                )
              )
            ).toBe(false)
            expect(steps.filter(step => step.detail.startsWith('SEARCH '))).toHaveLength(12)
          }
          expect(
            await k('sqlite_schema').where('name', 'snapshot_journal_source_rows').first('type', 'rootpage')
          ).toEqual({ type: 'view', rootpage: 0 })
        }
      }
      for (const table of tables) {
        for (const k of databases) await k(table).update({ updated_at: '2026-01-02 03:04:05.000' })
        expect(await snapshot(compact.k)).toEqual(await snapshot(legacy.k))
      }
      const sourceKeys = [
        ['transactionId'],
        ['outputId'],
        ['certificateId'],
        ['txLabelId'],
        ['basketId'],
        ['outputTagId'],
        ['commissionId'],
        ['syncStateId'],
        ['provenTxId'],
        ['provenTxReqId'],
        ['txLabelId', 'transactionId'],
        ['outputTagId', 'outputId'],
        ['certificateId', 'fieldName']
      ]
      for (const [tableId, table] of tables.entries()) {
        const before = await snapshot(legacy.k)
        for (const k of databases) {
          await k.raw('SAVEPOINT independent_source_key_move')
          await k.raw('PRAGMA defer_foreign_keys=ON')
          const row = await k(table).first(),
            key = Object.fromEntries(sourceKeys[tableId].map(column => [column, row[column]])),
            next = Object.fromEntries(
              sourceKeys[tableId].map(column => [
                column,
                typeof row[column] === 'string' ? 'independent-journal-key-move' : row[column] + 100000
              ])
            )
          await k(table).where(key).update(next)
        }
        expect(await snapshot(compact.k)).toEqual(await snapshot(legacy.k))
        for (const k of databases) {
          await k.raw('ROLLBACK TO independent_source_key_move')
          await k.raw('RELEASE independent_source_key_move')
          expect(await snapshot(k)).toEqual(before)
          expect(await k.raw('PRAGMA foreign_key_check')).toEqual([])
        }
      }
      expect((await snapshot(compact.k)).physical.map(row => row.tableId)).toEqual(
        expect.arrayContaining(tables.map((_, i) => i))
      )
      for (const k of databases) {
        const transaction = await k('transactions').first(),
          users = await k('users').orderBy('userId')
        await k('transactions')
          .where('transactionId', transaction.transactionId)
          .update({ userId: users.find(row => row.userId !== transaction.userId)!.userId })
      }
      expect(await snapshot(compact.k)).toEqual(await snapshot(legacy.k))
      for (const k of databases) {
        const before = await snapshot(k)
        await k.raw('SAVEPOINT independent_clock_rollback')
        await k('outputs').update({ updated_at: '2026-02-03 04:05:06.000' })
        expect((await snapshot(k)).clock.revision).toBeGreaterThan(before.clock.revision)
        await k.raw('ROLLBACK TO independent_clock_rollback')
        await k.raw('RELEASE independent_clock_rollback')
        expect(await snapshot(k)).toEqual(before)
      }
      for (const table of ['snapshot_journal_physical', 'snapshot_journal_scope']) {
        expect(
          (await compact.k.raw('PRAGMA table_list(??)', [table])).find(
            (row: { name: string; wr: number }) => row.name === table
          ).wr
        ).toBe(1)
        expect(
          (await legacy.k.raw('PRAGMA table_list(??)', [table])).find(
            (row: { name: string; wr: number }) => row.name === table
          ).wr
        ).toBe(0)
        await expect(compact.k.raw('SELECT _rowid_ FROM ?? LIMIT 1', [table])).rejects.toThrow('no such column')
        const plan = await compact.k.raw(
          `EXPLAIN QUERY PLAN SELECT * FROM ${table} INDEXED BY sqlite_autoindex_${table}_1 WHERE tableId=?`,
          [0]
        )
        expect(plan[0].detail.startsWith(`SEARCH ${table} USING PRIMARY KEY`)).toBe(true)
      }
      for (const table of tables) {
        const before = await snapshot(legacy.k)
        for (const k of databases) {
          await k.raw('SAVEPOINT independent_source_delete_reinsert')
          await k.raw('PRAGMA defer_foreign_keys=ON')
          const rows = await k(table)
          expect(rows.length).toBeGreaterThan(0)
          await k(table).delete()
          // Real source DELETE followed by fresh INSERT at the same physical
          // keys must replace generations and preserve independent tombstones.
          for (const row of rows) await k(table).insert(row)
          expect(await k.raw('PRAGMA foreign_key_check')).toEqual([])
        }
        expect(await snapshot(compact.k)).toEqual(await snapshot(legacy.k))
        for (const k of databases) {
          await k.raw('ROLLBACK TO independent_source_delete_reinsert')
          await k.raw('RELEASE independent_source_delete_reinsert')
          expect(await snapshot(k)).toEqual(before)
        }
      }
      if (layout !== 'clock-shared') {
        for (const helper of ['guard', 'scope', 'physical'])
          expect(await compact.k('snapshot_journal_' + helper + '_event')).toEqual([])
        if (layout === 'events-shared' || layout === 'sources-shared') {
          for (const helper of ['member', 'source', 'pointer'])
            expect(await compact.k('snapshot_journal_' + helper + '_event')).toEqual([])
          const before = await snapshot(compact.k)
          await expect(
            compact.k.raw('INSERT INTO snapshot_journal_source_event(event,tableId) VALUES(4,0)')
          ).rejects.toThrow('Invalid snapshot journal source event')
          expect(await snapshot(compact.k)).toEqual(before)
        }
        const before = await snapshot(compact.k)
        // The original guard uses three-valued NOT: NULL does not disable it.
        await compact.k.raw('INSERT INTO snapshot_journal_guard_event(valid) VALUES(NULL)')
        expect(await snapshot(compact.k)).toEqual(before)
        await compact.k.raw('SAVEPOINT independent_shared_guard_rollback')
        await compact.k.raw('INSERT INTO snapshot_journal_guard_event(valid) VALUES(0)')
        expect((await snapshot(compact.k)).clock).toMatchObject({ enabled: 0, reason: 'key-out-of-range' })
        await compact.k.raw('ROLLBACK TO independent_shared_guard_rollback')
        await compact.k.raw('RELEASE independent_shared_guard_rollback')
        expect(await snapshot(compact.k)).toEqual(before)
      }
      const pointers = [
        ['brc38_native_binary_fields', 0, 'transactions', 'transactionId', 0],
        ['brc38_native_binary_fields', 1, 'proven_txs', 'provenTxId', 0],
        ['brc38_native_binary_fields', 2, 'proven_tx_reqs', 'provenTxReqId', 0],
        ['brc38_native_binary_fields', 3, 'outputs', 'outputId', 0],
        ['brc38_native_binary_fields', 4, 'commissions', 'commissionId', 0],
        ['brc38_native_text_fields', 0, 'transactions', 'transactionId', 3],
        ['brc38_native_text_fields', 2, 'proven_tx_reqs', 'provenTxReqId', 2],
        ['brc38_native_text_fields', 3, 'outputs', 'outputId', 1],
        ['brc38_native_text_fields', 4, 'commissions', 'commissionId', 1],
        ['brc38_native_text_fields', 5, 'sync_states', 'syncStateId', 0],
        ['brc38_native_text_fields', 6, 'certificates', 'certificateId', 0],
        ['brc38_native_text_fields', 7, 'certificate_fields', 'rowid', 0]
      ] as const
      for (const [pointer, tableId, source, key, fieldId] of pointers) {
        const before = await snapshot(legacy.k)
        for (const k of databases) {
          await k.raw('SAVEPOINT independent_pointer_events')
          await k.raw('PRAGMA defer_foreign_keys=ON')
          const unchanged = await snapshot(k)
          await k(pointer).insert({ tableId, rowId: 999999, fieldId })
          expect(await snapshot(k)).toEqual(unchanged)
          await k(pointer).delete()
          expect(await snapshot(k)).toEqual(unchanged)
          const row = await k(source).select('*', k.raw('rowid AS independentRowId')).first()
          await k(pointer).insert({ tableId, rowId: key === 'rowid' ? row.independentRowId : row[key], fieldId })
        }
        expect(await snapshot(compact.k)).toEqual(await snapshot(legacy.k))
        for (const k of databases) {
          await k(pointer).delete()
        }
        expect(await snapshot(compact.k)).toEqual(await snapshot(legacy.k))
        for (const k of databases) {
          const row = await k(source).select('*', k.raw('rowid AS independentRowId')).first(),
            rowId = key === 'rowid' ? row.independentRowId : row[key]
          await k(pointer).insert({ tableId, rowId, fieldId })
          await k(source).whereRaw('rowid=?', [row.independentRowId]).delete()
          const tombstone = await snapshot(k)
          await k(pointer).delete()
          // Deleting a pointer after its main source is gone cannot revive the
          // physical tombstone or advance the original journal clock again.
          expect(await snapshot(k)).toEqual(tombstone)
        }
        expect(await snapshot(compact.k)).toEqual(await snapshot(legacy.k))
        for (const k of databases) {
          await k.raw('ROLLBACK TO independent_pointer_events')
          await k.raw('RELEASE independent_pointer_events')
          expect(await snapshot(k)).toEqual(before)
          expect(await k.raw('PRAGMA foreign_key_check')).toEqual([])
        }
      }
      const unchanged = await snapshot(compact.k)
      await expect(compact.k.raw('INSERT INTO snapshot_journal_advance_event(event) VALUES(2)')).rejects.toThrow(
        'Invalid snapshot journal advance event'
      )
      expect(await snapshot(compact.k)).toEqual(unchanged)
      expect(await compact.k('snapshot_journal_advance_event')).toEqual([])
      for (const k of databases) {
        const clock = (await snapshot(k)).clock
        await k('snapshot_journal_clock')
          .where('id', 1)
          .update({ ceiling: clock.revision + 1 })
        await k('outputs').update({ updated_at: '2026-03-04 05:06:07.000' })
      }
      expect(await snapshot(compact.k)).toEqual(await snapshot(legacy.k))
      expect((await snapshot(compact.k)).clock).toMatchObject({ enabled: 0, reason: 'capacity-exhausted' })
      for (const k of databases)
        expect(await k('outputs').where('updated_at', '2026-03-04 05:06:07.000')).not.toHaveLength(0)
      // Authored compact SQL in an ordinary engine proves semantics only; it
      // cannot make that database an admitted native installation.
      await expect(readSnapshotJournalSqliteGeneration(compact.k, journalReceiptPolicy)).rejects.toThrow(
        'Invalid or unowned'
      )
    } finally {
      try {
        await compact?.source.destroy()
      } finally {
        await legacy.source.destroy()
      }
    }
  },
  30000
)

test('journal inventory refuses attached foreign handlers even when their name resembles an autoindex', async () => {
  const { k, source } = await fixture()
  try {
    const installed = await installSnapshotJournalSqliteGeneration(k, ceiling, journalReceiptPolicy)
    await k.raw('CREATE TRIGGER sqliteXautoindex_foreign AFTER INSERT ON snapshot_journal_physical BEGIN SELECT 1; END')
    await expect(readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).rejects.toThrow('Invalid or unowned')
    await k.raw('DROP TRIGGER sqliteXautoindex_foreign')
    expect(await readSnapshotJournalSqliteGeneration(k, journalReceiptPolicy)).toEqual(installed)
  } finally {
    await source.destroy()
  }
})
