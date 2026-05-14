import { Beef, MerklePath } from '@bsv/sdk'
import { Knex } from 'knex'
import * as sdk from '../../sdk'
import { TableAction, TableOutput, TableTransactionNew } from './tables'
import {
  findAction,
  findTransactionNew,
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
 * High-level service over the new-schema storage primitives.
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

  async findById (transactionId: number): Promise<TableTransactionNew | undefined> {
    return await findTransactionNew(this.knex, transactionId)
  }

  /**
   * Insert a new new transaction row. The row is created in `queued` state
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
    const row: Omit<TableTransactionNew, 'transactionId' | 'created_at' | 'updated_at'> = {
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
    const id = await insertTransactionNew(this.knex, row, now)
    await auditProcessingTransition(this.knex, id, row.processing, row.processing, { reason: 'create' }, now)
    const stored = await this.findById(id)
    if (stored == null) throw new Error(`new transaction ${id} disappeared after insert`)
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
  }): Promise<TableTransactionNew | undefined> {
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
   *  - Transitions processing to `confirmed` from any spendable-class state.
   *  - Writes a `proof.acquired` audit row.
   *
   * The merkle leaf index is derived from `merklePath` (BUMP) using the row's
   * `txid`; callers do not pass it.
   */
  async recordProof (args: {
    transactionId: number
    height: number
    merklePath: number[]
    merkleRoot: string
    blockHash: string
    expectedFrom: sdk.ProcessingStatus
    now?: Date
  }): Promise<TableTransactionNew | undefined> {
    const now = args.now ?? new Date()
    const existing = await this.findById(args.transactionId)
    if (existing == null) return undefined
    const merkleIndex = indexFromMerklePath(args.merklePath, existing.txid)
    const next = await this.transition({
      transactionId: args.transactionId,
      expectedFrom: args.expectedFrom,
      to: 'confirmed',
      details: { source: 'recordProof', height: args.height },
      now
    })
    if (next == null) return undefined
    await this.knex('transactions').where({ transactionId: args.transactionId }).update({
      height: args.height,
      merkle_index: merkleIndex,
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

  // -----------------------
  // Net-new methods (§3)
  // -----------------------

  /**
   * #1 — Look up an action + its backing transaction by (userId, reference).
   */
  async findActionByReference (
    userId: number,
    reference: string
  ): Promise<{ action: TableAction, transaction: TableTransactionNew } | undefined> {
    const actionRow = await this.knex('actions').where({ userId, reference }).first()
    if (actionRow == null) return undefined
    const action = mapActionRow(actionRow)
    const tx = await this.findById(action.transactionId)
    if (tx == null) return undefined
    return { action, transaction: tx }
  }

  /**
   * #2 — Look up an action + its backing transaction by (userId, txid).
   */
  async findActionByUserTxid (
    userId: number,
    txid: string
  ): Promise<{ action: TableAction, transaction: TableTransactionNew } | undefined> {
    const txRow = await this.knex('transactions').where({ txid }).first()
    if (txRow == null) return undefined
    const tx = mapTransactionRow(txRow)
    const actionRow = await this.knex('actions')
      .where({ userId, transactionId: tx.transactionId })
      .first()
    if (actionRow == null) return undefined
    return { action: mapActionRow(actionRow), transaction: tx }
  }

  /**
   * #3 — Upsert: find existing action for (userId, txid) or create both the new
   * transaction row and the action row.
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
    // Try to find existing transaction
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
        await this.knex('transactions').where({ transactionId: tx.transactionId }).update(patches)
        const refreshed = await this.findById(tx.transactionId)
        if (refreshed != null) tx = refreshed
      }
    }

    // Find or create the action for this user.
    let actionRow = await this.knex('actions')
      .where({ userId: args.userId, transactionId: tx.transactionId })
      .first()

    if (actionRow == null) {
      await insertAction(
        this.knex,
        {
          userId: args.userId,
          transactionId: tx.transactionId,
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
        .where({ userId: args.userId, transactionId: tx.transactionId })
        .first()
      isNew = true
    }

    return { action: mapActionRow(actionRow), transaction: tx, isNew }
  }

  /**
   * #4 — Atomically update the satoshisDelta column on an action row.
   */
  async updateActionSatoshisDelta (
    actionId: number,
    delta: number,
    now?: Date
  ): Promise<void> {
    await this.knex('actions')
      .where({ actionId })
      .update({ satoshis_delta: delta, updated_at: now ?? new Date() })
  }

  /**
   * #5 — Create a new transaction row already in `confirmed` state with all proof
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
    const row: Omit<TableTransactionNew, 'transactionId' | 'created_at' | 'updated_at'> = {
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
    const id = await insertTransactionNew(this.knex, row, now)
    await auditProcessingTransition(this.knex, id, 'confirmed', 'confirmed', { reason: 'createWithProof' }, now)
    const stored = await this.findById(id)
    if (stored == null) throw new Error(`new transaction ${id} disappeared after createWithProof insert`)
    return stored
  }

  /**
   * #6 — Find an existing new transaction row for the given txid (suitable for
   * the broadcast queue) or create a new one in `queued` state.
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
      // Patch rawTx / batch if the row was previously created without them.
      const patches: Record<string, unknown> = { updated_at: args.now ?? new Date() }
      if (existing.rawTx == null) patches.raw_tx = Buffer.from(args.rawTx)
      if (args.inputBeef != null && existing.inputBeef == null) patches.input_beef = Buffer.from(args.inputBeef)
      if (args.batch != null && existing.batch == null) patches.batch = args.batch
      if (Object.keys(patches).length > 1) {
        await this.knex('transactions').where({ transactionId: existing.transactionId }).update(patches)
        const refreshed = await this.findById(existing.transactionId)
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
   * #7 — Bulk transition: attempt `transition` for each id; collect results.
   * When `expectedFrom` is omitted the current state of each row is used as
   * the expected source (lenient mode — only the FSM is checked).
   */
  async transitionMany (args: {
    transactionIds: number[]
    expectedFrom?: sdk.ProcessingStatus
    to: sdk.ProcessingStatus
    provider?: string
    providerStatus?: string
    details?: Record<string, unknown>
    now?: Date
  }): Promise<{ updated: number[], skipped: number[] }> {
    const updated: number[] = []
    const skipped: number[] = []
    const now = args.now ?? new Date()

    for (const id of args.transactionIds) {
      let expectedFrom = args.expectedFrom
      if (expectedFrom == null) {
        const row = await this.findById(id)
        if (row == null) { skipped.push(id); continue }
        expectedFrom = row.processing
      }
      const result = await this.transition({
        transactionId: id,
        expectedFrom,
        to: args.to,
        provider: args.provider,
        providerStatus: args.providerStatus,
        details: args.details,
        now
      })
      if (result != null) {
        updated.push(id)
      } else {
        skipped.push(id)
      }
    }

    return { updated, skipped }
  }

  /**
   * #8 — Bulk-set the `batch` column for a list of transaction ids.
   * Pass `undefined` to clear the batch tag.
   */
  async setBatch (
    transactionIds: number[],
    batch: string | undefined,
    now?: Date
  ): Promise<void> {
    if (transactionIds.length === 0) return
    await this.knex('transactions')
      .whereIn('transactionId', transactionIds)
      .update({ batch: batch ?? null, updated_at: now ?? new Date() })
  }

  /**
   * #9 — Atomically increment the `attempts` counter for one transaction and
   * write an `attempts.incremented` audit entry.
   */
  async incrementAttempts (
    transactionId: number,
    now?: Date
  ): Promise<TableTransactionNew | undefined> {
    const ts = now ?? new Date()
    const updated = await this.knex('transactions')
      .where({ transactionId })
      .increment('attempts', 1)
      .update({ updated_at: ts })
    if (updated === 0) return undefined
    await appendTxAudit(
      this.knex,
      { transactionId, event: 'attempts.incremented' },
      ts
    )
    return await this.findById(transactionId)
  }

  /**
   * #10 — Record the outcome of a broadcast attempt. Transitions processing
   * state, updates `wasBroadcast` and `lastProvider*` columns, and writes an
   * audit row.
   */
  async recordBroadcastResult (args: {
    transactionId: number
    txid: string
    status: sdk.ProcessingStatus
    provider: string
    providerStatus?: string
    wasBroadcast?: boolean
    details?: Record<string, unknown>
    now?: Date
  }): Promise<TableTransactionNew | undefined> {
    const now = args.now ?? new Date()
    const current = await this.findById(args.transactionId)
    if (current == null) return undefined

    const next = await this.transition({
      transactionId: args.transactionId,
      expectedFrom: current.processing,
      to: args.status,
      provider: args.provider,
      providerStatus: args.providerStatus,
      details: args.details,
      now
    })
    if (next == null) return undefined

    // Update wasBroadcast if the broadcast actually reached the network.
    if (args.wasBroadcast === true && !next.wasBroadcast) {
      await this.knex('transactions')
        .where({ transactionId: args.transactionId })
        .update({ was_broadcast: true, updated_at: now })
    }

    return await this.findById(args.transactionId)
  }

  /**
   * #11 — Append a free-form history note to the audit log for a transaction.
   */
  async recordHistoryNote (
    transactionId: number,
    note: { what: string, [k: string]: unknown },
    now?: Date
  ): Promise<void> {
    const { what, ...rest } = note
    await appendTxAudit(
      this.knex,
      {
        transactionId,
        event: 'history.note',
        details: { what, ...rest }
      },
      now ?? new Date()
    )
  }

  /**
   * #12 — For each txid that exists in the new transactions table, merge the
   * raw transaction bytes and (where available) the Merkle path into `beef`.
   * Txids not present in new-schema are silently skipped.
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
   * #13 — Collect broadcast-readiness info and a populated Beef for a list of
   * txids. Each entry is classified as:
   *  - `readyToSend`  — queued/sending → still needs broadcast
   *  - `alreadySent`  — sent/seen/seen_multi/unconfirmed/confirmed → already on network
   *  - `error`        — invalid/doubleSpend → terminal failure
   *  - `unknown`      — not found in new-schema
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

        // Merge raw tx + proof bytes for txids that have them.
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
   * #14 — Paginated list of actions (per-user transaction views) with optional
   * status and label filters.
   *
   * After the the schema cutover `tx_labels_map.transactionId` references `actions.actionId`
   * (not `transactions.transactionId`).
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
    rows: Array<TableAction & { txid: string, processing: sdk.ProcessingStatus, height?: number }>
    total?: number
  }> {
    let q = this.knex('actions as a')
      .join('transactions as t', 't.transactionId', 'a.transactionId')
      .where('a.userId', args.userId)
      .where('a.hidden', false)

    if (args.statusFilter != null && args.statusFilter.length > 0) {
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

    // Label filtering via tx_labels_map (post-cutover: transactionId = actionId)
    if (args.labelIds != null && args.labelIds.length > 0) {
      if (args.labelQueryMode === 'all') {
        // Must have ALL specified labels
        for (const labelId of args.labelIds) {
          q = q.whereExists(
            this.knex('tx_labels_map as lm')
              .where('lm.transactionId', this.knex.ref('a.actionId'))
              .where('lm.txLabelId', labelId)
              .whereNot('lm.isDeleted', true)
              .select(this.knex.raw('1'))
          )
        }
      } else {
        // Default: 'any' — must have at least one of the labels
        q = q.whereExists(
          this.knex('tx_labels_map as lm')
            .where('lm.transactionId', this.knex.ref('a.actionId'))
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
        'a.transactionId',
        'a.reference',
        'a.description',
        'a.isOutgoing',
        'a.satoshis_delta',
        'a.user_nosend',
        'a.hidden',
        'a.user_aborted',
        'a.notify_json',
        'a.row_version',
        'a.created_at',
        'a.updated_at',
        't.txid',
        't.processing',
        't.height'
      )
    const [countRow, rows] = await Promise.all([countQuery, rowsQuery])
    const total = countRow != null ? Number(countRow.c) : undefined

    const mapped = rows.map((row: any) => ({
      actionId: row.actionId,
      userId: row.userId,
      transactionId: row.transactionId,
      reference: row.reference,
      description: row.description,
      isOutgoing: !!row.isOutgoing,
      satoshisDelta: row.satoshis_delta,
      userNosend: !!row.user_nosend,
      hidden: !!row.hidden,
      userAborted: !!row.user_aborted,
      notifyJson: row.notify_json ?? undefined,
      rowVersion: row.row_version,
      created_at: new Date(row.created_at),
      updated_at: new Date(row.updated_at),
      txid: row.txid,
      processing: row.processing as sdk.ProcessingStatus,
      height: row.height ?? undefined
    }))

    return { rows: mapped, total }
  }

  /**
   * #15 — Paginated list of outputs with their backing transaction processing
   * state. Optional filters: basket, tag set, processing state, spent flag.
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
    rows: Array<TableOutput & { processing: sdk.ProcessingStatus }>
    total?: number
  }> {
    let q = this.knex('outputs as o')
      .join('transactions as t', 't.transactionId', 'o.transactionId')
      .where('o.userId', args.userId)

    if (args.processingFilter.length > 0) {
      q = q.whereIn('t.processing', args.processingFilter)
    }

    if (!args.includeSpent) {
      q = q.whereNull('o.spentBy')
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

    const columns = [
      'o.outputId',
      'o.userId',
      'o.transactionId',
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
      'o.spentBy',
      'o.sequenceNumber',
      'o.spendingDescription',
      'o.scriptLength',
      'o.scriptOffset',
      'o.created_at',
      'o.updated_at',
      't.processing'
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
      const out: TableOutput & { processing: sdk.ProcessingStatus } = {
        outputId: row.outputId,
        userId: row.userId,
        transactionId: row.transactionId,
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
        spentBy: row.spentBy ?? undefined,
        sequenceNumber: row.sequenceNumber ?? undefined,
        spendingDescription: row.spendingDescription ?? undefined,
        scriptLength: row.scriptLength ?? undefined,
        scriptOffset: row.scriptOffset ?? undefined,
        lockingScript: args.includeLockingScripts === true && row.lockingScript != null
          ? Array.from((row.lockingScript as Buffer).values())
          : undefined,
        created_at: new Date(row.created_at),
        updated_at: new Date(row.updated_at),
        processing: row.processing as sdk.ProcessingStatus
      }
      return out
    })

    return { rows: mapped, total }
  }

  /**
   * Post-cutover helper: rewrite `tx_labels_map.transactionId` rows that were
   * written with the legacy transactionId (before the real txid + actionId were
   * known) so that they now point at the new-schema `actions.actionId`.
   *
   * Call this once per new outgoing transaction immediately after
   * `findOrCreateActionForTxid` resolves the actionId.
   *
   * This is a no-op when:
   *  - `legacyTransactionId` has no rows in `tx_labels_map` (no labels on the tx)
   *  - `legacyTransactionId === actionId` (should not happen in practice but
   *    is safe to call anyway)
   */
  async repointLabelsToActionId (
    legacyTransactionId: number,
    actionId: number,
    now?: Date
  ): Promise<void> {
    if (legacyTransactionId === actionId) return
    const ts = now ?? new Date()
    await this.knex('tx_labels_map')
      .where({ transactionId: legacyTransactionId })
      .update({ transactionId: actionId, updated_at: ts })
  }

  /**
   * After `processAction` creates the new `transactions` row, remap
   * `outputs.transactionId` and `outputs.spentBy` from the bridge-period
   * `transactions_legacy.transactionId` to the real `transactions.transactionId`.
   *
   * During `createAction`, new outputs are inserted with `transactionId =
   * legacyTransactionId` (bypassing FK constraints). `listActionsKnex` queries
   * outputs by new transactionId, so without this remap the outputs would be
   * invisible to `listActions`.
   *
   * This is a no-op when `legacyTransactionId === newTransactionId`.
   */
  async repointOutputsToNewTransactionId (
    legacyTransactionId: number,
    newTransactionId: number,
    now?: Date
  ): Promise<void> {
    if (legacyTransactionId === newTransactionId) return
    const ts = now ?? new Date()
    // Remap outputs.transactionId (the new-schema FK for "which tx created this output")
    await this.knex('outputs')
      .where({ transactionId: legacyTransactionId })
      .update({ transactionId: newTransactionId, updated_at: ts })
    // Remap outputs.spentBy (the new-schema FK for "which tx spent this output")
    await this.knex('outputs')
      .where({ spentBy: legacyTransactionId })
      .update({ spentBy: newTransactionId, updated_at: ts })
    // Remap commissions.transactionId
    await this.knex('commissions')
      .where({ transactionId: legacyTransactionId })
      .update({ transactionId: newTransactionId, updated_at: ts })
  }
}
