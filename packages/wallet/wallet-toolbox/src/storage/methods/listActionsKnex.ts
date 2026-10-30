import { type ValidListActionsArgs } from '@bsv/sdk/wallet/validationHelpers'
import {
  Transaction as BsvTransaction,
  ActionStatus,
  ListActionsResult,
  WalletAction,
  WalletActionOutput,
  WalletActionInput
} from '@bsv/sdk'
import type { StorageKnex } from '../StorageKnex'
import { partitionActionLabels } from './ListActionsSpecOp'
import { AuthId } from '../../sdk/WalletStorage.interfaces'
import { TableTxLabel } from '../schema/tables/TableTxLabel'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { verifyId, verifyOne } from '../../utility/utilityHelpers'
import { TableOutput } from '../schema/tables/TableOutput'
import { TableOutputBasket } from '../schema/tables/TableOutputBasket'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { makeBrc114ActionTimeLabel, parseBrc114ActionTimeLabels } from '../../utility/brc114ActionTimeLabels'
import { applyBrc153ReferenceLabel } from '../../utility/brc153ReferenceLabels'

// Keep each statement below SQLite's and Postgres's bind-parameter limits: a
// page of 10000 actions can hold far more outputs than either accepts at once.
const SQL_IN_CHUNK = 500

async function whereInChunks<T>(ids: number[], query: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const chunks: number[][] = []
  for (let i = 0; i < ids.length; i += SQL_IN_CHUNK) chunks.push(ids.slice(i, i + SQL_IN_CHUNK))
  const rows: T[] = []
  // One chunk at a time, in order.
  await chunks.reduce(async (previous, chunk) => {
    await previous
    rows.push(...(await query(chunk)))
  }, Promise.resolve())
  return rows
}

function groupBy<T>(rows: T[], key: (row: T) => number | undefined): Map<number, T[]> {
  const groups = new Map<number, T[]>()
  for (const row of rows) {
    const id = key(row)
    if (id === undefined) continue
    const group = groups.get(id)
    if (group == null) groups.set(id, [row])
    else group.push(row)
  }
  return groups
}

/**
 * Reads the names mapped to each key (labels of transactions, tags of outputs)
 * for many keys at once.
 *
 * Like getLabelsForTransactionId and getTagsForOutputId, there is no ORDER BY:
 * each key's names keep the order its map rows come back in, which on SQLite,
 * MySQL and Postgres is the order they were added. Reading the map table on
 * its own, then the names, keeps that order whatever join the planner would
 * pick for many keys. `postgresIdOrder` instead orders each key's names by id
 * on Postgres, which is what its plan for the single-key query returns.
 */
async function findMappedNames(
  storage: StorageKnex,
  keys: number[],
  map: { table: string; key: string; id: string },
  names: { table: string; name: string },
  postgresIdOrder = false
): Promise<Map<number, string[]>> {
  const result = new Map<number, string[]>()
  if (keys.length === 0) return result
  const mapRows: Array<Record<string, unknown>> = await whereInChunks(keys, async chunk =>
    await storage.toDb()(map.table).whereIn(map.key, chunk).whereNot('isDeleted', true)
  )
  if (postgresIdOrder && storage.dbtype === 'Postgres') mapRows.sort((a, b) => Number(a[map.id]) - Number(b[map.id]))
  const ids = [...new Set(mapRows.map(r => Number(r[map.id])))]
  const nameRows: Array<Record<string, unknown>> = await whereInChunks(ids, async chunk =>
    await storage.toDb()(names.table).whereIn(map.id, chunk).whereNot('isDeleted', true).select(map.id, names.name)
  )
  const nameById = new Map(nameRows.map(r => [Number(r[map.id]), String(r[names.name])]))
  for (const row of mapRows) {
    const name = nameById.get(Number(row[map.id]))
    if (name === undefined) continue
    const key = Number(row[map.key])
    const list = result.get(key)
    if (list == null) result.set(key, [name])
    else list.push(name)
  }
  return result
}

async function findLabelsByTransactionId(storage: StorageKnex, transactionIds: number[]): Promise<Map<number, string[]>> {
  return await findMappedNames(
    storage,
    transactionIds,
    { table: 'tx_labels_map', key: 'transactionId', id: 'txLabelId' },
    { table: 'tx_labels', name: 'label' }
  )
}

async function findTagsByOutputId(storage: StorageKnex, outputIds: number[]): Promise<Map<number, string[]>> {
  return await findMappedNames(
    storage,
    outputIds,
    { table: 'output_tags_map', key: 'outputId', id: 'outputTagId' },
    { table: 'output_tags', name: 'tag' },
    true
  )
}

async function findBasketNamesById(storage: StorageKnex, basketIds: number[]): Promise<Map<number, string>> {
  const names = new Map<number, string>()
  if (basketIds.length === 0) return names
  const rows: TableOutputBasket[] = await whereInChunks(
    basketIds,
    async chunk => await storage.toDb()('output_baskets').whereIn('basketId', chunk)
  )
  for (const basket of rows) names.set(Number(basket.basketId), basket.name)
  return names
}

/**
 * Loads the outputs whose `column` (transactionId or spentBy) is one of
 * transactionIds, in the same row shape findOutputs returns.
 */
async function findOutputsByTransactionIds(
  storage: StorageKnex,
  column: 'transactionId' | 'spentBy',
  transactionIds: number[],
  includeScript: boolean
): Promise<TableOutput[]> {
  const rows: TableOutput[] = await whereInChunks(
    transactionIds,
    async chunk =>
      await storage
        .findOutputsQuery({ partial: {}, noScript: !includeScript })
        .whereIn(column, chunk)
        .orderBy(column)
        .orderBy(column === 'transactionId' ? 'vout' : 'outputId')
  )
  if (includeScript) {
    await rows.reduce(async (previous, o) => {
      await previous
      await storage.validateOutputScript(o)
    }, Promise.resolve())
  }
  return storage.validateEntities(rows, undefined, ['spendable', 'change'])
}

function actionLabels(tx: Partial<TableTransaction>, labels: string[], timeFilterRequested: boolean): string[] {
  let result = labels
  if (tx.reference != null && tx.reference !== '') {
    result = applyBrc153ReferenceLabel(result, tx.reference)
  }
  if (timeFilterRequested) {
    const ts = tx.created_at != null ? new Date(tx.created_at as any).getTime() : Number.NaN
    if (!Number.isNaN(ts)) {
      const timeLabel = makeBrc114ActionTimeLabel(ts)
      if (!result.includes(timeLabel)) result.push(timeLabel)
    }
  }
  return result
}

async function enrichActionOutputs(
  storage: StorageKnex,
  txs: Array<Partial<TableTransaction>>,
  actions: WalletAction[],
  transactionIds: number[],
  includeOutputLockingScripts: boolean
): Promise<void> {
  const outputs = await findOutputsByTransactionIds(storage, 'transactionId', transactionIds, includeOutputLockingScripts)
  const basketIds = [...new Set(outputs.map(o => o.basketId).filter((id): id is number => id != null && id > 0))]
  const [tagsByOutputId, basketNames] = await Promise.all([
    findTagsByOutputId(storage, outputs.map(o => o.outputId)),
    findBasketNamesById(storage, basketIds)
  ])
  const outputsByTransactionId = groupBy(outputs, o => o.transactionId)
  txs.forEach((tx, i) => {
    actions[i].outputs = (outputsByTransactionId.get(tx.transactionId as number) ?? []).map(o => {
      const wo: WalletActionOutput = {
        satoshis: o.satoshis || 0,
        spendable: !!o.spendable,
        tags: tagsByOutputId.get(o.outputId) ?? [],
        outputIndex: Number(o.vout),
        outputDescription: o.outputDescription || '',
        basket: (o.basketId != null && o.basketId > 0 ? basketNames.get(o.basketId) : undefined) || ''
      }
      if (includeOutputLockingScripts) wo.lockingScript = asString(o.lockingScript || [])
      return wo
    })
  })
}

async function enrichActionInputs(
  storage: StorageKnex,
  txs: Array<Partial<TableTransaction>>,
  actions: WalletAction[],
  transactionIds: number[],
  includeSourceLockingScripts: boolean,
  includeUnlockingScripts: boolean
): Promise<void> {
  const inputs = await findOutputsByTransactionIds(storage, 'spentBy', transactionIds, includeSourceLockingScripts)
  const inputsByTransactionId = groupBy(inputs, o => o.spentBy)
  const spendingTxids = txs
    .filter(tx => inputsByTransactionId.has(tx.transactionId as number) && tx.txid != null && tx.txid !== '')
    .map(tx => tx.txid as string)
  const rawTxs = await storage.getProvenOrRawTxs(spendingTxids)
  txs.forEach((tx, i) => {
    const action = actions[i]
    action.inputs = []
    const txInputs = inputsByTransactionId.get(tx.transactionId as number)
    if (txInputs == null) return
    const r = tx.txid != null && tx.txid !== '' ? rawTxs.get(tx.txid) : undefined
    const rawTx = r?.proven != null ? r.proven.rawTx : r?.rawTx
    const bsvTx = rawTx != null ? BsvTransaction.fromBinary(rawTx) : undefined
    for (const o of txInputs) {
      const input = bsvTx?.inputs.find(v => v.sourceTXID === o.txid && v.sourceOutputIndex === o.vout)
      const wo: WalletActionInput = {
        sourceOutpoint: `${o.txid}.${o.vout}`,
        sourceSatoshis: o.satoshis || 0,
        inputDescription: o.outputDescription || '',
        sequenceNumber: input?.sequence || 0
      }
      action.inputs.push(wo)
      if (includeSourceLockingScripts) wo.sourceLockingScript = asString(o.lockingScript || [])
      if (includeUnlockingScripts) wo.unlockingScript = input?.unlockingScript?.toHex()
    }
  })
}

export async function listActions(
  storage: StorageKnex,
  auth: AuthId,
  vargs: ValidListActionsArgs
): Promise<ListActionsResult> {
  const limit = vargs.limit
  const offset = vargs.offset
  const userId = verifyId(auth.userId)

  const k = storage.toDb()

  const r: ListActionsResult = {
    totalActions: 0,
    actions: []
  }

  const {
    from: actionTimeFrom,
    to: actionTimeTo,
    timeFilterRequested,
    remainingLabels: ordinaryLabelsPreSpecOp
  } = parseBrc114ActionTimeLabels(vargs.labels)

  const createdAtFrom = actionTimeFrom === undefined ? undefined : new Date(actionTimeFrom)
  const createdAtTo = actionTimeTo === undefined ? undefined : new Date(actionTimeTo)

  const { specOp, specOpLabels, labels } = partitionActionLabels(ordinaryLabelsPreSpecOp)

  let labelIds: number[] = []
  if (labels.length > 0) {
    const q = k<TableTxLabel>('tx_labels')
      .where({
        userId,
        isDeleted: false
      })
      .whereNotNull('txLabelId')
      .whereIn('label', labels)
      .select('txLabelId')
    const rows = await q
    labelIds = rows.map(r => r.txLabelId)
  }

  const isQueryModeAll = vargs.labelQueryMode === 'all'
  if (isQueryModeAll && labelIds.length < labels.length)
  // all the required labels don't exist, impossible to satisfy.
  {
    return r
  }

  if (!isQueryModeAll && labelIds.length === 0 && labels.length > 0)
  // any and only non-existing labels, impossible to satisfy.
  {
    return r
  }

  const columns: string[] = [
    'created_at',
    'transactionId',
    'reference',
    'txid',
    'satoshis',
    'status',
    'isOutgoing',
    'description',
    'version',
    'lockTime'
  ]

  const stati: string[] =
    specOp?.setStatusFilter == null
      ? ['completed', 'unprocessed', 'sending', 'unproven', 'unsigned', 'nosend', 'nonfinal']
      : specOp.setStatusFilter()

  const noLabels = labelIds.length === 0

  const applyTimestampFilters = (q: any) => {
    if (!timeFilterRequested) return
    q.whereNotNull('created_at')
    if (createdAtFrom != null) q.where('created_at', '>=', storage.validateDateForWhere(createdAtFrom))
    if (createdAtTo != null) q.where('created_at', '<', storage.validateDateForWhere(createdAtTo))
  }

  const makeWithLabelsQueries = () => {
    // ?? quotes identifiers: Postgres lowercases unquoted names, so camelCase columns must be quoted.
    const cteq = k.raw(
      `
            SELECT ${columns.map(() => '??').join(',')},
                    (SELECT COUNT(*)
                    FROM tx_labels_map AS m
                    WHERE ?? = ??
                    AND ?? IN (${labelIds.map(() => '?').join(',')})
                    ) AS lc
            FROM transactions AS t
            WHERE ?? = ?
            AND t.status in (${stati.map(() => '?').join(',')})
            `,
      [
        ...columns.map(c => 't.' + c),
        'm.transactionId',
        't.transactionId',
        'm.txLabelId',
        ...labelIds,
        't.userId',
        userId,
        ...stati
      ]
    )

    const q = k.with('tlc', cteq)
    q.from('tlc')
    applyTimestampFilters(q)
    if (isQueryModeAll) q.where('lc', labelIds.length)
    else q.where('lc', '>', 0)
    const qcount = q.clone()
    q.select(columns)
    qcount.count('transactionId as total')
    return { q, qcount }
  }

  const makeWithoutLabelsQueries = () => {
    const q = k('transactions').where('userId', userId).whereIn('status', stati)
    applyTimestampFilters(q)
    const qcount = q.clone().count('transactionId as total')
    return { q, qcount }
  }

  const { q, qcount } = noLabels ? makeWithoutLabelsQueries() : makeWithLabelsQueries()

  q.limit(limit).offset(offset).orderBy('transactionId', 'asc')

  const txs: Array<Partial<TableTransaction>> = await q

  if (specOp?.postProcess != null) {
    await specOp.postProcess(storage, auth, vargs, specOpLabels, txs)
  }

  if (!limit) r.totalActions = txs.length
  else if (txs.length < limit) r.totalActions = (offset || 0) + txs.length
  else {
    const total = verifyOne(await qcount).total
    r.totalActions = Number(total)
  }

  for (const tx of txs) {
    r.actions.push({
      txid: tx.txid || '',
      satoshis: tx.satoshis || 0,
      status: tx.status! as ActionStatus,
      isOutgoing: !!tx.isOutgoing,
      description: tx.description || '',
      version: tx.version || 0,
      lockTime: tx.lockTime || 0
    })
  }

  await enrichActions(storage, txs, r.actions, vargs, timeFilterRequested)
  return r
}

/** Loads each association for the whole page at once rather than per action. */
async function enrichActions(
  storage: StorageKnex,
  txs: Array<Partial<TableTransaction>>,
  actions: WalletAction[],
  vargs: ValidListActionsArgs,
  timeFilterRequested: boolean
): Promise<void> {
  const transactionIds = txs.map(tx => tx.transactionId).filter((id): id is number => id !== undefined)
  if (vargs.includeLabels) {
    const labelsByTransactionId = await findLabelsByTransactionId(storage, transactionIds)
    txs.forEach((tx, i) => {
      const labels = tx.transactionId === undefined ? [] : (labelsByTransactionId.get(tx.transactionId) ?? [])
      actions[i].labels = actionLabels(tx, labels, timeFilterRequested)
    })
  }
  if (vargs.includeOutputs && transactionIds.length > 0) {
    await enrichActionOutputs(storage, txs, actions, transactionIds, !!vargs.includeOutputLockingScripts)
  }
  if (vargs.includeInputs && transactionIds.length > 0) {
    await enrichActionInputs(
      storage,
      txs,
      actions,
      transactionIds,
      !!vargs.includeInputSourceLockingScripts,
      !!vargs.includeInputUnlockingScripts
    )
  }
}
