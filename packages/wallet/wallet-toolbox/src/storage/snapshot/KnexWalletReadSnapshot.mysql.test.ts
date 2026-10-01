import { knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageProvider } from '../StorageProvider'
import { walletSnapshotSourceQuery } from './KnexWalletReadSnapshot'

const identity = '02' + '11'.repeat(32)
const when = new Date('2026-01-01T00:00:00.000Z')

/** Actual installed Knex MySQL compiler/transaction protocol with a bounded driver response oracle. */
function fixture(fieldCount = 6, bytes = 524, certificate = false, deleted: boolean | number = 0) {
  const db = knex({ client: 'mysql2' })
  const source = new StorageKnex({ ...StorageProvider.createStorageBaseOptions('test'), knex: db })
  const queries: Array<{ sql: string; bindings: unknown[] }> = []
  const fields = certificate
    ? ['fieldName', 'certificateId', 'userId', 'created_at', 'updated_at', 'fieldValue', 'masterKey']
    : ['txLabelId', 'userId', 'created_at', 'updated_at', 'label', 'isDeleted']
  const table = certificate ? 'certificate_fields' : 'tx_labels'
  const fieldName = '😀'.repeat(100)
  const connection = {
    destroy() {},
    query(
      query: { sql: string },
      bindings: unknown[],
      callback: (error: Error | null, rows?: unknown[], fields?: unknown[]) => void
    ) {
      queries.push({ sql: query.sql, bindings })
      if (query.sql.startsWith('select * from information_schema.tables')) {
        // This fixture represents an unmigrated externally supplied pool.
        expect(query.sql).toBe(
          'select * from information_schema.tables where table_name = ? and table_schema = database()'
        )
        expect(bindings).toEqual(['knex_migrations'])
        callback(null, [], [])
      } else if (query.sql.startsWith('SELECT COLUMN_NAME')) {
        expect(query.sql).toBe(
          'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION LIMIT 65'
        )
        expect(bindings).toEqual([table])
        callback(
          null,
          Array.from({ length: fieldCount }, (_, i) => ({ name: fields[i] ?? `extra${i}` })),
          []
        )
      } else if (query.sql.includes('__snapshotBytes')) {
        if (certificate) {
          expect(query.sql).toContain('case when octet_length(`fieldName`) <= 400 then `fieldName` end as `fieldName`')
          expect(query.sql).toContain('`certificate_fields`.`userId` = ?')
          const after = query.sql.includes('`fieldName` > ?')
          if (after) {
            expect(query.sql).toContain('OR (`fieldName` = ? AND `certificateId` > ?)')
            expect(bindings.slice(-4)).toEqual([fieldName, fieldName, 1, 128])
          }
          callback(null, after ? [] : [{ fieldName, certificateId: 1, __snapshotBytes: bytes, __snapshotOwned: 1 }], [])
        } else {
          expect(query.sql).toContain('octet_length(`label`)')
          expect(query.sql).toContain('`tx_labels`.`userId` = ?')
          expect(bindings).toEqual([1, 128])
          callback(null, [{ txLabelId: 1, __snapshotBytes: bytes, __snapshotOwned: 1 }], [])
        }
      } else if (query.sql.includes('`certificate_fields`.*')) {
        callback(
          null,
          [
            {
              fieldName,
              certificateId: 1,
              userId: 1,
              created_at: when,
              updated_at: when,
              fieldValue: 'value',
              masterKey: 'key'
            }
          ],
          []
        )
      } else if (query.sql.includes('`tx_labels`.*')) {
        callback(
          null,
          [{ txLabelId: 1, userId: 1, created_at: when, updated_at: when, label: 'retained', isDeleted: deleted }],
          []
        )
      } else if (/^(SET TRANSACTION|BEGIN|COMMIT|ROLLBACK)/.test(query.sql)) callback(null, [], [])
      else callback(new Error('Unexpected synthetic driver query'))
    }
  }
  jest.spyOn(db.client, 'acquireConnection').mockResolvedValue(connection)
  jest.spyOn(db.client, 'releaseConnection').mockResolvedValue(undefined)
  const settings = {
    created_at: when,
    updated_at: when,
    storageIdentityKey: 'synthetic',
    storageName: 'synthetic MySQL',
    chain: 'test' as const,
    dbtype: 'MySQL' as const,
    maxOutputScript: 1024
  }
  source._settings = settings
  jest.spyOn(source, 'makeAvailable').mockResolvedValue(settings)
  jest.spyOn(source, 'readSettings').mockResolvedValue(settings)
  jest.spyOn(source, 'findUserByIdentityKey').mockResolvedValue({
    created_at: when,
    updated_at: when,
    userId: 1,
    identityKey: identity,
    activeStorage: 'synthetic'
  })
  return { source, db, queries }
}

afterEach(() => jest.restoreAllMocks())

test('MySQL preflights complete Unicode keys and preserves a boolean-returning pool typecast', async () => {
  const { source } = fixture(7, 1352, true)
  try {
    const view = await source.openWalletReadSnapshot(identity)
    const page = await view.readPage('certificateFields')
    expect(page.rows[0].fieldName).toBe('😀'.repeat(100))
    expect(page.cursor?.after).toEqual(['😀'.repeat(100), 1])
    expect(await view.readPage('certificateFields', page.cursor)).toMatchObject({
      rows: [],
      done: true,
      payloadBytes: 0
    })
    await view.close()
  } finally {
    await source.destroy()
  }
  const second = fixture(6, 524, false, false)
  try {
    const view = await second.source.openWalletReadSnapshot(identity)
    expect((await view.readPage('txLabels')).rows[0].isDeleted).toBe(false)
    await view.close()
  } finally {
    await second.source.destroy()
  }
})

test.each([
  ['txLabelMaps', 'tx_labels_map', 'txLabelId', 'transactionId', 0],
  ['outputTagMaps', 'output_tags_map', 'outputTagId', 'outputId', 1]
] as const)(
  'MySQL %s uses the cursor-order auxiliary primary key and both map keys',
  (table, name, left, right, tableId) => {
    const k = knex({ client: 'mysql2' })
    const query = walletSnapshotSourceQuery(k, table, 41, true, true).select(`${name}.*`).toSQL()
    expect(query.sql).toContain('from `snapshot_relation_keys` FORCE INDEX (`PRIMARY`) cross join `' + name + '`')
    expect(query.sql).toContain(
      '`snapshotLeftId` = `' + name + '`.`' + left + '` and `snapshotRightId` = `' + name + '`.`' + right + '`'
    )
    expect(query.bindings).toEqual([tableId, 41])
    const legacy = walletSnapshotSourceQuery(k, table, 41).toSQL()
    expect(legacy.sql).not.toContain('snapshot_relation_keys')
    expect(legacy.sql).toContain('or exists')
  }
)

test.each([6, 64])(
  'MySQL metadata resolves DATABASE() without a configured connection database and caches %s columns',
  async count => {
    const { source, db, queries } = fixture(count)
    try {
      const view = await source.openWalletReadSnapshot(identity)
      const first = await view.readPage('txLabels')
      expect(first.rows[0]).toMatchObject({
        txLabelId: 1,
        userId: 1,
        label: 'retained',
        isDeleted: false,
        created_at: when
      })
      expect(first.payloadBytes).toBe(524)
      expect(first.done).toBe(true)
      expect(await view.readPage('txLabels')).toEqual(first)
      expect(queries.filter(query => query.sql.startsWith('SELECT COLUMN_NAME'))).toHaveLength(1)
      await view.close()
    } finally {
      await source.destroy()
      await db.destroy()
    }
  }
)

test.each([0, 65])('rejects an unsupported schema with %s columns before row payload queries', async count => {
  const { source, queries } = fixture(count)
  try {
    const view = await source.openWalletReadSnapshot(identity)
    await expect(view.readPage('txLabels')).rejects.toThrow('Unsupported snapshot schema')
    await expect(view.closed).rejects.toThrow('Unsupported snapshot schema')
    expect(queries.some(query => query.sql.includes('__snapshotBytes'))).toBe(false)
  } finally {
    await source.destroy()
  }
})

test.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  'invalid driver row charge %s cannot admit payload allocation',
  async bytes => {
    const { source, queries } = fixture(6, bytes)
    try {
      const view = await source.openWalletReadSnapshot(identity)
      await expect(view.readPage('txLabels')).rejects.toThrow('Invalid snapshot row size')
      await expect(view.closed).rejects.toThrow('Invalid snapshot row size')
      expect(queries.some(query => query.sql.includes('`tx_labels`.*'))).toBe(false)
    } finally {
      await source.destroy()
    }
  }
)
