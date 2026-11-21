import { promiseFromSync } from '../../../utility/promiseFromSync'
import type { SnapshotJournalHashedFieldDelta } from './SnapshotJournalFieldTypes'
import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { SnapshotJournalDelta } from './SnapshotJournalDeltaPage'
import { snapshotSyncTables } from '../SnapshotSync'
import { requireSnapshotJournalCapturedFrame } from './SnapshotJournalCapturedIdentities'
import {
  readSnapshotJournalDestinationPromotionPage,
  readSnapshotJournalDestinationFieldPromotionPage,
  type SnapshotJournalDestinationStageReceipt
} from './SnapshotJournalDestinationStage'
import {
  advanceSnapshotJournalDestinationWindow,
  readSnapshotJournalDestinationWindow,
  withSnapshotJournalDestinationWindowFence,
  type SnapshotJournalDestinationBinding,
  type SnapshotJournalDestinationCheckpoint
} from './SnapshotJournalDestinationWindow'

export interface SnapshotJournalPromotionCursor {
  windowSequence: number
  frameSequence: number
  frameDigest: string
  nextChange: number
}

const table = 'snapshot_reconciliation_promotion_cursors'
const hash = /^[0-9a-f]{64}$/

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Invalid or stale journal partial promotion')
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value)
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) invalid()
  return value
}

function transaction(k: Knex): boolean {
  if (!k.isTransaction) invalid()
  const client = k.client.config.client
  if (client === 'sqlite3' || client === 'better-sqlite3' || isOwnedNativeSqlite(k)) return false
  if (client === 'mysql' || client === 'mysql2') return true
  return invalid()
}

function scope(binding: SnapshotJournalDestinationBinding, state: SnapshotJournalDestinationCheckpoint) {
  return {
    userId: binding.destinationUserId,
    sourceStorageIdentity: binding.source.storageIdentity,
    sessionId: state.sessionId,
    binding: state.binding
  }
}

function bounded(k: Knex, field: string, maximum: number, remote: boolean): Knex.Raw {
  return k.raw(
    remote
      ? 'CASE WHEN octet_length(cast(?? as char)) BETWEEN 1 AND 16 AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??'
      : "CASE WHEN typeof(??)='integer' AND ?? BETWEEN 0 AND ? THEN ?? ELSE NULL END AS ??",
    [field, field, maximum, field, field]
  )
}

function ownCursor(value: SnapshotJournalPromotionCursor): SnapshotJournalPromotionCursor {
  if (typeof value.frameDigest !== 'string' || !hash.test(value.frameDigest)) invalid()
  const result = {
    windowSequence: integer(value.windowSequence),
    frameSequence: integer(value.frameSequence),
    frameDigest: value.frameDigest,
    nextChange: integer(value.nextChange, 256)
  }
  if (result.frameSequence < 1 || result.nextChange < 1) invalid()
  return result
}

export function snapshotJournalDestinationPromotionDdl(k: Knex): string {
  const client = k.client.config.client
  if (!['sqlite3', 'better-sqlite3', 'mysql', 'mysql2'].includes(String(client)) && !isOwnedNativeSqlite(k)) invalid()
  return (
    'CREATE TABLE ' +
    table +
    '(userId BIGINT NOT NULL,sourceStorageIdentity VARCHAR(256) NOT NULL,sessionId VARCHAR(64) NOT NULL,binding VARCHAR(64) NOT NULL,windowSequence BIGINT NOT NULL,frameSequence BIGINT NOT NULL,frameDigest VARCHAR(64) NOT NULL,nextChange INTEGER NOT NULL,PRIMARY KEY(userId,sourceStorageIdentity,sessionId))' +
    (client === 'mysql' || client === 'mysql2'
      ? ' ENGINE=InnoDB DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin ROW_FORMAT=DYNAMIC'
      : '')
  )
}

/** Read committed progress after a lost reply in a new destination transaction.
 * Like window recovery, this observation remains possible after expiry but
 * grants no further write authority. No sender-side cursor is authoritative. */
export async function readSnapshotJournalPromotionCursor(
  k: Knex,
  binding: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint
): Promise<SnapshotJournalPromotionCursor | undefined> {
  const remote = transaction(k)
  if (JSON.stringify(await readSnapshotJournalDestinationWindow(k, binding)) !== JSON.stringify(expected)) invalid()
  const rows: Array<Record<string, unknown>> = await k(table)
    .select(
      bounded(k, 'windowSequence', Number.MAX_SAFE_INTEGER, remote),
      bounded(k, 'frameSequence', Number.MAX_SAFE_INTEGER, remote),
      bounded(k, 'nextChange', 256, remote),
      k.raw(
        remote
          ? 'CASE WHEN octet_length(??)=64 THEN ?? ELSE NULL END AS ??'
          : "CASE WHEN typeof(??)='text' AND length(cast(?? as blob))=64 THEN ?? ELSE NULL END AS ??",
        remote
          ? ['frameDigest', 'frameDigest', 'frameDigest']
          : ['frameDigest', 'frameDigest', 'frameDigest', 'frameDigest']
      )
    )
    .where(scope(binding, expected))
    .limit(2)
  if (rows.length > 1) invalid()
  if (rows.length === 0) return undefined
  const cursor = ownCursor(rows[0] as unknown as SnapshotJournalPromotionCursor)
  if (
    expected.phase !== 'promoting' ||
    cursor.windowSequence !== expected.sequence ||
    cursor.frameSequence <= expected.promotionSequence
  )
    invalid()
  return cursor
}

/** Apply a bounded portion of the actual next staged frame. Semantic writes,
 * generation-aware ID maps, retirement custody and this cursor share one SQL
 * savepoint and the fresh destination fence. The final portion advances the
 * window atomically. Each outer commit is followed by a scheduling yield;
 * waiting for source/network I/O must happen outside this destination writer.
 *
 * The internal semantic merger must validate captured source identities and
 * lease/receipt authority; a payload digest or a callback is not authority.
 */
export async function promoteSnapshotJournalDestinationBatch(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  expectedCursor: SnapshotJournalPromotionCursor | undefined,
  maximumChanges: number,
  applyChange: (
    trx: Knex,
    change: SnapshotJournalDelta,
    receipt: SnapshotJournalDestinationStageReceipt,
    changeIndex: number
  ) => Promise<void>,
  finishPromotion?: (trx: Knex) => Promise<boolean>
): Promise<{
  checkpoint: SnapshotJournalDestinationCheckpoint
  cursor?: SnapshotJournalPromotionCursor
  applied: number
}> {
  if (input.fieldEncoding !== undefined) invalid()
  return await promoteDestinationBatch(
    k,
    input,
    expected,
    expectedCursor,
    maximumChanges,
    applyChange,
    readSnapshotJournalDestinationPromotionPage,
    finishPromotion
  )
}

/** Internal field-family progress only. The effect callback must own complete
 * content/proof/semantic policy in this same actual SQL writer; descriptors and
 * the committed cursor do not grant financial authority. No source/network I/O
 * belongs in that callback. Recovery rereads the original durable cursor. */
export async function promoteSnapshotJournalDestinationFieldBatch(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  expectedCursor: SnapshotJournalPromotionCursor | undefined,
  maximumChanges: number,
  applyChange: (
    trx: Knex,
    change: SnapshotJournalHashedFieldDelta,
    receipt: SnapshotJournalDestinationStageReceipt,
    changeIndex: number
  ) => Promise<void>,
  finishPromotion?: (trx: Knex) => Promise<boolean>
): Promise<{
  checkpoint: SnapshotJournalDestinationCheckpoint
  cursor?: SnapshotJournalPromotionCursor
  applied: number
}> {
  if (input.fieldEncoding !== 'wallet-journal-fields/1') invalid()
  return await promoteDestinationBatch(
    k,
    input,
    expected,
    expectedCursor,
    maximumChanges,
    applyChange,
    readSnapshotJournalDestinationFieldPromotionPage,
    finishPromotion
  )
}

async function promoteDestinationBatch<T extends SnapshotJournalDelta | SnapshotJournalHashedFieldDelta>(
  k: Knex,
  input: SnapshotJournalDestinationBinding,
  expected: SnapshotJournalDestinationCheckpoint,
  expectedCursor: SnapshotJournalPromotionCursor | undefined,
  maximumChanges: number,
  applyChange: (
    trx: Knex,
    change: T,
    receipt: SnapshotJournalDestinationStageReceipt,
    changeIndex: number
  ) => Promise<void>,
  readPage: (
    trx: Knex,
    binding: SnapshotJournalDestinationBinding,
    state: SnapshotJournalDestinationCheckpoint
  ) => Promise<{ receipt: SnapshotJournalDestinationStageReceipt; page: { changes: readonly T[] } } | undefined>,
  finishPromotion?: (trx: Knex) => Promise<boolean>
): Promise<{
  checkpoint: SnapshotJournalDestinationCheckpoint
  cursor?: SnapshotJournalPromotionCursor
  applied: number
}> {
  transaction(k)
  const limit = integer(maximumChanges, 256)
  if (limit < 1 || typeof applyChange !== 'function') invalid()
  const binding = { ...input, source: { ...input.source }, receipt: { ...input.receipt } }
  const state = { ...expected, ...(expected.after === undefined ? {} : { after: { ...expected.after } }) }
  const wanted = expectedCursor === undefined ? undefined : ownCursor(expectedCursor)
  return await (
    require('./SnapshotJournalOwnedWriter') as typeof import('./SnapshotJournalOwnedWriter')
  ).withSnapshotJournalOwnedSavepoint(k, async trx => {
    // The outer savepoint also contains a final window advance. The inner
    // partial fence verifies the old window before and after semantic work.
    const prepared = await withSnapshotJournalDestinationWindowFence(trx, binding, state, async pinned => {
      const actual = await readSnapshotJournalPromotionCursor(pinned, binding, state)
      if (JSON.stringify(actual) !== JSON.stringify(wanted)) invalid()
      const frame = await readPage(pinned, binding, state)
      if (frame === undefined) {
        if (actual !== undefined) invalid()
        return undefined
      }
      await requireSnapshotJournalCapturedFrame(pinned, binding, state, frame.receipt.digest, frame.page.changes.length)
      const start = actual?.nextChange ?? 0
      if (
        actual !== undefined &&
        (actual.frameSequence !== frame.receipt.sequence ||
          actual.frameDigest !== frame.receipt.digest ||
          start >= frame.page.changes.length)
      )
        invalid()
      const end = Math.min(start + limit, frame.page.changes.length)
      for (let index = start; index < end; index++)
        await applyChange(pinned, frame.page.changes[index], frame.receipt, index)
      if (end === frame.page.changes.length) {
        if (
          actual !== undefined &&
          (await pinned(table)
            .where({ ...scope(binding, state), ...actual })
            .delete()) !== 1
        )
          invalid()
        return { frame, applied: end - start }
      }
      const cursor: SnapshotJournalPromotionCursor = {
        windowSequence: state.sequence,
        frameSequence: frame.receipt.sequence,
        frameDigest: frame.receipt.digest,
        nextChange: end
      }
      if (actual === undefined) await pinned(table).insert({ ...scope(binding, state), ...cursor })
      else if (
        (await pinned(table)
          .where({ ...scope(binding, state), ...actual })
          .update(cursor)) !== 1
      )
        invalid()
      return { frame, cursor, applied: end - start }
    })
    if (prepared?.cursor !== undefined) return { checkpoint: state, cursor: prepared.cursor, applied: prepared.applied }
    const frame = prepared?.frame
    // Integrated reconciliation drains retirement intents in bounded commits
    // before the LAST table can acknowledge the complete source window.
    if (
      frame === undefined &&
      state.tableIndex === snapshotSyncTables.length - 1 &&
      finishPromotion !== undefined &&
      !(await finishPromotion(trx))
    )
      return { checkpoint: state, applied: 0 }
    const advanced = await advanceSnapshotJournalDestinationWindow(
      trx,
      binding,
      state,
      frame === undefined
        ? { phase: 'promoting', examined: 0, complete: true, promotionSequence: state.promotionSequence }
        : {
            phase: 'promoting',
            examined: frame.receipt.examined,
            complete: false,
            promotionSequence: frame.receipt.sequence,
            ...(frame.receipt.examined === 0 ? { emptyFrameDigest: frame.receipt.digest } : {})
          },
      () => promiseFromSync(() => undefined)
    )
    return { checkpoint: advanced.checkpoint, applied: prepared?.applied ?? 0 }
  })
}
