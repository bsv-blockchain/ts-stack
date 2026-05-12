import { Knex } from 'knex'
import * as sdk from '../../sdk'
import { TableAction, TableTransactionV7 } from './tables'
import {
  findAction,
  findTransactionV7,
  findTransactionV7ByTxid,
  getChainTip,
  insertAction,
  insertTransactionV7,
  setChainTip,
  transitionProcessing
} from './v7Crud'
import { auditProcessingTransition } from './v7TxAudit'
import { releaseLease, renewLease, tryClaimLease } from './v7MonitorLease'
import {
  MonitorLeaseClaim,
  MonitorLeaseRelease,
  MonitorLeaseRenew,
  MonitorLeaseResult
} from './v7MonitorLease'

/**
 * High-level service over the V7 storage primitives.
 *
 * Storage methods and the Monitor call into this surface rather than the
 * lower-level CRUD/FSM/audit/lease modules so that:
 *  - Every processing transition is audited.
 *  - Optimistic concurrency is uniformly enforced.
 *  - Chain tip + monitor lease access have one canonical entry point.
 *
 * Construction takes a Knex handle; instances are stateless and cheap to
 * create — typically one per request or per Monitor task tick.
 */
export class V7TransactionService {
  constructor (private readonly knex: Knex) {}

  // -----------------------
  // Transactions
  // -----------------------

  async findByTxid (txid: string): Promise<TableTransactionV7 | undefined> {
    return await findTransactionV7ByTxid(this.knex, txid)
  }

  async findById (transactionId: number): Promise<TableTransactionV7 | undefined> {
    return await findTransactionV7(this.knex, transactionId)
  }

  /**
   * Insert a new V7 transaction row. The row is created in `queued` state
   * unless the caller overrides `processing`.
   */
  async create (args: {
    txid: string
    processing?: sdk.ProcessingStatus
    rawTx?: number[]
    inputBeef?: number[]
    batch?: string
    idempotencyKey?: string
    isCoinbase?: boolean
    now?: Date
  }): Promise<TableTransactionV7> {
    const now = args.now ?? new Date()
    const row: Omit<TableTransactionV7, 'transactionId' | 'created_at' | 'updated_at'> = {
      txid: args.txid,
      processing: args.processing ?? 'queued',
      processingChangedAt: now,
      nextActionAt: undefined,
      attempts: 0,
      rebroadcastCycles: 0,
      wasBroadcast: false,
      idempotencyKey: args.idempotencyKey,
      batch: args.batch,
      rawTx: args.rawTx,
      inputBeef: args.inputBeef,
      height: undefined,
      merkleIndex: undefined,
      merklePath: undefined,
      merkleRoot: undefined,
      blockHash: undefined,
      isCoinbase: args.isCoinbase === true,
      lastProvider: undefined,
      lastProviderStatus: undefined,
      frozenReason: undefined,
      rowVersion: 0
    }
    const id = await insertTransactionV7(this.knex, row, now)
    await auditProcessingTransition(this.knex, id, row.processing, row.processing, { reason: 'create' }, now)
    const stored = await this.findById(id)
    if (stored == null) throw new Error(`V7 transaction ${id} disappeared after insert`)
    return stored
  }

  /**
   * Transition processing state with optimistic concurrency. Returns
   * `undefined` when the FSM rejects the move OR the row's current state no
   * longer matches `expectedFrom`.
   */
  async transition (args: {
    transactionId: number
    expectedFrom: sdk.ProcessingStatus
    to: sdk.ProcessingStatus
    provider?: string
    providerStatus?: string
    details?: Record<string, unknown>
    now?: Date
  }): Promise<TableTransactionV7 | undefined> {
    return await transitionProcessing(this.knex, {
      transactionId: args.transactionId,
      expectedFromState: args.expectedFrom,
      toState: args.to,
      provider: args.provider,
      providerStatus: args.providerStatus,
      details: args.details
    }, args.now)
  }

  /**
   * Record acquisition of a Merkle proof for a transaction. Atomically:
   *  - Updates proof columns (height, index, merkle_path, merkle_root, block_hash)
   *  - Transitions processing to `proven` from any spendable-class state.
   *  - Writes a `proof.acquired` audit row.
   */
  async recordProof (args: {
    transactionId: number
    height: number
    merkleIndex: number
    merklePath: number[]
    merkleRoot: string
    blockHash: string
    expectedFrom: sdk.ProcessingStatus
    now?: Date
  }): Promise<TableTransactionV7 | undefined> {
    const now = args.now ?? new Date()
    const next = await this.transition({
      transactionId: args.transactionId,
      expectedFrom: args.expectedFrom,
      to: 'proven',
      details: { source: 'recordProof', height: args.height },
      now
    })
    if (next == null) return undefined
    await this.knex('transactions').where({ transactionId: args.transactionId }).update({
      height: args.height,
      merkle_index: args.merkleIndex,
      merkle_path: Buffer.from(args.merklePath),
      merkle_root: args.merkleRoot,
      block_hash: args.blockHash,
      updated_at: now
    })
    return await this.findById(args.transactionId)
  }

  // -----------------------
  // Actions
  // -----------------------

  async findActionForUser (userId: number, transactionId: number): Promise<TableAction | undefined> {
    return await findAction(this.knex, userId, transactionId)
  }

  async createAction (args: {
    userId: number
    transactionId: number
    reference: string
    description: string
    isOutgoing: boolean
    satoshisDelta: number
    userNosend?: boolean
    notifyJson?: string
    now?: Date
  }): Promise<number> {
    return await insertAction(
      this.knex,
      {
        userId: args.userId,
        transactionId: args.transactionId,
        reference: args.reference,
        description: args.description,
        isOutgoing: args.isOutgoing,
        satoshisDelta: args.satoshisDelta,
        userNosend: args.userNosend === true,
        hidden: false,
        userAborted: false,
        notifyJson: args.notifyJson,
        rowVersion: 0
      },
      args.now
    )
  }

  // -----------------------
  // Chain tip
  // -----------------------

  async getChainTip (): Promise<{ height: number, blockHash: string } | undefined> {
    const tip = await getChainTip(this.knex)
    if (tip == null) return undefined
    return { height: tip.height, blockHash: tip.blockHash }
  }

  async setChainTip (args: { height: number, blockHash: string, merkleRoot?: string, now?: Date }): Promise<void> {
    await setChainTip(this.knex, args, args.now)
  }

  // -----------------------
  // Monitor lease
  // -----------------------

  async tryClaimLease (claim: MonitorLeaseClaim, now?: Date): Promise<MonitorLeaseResult> {
    return await tryClaimLease(this.knex, claim, now)
  }

  async renewLease (renew: MonitorLeaseRenew, now?: Date): Promise<MonitorLeaseResult> {
    return await renewLease(this.knex, renew, now)
  }

  async releaseLease (release: MonitorLeaseRelease): Promise<boolean> {
    return await releaseLease(this.knex, release)
  }
}
