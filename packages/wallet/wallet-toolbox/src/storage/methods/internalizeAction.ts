import {
  Transaction as BsvTransaction,
  WalletPayment,
  BasketInsertion,
  InternalizeActionArgs,
  TransactionOutput,
  Beef,
  BeefTx,
  MerklePath,
  Validation,
  Utils
} from '@bsv/sdk'
import { GetReqsAndBeefResult, shareReqsWithWorld } from './processAction'
import { StorageProvider } from '../StorageProvider'
import { AuthId, StorageInternalizeActionResult, StorageProvenOrReq } from '../../sdk/WalletStorage.interfaces'
import { TableOutput } from '../schema/tables/TableOutput'
import { TableOutputBasket } from '../schema/tables/TableOutputBasket'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { randomBytesBase64, verifyId, verifyOne, verifyOneOrNone } from '../../utility/utilityHelpers'
import { TransactionStatus } from '../../sdk/types'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { blockHash } from '../../services/chaintracker/chaintracks/util/blockHeaderUtilities'
import { TableProvenTx } from '../schema/tables/TableProvenTx'
import { isManagedChangeOutput } from './managedChange'

/**
 * Record of a spent-input transition this internalize call performed.
 * Carries enough state to roll back the exact change via
 * {@link restoreInputsToSpendable}: which row, and whether we touched
 * `spentBy` (only true for rows owned by the internalizing user).
 */
export interface SpentInputTransition {
  outputId: number
  /** true if the call set spentBy; false if only spendable was flipped. */
  setSpentBy: boolean
}

/**
 * Mark every storage row at each consumed-input outpoint as spent — across
 * all users that track that outpoint. An on-chain spend invalidates the UTXO
 * for every wallet that references it, not just the wallet that called
 * `internalizeAction`. Returns the per-row transitions so the caller can
 * roll back via {@link restoreInputsToSpendable} on broadcast failure.
 *
 * Cross-user semantics:
 *   - For rows owned by `userId` (the internalizing user) we also set
 *     `spentBy=transactionId`. They own the corresponding transaction
 *     record; the FK target exists in their scope.
 *   - For rows owned by other users we set `spendable=false` and leave
 *     `spentBy` untouched. `spentBy` references the owning user's
 *     `transactions.transactionId`, and that user has no record of our
 *     transaction yet — they'd need to internalize it themselves to get
 *     one. Leaving `spentBy` undefined keeps the field consistent with
 *     "this UTXO is spent, but my wallet didn't witness the spend".
 *
 * Mirrors what `createAction` does for wallet-originated transactions and
 * what `TaskUnFail.unfailReq` does when reviving a previously-failed tx.
 * Without this, an externally-broadcast tx that consumed user UTXOs would
 * leave those UTXOs as phantom spendable rows, picked up by subsequent
 * `createAction` fund selection.
 *
 * Idempotent: rows already `spendable=false` are skipped. Rows already
 * `spentBy` a different transaction are also skipped (a competing spend
 * has been recorded; do not overwrite).
 */
export async function markUserInputsSpent (
  storage: StorageProvider,
  userId: number,
  tx: BsvTransaction,
  transactionId: number
): Promise<SpentInputTransition[]> {
  const outpoints = tx.inputs
    .map(i => ({ txid: i.sourceTXID ?? '', vout: i.sourceOutputIndex ?? 0 }))
    .filter(o => o.txid !== '')
  if (outpoints.length === 0) return []
  const transitioned: SpentInputTransition[] = []
  await storage.transaction(async trx => {
    for (const op of outpoints) {
      const matches = await storage.findOutputs({
        partial: { txid: op.txid, vout: op.vout },
        noScript: true,
        trx
      })
      for (const o of matches) {
        if (!o.spendable) continue
        if (o.spentBy != null && o.spentBy !== transactionId) continue
        const setSpentBy = o.userId === userId
        const update: Partial<TableOutput> = setSpentBy
          ? { spendable: false, spentBy: transactionId }
          : { spendable: false }
        await storage.updateOutput(verifyId(o.outputId), update, trx)
        transitioned.push({ outputId: verifyId(o.outputId), setSpentBy })
      }
    }
  })
  return transitioned
}

/**
 * Revert the spendable=true → false transitions performed by
 * {@link markUserInputsSpent}. Used when an internalize call's downstream
 * broadcast fails non-fatally so the caller can retry with the same UTXOs.
 *
 * Only undoes what was changed: `spendable=true` always; `spentBy=undefined`
 * only when the original transition set it. Avoids clobbering a competing
 * spent-by on cross-user rows.
 *
 * The downstream `attemptToPostReqsToNetwork` path also calls
 * `updateTransactionStatus('failed')` on doubleSpend/invalidTx outcomes,
 * which independently restores same-user inputs (via
 * `EntityTransaction.getInputs` filtered by userId). This explicit rollback
 * covers cross-user rows and any path where the downstream restore did not
 * run, and is a no-op when the downstream restore already happened.
 */
export async function restoreInputsToSpendable (
  storage: StorageProvider,
  transitions: SpentInputTransition[]
): Promise<void> {
  if (transitions.length === 0) return
  await storage.transaction(async trx => {
    for (const t of transitions) {
      const update: Partial<TableOutput> = t.setSpentBy
        ? { spendable: true, spentBy: undefined }
        : { spendable: true }
      await storage.updateOutput(verifyId(t.outputId), update, trx)
    }
  })
}

/**
 * Internalize Action allows a wallet to take ownership of outputs in a pre-existing transaction.
 * The transaction may, or may not already be known to both the storage and user.
 *
 * Two types of outputs are handled: "wallet payments" and "basket insertions".
 *
 * A "basket insertion" output is considered a custom output and has no effect on the wallet's "balance".
 *
 * A "wallet payment" adds an outputs value to the wallet's change "balance". These outputs are assigned to the "default" basket.
 *
 * Processing starts with simple validation and then checks for a pre-existing transaction.
 * If the transaction is already known to the user, then the outputs are reviewed against the existing outputs treatment,
 * and merge rules are added to the arguments passed to the storage layer.
 *
 * The existing transaction's `status` determines what the merge path does next:
 *  - `'unproven'`, `'completed'`, or `'sending'`: outputs are merged into the existing record. The transaction status is left as-is.
 *    The `'sending'` case covers a transaction this wallet already signed and handed to broadcast processing, but
 *    whose proven_tx_req has not yet been advanced by the normal monitor/posting flow.
 *  - `'nosend'`: an ambiguous case. The transaction was created with `noSend: true` and may have been externally
 *    broadcast, may be sitting in a sendWith chain, or may be stuck mid-flight. The merge path treats the
 *    `internalizeAction` call as explicit authorization to advance the lifecycle. Specifically: `transactions.status`
 *    is promoted to `'completed'` (when a BUMP is included in the BEEF) or `'unproven'` (otherwise), and the
 *    `proven_tx_req` is moved out of `'nosend'` so Monitor's standard proof-fetching flow can finalize it.
 *    This makes the `internalizeAction` semantics consistent regardless of whether the originator shares the
 *    same storage as the internalizer or not.
 *  - Any other status: an error.
 *
 * When the transaction already exists, the description is updated. The isOutgoing sense is not changed.
 *
 * "basket insertion" Merge Rules:
 * 1. The "default" basket may not be specified as the insertion basket.
 * 2. Managed change may not be reclassified as a basket insertion.
 * 3. Basket insertions do not affect wallet balance and are typed "custom".
 *
 * "wallet payment" Merge Rules:
 * 1. Targeting an existing managed output is idempotent.
 * 2. Targeting an existing custom output converts it to managed BRC-29
 *    change and increases wallet balance. This includes verified recovery of
 *    a legacy custom row that was incorrectly placed in the default basket.
 */
export async function internalizeAction (
  storage: StorageProvider,
  auth: AuthId,
  args: InternalizeActionArgs
): Promise<StorageInternalizeActionResult> {
  const ctx = new InternalizeActionContext(storage, auth, args)
  await ctx.asyncSetup()

  if (ctx.isMerge) await ctx.mergedInternalize()
  else await ctx.newInternalize()

  return ctx.r
}

interface BasketInsertionX extends BasketInsertion {
  /** incoming transaction output index */
  vout: number
  /** incoming transaction output */
  txo: TransactionOutput
  /** if valid, corresponding storage output  */
  eo?: TableOutput
}

interface WalletPaymentX extends WalletPayment {
  /** incoming transaction output index */
  vout: number
  /** incoming transaction output */
  txo: TransactionOutput
  /** if valid, corresponding storage output  */
  eo?: TableOutput
  /** corresponds to an existing change output */
  ignore: boolean
}

class InternalizeActionContext {
  /** result to be returned */
  r: StorageInternalizeActionResult
  /** the parsed input AtomicBEEF */
  ab: Beef
  /** the incoming transaction extracted from AtomicBEEF */
  tx: BsvTransaction
  /** the user's change basket */
  changeBasket: TableOutputBasket
  /** cached baskets referenced by basket insertions */
  baskets: Record<string, TableOutputBasket>
  /** existing storage transaction for this txid and userId */
  etx?: TableTransaction
  /** existing outputs */
  eos: TableOutput[]
  /** all the basket insertions from incoming outputs array */
  basketInsertions: BasketInsertionX[]
  /** all the wallet payments from incoming outputs array */
  walletPayments: WalletPaymentX[]
  /** outputs this call transitioned spendable=true → false (for rollback) */
  spentInputs: SpentInputTransition[]
  userId: number
  vargs: Validation.ValidInternalizeActionArgs

  constructor (
    public storage: StorageProvider,
    public auth: AuthId,
    public args: InternalizeActionArgs
  ) {
    this.vargs = Validation.validateInternalizeActionArgs(args)
    this.userId = auth.userId!
    this.r = {
      accepted: true,
      isMerge: false,
      txid: '',
      satoshis: 0
    }
    this.ab = new Beef()
    this.tx = new BsvTransaction()
    this.changeBasket = {} as TableOutputBasket
    this.baskets = {}
    this.basketInsertions = []
    this.walletPayments = []
    this.eos = []
    this.spentInputs = []
  }

  get isMerge (): boolean {
    return this.r.isMerge
  }

  set isMerge (v: boolean) {
    this.r.isMerge = v
  }

  get txid (): string {
    return this.r.txid
  }

  set txid (v: string) {
    this.r.txid = v
  }

  get satoshis (): number {
    return this.r.satoshis
  }

  set satoshis (v: number) {
    this.r.satoshis = v
  }

  async getBasket (basketName: string): Promise<TableOutputBasket> {
    if (basketName === 'default') {
      throw new WERR_INVALID_PARAMETER('insertionRemittance.basket', 'a non-default basket')
    }
    let b = this.baskets[basketName]
    if (b) return b
    b = await this.storage.findOrInsertOutputBasket(this.userId, basketName)
    this.baskets[basketName] = b
    return b
  }

  async asyncSetup () {
    ;({ ab: this.ab, tx: this.tx, txid: this.txid } = await this.validateAtomicBeef(this.args.tx))

    for (const o of this.args.outputs) {
      if (o.outputIndex < 0 || o.outputIndex >= this.tx.outputs.length) {
        throw new WERR_INVALID_PARAMETER(
          'outputIndex',
          `a valid output index in range 0 to ${this.tx.outputs.length - 1}`
        )
      }
      const txo = this.tx.outputs[o.outputIndex]
      switch (o.protocol) {
        case 'basket insertion':
          if ((o.insertionRemittance == null) || (o.paymentRemittance != null)) { throw new WERR_INVALID_PARAMETER('basket insertion', 'valid insertionRemittance and no paymentRemittance') }
          if (o.insertionRemittance.basket === 'default') {
            throw new WERR_INVALID_PARAMETER('insertionRemittance.basket', 'a non-default basket')
          }
          this.basketInsertions.push({
            ...o.insertionRemittance,
            txo,
            vout: o.outputIndex
          })
          break
        case 'wallet payment':
          if (o.insertionRemittance || (o.paymentRemittance == null)) { throw new WERR_INVALID_PARAMETER('wallet payment', 'valid paymentRemittance and no insertionRemittance') }
          this.walletPayments.push({
            ...o.paymentRemittance,
            txo,
            vout: o.outputIndex,
            ignore: false
          })
          break
        default:
          throw new WERR_INTERNAL(`unexpected protocol ${o.protocol}`)
      }
    }

    this.changeBasket = verifyOne(
      await this.storage.findOutputBaskets({
        partial: { userId: this.userId, name: 'default' }
      })
    )
    this.baskets = {}

    this.etx = verifyOneOrNone(
      await this.storage.findTransactions({
        partial: { userId: this.userId, txid: this.txid }
      })
    )
    if ((this.etx != null) && this.etx.status !== 'completed' && this.etx.status !== 'unproven' && this.etx.status !== 'sending' && this.etx.status !== 'nosend') {
      throw new WERR_INVALID_PARAMETER(
        'tx',
        `target transaction of internalizeAction has invalid status ${this.etx.status}.`
      )
    }
    this.isMerge = this.etx != null

    if (this.isMerge) {
      this.eos = await this.storage.findOutputs({
        partial: { userId: this.userId, txid: this.txid }
      }) // It is possible for a transaction to have no outputs, or less outputs in storage than in the transaction itself.
      for (const eo of this.eos) {
        const bi = this.basketInsertions.find(b => b.vout === eo.vout)
        const wp = this.walletPayments.find(b => b.vout === eo.vout)
        if ((bi != null) && (wp != null)) throw new WERR_INVALID_PARAMETER('outputs', 'unique outputIndex values')
        if (bi != null) bi.eo = eo
        if (wp != null) wp.eo = eo
      }
    }

    for (const basket of this.basketInsertions) {
      if (this.isMerge && (basket.eo != null)) {
        if (isManagedChangeOutput(basket.eo)) {
          throw new WERR_INVALID_PARAMETER(
            'outputs',
            `output ${basket.vout} is wallet-managed change and cannot be reclassified as a basket insertion`
          )
        }
        // An incompatible legacy row in the default basket may be moved to a
        // non-default recovery basket. It was not part of managed balance, so
        // this metadata repair has no satoshi adjustment.
      }
    }

    for (const payment of this.walletPayments) {
      if (this.isMerge) {
        if (payment.eo != null) {
          if (isManagedChangeOutput(payment.eo) && payment.eo.basketId === this.changeBasket.basketId) {
            // Re-internalizing managed change is idempotent.
            payment.ignore = true
          } else {
            // Verified signer processing established that this is BRC-29.
            // Promote a custom row (including legacy custom-in-default rows)
            // to managed change and add it to balance.
            this.satoshis += payment.txo.satoshis!
          }
        } else {
          // adding a previously untracked output of an existing transaction as change... increase net satoshis
          this.satoshis += payment.txo.satoshis!
        }
      } else {
        // If there are no existing outputs, all incoming wallet payment outputs add to net satoshis
        this.satoshis += payment.txo.satoshis!
      }
    }
  }

  /**
   * This is the second time the atomic beef is validated against a chaintracker.
   * The first validation used the originating wallet's configured chaintracker.
   * Now the chaintracker configured for this storage is used.
   * These may be the same, or different.
   *
   * THIS DOES NOT GUARANTEE:
   * 1. That the transaction has been broadcast. (Is known to the network).
   * 2. That the proof(s) are for the same block as recorded in this storage in the event of a reorg.
   *
   * In the event of a reorg, we CAN assume that the proof contained in this beef should replace the proof in storage.
   *
   * @param atomicBeef
   * @returns
   */
  async validateAtomicBeef (atomicBeef: number[] | Uint8Array) {
    const ab = atomicBeef instanceof Uint8Array ? Beef.fromBinaryView(atomicBeef) : Beef.fromBinary(atomicBeef)
    const txValid = await ab.verify(await this.storage.getServices().getChainTracker(), false)
    if (!txValid || !ab.atomicTxid) throw new WERR_INVALID_PARAMETER('tx', 'valid AtomicBEEF')
    const txid = ab.atomicTxid
    const btx = ab.findTxid(txid)
    if (btx == null) throw new WERR_INVALID_PARAMETER('tx', `valid AtomicBEEF with newest txid of ${txid}`)
    const tx = btx.tx!


    return { ab, tx, txid }
  }

  async findOrInsertTargetTransaction (satoshis: number, provenTx?: TableProvenTx): Promise<TableTransaction> {
    const now = new Date()
    const provenTxId = provenTx?.provenTxId
    const status: TransactionStatus = (provenTx != null) ? 'completed' : 'unproven'
    const newTx: TableTransaction = {
      created_at: now,
      updated_at: now,
      transactionId: 0,

      provenTxId,
      status,

      satoshis,

      version: this.tx.version,
      lockTime: this.tx.lockTime,
      reference: randomBytesBase64(7),
      userId: this.userId,
      isOutgoing: false,
      description: this.args.description,

      inputBEEF: undefined,
      txid: this.txid,
      rawTx: undefined
    }
    const tr = await this.storage.findOrInsertTransaction(newTx)
    if (!tr.isNew) {
      if (!this.isMerge)
      // For now, only allow transaction record to pre-exist if it was there at the start.
      { throw new WERR_INVALID_PARAMETER('tx', 'target transaction of internalizeAction is undergoing active changes.') }
      const update: Partial<TableTransaction> = { satoshis: tr.tx.satoshis + satoshis }
      if (provenTx != null) {
        update.provenTxId = provenTxId
        update.status = status
      }
      await this.storage.updateTransaction(tr.tx.transactionId, update)
    }
    return tr.tx
  }

  private async findOrInsertProvenTxFromBump (bump: MerklePath, btx: BeefTx): Promise<TableProvenTx> {
    const now = new Date()
    const merkleRoot = bump.computeRoot(this.txid)
    const indexEntry = bump.path[0].find(p => p.hash === this.txid)
    if (indexEntry == null) {
      throw new WERR_INTERNAL(
        `Could not determine transaction index for txid ${this.txid} in bump path. Expected to find txid in bump.path[0]: ${JSON.stringify(bump.path[0])}`
      )
    }
    const index = indexEntry.offset
    const header = await this.storage.getServices().getHeaderForHeight(bump.blockHeight)
    if (!header) {
      throw new WERR_INTERNAL(`Block header not found for height ${bump.blockHeight}`)
    }
    const hash = blockHash(header)
    const provenTxR = await this.storage.findOrInsertProvenTx({
      created_at: now,
      updated_at: now,
      provenTxId: 0,
      txid: this.txid,
      height: bump.blockHeight,
      index,
      merklePath: bump.toBinary(),
      rawTx: btx.rawTx!,
      blockHash: hash,
      merkleRoot
    })
    return provenTxR.proven
  }

  async mergedInternalize () {
    const transactionId = this.etx!.transactionId
    const wasNoSend = this.etx!.status === 'nosend'

    await this.addLabels(transactionId)

    // Externally-broadcast txs internalized into a pre-existing storage
    // record (typically a nosend created by this wallet) still need their
    // consumed user UTXOs marked spent. createAction marks them when the
    // tx is wallet-originated, but a nosend can be merged from a sender
    // that doesn't share storage. Idempotent for the wallet-originated
    // case — already-spent outputs are skipped.
    await this.markInputsSpent(transactionId)

    for (const payment of this.walletPayments) {
      if ((payment.eo != null) && !payment.ignore) await this.mergeWalletPaymentForOutput(transactionId, payment)
      else if (!payment.ignore) await this.storeNewWalletPaymentForOutput(transactionId, payment)
    }

    for (const basket of this.basketInsertions) {
      if (basket.eo != null) await this.mergeBasketInsertionForOutput(transactionId, basket)
      else await this.storeNewBasketInsertionForOutput(transactionId, basket)
    }

    // Lifecycle advance when merging into a tx that was 'nosend'.
    //
    // Background: an internalizeAction call against an existing tx in
    // 'nosend' status is the caller asserting the tx has now been
    // externally broadcast (and potentially mined if the BEEF includes
    // a BUMP). Before this advance, mergedInternalize only updated
    // labels + per-output ownership records and left transactions.status
    // and proven_tx_reqs.status unchanged. The nosend state then had no
    // reliable retirement path: TaskCheckNoSends's default daily cadence
    // combined with intermittent wallet uptime meant the req could sit
    // in 'nosend' indefinitely, and a subsequent abortAction call would
    // unconditionally invalidate the on-chain tx — orphaning every
    // output the tx produced.
    //
    // BUMP-present path: mirror newInternalize's findOrInsertProvenTx
    // path, then promote the existing transaction record to 'completed'
    // with the new provenTxId and retire the proven_tx_req to
    // 'completed' too.
    //
    // BUMP-absent path: promote transactions.status to 'unproven' (so
    // listOutputs filters the tx's outputs into the spendable set
    // immediately) and transition the proven_tx_req to 'unmined' so
    // TaskCheckForProofs picks it up on its next nudge cycle. This
    // hands off to Monitor's standard proof-fetching flow.
    if (wasNoSend) {
      const bump = this.ab.findBump(this.txid)
      if (bump != null) {
        const btx = this.ab.findTxid(this.txid)
        if (btx == null) {
          throw new WERR_INTERNAL(`Could not find transaction ${this.txid} in AtomicBEEF`)
        }
        const proven = await this.findOrInsertProvenTxFromBump(bump, btx)
        await this.storage.updateTransaction(transactionId, {
          provenTxId: proven.provenTxId,
          status: 'completed'
        })
        const req = await EntityProvenTxReq.fromStorageTxid(this.storage, this.txid)
        if (req != null && req.status === 'nosend') {
          req.addHistoryNote({ what: 'internalizeAction-bumpRetire', userId: this.userId })
          req.provenTxId = proven.provenTxId
          req.status = 'completed'
          await req.updateStorageDynamicProperties(this.storage)
        }
      } else {
        await this.storage.updateTransaction(transactionId, { status: 'unproven' })
        const req = await EntityProvenTxReq.fromStorageTxid(this.storage, this.txid)
        if (req != null && req.status === 'nosend') {
          req.addHistoryNote({ what: 'internalizeAction-nosendRetire', userId: this.userId })
          req.status = 'unmined'
          await req.updateStorageDynamicProperties(this.storage)
        }
      }
    }
  }

  /**
   * internalize output(s) from a transaction with txid unknown to storage.
   */
  async newInternalize () {
    // Check if the transaction has a merkle path proof (BUMP)
    const btx = this.ab.findTxid(this.txid)
    if (btx == null) throw new WERR_INTERNAL(`Could not find transaction ${this.txid} in AtomicBEEF`)
    const bump = this.ab.findBump(this.txid)

    let pr: StorageProvenOrReq = { isNew: false, proven: undefined, req: undefined }

    if (bump != null) {
      // The presence bump indicates the transaction has already been mined.
      // Verify a provenTx record exist before creating a new transaction with completed status...
      // Which normally means creating a new provenTx record.
      pr.proven = await this.findOrInsertProvenTxFromBump(bump, btx)
    }

    this.etx = await this.findOrInsertTargetTransaction(this.satoshis, pr.proven)

    const transactionId = this.etx.transactionId

    // Mark any user-owned outputs the incoming tx consumes as spent BEFORE
    // attempting broadcast. If broadcast fails we restore them below.
    await this.markInputsSpent(transactionId)

    if (pr.proven == null) {
      // beef doesn't include proof of mining for the transaction (etx).
      // the new transaction record has been added to storage, but (baring race conditions)
      // there should be no provenTx or provenTxReq records for this txid.
      //
      // Attempt to create a provenTxReq record for the txid to obtain a proof,
      // while allowing for possible race conditions...
      const newReq = EntityProvenTxReq.fromTxid(this.txid, this.tx.toBinary(), Utils.toArray(this.args.tx))
      newReq.status = 'unsent'
      // this history and notify will be merged into an existing req if it exists.
      newReq.addHistoryNote({ what: 'internalizeAction', userId: this.userId })
      newReq.addNotifyTransactionId(transactionId)
      pr = await this.storage.getProvenOrReq(this.txid, newReq.toApi())
    }

    if (pr.isNew) {
      // This storage didn't know about this txid and the beef didn't include a mining proof.
      // Assume the transaction has never been broadcast.
      // Attempt to broadcast it to the network, throwing an error if it fails.

      // Skip looking up txids and building an aggregate beef,
      // just this one txid and the already validated atomic beef.
      // The beef may contain additional unbroadcast transactions which
      // we don't care about.
      const r: GetReqsAndBeefResult = {
        beef: this.ab,
        details: [{ txid: this.txid, status: 'readyToSend', req: pr.req }]
      }
      const { swr, ndr } = await shareReqsWithWorld(this.storage, this.userId, [], false, r)
      if (ndr![0].status !== 'success') {
        // Roll back the spendable=true → false transitions performed above
        // so the caller can retry with the same UTXOs. Idempotent w.r.t.
        // attemptToPostReqsToNetwork's own updateTransactionStatus('failed')
        // restore on doubleSpend/invalidTx outcomes.
        await this.restoreSpentInputs()
        this.r.sendWithResults = swr
        this.r.notDelayedResults = ndr
        // abort the internalize action, WERR_REVIEW_ACTIONS exception will be thrown
        return
      }
    }

    await this.addLabels(transactionId)

    for (const payment of this.walletPayments) {
      await this.storeNewWalletPaymentForOutput(transactionId, payment)
    }

    for (const basket of this.basketInsertions) {
      await this.storeNewBasketInsertionForOutput(transactionId, basket)
    }
  }

  async addLabels (transactionId: number) {
    for (const label of this.vargs.labels) {
      const txLabel = await this.storage.findOrInsertTxLabel(this.userId, label)
      await this.storage.findOrInsertTxLabelMap(verifyId(transactionId), verifyId(txLabel.txLabelId))
    }
  }

  async markInputsSpent (transactionId: number): Promise<void> {
    const transitioned = await markUserInputsSpent(this.storage, this.userId, this.tx, transactionId)
    this.spentInputs.push(...transitioned)
  }

  async restoreSpentInputs (): Promise<void> {
    await restoreInputsToSpendable(this.storage, this.spentInputs)
    this.spentInputs = []
  }

  async addBasketTags (basket: BasketInsertionX, outputId: number) {
    for (const tag of basket.tags || []) {
      await this.storage.tagOutput({ outputId, userId: this.userId }, tag)
    }
  }

  async storeNewWalletPaymentForOutput (transactionId: number, payment: WalletPaymentX): Promise<void> {
    const now = new Date()
    const txOut: TableOutput = {
      created_at: now,
      updated_at: now,
      outputId: 0,
      transactionId,
      userId: this.userId,
      spendable: true,
      lockingScript: payment.txo.lockingScript.toBinary(),
      vout: payment.vout,
      basketId: this.changeBasket.basketId,
      satoshis: payment.txo.satoshis!,
      txid: this.txid,
      senderIdentityKey: payment.senderIdentityKey,
      type: 'P2PKH',
      providedBy: 'storage',
      purpose: 'change',
      derivationPrefix: payment.derivationPrefix,
      derivationSuffix: payment.derivationSuffix,

      change: true,
      spentBy: undefined,
      customInstructions: undefined,
      outputDescription: '',
      spendingDescription: undefined
    }
    txOut.outputId = await this.storage.insertOutput(txOut)
    payment.eo = txOut
  }

  async mergeWalletPaymentForOutput (transactionId: number, payment: WalletPaymentX) {
    const outputId = payment.eo!.outputId
    const update: Partial<TableOutput> = {
      basketId: this.changeBasket.basketId,
      type: 'P2PKH',
      customInstructions: undefined,
      change: true,
      providedBy: 'storage',
      purpose: 'change',
      senderIdentityKey: payment.senderIdentityKey,
      derivationPrefix: payment.derivationPrefix,
      derivationSuffix: payment.derivationSuffix
    }
    await this.storage.updateOutput(outputId, update)
    payment.eo = { ...payment.eo!, ...update }
  }

  async mergeBasketInsertionForOutput (transactionId: number, basket: BasketInsertionX) {
    const outputId = basket.eo!.outputId
    const update: Partial<TableOutput> = {
      basketId: (await this.getBasket(basket.basket)).basketId,
      type: 'custom',
      customInstructions: basket.customInstructions,
      change: false,
      providedBy: 'you',
      purpose: '',
      senderIdentityKey: undefined,
      derivationPrefix: undefined,
      derivationSuffix: undefined
    }
    await this.storage.updateOutput(outputId, update)
    basket.eo = { ...basket.eo!, ...update }
  }

  async storeNewBasketInsertionForOutput (transactionId: number, basket: BasketInsertionX): Promise<void> {
    const now = new Date()
    const txOut: TableOutput = {
      created_at: now,
      updated_at: now,
      outputId: 0,
      transactionId,
      userId: this.userId,
      spendable: true,
      lockingScript: basket.txo.lockingScript.toBinary(),
      vout: basket.vout,
      basketId: (await this.getBasket(basket.basket)).basketId,
      satoshis: basket.txo.satoshis!,
      txid: this.txid,
      type: 'custom',
      customInstructions: basket.customInstructions,

      change: false,
      spentBy: undefined,
      outputDescription: '',
      spendingDescription: undefined,

      providedBy: 'you',
      purpose: '',

      senderIdentityKey: undefined,
      derivationPrefix: undefined,
      derivationSuffix: undefined
    }
    txOut.outputId = await this.storage.insertOutput(txOut)

    await this.addBasketTags(basket, txOut.outputId)

    basket.eo = txOut
  }
}
