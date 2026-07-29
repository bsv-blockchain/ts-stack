import { Beef } from '@bsv/sdk'
import { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { PurgeParams, PurgeResults, StorageGetBeefOptions, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { WalletError } from '../../sdk/WalletError'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { TableOutput } from '../schema/tables/TableOutput'
import { TableOutputTagMap } from '../schema/tables/TableOutputTagMap'
import { TableTxLabelMap } from '../schema/tables/TableTxLabelMap'
import { TableCommission } from '../schema/tables/TableCommission'

export async function purgeData(storage: StorageKnex, params: PurgeParams, trx?: TrxToken): Promise<PurgeResults> {
  const r: PurgeResults = { count: 0, log: '' }
  const defaultAge = 1000 * 60 * 60 * 24 * 14

  if (params.purgeCompleted) {
    await purgeCompletedData(storage, params.purgeCompletedAge || defaultAge, r, trx)
  }

  if (params.purgeFailed) {
    await purgeFailedData(storage, params.purgeFailedAge || defaultAge, r, trx)
  }

  if (params.purgeSpent) {
    await purgeSpentData(storage, params.purgeSpentAge || defaultAge, r, trx)
  }

  await runPurgeQuery({
    log: 'orphan proven_txs deleted',
    q: storage
      .toDb(trx)('proven_txs')
      .whereRaw(
        'not exists(select * from transactions as t where t.txid = proven_txs.txid or t.provenTxId = proven_txs.provenTxId)'
      )
      .whereRaw(
        'not exists(select * from proven_tx_reqs as r where r.txid = proven_txs.txid or r.provenTxId = proven_txs.provenTxId)'
      )
      .delete()
  }, r)

  return r
}

async function runPurgeQuery(pq: PurgeQuery, result: PurgeResults): Promise<void> {
  try {
    pq.sql = pq.q.toString()
    const count = await pq.q
    if (count > 0) {
      result.count += count
      result.log += `${count} ${pq.log}\n`
    }
  } catch (error: unknown) {
    WalletError.fromUnknown(error)
    throw error
  }
}

async function runPurgeQueries(queries: PurgeQuery[], result: PurgeResults): Promise<void> {
  for (const query of queries) await runPurgeQuery(query, result)
}

async function purgeCompletedData(
  storage: StorageKnex,
  age: number,
  result: PurgeResults,
  trx?: TrxToken
): Promise<void> {
  const before = toSqlWhereDate(new Date(Date.now() - age))
  const queries: PurgeQuery[] = [{
    log: 'conpleted transactions purged of transient data',
    q: storage
      .toDb(trx)('transactions')
      .update({ inputBEEF: null, rawTx: null })
      .where('updated_at', '<', before)
      .where('status', 'completed')
      .whereNotNull('provenTxId')
      .where(function () {
        this.orWhereNotNull('inputBEEF')
        this.orWhereNotNull('rawTx')
      })
  }]
  const completedReqs = await storage
    .toDb(trx)<{ provenTxReqId: number }>('proven_tx_reqs')
    .select('provenTxReqId')
    .where('updated_at', '<', before)
    .where('status', 'completed')
    .whereNotNull('provenTxId')
    .where('notified', 1)
  const ids = completedReqs.map(request => request.provenTxReqId)
  if (ids.length > 0) {
    queries.push({
      log: 'completed proven_tx_reqs deleted',
      q: storage.toDb(trx)('proven_tx_reqs').whereIn('provenTxReqId', ids).delete()
    })
  }
  await runPurgeQueries(queries, result)
}

async function queueProvenRequestDeletion(
  storage: StorageKnex,
  before: string,
  status: 'invalid' | 'doubleSpend',
  queries: PurgeQuery[],
  trx?: TrxToken
): Promise<void> {
  const requests = await storage
    .toDb(trx)<{ provenTxReqId: number }>('proven_tx_reqs')
    .select('provenTxReqId')
    .where('updated_at', '<', before)
    .where('status', status)
  const ids = requests.map(request => request.provenTxReqId)
  if (ids.length === 0) return
  queries.push({
    log: `${status} proven_tx_reqs deleted`,
    q: storage.toDb(trx)('proven_tx_reqs').whereIn('provenTxReqId', ids).delete()
  })
}

async function purgeFailedData(
  storage: StorageKnex,
  age: number,
  result: PurgeResults,
  trx?: TrxToken
): Promise<void> {
  const before = toSqlWhereDate(new Date(Date.now() - age))
  const failedTransactions = await storage
    .toDb(trx)<{ transactionId: number }>('transactions')
    .select('transactionId')
    .where('updated_at', '<', before)
    .where('status', 'failed')
  const queries: PurgeQuery[] = []
  await queueTransactionDeletion(
    storage,
    failedTransactions.map(transaction => transaction.transactionId),
    queries,
    'failed',
    true,
    trx
  )
  await queueProvenRequestDeletion(storage, before, 'invalid', queries, trx)
  await queueProvenRequestDeletion(storage, before, 'doubleSpend', queries, trx)
  await runPurgeQueries(queries, result)
}

async function collectProofTransactionIds(storage: StorageKnex): Promise<Set<string>> {
  const beef = new Beef()
  const utxos = await storage.findOutputs({
    partial: { spendable: true },
    txStatus: ['sending', 'unproven', 'completed', 'nosend']
  })
  for (const utxo of utxos) {
    if (utxo.txid == null) continue
    const options: StorageGetBeefOptions = { mergeToBeef: beef, ignoreServices: true }
    try {
      await storage.getBeefForTransaction(utxo.txid, options)
    } catch (error: unknown) {
      const walletError = WalletError.fromUnknown(error)
      if (!isMissingLocalBeefError(walletError, utxo.txid, storage.chain)) throw error
    }
  }
  return new Set(beef.txs.map(transaction => transaction.txid))
}

async function purgeSpentData(
  storage: StorageKnex,
  age: number,
  result: PurgeResults,
  trx?: TrxToken
): Promise<void> {
  const before = toSqlWhereDate(new Date(Date.now() - age))
  const proofTxids = await collectProofTransactionIds(storage)
  const spentTransactions: TableTransaction[] = await storage
    .toDb(trx)<TableTransaction>('transactions')
    .where('updated_at', '<', before)
    .where('status', 'completed')
    .whereRaw(
      'not exists(select outputId from outputs as o where o.transactionId = transactions.transactionId and o.spendable = 1)'
    )
  const ids = spentTransactions
    .filter(transaction => !proofTxids.has(transaction.txid ?? ''))
    .map(transaction => transaction.transactionId)
  if (ids.length === 0) return
  const update: Partial<TableOutput> = { spentBy: null as unknown as undefined }
  const queries: PurgeQuery[] = [{
    log: 'spent outputs no longer tracked by spentBy',
    q: storage
      .toDb(trx)<TableOutput>('outputs')
      .update(storage.validatePartialForUpdate(update, undefined, ['spendable']))
      .where('spendable', false)
      .whereIn('spentBy', ids)
  }]
  await queueTransactionDeletion(storage, ids, queries, 'spent', false, trx)
  await runPurgeQueries(queries, result)
}

async function queueTransactionDeletion(
  storage: StorageKnex,
  transactionIds: number[],
  queries: PurgeQuery[],
  reason: string,
  markNotSpentBy: boolean,
  trx?: TrxToken
): Promise<void> {
  if (transactionIds.length === 0) return
  const outputs = await storage
    .toDb(trx)<{ outputId: number }>('outputs')
    .select('outputId')
    .whereIn('transactionId', transactionIds)
  const outputIds = outputs.map(output => output.outputId)
  if (outputIds.length > 0) {
    queries.push(
      {
        log: `${reason} output_tags_map deleted`,
        q: storage.toDb(trx)<TableOutputTagMap>('output_tags_map').whereIn('outputId', outputIds).delete()
      },
      {
        log: `${reason} outputs deleted`,
        q: storage.toDb(trx)<TableOutput>('outputs').whereIn('outputId', outputIds).delete()
      }
    )
  }
  queries.push(
    {
      log: `${reason} tx_labels_map deleted`,
      q: storage.toDb(trx)<TableTxLabelMap>('tx_labels_map').whereIn('transactionId', transactionIds).delete()
    },
    {
      log: `${reason} commissions deleted`,
      q: storage.toDb(trx)<TableCommission>('commissions').whereIn('transactionId', transactionIds).delete()
    }
  )
  if (markNotSpentBy) {
    queries.push({
      log: 'unspent outputs updated to spendable',
      q: storage
        .toDb(trx)<TableOutput>('outputs')
        .update({ spendable: true, spentBy: null as unknown as undefined })
        .whereIn('spentBy', transactionIds)
    })
  }
  queries.push({
    log: `${reason} transactions deleted`,
    q: storage.toDb(trx)<TableTransaction>('transactions').whereIn('transactionId', transactionIds).delete()
  })
}

interface PurgeQuery {
  q: Knex.QueryBuilder<any, number>
  sql?: string
  log: string
}

function toSqlWhereDate(d: Date): string {
  let s = d.toISOString()
  s = s.replace('T', ' ')
  s = s.replace('Z', '')
  return s
}

function isMissingLocalBeefError(e: WalletError, txid: string, chain: string): boolean {
  if (e.code !== 'WERR_INVALID_PARAMETER') return false
  const parameter = (e as WalletError & { parameter?: string }).parameter
  if (
    parameter === `txid ${txid}` &&
    e.message === `The txid ${txid} parameter must be valid transaction on chain ${chain}`
  ) {
    return true
  }
  return parameter === 'txid' && /^The txid parameter must be known to storage\. .+ is not known\.$/.test(e.message)
}
