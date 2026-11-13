import { brc38NativeLocalJournalPayloadQuotaDefinitions } from './Brc38NativeLocalPackedLayout'

// CommonJS driver's narrow test-only surface; no public declaration or
// dependency changes are needed for this independent SQL oracle.
interface SqliteDatabase {
  exec(sql: string): void
  transaction(action: () => void): () => void
  prepare(sql: string): { get(): unknown }
  close(): void
}
const Sqlite: new (filename: string) => SqliteDatabase = require('better-sqlite3')
const limit = 17179869184
interface Scenario {
  name: string
  before?: string
  operation: string
  bytes: number | null
  bit: number | null
  pointers: number
  reject?: boolean
}
const scenarios: Scenario[] = [
  {
    name: 'empty reference',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'empty')",
    bytes: 0,
    bit: 1,
    pointers: 1
  },
  {
    name: 'sealed two-byte reference',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a')",
    bytes: 8,
    bit: 1,
    pointers: 1
  },
  {
    name: 'shared content charged per reference',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a'),($id,2,0,'a')",
    bytes: 16,
    bit: 0,
    pointers: 2
  },
  {
    name: 'replacement charges the exact byte difference',
    before:
      "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a'); UPDATE snapshot_reconciliation_shared_quota SET bytes=8",
    operation: "UPDATE brc38_native_binary_fields SET sha256='b'",
    bytes: 12,
    bit: 1,
    pointers: 1
  },
  {
    name: 'physical pointer move retains its payload charge',
    before:
      "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a'); UPDATE snapshot_reconciliation_shared_quota SET bytes=8",
    operation: 'UPDATE brc38_native_binary_fields SET rowId=2',
    bytes: 8,
    bit: 1,
    pointers: 1
  },
  {
    name: 'deletion releases the sealed charge',
    before:
      "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a'); UPDATE snapshot_reconciliation_shared_quota SET bytes=8",
    operation: 'DELETE FROM brc38_native_binary_fields',
    bytes: 0,
    bit: 1,
    pointers: 0
  },
  {
    name: 'missing version aborts the pointer',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'missing')",
    bytes: 0,
    bit: 0,
    pointers: 0,
    reject: true
  },
  {
    name: 'pending version cannot become a free reference',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'pending')",
    bytes: 0,
    bit: 0,
    pointers: 0,
    reject: true
  },
  {
    name: 'incomplete sealed version cannot become a free reference',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'incomplete')",
    bytes: 0,
    bit: 0,
    pointers: 0,
    reject: true
  },
  {
    name: 'missing counter aborts the pointer',
    before: 'DELETE FROM snapshot_reconciliation_shared_quota',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a')",
    bytes: null,
    bit: null,
    pointers: 0,
    reject: true
  },
  {
    name: 'underflow preserves the pointer',
    before: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a')",
    operation: 'DELETE FROM brc38_native_binary_fields',
    bytes: 0,
    bit: 0,
    pointers: 1,
    reject: true
  },
  {
    name: 'wrong byte ceiling is rejected',
    before: 'UPDATE snapshot_reconciliation_shared_quota SET byteLimit=17179869183',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a')",
    bytes: 0,
    bit: 0,
    pointers: 0,
    reject: true
  },
  {
    name: 'wrong row ceiling is rejected',
    before: 'UPDATE snapshot_reconciliation_shared_quota SET rowLimit=2147483646',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a')",
    bytes: 0,
    bit: 0,
    pointers: 0,
    reject: true
  },
  {
    name: 'invalid change bit is rejected',
    before: 'UPDATE snapshot_reconciliation_shared_quota SET changeBit=2',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a')",
    bytes: 0,
    bit: 2,
    pointers: 0,
    reject: true
  },
  {
    name: 'exact ceiling is accepted',
    before: 'UPDATE snapshot_reconciliation_shared_quota SET bytes=17179869176',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a')",
    bytes: limit,
    bit: 1,
    pointers: 1
  },
  {
    name: 'one-byte budget deficit is rejected',
    before: 'UPDATE snapshot_reconciliation_shared_quota SET bytes=17179869177',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a')",
    bytes: limit - 7,
    bit: 0,
    pointers: 0,
    reject: true
  },
  {
    name: 'four-GiB sealed length retains integer arithmetic',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'huge')",
    bytes: limit,
    bit: 1,
    pointers: 1
  },
  {
    name: 'four-GiB plus one exceeds the ceiling',
    operation: "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'oversized')",
    bytes: 0,
    bit: 0,
    pointers: 0,
    reject: true
  },
  {
    name: 'later rejected reference rolls back earlier charge',
    operation:
      "INSERT INTO brc38_native_binary_fields VALUES($id,1,0,'a'); INSERT INTO brc38_native_binary_fields VALUES($id,2,0,'missing')",
    bytes: 0,
    bit: 0,
    pointers: 0,
    reject: true
  }
]
function fixture(): SqliteDatabase {
  const db = new Sqlite(':memory:')
  // Independent minimal SQL oracle for payload quota only. Profile ownership,
  // complete source guards and physical native limits require separate tests.
  db.exec(`CREATE TABLE snapshot_reconciliation_shared_quota(id INTEGER,bytes INTEGER,changeBit INTEGER,byteLimit INTEGER,rowLimit INTEGER);
    INSERT INTO snapshot_reconciliation_shared_quota VALUES(0,0,0,17179869184,2147483647);
    CREATE TABLE brc38_native_binary_versions(sha256 TEXT,bytes INTEGER,state TEXT,accepted INTEGER);
    INSERT INTO brc38_native_binary_versions VALUES('empty',0,'SEALED',0),('a',2,'SEALED',2),('b',3,'SEALED',3),('pending',2,'PENDING',2),('incomplete',2,'SEALED',1),('huge',4294967296,'SEALED',4294967296),('oversized',4294967297,'SEALED',4294967297);
    CREATE TABLE brc38_native_binary_fields(tableId INTEGER,rowId INTEGER,fieldId INTEGER,sha256 TEXT);`)
  return db
}
describe.each([false, true])('local payload quota projected=%s', projected => {
  test.each(scenarios)('$name', scenario => {
    for (const id of [14, 15]) {
      const db = fixture()
      try {
        if (scenario.before !== undefined) db.exec(scenario.before.replaceAll('$id', String(id)))
        for (const sql of brc38NativeLocalJournalPayloadQuotaDefinitions(projected)) db.exec(sql)
        const operation = db.transaction(() => db.exec(scenario.operation.replaceAll('$id', String(id))))
        if (scenario.reject) {
          expect(operation).toThrow('Shared logical journal payload quota exhausted or inconsistent')
          try {
            operation()
          } catch (error) {
            expect(error).toMatchObject({ code: 'SQLITE_CONSTRAINT_TRIGGER' })
          }
        } else operation()
        const counter = db
          .prepare('SELECT bytes,changeBit FROM snapshot_reconciliation_shared_quota WHERE id=0')
          .get() as { bytes: number; changeBit: number } | undefined
        expect(counter?.bytes ?? null).toBe(scenario.bytes)
        expect(counter?.changeBit ?? null).toBe(scenario.bit)
        expect(db.prepare('SELECT count(*) AS count FROM brc38_native_binary_fields').get()).toEqual({
          count: scenario.pointers
        })
      } finally {
        db.close()
      }
    }
  })
})
