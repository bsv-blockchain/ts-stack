import { brc38NativePackedParentGuards } from './Brc38NativePackedParentGuards'
import { brc38NativePackedBinaryBaseDefinitions } from './Brc38NativePackedSchemaNode'
import { brc38NativePackedTextBaseDefinitions } from './Brc38NativePackedTextSchemaNode'
import {
  brc38NativeCompactPackedDefinitions,
  brc38NativeLocalPackedFamilyDefinitions
} from './Brc38NativeLocalPackedLayout'

type Value = number | string | Buffer | null
interface Database {
  exec(sql: string): void
  prepare(sql: string): { run(...values: Value[]): void; all(): unknown[] }
  close(): void
}
const SQLite: new (filename: string) => Database = require('better-sqlite3')
// Independent coordinates include the real first field ID, parent key and all
// marker columns. Original production guards are the behavioral oracle.
const coordinates = [
  ['binary', 0, 'transactions', 'transactionId', 0, ['rawTx', 'inputBEEF', 'noSendExpiryReclaimRawTx']],
  ['binary', 1, 'proven_txs', 'provenTxId', 0, ['rawTx', 'merklePath']],
  ['binary', 2, 'proven_tx_reqs', 'provenTxReqId', 0, ['rawTx', 'inputBEEF']],
  ['binary', 3, 'outputs', 'outputId', 0, ['lockingScript']],
  ['binary', 4, 'commissions', 'commissionId', 0, ['lockingScript']],
  ['binary', 8, 'prepared_beefs', 'preparedBeefId', 0, ['beef']],
  ['binary', 9, 'action_batch_blobs', 'actionBatchBlobId', 0, ['bytes']],
  ['binary', 10, 'sync_transfer_parts', 'rowid', 0, ['bytes']],
  ['binary', 14, 'snapshot_reconciliation_stage_pages', 'rowid', 0, ['payload']],
  ['binary', 15, 'snapshot_reconciliation_provenance', 'rowid', 0, ['payload']],
  [
    'text',
    0,
    'transactions',
    'transactionId',
    3,
    ['description', 'noSendExpiryReclaimDerivationPrefix', 'noSendExpiryReclaimDerivationSuffix']
  ],
  ['text', 2, 'proven_tx_reqs', 'provenTxReqId', 2, ['history', 'notify']],
  [
    'text',
    3,
    'outputs',
    'outputId',
    1,
    [
      'outputDescription',
      'spendingDescription',
      'customInstructions',
      'derivationPrefix',
      'derivationSuffix',
      'type',
      'purpose'
    ]
  ],
  ['text', 4, 'commissions', 'commissionId', 1, ['keyOffset']],
  ['text', 5, 'sync_states', 'syncStateId', 0, ['syncMap', 'errorLocal', 'errorOther']],
  ['text', 6, 'certificates', 'certificateId', 0, ['subject', 'revocationOutpoint', 'signature', 'verifier']],
  ['text', 7, 'certificate_fields', 'rowid', 0, ['fieldValue', 'masterKey']],
  ['text', 11, 'action_batches', 'actionBatchId', 0, ['uploadDigests', 'result', 'manifest']],
  ['text', 12, 'sync_transfers', 'slot', 0, ['result']],
  ['text', 13, 'monitor_events', 'id', 0, ['details']]
] as const
function original(kind: 'binary' | 'text', literal: boolean, local = true): readonly string[] {
  const base = kind === 'binary' ? brc38NativePackedBinaryBaseDefinitions : brc38NativePackedTextBaseDefinitions
  return brc38NativeCompactPackedDefinitions(
    kind,
    local ? brc38NativeLocalPackedFamilyDefinitions(kind, base) : base,
    literal
  )
}
function parent(sql: string): boolean {
  return /^CREATE TRIGGER brc38_native_(binary|text)_fields_(row|move)_/.test(sql)
}

describe('grouped native packed parent admission', () => {
  test.each(coordinates.flatMap(coordinate => [false, true].map(literal => [...coordinate, literal] as const)))(
    '%s %i retains original marker, move and refusal behavior',
    (kind, id, table, key, first, fields, literal) => {
      const execute = (grouped: boolean): unknown[] => {
        const db = new SQLite(':memory:'),
          result: unknown[] = [],
          empty = kind === 'binary' ? Buffer.alloc(0) : ''
        try {
          const pointer = `brc38_native_${kind}_fields`,
            selected = original(kind, literal)
          db.exec(`CREATE TABLE ${pointer}(tableId INTEGER,rowId INTEGER,fieldId INTEGER);`)
          for (const source of coordinates.filter(value => value[0] === kind)) {
            db.exec(
              `CREATE TABLE ${source[2]}(${source[3] === 'rowid' ? '' : source[3] + ' INTEGER UNIQUE,'}${source[5].map(name => `"${name}" ${kind === 'binary' ? 'BLOB' : 'TEXT COLLATE RTRIM'}`).join(',')});`
            )
          }
          for (const sql of (grouped ? brc38NativePackedParentGuards(kind, selected) : selected).filter(parent))
            db.exec(sql)
          const put = (row: number, value: Value): void => {
            db.prepare(
              `INSERT INTO ${table}(${key},${fields.map(name => `"${name}"`).join(',')}) VALUES(${[key, ...fields].map(() => '?').join(',')})`
            ).run(row, ...fields.map(() => value))
          }
          const insert = db.prepare(`INSERT INTO ${pointer} VALUES(?,?,?)`),
            read = () => db.prepare(`SELECT * FROM ${pointer} ORDER BY rowid`).all()
          const attempt = (operation: () => void): void => {
            try {
              operation()
              result.push('accepted')
            } catch (error) {
              result.push((error as Error).message)
            }
            result.push(read())
          }
          put(42, empty)
          for (let field = first; field < first + fields.length; field++) attempt(() => insert.run(id, 42, field))
          attempt(() => insert.run(id, '42', first)) // original INTEGER affinity
          for (const value of [404, null, Buffer.from([42])]) attempt(() => insert.run(id, value, first))
          attempt(() => insert.run(id, 42, 999))
          for (const value of [null, 'not-empty', 0, kind === 'binary' ? '' : Buffer.alloc(0)]) {
            db.prepare(`UPDATE ${table} SET "${fields[0]}"=? WHERE ${key}=42`).run(value)
            attempt(() => insert.run(id, 42, first))
          }
          db.prepare(`UPDATE ${table} SET "${fields[0]}"=? WHERE ${key}=42`).run(empty)
          put(43, empty)
          attempt(() => db.exec(`UPDATE ${pointer} SET rowId=43 WHERE rowId=42`)) // old parent still exists
          db.exec(`DELETE FROM ${table} WHERE ${key}=42`)
          attempt(() => db.exec(`UPDATE ${pointer} SET rowId=404 WHERE rowId=42`)) // new parent absent
          attempt(() => db.exec(`UPDATE ${pointer} SET rowId=43 WHERE rowId=42`))
          const saved = read()
          db.exec('SAVEPOINT parent_guard')
          attempt(() => insert.run(id, 43, first))
          db.exec('ROLLBACK TO parent_guard; RELEASE parent_guard')
          expect(read()).toEqual(saved)
          // Irrelevant/NULL coordinates never acquire a parent verdict from
          // either family; the original field-table CHECK remains separate.
          attempt(() => insert.run(999, 43, first))
          attempt(() => insert.run(null, 43, first))
          return result
        } finally {
          db.close()
        }
      }
      const reference = execute(false)
      expect(reference).toContain('accepted')
      expect(reference.some(value => typeof value === 'string' && value.includes('metadata row'))).toBe(true)
      expect(reference.some(value => typeof value === 'string' && value.includes('key transition'))).toBe(true)
      expect(execute(true)).toEqual(reference)
    }
  )

  test('complete base and local families retain every unrelated definition', () => {
    for (const kind of ['binary', 'text'] as const)
      for (const local of [false, true]) {
        const source = original(kind, true, local),
          grouped = brc38NativePackedParentGuards(kind, source)
        expect(grouped.filter(sql => !parent(sql))).toEqual(source.filter(sql => !parent(sql)))
        expect(grouped.filter(parent)).toHaveLength(kind === 'text' && local ? 4 : 2)
        expect(Object.isFrozen(grouped)).toBe(true)
        expect(grouped.join('').length).toBeLessThan(source.join('').length)
      }
  })
  test('partial, duplicate, altered-parent and mismatched-move DATA refuse', () => {
    const source = original('binary', true),
      name = 'CREATE TRIGGER brc38_native_binary_fields_row_0 '
    const row = source.find(sql => sql.startsWith(name))!
    for (const altered of [
      source.filter(sql => sql !== row),
      [...source, row],
      source.map(sql => (sql === row ? sql.replace('FROM transactions w', 'FROM outputs w') : sql)),
      source.map(sql =>
        sql.startsWith('CREATE TRIGGER brc38_native_binary_fields_move_0 ')
          ? sql.replace('OLD.rowId', 'NEW.rowId')
          : sql
      )
    ])
      expect(() => brc38NativePackedParentGuards('binary', altered)).toThrow('DATA')
  })
})
