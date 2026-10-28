import { brc38NativeLocalBaselineCompactObserverNames } from './Brc38NativeLocalBaselineObserverNames'
interface Database {
  exec(sql: string): void
  prepare(sql: string): { all(): unknown[] }
  close(): void
}
const Sqlite: new (filename: string) => Database = require('better-sqlite3')
// Independent fixed source coordinates, separate from the implementation.
const tables = [
  'users',
  'settings',
  'proven_txs',
  'proven_tx_reqs',
  'output_baskets',
  'output_tags',
  'tx_labels',
  'transactions',
  'outputs',
  'commissions',
  'tx_labels_map',
  'output_tags_map',
  'certificates',
  'certificate_fields',
  'sync_states',
  'monitor_events',
  'prepared_beef_metadata',
  'prepared_beefs',
  'action_batches',
  'action_batch_outputs',
  'action_batch_blobs',
  'sync_transfers',
  'sync_transfer_parts',
  'auth_sessions',
  'auth_message_nonces',
  'payment_replays',
  'snapshot_sync_sessions',
  'snapshot_sync_ids',
  'snapshot_sync_primary_epochs',
  'snapshot_reconciliation_windows',
  'snapshot_reconciliation_stage_budgets',
  'snapshot_reconciliation_stage_pages',
  'snapshot_reconciliation_stage_chains',
  'snapshot_reconciliation_promotion_cursors',
  'snapshot_reconciliation_captured_identity_budgets',
  'snapshot_reconciliation_captured_identities',
  'snapshot_reconciliation_identity_frames',
  'snapshot_reconciliation_identity_budgets',
  'snapshot_reconciliation_identity_maps',
  'snapshot_reconciliation_identity_retirement_budgets',
  'snapshot_reconciliation_identity_retirements',
  'snapshot_reconciliation_membership_budgets',
  'snapshot_reconciliation_memberships',
  'snapshot_reconciliation_membership_retirements',
  'snapshot_reconciliation_provenance_budgets',
  'snapshot_reconciliation_provenance',
  'snapshot_reconciliation_window_progress'
] as const
const events = ['insert', 'delete', 'update'] as const
function definitions(table: string, id: number): string[] {
  return events.map(
    (event, index) =>
      'CREATE TRIGGER brc38_local_baseline_' +
      table +
      '_' +
      event +
      ' AFTER ' +
      event.toUpperCase() +
      ' ON ' +
      table +
      ' BEGIN INSERT INTO captured VALUES(' +
      id +
      ',' +
      (index === 0 ? 'NULL' : 'OLD.rowid') +
      ',' +
      (index === 1 ? 'NULL' : 'NEW.rowid') +
      ',' +
      (index === 1 ? 0 : 1) +
      '); END'
  )
}
describe('fresh compact baseline observer names', () => {
  test.each(tables.map((table, id) => [table, id] as const))(
    '%s retains physical insert, move, delete and rollback',
    (table, id) => {
      const db = new Sqlite(':memory:')
      try {
        db.exec(
          'CREATE TABLE ' + table + '(id INTEGER PRIMARY KEY); CREATE TABLE captured(tableId,oldRowId,newRowId,present)'
        )
        const original = definitions(table, id)
        const compact = brc38NativeLocalBaselineCompactObserverNames(original)
        expect(compact).toEqual(
          original.map((sql, index) =>
            sql.replace(
              'brc38_local_baseline_' + table + '_' + events[index],
              'brc38_local_baseline_s' + id + '_' + events[index]
            )
          )
        )
        for (const sql of compact) db.exec(sql)
        db.exec('INSERT INTO ' + table + ' VALUES(-5);UPDATE ' + table + ' SET id=-7;DELETE FROM ' + table)
        const expected = [
          { tableId: id, oldRowId: null, newRowId: -5, present: 1 },
          { tableId: id, oldRowId: -5, newRowId: -7, present: 1 },
          { tableId: id, oldRowId: -7, newRowId: null, present: 0 }
        ]
        expect(db.prepare('SELECT * FROM captured').all()).toEqual(expected)
        db.exec('SAVEPOINT independent;INSERT INTO ' + table + ' VALUES(9);ROLLBACK TO independent;RELEASE independent')
        expect(db.prepare('SELECT * FROM captured').all()).toEqual(expected)
        expect(db.prepare('SELECT * FROM ' + table).all()).toEqual([])
        for (const event of events) db.exec('DROP TRIGGER brc38_local_baseline_s' + id + '_' + event)
        for (const sql of original) db.exec(sql)
        db.exec('INSERT INTO ' + table + ' VALUES(-5);UPDATE ' + table + ' SET id=-7;DELETE FROM ' + table)
        expect(db.prepare('SELECT * FROM captured').all()).toEqual([...expected, ...expected])
      } finally {
        db.close()
      }
    }
  )
  test('only fixed original source observer headers change', () => {
    const all = tables.flatMap((table, id) => definitions(table, id))
    const compact = brc38NativeLocalBaselineCompactObserverNames(all)
    expect(compact.length).toBe(141)
    expect(all.reduce((sum, sql, index) => sum + Buffer.byteLength(sql) - Buffer.byteLength(compact[index]), 0)).toBe(
      3027
    )
    const untouched = [
      'CREATE TABLE brc38_local_baseline_clock(slot INTEGER PRIMARY KEY)',
      'CREATE TRIGGER brc38_local_baseline_users_insert BEFORE INSERT ON users BEGIN SELECT 1; END',
      'CREATE TRIGGER brc38_local_baseline_foreign_insert AFTER INSERT ON users BEGIN SELECT 1; END',
      'CREATE TRIGGER brc38_local_baseline_packed_binary_INSERT AFTER INSERT ON brc38_native_binary_fields BEGIN SELECT 1; END'
    ]
    expect(brc38NativeLocalBaselineCompactObserverNames(untouched)).toEqual(untouched)
    expect(brc38NativeLocalBaselineCompactObserverNames(compact)).toEqual(compact)
    expect(Object.isFrozen(compact)).toBe(true)
  })
})
