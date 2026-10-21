import { type ValidInternalizeActionArgs, validateInternalizeActionArgs } from '@bsv/sdk/wallet/validationHelpers'
import {
  Transaction as BsvTransaction,
  WalletPayment,
  BasketInsertion,
  InternalizeActionArgs,
  TransactionOutput,
  Beef,
  BeefTx,
  MerklePath
} from '@bsv/sdk'
import { toArray } from '@bsv/sdk/primitives/utils'
import { GetReqsAndBeefResult, shareReqsWithWorld } from './processAction'
import { StorageProvider } from '../StorageProvider'
import {
  AuthId,
  StorageInternalizeActionResult,
  StorageProvenOrReq,
  TrxToken
} from '../../sdk/WalletStorage.interfaces'
import { TableOutput } from '../schema/tables/TableOutput'
import { TableOutputBasket } from '../schema/tables/TableOutputBasket'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { canonicalizeAtomicBeef } from '../../utility/canonicalizeAtomicBeef'
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
export async function markUserInputsSpent(
  storage: StorageProvider,
  userId: number,
  tx: BsvTransaction,
  transactionId: number,
  trx?: TrxToken
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
  }, trx)
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
export async function restoreInputsToSpendable(
  storage: StorageProvider,
  transitions: SpentInputTransition[],
  trx?: TrxToken
): Promise<void> {
  if (transitions.length === 0) return
  await storage.transaction(async trx => {
    for (const t of transitions) {
      const update: Partial<TableOutput> = t.setSpentBy ? { spendable: true, spentBy: undefined } : { spendable: true }
      await storage.updateOutput(verifyId(t.outputId), update, trx)
    }
  }, trx)
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
export async function internalizeAction(
  storage: StorageProvider,
  auth: AuthId,
  args: InternalizeActionArgs,
  receipt?: InternalizeReceiptClaim
): Promise<StorageInternalizeActionResult> {
  const ctx = new InternalizeActionContext(storage, auth, args, receipt)
  await ctx.asyncSetup()

  if (ctx.isMerge) await ctx.mergedInternalize()
  else await ctx.newInternalize()

  return ctx.r
}

/** SQL storage uses a durable claim to fence receipt writes across processes. */
export interface InternalizeReceiptClaim {
  retryNew: boolean
  assertActive: (trx: TrxToken) => Promise<void>
  markNew: (trx: TrxToken) => Promise<void>
  complete: (trx: TrxToken) => Promise<void>
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
  retryExistingTransaction = false
  userId: number
  vargs: ValidInternalizeActionArgs

  constructor(
    public storage: StorageProvider,
    public auth: AuthId,
    public args: InternalizeActionArgs,
    public receipt?: InternalizeReceiptClaim
  ) {
    this.vargs = validateInternalizeActionArgs(args)
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

  get isMerge(): boolean {
    return this.r.isMerge
  }

  set isMerge(v: boolean) {
    this.r.isMerge = v
  }

  get txid(): string {
    return this.r.txid
  }

  set txid(v: string) {
    this.r.txid = v
  }

  get satoshis(): number {
    return this.r.satoshis
  }

  set satoshis(v: number) {
    this.r.satoshis = v
  }

  async getBasket(basketName: string, trx?: TrxToken): Promise<TableOutputBasket> {
    if (basketName === 'default') {
      throw new WERR_INVALID_PARAMETER('insertionRemittance.basket', 'a non-default basket')
    }
    let b = this.baskets[basketName]
    if (b) return b
    b = await this.storage.findOrInsertOutputBasket(this.userId, basketName, trx)
    this.baskets[basketName] = b
    return b
  }

  private classifyRequestedOutput(output: ValidInternalizeActionArgs['outputs'][number]): void {
    if (output.outputIndex < 0 || output.outputIndex >= this.tx.outputs.length) {
      throw new WERR_INVALID_PARAMETER(
        'outputIndex',
        `a valid output index in range 0 to ${this.tx.outputs.length - 1}`
      )
    }
    const txo = this.tx.outputs[output.outputIndex]
    if (output.protocol === 'basket insertion') {
      if (output.insertionRemittance == null || output.paymentRemittance != null) {
        throw new WERR_INVALID_PARAMETER('basket insertion', 'valid insertionRemittance and no paymentRemittance')
      }
      if (output.insertionRemittance.basket === 'default') {
        throw new WERR_INVALID_PARAMETER('insertionRemittance.basket', 'a non-default basket')
      }
      this.basketInsertions.push({
        ...output.insertionRemittance,
        txo,
        vout: output.outputIndex
      })
      return
    }
    if (output.protocol !== 'wallet payment') {
      throw new WERR_INTERNAL(`unexpected protocol ${output.protocol}`)
    }
    if (output.insertionRemittance != null || output.paymentRemittance == null) {
      throw new WERR_INVALID_PARAMETER('wallet payment', 'valid paymentRemittance and no insertionRemittance')
    }
    this.walletPayments.push({
      ...output.paymentRemittance,
      txo,
      vout: output.outputIndex,
      ignore: false
    })
  }

  private async loadExistingTransaction(): Promise<void> {
    this.etx = verifyOneOrNone(
      await this.storage.findTransactions({
        partial: { userId: this.userId, txid: this.txid }
      })
    )
    const allowedStatuses: TransactionStatus[] = ['completed', 'unproven', 'sending', 'nosend']
    if (this.receipt?.retryNew) allowedStatuses.push('failed')
    if (this.etx != null && !allowedStatuses.includes(this.etx.status)) {
      throw new WERR_INVALID_PARAMETER(
        'tx',
        `target transaction of internalizeAction has invalid status ${this.etx.status}.`
      )
    }
    this.isMerge = this.etx != null
    if (this.receipt?.retryNew && this.etx != null) {
      const existingOutputs = await this.storage.findOutputs({ partial: { userId: this.userId, txid: this.txid } })
      if (existingOutputs.length === 0) {
        this.retryExistingTransaction = true
        this.isMerge = false
      }
    }
  }

  private async linkExistingOutputs(): Promise<void> {
    if (!this.isMerge) return
    this.eos = await this.storage.findOutputs({
      partial: { userId: this.userId, txid: this.txid }
    })
    for (const existing of this.eos) {
      const basket = this.basketInsertions.find(candidate => candidate.vout === existing.vout)
      const payment = this.walletPayments.find(candidate => candidate.vout === existing.vout)
      if (basket != null && payment != null) {
        throw new WERR_INVALID_PARAMETER('outputs', 'unique outputIndex values')
      }
      if (basket != null) basket.eo = existing
      if (payment != null) payment.eo = existing
    }
  }

  /**
   * Rejects a basket-insertion merge that would silently move an existing
   * output between baskets. Without this, an app with insertion permission on
   * basket X only (checked at the WalletPermissionsManager layer against the
   * *requested* basket) could internalize an already-known transaction and
   * reclassify another app's output from basket Y into X, then spend it.
   *
   * An output currently sitting in the wallet's own 'default'/change basket
   * without being wallet-managed change is not a real, app-claimed basket
   * assignment — it is the documented legacy-recovery state (see
   * `internalizeActionManagedChangePolicy.test.ts`), and 'default' can never
   * be requested as an insertion destination (see `getBasket`), so it is
   * exempt from this check and remains sweepable into a real basket.
   *
   * The requested basket is resolved with a plain, non-inserting lookup
   * (`findOutputBaskets`) so that a request which is then rejected never
   * creates the named basket as a side effect.
   */
  private async validateBasketMerges(): Promise<void> {
    if (!this.isMerge) return
    for (const basket of this.basketInsertions) {
      const eo = basket.eo
      if (eo == null) continue
      // Widened so the type guard's false branch does not narrow `eo` to never.
      if (isManagedChangeOutput(eo as TableOutput | undefined)) {
        throw new WERR_INVALID_PARAMETER(
          'outputs',
          `output ${basket.vout} is wallet-managed change and cannot be reclassified as a basket insertion`
        )
      }
      const currentBasketId = eo.basketId
      if (currentBasketId == null || currentBasketId === this.changeBasket.basketId) continue
      const requestedBasket = verifyOneOrNone(
        await this.storage.findOutputBaskets({ partial: { userId: this.userId, name: basket.basket } })
      )
      if (requestedBasket?.basketId !== currentBasketId) {
        throw new WERR_INVALID_PARAMETER(
          'outputs',
          `output ${basket.vout} is already assigned to a different basket and cannot be reclassified as a basket insertion into ${basket.basket}`
        )
      }
      // Same basket already: cache it so mergeBasketInsertionForOutput's later
      // getBasket call reuses this lookup instead of repeating it.
      this.baskets[basket.basket] = requestedBasket
    }
  }

  private computeWalletPaymentBalance(): void {
    for (const payment of this.walletPayments) {
      if (!this.isMerge || payment.eo == null) {
        this.satoshis += payment.txo.satoshis!
        continue
      }
      if (isManagedChangeOutput(payment.eo) && payment.eo.basketId === this.changeBasket.basketId) {
        payment.ignore = true
        continue
      }
      this.satoshis += payment.txo.satoshis!
    }
  }

  async asyncSetup(): Promise<void> {
    ;({ ab: this.ab, tx: this.tx, txid: this.txid } = await this.validateAtomicBeef(this.args.tx))

    for (const output of this.vargs.outputs) this.classifyRequestedOutput(output)

    this.changeBasket = verifyOne(
      await this.storage.findOutputBaskets({
        partial: { userId: this.userId, name: 'default' }
      })
    )
    this.baskets = {}
    await this.loadExistingTransaction()
    await this.linkExistingOutputs()
    await this.validateBasketMerges()
    this.computeWalletPaymentBalance()
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
  async validateAtomicBeef(atomicBeef: number[] | Uint8Array) {
    const ab = canonicalizeAtomicBeef(atomicBeef)
    const txValid = await ab.verify(await this.storage.getServices().getChainTracker(), false)
    if (!txValid || !ab.atomicTxid) throw new WERR_INVALID_PARAMETER('tx', 'valid AtomicBEEF')
    const txid = ab.atomicTxid
    const btx = ab.findTxid(txid)
    if (btx == null) throw new WERR_INVALID_PARAMETER('tx', `valid AtomicBEEF with newest txid of ${txid}`)
    const tx = btx.tx!

    return { ab, tx, txid }
  }

  async findOrInsertTargetTransaction(
    satoshis: number,
    provenTx?: TableProvenTx,
    trx?: TrxToken
  ): Promise<TableTransaction> {
    const now = new Date()
    const provenTxId = provenTx?.provenTxId
    const status: TransactionStatus = provenTx != null ? 'completed' : 'unproven'
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
    const tr = await this.storage.findOrInsertTransaction(newTx, trx)
    if (!tr.isNew) {
      if (this.retryExistingTransaction) {
        const update: Partial<TableTransaction> = { satoshis }
        if (provenTx != null) {
          update.provenTxId = provenTxId
          update.status = status
        }
        await this.storage.updateTransaction(tr.tx.transactionId, update, trx)
        return tr.tx
      }
      if (!this.isMerge)
      // For now, only allow transaction record to pre-exist if it was there at the start.
      {
        throw new WERR_INVALID_PARAMETER('tx', 'target transaction of internalizeAction is undergoing active changes.')
      }
      const update: Partial<TableTransaction> = { satoshis: tr.tx.satoshis + satoshis }
      if (provenTx != null) {
        update.provenTxId = provenTxId
        update.status = status
      }
      await this.storage.updateTransaction(tr.tx.transactionId, update, trx)
    }
    return tr.tx
  }

  /**
   * Resolve mined-transaction evidence before a storage writer starts.
   *
   * IndexedDB commits a transaction when the event loop turns without a
   * pending request on that transaction. Awaiting a header lookup while the
   * writer is open finishes the transaction, and the next object-store call
   * fails with InvalidStateError before any proven tx, transaction, or output
   * is stored. Header validation still runs to completion here, so a missing
   * or malformed header rejects with no database writes.
   */
  private async resolveProvenTxForBump(bump: MerklePath, btx: BeefTx): Promise<TableProvenTx> {
    const now = new Date()
    const merkleRoot = bump.computeRoot(this.txid)
    const indexEntry = bump.path[0].find(p => p.hash === this.txid)
    if (indexEntry == null) {
      throw new WERR_INTERNAL(
        `Could not determine transaction index for txid ${this.txid} in bump path. Expected to find txid in bump.path[0]: ${JSON.stringify(bump.path[0])}`
      )
    }
    const header = await this.storage.getServices().getHeaderForHeight(bump.blockHeight)
    if (!header) {
      throw new WERR_INTERNAL(`Block header not found for height ${bump.blockHeight}`)
    }
    return {
      created_at: now,
      updated_at: now,
      provenTxId: 0,
      txid: this.txid,
      height: bump.blockHeight,
      index: indexEntry.offset,
      merklePath: bump.toBinary(),
      rawTx: btx.rawTx!,
      blockHash: blockHash(header),
      merkleRoot
    }
  }

  private async storeResolvedProvenTx(proven: TableProvenTx, trx?: TrxToken): Promise<TableProvenTx> {
    const stored = await this.storage.findOrInsertProvenTx(proven, trx)
    return stored.proven
  }

  private async mergeWalletPayments(transactionId: number, trx?: TrxToken): Promise<void> {
    for (const payment of this.walletPayments) {
      if (payment.ignore) continue
      if (payment.eo != null) {
        await this.mergeWalletPaymentForOutput(transactionId, payment, trx)
      } else {
        await this.storeNewWalletPaymentForOutput(transactionId, payment, trx)
      }
    }
  }

  private async mergeBasketInsertions(transactionId: number, trx?: TrxToken): Promise<void> {
    for (const basket of this.basketInsertions) {
      if (basket.eo != null) {
        await this.mergeBasketInsertionForOutput(transactionId, basket, trx)
      } else {
        await this.storeNewBasketInsertionForOutput(transactionId, basket, trx)
      }
    }
  }

  private async prepareNoSendProof(): Promise<TableProvenTx | undefined> {
    const bump = this.ab.findBump(this.txid)
    if (bump == null) return undefined
    const beefTx = this.ab.findTxid(this.txid)
    if (beefTx == null) {
      throw new WERR_INTERNAL(`Could not find transaction ${this.txid} in AtomicBEEF`)
    }
    return await this.resolveProvenTxForBump(bump, beefTx)
  }

  private async retireNoSendWithProof(transactionId: number, proven: TableProvenTx, trx?: TrxToken): Promise<void> {
    const stored = await this.storeResolvedProvenTx(proven, trx)
    await this.storage.updateTransaction(
      transactionId,
      {
        provenTxId: stored.provenTxId,
        status: 'completed'
      },
      trx
    )
    const req = await EntityProvenTxReq.fromStorageTxid(this.storage, this.txid, trx)
    if (req?.status !== 'nosend') return
    req.addHistoryNote({ what: 'internalizeAction-bumpRetire', userId: this.userId })
    req.provenTxId = stored.provenTxId
    req.status = 'completed'
    await req.updateStorageDynamicProperties(this.storage, trx)
  }

  private async retireNoSendWithoutProof(transactionId: number, trx?: TrxToken): Promise<void> {
    await this.storage.updateTransaction(transactionId, { status: 'unproven' }, trx)
    const req = await EntityProvenTxReq.fromStorageTxid(this.storage, this.txid, trx)
    if (req?.status !== 'nosend') return
    req.addHistoryNote({ what: 'internalizeAction-nosendRetire', userId: this.userId })
    req.status = 'unmined'
    await req.updateStorageDynamicProperties(this.storage, trx)
  }

  private async retireNoSendTransaction(
    transactionId: number,
    preparedProven: TableProvenTx | undefined,
    trx?: TrxToken
  ): Promise<void> {
    if (preparedProven != null) {
      await this.retireNoSendWithProof(transactionId, preparedProven, trx)
    } else {
      await this.retireNoSendWithoutProof(transactionId, trx)
    }
  }

  async mergedInternalize() {
    const transactionId = this.etx!.transactionId
    const wasNoSend = this.etx!.status === 'nosend'
    // Fetch any mining header before the writer. A no-send merge with a BUMP
    // otherwise awaits that lookup after labels and outputs have already been
    // queued on the same IndexedDB transaction.
    const preparedProven = wasNoSend ? await this.prepareNoSendProof() : undefined

    await this.storage.transaction(async trx => {
      await this.receipt?.assertActive(trx)
      await this.addLabels(transactionId, trx)

      // Externally-broadcast txs internalized into a pre-existing storage
      // record (typically a nosend created by this wallet) still need their
      // consumed user UTXOs marked spent. createAction marks them when the
      // tx is wallet-originated, but a nosend can be merged from a sender
      // that doesn't share storage. Idempotent for the wallet-originated
      // case — already-spent outputs are skipped.
      await this.markInputsSpent(transactionId, trx)

      await this.mergeWalletPayments(transactionId, trx)
      await this.mergeBasketInsertions(transactionId, trx)

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
      if (wasNoSend) await this.retireNoSendTransaction(transactionId, preparedProven, trx)
      await this.receipt?.complete(trx)
    })
  }

  private async persistNewOwnership(transactionId: number, trx?: TrxToken): Promise<void> {
    await this.addLabels(transactionId, trx)

    for (const payment of this.walletPayments) {
      await this.storeNewWalletPaymentForOutput(transactionId, payment, trx)
    }

    for (const basket of this.basketInsertions) {
      await this.storeNewBasketInsertionForOutput(transactionId, basket, trx)
    }
  }

  /**
   * internalize output(s) from a transaction with txid unknown to storage.
   */
  async newInternalize() {
    // Check if the transaction has a merkle path proof (BUMP)
    const btx = this.ab.findTxid(this.txid)
    if (btx == null) throw new WERR_INTERNAL(`Could not find transaction ${this.txid} in AtomicBEEF`)
    const bump = this.ab.findBump(this.txid)
    // A bump means the transaction is already mined. Resolve and validate its
    // header before opening the writer so the proven tx, transaction, and
    // requested outputs commit together or not at all.
    const preparedProven = bump != null ? await this.resolveProvenTxForBump(bump, btx) : undefined

    let pr: StorageProvenOrReq = { proven: undefined, req: undefined }

    await this.storage.transaction(async trx => {
      await this.receipt?.assertActive(trx)
      if (preparedProven != null) {
        pr.proven = await this.storeResolvedProvenTx(preparedProven, trx)
      }

      this.etx = await this.findOrInsertTargetTransaction(this.satoshis, pr.proven, trx)
      await this.receipt?.markNew(trx)

      const transactionId = this.etx.transactionId

      // Mark any user-owned outputs the incoming tx consumes as spent BEFORE
      // attempting broadcast. If broadcast fails we restore them below.
      await this.markInputsSpent(transactionId, trx)

      if (pr.proven == null) {
        // beef doesn't include proof of mining for the transaction (etx).
        // the new transaction record has been added to storage, but (baring race conditions)
        // there should be no provenTx or provenTxReq records for this txid.
        //
        // Attempt to create a provenTxReq record for the txid to obtain a proof,
        // while allowing for possible race conditions...
        const newReq = EntityProvenTxReq.fromTxid(this.txid, this.tx.toBinary(), toArray(this.args.tx))
        newReq.status = 'unsent'
        // this history and notify will be merged into an existing req if it exists.
        newReq.addHistoryNote({ what: 'internalizeAction', userId: this.userId })
        newReq.addNotifyTransactionId(transactionId)
        pr = await this.storage.getProvenOrReq(this.txid, newReq.toApi(), trx)
        if (pr.proven != null) {
          await this.storage.updateTransaction(
            transactionId,
            {
              provenTxId: pr.proven.provenTxId,
              status: 'completed'
            },
            trx
          )
          await this.persistNewOwnership(transactionId, trx)
          await this.receipt?.complete(trx)
        }
      } else {
        await this.persistNewOwnership(transactionId, trx)
        await this.receipt?.complete(trx)
      }
    })

    const transactionId = this.etx!.transactionId

    if (pr.proven == null) {
      // The transaction is new to this user and the beef didn't include a mining proof.
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

      // Network publication cannot safely run while a database transaction is
      // held open. Persist recipient ownership only after broadcast succeeds.
      // Mined transactions already stored that ownership in the proof writer.
      await this.storage.transaction(async trx => {
        await this.receipt?.assertActive(trx)
        if (this.retryExistingTransaction) {
          await this.storage.updateTransaction(transactionId, { status: 'unproven' }, trx)
        }
        await this.persistNewOwnership(transactionId, trx)
        await this.receipt?.complete(trx)
      })
    }
  }

  async addLabels(transactionId: number, trx?: TrxToken) {
    for (const label of this.vargs.labels) {
      const txLabel = await this.storage.findOrInsertTxLabel(this.userId, label, trx)
      await this.storage.findOrInsertTxLabelMap(verifyId(transactionId), verifyId(txLabel.txLabelId), trx)
    }
  }

  async markInputsSpent(transactionId: number, trx?: TrxToken): Promise<void> {
    const transitioned = await markUserInputsSpent(this.storage, this.userId, this.tx, transactionId, trx)
    this.spentInputs.push(...transitioned)
  }

  async restoreSpentInputs(trx?: TrxToken): Promise<void> {
    await restoreInputsToSpendable(this.storage, this.spentInputs, trx)
    this.spentInputs = []
  }

  async addBasketTags(basket: BasketInsertionX, outputId: number, trx?: TrxToken) {
    for (const tag of basket.tags || []) {
      await this.storage.tagOutput({ outputId, userId: this.userId }, tag, trx)
    }
  }

  async storeNewWalletPaymentForOutput(transactionId: number, payment: WalletPaymentX, trx?: TrxToken): Promise<void> {
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
    txOut.outputId = await this.storage.insertOutput(txOut, trx)
    payment.eo = txOut
  }

  async mergeWalletPaymentForOutput(transactionId: number, payment: WalletPaymentX, trx?: TrxToken) {
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
    await this.storage.updateOutput(outputId, update, trx)
    payment.eo = { ...payment.eo!, ...update }
  }

  async mergeBasketInsertionForOutput(transactionId: number, basket: BasketInsertionX, trx?: TrxToken) {
    const outputId = basket.eo!.outputId
    const update: Partial<TableOutput> = {
      basketId: (await this.getBasket(basket.basket, trx)).basketId,
      type: 'custom',
      customInstructions: basket.customInstructions,
      change: false,
      providedBy: 'you',
      purpose: '',
      senderIdentityKey: undefined,
      derivationPrefix: undefined,
      derivationSuffix: undefined
    }
    await this.storage.updateOutput(outputId, update, trx)
    basket.eo = { ...basket.eo!, ...update }
  }

  async storeNewBasketInsertionForOutput(
    transactionId: number,
    basket: BasketInsertionX,
    trx?: TrxToken
  ): Promise<void> {
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
      basketId: (await this.getBasket(basket.basket, trx)).basketId,
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
    txOut.outputId = await this.storage.insertOutput(txOut, trx)

    await this.addBasketTags(basket, txOut.outputId, trx)

    basket.eo = txOut
  }
}
