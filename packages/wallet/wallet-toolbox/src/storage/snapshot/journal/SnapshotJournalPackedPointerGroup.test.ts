import {
  snapshotJournalGroupedPointerSql,
  snapshotJournalNativePointerDefinitions
} from './SnapshotJournalPackedPointerGroup'
import {
  snapshotJournalPackedPointerObserverSql,
  snapshotJournalPositionalEventSql
} from './SnapshotJournalSqliteObservers'
import knex from 'knex'

interface Database {
  exec(sql: string): void
  prepare(sql: string): { run(...values: Array<number | null>): void; all(): unknown[] }
  close(): void
}
const SQLite: new (filename: string) => Database = require('better-sqlite3')
// Independent coordinates: no production recipe supplies expected events.
const points = [
  ['binary', 0, 0, 'transactions', 'transactionId'],
  ['binary', 1, 8, 'proven_txs', 'provenTxId'],
  ['binary', 2, 9, 'proven_tx_reqs', 'provenTxReqId'],
  ['binary', 3, 1, 'outputs', 'outputId'],
  ['binary', 4, 6, 'commissions', 'commissionId'],
  ['text', 0, 0, 'transactions', 'transactionId'],
  ['text', 2, 9, 'proven_tx_reqs', 'provenTxReqId'],
  ['text', 3, 1, 'outputs', 'outputId'],
  ['text', 4, 6, 'commissions', 'commissionId'],
  ['text', 5, 7, 'sync_states', 'syncStateId'],
  ['text', 6, 2, 'certificates', 'certificateId'],
  ['text', 7, 12, 'certificate_fields', 'rowid']
] as const
const definitions = () =>
  snapshotJournalPositionalEventSql([
    ...snapshotJournalPackedPointerObserverSql(false, true, true),
    ...snapshotJournalPackedPointerObserverSql(true, true, true)
  ])

test.each(points)(
  '%s pointer %i preserves original INSERT/DELETE parent selection',
  (family, id, tableId, table, key) => {
    const samples: unknown[][] = []
    for (const sql of [definitions(), snapshotJournalGroupedPointerSql(definitions())]) {
      const db = new SQLite(':memory:')
      try {
        db.exec(`CREATE TABLE captured(tableId,rowId);
        CREATE VIEW snapshot_journal_pointer_event(tableId,rowId) AS SELECT NULL,NULL WHERE 0;
        CREATE TRIGGER capture INSTEAD OF INSERT ON snapshot_journal_pointer_event BEGIN
          INSERT INTO captured VALUES(NEW.tableId,NEW.rowId); END;
        CREATE TABLE brc38_native_binary_fields(tableId,rowId);
        CREATE TABLE brc38_native_text_fields(tableId,rowId);`)
        for (const [name, column] of new Map(points.map(point => [point[3], point[4]])))
          db.exec(column === 'rowid' ? `CREATE TABLE ${name}(value)` : `CREATE TABLE ${name}(${column} INTEGER UNIQUE)`)
        db.exec(
          key === 'rowid' ? `INSERT INTO ${table}(rowid,value) VALUES(-5,1)` : `INSERT INTO ${table}(${key}) VALUES(-5)`
        )
        for (const definition of sql) db.exec(definition)
        const insert = db.prepare(`INSERT INTO brc38_native_${family}_fields VALUES(?,?)`),
          remove = db.prepare(`DELETE FROM brc38_native_${family}_fields WHERE tableId=? AND rowId=?`),
          read = (): unknown[] => db.prepare('SELECT * FROM captured').all()
        insert.run(id, -5)
        remove.run(id, -5)
        const initial = [
          { tableId, rowId: -5 },
          { tableId, rowId: -5 }
        ]
        expect(read()).toEqual(initial)
        db.exec('SAVEPOINT paired')
        insert.run(id, -5)
        db.exec('ROLLBACK TO paired; RELEASE paired')
        expect(read()).toEqual(initial)
        for (const [selectedId, rowId] of [
          [id, 404],
          [id, null],
          [null, -5],
          [999, -5]
        ] as const) {
          insert.run(selectedId, rowId)
          db.exec(`DELETE FROM brc38_native_${family}_fields`)
        }
        expect(read()).toEqual(initial)
        db.exec(
          key === 'rowid'
            ? `UPDATE ${table} SET rowid=-6 WHERE rowid=-5`
            : `UPDATE ${table} SET ${key}=-6 WHERE ${key}=-5`
        )
        insert.run(id, -5)
        remove.run(id, -5)
        expect(read()).toEqual(initial)
        insert.run(id, -6)
        remove.run(id, -6)
        db.exec(
          key === 'rowid' ? `INSERT INTO ${table}(rowid,value) VALUES(0,1)` : `INSERT INTO ${table}(${key}) VALUES(0)`
        )
        insert.run(id, 0)
        remove.run(id, 0)
        expect(read().slice(-4)).toEqual([
          { tableId, rowId: -6 },
          { tableId, rowId: -6 },
          { tableId, rowId: 0 },
          { tableId, rowId: 0 }
        ])
        insert.run(id, -6)
        db.exec(`DELETE FROM ${table}`)
        const before = read()
        remove.run(id, -6)
        expect(read()).toEqual(before)
        samples.push(read())
      } finally {
        db.close()
      }
    }
    expect(samples[1]).toEqual(samples[0])
  }
)

test('only complete fixed positional families group; all other definition DATA stays exact', () => {
  const original = definitions(),
    other = 'CREATE TABLE unrelated(id INTEGER PRIMARY KEY)',
    compact = snapshotJournalGroupedPointerSql([other, ...original])
  expect(original).toHaveLength(24)
  expect(compact).toHaveLength(5)
  expect(compact[0]).toBe(other)
  expect(snapshotJournalGroupedPointerSql([])).toEqual([])
  for (const bad of [
    original.slice(1),
    [...original, original[0]],
    original.map((sql, i) => (i === 0 ? sql.replace('VALUES(0,NEW.rowId)', 'VALUES(1,NEW.rowId)') : sql)),
    [...original, 'CREATE TRIGGER snapshot_journal_packed_unknown AFTER INSERT ON unknown BEGIN SELECT 1; END']
  ])
    expect(() => snapshotJournalGroupedPointerSql(bad)).toThrow('Invalid or unowned SQLite snapshot journal generation')
  expect(compact.reduce((n, sql) => n + Buffer.byteLength(sql), 0)).toBeLessThan(
    original.reduce((n, sql) => n + Buffer.byteLength(sql), 0)
  )
})

test('ordinary SQLite cannot select native grouped generation DATA', async () => {
  const original = definitions(),
    k = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    expect(await snapshotJournalNativePointerDefinitions(k, original)).toBe(original)
  } finally {
    await k.destroy()
  }
})
