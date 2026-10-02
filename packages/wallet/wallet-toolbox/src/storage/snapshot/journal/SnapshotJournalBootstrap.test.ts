import { copySnapshotJournalBootstrapPage, SNAPSHOT_JOURNAL_BOOTSTRAP_DDL } from './SnapshotJournalBootstrap'
import {
  snapshotJournalSqliteObserverSql,
  SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL
} from './SnapshotJournalSqliteObservers'
import { installSnapshotJournalSqliteClock } from './SnapshotJournalSqliteClock'
import { snapshotJournalRevision } from './SnapshotJournalRevision'
// Internal journal foundation. Registered migration and reader adoption remain separate.
import { knex, type Knex } from 'knex'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StorageKnex } from '../../StorageKnex'
import { StorageProvider } from '../../StorageProvider'
import { seedArchiveClosure } from '../../../../test/utils/snapshotArchiveFixtures'
import { fixture, value, tables, numeric, profiles } from '../../../../test/utils/snapshotSqliteFixtures'
import { installGeneration } from '../../schema/snapshotSqliteIndexGeneration'
import { copyGenerationPage } from '../../schema/snapshotSqliteIndexBootstrap'

const q = (name: string) => '"' + name.replaceAll('"', '""') + '"'
const scopeKey = 'tableId,userId,id1,id2,exactText'
const tuple = (table: string, prefix: string) => {
  const key = numeric.find(([name]) => name === table)?.[1]
  if (key) return [prefix + '.' + q(key), '0', "''"]
  if (table === 'tx_labels_map') return [prefix + '.txLabelId', prefix + '.transactionId', "''"]
  if (table === 'output_tags_map') return [prefix + '.outputTagId', prefix + '.outputId', "''"]
  return [prefix + '.certificateId', '0', prefix + '.fieldName']
}
async function installCandidate(k: Knex, reverse: boolean) {
  const definitions = await snapshotJournalSqliteObserverSql(k)
  await installSnapshotJournalSqliteClock(k, snapshotJournalRevision('1000000000'))
  for (const ddl of SNAPSHOT_JOURNAL_SQLITE_METADATA_DDL) await k.raw(ddl)
  const prior: Array<{ name: string; sql: string }> = await k('sqlite_master')
    .where('type', 'trigger')
    .whereIn('tbl_name', tables)
    .select('name', 'sql')
  for (const definition of definitions) await k.raw(definition)
  if (reverse)
    for (const trigger of prior) {
      await k.raw('DROP TRIGGER ??', [trigger.name])
      await k.raw(trigger.sql)
    }
}
async function expected(k: Knex) {
  const selections = profiles.map(
    ([table, key], id) => `SELECT ${id} tableId,userId,${q(key)} id1,0 id2,'' exactText FROM ${q(table)}`
  )
  for (const [id, table, left, leftKey, right, rightKey] of [
    [10, 'tx_labels_map', 'tx_labels', 'txLabelId', 'transactions', 'transactionId'],
    [11, 'output_tags_map', 'output_tags', 'outputTagId', 'outputs', 'outputId']
  ])
    for (const [parent, key] of [
      [left, leftKey],
      [right, rightKey]
    ])
      selections.push(
        `SELECT ${id},p.userId,m.${leftKey},m.${rightKey},'' FROM ${table} m JOIN ${parent} p ON m.${key}=p.${key}`
      )
  selections.push(
    'SELECT 12,userId,certificateId,0,fieldName FROM certificate_fields',
    'SELECT 12,c.userId,f.certificateId,0,f.fieldName FROM certificate_fields f JOIN certificates c ON c.certificateId=f.certificateId',
    "SELECT 9,t.userId,r.provenTxReqId,0,'' FROM transactions t JOIN proven_tx_reqs r ON r.txid=t.txid",
    "SELECT 8,t.userId,p.provenTxId,0,'' FROM transactions t JOIN proven_txs p ON p.provenTxId=t.provenTxId",
    "SELECT 8,t.userId,p.provenTxId,0,'' FROM transactions t JOIN proven_tx_reqs r ON r.txid=t.txid JOIN proven_txs p ON p.provenTxId=r.provenTxId"
  )
  return await k.raw(
    'SELECT * FROM (' + selections.join(' UNION ') + ') ORDER BY tableId,userId,id1,id2,exactText COLLATE BINARY'
  )
}
async function exact(k: Knex) {
  expect(
    await k('snapshot_journal_scope').where('present', 1).select(scopeKey.split(',')).orderBy(scopeKey.split(','))
  ).toEqual(await expected(k))
  for (const [tableId, table] of tables.entries()) {
    const keys = tuple(table, 's')
    const rows = await k.raw(
      `SELECT s.*,g.generation AS candidateGeneration,g.present AS candidatePresent FROM ${q(table)} s LEFT JOIN snapshot_journal_physical g ON g.tableId=${tableId} AND g.id1=${keys[0]} AND g.id2=${keys[1]} AND g.exactText COLLATE BINARY=${keys[2]} COLLATE BINARY`
    )
    for (const row of rows) {
      expect(row.candidatePresent).toBe(1)
      expect(row.candidateGeneration).toBeGreaterThan(0)
    }
  }
}

async function beginBootstrap(k: Knex) {
  await installCandidate(k, false)
  await k.raw(SNAPSHOT_JOURNAL_BOOTSTRAP_DDL)
  await k('snapshot_journal_bootstrap').insert({ id: 1, stream: 0, cursor: null })
}

test('exact bootstrap copies bounded pages, resumes and preserves newer low-key observers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ts569-exact-bootstrap-')),
    filename = join(directory, 'source.sqlite')
  const k = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: k })
  const writer = knex({
    client: 'better-sqlite3',
    connection: { filename },
    useNullAsDefault: true,
    pool: { min: 1, max: 1 }
  })
  try {
    await k.raw('PRAGMA journal_mode=WAL')
    await source.migrate('exact bootstrap fixture', 'synthetic-exact-bootstrap')
    await source.makeAvailable()
    const { user } = await source.findOrInsertUser('02' + '11'.repeat(32)),
      { user: other } = await source.findOrInsertUser('03' + '22'.repeat(32))
    await seedArchiveClosure(source, user.userId, other.userId)
    const original = await k('tx_labels').where('txLabelId', 1).first()
    for (let start = 1000; start < 1600; start += 100)
      await k('tx_labels').insert(
        Array.from({ length: 100 }, (_, offset) => ({
          ...original,
          txLabelId: start + offset,
          label: 'bootstrap-' + (start + offset)
        }))
      )
    await beginBootstrap(k)
    await k('snapshot_journal_clock').update({
      revision: '9007199254740992',
      ceiling: '9223372036854775807'
    })
    let moved = false,
      complete = false,
      max = 0,
      insertQueries = 0
    const count = (q: { sql: string; bindings: unknown[] }) => {
      if (/^insert into `snapshot_journal_(physical|scope)`/i.test(q.sql)) {
        insertQueries++
        expect(q.bindings.length).toBeLessThanOrEqual(64 * 7)
      }
    }
    k.on('query', count)
    writer.on('query', count)
    for (let page = 0; page < 100; page++) {
      insertQueries = 0
      const result = await copySnapshotJournalBootstrapPage(page % 2 ? writer : k)
      expect(insertQueries).toBeLessThanOrEqual(4)
      expect(result.invalidated).toBe(false)
      max = Math.max(max, result.selected)
      if (result.stream === 3 && result.selected === 256 && !moved) {
        moved = true
        await writer('tx_labels').where('txLabelId', 1).update({ label: 'changed below cursor' })
        await writer('tx_labels').where('txLabelId', 1000).delete()
        await writer('tx_labels').insert({
          ...original,
          txLabelId: 999,
          label: 'inserted below cursor'
        })
        await writer('tx_labels').where('txLabelId', 1599).update({ userId: other.userId })
      }
      if (result.complete) {
        complete = true
        break
      }
    }
    expect({ moved, complete, max }).toEqual({ moved: true, complete: true, max: 256 })
    await exact(k)
    expect((await k('snapshot_journal_physical').where({ tableId: 3, id1: 1000 }).first()).present).toBe(0)
    expect(
      (await k('snapshot_journal_scope').where({ tableId: 3, id1: 1000, userId: user.userId }).first()).present
    ).toBe(0)
    const revisions = await k('snapshot_journal_physical').select(
      k.raw('CAST(revision AS TEXT) revision'),
      k.raw('CAST(generation AS TEXT) generation')
    )
    for (const row of revisions) {
      expect(BigInt(row.revision)).toBeGreaterThan(9007199254740992n)
      expect(BigInt(row.generation)).toBeGreaterThan(9007199254740992n)
    }
    expect(await copySnapshotJournalBootstrapPage(k)).toEqual({
      complete: true,
      selected: 0,
      stream: 17,
      invalidated: false
    })
    expect(await k.raw('PRAGMA foreign_key_check')).toEqual([])
  } finally {
    await writer.destroy()
    await source.destroy()
    await rm(directory, { recursive: true, force: true })
  }
}, 60000)

async function emptyFixture(): Promise<Knex> {
  const k = await fixture('BINARY', false, false)
  const plan = await installGeneration(k)
  for (let i = 0; i < 100; i++) if ((await copyGenerationPage(k, plan)).complete) break
  return k
}

test('oversized historical text is bounded before decode and disables bootstrap without losing source data', async () => {
  const k = await emptyFixture()
  try {
    const text = 'x'.repeat(1000000)
    await k('certificate_fields').insert({
      ...value('certificate_fields', 1, 1, 1),
      fieldName: text
    })
    await beginBootstrap(k)
    await k('snapshot_journal_bootstrap').update({ stream: 12 })
    let maximum = 0
    const record = (response: unknown) => {
      if (Array.isArray(response))
        for (const row of response)
          if (row?.boundedText instanceof Uint8Array) maximum = Math.max(maximum, row.boundedText.length)
    }
    k.on('query-response', record)
    const page = await copySnapshotJournalBootstrapPage(k)
    k.off('query-response', record)
    expect(page).toEqual({ complete: false, selected: 1, stream: 12, invalidated: true })
    expect(maximum).toBe(401)
    expect(await k('snapshot_journal_clock').first('enabled', 'reason')).toEqual({
      enabled: 0,
      reason: 'key-out-of-range'
    })
    expect(await k('snapshot_journal_physical')).toEqual([])
    expect(await k('certificate_fields').select(k.raw('length(fieldName) n')).first()).toEqual({
      n: 1000000
    })
    expect(await k('snapshot_journal_bootstrap').first()).toEqual({
      id: 1,
      stream: 12,
      cursor: null
    })
  } finally {
    await k.destroy()
  }
})

test.each(['capacity', 'signed63'])('%s exhaustion commits invalidation without publishing progress', async kind => {
  const k = await emptyFixture()
  try {
    await k('transactions').insert(value('transactions', 1, 1, 1))
    await beginBootstrap(k)
    await k('snapshot_journal_clock').update(
      kind === 'capacity'
        ? { revision: 1, ceiling: 1 }
        : { revision: '9223372036854775807', ceiling: '9223372036854775807' }
    )
    expect(await copySnapshotJournalBootstrapPage(k)).toEqual({
      complete: false,
      selected: 1,
      stream: 0,
      invalidated: true
    })
    expect(await k('snapshot_journal_bootstrap').first()).toEqual({
      id: 1,
      stream: 0,
      cursor: null
    })
    expect(await k('snapshot_journal_physical')).toEqual([])
    expect(await k('transactions').count('* AS n').first()).toEqual({ n: 1 })
  } finally {
    await k.destroy()
  }
})

test.each(['{', '{}', '[]', '["wrong-type"]', '[9007199254740992]', '[1,2]'])(
  'malformed persisted cursor %s refuses before progress',
  async cursor => {
    const k = await emptyFixture()
    try {
      await beginBootstrap(k)
      await k('snapshot_journal_bootstrap').update({ cursor })
      await expect(copySnapshotJournalBootstrapPage(k)).rejects.toThrow('bootstrap state')
      expect(await k('snapshot_journal_physical')).toEqual([])
    } finally {
      await k.destroy()
    }
  }
)

test('historical BLOB field spelling invalidates instead of changing its SQL comparison domain', async () => {
  const k = await emptyFixture()
  try {
    await k.raw(
      "INSERT INTO certificate_fields(userId,certificateId,fieldName,fieldValue) VALUES(1,1,CAST('field' AS BLOB),'value')"
    )
    await beginBootstrap(k)
    await k('snapshot_journal_bootstrap').update({ stream: 12 })
    expect((await copySnapshotJournalBootstrapPage(k)).invalidated).toBe(true)
    expect(await k('snapshot_journal_physical')).toEqual([])
    expect(await k('certificate_fields').select(k.raw('typeof(fieldName) kind')).first()).toEqual({
      kind: 'blob'
    })
  } finally {
    await k.destroy()
  }
})

test('malformed SQLite clock response rolls back allocation and bootstrap progress', async () => {
  const k = await emptyFixture()
  let altered = false
  const listener = (row: { enabled: number }, query: { sql: string }) => {
    if (query.sql.startsWith('select `enabled`') && query.sql.includes('as `value`')) {
      row.enabled = 2
      altered = true
    }
  }
  try {
    await k('transactions').insert(value('transactions', 1, 1, 1))
    await beginBootstrap(k)
    const before = await k('snapshot_journal_clock').first()
    k.on('query-response', listener)
    await expect(copySnapshotJournalBootstrapPage(k)).rejects.toThrow('Invalid snapshot')
    expect(altered).toBe(true)
    expect(await k('snapshot_journal_clock').first()).toEqual(before)
    expect(await k('snapshot_journal_physical')).toEqual([])
    expect(await k('snapshot_journal_bootstrap').first()).toEqual({
      id: 1,
      stream: 0,
      cursor: null
    })
  } finally {
    k.off('query-response', listener)
    await k.destroy()
  }
})

test('legacy SQLite alias bootstraps an exact 400-byte historical key', async () => {
  const k = await emptyFixture()
  k.client.config.client = 'sqlite3'
  try {
    const fieldName = '😀'.repeat(100)
    await k('certificate_fields').insert({ ...value('certificate_fields', 1, 1, 1), fieldName })
    await beginBootstrap(k)
    await k('snapshot_journal_bootstrap').update({ stream: 12 })
    expect(await copySnapshotJournalBootstrapPage(k)).toMatchObject({
      selected: 1,
      invalidated: false
    })
    expect((await k('snapshot_journal_physical').first()).exactText).toBe(fieldName)
    expect(await copySnapshotJournalBootstrapPage(k)).toMatchObject({
      selected: 0,
      invalidated: false
    })
  } finally {
    await k.destroy()
  }
})
