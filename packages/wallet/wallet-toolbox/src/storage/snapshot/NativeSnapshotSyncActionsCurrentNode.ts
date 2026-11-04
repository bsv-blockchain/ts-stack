import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { SyncMap } from '../schema/entities/EntityBase'
import {
  brc38ImportTargetIndexName,
  verifyBrc38ImportTargetIndexes,
  type Brc38ImportTargetIndex
} from '../portable/Brc38ImportTargetIndexes'
import {
  readBrc38NativeCurrentFieldTargets,
  type Brc38ImportExistingFieldRow
} from '../portable/Brc38ImportExistingRows'
import type { Brc38ImportEntityTarget } from '../portable/Brc38ImportEntityTargets'
import type { WalletSnapshotFieldDescriptor } from './WalletReadSnapshot'
import {
  snapshotSyncTransactionMetadata,
  snapshotSyncOutputMetadata,
  type SnapshotSyncTransactionRow,
  type SnapshotSyncOutputRow
} from './SnapshotSyncActionMetadata'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './journal/SnapshotJournalRevision'
import {
  readNativeSnapshotParentFences,
  type NativeSnapshotParentFence,
  type NativeSnapshotParentEntity
} from './NativeSnapshotSyncParentFencesNode'
import { requireBrc38PackedRead, requireBrc38PackedWriter } from '../portable/Brc38NativePackedSchemaNode'

export type NativeSnapshotSyncAction =
  | { readonly table: 'transactions'; readonly row: SnapshotSyncTransactionRow }
  | { readonly table: 'outputs'; readonly row: SnapshotSyncOutputRow }
export interface NativeSnapshotSyncActionCurrent {
  readonly field: Readonly<Brc38ImportExistingFieldRow>
  readonly target?: Readonly<Brc38ImportEntityTarget>
  readonly action?: NativeSnapshotSyncAction
  readonly parentIds: Readonly<Record<string, number>>
  readonly parents: readonly Readonly<NativeSnapshotParentFence>[]
  readonly revision?: string
  readonly generation?: string
}
function invalid(): never {
  throw new Error('Native action current natural identity, parents or physical journal differs')
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}
export function nativeSnapshotSyncActionParents(
  action: NativeSnapshotSyncAction,
  map: SyncMap
): Readonly<Record<string, number>> {
  const ids: Record<string, number> = Object.create(null)
  if (action.table === 'transactions') {
    if (action.row.provenTxId !== undefined) ids.provenTxId = positive(map.provenTx.idMap[action.row.provenTxId])
  } else {
    ids.transactionId = positive(map.transaction.idMap[action.row.transactionId])
    if (action.row.spentBy !== undefined) ids.spentBy = positive(map.transaction.idMap[action.row.spentBy])
    if (action.row.basketId !== undefined) ids.basketId = positive(map.outputBasket.idMap[action.row.basketId])
  }
  return Object.freeze(ids)
}
/** Native transactions prefer known (profile,txid), falling back to original
 * reference only after a miss. Outputs use actual mapped parent/vout/profile.
 * All payloads stay descriptor DATA and actual physical IDs remain private. */
export async function readNativeSnapshotSyncActionCurrent(
  storage: StorageKnex,
  trx: Knex.Transaction,
  userId: number,
  incoming: NativeSnapshotSyncAction,
  map: SyncMap,
  signal?: AbortSignal
): Promise<NativeSnapshotSyncActionCurrent> {
  signal?.throwIfAborted()
  requireBrc38PackedRead(trx)
  positive(userId)
  await verifyBrc38ImportTargetIndexes(trx)
  const parentIds = nativeSnapshotSyncActionParents(incoming, map),
    selections = Object.entries(parentIds).map(([name, id]) => ({
      entity: (name === 'provenTxId'
        ? 'provenTx'
        : name === 'basketId'
          ? 'outputBasket'
          : 'transaction') as NativeSnapshotParentEntity,
      id
    })),
    parents = await readNativeSnapshotParentFences(trx, userId, selections, signal),
    sql = incoming.table,
    idName = sql === 'transactions' ? 'transactionId' : 'outputId'
  let target: Brc38ImportEntityTarget | undefined
  const select = async (
    index: Brc38ImportTargetIndex,
    key: Readonly<Record<string, string | number>>
  ): Promise<Brc38ImportEntityTarget> => {
    const rows: Array<{ localId: unknown }> = await trx
      .from(trx.raw('?? INDEXED BY ??', [sql, brc38ImportTargetIndexName(index, trx)]))
      .where(key)
      .select(
        trx.raw("CASE WHEN typeof(??)='integer' AND ?? BETWEEN 1 AND 9007199254740991 THEN ?? END AS localId", [
          idName,
          idName,
          idName
        ])
      )
      .limit(2)
    if (rows.length > 1) invalid()
    return {
      table: incoming.table,
      index,
      key,
      found: rows.length === 1,
      ...(rows.length === 0 ? {} : { localId: positive(rows[0].localId) })
    }
  }
  if (incoming.table === 'transactions') {
    if (incoming.row.txid) target = await select('transactions', { userId, txid: incoming.row.txid })
    if (target?.found !== true && incoming.row.reference)
      target = await select('transactionReference', { userId, reference: incoming.row.reference })
  } else target = await select('outputs', { userId, transactionId: parentIds.transactionId, vout: incoming.row.vout })
  // Empty txid/reference never matches another empty-reference transaction.
  // This is absence DATA, not a fabricated complete wallet row.
  if (target === undefined)
    return Object.freeze({
      parentIds,
      parents,
      field: Object.freeze({
        table: incoming.table,
        binaries: Object.freeze({}),
        structured: Object.freeze({}),
        texts: Object.freeze({}),
        allocationBytes: 2048
      })
    })
  const fields = await readBrc38NativeCurrentFieldTargets(trx, storage, userId, incoming.table, [target], 65536, signal)
  if (fields.length !== 1) invalid()
  const field = fields[0]
  if (field.metadata === undefined) return Object.freeze({ field, target: Object.freeze(target), parentIds, parents })
  if (field.metadata.userId !== userId) invalid()
  const extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = {}
  for (const [name, descriptor] of Object.entries(field.texts ?? {}))
    extents[name] = Object.freeze({ kind: 'utf8', ...descriptor })
  for (const [name, descriptor] of Object.entries(field.binaries))
    extents[name] = Object.freeze({ kind: 'binary', ...descriptor })
  const action: NativeSnapshotSyncAction =
      incoming.table === 'transactions'
        ? { table: 'transactions', row: snapshotSyncTransactionMetadata(field.metadata, extents) }
        : { table: 'outputs', row: snapshotSyncOutputMetadata(field.metadata, extents) },
    localId = positive(field.metadata[idName]),
    clocks: Array<{ revision: unknown; generation: unknown; present: unknown; ceiling: unknown }> = await trx(
      'snapshot_journal_physical'
    )
      .where({ tableId: incoming.table === 'transactions' ? 0 : 1, id1: localId, id2: 0, exactText: '' })
      .select(
        trx.raw("CASE WHEN typeof(revision)='integer' AND revision>=0 THEN CAST(revision AS TEXT) END AS revision"),
        trx.raw(
          "CASE WHEN typeof(generation)='integer' AND generation>=0 THEN CAST(generation AS TEXT) END AS generation"
        ),
        'present',
        trx.raw('(SELECT CAST(ceiling AS TEXT) FROM snapshot_journal_clock WHERE id=1) AS ceiling')
      )
      .limit(2)
  if (clocks.length !== 1 || clocks[0].present !== 1 || localId !== target.localId) invalid()
  const revision = snapshotJournalRevision(clocks[0].revision),
    generation = snapshotJournalRevision(clocks[0].generation)
  if (
    generation === '0' ||
    compareSnapshotJournalRevisions(generation, revision) > 0 ||
    compareSnapshotJournalRevisions(revision, snapshotJournalRevision(clocks[0].ceiling)) > 0
  )
    invalid()
  signal?.throwIfAborted()
  return Object.freeze({ field, target: Object.freeze(target), action, parentIds, parents, revision, generation })
}
export function requireSameNativeSnapshotSyncActionCurrent(
  expected: NativeSnapshotSyncActionCurrent,
  actual: NativeSnapshotSyncActionCurrent
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) invalid()
}
/** Original BRC-177 quarantine reads scalar current state through the declared
 * reclaim indexes; it never hydrates a large transaction or output DTO. */
export async function nativeSnapshotUnresolvedReclaim(
  trx: Knex.Transaction,
  userId: number,
  txid: string,
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted()
  requireBrc38PackedRead(trx)
  positive(userId)
  if (typeof txid !== 'string' || Buffer.byteLength(txid, 'utf8') > 4096) invalid()
  await verifyBrc38ImportTargetIndexes(trx)
  const rows: Array<{ reclaimed: unknown }> = await trx
    .from(trx.raw('?? INDEXED BY ??', ['transactions', brc38ImportTargetIndexName('transactionReclaim', trx)]))
    .where({ userId, noSendExpiryReclaimTxid: txid })
    .select(trx.raw("CASE WHEN noSendExpiryState='reclaimed' THEN 1 ELSE 0 END AS reclaimed"))
    .limit(2)
  if (rows.length > 1 || (rows.length === 1 && ![0, 1].includes(rows[0].reclaimed as number))) invalid()
  requireBrc38PackedRead(trx)
  signal?.throwIfAborted()
  return rows.length === 1 && rows[0].reclaimed === 0
}
export async function nativeSnapshotQuarantineReclaim(
  storage: StorageKnex,
  trx: Knex.Transaction,
  userId: number,
  txid: string,
  signal?: AbortSignal
): Promise<void> {
  signal?.throwIfAborted()
  requireBrc38PackedWriter(trx)
  positive(userId)
  if (typeof txid !== 'string' || Buffer.byteLength(txid, 'utf8') > 4096) invalid()
  await verifyBrc38ImportTargetIndexes(trx)
  const rows: Array<{ outputId: unknown; spendable: unknown }> = await trx
    .from(trx.raw('?? INDEXED BY ??', ['outputs', brc38ImportTargetIndexName('reclaimOutput', trx)]))
    .where({ userId, txid, vout: 0 })
    .select('outputId', trx.raw('CASE WHEN spendable IS NOT NULL AND spendable != 0 THEN 1 ELSE 0 END AS spendable'))
    .limit(2)
  if (rows.length > 1 || (rows.length === 1 && ![0, 1].includes(rows[0].spendable as number))) invalid()
  if (
    rows.length === 1 &&
    rows[0].spendable === 1 &&
    (await storage.updateOutput(positive(rows[0].outputId), { spendable: false }, trx)) !== 1
  )
    invalid()
  requireBrc38PackedWriter(trx)
  signal?.throwIfAborted()
}
