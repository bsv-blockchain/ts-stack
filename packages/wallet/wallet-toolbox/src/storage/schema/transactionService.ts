import { Beef, MerklePath } from '@bsv/sdk'
import { Knex } from 'knex'
import * as sdk from '../../sdk'
import { TableAction, TableOutput, TableTransactionNew } from './tables'
import {
  findActionById,
  findActionByTxid,
  findTransactionNewByTxid,
  getChainTip,
  insertAction,
  insertTransactionNew,
  mapActionRow,
  mapTransactionRow,
  setChainTip,
  transitionProcessing
} from './transactionCrud'
import { appendTxAudit, auditProcessingTransition } from './txAudit'
import { releaseLease, renewLease, tryClaimLease } from './monitorLease'
import {
  MonitorLeaseClaim,
  MonitorLeaseRelease,
  MonitorLeaseRenew,
  MonitorLeaseResult
} from './monitorLease'

/**
 * High-level service over the v3 new-schema storage primitives.
 *
 * Storage methods and the Monitor call into this surface rather than the
 * lower-level CRUD/FSM/audit/lease modules so that:
 *  - Every processing transition is audited.
 *  - Optimistic concurrency is uniformly enforced.
 *  - Chain tip + monitor lease access have one canonical entry point.
 *
 * v3 schema notes:
 *  - `transactions.txid` is the PK (no integer `transactionId`).
 *  - `actions.actionId` is the PK; `actions.txid` is the (nullable) FK to
 *    `transactions(txid)` and is set on signed actions.
 *  - `outputs.actionId` is the FK to the creating action; `outputs.txid` is
 *    a denormalised copy of the on-chain txid (NULL while the action is
 *    still an unsigned draft).
 *  - `tx_audit` is keyed by `(txid, actionId)`; both nullable.
 *  - `tx_labels_map.actionId` references `actions(actionId)`.
 *
 * Construction takes a Knex handle; instances are stateless and cheap to
 * create — typically one per request or per Monitor task tick.
 */

/**
 * Extract the merkle leaf index for `txid` from a BUMP-encoded merkle path.
 *
 * The BUMP format encodes level 0 leaves with `txid: true` and an `offset`
 * equal to the position of the transaction in its block. For a single-tx
 * proof exactly one leaf is flagged; for trimmed compound proofs the leaf
 * matching `txid` is selected.
 */
export function indexFromMerklePath (merklePath: number[], txid: string): number {
  const mp = MerklePath.fromBinary(merklePath)
  const level0 = mp.path[0] ?? []
  const leaf = level0.find(l => l.txid === true && l.hash === txid)
  if (leaf == null) throw new Error(`txid ${txid} not present in merklePath`)
  return leaf.offset
}

export class TransactionService {
  constructor (private readonly knex: Knex) {}

  // -----------------------
  // Transactions
  // -----------------------

  async findByTxid (txid: string): Promise<TableTransactionNew | undefined> {
    return await findTransactionNewByTxid(this.knex, txid)
  }

  /**
   * Insert a new canonical `transactions` row. Created in `queued` state
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
  }): Promise<TableTransactionNew> {
    const now = args.now ?? new Date()
    const row: Omit<TableTransactionNew, 'created_at' | 'updated_at'> = {
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
    const txid = await insertTransactionNew(this.knex, row, now)
    await auditProcessingTransition(this.knex, txid, row.processing, row.processing, { reason: 'create' }, now)
    const stored = await this.findByTxid(txid)
    if (stored == null) throw new Error(`new transaction ${txid} disappeared after insert`)
    return stored
  }

  /**
   * Transition processing state with optimistic concurrency. Returns
   * `undefined` when the FSM rejects the move OR the row's current state no
   * longer matches `expectedFrom`.
   */
  async transition (args: {
    txid: string
    expectedFrom: sdk.ProcessingStatus
    to: sdk.ProcessingStatus
    provider?: string
    providerStatus?: string
    details?: Record<string, unknown>
    now?: Date
  }): Promise<TableTransactionNew | undefined> {
    return await transitionProcessing(this.knex, {
      txid: args.txid,
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
   *  - Transitions processing to `confirmed` from any spendable-class state.
   *  - Writes a `proof.acquired` audit row (via the transition).
   *
   * The merkle leaf index is derived from `merklePath` (BUMP) using the row's
   * `txid`; callers do not pass it.
   */
  async recordProof (args: {
    txid: string
    height: number
    merklePath: number[]
    merkleRoot: string
    blockHash: string
    expectedFrom: sdk.ProcessingStatus
    now?: Date
  }): Promise<TableTransactionNew | undefined> {
    const now = args.now ?? new Date()
    const existing = await this.findByTxid(args.txid)
    if (existing == null) return undefined
    const merkleIndex = indexFromMerklePath(args.merklePath, existing.txid)
    const next = await this.transition({
      txid: args.txid,
      expectedFrom: args.expectedFrom,
      to: 'confirmed',
      details: { source: 'recordProof', height: args.height },
      now
    })
    if (next == null) return undefined
    await this.knex('transactions').where({ txid: args.txid }).update({
      height: args.height,
      merkle_index: merkleIndex,
      merkle_path: Buffer.from(args.merklePath),
      merkle_root: args.merkleRoot,
      block_hash: args.blockHash,
      updated_at: now
    })
    return await this.findByTxid(args.txid)
  }

  // -----------------------
  // Actions
  // -----------------------

  /**
   * Find an action by `(userId, txid)`. Only matches signed actions — unsigned
   * drafts have `actions.txid = NULL` and are not reachable by this method.
   */
  async findAction (userId: number, txid: string): Promise<TableAction | undefined> {
    return await findActionByTxid(this.knex, userId, txid)
  }

  /** Find an action by its primary key. */
  async findActionById (actionId: number): Promise<TableAction | undefined> {
    return await findActionById(this.knex, actionId)
  }

  /** Find an action by `(userId, reference)`. */
  async findActionByReference (
    userId: number,
    reference: string
  ): Promise<TableAction | undefined> {
    const row = await this.knex('actions').where({ userId, reference }).first()
    if (row == null) return undefined
    return mapActionRow(row)
  }

  /**
   * Find-or-create the canonical transaction row and the per-user action row
   * for a known on-chain txid. The action's `txid` column is set non-null
   * because the txid is supplied.
   *
   * Returns the action, the transaction, and `isNew` — true if either side
   * was newly inserted.
   */
  async findOrCreateActionForTxid (args: {
    userId: number
    txid: string
    isOutgoing: boolean
    description: string
    satoshisDelta: number
    reference: string
    rawTx?: number[]
    inputBeef?: number[]
    processing?: sdk.ProcessingStatus
    now?: Date
  }): Promise<{ action: TableAction, transaction: TableTransactionNew, isNew: boolean }> {
    const now = args.now ?? new Date()
    // Try to find existing canonical transaction row.
    let tx = await this.findByTxid(args.txid)
    let isNew = false

    if (tx == null) {
      tx = await this.create({
        txid: args.txid,
        processing: args.processing ?? 'queued',
        rawTx: args.rawTx,
        inputBeef: args.inputBeef,
        now
      })
      isNew = true
    } else {
      // Patch rawTx / inputBeef if the caller is supplying them for the first time.
      const patches: Record<string, unknown> = { updated_at: now }
      if (args.rawTx != null && tx.rawTx == null) patches.raw_tx = Buffer.from(args.rawTx)
      if (args.inputBeef != null && tx.inputBeef == null) patches.input_beef = Buffer.from(args.inputBeef)
      if (Object.keys(patches).length > 1) {
        await this.knex('transactions').where({ txid: tx.txid }).update(patches)
        const refreshed = await this.findByTxid(tx.txid)
        if (refreshed != null) tx = refreshed
      }
    }

    // Find or create the action for this user/txid.
    let actionRow = await this.knex('actions')
      .where({ userId: args.userId, txid: args.txid })
      .first()

    if (actionRow == null) {
      await insertAction(
        this.knex,
        {
          userId: args.userId,
          txid: args.txid,
          reference: args.reference,
          description: args.description,
          isOutgoing: args.isOutgoing,
          satoshisDelta: args.satoshisDelta,
          userNosend: false,
          hidden: false,
          userAborted: false,
          rowVersion: 0
        },
        now
      )
      actionRow = await this.knex('actions')
        .where({ userId: args.userId, txid: args.txid })
        .first()
      isNew = true
    }

    return { action: mapActionRow(actionRow), transaction: tx, isNew }
  }

  /** Atomically update the `satoshis_delta` column on an action row. */
  async updateActionSatoshisDelta (
    actionId: number,
    delta: number,
    now?: Date
  ): Promise<void> {
    await this.knex('actions')
      .where({ actionId })
      .update({ satoshis_delta: delta, updated_at: now ?? new Date() })
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

  // -----------------------
  // Bulk + broadcast helpers
  // -----------------------

  /**
   * Create a new transaction row already in `confirmed` state with all proof
   * columns populated. Useful for internalised transactions that arrive with a
   * Merkle proof (bump) already attached.
   */
  async createWithProof (args: {
    txid: string
    rawTx?: number[]
    inputBeef?: number[]
    height: number
    merklePath: number[]
    merkleRoot: string
    blockHash: string
    isCoinbase?: boolean
    now?: Date
  }): Promise<TableTransactionNew> {
    const now = args.now ?? new Date()
    const merkleIndex = indexFromMerklePath(args.merklePath, args.txid)
    const row: Omit<TableTransactionNew, 'created_at' | 'updated_at'> = {
      txid: args.txid,
      processing: 'confirmed',
      processingChangedAt: now,
      nextActionAt: undefined,
      attempts: 0,
      rebroadcastCycles: 0,
      wasBroadcast: true,
      idempotencyKey: undefined,
      batch: undefined,
      rawTx: args.rawTx,
      inputBeef: args.inputBeef,
      height: args.height,
      merkleIndex,
      merklePath: args.merklePath,
      merkleRoot: args.merkleRoot,
      blockHash: args.blockHash,
      isCoinbase: args.isCoinbase === true,
      lastProvider: undefined,
      lastProviderStatus: undefined,
      frozenReason: undefined,
      rowVersion: 0
    }
    const txid = await insertTransactionNew(this.knex, row, now)
    await auditProcessingTransition(this.knex, txid, 'confirmed', 'confirmed', { reason: 'createWithProof' }, now)
    const stored = await this.findByTxid(txid)
    if (stored == null) throw new Error(`new transaction ${txid} disappeared after createWithProof insert`)
    return stored
  }

  /**
   * Find an existing transaction row by txid suitable for the broadcast queue,
   * or create a new one in `queued` state. Patches missing `rawTx`/`inputBeef`/
   * `batch` columns on the existing row if the caller is supplying them.
   */
  async findOrCreateForBroadcast (args: {
    txid: string
    rawTx: number[]
    inputBeef?: number[]
    batch?: string
    processing?: sdk.ProcessingStatus
    now?: Date
  }): Promise<{ transaction: TableTransactionNew, isNew: boolean }> {
    const existing = await this.findByTxid(args.txid)
    if (existing != null) {
      const patches: Record<string, unknown> = { updated_at: args.now ?? new Date() }
      if (existing.rawTx == null) patches.raw_tx = Buffer.from(args.rawTx)
      if (args.inputBeef != null && existing.inputBeef == null) patches.input_beef = Buffer.from(args.inputBeef)
      if (args.batch != null && existing.batch == null) patches.batch = args.batch
      if (Object.keys(patches).length > 1) {
        await this.knex('transactions').where({ txid: existing.txid }).update(patches)
        const refreshed = await this.findByTxid(existing.txid)
        return { transaction: refreshed ?? existing, isNew: false }
      }
      return { transaction: existing, isNew: false }
    }

    const tx = await this.create({
      txid: args.txid,
      processing: args.processing ?? 'queued',
      rawTx: args.rawTx,
      inputBeef: args.inputBeef,
      batch: args.batch,
      now: args.now
    })
    return { transaction: tx, isNew: true }
  }

  /**
   * Bulk transition: attempt `transition` for each txid; returns the number of
   * rows that were successfully transitioned.
   *
   * The current state of each row is used as the expected source (lenient mode
   * — only the FSM is checked).
   */
  async transitionMany (args: {
    txids: string[]
    to: sdk.ProcessingStatus
    provider?: string
    providerStatus?: string
    details?: Record<string, unknown>
    now?: Date
  }): Promise<number> {
    const now = args.now ?? new Date()
    let updated = 0

    for (const txid of args.txids) {
      const row = await this.findByTxid(txid)
      if (row == null) continue
      const result = await this.transition({
        txid,
        expectedFrom: row.processing,
        to: args.to,
        provider: args.provider,
        providerStatus: args.providerStatus,
        details: args.details,
        now
      })
      if (result != null) updated++
    }

    return updated
  }

  /**
   * Atomically increment the `attempts` counter for one transaction and write
   * an `attempts.incremented` audit entry.
   */
  async incrementAttempts (
    txid: string,
    now?: Date
  ): Promise<TableTransactionNew | undefined> {
    const ts = now ?? new Date()
    const updated = await this.knex('transactions')
      .where({ txid })
      .increment('attempts', 1)
      .update({ updated_at: ts })
    if (updated === 0) return undefined
    await appendTxAudit(
      this.knex,
      { txid, event: 'attempts.incremented' },
      ts
    )
    return await this.findByTxid(txid)
  }

  /**
   * Record the outcome of a broadcast attempt. Transitions processing state,
   * updates `wasBroadcast` and `lastProvider*` columns, and writes an audit
   * row.
   */
  async recordBroadcastResult (args: {
    txid: string
    status: sdk.ProcessingStatus
    provider: string
    providerStatus?: string
    wasBroadcast?: boolean
    details?: Record<string, unknown>
    now?: Date
  }): Promise<TableTransactionNew | undefined> {
    const now = args.now ?? new Date()
    const current = await this.findByTxid(args.txid)
    if (current == null) return undefined

    const next = await this.transition({
      txid: args.txid,
      expectedFrom: current.processing,
      to: args.status,
      provider: args.provider,
      providerStatus: args.providerStatus,
      details: args.details,
      now
    })
    if (next == null) return undefined

    if (args.wasBroadcast === true && !next.wasBroadcast) {
      await this.knex('transactions')
        .where({ txid: args.txid })
        .update({ was_broadcast: true, updated_at: now })
    }

    return await this.findByTxid(args.txid)
  }

  /** Append a free-form history note to the audit log for a transaction. */
  async recordHistoryNote (
    txid: string,
    note: { what: string, [k: string]: unknown },
    now?: Date
  ): Promise<void> {
    const { what, ...rest } = note
    await appendTxAudit(
      this.knex,
      {
        txid,
        event: 'history.note',
        details: { what, ...rest }
      },
      now ?? new Date()
    )
  }

  /**
   * For each txid that exists in the transactions table, merge the raw
   * transaction bytes and (where available) the Merkle path into `beef`.
   * Txids not present are silently skipped.
   */
  async mergeBeefForTxids (beef: Beef, txids: string[]): Promise<void> {
    if (txids.length === 0) return
    const rows = await this.knex('transactions')
      .whereIn('txid', txids)
      .select('txid', 'raw_tx', 'merkle_path')

    for (const row of rows) {
      if (row.raw_tx != null) {
        const rawBytes = Array.from((row.raw_tx as Buffer).values())
        beef.mergeRawTx(rawBytes)
      }
      if (row.merkle_path != null) {
        const mp = MerklePath.fromBinary(Array.from((row.merkle_path as Buffer).values()))
        beef.mergeBump(mp)
      }
    }
  }

  /**
   * Collect broadcast-readiness info and a populated Beef for a list of
   * txids. Each entry is classified as:
   *  - `readyToSend`  — queued/sending/nonfinal → still needs broadcast
   *  - `alreadySent`  — sent/seen/seen_multi/unconfirmed/confirmed → already on network
   *  - `error`        — invalid/doubleSpend → terminal failure
   *  - `unknown`      — txid not found in the canonical transactions table
   */
  async collectReqsAndBeef (
    txids: string[],
    extraTxids?: string[]
  ): Promise<{
    beef: Beef
    details: Array<{
      txid: string
      status: 'readyToSend' | 'alreadySent' | 'error' | 'unknown'
      reason?: string
    }>
  }> {
    const beef = new Beef()
    const details: Array<{
      txid: string
      status: 'readyToSend' | 'alreadySent' | 'error' | 'unknown'
      reason?: string
    }> = []

    const allTxids = Array.from(new Set([...txids, ...(extraTxids ?? [])]))
    if (allTxids.length > 0) {
      const rows = await this.knex('transactions')
        .whereIn('txid', allTxids)
        .select('txid', 'processing', 'raw_tx', 'merkle_path')

      const rowByTxid = new Map<string, typeof rows[0]>()
      for (const row of rows) rowByTxid.set(row.txid, row)

      for (const txid of txids) {
        const row = rowByTxid.get(txid)
        if (row == null) {
          details.push({ txid, status: 'unknown' })
          continue
        }

        const p: sdk.ProcessingStatus = row.processing
        let status: 'readyToSend' | 'alreadySent' | 'error' | 'unknown'

        if (p === 'queued' || p === 'sending' || p === 'nonfinal') {
          status = 'readyToSend'
        } else if (p === 'sent' || p === 'seen' || p === 'seen_multi' || p === 'unconfirmed' || p === 'confirmed') {
          status = 'alreadySent'
        } else if (p === 'invalid' || p === 'doubleSpend') {
          status = 'error'
        } else {
          status = 'readyToSend'
        }

        details.push({ txid, status, reason: p })

        if (row.raw_tx != null) {
          beef.mergeRawTx(Array.from((row.raw_tx as Buffer).values()))
        }
        if (row.merkle_path != null) {
          const mp = MerklePath.fromBinary(Array.from((row.merkle_path as Buffer).values()))
          beef.mergeBump(mp)
        }
      }

      // Also merge extra txids that may be input ancestors.
      for (const txid of extraTxids ?? []) {
        const row = rowByTxid.get(txid)
        if (row == null) continue
        if (row.raw_tx != null) {
          beef.mergeRawTx(Array.from((row.raw_tx as Buffer).values()))
        }
        if (row.merkle_path != null) {
          const mp = MerklePath.fromBinary(Array.from((row.merkle_path as Buffer).values()))
          beef.mergeBump(mp)
        }
      }
    }

    return { beef, details }
  }

  /**
   * Paginated list of actions (per-user views of a transaction) with optional
   * status and label filters.
   *
   * JOIN is `actions a LEFT JOIN transactions t ON t.txid = a.txid` — LEFT
   * because unsigned drafts have `actions.txid IS NULL` and therefore no
   * matching `transactions` row.
   *
   * Label filtering uses `tx_labels_map.actionId` (the v3 layout).
   */
  async listActionsForUser (args: {
    userId: number
    statusFilter?: sdk.ProcessingStatus[]
    labelIds?: number[]
    labelQueryMode?: 'all' | 'any'
    createdAtFrom?: Date
    createdAtTo?: Date
    limit: number
    offset: number
  }): Promise<{
    rows: Array<TableAction & { processing?: sdk.ProcessingStatus, height?: number }>
    total?: number
  }> {
    let q = this.knex('actions as a')
      .leftJoin('transactions as t', 't.txid', 'a.txid')
      .where('a.userId', args.userId)
      .where('a.hidden', false)

    if (args.statusFilter != null && args.statusFilter.length > 0) {
      // statusFilter excludes draft (NULL-txid) rows since they have no
      // matching transactions row.
      q = q.whereIn('t.processing', args.statusFilter)
    }

    if (args.createdAtFrom != null) {
      // IDB path uses >= for `from` (inclusive); mirror that here.
      q = q.where('a.created_at', '>=', args.createdAtFrom)
    }
    if (args.createdAtTo != null) {
      // IDB path uses EXCLUSIVE `to` semantics:
      //   r.created_at.getTime() >= args.to.getTime() → exclude
      // Mirror that: exclude rows where created_at >= createdAtTo (use '<' not '<=').
      q = q.where('a.created_at', '<', args.createdAtTo)
    }

    // Label filtering via tx_labels_map.actionId (v3 layout).
    if (args.labelIds != null && args.labelIds.length > 0) {
      if (args.labelQueryMode === 'all') {
        // Must have ALL specified labels
        for (const labelId of args.labelIds) {
          q = q.whereExists(
            this.knex('tx_labels_map as lm')
              .where('lm.actionId', this.knex.ref('a.actionId'))
              .where('lm.txLabelId', labelId)
              .whereNot('lm.isDeleted', true)
              .select(this.knex.raw('1'))
          )
        }
      } else {
        // Default: 'any' — must have at least one of the labels
        q = q.whereExists(
          this.knex('tx_labels_map as lm')
            .where('lm.actionId', this.knex.ref('a.actionId'))
            .whereIn('lm.txLabelId', args.labelIds)
            .whereNot('lm.isDeleted', true)
            .select(this.knex.raw('1'))
        )
      }
    }

    const countQuery = q.clone().count<{ c: number }>({ c: 'a.actionId' }).first()
    const rowsQuery = q
      .orderBy('a.created_at', 'desc')
      .orderBy('a.actionId', 'asc')
      .limit(args.limit)
      .offset(args.offset)
      .select(
        'a.actionId',
        'a.userId',
        'a.txid',
        'a.reference',
        'a.description',
        'a.isOutgoing',
        'a.satoshis_delta',
        'a.version',
        'a.lockTime',
        'a.user_nosend',
        'a.hidden',
        'a.user_aborted',
        'a.raw_tx_draft',
        'a.input_beef_draft',
        'a.notify_json',
        'a.row_version',
        'a.created_at',
        'a.updated_at',
        't.processing as t_processing',
        't.height as t_height'
      )
    const [countRow, rows] = await Promise.all([countQuery, rowsQuery])
    const total = countRow != null ? Number(countRow.c) : undefined

    const mapped = rows.map((row: any) => ({
      actionId: row.actionId,
      userId: row.userId,
      txid: row.txid ?? undefined,
      reference: row.reference,
      description: row.description,
      isOutgoing: !!row.isOutgoing,
      satoshisDelta: row.satoshis_delta,
      version: row.version ?? undefined,
      lockTime: row.lockTime ?? undefined,
      userNosend: !!row.user_nosend,
      hidden: !!row.hidden,
      userAborted: !!row.user_aborted,
      rawTxDraft: row.raw_tx_draft != null ? Array.from((row.raw_tx_draft as Buffer).values()) : undefined,
      inputBeefDraft: row.input_beef_draft != null ? Array.from((row.input_beef_draft as Buffer).values()) : undefined,
      notifyJson: row.notify_json ?? undefined,
      rowVersion: row.row_version,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      processing: row.t_processing != null ? (row.t_processing as sdk.ProcessingStatus) : undefined,
      height: row.t_height ?? undefined
    }))

    return { rows: mapped, total }
  }

  /**
   * Paginated list of outputs with their backing transaction processing state.
   *
   * JOIN is `outputs o JOIN actions a ON a.actionId = o.actionId LEFT JOIN
   * transactions t ON t.txid = a.txid`. The LEFT join on transactions allows
   * outputs created by unsigned drafts (`actions.txid IS NULL`) to surface
   * with no `processing` value.
   *
   * Optional filters: basket, tag set, processing state, spent flag.
   */
  async listOutputsForUser (args: {
    userId: number
    basketId?: number
    tagIds?: number[]
    tagQueryMode?: 'all' | 'any'
    processingFilter: sdk.ProcessingStatus[]
    includeSpent: boolean
    limit: number
    offset: number
    includeLockingScripts?: boolean
  }): Promise<{
    rows: Array<TableOutput & { processing?: sdk.ProcessingStatus }>
    total?: number
  }> {
    let q = this.knex('outputs as o')
      .join('actions as a', 'a.actionId', 'o.actionId')
      .leftJoin('transactions as t', 't.txid', 'a.txid')
      .where('o.userId', args.userId)

    if (args.processingFilter.length > 0) {
      q = q.whereIn('t.processing', args.processingFilter)
    }

    if (!args.includeSpent) {
      q = q.whereNull('o.spentByActionId')
    }

    if (args.basketId != null) {
      q = q.where('o.basketId', args.basketId)
    }

    // Tag filtering via output_tags_map
    if (args.tagIds != null && args.tagIds.length > 0) {
      if (args.tagQueryMode === 'all') {
        for (const tagId of args.tagIds) {
          q = q.whereExists(
            this.knex('output_tags_map as otm')
              .where('otm.outputId', this.knex.ref('o.outputId'))
              .where('otm.outputTagId', tagId)
              .whereNot('otm.isDeleted', true)
              .select(this.knex.raw('1'))
          )
        }
      } else {
        q = q.whereExists(
          this.knex('output_tags_map as otm')
            .where('otm.outputId', this.knex.ref('o.outputId'))
            .whereIn('otm.outputTagId', args.tagIds)
            .whereNot('otm.isDeleted', true)
            .select(this.knex.raw('1'))
        )
      }
    }

    const columns: any[] = [
      'o.outputId',
      'o.userId',
      'o.actionId',
      'o.basketId',
      'o.spendable',
      'o.change',
      'o.outputDescription',
      'o.vout',
      'o.satoshis',
      'o.providedBy',
      'o.purpose',
      'o.type',
      'o.txid',
      'o.senderIdentityKey',
      'o.derivationPrefix',
      'o.derivationSuffix',
      'o.customInstructions',
      'o.spentByActionId',
      'o.sequenceNumber',
      'o.spendingDescription',
      'o.scriptLength',
      'o.scriptOffset',
      'o.created_at',
      'o.updated_at',
      't.processing as t_processing'
    ]
    if (args.includeLockingScripts === true) {
      columns.push('o.lockingScript')
    }

    const countQuery = q.clone().count<{ c: number }>({ c: 'o.outputId' }).first()
    const rowsQuery = q
      .orderBy('o.outputId', 'asc')
      .limit(args.limit)
      .offset(args.offset)
      .select(columns)
    const [countRow, rows] = await Promise.all([countQuery, rowsQuery])
    const total = countRow != null ? Number(countRow.c) : undefined

    const mapped = rows.map((row: any) => {
      const out: TableOutput & { processing?: sdk.ProcessingStatus } = {
        outputId: row.outputId,
        userId: row.userId,
        // TableOutput's `transactionId` interface field carries the FK to
        // `actions.actionId` post-v3.
        transactionId: row.actionId,
        basketId: row.basketId ?? undefined,
        spendable: !!row.spendable,
        change: !!row.change,
        outputDescription: row.outputDescription,
        vout: row.vout,
        satoshis: row.satoshis,
        providedBy: row.providedBy,
        purpose: row.purpose,
        type: row.type,
        txid: row.txid ?? undefined,
        senderIdentityKey: row.senderIdentityKey ?? undefined,
        derivationPrefix: row.derivationPrefix ?? undefined,
        derivationSuffix: row.derivationSuffix ?? undefined,
        customInstructions: row.customInstructions ?? undefined,
        spentBy: row.spentByActionId ?? undefined,
        sequenceNumber: row.sequenceNumber ?? undefined,
        spendingDescription: row.spendingDescription ?? undefined,
        scriptLength: row.scriptLength ?? undefined,
        scriptOffset: row.scriptOffset ?? undefined,
        lockingScript: args.includeLockingScripts === true && row.lockingScript != null
          ? Array.from((row.lockingScript as Buffer).values())
          : undefined,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        processing: row.t_processing != null ? (row.t_processing as sdk.ProcessingStatus) : undefined
      }
      return out
    })

    return { rows: mapped, total }
  }

  /**
   * @deprecated v3 schema no-op. Retained for back-compat callers that ran
   * the legacy cutover path. `tx_labels_map` no longer carries a
   * `transactionId` column — it is keyed directly by `actionId` from the
   * outset, so there is nothing to repoint.
   */
  async repointLabelsToActionId (
    _legacyTransactionId: number,
    _actionId: number,
    _now?: Date
  ): Promise<void> {
    // intentionally empty — v3 stores `tx_labels_map.actionId` directly.
  }
}
