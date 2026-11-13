import type { Knex } from 'knex'
import { runInSeries } from '../../utility/runInSeries'
import { EDGES, GUARDS, PROGRESS, PAGE_ROWS, mysql, invalid } from './snapshotGlobalIndexModel'

export interface Position {
  afterRowId: number
  complete: boolean | number
}
export function validPosition(state: Position | undefined): state is Position {
  return (
    state !== undefined &&
    Number.isSafeInteger(state.afterRowId) &&
    state.afterRowId >= 0 &&
    [false, true, 0, 1].includes(state.complete)
  )
}
function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) invalid('Invalid snapshot global source key')
  return value
}
interface SourceRow {
  transactionId: number
  userId: number
  provenTxId: number | null
  txid: string | null
  txidBytes: number
}
interface RequestRow {
  provenTxReqId: number
  provenTxId: number | null
}
async function currentProof(k: Knex, proofId: number): Promise<void> {
  positive(proofId)
  await k(GUARDS)
    .insert({ proofId, present: false })
    .onConflict('proofId')
    .merge({ proofId: k.ref('proofId') })
  // This lock is shared with proof insert/delete triggers, including absence.
  // UPDATE reads the current source after acquiring the auxiliary target lock.
  if (mysql(k))
    await k.raw(
      'UPDATE snapshot_global_guards g LEFT JOIN proven_txs p ON p.provenTxId=g.proofId SET g.present=(p.provenTxId IS NOT NULL) WHERE g.proofId=?',
      [proofId]
    )
  else
    await k(GUARDS)
      .where('proofId', proofId)
      .update({
        present: k.raw('EXISTS(SELECT 1 FROM proven_txs WHERE provenTxId=?)', [proofId])
      })
}
async function bootstrapRow(k: Knex, row: SourceRow): Promise<void> {
  positive(row.transactionId)
  positive(row.userId)
  if (
    !Number.isSafeInteger(row.txidBytes) ||
    row.txidBytes < 0 ||
    row.txidBytes > 256 ||
    (row.txid !== null && (typeof row.txid !== 'string' || Array.from(row.txid).length > 64))
  )
    invalid('Invalid snapshot global transaction key')
  let request: RequestRow | undefined
  if (row.txid !== null) {
    const query = k('proven_tx_reqs').select('provenTxReqId', 'provenTxId').where('txid', row.txid)
    if (mysql(k)) void query.forShare()
    request = await query.first()
    if (request !== undefined) positive(request.provenTxReqId)
  }
  const proofs = [
    ...new Set(
      [row.provenTxId, request?.provenTxId].filter((value): value is number => value !== null && value !== undefined)
    )
  ].sort((a, b) => a - b)
  await runInSeries(proofs, async proofId => {
    await currentProof(k, proofId)
  })
  const values: Array<{ requestId: number; tableId: number; rowId: number }> = []
  if (row.provenTxId !== null) values.push({ requestId: 0, tableId: 1, rowId: positive(row.provenTxId) })
  if (request !== undefined) {
    values.push({
      requestId: request.provenTxReqId,
      tableId: 0,
      rowId: request.provenTxReqId
    })
    if (request.provenTxId !== null)
      values.push({
        requestId: request.provenTxReqId,
        tableId: 1,
        rowId: positive(request.provenTxId)
      })
  }
  if (values.length !== 0)
    await k(EDGES)
      .insert(
        values.map(value => ({
          ...value,
          transactionId: row.transactionId,
          userId: row.userId
        }))
      )
      .onConflict(['transactionId', 'requestId', 'tableId', 'rowId'])
      .merge({ transactionId: k.ref('transactionId') })
}
export async function bootstrapPage(k: Knex): Promise<boolean> {
  return await k.transaction(async trx => {
    if (!mysql(k))
      await trx(PROGRESS)
        .where('id', 0)
        .update({ complete: trx.ref('complete') })
    const position = trx(PROGRESS).where('id', 0)
    if (mysql(k)) void position.forUpdate()
    const state: Position | undefined = await position.first()
    if (!validPosition(state)) invalid('Invalid snapshot global bootstrap position')
    if (state.complete === true || state.complete === 1) return true
    if (state.afterRowId === 0) {
      // The initial position is below every supported source key. Do not mark a
      // malformed legacy SQLite store complete while silently skipping its rows.
      const unsupported = trx('transactions').select('transactionId').where('transactionId', '<=', 0)
      if (mysql(k)) void unsupported.forUpdate()
      if ((await unsupported.first()) !== undefined) invalid('Invalid snapshot global source key')
    }
    const length = mysql(k) ? 'octet_length(txid)' : 'length(cast(txid AS blob))'
    const source = trx('transactions')
      .select(
        'transactionId',
        'userId',
        'provenTxId',
        trx.raw(`CASE WHEN ${length} <= ? THEN txid END AS txid`, [256]),
        trx.raw(`COALESCE(${length},?) AS txidBytes`, [0])
      )
      .where('transactionId', '>', state.afterRowId)
      .orderBy('transactionId')
      .limit(PAGE_ROWS)
    if (mysql(k)) void source.forUpdate()
    const rows: SourceRow[] = await source
    await runInSeries(rows, async row => {
      await bootstrapRow(trx, row)
    })
    const complete = rows.length < PAGE_ROWS
    await trx(PROGRESS)
      .where('id', 0)
      .update({
        afterRowId: rows.at(-1)?.transactionId ?? state.afterRowId,
        complete
      })
    return complete
  })
}
