import { knex, type Knex } from 'knex'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  createSnapshotJournalMysqlIntent,
  readSnapshotJournalMysqlIntent,
  type SnapshotJournalMysqlBinding
} from './SnapshotJournalMysqlIntent'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
let binding: SnapshotJournalMysqlBinding
beforeEach(() => {
  binding = {
    source: 'a'.repeat(64),
    plan: 'b'.repeat(64),
    ceiling: snapshotJournalRevision('9223372036854775807')
  }
})
const epoch = '12345678-1234-4123-8123-123456789abc'
const captured: Record<string, Array<Record<string, unknown>>> = JSON.parse(
  readFileSync(join(__dirname, '../../../../test/fixtures/snapshotJournal/mysql-intent-metadata-fixture.json'), 'utf8')
)
async function fixture() {
  const database = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  await database.raw(
    'CREATE TABLE snapshot_journal_generation(id INTEGER,version INTEGER,epoch TEXT,source TEXT,plan TEXT,ceiling TEXT,nextObject INTEGER,complete INTEGER)'
  )
  await database('snapshot_journal_generation').insert({
    id: 1,
    version: 1,
    epoch,
    ...binding,
    nextObject: 0,
    complete: 0
  })
  const metadata = structuredClone(captured),
    configuration = { client: { config: { client: 'mysql2' } }, isTransaction: false },
    version = { value: '8.4.0' }
  const raw = jest.fn(async (sql: string, values?: unknown[]) => {
    if (sql === 'SELECT VERSION() version') return [[{ version: version.value }]]
    for (const [table, key] of [
      ['TABLES', 'tables'],
      ['COLUMNS', 'columns'],
      ['STATISTICS', 'indexes'],
      ['TABLE_CONSTRAINTS', 'constraints'],
      ['TRIGGERS', 'triggers']
    ])
      if (sql.includes('information_schema.' + table + ' ')) return [metadata[key]]
    // Driver boundary only; native MySQL separately executes the atomic CTAS.
    if (sql.startsWith('CREATE TABLE snapshot_journal_generation')) {
      if (!values) throw new Error('Missing bound intent values')
      await database('snapshot_journal_generation').update({
        epoch: values[0],
        source: values[1],
        plan: values[2],
        ceiling: values[3]
      })
      return {}
    }
    throw new Error('Unexpected SQL fixture request')
  })
  const k = Object.assign((table: string) => database(table), configuration, {
    raw
  }) as unknown as Knex
  return { k, database, metadata, raw, version }
}
test('native metadata and exact signed63 binding resume the persisted epoch', async () => {
  const f = await fixture()
  try {
    expect(await readSnapshotJournalMysqlIntent(f.k, binding)).toEqual({
      ...binding,
      epoch,
      nextObject: 0,
      complete: false
    })
    await f.database('snapshot_journal_generation').update({ nextObject: 128, complete: 1 })
    expect(await readSnapshotJournalMysqlIntent(f.k, binding)).toEqual({
      ...binding,
      epoch,
      nextObject: 128,
      complete: true
    })
  } finally {
    await f.database.destroy()
  }
})
test.each(['8.0.21', '8.0.40-commercial', '8.4.0', '8.10.0'])(
  'supported %s binds intent values and reads back its newly generated epoch',
  async version => {
    const f = await fixture()
    try {
      f.version.value = version
      const created = await createSnapshotJournalMysqlIntent(f.k, binding)
      expect(created).toMatchObject({ ...binding, nextObject: 0, complete: false })
      expect(created.epoch).not.toBe(epoch)
      expect(created.epoch).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
      expect(f.raw.mock.calls.filter(([sql]) => sql.startsWith('CREATE TABLE'))).toHaveLength(1)
    } finally {
      await f.database.destroy()
    }
  }
)
test.each(['8.0.20', '5.7.44', '10.11.8-MariaDB', '9.0.0', 'unknown', 'prefix-8.4.0'])(
  'unsupported atomic-DDL baseline %s performs no DDL',
  async version => {
    const f = await fixture()
    try {
      f.version.value = version
      await expect(createSnapshotJournalMysqlIntent(f.k, binding)).rejects.toThrow('Invalid or unowned')
      expect(f.raw.mock.calls.map(([sql]) => sql)).toEqual(['SELECT VERSION() version'])
    } finally {
      await f.database.destroy()
    }
  }
)
test.each(['sqlite3', 'better-sqlite3', 'pg'])('unsupported driver %s refuses without I/O', async client => {
  const f = await fixture()
  try {
    f.k.client.config.client = client
    await expect(createSnapshotJournalMysqlIntent(f.k, binding)).rejects.toThrow('Invalid or unowned')
    await expect(readSnapshotJournalMysqlIntent(f.k, binding)).rejects.toThrow('Invalid or unowned')
    expect(f.raw).not.toHaveBeenCalled()
  } finally {
    await f.database.destroy()
  }
})
test('implicit DDL never commits a caller-owned transaction', async () => {
  const f = await fixture()
  try {
    Object.defineProperty(f.k, 'isTransaction', { value: true })
    await expect(createSnapshotJournalMysqlIntent(f.k, binding)).rejects.toThrow('Invalid or unowned')
    expect(f.raw).not.toHaveBeenCalled()
  } finally {
    await f.database.destroy()
  }
})
test.each([
  { source: 'A'.repeat(64) },
  { source: 'x' + 'a'.repeat(64) },
  { source: 'a'.repeat(64) + 'x' },
  { plan: 'x' + 'b'.repeat(64) },
  { plan: 'b'.repeat(64) + 'x' },
  { plan: 'bad' },
  { source: { toString: () => 'a'.repeat(64) } },
  { plan: { toString: () => 'b'.repeat(64) } },
  { ceiling: '0' },
  { ceiling: '01' },
  { ceiling: '9223372036854775808' }
])('invalid binding %j refuses before SQL', async patch => {
  const f = await fixture()
  try {
    await expect(
      createSnapshotJournalMysqlIntent(f.k, { ...binding, ...patch } as SnapshotJournalMysqlBinding)
    ).rejects.toThrow()
    expect(f.raw).not.toHaveBeenCalled()
  } finally {
    await f.database.destroy()
  }
})
test.each([
  ['tables', 'engine', 'MyISAM'],
  ['tables', 'type', 'VIEW'],
  ['tables', 'collation', 'ascii_general_ci'],
  ['tables', 'rowFormat', 'Compact'],
  ['tables', 'options', ''],
  ['columns', 'name', 'foreign'],
  ['columns', 'type', 'bigint'],
  ['columns', 'nullable', 'YES'],
  ['columns', 'defaultValue', 0],
  ['columns', 'extra', 'auto_increment'],
  ['columns', 'expression', '1'],
  ['columns', 'charset', 'utf8mb4'],
  ['columns', 'collation', 'utf8mb4_bin'],
  ['indexes', 'name', 'foreign'],
  ['indexes', 'columnName', 'source'],
  ['indexes', 'nonUnique', 1],
  ['indexes', 'direction', 'D'],
  ['indexes', 'prefix', 1],
  ['indexes', 'type', 'HASH'],
  ['indexes', 'visible', 'NO'],
  ['constraints', 'name', 'foreign'],
  ['constraints', 'type', 'CHECK'],
  ['constraints', 'enforced', 'NO']
])('native %s %s drift refuses ownership', async (key, field, value) => {
  const f = await fixture()
  try {
    f.metadata[key as string][0][field as string] = value
    await expect(readSnapshotJournalMysqlIntent(f.k, binding)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})
test.each(['tables', 'columns', 'indexes', 'constraints'])('incomplete %s metadata refuses', async key => {
  const f = await fixture()
  try {
    f.metadata[key].pop()
    await expect(readSnapshotJournalMysqlIntent(f.k, binding)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})
test('an attached foreign observer refuses ownership', async () => {
  const f = await fixture()
  try {
    f.metadata.triggers.push({ TRIGGER_NAME: 'foreign' })
    await expect(readSnapshotJournalMysqlIntent(f.k, binding)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})
test.each([
  { id: 2 },
  { version: 2 },
  { epoch: 'wrong' },
  { epoch: 'x' + epoch },
  { epoch: epoch + 'x' },
  { source: 'c'.repeat(64) },
  { plan: 'c'.repeat(64) },
  { ceiling: '1' },
  { nextObject: -1 },
  { nextObject: 129 },
  { nextObject: 0.5 },
  { complete: 2 }
])('persisted state %j cannot establish installation continuity', async patch => {
  const f = await fixture()
  try {
    await f.database('snapshot_journal_generation').update(patch)
    await expect(readSnapshotJournalMysqlIntent(f.k, binding)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})
test.each(['missing', 'extra'])('%s intent row refuses', async kind => {
  const f = await fixture()
  try {
    if (kind === 'missing') await f.database('snapshot_journal_generation').delete()
    else
      await f
        .database('snapshot_journal_generation')
        .insert({ ...(await f.database('snapshot_journal_generation').first()), id: 2 })
    await expect(readSnapshotJournalMysqlIntent(f.k, binding)).rejects.toThrow('Invalid or unowned')
  } finally {
    await f.database.destroy()
  }
})

test('legacy MySQL alias can resume its exact persisted intent', async () => {
  const f = await fixture()
  try {
    f.k.client.config.client = 'mysql'
    expect(await readSnapshotJournalMysqlIntent(f.k, binding)).toMatchObject({ ...binding, epoch })
  } finally {
    await f.database.destroy()
  }
})
