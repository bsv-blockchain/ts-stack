import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { snapshotArchiveDatabaseNow } from '../archive/SnapshotArchiveSql'
import {
  compareSnapshotJournalRevisions,
  snapshotJournalRevision,
  type SnapshotJournalRevision
} from './SnapshotJournalRevision'

export const SNAPSHOT_JOURNAL_RECEIPT_LIMIT = 128
export const SNAPSHOT_JOURNAL_RECEIPT_MAX_LIFETIME = 2592000000
export interface SnapshotJournalReceiptPolicy {
  receiptLimit: number
  receiptLifetimeMs: number
}
export interface SnapshotJournalReceiptBinding {
  backend: string
  epoch: string
  source: string
  schema: string
  storageIdentity: string
  identityKey: string
  userId: number
  chain: string
}
export interface SnapshotJournalReceipt {
  requestId: string
  binding: string
  highWater: SnapshotJournalRevision
  floor: SnapshotJournalRevision
  expiresAt: number
}
export interface SnapshotJournalRetention {
  floor: SnapshotJournalRevision
  receiptLimit: number
  receiptLifetimeMs: number
}
const digestPattern = /^[0-9a-f]{64}$/
function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid, unavailable or expired snapshot journal receipt')
}
function local(k: Knex): boolean {
  const client = k.client.config.client
  if (client === 'sqlite3' || client === 'better-sqlite3') return true
  if (client === 'mysql' || client === 'mysql2') return false
  return invalid()
}
function transaction(k: Knex): void {
  local(k)
  if (!k.isTransaction) invalid()
}
const boundedInteger = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max

/** Detached installation policy; a generation cannot silently change it on resume. */
export function snapshotJournalReceiptPolicy(value: SnapshotJournalReceiptPolicy): SnapshotJournalReceiptPolicy {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  const { receiptLimit, receiptLifetimeMs } = value
  if (
    !boundedInteger(receiptLimit, SNAPSHOT_JOURNAL_RECEIPT_LIMIT) ||
    !boundedInteger(receiptLifetimeMs, SNAPSHOT_JOURNAL_RECEIPT_MAX_LIFETIME)
  )
    return invalid()
  return { receiptLimit, receiptLifetimeMs }
}

/** An exact, bounded digest binds a receipt without retaining profile metadata in it. */
export function snapshotJournalReceiptBinding(value: SnapshotJournalReceiptBinding): string {
  if (
    value === null ||
    typeof value !== 'object' ||
    ![value.backend, value.source, value.schema].every(part => typeof part === 'string' && digestPattern.test(part)) ||
    typeof value.epoch !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.epoch) ||
    typeof value.storageIdentity !== 'string' ||
    Buffer.byteLength(value.storageIdentity, 'utf8') < 1 ||
    Buffer.byteLength(value.storageIdentity, 'utf8') > 256 ||
    Buffer.from(value.storageIdentity, 'utf8').toString('utf8') !== value.storageIdentity ||
    typeof value.identityKey !== 'string' ||
    !/^(02|03)[0-9a-f]{64}$/.test(value.identityKey) ||
    !boundedInteger(value.userId, Number.MAX_SAFE_INTEGER) ||
    !['main', 'test', 'stn', 'ttn', 'tstn', 'mock'].includes(value.chain)
  )
    return invalid()
  return createHash('sha256')
    .update('snapshot-journal-receipt-binding-v1\n')
    .update(
      JSON.stringify([
        value.backend,
        value.epoch,
        value.source,
        value.schema,
        value.storageIdentity,
        value.identityKey,
        value.userId,
        value.chain
      ])
    )
    .digest('hex')
}

/** Owned generation DDL only. This helper neither adopts objects nor registers a migration. */
export function snapshotJournalReceiptDdl(k: Knex): string[] {
  const sqlite = local(k)
  const suffix = sqlite ? '' : ' ENGINE=InnoDB DEFAULT CHARACTER SET ascii COLLATE ascii_bin ROW_FORMAT=DYNAMIC'
  return [
    'CREATE TABLE snapshot_journal_retention(id INTEGER NOT NULL PRIMARY KEY,floor VARCHAR(19) NOT NULL,receiptLimit INTEGER NOT NULL,receiptLifetimeMs BIGINT NOT NULL,CHECK(id=1),CHECK(receiptLimit BETWEEN 1 AND 128),CHECK(receiptLifetimeMs BETWEEN 1 AND 2592000000))' +
      suffix,
    'CREATE TABLE snapshot_journal_receipts(requestId VARCHAR(64) NOT NULL PRIMARY KEY,binding VARCHAR(64) NOT NULL,highWater VARCHAR(19) NOT NULL,floor VARCHAR(19) NOT NULL,expiresAt BIGINT NOT NULL,CHECK(expiresAt BETWEEN 1 AND 9007199254740991)' +
      (sqlite ? ')' : ',KEY snapshot_journal_receipts_expiry(expiresAt,requestId))') +
      suffix,
    ...(sqlite
      ? ['CREATE INDEX snapshot_journal_receipts_expiry ON snapshot_journal_receipts(expiresAt,requestId)']
      : [])
  ]
}
async function sharedRows(k: Knex, query: Knex.QueryBuilder): Promise<Array<Record<string, unknown>>> {
  if (local(k)) return await query
  // Knex's MySQL forShare emits legacy LOCK IN SHARE MODE, which cannot
  // take NOWAIT. Use the current-read MySQL8 form with the same bindings.
  const sql = query.toSQL()
  const [rows]: Array<Array<Record<string, unknown>>> = await k.raw(
    sql.sql + ' FOR SHARE NOWAIT',
    sql.bindings as Knex.RawBinding[]
  )
  return rows
}
function receiptQuery(k: Knex): Knex.QueryBuilder {
  return k('snapshot_journal_receipts').select(
    'expiresAt',
    ...[
      ['requestId', 65],
      ['binding', 65],
      ['highWater', 20],
      ['floor', 20]
    ].map(([field, length]) => k.raw('substr(??,1,?) AS ??', [field, length, field] as Knex.RawBinding[]))
  )
}
async function retention(k: Knex, lock: boolean): Promise<SnapshotJournalRetention> {
  transaction(k)
  if (lock && local(k)) {
    const mode: Array<{ timeout: number }> = await k.raw('PRAGMA busy_timeout')
    if (mode.length !== 1 || mode[0].timeout !== 0) return invalid()
    await k('snapshot_journal_retention').where('id', 1).update({ id: 1 })
  }
  const query = k('snapshot_journal_retention')
    .select('id', 'receiptLimit', 'receiptLifetimeMs', k.raw('substr(??,1,20) AS ??', ['floor', 'floor']))
    .limit(2)
  if (lock && !local(k)) query.forUpdate().noWait()
  const rows = lock ? await query : await sharedRows(k, query)
  if (rows.length === 1) rows[0].receiptLifetimeMs = storedInteger(rows[0].receiptLifetimeMs)
  if (
    rows.length !== 1 ||
    rows[0].id !== 1 ||
    !boundedInteger(rows[0].receiptLimit, SNAPSHOT_JOURNAL_RECEIPT_LIMIT) ||
    !boundedInteger(rows[0].receiptLifetimeMs, SNAPSHOT_JOURNAL_RECEIPT_MAX_LIFETIME)
  )
    return invalid()
  return {
    floor: snapshotJournalRevision(rows[0].floor),
    receiptLimit: rows[0].receiptLimit,
    receiptLifetimeMs: rows[0].receiptLifetimeMs
  }
}
async function now(k: Knex): Promise<number> {
  const value = await snapshotArchiveDatabaseNow(k)
  if (!boundedInteger(value, Number.MAX_SAFE_INTEGER)) return invalid()
  return value
}
function storedInteger(value: unknown): number {
  if (typeof value === 'string' && /^(?:0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value)
  if (!boundedInteger(value, Number.MAX_SAFE_INTEGER)) return invalid()
  return value
}
function receipt(value: Record<string, unknown>, stored = false): SnapshotJournalReceipt {
  if (stored) value = { ...value, expiresAt: storedInteger(value.expiresAt) }
  if (
    typeof value.requestId !== 'string' ||
    !digestPattern.test(value.requestId) ||
    typeof value.binding !== 'string' ||
    !digestPattern.test(value.binding) ||
    !boundedInteger(value.expiresAt, Number.MAX_SAFE_INTEGER)
  )
    return invalid()
  const highWater = snapshotJournalRevision(value.highWater),
    floor = snapshotJournalRevision(value.floor)
  if (highWater === '0' || compareSnapshotJournalRevisions(highWater, floor) < 0) return invalid()
  return { requestId: value.requestId, binding: value.binding, highWater, floor, expiresAt: value.expiresAt }
}

/** Persist inside the caller's short writer-barrier transaction, after its separately
 * reserved reader has pinned a coherent view. Never publish before that transaction
 * commits. A receipt is a prefix proof, not a resumable database read transaction.
 * A retry may repeat this exact proof; opening another view requires another ID. */
export async function recordSnapshotJournalReceipt(
  k: Knex,
  binding: SnapshotJournalReceiptBinding,
  request: { requestId: string; highWater: SnapshotJournalRevision; expiresAt: number }
): Promise<SnapshotJournalReceipt> {
  const expected = snapshotJournalReceiptBinding(binding)
  const input = receipt({ ...request, binding: expected, floor: '0' })
  const state = await retention(k, true),
    time = await now(k)
  if (
    input.expiresAt <= time ||
    input.expiresAt - time > state.receiptLifetimeMs ||
    compareSnapshotJournalRevisions(input.highWater, state.floor) < 0
  )
    return invalid()
  const priorQuery = receiptQuery(k).where('requestId', input.requestId).first()
  if (!local(k)) priorQuery.forUpdate().noWait()
  const prior = await priorQuery
  if (prior !== undefined) {
    const existing = receipt(prior, true)
    if (
      existing.binding !== expected ||
      existing.highWater !== input.highWater ||
      existing.expiresAt !== input.expiresAt ||
      compareSnapshotJournalRevisions(existing.highWater, state.floor) < 0 ||
      compareSnapshotJournalRevisions(existing.floor, state.floor) > 0
    )
      return invalid()
    return existing
  }
  // Capacity includes expired rows until a bounded collector actually commits deletion.
  const occupiedQuery = k('snapshot_journal_receipts')
    .select(k.raw('1 AS occupied'))
    .orderBy('requestId')
    .limit(state.receiptLimit + 1)
  if (!local(k)) occupiedQuery.forUpdate().noWait()
  const occupied = await occupiedQuery
  if (occupied.length >= state.receiptLimit) return invalid()
  const result = { ...input, floor: state.floor }
  await k('snapshot_journal_receipts').insert(result)
  return result
}

/** Read the floor and exact receipt in one coherent transaction. */
export async function readSnapshotJournalReceipt(
  k: Knex,
  binding: SnapshotJournalReceiptBinding,
  expected: { requestId: string; highWater: SnapshotJournalRevision; expiresAt: number }
): Promise<SnapshotJournalReceipt> {
  const bound = snapshotJournalReceiptBinding(binding)
  const requested = receipt({ ...expected, binding: bound, floor: '0' })
  const state = await retention(k, false),
    time = await now(k)
  const [stored] = await sharedRows(k, receiptQuery(k).where('requestId', requested.requestId).limit(1))
  if (stored === undefined) return invalid()
  const result = receipt(stored, true)
  if (
    result.binding !== bound ||
    result.highWater !== requested.highWater ||
    result.expiresAt !== requested.expiresAt ||
    result.expiresAt <= time ||
    compareSnapshotJournalRevisions(result.highWater, state.floor) < 0 ||
    compareSnapshotJournalRevisions(result.floor, state.floor) > 0
  )
    return invalid()
  return result
}

/** At most 64 indexed expired receipts per caller-owned transaction. Retiring a
 * receipt never reopens its expired request; capacity is released only on commit. */
export async function collectSnapshotJournalReceipts(k: Knex): Promise<number> {
  await retention(k, true)
  const time = await now(k)
  const query = k('snapshot_journal_receipts')
    .where('expiresAt', '<=', time)
    .select(k.raw('substr(??,1,65) AS ??', ['requestId', 'requestId']))
    .orderBy(['expiresAt', 'requestId'])
    .limit(64)
  if (!local(k)) query.forUpdate().noWait()
  const rows: Array<{ requestId: unknown }> = await query
  if (rows.some(row => typeof row.requestId !== 'string' || !digestPattern.test(row.requestId))) return invalid()
  if (rows.length)
    await k('snapshot_journal_receipts')
      .whereIn(
        'requestId',
        rows.map(row => row.requestId as string)
      )
      .delete()
  return rows.length
}
