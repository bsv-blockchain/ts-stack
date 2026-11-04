import type { Knex } from 'knex'
import { requireBrc38PackedRead } from '../portable/Brc38NativePackedSchemaNode'
import { snapshotJournalRevision, compareSnapshotJournalRevisions } from './journal/SnapshotJournalRevision'

export type NativeSnapshotParentEntity = 'provenTx' | 'transaction' | 'outputBasket' | 'certificate'
export interface NativeSnapshotParentFence {
  readonly entity: NativeSnapshotParentEntity
  readonly id: number
  readonly revision: string
  readonly generation: string
}
const definitions = {
  provenTx: { sql: 'proven_txs', key: 'provenTxId', owned: false, tableId: 8 },
  transaction: { sql: 'transactions', key: 'transactionId', owned: true, tableId: 0 },
  outputBasket: { sql: 'output_baskets', key: 'basketId', owned: true, tableId: 4 },
  certificate: { sql: 'certificates', key: 'certificateId', owned: true, tableId: 2 }
} as const
function invalid(): never {
  throw new Error('Native snapshot mapped parent physical generation or ownership differs')
}
/** Fresh actual parent point reads on the same admitted native transaction.
 * Returned ID/revision/generation tuples are comparison DATA, not existence or
 * authorization verdicts. The enclosing current-row/session operation repeats
 * this after every await and inside the final writer before its effects. */
export async function readNativeSnapshotParentFences(
  trx: Knex.Transaction,
  userId: number,
  parents: readonly Readonly<{ entity: NativeSnapshotParentEntity; id: number }>[],
  signal?: AbortSignal
): Promise<readonly Readonly<NativeSnapshotParentFence>[]> {
  signal?.throwIfAborted()
  requireBrc38PackedRead(trx)
  const selectedParents: readonly Readonly<{ entity: NativeSnapshotParentEntity; id: number }>[] = parents
  if (!Number.isSafeInteger(userId) || userId < 1 || !Array.isArray(parents) || parents.length > 3) invalid()
  const result: NativeSnapshotParentFence[] = []
  for (const parent of selectedParents) {
    if (!Object.hasOwn(definitions, parent.entity) || !Number.isSafeInteger(parent.id) || parent.id < 1) invalid()
    if (result.some(value => value.entity === parent.entity && value.id === parent.id)) continue
    const form = definitions[parent.entity],
      key = { [form.key]: parent.id, ...(form.owned ? { userId } : {}) },
      actual: Array<{ id: unknown; revision: unknown; generation: unknown; present: unknown; ceiling: unknown }> =
        await trx(form.sql)
          .where(key)
          .select(
            trx.raw('?? AS id', [form.key]),
            trx.raw(
              "(SELECT CASE WHEN typeof(revision)='integer' AND revision>=0 THEN CAST(revision AS TEXT) END FROM snapshot_journal_physical WHERE tableId=? AND id1=??.?? AND id2=0 AND exactText='') AS revision",
              [form.tableId, form.sql, form.key]
            ),
            trx.raw(
              "(SELECT CASE WHEN typeof(generation)='integer' AND generation>=0 THEN CAST(generation AS TEXT) END FROM snapshot_journal_physical WHERE tableId=? AND id1=??.?? AND id2=0 AND exactText='') AS generation",
              [form.tableId, form.sql, form.key]
            ),
            trx.raw(
              "(SELECT present FROM snapshot_journal_physical WHERE tableId=? AND id1=??.?? AND id2=0 AND exactText='') AS present",
              [form.tableId, form.sql, form.key]
            ),
            trx.raw('(SELECT CAST(ceiling AS TEXT) FROM snapshot_journal_clock WHERE id=1) AS ceiling')
          )
          .limit(2)
    if (actual.length !== 1 || actual[0].id !== parent.id || actual[0].present !== 1) invalid()
    const revision = snapshotJournalRevision(actual[0].revision),
      generation = snapshotJournalRevision(actual[0].generation),
      ceiling = snapshotJournalRevision(actual[0].ceiling)
    if (
      generation === '0' ||
      compareSnapshotJournalRevisions(generation, revision) > 0 ||
      compareSnapshotJournalRevisions(revision, ceiling) > 0
    )
      invalid()
    result.push(Object.freeze({ entity: parent.entity, id: parent.id, revision, generation }))
    requireBrc38PackedRead(trx)
    signal?.throwIfAborted()
  }
  return Object.freeze(result)
}
