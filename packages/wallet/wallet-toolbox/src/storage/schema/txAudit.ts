import { Knex } from 'knex'
import * as sdk from '../../sdk'
import { TableTxAudit } from './tables'
import { validateProcessingTransition } from './processingFsm'

/**
 * Append-only audit log writer.
 *
 * Each call inserts one `tx_audit` row. Events use small stable identifiers
 * (e.g. `processing.changed`, `proof.acquired`, `lease.claimed`). Payload is
 * a JSON-encoded string so consumers can extend shape without migration.
 *
 * `txid` is the canonical FK to `transactions(txid)`. `actionId` is the FK
 * to `actions(actionId)`. Both are nullable so an audit can reference either
 * side of the model.
 */
export interface AuditEvent {
  txid?: string
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
    txid: ev.txid ?? null,
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
 * Validate a processing transition and append the audit row. Returns `true`
 * when the move is legal (`processing.changed` recorded), `false` when the
 * FSM rejected it (`processing.rejected` recorded).
 */
export async function auditProcessingTransition (
  knex: Knex,
  txid: string,
  from: sdk.ProcessingStatus,
  to: sdk.ProcessingStatus,
  details?: Record<string, unknown>,
  now: Date = new Date()
): Promise<boolean> {
  const v = validateProcessingTransition(from, to)
  await appendTxAudit(
    knex,
    {
      txid,
      event: v.ok ? 'processing.changed' : 'processing.rejected',
      fromState: from,
      toState: to,
      details: v.ok ? details : { ...(details ?? {}), reason: v.reason }
    },
    now
  )
  return v.ok
}

/** Read all audit rows for a transaction, oldest first. */
export async function listAuditForTransaction (knex: Knex, txid: string): Promise<TableTxAudit[]> {
  const rows = await knex('tx_audit').where({ txid }).orderBy('auditId')
  return rows.map(mapRow)
}

function mapRow (row: any): TableTxAudit {
  return {
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    auditId: row.auditId,
    txid: row.txid ?? undefined,
    actionId: row.actionId ?? undefined,
    event: row.event,
    fromState: row.from_state ?? undefined,
    toState: row.to_state ?? undefined,
    detailsJson: row.details_json ?? undefined
  }
}
