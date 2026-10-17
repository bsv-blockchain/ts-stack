import type { Knex } from 'knex'
import { verifyBrc38ImportJournalSchema as verifyBody } from './Brc38ImportJournalSchemaBody'
import {
  requireBrc38NativeProfileTransaction,
  requireBrc38NativeProfileReadTransaction
} from './Brc38PublishedProfileNode'

export function requireBrc38ImportSqliteTransaction(k: Knex.Transaction): void {
  requireBrc38NativeProfileTransaction(k)
}
export async function verifyBrc38ImportJournalSchema(k: Knex.Transaction): Promise<void> {
  requireBrc38ImportSqliteTransaction(k)
  await verifyBody(k)
}

/** Fresh readonly schema inspection; ordinary journal write admission above
 * still requires an actual enrolled published profile transaction. */
export async function verifyBrc38ImportJournalReadSchema(k: Knex.Transaction): Promise<void> {
  requireBrc38NativeProfileReadTransaction(k)
  await verifyBody(k)
  requireBrc38NativeProfileReadTransaction(k)
}
