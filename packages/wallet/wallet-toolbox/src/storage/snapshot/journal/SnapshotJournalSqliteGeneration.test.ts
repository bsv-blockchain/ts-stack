import * as observers from './SnapshotJournalSqliteObservers'
import { knex, type Knex } from 'knex'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { seedArchiveClosure } from '../../../../test/utils/snapshotArchiveFixtures'
import {
  installSnapshotJournalSqliteGeneration,
  readSnapshotJournalSqliteGeneration,
  completeSnapshotJournalSqliteGeneration,
  SNAPSHOT_JOURNAL_SQLITE_GENERATION as metadata
} from './SnapshotJournalSqliteGeneration'
import { copySnapshotJournalBootstrapPage } from './SnapshotJournalBootstrap'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'
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
    await source.migrate('journal lifecycle', 'synthetic-journal-lifecycle')
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
      installed = await installSnapshotJournalSqliteGeneration(k, ceiling)
    expect(installed).toMatchObject({ complete: false, enabled: true, ceiling })
    expect(installed.epoch).toMatch(/^[0-9a-f-]{36}$/)
    await expect(completeSnapshotJournalSqliteGeneration(k)).rejects.toThrow('Invalid or unowned')
    await copySnapshotJournalBootstrapPage(k, 1000000)
    const progress = await k('snapshot_journal_bootstrap').first()
    expect(await installSnapshotJournalSqliteGeneration(k, ceiling)).toEqual(installed)
    expect(await k('snapshot_journal_bootstrap').first()).toEqual(progress)
    await finish(k)
    expect(await readSnapshotJournalSqliteGeneration(k)).toEqual(installed)
    expect(await completeSnapshotJournalSqliteGeneration(k)).toEqual({
      ...installed,
      complete: true
    })
    expect(await readSnapshotJournalSqliteGeneration(k)).toEqual({ ...installed, complete: true })
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
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).rejects.toThrow('Invalid or unowned')
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
      await installSnapshotJournalSqliteGeneration(k, ceiling)
      if (kind === 'observer') await k.raw('DROP TRIGGER snapshot_journal_scope_0_INSERT')
      if (kind === 'index') await k.raw('DROP INDEX snapshot_journal_scope_page')
      if (kind === 'same-name view') await k.raw('CREATE VIEW snapshot_journal_scope_0_INSERT AS SELECT 1')
      if (kind === 'unknown reserved') await k.raw('CREATE TABLE snapshot_journal_foreign(id INTEGER)')
      const before = await k('sqlite_master').orderBy(['type', 'name']),
        rows = await k('transactions')
      await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).rejects.toThrow('Invalid or unowned')
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
    await installSnapshotJournalSqliteGeneration(k, ceiling)
    await k.raw('DROP TRIGGER application_user')
    await k.raw("CREATE TRIGGER application_user AFTER INSERT ON users BEGIN SELECT 'a b'; END")
    await expect(readSnapshotJournalSqliteGeneration(k)).rejects.toThrow('Invalid or unowned')
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
    await installSnapshotJournalSqliteGeneration(k, ceiling)
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
    await expect(readSnapshotJournalSqliteGeneration(k)).rejects.toThrow()
  } finally {
    await source.destroy()
  }
})
test('configured event exhaustion preserves source writes and refuses completion', async () => {
  const { k, source } = await fixture()
  try {
    const installed = await installSnapshotJournalSqliteGeneration(k, snapshotJournalRevision('1'))
    await k('tx_labels').where('txLabelId', 1).update({ label: 'first' })
    await k('tx_labels').where('txLabelId', 1).update({ label: 'ordinary after exhaustion' })
    expect((await k('tx_labels').where('txLabelId', 1).first()).label).toBe('ordinary after exhaustion')
    expect(await readSnapshotJournalSqliteGeneration(k)).toEqual({ ...installed, enabled: false })
    await k('snapshot_journal_bootstrap').update({ stream: 17, cursor: null, rowLimit: 1000000 })
    await expect(completeSnapshotJournalSqliteGeneration(k)).rejects.toThrow('Invalid or unowned')
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).rejects.toThrow('Invalid or unowned')
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
      await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).rejects.toBe(failure)
    } finally {
      k.off('query', listener)
    }
    expect(await k('sqlite_master').orderBy(['type', 'name'])).toEqual(before)
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).resolves.toMatchObject({
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
    const installed = await installSnapshotJournalSqliteGeneration(k, ceiling)
    await finish(k)
    const failure = new Error('synthetic completion failure'),
      listener = (query: { sql: string }) => {
        if (query.sql.startsWith('update `snapshot_journal_generation`')) throw failure
      }
    k.on('query', listener)
    try {
      await expect(completeSnapshotJournalSqliteGeneration(k)).rejects.toBe(failure)
    } finally {
      k.off('query', listener)
    }
    expect(await readSnapshotJournalSqliteGeneration(k)).toEqual(installed)
    await expect(completeSnapshotJournalSqliteGeneration(k)).resolves.toMatchObject({
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
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).rejects.toThrow('Invalid or unowned')
    expect(await k('sqlite_master')).toEqual([])
    k.client.config.client = 'mysql2'
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).rejects.toThrow('Invalid or unowned')
  } finally {
    await k.destroy()
  }
})

test.each(['zero ceiling', 'invalid clock reason', 'replaced observer'])(
  'owned generation refuses incompatible persisted %s',
  async kind => {
    const { k, source } = await fixture()
    try {
      await installSnapshotJournalSqliteGeneration(k, ceiling)
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
      await expect(readSnapshotJournalSqliteGeneration(k)).rejects.toThrow('Invalid or unowned')
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
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).rejects.toThrow('Invalid or unowned')
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
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).rejects.toThrow('Invalid or unowned')
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
    await expect(installSnapshotJournalSqliteGeneration(k, ceiling)).rejects.toThrow('Invalid or unowned')
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
    const installed = await installSnapshotJournalSqliteGeneration(k, ceiling)
    await finish(k)
    expect(await completeSnapshotJournalSqliteGeneration(k)).toEqual({
      ...installed,
      complete: true
    })
    expect(await readSnapshotJournalSqliteGeneration(k)).toEqual({ ...installed, complete: true })
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
    const result =
      operation === 'install'
        ? installSnapshotJournalSqliteGeneration(k, ceiling)
        : operation === 'read'
          ? readSnapshotJournalSqliteGeneration(k)
          : completeSnapshotJournalSqliteGeneration(k)
    await expect(result).rejects.toThrow('Invalid or unowned SQLite snapshot journal generation')
    expect(transaction).not.toHaveBeenCalled()
    expect(raw).not.toHaveBeenCalled()
  }
)

test('empty SQLite generation event window refuses before transaction admission', async () => {
  const transaction = jest.fn(),
    k = { client: { config: { client: 'sqlite3' } }, transaction } as unknown as Knex
  await expect(installSnapshotJournalSqliteGeneration(k, snapshotJournalRevision('0'))).rejects.toThrow(
    'Invalid or unowned SQLite snapshot journal generation'
  )
  expect(transaction).not.toHaveBeenCalled()
})

test.each(['prefix', 'suffix'])(
  'SQLite generation rejects an epoch with a valid UUID only as a %s substring',
  async side => {
    const { k, source } = await fixture()
    try {
      const installed = await installSnapshotJournalSqliteGeneration(k, ceiling)
      await k(metadata).update({
        epoch: side === 'prefix' ? installed.epoch + 'x' : 'x' + installed.epoch
      })
      await expect(readSnapshotJournalSqliteGeneration(k)).rejects.toThrow(
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
      const installed = await installSnapshotJournalSqliteGeneration(k, ceiling)
      await k('snapshot_journal_clock').update({ enabled: 0, reason })
      expect(await readSnapshotJournalSqliteGeneration(k)).toEqual({ ...installed, enabled: false })
      await expect(completeSnapshotJournalSqliteGeneration(k)).rejects.toThrow(
        'Invalid or unowned SQLite snapshot journal generation'
      )
    } finally {
      await source.destroy()
    }
  }
)
