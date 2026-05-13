import { Knex } from 'knex'
import {
  TableAction,
  TableProvenTx,
  TableProvenTxReq,
  TableTransaction,
  TableTransactionNew
} from './tables'
import { runBackfill, BackfillDriver, BackfillStats } from './backfill.runner'

const STREAM_BATCH = 500

/**
 * Knex driver for the the backfill.
 *
 * Reads from the legacy `proven_tx_reqs`, `proven_txs`, and `transactions`
 * tables, writes into the new `transactions_new` and `actions` tables, and
 * re-points `tx_labels_map` rows to the new `actionId`.
 *
 * All work is performed against the `knex` (or transaction) handle passed in.
 * The caller is responsible for opening a transaction around the orchestrator
 * call when atomicity is desired.
 */
export class KnexBackfillDriver implements BackfillDriver {
  constructor (private readonly knex: Knex) {}

  async * streamLegacyReqs (): AsyncIterable<{ req: TableProvenTxReq, proven?: TableProvenTx }> {
    let lastId = 0
    /* eslint-disable-next-line no-constant-condition */
    while (true) {
      const rows: any[] = await this.knex('proven_tx_reqs as r')
        .leftJoin('proven_txs as p', 'r.provenTxId', 'p.provenTxId')
        .select(
          'r.*',
          this.knex.ref('p.height').as('p_height'),
          this.knex.ref('p.index').as('p_index'),
          this.knex.ref('p.merklePath').as('p_merklePath'),
          this.knex.ref('p.blockHash').as('p_blockHash'),
          this.knex.ref('p.merkleRoot').as('p_merkleRoot'),
          this.knex.ref('p.rawTx').as('p_rawTx'),
          this.knex.ref('p.created_at').as('p_created_at'),
          this.knex.ref('p.updated_at').as('p_updated_at'),
          this.knex.ref('p.txid').as('p_txid')
        )
        .where('r.provenTxReqId', '>', lastId)
        .orderBy('r.provenTxReqId')
        .limit(STREAM_BATCH)
      if (rows.length === 0) return
      for (const row of rows) {
        lastId = row.provenTxReqId
        const req: TableProvenTxReq = {
          created_at: row.created_at,
          updated_at: row.updated_at,
          provenTxReqId: row.provenTxReqId,
          provenTxId: row.provenTxId,
          status: row.status,
          attempts: row.attempts,
          notified: row.notified,
          txid: row.txid,
          batch: row.batch,
          history: row.history,
          notify: row.notify,
          rawTx: toBytes(row.rawTx) ?? [],
          inputBEEF: toBytes(row.inputBEEF),
          wasBroadcast: row.wasBroadcast,
          rebroadcastAttempts: row.rebroadcastAttempts
        }
        let proven: TableProvenTx | undefined
        if (row.p_txid != null) {
          proven = {
            created_at: row.p_created_at,
            updated_at: row.p_updated_at,
            provenTxId: row.provenTxId,
            txid: row.p_txid,
            height: row.p_height,
            index: row.p_index,
            merklePath: toBytes(row.p_merklePath) ?? [],
            rawTx: toBytes(row.p_rawTx) ?? [],
            blockHash: row.p_blockHash,
            merkleRoot: row.p_merkleRoot
          }
        }
        yield { req, proven }
      }
    }
  }

  async * streamLegacyTransactions (): AsyncIterable<TableTransaction> {
    let lastId = 0
    /* eslint-disable-next-line no-constant-condition */
    while (true) {
      const rows: any[] = await this.knex('transactions')
        .where('transactionId', '>', lastId)
        .orderBy('transactionId')
        .limit(STREAM_BATCH)
        .select('*')
      if (rows.length === 0) return
      for (const row of rows) {
        lastId = row.transactionId
        yield {
          created_at: row.created_at,
          updated_at: row.updated_at,
          transactionId: row.transactionId,
          userId: row.userId,
          provenTxId: row.provenTxId,
          status: row.status,
          reference: row.reference,
          isOutgoing: !!row.isOutgoing,
          satoshis: row.satoshis,
          description: row.description,
          version: row.version,
          lockTime: row.lockTime,
          txid: row.txid,
          inputBEEF: toBytes(row.inputBEEF),
          rawTx: toBytes(row.rawTx)
        }
      }
    }
  }

  async upsertTransactionNew (row: Omit<TableTransactionNew, 'transactionId'>): Promise<number> {
    const existing = await this.knex('transactions_new').where({ txid: row.txid }).first('transactionId')
    if (existing != null) {
      await this.knex('transactions_new')
        .where({ transactionId: existing.transactionId })
        .update({
          processing: row.processing,
          processing_changed_at: row.processingChangedAt,
          next_action_at: row.nextActionAt ?? null,
          attempts: row.attempts,
          rebroadcast_cycles: row.rebroadcastCycles,
          was_broadcast: row.wasBroadcast,
          batch: row.batch ?? null,
          raw_tx: toBuf(row.rawTx),
          input_beef: toBuf(row.inputBeef),
          height: row.height ?? null,
          merkle_index: row.merkleIndex ?? null,
          merkle_path: toBuf(row.merklePath),
          merkle_root: row.merkleRoot ?? null,
          block_hash: row.blockHash ?? null,
          is_coinbase: row.isCoinbase,
          updated_at: row.updated_at
        })
      return existing.transactionId
    }
    const [insertedId] = await this.knex('transactions_new').insert({
      txid: row.txid,
      processing: row.processing,
      processing_changed_at: row.processingChangedAt,
      next_action_at: row.nextActionAt ?? null,
      attempts: row.attempts,
      rebroadcast_cycles: row.rebroadcastCycles,
      was_broadcast: row.wasBroadcast,
      idempotency_key: row.idempotencyKey ?? null,
      batch: row.batch ?? null,
      raw_tx: toBuf(row.rawTx),
      input_beef: toBuf(row.inputBeef),
      height: row.height ?? null,
      merkle_index: row.merkleIndex ?? null,
      merkle_path: toBuf(row.merklePath),
      merkle_root: row.merkleRoot ?? null,
      block_hash: row.blockHash ?? null,
      is_coinbase: row.isCoinbase,
      last_provider: row.lastProvider ?? null,
      last_provider_status: row.lastProviderStatus ?? null,
      frozen_reason: row.frozenReason ?? null,
      row_version: row.rowVersion,
      created_at: row.created_at,
      updated_at: row.updated_at
    })
    if (typeof insertedId === 'number' && insertedId > 0) return insertedId
    const row2 = await this.knex('transactions_new').where({ txid: row.txid }).first('transactionId')
    return row2.transactionId
  }

  async upsertAction (row: Omit<TableAction, 'actionId'>): Promise<number> {
    const existing = await this.knex('actions')
      .where({ userId: row.userId, transactionId: row.transactionId })
      .first('actionId')
    if (existing != null) {
      await this.knex('actions')
        .where({ actionId: existing.actionId })
        .update({
          reference: row.reference,
          description: row.description,
          isOutgoing: row.isOutgoing,
          satoshis_delta: row.satoshisDelta,
          user_nosend: row.userNosend,
          hidden: row.hidden,
          user_aborted: row.userAborted,
          notify_json: row.notifyJson ?? null,
          updated_at: row.updated_at
        })
      return existing.actionId
    }
    const [insertedId] = await this.knex('actions').insert({
      userId: row.userId,
      transactionId: row.transactionId,
      reference: row.reference,
      description: row.description,
      isOutgoing: row.isOutgoing,
      satoshis_delta: row.satoshisDelta,
      user_nosend: row.userNosend,
      hidden: row.hidden,
      user_aborted: row.userAborted,
      notify_json: row.notifyJson ?? null,
      row_version: row.rowVersion,
      created_at: row.created_at,
      updated_at: row.updated_at
    })
    if (typeof insertedId === 'number' && insertedId > 0) return insertedId
    const row2 = await this.knex('actions')
      .where({ userId: row.userId, transactionId: row.transactionId })
      .first('actionId')
    return row2.actionId
  }

  async repointTxLabelMap (legacyTransactionId: number, actionId: number): Promise<void> {
    if (legacyTransactionId === actionId) return
    await this.knex('tx_labels_map')
      .where({ transactionId: legacyTransactionId })
      .update({ transactionId: actionId })
  }
}

/**
 * Convenience entry point. Opens a Knex transaction and runs the orchestrator
 * inside it so that the entire backfill either succeeds or rolls back.
 */
export async function runKnexBackfill (knex: Knex, now: Date = new Date()): Promise<BackfillStats> {
  return await knex.transaction(async trx => {
    const driver = new KnexBackfillDriver(trx)
    return await runBackfill(driver, now)
  })
}

function toBytes (v: unknown): number[] | undefined {
  if (v == null) return undefined
  if (Array.isArray(v)) return v as number[]
  if (Buffer.isBuffer(v)) return Array.from(v.values())
  if (v instanceof Uint8Array) return Array.from(v.values())
  return undefined
}

function toBuf (v: number[] | undefined): Buffer | null {
  if (v == null) return null
  return Buffer.from(v)
}
