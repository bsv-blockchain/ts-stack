import { brc38NativeLocalBaselinePointerGroup } from './Brc38NativeLocalBaselinePointerGroup'

interface SqliteDatabase {
  exec(sql: string): void
  prepare(sql: string): { run(...bindings: Array<number | null>): void; all(): unknown[] }
  close(): void
}
const Database: new (filename: string) => SqliteDatabase = require('better-sqlite3')

// Independent original coordinates, deliberately separate from production DATA.
const coordinates = [
  ['binary', 0, 'transactions', 'transactionId', 7],
  ['binary', 1, 'proven_txs', 'provenTxId', 2],
  ['binary', 2, 'proven_tx_reqs', 'provenTxReqId', 3],
  ['binary', 3, 'outputs', 'outputId', 8],
  ['binary', 4, 'commissions', 'commissionId', 9],
  ['binary', 8, 'prepared_beefs', 'preparedBeefId', 17],
  ['binary', 9, 'action_batch_blobs', 'actionBatchBlobId', 20],
  ['binary', 10, 'sync_transfer_parts', 'rowid', 22],
  ['binary', 14, 'snapshot_reconciliation_stage_pages', 'rowid', 31],
  ['binary', 15, 'snapshot_reconciliation_provenance', 'rowid', 45],
  ['text', 0, 'transactions', 'transactionId', 7],
  ['text', 2, 'proven_tx_reqs', 'provenTxReqId', 3],
  ['text', 3, 'outputs', 'outputId', 8],
  ['text', 4, 'commissions', 'commissionId', 9],
  ['text', 5, 'sync_states', 'syncStateId', 14],
  ['text', 6, 'certificates', 'certificateId', 12],
  ['text', 7, 'certificate_fields', 'rowid', 13],
  ['text', 11, 'action_batches', 'actionBatchId', 18],
  ['text', 12, 'sync_transfers', 'slot', 21],
  ['text', 13, 'monitor_events', 'id', 15]
] as const

describe('shared native baseline pointer effects', () => {
  test.each(coordinates)('%s %i selects the original physical coordinate', (family, id, table, key, tableId) => {
    const db = new Database(':memory:')
    try {
      db.exec(`CREATE TABLE captured(tableId,oldRowId,newRowId,present);
        CREATE VIEW brc38_local_baseline_event(tableId,oldRowId,newRowId,present) AS SELECT NULL,NULL,NULL,NULL WHERE 0;
        CREATE TRIGGER capture INSTEAD OF INSERT ON brc38_local_baseline_event BEGIN
          INSERT INTO captured VALUES(NEW.tableId,NEW.oldRowId,NEW.newRowId,NEW.present); END;
        CREATE TABLE brc38_native_${family}_fields(tableId,rowId);`)
      const sources = coordinates
        .filter(c => c[0] === family)
        .map(c => ({ id: c[1], table: c[2], key: c[3], tableId: c[4] }))
      for (const source of sources) {
        db.exec(
          source.key === 'rowid'
            ? `CREATE TABLE ${source.table}(value)`
            : `CREATE TABLE ${source.table}(${source.key} INTEGER UNIQUE)`
        )
      }
      db.exec(
        key === 'rowid'
          ? `INSERT INTO ${table}(rowid,value) VALUES(-5,1)`
          : `INSERT INTO ${table}(rowid,${key}) VALUES(-5,42)`
      )
      for (const event of ['INSERT', 'DELETE'] as const)
        db.exec(brc38NativeLocalBaselinePointerGroup(family, sources, event))
      const insert = db.prepare(`INSERT INTO brc38_native_${family}_fields VALUES(?,?)`),
        remove = db.prepare(`DELETE FROM brc38_native_${family}_fields WHERE tableId=? AND rowId=?`),
        read = () => db.prepare('SELECT * FROM captured').all(),
        reference = key === 'rowid' ? -5 : 42,
        expected = { tableId, oldRowId: null, newRowId: -5, present: 1 }
      insert.run(id, reference)
      remove.run(id, reference)
      expect(read()).toEqual([expected, expected])
      db.exec('SAVEPOINT independent')
      insert.run(id, reference)
      db.exec('ROLLBACK TO independent; RELEASE independent')
      expect(read()).toEqual([expected, expected])
      insert.run(id, 404)
      remove.run(id, 404)
      insert.run(id, null)
      db.prepare(`DELETE FROM brc38_native_${family}_fields WHERE rowId IS NULL`).run()
      insert.run(null, reference)
      remove.run(null, reference)
      insert.run(999, reference)
      remove.run(999, reference)
      expect(read()).toEqual([expected, expected])
      db.exec(`UPDATE ${table} SET rowid=-6 WHERE rowid=-5`)
      const moved = key === 'rowid' ? -6 : reference
      insert.run(id, moved)
      remove.run(id, moved)
      expect(read()).toEqual([expected, expected, { ...expected, newRowId: -6 }, { ...expected, newRowId: -6 }])
      db.exec(
        key === 'rowid'
          ? `INSERT INTO ${table}(rowid,value) VALUES(0,1)`
          : `INSERT INTO ${table}(rowid,${key}) VALUES(17,0)`
      )
      insert.run(id, 0)
      remove.run(id, 0)
      expect(read().slice(-2)).toEqual([
        { ...expected, newRowId: key === 'rowid' ? 0 : 17 },
        { ...expected, newRowId: key === 'rowid' ? 0 : 17 }
      ])
    } finally {
      db.close()
    }
  })
})
