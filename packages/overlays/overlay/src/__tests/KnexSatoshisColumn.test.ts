import { knex as createKnex, type Knex } from 'knex'
import allMigrations from '../storage/knex/all-migrations.js'
import { down, up } from '../storage/knex/migrations/2026-11-22-001-widen-satoshis-column.js'

// A connectionless Knex for the dialect generates the real DDL; the schema calls the
// migration makes are recorded instead of executed. `oversized` is what the down's range
// check finds in outputs.
function recordingKnex(
  client: string,
  { hasColumn = true, oversized = false } = {}
): { knex: Knex; sql: string[]; rangeChecks: unknown[][] } {
  const dialect = createKnex({ client, useNullAsDefault: true })
  const sql: string[] = []
  const rangeChecks: unknown[][] = []
  const knex = Object.assign(
    (table: string) => ({
      where: (...args: unknown[]) => {
        rangeChecks.push([table, ...args])
        return { first: async () => (oversized ? { txid: 'aa'.repeat(32) } : undefined) }
      }
    }),
    {
      client: dialect.client,
      schema: {
        hasColumn: async (table: string, column: string) =>
          hasColumn && table === 'outputs' && column === 'satoshis',
        alterTable: async (table: string, build: (builder: Knex.AlterTableBuilder) => void) => {
          sql.push(
            ...dialect.schema
              .alterTable(table, build)
              .toSQL()
              .map(statement => statement.sql)
          )
        }
      }
    }
  ) as unknown as Knex
  return { knex, sql, rangeChecks }
}

describe('outputs.satoshis column width migration', () => {
  it('is registered as the newest Knex migration', () => {
    expect(allMigrations[allMigrations.length - 1]).toEqual({ up, down })
  })

  it.each(['mysql', 'mysql2'])(
    'widens satoshis to BIGINT on %s and restores it on down',
    async client => {
      const migrated = recordingKnex(client)
      await up(migrated.knex)
      expect(migrated.sql).toEqual(['alter table `outputs` modify `satoshis` bigint'])

      const rolledBack = recordingKnex(client)
      await down(rolledBack.knex)
      expect(rolledBack.sql).toEqual(['alter table `outputs` modify `satoshis` int(15)'])
    }
  )

  it('widens satoshis to bigint on Postgres and restores integer on down', async () => {
    const migrated = recordingKnex('pg')
    await up(migrated.knex)
    expect(migrated.sql).toContain(
      'alter table "outputs" alter column "satoshis" type bigint using ("satoshis"::bigint)'
    )

    const rolledBack = recordingKnex('pg')
    await down(rolledBack.knex)
    expect(rolledBack.sql).toContain(
      'alter table "outputs" alter column "satoshis" type integer using ("satoshis"::integer)'
    )
  })

  it.each(['mysql2', 'pg'])(
    'refuses to narrow on %s while a stored output exceeds 32 bits',
    async client => {
      const { knex, sql, rangeChecks } = recordingKnex(client, { oversized: true })
      await expect(down(knex)).rejects.toThrow('Cannot narrow outputs.satoshis to 32 bits')
      expect(rangeChecks).toEqual([['outputs', 'satoshis', '>', 2_147_483_647]])
      expect(sql).toEqual([])
    }
  )

  it.each(['sqlite3', 'better-sqlite3'])(
    'leaves the already 64-bit SQLite column alone on %s',
    async client => {
      const { knex, sql } = recordingKnex(client)
      await up(knex)
      await down(knex)
      expect(sql).toEqual([])
    }
  )

  it('does nothing when the outputs table has no satoshis column', async () => {
    const { knex, sql } = recordingKnex('mysql2', { hasColumn: false })
    await up(knex)
    await down(knex)
    expect(sql).toEqual([])
  })
})
