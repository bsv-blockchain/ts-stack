import { Knex } from 'knex'

const PG_INT8_OID = 20
const installed = Symbol.for('@bsv/wallet-toolbox/postgres-int8-numbers')

interface PgConnection {
  setTypeParser: (oid: number, parse: (value: string) => number) => void
}

type InstallableClient = Knex.Client & { [installed]?: true }

function parseInt8(value: string): number {
  return Number.parseInt(value, 10)
}

/**
 * Makes a Postgres knex return int8 values (bigint columns, `count(*)`) as
 * JavaScript numbers, as mysql2 and better-sqlite3 do. node-postgres returns
 * them as strings by default.
 *
 * The parser is set on each connection this knex acquires, including
 * connections created before this call and connections from a caller-supplied
 * pool. The process-wide `pg.types` defaults are not changed, so other pg
 * clients in the process are unaffected. Values above 2^53 lose precision;
 * wallet amounts and row ids stay well below that.
 *
 * Does nothing for other dialects, and is idempotent.
 */
export function usePostgresInt8Numbers(knex: Knex): void {
  const client = knex.client as InstallableClient | undefined
  if (client?.dialect !== 'postgresql' || client[installed] === true) return
  const acquire = client.acquireConnection.bind(client)
  client.acquireConnection = async () => {
    const connection = (await acquire()) as PgConnection
    connection.setTypeParser(PG_INT8_OID, parseInt8)
    return connection
  }
  client[installed] = true
}
