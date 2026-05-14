import {
  Transaction as BsvTransaction,
  WalletPayment,
  BasketInsertion,
  InternalizeActionArgs,
  TransactionOutput,
  Beef,
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

/**
 * Swallow a new-schema wiring error that is due to the database not yet being on the
 * the new schema (pre-cutover test databases, StorageIdb, etc.).
 * Re-throws any other error so callers see real failures.
 */
function isPreCutoverError (err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return (
    msg.includes('no such table') ||
    msg.includes('no such column') ||
    msg.includes('Table') ||
    msg.includes('SQLITE_ERROR') ||
    msg.includes('Unknown column')
  )
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
 * The existing transaction must be in the 'unproven' or 'completed' status. Any other status is an error.
 *
 * When the transaction already exists, the description is updated. The isOutgoing sense is not changed.
 *
 * "basket insertion" Merge Rules:
 * 1. The "default" basket may not be specified as the insertion basket.
 * 2. A change output in the "default" basket may not be target of an insertion into a different basket.
 * 3. These baskets do not affect the wallet's balance and are typed "custom".
 *
 * "wallet payment" Merge Rules:
 * 1. Targetting an existing change "default" basket output results in a no-op. No error. No alterations made.
 * 2. Targetting a previously "custom" non-change output converts it into a change output. This alters the transaction's `satoshis`, and the wallet balance.
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
  userId: number
  vargs: Validation.ValidInternalizeActionArgs
  /**
   * new actionId set when the new-schema `actions` row is found or created during
   * `findOrInsertTargetTransaction`. Used afterwards to call
   * `updateActionSatoshisDelta` in the merge-update path.
   *
   * Undefined when the transaction service is unavailable (StorageIdb, pre-cutover DBs).
   */
  newActionId?: number

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
    let b = this.baskets[basketName]
    if (b) return b
    b = await this.storage.findOrInsertOutputBasket(this.userId, basketName)
    this.baskets[basketName] = b
    return b
  }

  async asyncSetup () {
    ;({ ab: this.ab, tx: this.tx, txid: this.txid } = await this.validateAtomicBeef(Utils.toArray(this.args.tx)))

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

    // new-schema wiring — call site 1: findTransactions → findAction
    // On post-cutover DBs `transactions` is the new transactions table (no `status` column).
    // Try the the transaction service first; fall back to the legacy `findTransactions` path
    // when the service is unavailable or the DB is pre-cutover.
    // TODO(post-cutover): remove legacy fallback once all DBs are post-cutover.
    const txSvcSetup = this.storage.getTransactionService()
    let existingNewAction: { actionId: number, satoshisDelta: number } | undefined
    if (txSvcSetup != null) {
      try {
        const foundAction = await txSvcSetup.findAction(this.userId, this.txid)
        if (foundAction != null) {
          const foundTx = await txSvcSetup.findByTxid(this.txid)
          existingNewAction = { actionId: foundAction.actionId, satoshisDelta: foundAction.satoshisDelta }
          // Synthesise a minimal legacy TableTransaction so the rest of the context
          // can check isMerge without touching the (absent) legacy columns.
          // status is mapped from processing so the status guard below works.
          const legacyStatus: TransactionStatus =
            foundTx?.processing === 'confirmed' ? 'completed'
            : foundTx?.processing === 'nosend' ? 'nosend'
            : 'unproven'
          this.etx = {
            transactionId: foundAction.actionId,
            userId: this.userId,
            txid: this.txid,
            status: legacyStatus,
            isOutgoing: foundAction.isOutgoing,
            satoshis: foundAction.satoshisDelta,
            description: foundAction.description,
            reference: foundAction.reference,
            inputBEEF: undefined,
            rawTx: undefined,
            version: undefined,
            lockTime: undefined,
            provenTxId: undefined,
            created_at: foundAction.created_at,
            updated_at: foundAction.updated_at
          } as unknown as TableTransaction
        }
      } catch (txErr) {
        if (!isPreCutoverError(txErr)) throw txErr
        // Pre-cutover: fall through to legacy findTransactions below
      }
    }

    if (this.etx == null) {
      // Legacy fallback — works on pre-cutover DBs and StorageIdb.
      // TODO(post-cutover): remove once all DBs are post-cutover.
      this.etx = verifyOneOrNone(
        await this.storage.findTransactions({
          partial: { userId: this.userId, txid: this.txid }
        })
      )
    }

    if ((this.etx != null) && this.etx.status !== 'completed' && this.etx.status !== 'unproven' && this.etx.status !== 'nosend') {
      throw new WERR_INVALID_PARAMETER(
        'tx',
        `target transaction of internalizeAction has invalid status ${this.etx.status}.`
      )
    }
    this.isMerge = this.etx != null
    if (existingNewAction != null) this.newActionId = existingNewAction.actionId

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
        // merging with an existing user output
        if (basket.eo.basketId === this.changeBasket.basketId) {
          // converting a change output to a user basket custom output
          this.satoshis -= basket.txo.satoshis!
        }
      }
    }

    for (const payment of this.walletPayments) {
      if (this.isMerge) {
        if (payment.eo != null) {
          // merging with an existing user output
          if (payment.eo.basketId === this.changeBasket.basketId) {
            // ignore attempts to internalize an existing change output.
            payment.ignore = true
          } else {
            // converting an existing non-change output to change... increases net satoshis
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
  async validateAtomicBeef (atomicBeef: number[]) {
    const ab = Beef.fromBinary(atomicBeef)
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
    const reference = randomBytesBase64(7)
    const newTx: TableTransaction = {
      created_at: now,
      updated_at: now,
      transactionId: 0,

      provenTxId,
      status,

      satoshis,

      version: this.tx.version,
      lockTime: this.tx.lockTime,
      reference,
      userId: this.userId,
      isOutgoing: false,
      description: this.args.description,

      inputBEEF: undefined,
      txid: this.txid,
      rawTx: undefined
    }

    // new-schema wiring — call site 2a: findOrInsertTransaction → findOrCreateActionForTxid
    // Do the new-schema write FIRST (so processing state is authoritative) then fall through to
    // legacy write for backward compat with code paths still reading legacy tables.
    // TODO(post-cutover): remove legacy write once all read paths use new transactions tables.
    const txSvc = this.storage.getTransactionService()
    if (txSvc != null) {
      try {
        const processing = (provenTx != null) ? 'confirmed' as const : 'queued' as const
        const { action, isNew: isNewTx } = await txSvc.findOrCreateActionForTxid({
          userId: this.userId,
          txid: this.txid,
          isOutgoing: false,
          description: this.args.description ?? '',
          satoshisDelta: satoshis,
          reference,
          processing,
          now
        })
        this.newActionId = action.actionId

        if (!isNewTx) {
          // Merge path: new schema row already exists — update satoshisDelta to reflect
          // the additional satoshis being added by this internalize call.
          // new-schema wiring — call site 2b: updateTransaction(satoshis) → updateActionSatoshisDelta
          // TODO(post-cutover): remove legacy updateTransaction once read paths use new-schema.
          await txSvc.updateActionSatoshisDelta(action.actionId, action.satoshisDelta + satoshis, now)
        }
      } catch (txErr) {
        if (!isPreCutoverError(txErr)) throw txErr
        // Pre-cutover: continue with legacy path only
      }
    }

    // Legacy write path — TODO(post-cutover): remove once all read paths use new transactions tables.
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
      // TODO(post-cutover): updateTransaction targets legacy table post-cutover.
      await this.storage.updateTransaction(tr.tx.transactionId, update)
    }
    return tr.tx
  }

  async mergedInternalize () {
    const transactionId = this.etx!.transactionId

    await this.addLabels(transactionId)

    for (const payment of this.walletPayments) {
      if ((payment.eo != null) && !payment.ignore) await this.mergeWalletPaymentForOutput(transactionId, payment)
      else if (!payment.ignore) await this.storeNewWalletPaymentForOutput(transactionId, payment)
    }

    for (const basket of this.basketInsertions) {
      if (basket.eo != null) await this.mergeBasketInsertionForOutput(transactionId, basket)
      else await this.storeNewBasketInsertionForOutput(transactionId, basket)
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

      // new-schema wiring — call site 3: findOrInsertProvenTx (bump present) → createWithProof
      // Creates the new transactions row directly in `proven` state with all proof
      // columns populated. If the row already exists (race / merge), use recordProof.
      // Do new-schema write FIRST; legacy write follows for backward compat.
      // TODO(post-cutover): remove legacy findOrInsertProvenTx once all read paths use new-schema.
      const txSvcBump = this.storage.getTransactionService()
      if (txSvcBump != null) {
        try {
          const existingNewTx = await txSvcBump.findByTxid(this.txid)
          if (existingNewTx == null) {
            await txSvcBump.createWithProof({
              txid: this.txid,
              rawTx: Array.from(btx.rawTx!),
              inputBeef: Array.from(this.ab.toBinary()),
              height: bump.blockHeight,
              merklePath: bump.toBinary(),
              merkleRoot,
              blockHash: hash,
              now
            })
          } else {
            // new schema row exists — record the proof (transitions to confirmed if not already).
            await txSvcBump.recordProof({
              txid: existingNewTx.txid,
              height: bump.blockHeight,
              merklePath: bump.toBinary(),
              merkleRoot,
              blockHash: hash,
              expectedFrom: existingNewTx.processing,
              now
            })
          }
        } catch (txErr) {
          if (!isPreCutoverError(txErr)) throw txErr
          // Pre-cutover: continue with legacy path only
        }
      }

      // Legacy write path — TODO(post-cutover): remove once all read paths use new transactions tables.
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
      pr.proven = provenTxR.proven
    }

    this.etx = await this.findOrInsertTargetTransaction(this.satoshis, pr.proven)

    const transactionId = this.etx.transactionId

    if (pr.proven == null) {
      // beef doesn't include proof of mining for the transaction (etx).
      // the new transaction record has been added to storage, but (baring race conditions)
      // there should be no provenTx or provenTxReq records for this txid.
      //
      // Attempt to create a provenTxReq record for the txid to obtain a proof,
      // while allowing for possible race conditions...

      // new-schema wiring — call site 4: getProvenOrReq (bump absent) → findOrCreateForBroadcast
      // Ensures a new transactions row in `queued` state exists for the broadcast queue.
      // Do new-schema write FIRST; legacy getProvenOrReq follows for backward compat.
      // TODO(post-cutover): remove legacy getProvenOrReq once all read paths use new transactions tables.
      const txSvcReq = this.storage.getTransactionService()
      if (txSvcReq != null) {
        try {
          await txSvcReq.findOrCreateForBroadcast({
            txid: this.txid,
            rawTx: Array.from(this.tx.toBinary()),
            inputBeef: Array.from(this.ab.toBinary()),
            processing: 'queued'
          })
        } catch (txErr) {
          if (!isPreCutoverError(txErr)) throw txErr
          // Pre-cutover: continue with legacy path only
        }
      }

      // Legacy write path — TODO(post-cutover): remove once all read paths use new transactions tables.
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
        beef: Beef.fromBinary(this.args.tx),
        details: [{ txid: this.txid, status: 'readyToSend', req: pr.req }]
      }
      const { swr, ndr } = await shareReqsWithWorld(this.storage, this.userId, [], false, r)
      if (ndr![0].status !== 'success') {
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
    // new-schema wiring — label map key: post-cutover `tx_labels_map.transactionId` = actions.actionId.
    // Use newActionId if the new schema row was created (set by findOrInsertTargetTransaction or
    // asyncSetup).  Fall back to the legacy transactionId for pre-cutover / StorageIdb.
    // TODO(post-cutover): remove fallback once all DBs are post-cutover.
    const labelTransactionId = this.newActionId ?? transactionId
    for (const label of this.vargs.labels) {
      const txLabel = await this.storage.findOrInsertTxLabel(this.userId, label)
      await this.storage.findOrInsertTxLabelMap(verifyId(labelTransactionId), verifyId(txLabel.txLabelId))
    }
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
