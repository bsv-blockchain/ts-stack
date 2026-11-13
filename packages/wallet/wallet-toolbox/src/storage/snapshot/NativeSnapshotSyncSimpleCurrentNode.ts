import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { SyncMap } from '../schema/entities/EntityBase'
import { brc38ImportTargetIndexName, verifyBrc38ImportTargetIndexes } from '../portable/Brc38ImportTargetIndexes'
import {
  readBrc38NativeCurrentFieldTargets,
  type Brc38ImportExistingFieldRow
} from '../portable/Brc38ImportExistingRows'
import type { Brc38ImportEntityTarget } from '../portable/Brc38ImportEntityTargets'
import type { WalletSnapshotFieldDescriptor } from './WalletReadSnapshot'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './journal/SnapshotJournalRevision'
import {
  nativeSimplePayloadRow,
  nativeSimplePositive,
  type NativeSimplePayloadRow
} from './NativeSnapshotSyncSimpleRows'
import { readNativeSnapshotParentFences, type NativeSnapshotParentFence } from './NativeSnapshotSyncParentFencesNode'

export interface NativeSimpleCurrent {
  readonly field: Readonly<Brc38ImportExistingFieldRow>
  readonly row?: NativeSimplePayloadRow
  readonly parent?: number
  readonly parents: readonly Readonly<NativeSnapshotParentFence>[]
  readonly revision?: string
  readonly generation?: string
}
function invalid(): never {
  throw new Error('Native payload current natural row or journal identity differs')
}
/** Current natural-key selection and actual packed pointer metadata in one
 * genuine native transaction. Returned metadata/revisions are comparison DATA;
 * the final writer repeats this whole operation before and during its effects. */
export async function readNativeSimpleCurrent(
  storage: StorageKnex,
  trx: Knex.Transaction,
  userId: number,
  incoming: NativeSimplePayloadRow,
  map: SyncMap,
  signal?: AbortSignal
): Promise<NativeSimpleCurrent> {
  signal?.throwIfAborted()
  nativeSimplePositive(userId)
  await verifyBrc38ImportTargetIndexes(trx)
  let sql: string,
    id: string | undefined,
    key: Record<string, string | number>,
    parent: number | undefined,
    journalTable: number
  switch (incoming.table) {
    case 'certificates':
      sql = 'certificates'
      id = 'certificateId'
      journalTable = 2
      key = { userId, certifier: incoming.value.certifier, serialNumber: incoming.value.serialNumber }
      break
    case 'certificateFields':
      sql = 'certificate_fields'
      id = undefined
      journalTable = 12
      parent = nativeSimplePositive(map.certificate.idMap[incoming.value.certificateId])
      key = { userId, certificateId: parent, fieldName: incoming.value.fieldName }
      break
    case 'commissions':
      sql = 'commissions'
      id = 'commissionId'
      journalTable = 6
      parent = nativeSimplePositive(map.transaction.idMap[incoming.value.transactionId])
      key = { userId, transactionId: parent }
      break
  }
  const parents = await readNativeSnapshotParentFences(
      trx,
      userId,
      parent === undefined
        ? []
        : [
            {
              entity: incoming.table === 'certificateFields' ? 'certificate' : 'transaction',
              id: parent
            }
          ],
      signal
    ),
    indexed = (): Knex.QueryBuilder =>
      trx
        .from(trx.raw('?? INDEXED BY ??', [sql, brc38ImportTargetIndexName(incoming.table, trx)]))
        .where(key)
        .limit(2),
    selected: Array<{ localId: number }> = await indexed().select(
      id === undefined
        ? trx.raw('rowid AS localId')
        : trx.raw("CASE WHEN typeof(??)='integer' AND ?? BETWEEN 1 AND 9007199254740991 THEN ?? END AS localId", [
            id,
            id,
            id
          ])
    )
  if (selected.length > 1) invalid()
  if (selected.length === 1) nativeSimplePositive(selected[0].localId)
  const target: Brc38ImportEntityTarget = {
      table: incoming.table,
      index: incoming.table,
      key,
      found: selected.length === 1,
      ...(id === undefined || selected.length === 0 ? {} : { localId: selected[0].localId })
    },
    fields = await readBrc38NativeCurrentFieldTargets(trx, storage, userId, incoming.table, [target], 65536, signal)
  if (fields.length !== 1) invalid()
  const field = fields[0]
  if (field.metadata === undefined) return Object.freeze({ field, parent, parents })
  if (field.metadata.userId !== userId) invalid()
  const extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = {}
  for (const [name, descriptor] of Object.entries(field.texts ?? {}))
    extents[name] = Object.freeze({ kind: 'utf8', ...descriptor })
  for (const [name, descriptor] of Object.entries(field.binaries))
    extents[name] = Object.freeze({ kind: 'binary', ...descriptor })
  const row = nativeSimplePayloadRow(incoming.table, field.metadata, extents),
    physical = {
      tableId: journalTable,
      id1: incoming.table === 'certificateFields' ? parent! : selected[0].localId,
      id2: 0,
      exactText: incoming.table === 'certificateFields' ? incoming.value.fieldName : ''
    },
    generations: Array<{ revision: unknown; generation: unknown; present: unknown; ceiling: unknown }> = await trx(
      'snapshot_journal_physical'
    )
      .where(physical)
      .select(
        trx.raw("CASE WHEN typeof(revision)='integer' AND revision>=0 THEN CAST(revision AS TEXT) END AS revision"),
        trx.raw(
          "CASE WHEN typeof(generation)='integer' AND generation>=0 THEN CAST(generation AS TEXT) END AS generation"
        ),
        'present',
        trx.raw('(SELECT CAST(ceiling AS TEXT) FROM snapshot_journal_clock WHERE id=1) AS ceiling')
      )
      .limit(2)
  if (generations.length !== 1 || generations[0].present !== 1) invalid()
  const revision = snapshotJournalRevision(generations[0].revision),
    generation = snapshotJournalRevision(generations[0].generation)
  if (
    generation === '0' ||
    compareSnapshotJournalRevisions(generation, revision) > 0 ||
    compareSnapshotJournalRevisions(revision, snapshotJournalRevision(generations[0].ceiling)) > 0
  )
    invalid()
  signal?.throwIfAborted()
  return Object.freeze({ field, row, parent, parents, revision, generation })
}
export function requireSameNativeSimpleCurrent(expected: NativeSimpleCurrent, actual: NativeSimpleCurrent): void {
  if (JSON.stringify(expected) !== JSON.stringify(actual)) invalid()
}
