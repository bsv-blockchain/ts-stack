import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'

function sqlite(k: Knex): boolean {
  const client = k.client.config.client
  if (client === 'better-sqlite3' || client === 'sqlite3') return true
  if (client === 'mysql' || client === 'mysql2') return false
  throw new WERR_INVALID_OPERATION('Unsupported snapshot journal SQL driver')
}

/** Select with an alias different from the integer column used by ORDER BY. */
export function snapshotJournalRevisionText(k: Knex, column: string): Knex.Raw {
  return k.raw(sqlite(k) ? 'CAST(?? AS TEXT)' : 'CAST(?? AS CHAR)', [column])
}

/** Explicit integer operands avoid implicit floating-point comparisons. */
export function snapshotJournalRevisionOperand(k: Knex, value: SnapshotJournalRevision): Knex.Raw {
  const revision = snapshotJournalRevision(value)
  return k.raw(sqlite(k) ? 'CAST(? AS INTEGER)' : 'CAST(? AS SIGNED)', [revision])
}
