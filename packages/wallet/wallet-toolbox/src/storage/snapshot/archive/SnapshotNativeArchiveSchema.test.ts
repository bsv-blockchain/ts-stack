import createKnex, { type Knex } from 'knex'
import { addSnapshotArchiveTables } from '../../schema/snapshotArchiveMigration'
import { addSnapshotArchiveRequestTable } from '../../schema/snapshotArchiveRequestMigration'
import { snapshotNativeArchiveDefinitions } from '../../schema/snapshotNativeArchiveSchema'

const tables = ['snapshot_archive_pages', 'snapshot_archive_requests'] as const
type Table = (typeof tables)[number]
function row(table: Table, key: string, ordinal: number) {
  return table === 'snapshot_archive_pages'
    ? {
        archiveId: key,
        sequence: ordinal,
        tableName: 'outputs',
        rows: 0,
        done: 1,
        digest: 'a'.repeat(64),
        payload: Buffer.from(Array.from({ length: ordinal === 0 ? 0 : 4096 }, (_, index) => index % 256))
      }
    : {
        identityKey: key,
        requestId: String(ordinal),
        claimToken: 'b'.repeat(64),
        state: 'claimed',
        requestJson: '{}',
        expiresAt: 12345,
        reservedBytes: 8192,
        archiveId: null,
        released: 0
      }
}
function key(table: Table, value: string, ordinal: number) {
  return table === 'snapshot_archive_pages'
    ? { archiveId: value, sequence: ordinal }
    : { identityKey: value, requestId: String(ordinal) }
}
async function database(): Promise<Knex> {
  return createKnex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
}
async function commands(table: Table, k: Knex): Promise<string[]> {
  const observed: string[] = []
  k.on('query', (query: { sql: string }) => {
    if (query.sql.startsWith(`create table \`${table}\``) || query.sql.startsWith(`create index \`${table}_`))
      observed.push(query.sql)
  })
  if (table === 'snapshot_archive_pages') await addSnapshotArchiveTables(k)
  else await addSnapshotArchiveRequestTable(k)
  return observed
}
async function contents(k: Knex, table: Table) {
  return await k(table).orderBy(
    table === 'snapshot_archive_pages' ? ['archiveId', 'sequence'] : ['identityKey', 'requestId']
  )
}

describe('fresh native auxiliary archive primary trees', () => {
  test.each(tables)('%s retains original key, payload and rollback semantics', async table => {
    const original = await database(),
      clustered = await database()
    try {
      const ddl = await commands(table, original)
      for (const sql of snapshotNativeArchiveDefinitions(
        table,
        ddl.map(sql => ({ sql }))
      ))
        await clustered.raw(sql)
      const shape = async (k: Knex) => await k.raw('PRAGMA table_xinfo(??)', [table])
      expect(await shape(clustered)).toEqual(await shape(original))
      for (const [k, wr] of [
        [original, 0],
        [clustered, 1]
      ] as const) {
        expect((await k.raw('PRAGMA table_list(??)', [table]))[0].wr).toBe(wr)
        const indexes: Array<{ name: string }> = await k.raw('PRAGMA index_list(??)', [table])
        expect(indexes.some(index => index.name === `${table}_expiresat_index`)).toBe(
          table === 'snapshot_archive_requests'
        )
        for (const value of [row(table, 'Alpha', 0), row(table, 'alpha', 1), row(table, 'Alpha', 2)])
          await k(table).insert(value)
        await expect(k(table).insert(row(table, 'Alpha', 0))).rejects.toThrow()
        for (const column of table === 'snapshot_archive_pages'
          ? ['archiveId', 'sequence']
          : ['identityKey', 'requestId'])
          await expect(k(table).insert({ ...row(table, 'other', 3), [column]: null })).rejects.toThrow()
        await k.transaction(async trx => {
          await trx(table)
            .where(key(table, 'Alpha', 2))
            .update(key(table, 'Beta', 7))
          await trx(table)
            .where(key(table, 'Alpha', 0))
            .delete()
          await trx.rollback()
        })
      }
      expect(await contents(clustered, table)).toEqual(await contents(original, table))
      for (const k of [original, clustered]) {
        await k(table)
          .where(key(table, 'Alpha', 2))
          .update(key(table, 'Beta', 7))
        await k(table)
          .where(key(table, 'Alpha', 0))
          .delete()
      }
      expect(await contents(clustered, table)).toEqual(await contents(original, table))
      const roots = async (k: Knex) =>
        Number(
          (await k('sqlite_schema').where({ tbl_name: table }).where('rootpage', '>', 0).count({ n: '*' }).first())?.n
        )
      expect(await roots(clustered)).toBe((await roots(original)) - 1)
    } finally {
      await original.destroy()
      await clustered.destroy()
    }
  })

  test.each(tables)('%s refuses altered, bound, incomplete or extra definition DATA', async table => {
    const k = await database()
    try {
      const ddl = (await commands(table, k)).map(sql => ({ sql }))
      for (const changed of [
        [],
        [...ddl, { sql: 'SELECT 1' }],
        ddl.map((command, index) => (index === 0 ? { sql: command.sql.replace(' not null', '') } : command)),
        ddl.map(command => ({ ...command, bindings: ['untrusted'] })),
        ddl.map((command, index) => (index === 0 ? { sql: command.sql + ' WITHOUT ROWID' } : command))
      ])
        expect(() => snapshotNativeArchiveDefinitions(table, changed)).toThrow('exact fresh private migration')
    } finally {
      await k.destroy()
    }
  })

  test.each(tables)('%s occupied ordinary migration remains unchanged', async table => {
    const k = await database()
    try {
      await commands(table, k)
      await k(table).insert(row(table, 'retained', 1))
      const schema = await k('sqlite_schema').where({ tbl_name: table }).orderBy('name'),
        before = await contents(k, table)
      if (table === 'snapshot_archive_pages') await addSnapshotArchiveTables(k)
      else await addSnapshotArchiveRequestTable(k)
      expect(await k('sqlite_schema').where({ tbl_name: table }).orderBy('name')).toEqual(schema)
      expect(await contents(k, table)).toEqual(before)
      expect((await k.raw('PRAGMA table_list(??)', [table]))[0].wr).toBe(0)
    } finally {
      await k.destroy()
    }
  })
})
