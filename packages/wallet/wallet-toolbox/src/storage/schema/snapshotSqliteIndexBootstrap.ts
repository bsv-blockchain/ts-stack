import { runInSeries } from '../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import type { Knex } from 'knex'
import { profiles, numeric, relations } from './snapshotSqliteMembership'
import { names, progress, metadata, validateInstalled, type Plan } from './snapshotSqliteIndexGeneration'
export interface Position {
  stream: number
  afterId: number
  afterSecond: number
  afterText: string
  complete: number
}
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0
const nonnegative = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0
export function valid(state: Position): boolean {
  if (state.stream !== 10 && state.afterText !== '') return false
  if (state.stream !== 8 && state.stream !== 9 && state.afterSecond !== 0) return false
  if ((state.stream === 8 || state.stream === 9) && (state.afterId === 0) !== (state.afterSecond === 0)) return false
  if (state.stream === 10 && state.afterId === 0 && state.afterText !== '') return false
  return (
    Number.isSafeInteger(state.stream) &&
    state.stream >= 0 &&
    state.stream < 12 &&
    nonnegative(state.afterId) &&
    nonnegative(state.afterSecond) &&
    typeof state.afterText === 'string' &&
    Array.from(state.afterText).length <= 100 &&
    Buffer.byteLength(state.afterText) <= 400 &&
    [0, 1].includes(state.complete)
  )
}
async function addProfile(trx: Knex, stream: number, state: Position): Promise<Partial<Position>> {
  const { table, key } = numeric[stream]
  const query = trx(table).select({ rowId: key }, 'userId').orderBy(key).limit(256)
  if (state.afterId !== 0) void query.where(key, '>', state.afterId)
  const rows: Array<{
    rowId: number
    userId: number
  }> = await query
  if (rows.some(row => !id(row.rowId) || !id(row.userId)))
    throw new WERR_INVALID_OPERATION('Invalid profile source identity')
  if (rows.length)
    await trx(names.profile)
      .insert(
        rows.map(row => ({
          snapshotTableId: stream,
          snapshotUserId: row.userId,
          snapshotRowId: row.rowId
        }))
      )
      .onConflict(['snapshotTableId', 'snapshotUserId', 'snapshotRowId'])
      .ignore()
  return { afterId: rows.at(-1)?.rowId ?? state.afterId, complete: rows.length < 256 ? 1 : 0 }
}
async function addRelations(trx: Knex, stream: number, state: Position): Promise<Partial<Position>> {
  const relation = relations[stream - 8]
  const query = trx(relation.table)
    .select({ leftId: relation.leftKey, rightId: relation.rightKey })
    .orderBy([relation.leftKey, relation.rightKey])
    .limit(256)
  if (state.afterId !== 0)
    void query.whereRaw('(??,??)>(?,?)', [relation.leftKey, relation.rightKey, state.afterId, state.afterSecond])
  const rows: Array<{
    leftId: number
    rightId: number
  }> = await query
  if (rows.some(row => !id(row.leftId) || !id(row.rightId)))
    throw new WERR_INVALID_OPERATION('Invalid relation source identity')
  await runInSeries(rows, async row => {
    await runInSeries(['left', 'right'] as const, async side => {
      const key = side === 'left' ? relation.leftKey : relation.rightKey
      const bit = side === 'left' ? 1 : 2
      const owner = await trx(relation[side])
        .select('userId')
        .where(key, side === 'left' ? row.leftId : row.rightId)
        .first()
      if (owner === undefined) return
      if (!id(owner.userId)) throw new WERR_INVALID_OPERATION('Invalid relation source owner')
      await trx(names.relation)
        .insert({
          snapshotTableId: stream - 8,
          snapshotUserId: owner.userId,
          snapshotLeftId: row.leftId,
          snapshotRightId: row.rightId,
          snapshotMembership: bit
        })
        .onConflict(['snapshotTableId', 'snapshotUserId', 'snapshotLeftId', 'snapshotRightId'])
        .merge({ snapshotMembership: trx.raw('snapshotMembership | ?', [bit]) })
    })
  })
  return {
    afterId: rows.at(-1)?.leftId ?? state.afterId,
    afterSecond: rows.at(-1)?.rightId ?? state.afterSecond,
    complete: rows.length < 256 ? 1 : 0
  }
}
async function addFields(trx: Knex, state: Position): Promise<Partial<Position>> {
  const query = trx('certificate_fields')
    .select(
      'certificateId',
      'userId',
      trx.raw('CASE WHEN length(CAST(fieldName AS BLOB))<=400 THEN fieldName END AS fieldName'),
      trx.raw('length(CAST(fieldName AS BLOB)) AS bytes')
    )
    .orderBy(['fieldName', 'certificateId'])
    .limit(256)
  if (state.afterId !== 0) void query.whereRaw('(fieldName,certificateId)>(?,?)', [state.afterText, state.afterId])
  const rows: Array<{
    fieldName: string | null
    certificateId: number
    userId: number
    bytes: number
  }> = await query
  if (
    rows.some(
      row =>
        typeof row.fieldName !== 'string' ||
        Array.from(row.fieldName).length > 100 ||
        Buffer.byteLength(row.fieldName) !== row.bytes ||
        !id(row.certificateId) ||
        !id(row.userId)
    )
  )
    throw new WERR_INVALID_OPERATION('Invalid certificate source identity')
  await runInSeries(rows, async row => {
    const parent = await trx('certificates').where('certificateId', row.certificateId).first('userId')
    const owners = [
      { userId: row.userId, bit: 1 },
      ...(parent === undefined ? [] : [{ userId: parent.userId, bit: 2 }])
    ]
    await runInSeries(owners, async owner => {
      if (!id(owner.userId)) throw new WERR_INVALID_OPERATION('Invalid certificate source owner')
      await trx(names.certificate)
        .insert({
          snapshotUserId: owner.userId,
          snapshotFieldName: row.fieldName,
          snapshotCertificateId: row.certificateId,
          snapshotMembership: owner.bit
        })
        .onConflict(['snapshotUserId', 'snapshotFieldName', 'snapshotCertificateId'])
        .merge({ snapshotMembership: trx.raw('snapshotMembership | ?', [owner.bit]) })
    })
  })
  return {
    afterText: rows.at(-1)?.fieldName ?? state.afterText,
    afterId: rows.at(-1)?.certificateId ?? state.afterId,
    complete: rows.length < 256 ? 1 : 0
  }
}
async function addGlobal(trx: Knex, state: Position): Promise<Partial<Position>> {
  const query = trx('transactions')
    .select(
      'transactionId',
      'userId',
      'provenTxId',
      trx.raw('CASE WHEN length(CAST(txid AS BLOB))<=256 THEN txid END AS txid'),
      trx.raw('length(CAST(txid AS BLOB)) AS bytes')
    )
    .orderBy('transactionId')
    .limit(256)
  if (state.afterId !== 0) void query.where('transactionId', '>', state.afterId)
  const rows: Array<{
    transactionId: number
    userId: number
    provenTxId: number | null
    txid: string | null
    bytes: number | null
  }> = await query
  await runInSeries(rows, async row => {
    if (
      !id(row.transactionId) ||
      !id(row.userId) ||
      (row.provenTxId !== null && !id(row.provenTxId)) ||
      (row.bytes !== null &&
        (typeof row.txid !== 'string' || Array.from(row.txid).length > 64 || Buffer.byteLength(row.txid) !== row.bytes))
    )
      throw new WERR_INVALID_OPERATION('Invalid global source identity')
    const request =
      row.txid === null
        ? undefined
        : await trx('proven_tx_reqs').where('txid', row.txid).first('provenTxReqId', 'provenTxId')
    if (
      request !== undefined &&
      (!id(request.provenTxReqId) || (request.provenTxId !== null && !id(request.provenTxId)))
    )
      throw new WERR_INVALID_OPERATION('Invalid global request identity')
    const edges: Array<{ requestId: number; tableId: number; rowId: number }> = []
    if (row.provenTxId !== null) edges.push({ requestId: 0, tableId: 1, rowId: row.provenTxId })
    if (request !== undefined) {
      edges.push({ requestId: request.provenTxReqId, tableId: 0, rowId: request.provenTxReqId })
      if (request.provenTxId !== null)
        edges.push({ requestId: request.provenTxReqId, tableId: 1, rowId: request.provenTxId })
    }
    await runInSeries(edges, async edge => {
      if (edge.tableId === 1) {
        const present = (await trx('proven_txs').where('provenTxId', edge.rowId).first('provenTxId')) !== undefined
        await trx(names.guards).insert({ proofId: edge.rowId, present }).onConflict('proofId').merge({ present })
      }
      await trx(names.edges)
        .insert({ ...edge, transactionId: row.transactionId, userId: row.userId })
        .onConflict(['transactionId', 'requestId', 'tableId', 'rowId'])
        .ignore()
    })
  })
  return {
    afterId: rows.at(-1)?.transactionId ?? state.afterId,
    complete: rows.length < 256 ? 1 : 0
  }
}
async function copyStream(trx: Knex, state: Position): Promise<Partial<Position>> {
  if (state.stream < profiles.length) return await addProfile(trx, state.stream, state)
  if (state.stream < 10) return await addRelations(trx, state.stream, state)
  if (state.stream === 10) return await addFields(trx, state)
  return await addGlobal(trx, state)
}

/** Exactly one bounded source page and its cursor commit together. */
export async function copyGenerationPage(
  k: Knex,
  plan: Plan
): Promise<{
  complete: boolean
  stream: number
  copiedThrough: Position | undefined
}> {
  return await k.transaction(async trx => {
    await trx(metadata)
      .where('id', 0)
      .update({ complete: trx.ref('complete') })
    const states: Position[] = await trx(progress).select('*').orderBy('stream').limit(13)
    if (states.length !== 12 || states.some((state, index) => state.stream !== index || !valid(state)))
      throw new WERR_INVALID_OPERATION('Invalid generation progress')
    const state = states.find(state => state.complete === 0)
    if (state === undefined) {
      await validateInstalled(trx, plan)
      await trx(metadata).where('id', 0).update({ complete: true })
      return { complete: true, stream: 12, copiedThrough: undefined }
    }
    const next = await copyStream(trx, state)
    await trx(progress).where('stream', state.stream).update(next)
    return { complete: false, stream: state.stream, copiedThrough: { ...state, ...next } }
  })
}
