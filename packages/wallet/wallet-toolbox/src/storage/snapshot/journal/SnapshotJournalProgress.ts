import type { SnapshotJournalProgress } from './SnapshotJournalTypes'
export type { SnapshotJournalProgress } from './SnapshotJournalTypes'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import {
  readSnapshotJournalDestinationWindow,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

const table = 'snapshot_reconciliation_window_progress'
const fields = ['commits', 'pages', 'examined', 'payloadBytes', 'inserts', 'updates'] as const
export function snapshotJournalProgressDdl(k: Knex): string {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return (
    'CREATE TABLE ' +
    table +
    '(userId BIGINT NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,binding VARCHAR(64) NOT NULL,sequence BIGINT NOT NULL,commits BIGINT NOT NULL,pages BIGINT NOT NULL,examined BIGINT NOT NULL,payloadBytes BIGINT NOT NULL,inserts BIGINT NOT NULL,updates BIGINT NOT NULL,PRIMARY KEY(userId,sourceStorageIdentity))' +
    (mysql ? ' ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=DYNAMIC' : '')
  )
}
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal progress differs from its durable acknowledgement')
}
function integer(value: unknown): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid()
  return value
}
function key(binding: SnapshotJournalDestinationBinding) {
  return { userId: binding.destinationUserId, sourceStorageIdentity: binding.source.storageIdentity }
}
function zero(): SnapshotJournalProgress {
  return { commits: 0, pages: 0, examined: 0, payloadBytes: 0, inserts: 0, updates: 0 }
}
function projection(k: Knex, field: string): Knex.Raw {
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  return k.raw(
    mysql
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, Number.MAX_SAFE_INTEGER, field, field]
  )
}
async function record(
  k: Knex,
  binding: SnapshotJournalDestinationBinding
): Promise<Record<string, unknown> | undefined> {
  if (!k.isTransaction) invalid()
  const rows: Array<Record<string, unknown>> = await k(table)
    .where(key(binding))
    .select(
      ...['sequence', ...fields].map(field => projection(k, field)),
      k.raw('substr(sessionId,1,65) AS sessionId'),
      k.raw('substr(binding,1,65) AS binding')
    )
    .limit(2)
  if (rows.length > 1) invalid()
  const row = rows[0]
  if (
    row !== undefined &&
    (typeof row.sessionId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.sessionId) ||
      typeof row.binding !== 'string' ||
      !/^[0-9a-f]{64}$/.test(row.binding))
  )
    invalid()
  if (row !== undefined) for (const field of ['sequence', ...fields]) integer(row[field])
  return row
}
async function current(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint
): Promise<void> {
  if (JSON.stringify(await readSnapshotJournalDestinationWindow(k, binding)) !== JSON.stringify(state)) invalid()
}

/** New-window reset shares its actual window transaction. A durable old record
 * cannot be reused as counters for a different receipt/session. Existing source
 * authority and physical/profile checks remain independent prerequisites. */
export async function beginSnapshotJournalProgress(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint
): Promise<void> {
  await current(k, binding, state)
  if (state.sequence !== 0 || state.phase !== 'intake') invalid()
  const old = await record(k, binding)
  if (old?.sessionId === state.sessionId) {
    if (old.binding !== state.binding || integer(old.sequence) !== 0 || fields.some(field => integer(old[field]) !== 0))
      invalid()
    return
  }
  const replacement = { sessionId: state.sessionId, binding: state.binding, sequence: 0, ...zero() }
  if (old === undefined) await k(table).insert({ ...key(binding), ...replacement })
  else if (
    (await k(table)
      .where({ ...key(binding), sessionId: old.sessionId, binding: old.binding, sequence: integer(old.sequence) })
      .update(replacement)) !== 1
  )
    invalid()
}
export async function readSnapshotJournalProgress(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  state: SnapshotJournalDestinationCheckpoint
): Promise<SnapshotJournalProgress> {
  await current(k, binding, state)
  const row = await record(k, binding)
  if (
    row === undefined ||
    row.sessionId !== state.sessionId ||
    row.binding !== state.binding ||
    integer(row.sequence) !== state.sequence
  )
    invalid()
  return {
    commits: integer(row.commits),
    pages: integer(row.pages),
    examined: integer(row.examined),
    payloadBytes: integer(row.payloadBytes),
    inserts: integer(row.inserts),
    updates: integer(row.updates)
  }
}

/** Call after window/cursor advancement, inside the SAME outer writer. All
 * counters advance only from the previous actual durable sequence. Lost replies
 * recover this row; sender logs and preparation attempts cannot advance it. */
export async function advanceSnapshotJournalProgress(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  previous: SnapshotJournalDestinationCheckpoint,
  next: SnapshotJournalDestinationCheckpoint,
  delta: Partial<Omit<SnapshotJournalProgress, 'commits'>>
): Promise<SnapshotJournalProgress> {
  await current(k, binding, next)
  if (
    next.sessionId !== previous.sessionId ||
    next.binding !== previous.binding ||
    next.sequence < previous.sequence ||
    next.sequence > previous.sequence + 1
  )
    invalid()
  const row = await record(k, binding)
  if (
    row === undefined ||
    row.sessionId !== previous.sessionId ||
    row.binding !== previous.binding ||
    integer(row.sequence) !== previous.sequence
  )
    invalid()
  const result = zero()
  for (const field of fields) {
    const added = field === 'commits' ? 1 : integer(delta[field] ?? 0)
    result[field] = integer(integer(row[field]) + added)
  }
  const preimage = Object.fromEntries(fields.map(field => [field, integer(row[field])]))
  if (
    (await k(table)
      .where({
        ...key(binding),
        sessionId: previous.sessionId,
        binding: previous.binding,
        sequence: previous.sequence,
        ...preimage
      })
      .update({ sequence: next.sequence, ...result })) !== 1
  )
    invalid()
  return result
}
