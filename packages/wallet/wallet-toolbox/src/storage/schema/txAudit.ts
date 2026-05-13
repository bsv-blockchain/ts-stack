import { Knex } from 'knex'
import * as sdk from '../../sdk'
import { TableTxAudit } from './tables'
import { validateProcessingTransition } from './processingFsm'

/**
 * append-only audit log writer.
 *
 * Each call inserts one `tx_audit` row. Events should be small, stable
 * identifiers (e.g. `processing.changed`, `proof.acquired`, `lease.claimed`).
 * Payload is stored as a JSON-encoded string so downstream consumers may add
 * shape over time without a migration.
 */
export interface AuditEvent {
  transactionId?: number
  actionId?: number
  event: string
  fromState?: sdk.ProcessingStatus
  toState?: sdk.ProcessingStatus
  details?: Record<string, unknown>
}

export async function appendTxAudit (
  knex: Knex,
  ev: AuditEvent,
  now: Date = new Date()
): Promise<number> {
  const detailsJson = ev.details != null ? JSON.stringify(ev.details) : null
  const [id] = await knex('tx_audit').insert({
    transactionId: ev.transactionId ?? null,
    actionId: ev.actionId ?? null,
    event: ev.event,
    from_state: ev.fromState ?? null,
    to_state: ev.toState ?? null,
    details_json: detailsJson,
    created_at: now,
    updated_at: now
  })
  if (typeof id === 'number') return id
  const row = await knex('tx_audit').orderBy('auditId', 'desc').first('auditId')
  return row.auditId
}

/**
 * Convenience helper for processing transitions. Validates the move first;
 * on rejection it still records the attempt with `event = 'processing.rejected'`
 * so the audit trail captures impossible transitions for later diagnosis.
 *
 * Returns `true` when the transition is legal (audit row written with
 * `processing.changed`) and `false` when rejected (audit row written with
 * `processing.rejected`).
 */
export async function auditProcessingTransition (
  knex: Knex,
  transactionId: number,
  from: sdk.ProcessingStatus,
  to: sdk.ProcessingStatus,
  details?: Record<string, unknown>,
  now: Date = new Date()
): Promise<boolean> {
  const v = validateProcessingTransition(from, to)
  await appendTxAudit(
    knex,
    {
      transactionId,
      event: v.ok ? 'processing.changed' : 'processing.rejected',
      fromState: from,
      toState: to,
      details: v.ok ? details : { ...(details ?? {}), reason: v.reason }
    },
    now
  )
  return v.ok
}

/** Read all audit rows for a transaction, oldest first. Useful for tests. */
export async function listAuditForTransaction (knex: Knex, transactionId: number): Promise<TableTxAudit[]> {
  const rows = await knex('tx_audit').where({ transactionId }).orderBy('auditId')
  return rows.map(mapRow)
}

function mapRow (row: any): TableTxAudit {
  return {
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    auditId: row.auditId,
    transactionId: row.transactionId ?? undefined,
    actionId: row.actionId ?? undefined,
    event: row.event,
    fromState: row.from_state ?? undefined,
    toState: row.to_state ?? undefined,
    detailsJson: row.details_json ?? undefined
  }
}
