import { isOwnedNativeSqlite } from '../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import {
  installBrc38ImportJournalSchema as installBody,
  verifyBrc38ImportJournalSchema as verifyBody
} from './Brc38ImportJournalSchemaBody'

export function requireBrc38ImportSqliteTransaction(k: Knex.Transaction): void {
  if (
    typeof k !== 'function' ||
    k.isTransaction !== true ||
    (k.client.config.client !== 'better-sqlite3' && !isOwnedNativeSqlite(k))
  )
    throw new Error('Private import journal requires an actual SQLite transaction')
}

export async function installBrc38ImportJournalSchema(k: Knex.Transaction): Promise<void> {
  requireBrc38ImportSqliteTransaction(k)
  await installBody(k)
  await verifyBrc38ImportJournalSchema(k)
}
export async function verifyBrc38ImportJournalSchema(k: Knex.Transaction): Promise<void> {
  requireBrc38ImportSqliteTransaction(k)
  await verifyBody(k)
}
