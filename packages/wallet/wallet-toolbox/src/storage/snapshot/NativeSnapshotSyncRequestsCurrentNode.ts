import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { SyncMap } from '../schema/entities/EntityBase'
import { requireBrc38PackedRead } from '../portable/Brc38NativePackedSchemaNode'
import { brc38ImportTargetIndexName, verifyBrc38ImportTargetIndexes } from '../portable/Brc38ImportTargetIndexes'
import {
  readBrc38NativeCurrentFieldTargets,
  type Brc38ImportExistingFieldRow
} from '../portable/Brc38ImportExistingRows'
import { readBrc38NativePackedTextExtent } from '../portable/Brc38NativePackedTextFieldsNode'
import { snapshotSyncRequestMetadata, type SnapshotSyncRequestRow } from './SnapshotSyncRequestMetadata'
import type { WalletSnapshotFieldDescriptor } from './WalletReadSnapshot'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './journal/SnapshotJournalRevision'
import { readNativeSnapshotParentFences, type NativeSnapshotParentFence } from './NativeSnapshotSyncParentFencesNode'
import type { Brc38ImportEntityTarget } from '../portable/Brc38ImportEntityTargets'

export interface NativeSnapshotSyncRequestCurrent {
  /** Actual indexed natural-key selection DATA for a private final writer. */
  readonly target?: Readonly<Brc38ImportEntityTarget>
  readonly field: Readonly<Brc38ImportExistingFieldRow>
  readonly row?: SnapshotSyncRequestRow
  readonly incomingProvenTxId?: number
  readonly parents: readonly Readonly<NativeSnapshotParentFence>[]
  readonly revision?: string
  readonly generation?: string
}
function invalid(): never {
  throw new Error('Native request current row, mapped proof, membership or physical journal differs')
}
function positive(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) invalid()
  return value
}
/** Global request natural identity and actual proof generations, on the same
 * freshly admitted native session view. No payload is read as a complete DTO. */
export async function readNativeSnapshotSyncRequestCurrent(
  storage: StorageKnex,
  trx: Knex.Transaction,
  userId: number,
  incoming: SnapshotSyncRequestRow,
  map: SyncMap,
  signal?: AbortSignal
): Promise<NativeSnapshotSyncRequestCurrent> {
  signal?.throwIfAborted()
  requireBrc38PackedRead(trx)
  positive(userId)
  await verifyBrc38ImportTargetIndexes(trx)
  const incomingProvenTxId =
      incoming.provenTxId === undefined ? undefined : positive(map.provenTx.idMap[incoming.provenTxId]),
    selected: Array<{ localId: unknown }> = await trx
      .from(trx.raw('?? INDEXED BY ??', ['proven_tx_reqs', brc38ImportTargetIndexName('provenTxReqs', trx)]))
      .where({ txid: incoming.txid })
      .select(
        trx.raw(
          "CASE WHEN typeof(provenTxReqId)='integer' AND provenTxReqId BETWEEN 1 AND 9007199254740991 THEN provenTxReqId END AS localId"
        )
      )
      .limit(2)
  if (selected.length > 1) invalid()
  const localId = selected.length === 0 ? undefined : positive(selected[0].localId),
    target: Readonly<Brc38ImportEntityTarget> = Object.freeze({
      table: 'provenTxReqs',
      index: 'provenTxReqs',
      key: Object.freeze({ txid: incoming.txid }),
      found: localId !== undefined,
      ...(localId === undefined ? {} : { localId })
    }),
    fields = await readBrc38NativeCurrentFieldTargets(trx, storage, userId, 'provenTxReqs', [target], 65536, signal)
  if (fields.length !== 1) invalid()
  const field = fields[0],
    extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = {}
  for (const [name, descriptor] of Object.entries(field.texts ?? {}))
    extents[name] = Object.freeze({ kind: 'utf8', ...descriptor })
  for (const [name, descriptor] of Object.entries(field.binaries))
    extents[name] = Object.freeze({ kind: 'binary', ...descriptor })
  const row = field.metadata === undefined ? undefined : snapshotSyncRequestMetadata(field.metadata, extents),
    parentIds = [
      ...new Set([incomingProvenTxId, row?.provenTxId].filter((value): value is number => value !== undefined))
    ],
    parents = await readNativeSnapshotParentFences(
      trx,
      userId,
      parentIds.map(id => ({ entity: 'provenTx', id })),
      signal
    )
  if (row === undefined) return Object.freeze({ target, field, incomingProvenTxId, parents })
  if (
    row.provenTxReqId !== localId ||
    row.txid !== incoming.txid ||
    field.binaryRowId === undefined ||
    field.textRowId === undefined ||
    field.binaries.rawTx === undefined ||
    field.texts?.history === undefined ||
    field.texts.notify === undefined
  )
    invalid()
  const clocks: Array<{ revision: unknown; generation: unknown; present: unknown; ceiling: unknown }> = await trx(
    'snapshot_journal_physical'
  )
    .where({ tableId: 9, id1: localId, id2: 0, exactText: '' })
    .select(
      trx.raw("CASE WHEN typeof(revision)='integer' AND revision>=0 THEN CAST(revision AS TEXT) END AS revision"),
      trx.raw(
        "CASE WHEN typeof(generation)='integer' AND generation>=0 THEN CAST(generation AS TEXT) END AS generation"
      ),
      'present',
      trx.raw('(SELECT CAST(ceiling AS TEXT) FROM snapshot_journal_clock WHERE id=1) AS ceiling')
    )
    .limit(2)
  if (clocks.length !== 1 || clocks[0].present !== 1) invalid()
  const revision = snapshotJournalRevision(clocks[0].revision),
    generation = snapshotJournalRevision(clocks[0].generation)
  if (
    generation === '0' ||
    compareSnapshotJournalRevisions(generation, revision) > 0 ||
    compareSnapshotJournalRevisions(revision, snapshotJournalRevision(clocks[0].ceiling)) > 0
  )
    invalid()
  signal?.throwIfAborted()
  requireBrc38PackedRead(trx)
  return Object.freeze({ target, field, row, incomingProvenTxId, parents, revision, generation })
}
export function requireSameNativeSnapshotSyncRequestCurrent(
  expected: NativeSnapshotSyncRequestCurrent,
  actual: NativeSnapshotSyncRequestCurrent
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) invalid()
}
export async function readNativeSnapshotSyncRequestCurrentExtent(
  storage: StorageKnex,
  trx: Knex.Transaction,
  userId: number,
  incoming: SnapshotSyncRequestRow,
  map: SyncMap,
  expected: NativeSnapshotSyncRequestCurrent,
  field: 'history' | 'notify',
  offset: number,
  length: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (
    expected.row === undefined ||
    expected.field.textRowId === undefined ||
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > 16384
  )
    invalid()
  requireSameNativeSnapshotSyncRequestCurrent(
    expected,
    await readNativeSnapshotSyncRequestCurrent(storage, trx, userId, incoming, map, signal)
  )
  const descriptor = expected.field.texts?.[field]
  if (descriptor === undefined) invalid()
  const bytes = await readBrc38NativePackedTextExtent(
    trx,
    { table: 'provenTxReqs', field, rowId: expected.field.textRowId, totalBytes: descriptor.bytes, offset, length },
    signal
  )
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) invalid()
    requireSameNativeSnapshotSyncRequestCurrent(
      expected,
      await readNativeSnapshotSyncRequestCurrent(storage, trx, userId, incoming, map, signal)
    )
    return bytes
  } catch (cause) {
    if (bytes instanceof Uint8Array) bytes.fill(0)
    throw cause
  }
}
/** Conservative transaction membership fence: the exact latest physical
 * transaction event, including tombstones, from its current declared index.
 * Payload-only changes may cause a retry too; no existence verdict is cached. */
export async function readNativeSnapshotTransactionMembershipRevision(trx: Knex.Transaction): Promise<string> {
  requireBrc38PackedRead(trx)
  const rows: Array<{ revision: unknown }> = await trx
    .from(trx.raw('?? INDEXED BY ??', ['snapshot_journal_physical', 'snapshot_journal_physical_page']))
    .where({ tableId: 0 })
    .orderBy('revision', 'desc')
    .limit(1)
    .select(trx.raw("CASE WHEN typeof(revision)='integer' AND revision>=0 THEN CAST(revision AS TEXT) END AS revision"))
  requireBrc38PackedRead(trx)
  return rows.length === 0 ? '0' : snapshotJournalRevision(rows[0].revision)
}
/** Fresh finite actual mapping/parent point reads. Unsafe legacy normalized
 * integer Numbers remain unmapped, preserving original notification behavior. */
export async function readNativeSnapshotNotificationMappings(
  trx: Knex.Transaction,
  userId: number,
  sourceStorageIdentityKey: string,
  incoming: readonly number[],
  signal?: AbortSignal
): Promise<readonly (number | undefined)[]> {
  requireBrc38PackedRead(trx)
  positive(userId)
  if (
    !Array.isArray(incoming) ||
    incoming.length > 128 ||
    typeof sourceStorageIdentityKey !== 'string' ||
    sourceStorageIdentityKey.length < 1 ||
    sourceStorageIdentityKey.length > 130
  )
    invalid()
  const output: Array<number | undefined> = []
  for (const id of incoming) {
    signal?.throwIfAborted()
    if (!Number.isInteger(id)) invalid()
    if (!Number.isSafeInteger(id) || id < 1) {
      output.push(undefined)
      continue
    }
    const rows: Array<{ localId: unknown }> = await trx('snapshot_sync_ids')
      .where({ userId, sourceStorageIdentityKey, entity: 'transaction', incomingId: id })
      .select(
        trx.raw(
          "CASE WHEN typeof(localId)='integer' AND localId BETWEEN 1 AND 9007199254740991 THEN localId END AS localId"
        )
      )
      .limit(2)
    if (rows.length > 1) invalid()
    if (rows.length === 0) {
      output.push(undefined)
      continue
    }
    const localId = positive(rows[0].localId)
    await readNativeSnapshotParentFences(trx, userId, [{ entity: 'transaction', id: localId }], signal)
    output.push(localId)
  }
  signal?.throwIfAborted()
  requireBrc38PackedRead(trx)
  return Object.freeze(output)
}
