import type { Knex } from 'knex'

/** Snapshot auxiliary schemas currently require SQLite or MySQL. Postgres keeps
 * its standard wallet schema and legacy sync path. A future Postgres snapshot
 * implementation must use new forward migrations, rather than changing these
 * already-recorded no-op entries. */
export function forSnapshotSqlDialect(run: (k: Knex) => Promise<void>): (k: Knex) => Promise<void> {
  return async k => {
    if (k.client.dialect === 'postgresql') return
    await run(k)
  }
}
