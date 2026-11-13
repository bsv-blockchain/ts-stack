import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { brc38ImportTargetIndexName, verifyBrc38ImportTargetIndexes } from '../portable/Brc38ImportTargetIndexes'
import {
  readBrc38NativeCurrentFieldTargets,
  type Brc38ImportExistingFieldRow
} from '../portable/Brc38ImportExistingRows'
import { readBrc38NativePackedExtent } from '../portable/Brc38NativePackedFieldsNode'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './journal/SnapshotJournalRevision'

export interface NativeSnapshotSyncProofRow {
  readonly provenTxId: number
  readonly created_at: Date
  readonly updated_at: Date
  readonly txid: string
  readonly blockHash: string
  readonly merkleRoot: string
  readonly height: number
  readonly index: number
}
export interface NativeSnapshotSyncProofCurrent {
  readonly field: Readonly<Brc38ImportExistingFieldRow>
  readonly row?: Readonly<NativeSnapshotSyncProofRow>
  readonly revision?: string
  readonly generation?: string
}
function invalid(): never {
  throw new Error('Native proof current metadata, physical identity or journal differs')
}
function hex(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/i.test(value)) invalid()
  // Storage indexes and persisted metadata retain their original spelling.
  // The streamed proof oracle normalizes only its cryptographic comparisons.
  return value
}
function integer(value: unknown, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) invalid()
  return value
}
function date(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(Date.prototype.getTime.call(value))) invalid()
  return new Date(Date.prototype.getTime.call(value))
}
export function nativeSnapshotSyncProofRow(
  fields: Readonly<Record<string, unknown>>
): Readonly<NativeSnapshotSyncProofRow> {
  if (
    Object.keys(fields).some(
      name =>
        !['created_at', 'updated_at', 'provenTxId', 'txid', 'blockHash', 'merkleRoot', 'height', 'index'].includes(name)
    )
  )
    invalid()
  return Object.freeze({
    provenTxId: integer(fields.provenTxId, 1),
    created_at: date(fields.created_at),
    updated_at: date(fields.updated_at),
    txid: hex(fields.txid),
    blockHash: hex(fields.blockHash),
    merkleRoot: hex(fields.merkleRoot),
    height: integer(fields.height, 0),
    index: integer(fields.index, 0)
  })
}
/** Exact current indexed global proof, read only after the enclosing actual
 * native session admits its profile and complete journal generation. Payload
 * descriptors/revisions are comparison DATA; bytes are compared independently. */
export async function readNativeSnapshotSyncProofCurrent(
  storage: StorageKnex,
  trx: Knex.Transaction,
  userId: number,
  txid: string,
  signal?: AbortSignal,
  canonicalFallback = false
): Promise<NativeSnapshotSyncProofCurrent> {
  signal?.throwIfAborted()
  integer(userId, 1)
  hex(txid)
  await verifyBrc38ImportTargetIndexes(trx)
  // Journal field receivers also meet legacy validators' canonical stores.
  // The original full-snapshot default remains one exact indexed lookup.
  const lookup = async (key: string): Promise<Array<{ localId: unknown }>> =>
    await trx
      .from(trx.raw('?? INDEXED BY ??', ['proven_txs', brc38ImportTargetIndexName('provenTxs', trx)]))
      .where({ txid: key })
      .select(
        trx.raw(
          "CASE WHEN typeof(provenTxId)='integer' AND provenTxId BETWEEN 1 AND 9007199254740991 THEN provenTxId END AS localId"
        )
      )
      .limit(2)
  let lookupTxid = txid
  let selected = await lookup(lookupTxid)
  if (selected.length > 1) invalid()
  if (selected.length === 0 && canonicalFallback && txid.toLowerCase() !== txid) {
    lookupTxid = txid.toLowerCase()
    selected = await lookup(lookupTxid)
    if (selected.length > 1) invalid()
  }
  const localId = selected.length === 0 ? undefined : integer(selected[0].localId, 1),
    fields = await readBrc38NativeCurrentFieldTargets(
      trx,
      storage,
      userId,
      'provenTxs',
      [
        {
          table: 'provenTxs',
          index: 'provenTxs',
          key: { txid: lookupTxid },
          found: localId !== undefined,
          ...(localId === undefined ? {} : { localId })
        }
      ],
      65536,
      signal
    )
  if (fields.length !== 1) invalid()
  const field = fields[0]
  if (field.metadata === undefined) return Object.freeze({ field })
  const row = nativeSnapshotSyncProofRow(field.metadata)
  if (
    row.provenTxId !== localId ||
    row.txid !== lookupTxid ||
    field.binaryRowId === undefined ||
    field.binaries.rawTx === undefined ||
    field.binaries.merklePath === undefined
  )
    invalid()
  const clocks: Array<{ revision: unknown; generation: unknown; present: unknown; ceiling: unknown }> = await trx(
    'snapshot_journal_physical'
  )
    .where({ tableId: 8, id1: row.provenTxId, id2: 0, exactText: '' })
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
    generation = snapshotJournalRevision(clocks[0].generation),
    ceiling = snapshotJournalRevision(clocks[0].ceiling)
  if (
    generation === '0' ||
    compareSnapshotJournalRevisions(generation, revision) > 0 ||
    compareSnapshotJournalRevisions(revision, ceiling) > 0
  )
    invalid()
  signal?.throwIfAborted()
  return Object.freeze({ field, row, revision, generation })
}
export function requireSameNativeSnapshotSyncProofCurrent(
  expected: NativeSnapshotSyncProofCurrent,
  actual: NativeSnapshotSyncProofCurrent
): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) invalid()
}
/** One actual <=16KiB window on the SAME freshly inspected native transaction.
 * The caller precharges physical 64KiB chunk/copy allocations and retains the
 * returned owned bytes until its comparison finishes, then wipes them. */
export async function readNativeSnapshotSyncProofCurrentExtent(
  storage: StorageKnex,
  trx: Knex.Transaction,
  userId: number,
  expected: NativeSnapshotSyncProofCurrent,
  field: 'rawTx' | 'merklePath',
  offset: number,
  length: number,
  signal?: AbortSignal
): Promise<Uint8Array> {
  if (
    expected.row === undefined ||
    expected.field.binaryRowId === undefined ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 16384
  )
    invalid()
  requireSameNativeSnapshotSyncProofCurrent(
    expected,
    await readNativeSnapshotSyncProofCurrent(storage, trx, userId, expected.row.txid, signal)
  )
  const descriptor = expected.field.binaries[field]
  if (descriptor === undefined) invalid()
  const bytes = await readBrc38NativePackedExtent(
    trx,
    { table: 'provenTxs', field, rowId: expected.field.binaryRowId, totalBytes: descriptor.bytes, offset, length },
    signal
  )
  try {
    if (!(bytes instanceof Uint8Array) || bytes.length !== length) invalid()
    requireSameNativeSnapshotSyncProofCurrent(
      expected,
      await readNativeSnapshotSyncProofCurrent(storage, trx, userId, expected.row.txid, signal)
    )
    return bytes
  } catch (cause) {
    if (bytes instanceof Uint8Array) bytes.fill(0)
    throw cause
  }
}
