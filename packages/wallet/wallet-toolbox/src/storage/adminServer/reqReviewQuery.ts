import type { Knex } from 'knex'

export interface ReqRow {
  updated_at: Date | string
  req_created_at: Date | string
  tx_created_at?: Date | string
  minutesOld: number
  hoursOld: number
  provenTxReqId: number
  transactionId?: number
  userId?: number
  txid: string
  provenTxId?: number
  reqStatus: string
  txStatus?: string
  satoshis?: number
  attempts: number
  notified: boolean
  history: string
  notify: string
  rawTxHex?: string
  batch?: string
  inputBeefHex?: string
}

export interface ReqReviewFilter {
  status?: string
  txid?: string
  batch?: string
  userId?: number
  minTransactionId: number
  limit: number
  offset: number
}

function isPostgres(knex: Knex): boolean {
  return knex.client.dialect === 'postgresql'
}

/** Whole `unitSeconds` elapsed since `column`, as MySQL TIMESTAMPDIFF reports it. */
function ageSince(knex: Knex, column: string, unitSeconds: 60 | 3600, alias: string): Knex.Raw {
  if (isPostgres(knex)) {
    return knex.raw('cast(trunc(extract(epoch from (now() - ??)) / ?) as integer) as ??', [column, unitSeconds, alias])
  }
  return knex.raw(`TIMESTAMPDIFF(${unitSeconds === 60 ? 'MINUTE' : 'HOUR'}, ??, NOW()) as ??`, [column, alias])
}

/** Upper-case hex of a binary column, as MySQL HEX() returns it. */
function upperHex(knex: Knex, column: string, alias: string): Knex.Raw {
  if (isPostgres(knex)) return knex.raw("upper(encode(??, 'hex')) as ??", [column, alias])
  return knex.raw('HEX(??) as ??', [column, alias])
}

/**
 * Proven-tx-req rows joined to their transactions for the admin review page.
 * Supports MySQL and Postgres.
 */
export async function selectReqReview(
  knex: Knex,
  filter: ReqReviewFilter
): Promise<{ total: number; rows: ReqRow[] }> {
  const base = knex('proven_tx_reqs as r')
    .join('transactions as t', 't.txid', 'r.txid')
    .where('t.transactionId', '>=', filter.minTransactionId)

  if (filter.status) void base.andWhere('r.status', filter.status)
  if (filter.txid) void base.andWhere('r.txid', filter.txid)
  if (filter.batch) void base.andWhere('r.batch', filter.batch)
  if (filter.userId) void base.andWhere('t.userId', filter.userId)

  const totalResult = (await base.clone().count({ count: '*' })) as Array<{ count: number | string }>
  const total = Number(totalResult[0]?.count || 0)

  const rows = (await base
    .clone()
    .select([
      'r.updated_at',
      'r.created_at as req_created_at',
      't.created_at as tx_created_at',
      ageSince(knex, 'r.created_at', 60, 'minutesOld'),
      ageSince(knex, 'r.created_at', 3600, 'hoursOld'),
      'r.provenTxReqId',
      't.transactionId',
      't.userId',
      'r.txid',
      'r.provenTxId',
      'r.status as reqStatus',
      't.status as txStatus',
      't.satoshis',
      'r.attempts',
      'r.notified',
      'r.history',
      'r.notify',
      upperHex(knex, 'r.rawTx', 'rawTxHex'),
      'r.batch',
      upperHex(knex, 'r.inputBEEF', 'inputBeefHex')
    ])
    .orderBy('r.provenTxReqId', 'desc')
    .limit(filter.limit)
    .offset(filter.offset)) as ReqRow[]

  return { total, rows }
}
