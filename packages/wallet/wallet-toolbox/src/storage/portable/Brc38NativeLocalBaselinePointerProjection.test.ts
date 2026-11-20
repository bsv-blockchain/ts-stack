import { brc38NativeLocalBaselinePointerProjection } from './Brc38NativeLocalBaselinePointerProjection'

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): { all(): unknown[] }
  close(): void
}
const Sqlite: new (filename: string) => SqliteDatabase = require('better-sqlite3')
const sources = [
  { family: 'binary', id: 0, table: 'transactions', key: 'transactionId', tableId: 7 },
  { family: 'text', id: 13, table: 'monitor_events', key: 'id', tableId: 15 }
] as const
const scenarios = [
  { name: 'insert uses physical rowid', operation: 'INSERT INTO $fields VALUES($id,42)', expected: [-5] },
  {
    name: 'delete marks the current parent present',
    before: 'INSERT INTO $fields VALUES($id,42)',
    operation: 'DELETE FROM $fields',
    expected: [-5]
  },
  { name: 'missing parent emits no event', operation: 'INSERT INTO $fields VALUES($id,404)', expected: [] },
  { name: 'different source ID emits no event', operation: 'INSERT INTO $fields VALUES(99,42)', expected: [] },
  {
    name: 'each pointer emits one current coordinate',
    operation: 'INSERT INTO $fields VALUES($id,42),($id,42)',
    expected: [-5, -5]
  },
  {
    name: 'current moved physical rowid is selected',
    before: 'UPDATE $parent SET rowid=-7',
    operation: 'INSERT INTO $fields VALUES($id,42)',
    expected: [-7]
  },
  {
    name: 'source and event roll back together',
    operation:
      'SAVEPOINT independent_rollback;INSERT INTO $fields VALUES($id,42);ROLLBACK TO independent_rollback;RELEASE independent_rollback',
    expected: []
  },
  {
    name: 'deleted parent emits no pointer-retirement event',
    before: 'INSERT INTO $fields VALUES($id,42);DELETE FROM $parent',
    operation: 'DELETE FROM $fields',
    expected: []
  },
  {
    name: 'replaced current parent supplies its physical rowid',
    before: 'DELETE FROM $parent;INSERT INTO $parent(rowid,$key) VALUES(-9,42)',
    operation: 'INSERT INTO $fields VALUES($id,42)',
    expected: [-9]
  }
]
describe.each([false, true])('baseline pointer projected=%s', projected => {
  describe.each(sources)('$family independent coordinate oracle', source => {
    test.each(scenarios)('$name', scenario => {
      const db = new Sqlite(':memory:')
      const expand = (sql: string) =>
        sql
          .replaceAll('$fields', `brc38_native_${source.family}_fields`)
          .replaceAll('$parent', source.table)
          .replaceAll('$key', source.key)
          .replaceAll('$id', String(source.id))
      try {
        // Independently authored physical parent and coordinate oracle. No
        // profile-owner, authorizer or complete-family authority is simulated.
        db.exec(`CREATE TABLE ${source.table}(${source.key} INTEGER UNIQUE);
          INSERT INTO ${source.table}(rowid,${source.key}) VALUES(-5,42);
          CREATE TABLE brc38_native_${source.family}_fields(tableId,rowId);
          CREATE TABLE independent_coordinates(tableId,oldRowId,newRowId,present);
          CREATE VIEW brc38_local_baseline_event(tableId,oldRowId,newRowId,present) AS SELECT NULL,NULL,NULL,NULL WHERE 0;
          CREATE TRIGGER independent_dispatch INSTEAD OF INSERT ON brc38_local_baseline_event BEGIN
            INSERT INTO independent_coordinates VALUES(NEW.tableId,NEW.oldRowId,NEW.newRowId,NEW.present); END`)
        for (const event of ['INSERT', 'DELETE'] as const) {
          const context = event === 'INSERT' ? 'NEW' : 'OLD'
          // Historical SQL is handwritten rather than derived from the new
          // implementation; expected coordinates below are independent data.
          const legacy = `CREATE TRIGGER brc38_local_baseline_packed_${source.family}_${source.id}_${event} AFTER ${event} ON brc38_native_${source.family}_fields WHEN ${context}.tableId=${source.id} AND EXISTS(SELECT 1 FROM ${source.table} s WHERE s.${source.key}=${context}.rowId) BEGIN INSERT INTO brc38_local_baseline_event VALUES(${source.tableId},NULL,(SELECT s.rowid FROM ${source.table} s WHERE s.${source.key}=${context}.rowId),1); END`
          db.exec(
            projected ? brc38NativeLocalBaselinePointerProjection(source.family, source, source.tableId, event) : legacy
          )
        }
        if ('before' in scenario && scenario.before !== undefined) db.exec(expand(scenario.before))
        db.exec('DELETE FROM independent_coordinates')
        db.exec(expand(scenario.operation))
        expect(
          db.prepare('SELECT tableId,oldRowId,newRowId,present FROM independent_coordinates ORDER BY rowid').all()
        ).toEqual(
          scenario.expected.map(newRowId => ({ tableId: source.tableId, oldRowId: null, newRowId, present: 1 }))
        )
      } finally {
        db.close()
      }
    })
  })
})
