import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Snapshot journal maintenance cannot exclude the configured migration owner')
}

/** Internal prerequisite for complete owned-generation validation and one bounded
 * maintenance operation. Use a fresh caller-owned transaction. MySQL locks only
 * the migration owner during metadata validation; foreground clock writers can
 * proceed until the bounded floor/page operation reserves its current clock.
 * SQLite reserves the writer before any read can pin an old snapshot. Neither
 * reservation allocates an event position, and the owner row remains unchanged.
 * Every approved schema operation must use that migration owner. This does not
 * exclude raw operator DDL, publish a migration, or authorize source-row removal.
 */
export async function lockSnapshotJournalMaintenanceOwner(k: Knex, config?: Knex.MigratorConfig): Promise<void> {
  const driver = k.client.config.client
  const sqlite = driver === 'better-sqlite3' || driver === 'sqlite3'
  if (!k.isTransaction || (!sqlite && driver !== 'mysql' && driver !== 'mysql2')) return invalid()
  const table = config?.tableName ?? 'knex_migrations',
    schema = config?.schemaName
  if (
    typeof table !== 'string' ||
    table.length === 0 ||
    table.length > (sqlite ? 512 : 59) ||
    (schema !== undefined && (typeof schema !== 'string' || schema.length === 0 || schema.length > 64))
  )
    return invalid()
  if (sqlite) {
    const timeouts: Array<{ timeout: number }> = await k.raw('PRAGMA busy_timeout')
    const modes: Array<{ journal_mode: string }> = await k.raw('PRAGMA journal_mode')
    if (timeouts.length !== 1 || timeouts[0].timeout !== 0 || modes.length !== 1 || modes[0].journal_mode !== 'wal')
      return invalid()
    if (
      (await k('snapshot_journal_clock')
        .where('id', 1)
        .update({ revision: k.ref('revision') })) !== 1
    )
      return invalid()
  }
  const query = k(table + '_lock')
    .select('index', 'is_locked')
    .limit(2)
  if (schema !== undefined) query.withSchema(schema)
  if (!sqlite) query.forUpdate().noWait()
  const rows: Array<{ index: unknown; is_locked: unknown }> = await query
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(rows[0].index) ||
    (rows[0].index as number) < 1 ||
    rows[0].is_locked !== 0
  )
    return invalid()
}
