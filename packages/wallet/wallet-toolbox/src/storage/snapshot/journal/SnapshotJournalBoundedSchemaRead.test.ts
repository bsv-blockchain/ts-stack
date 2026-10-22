import { knex, type Knex } from 'knex'
import { readBoundedSnapshotJournalSqliteSchema } from './SnapshotJournalSqliteGeneration'

async function fixture(run: (k: Knex) => Promise<void>): Promise<void> {
  const k = knex({ client: 'better-sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true })
  try {
    await k.raw('CREATE TABLE users(id INTEGER PRIMARY KEY, identityKey TEXT UNIQUE)')
    await run(k)
  } finally {
    await k.destroy()
  }
}
async function inventory(
  k: Knex
): Promise<Array<{ type: string; name: string; tbl_name: string; sql: string | null }>> {
  return await k('main.sqlite_schema')
    .where({ tbl_name: 'users' })
    .select('type', 'name', 'tbl_name', 'sql')
    .orderBy(['type', 'name'])
}
function blobBytes(value: unknown): number {
  if (Buffer.isBuffer(value)) return value.length
  if (Array.isArray(value)) return value.reduce((total, part) => total + blobBytes(part), 0)
  if (value !== null && typeof value === 'object')
    return Object.values(value).reduce<number>((total, part) => total + blobBytes(part), 0)
  return 0
}

test('small fresh schema rows retain exact values with one bounded response per object', async () => {
  await fixture(async k => {
    await k.raw("CREATE TRIGGER unicode_small AFTER INSERT ON users BEGIN SELECT '🙂\n a  b ﻿é'; END")
    const expected = await inventory(k)
    expect(expected.some(row => row.sql === null)).toBe(true)
    await k.transaction(async trx => {
      const queries: string[] = [],
        responses: number[] = []
      const query = (value: { sql: string }): void => {
        queries.push(value.sql)
      }
      const response = (value: unknown): void => {
        responses.push(blobBytes(value))
      }
      trx.on('query', query).on('query-response', response)
      try {
        expect(await readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).toEqual(expected)
      } finally {
        trx.removeListener('query', query).removeListener('query-response', response)
      }
      expect(queries).toHaveLength(expected.length + 1)
      expect(queries.some(sql => sql.includes(' AS chunk'))).toBe(false)
      expect(responses.length).toBe(queries.length)
      expect(Math.max(...responses)).toBeLessThanOrEqual(16384)
      expect(responses.some(bytes => bytes > 0)).toBe(true)
    })
  })
})

test.each([16384, 16385])('combined %i-byte row keeps its exact bounded transfer and fallback', async bytes => {
  await fixture(async k => {
    const name = 'combined_boundary',
      prefix = `CREATE TRIGGER ${name} AFTER INSERT ON users BEGIN SELECT '🙂`,
      suffix = "'; END"
    const sql = prefix + 'x'.repeat(bytes - Buffer.byteLength('trigger' + name + 'users' + prefix + suffix)) + suffix
    await k.raw(sql)
    const expected = await inventory(k),
      row = expected.find(value => value.name === name)!
    expect(Object.values(row).reduce<number>((total, value) => total + Buffer.byteLength(value ?? ''), 0)).toBe(bytes)
    await k.transaction(async trx => {
      const queries: string[] = [],
        responses: number[] = []
      const query = (value: { sql: string }): void => {
        queries.push(value.sql)
      }
      const response = (value: unknown): void => {
        responses.push(blobBytes(value))
      }
      trx.on('query', query).on('query-response', response)
      try {
        expect(await readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).toEqual(expected)
      } finally {
        trx.removeListener('query', query).removeListener('query-response', response)
      }
      expect(queries.some(value => value.includes(' AS chunk'))).toBe(bytes > 16384)
      expect(Math.max(...responses)).toBeLessThanOrEqual(16384)
    })
  })
})

test('small schema transfer rereads mutation and real savepoint rollback without retaining a verdict', async () => {
  await fixture(async k => {
    const originalSql = "CREATE TRIGGER current_definition AFTER INSERT ON users BEGIN SELECT 'original'; END"
    await k.raw(originalSql)
    const original = await inventory(k)
    await k.transaction(async trx => {
      expect(await readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).toEqual(original)
      const rollback = new Error('independent bounded schema rollback')
      await expect(
        trx.transaction(async nested => {
          await nested.raw('DROP TRIGGER current_definition')
          await nested.raw("CREATE TRIGGER current_definition AFTER INSERT ON users BEGIN SELECT 'changed'; END")
          const changed = await inventory(nested)
          expect(changed).not.toEqual(original)
          expect(await readBoundedSnapshotJournalSqliteSchema(nested, ['users'])).toEqual(changed)
          throw rollback
        })
      ).rejects.toBe(rollback)
      expect(await readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).toEqual(original)
    })
  })
})

test('large schema keeps the original complete source JSON allowance and explicit excluded-name accounting', async () => {
  await fixture(async k => {
    const excluded = new Set<string>()
    for (let index = 0; index < 17; index++) {
      const name = `large_${index}`,
        prefix = `CREATE TRIGGER ${name} AFTER INSERT ON users BEGIN SELECT '`,
        suffix = "'; END"
      const sql = prefix + 'x'.repeat(65536 - Buffer.byteLength(prefix + suffix)) + suffix
      excluded.add(name)
      await k.raw(sql)
    }
    const expected = await inventory(k)
    expect(Buffer.byteLength(JSON.stringify(expected))).toBeGreaterThan(1048576)
    await k.transaction(async trx => {
      await expect(readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).rejects.toThrow('Invalid or unowned')
      expect(await readBoundedSnapshotJournalSqliteSchema(trx, ['users'], excluded)).toEqual(expected)
    })
  })
})

test('schema enumeration keeps the original 512-object bound', async () => {
  await fixture(async k => {
    for (let index = 0; index < 511; index++)
      await k.raw(`CREATE TRIGGER object_${index} AFTER INSERT ON users BEGIN SELECT 1; END`)
    expect(await inventory(k)).toHaveLength(513)
    await k.transaction(async trx => {
      await expect(readBoundedSnapshotJournalSqliteSchema(trx, ['users'])).rejects.toThrow('Invalid or unowned')
    })
  })
})
