import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  withSnapshotJournalWindowCustodyFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'
import { verifySnapshotJournalDestinationSchema } from './SnapshotJournalDestinationSchema'

const tables: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['snapshot_reconciliation_captured_identities', ['frameDigest', 'changeIndex', 'tableId', 'incomingId']],
  ['snapshot_reconciliation_identity_frames', ['frameDigest']],
  ['snapshot_reconciliation_stage_pages', ['sequence']],
  ['snapshot_reconciliation_stage_chains', ['tableId']],
  ['snapshot_reconciliation_promotion_cursors', []],
  ['snapshot_reconciliation_captured_identity_budgets', []],
  ['snapshot_reconciliation_stage_budgets', []]
]
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Acknowledged journal window cleanup differs from actual custody')
}
function scope(binding: SnapshotJournalDestinationBinding, state: SnapshotJournalDestinationCheckpoint) {
  return {
    userId: binding.destinationUserId,
    sourceStorageIdentity: binding.source.storageIdentity,
    sessionId: state.sessionId,
    binding: state.binding
  }
}
export async function requireSnapshotJournalWindowClean(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint
): Promise<void> {
  if (!k.isTransaction) invalid()
  const { binding: ignored, ...selected } = scope(binding, state)
  void ignored
  for (const [table] of tables) {
    if ((await k(table).where(selected).select(k.raw('1 AS occupied')).limit(1)).length) invalid()
  }
}

/** Session-scoped auxiliary GC only; never delete the window/high-water,
 * persisted identity associations, source memberships or archive provenance.
 * Read at most128 small keys and delete exactly those selected rows. Shared
 * quota triggers release their real charges in the same commit. Retry/restart
 * resumes actual remaining custody, not a sender's in-memory cleanup position.
 */
export async function cleanupSnapshotJournalAcknowledgedWindow(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  maximumRows = 128
): Promise<{ removed: number; complete: boolean }> {
  if (state.phase !== 'acknowledged') invalid()
  return await cleanupSnapshotJournalWindowCustody(k, binding, state, maximumRows)
}

/** Discard session-scoped payload custody before a freshly authorized full
 * replacement scan; applied native data and persistent associations survive. */
export async function cleanupSnapshotJournalWindowCustody(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint,
  maximumRows = 128
): Promise<{ removed: number; complete: boolean }> {
  if (!Number.isSafeInteger(maximumRows) || maximumRows < 1 || maximumRows > 128) invalid()
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return await withSnapshotJournalWindowCustodyFence(k, binding, state, async trx => {
    await verifySnapshotJournalDestinationSchema(trx)
    const selected = scope(binding, state)
    const { binding: ignored, ...base } = selected
    void ignored
    let removed = 0
    for (const [table, keys] of tables) {
      if (removed === maximumRows) break
      const fields = keys.map(field =>
        field === 'frameDigest'
          ? trx.raw(
              mysql
                ? 'CASE WHEN octet_length(??)=64 THEN ?? ELSE NULL END AS ??'
                : "CASE WHEN typeof(??)='text' AND length(cast(?? as blob))=64 THEN ?? ELSE NULL END AS ??",
              mysql ? [field, field, field] : [field, field, field, field]
            )
          : trx.raw(
              mysql
                ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
                : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
              [field, field, Number.MAX_SAFE_INTEGER, field, field]
            )
      )
      const bound = trx.raw(
        mysql
          ? 'CASE WHEN octet_length(binding)=64 THEN binding ELSE NULL END AS binding'
          : "CASE WHEN typeof(binding)='text' AND length(cast(binding as blob))=64 THEN binding ELSE NULL END AS binding"
      )
      const query = trx(table)
        .where(base)
        .select([bound, ...fields])
        .limit(maximumRows - removed)
      if (keys.length) query.orderBy([...keys])
      const rows: Array<Record<string, unknown>> = await query
      for (const row of rows) {
        if (row.binding !== state.binding) invalid()
        const key: Record<string, string | number> = {}
        for (const field of keys) {
          if (field === 'frameDigest') {
            if (typeof row[field] !== 'string' || !/^[0-9a-f]{64}$/.test(row[field])) invalid()
            key[field] = row[field]
          } else {
            const number = Number(row[field])
            if (row[field] === null || !Number.isSafeInteger(number) || number < 0) invalid()
            key[field] = number
          }
        }
        if (
          (await trx(table)
            .where({ ...selected, ...key })
            .delete()) !== 1
        )
          invalid()
        removed++
      }
    }
    let complete = true
    for (const [table] of tables) {
      if ((await trx(table).where(base).select(trx.raw('1 AS occupied')).limit(1)).length) {
        complete = false
        break
      }
    }
    return { removed, complete }
  })
}
