import { TransactionStatus } from '../../../sdk/types'
import { TrxToken } from '../../../sdk/WalletStorage.interfaces'
import { optionalArraysEqual, verifyId, verifyOneOrNone } from '../../../utility/utilityHelpers'
import { brc177NoSendExpiryStateRank } from '../../../utility/brc177NoSendExpiry'
import { TableOutput } from '../tables/TableOutput'
import { TableTransaction } from '../tables/TableTransaction'
import { EntityBase, EntityStorage, SyncMap } from './EntityBase'
import { EntityProvenTx } from './EntityProvenTx'
import { Transaction as BsvTransaction, TransactionInput } from '@bsv/sdk'

function earliestDefined (a: number | undefined, b: number | undefined): number | undefined {
  if (a == null) return b
  if (b == null) return a
  return Math.min(a, b)
}

type NoSendExpirySnapshot = Pick<
  TableTransaction,
  | 'noSendExpiryMode'
  | 'noSendExpiryValue'
  | 'noSendExpiryDeadline'
  | 'noSendExpiryState'
  | 'noSendExpiryAnchorTxid'
  | 'noSendExpiryAnchorVout'
  | 'noSendExpiryReleasedAt'
  | 'noSendExpiryObservedAt'
  | 'noSendExpiryReclaimTxid'
  | 'noSendExpiryReclaimRawTx'
  | 'noSendExpiryReclaimDerivationPrefix'
  | 'noSendExpiryReclaimDerivationSuffix'
  | 'noSendExpiryReclaimSatoshis'
>

function noSendExpirySnapshot (transaction: TableTransaction): NoSendExpirySnapshot {
  return {
    noSendExpiryMode: transaction.noSendExpiryMode,
    noSendExpiryValue: transaction.noSendExpiryValue,
    noSendExpiryDeadline: transaction.noSendExpiryDeadline,
    noSendExpiryState: transaction.noSendExpiryState,
    noSendExpiryAnchorTxid: transaction.noSendExpiryAnchorTxid,
    noSendExpiryAnchorVout: transaction.noSendExpiryAnchorVout,
    noSendExpiryReleasedAt: transaction.noSendExpiryReleasedAt,
    noSendExpiryObservedAt: transaction.noSendExpiryObservedAt,
    noSendExpiryReclaimTxid: transaction.noSendExpiryReclaimTxid,
    noSendExpiryReclaimRawTx: transaction.noSendExpiryReclaimRawTx,
    noSendExpiryReclaimDerivationPrefix: transaction.noSendExpiryReclaimDerivationPrefix,
    noSendExpiryReclaimDerivationSuffix: transaction.noSendExpiryReclaimDerivationSuffix,
    noSendExpiryReclaimSatoshis: transaction.noSendExpiryReclaimSatoshis
  }
}

function mergeNoSendExpiryMetadata (
  target: TableTransaction,
  current: NoSendExpirySnapshot,
  incoming: TableTransaction,
  lifecycleAdvanced: boolean,
  targetWinnerSupersedesReclaim: boolean
): void {
  target.noSendExpiryMode = current.noSendExpiryMode ?? incoming.noSendExpiryMode
  target.noSendExpiryValue = current.noSendExpiryValue ?? incoming.noSendExpiryValue
  target.noSendExpiryDeadline = earliestDefined(current.noSendExpiryDeadline, incoming.noSendExpiryDeadline)

  target.noSendExpiryState = current.noSendExpiryState
  if (lifecycleAdvanced) target.noSendExpiryState = incoming.noSendExpiryState
  if (targetWinnerSupersedesReclaim) target.noSendExpiryState = 'target-won'

  target.noSendExpiryAnchorTxid = current.noSendExpiryAnchorTxid ?? incoming.noSendExpiryAnchorTxid
  target.noSendExpiryAnchorVout = current.noSendExpiryAnchorVout ?? incoming.noSendExpiryAnchorVout
  target.noSendExpiryReleasedAt = earliestDefined(
    current.noSendExpiryReleasedAt,
    incoming.noSendExpiryReleasedAt
  )
  target.noSendExpiryObservedAt = earliestDefined(
    current.noSendExpiryObservedAt,
    incoming.noSendExpiryObservedAt
  )
  target.noSendExpiryReclaimTxid = current.noSendExpiryReclaimTxid ?? incoming.noSendExpiryReclaimTxid
  target.noSendExpiryReclaimRawTx = current.noSendExpiryReclaimRawTx ?? incoming.noSendExpiryReclaimRawTx
  target.noSendExpiryReclaimDerivationPrefix =
    current.noSendExpiryReclaimDerivationPrefix ?? incoming.noSendExpiryReclaimDerivationPrefix
  target.noSendExpiryReclaimDerivationSuffix =
    current.noSendExpiryReclaimDerivationSuffix ?? incoming.noSendExpiryReclaimDerivationSuffix
  target.noSendExpiryReclaimSatoshis =
    current.noSendExpiryReclaimSatoshis ?? incoming.noSendExpiryReclaimSatoshis
}

function carriesProofEvidence (transaction: TableTransaction): boolean {
  // `completed` is a useful conservative signal, but only a mapped provenTx
  // record carries the proof material that may advance BRC-177 finality.
  return transaction.provenTxId != null
}

function mappedProvenTxId (incoming: TableTransaction, syncMap: SyncMap): number | undefined {
  return incoming.provenTxId == null ? undefined : syncMap.provenTx.idMap[incoming.provenTxId]
}

function mergeOrdinaryTransactionProperties (
  target: TableTransaction,
  incoming: TableTransaction,
  syncMap: SyncMap
): void {
  target.version = incoming.version
  target.lockTime = incoming.lockTime
  target.isOutgoing = incoming.isOutgoing
  target.status = incoming.status
  target.provenTxId = mappedProvenTxId(incoming, syncMap)
  target.satoshis = incoming.satoshis
  target.txid = incoming.txid
  target.description = incoming.description
  target.rawTx = incoming.rawTx
  target.inputBEEF = incoming.inputBEEF
}

function mergeProofEvidence (
  target: TableTransaction,
  incoming: TableTransaction,
  syncMap: SyncMap
): void {
  target.status = incoming.status
  target.provenTxId = mappedProvenTxId(incoming, syncMap)
  target.rawTx ??= incoming.rawTx
  target.inputBEEF ??= incoming.inputBEEF
}

async function quarantineReclaimOutput (
  storage: EntityStorage,
  target: TableTransaction,
  reclaimTxid: string | undefined,
  trx?: TrxToken
): Promise<void> {
  if (reclaimTxid == null) return
  const reclaimOutput = verifyOneOrNone(
    await storage.findOutputs({
      partial: { userId: target.userId, txid: reclaimTxid, vout: 0 },
      trx
    })
  )
  if (reclaimOutput?.spendable) {
    await storage.updateOutput(reclaimOutput.outputId, { spendable: false }, trx)
  }
}

export class EntityTransaction extends EntityBase<TableTransaction> {
  /**
   * @returns @bsv/sdk Transaction object from parsed rawTx.
   * If rawTx is undefined, returns undefined.
   */
  getBsvTx (): BsvTransaction | undefined {
    if (this.rawTx == null) return undefined
    return BsvTransaction.fromBinary(this.rawTx)
  }

  /**
   * @returns array of @bsv/sdk TransactionInput objects from parsed rawTx.
   * If rawTx is undefined, an empty array is returned.
   */
  getBsvTxIns (): TransactionInput[] {
    const tx = this.getBsvTx()
    if (tx == null) return []
    return tx.inputs
  }

  /**
   * Returns an array of "known" inputs to this transaction which belong to the same userId.
   * Uses both spentBy and rawTx inputs (if available) to locate inputs from among user's outputs.
   * Not all transaction inputs correspond to prior storage outputs.
   */
  async getInputs (storage: EntityStorage, trx?: TrxToken): Promise<TableOutput[]> {
    const inputs = await storage.findOutputs({
      partial: { userId: this.userId, spentBy: this.id },
      trx
    })
    // Merge "inputs" by spentBy and userId
    for (const input of this.getBsvTxIns()) {
      // console.log(`getInputs of ${this.id}: ${input.txid()} ${input.txOutNum}`)
      const pso = verifyOneOrNone(
        await storage.findOutputs({
          partial: {
            userId: this.userId,
            txid: input.sourceTXID,
            vout: input.sourceOutputIndex
          },
          trx
        })
      )
      if ((pso != null) && !inputs.some(i => i.outputId === pso.outputId)) inputs.push(pso)
    }
    return inputs
  }

  constructor (api?: TableTransaction) {
    const now = new Date()
    super(
      api || {
        transactionId: 0,
        created_at: now,
        updated_at: now,
        userId: 0,
        txid: '',
        status: 'unprocessed',
        reference: '',
        satoshis: 0,
        description: '',
        isOutgoing: false,
        rawTx: undefined,
        inputBEEF: undefined
      }
    )
  }

  override updateApi (): void {
    /* nothing needed yet... */
  }

  get transactionId () {
    return this.api.transactionId
  }

  set transactionId (v: number) {
    this.api.transactionId = v
  }

  get created_at () {
    return this.api.created_at
  }

  set created_at (v: Date) {
    this.api.created_at = v
  }

  get updated_at () {
    return this.api.updated_at
  }

  set updated_at (v: Date) {
    this.api.updated_at = v
  }

  get version () {
    return this.api.version
  }

  set version (v: number | undefined) {
    this.api.version = v
  }

  get lockTime () {
    return this.api.lockTime
  }

  set lockTime (v: number | undefined) {
    this.api.lockTime = v
  }

  get isOutgoing () {
    return this.api.isOutgoing
  }

  set isOutgoing (v: boolean) {
    this.api.isOutgoing = v
  }

  get status () {
    return this.api.status
  }

  set status (v: TransactionStatus) {
    this.api.status = v
  }

  get userId () {
    return this.api.userId
  }

  set userId (v: number) {
    this.api.userId = v
  }

  get provenTxId () {
    return this.api.provenTxId
  }

  set provenTxId (v: number | undefined) {
    this.api.provenTxId = v
  }

  get satoshis () {
    return this.api.satoshis
  }

  set satoshis (v: number) {
    this.api.satoshis = v
  }

  get txid () {
    return this.api.txid
  }

  set txid (v: string | undefined) {
    this.api.txid = v
  }

  get reference () {
    return this.api.reference
  }

  set reference (v: string) {
    this.api.reference = v
  }

  get inputBEEF () {
    return this.api.inputBEEF
  }

  set inputBEEF (v: number[] | undefined) {
    this.api.inputBEEF = v
  }

  get description () {
    return this.api.description
  }

  set description (v: string) {
    this.api.description = v
  }

  get rawTx () {
    return this.api.rawTx
  }

  set rawTx (v: number[] | undefined) {
    this.api.rawTx = v
  }

  get noSendExpiryMode () {
    return this.api.noSendExpiryMode
  }
  set noSendExpiryMode (v) {
    this.api.noSendExpiryMode = v
  }
  get noSendExpiryValue () {
    return this.api.noSendExpiryValue
  }
  set noSendExpiryValue (v) {
    this.api.noSendExpiryValue = v
  }
  get noSendExpiryDeadline () {
    return this.api.noSendExpiryDeadline
  }
  set noSendExpiryDeadline (v) {
    this.api.noSendExpiryDeadline = v
  }
  get noSendExpiryState () {
    return this.api.noSendExpiryState
  }
  set noSendExpiryState (v) {
    this.api.noSendExpiryState = v
  }
  get noSendExpiryAnchorTxid () {
    return this.api.noSendExpiryAnchorTxid
  }
  set noSendExpiryAnchorTxid (v) {
    this.api.noSendExpiryAnchorTxid = v
  }
  get noSendExpiryAnchorVout () {
    return this.api.noSendExpiryAnchorVout
  }
  set noSendExpiryAnchorVout (v) {
    this.api.noSendExpiryAnchorVout = v
  }
  get noSendExpiryReleasedAt () {
    return this.api.noSendExpiryReleasedAt
  }
  set noSendExpiryReleasedAt (v) {
    this.api.noSendExpiryReleasedAt = v
  }
  get noSendExpiryObservedAt () {
    return this.api.noSendExpiryObservedAt
  }
  set noSendExpiryObservedAt (v) {
    this.api.noSendExpiryObservedAt = v
  }
  get noSendExpiryReclaimTxid () {
    return this.api.noSendExpiryReclaimTxid
  }
  set noSendExpiryReclaimTxid (v) {
    this.api.noSendExpiryReclaimTxid = v
  }
  get noSendExpiryReclaimRawTx () {
    return this.api.noSendExpiryReclaimRawTx
  }
  set noSendExpiryReclaimRawTx (v) {
    this.api.noSendExpiryReclaimRawTx = v
  }
  get noSendExpiryReclaimDerivationPrefix () {
    return this.api.noSendExpiryReclaimDerivationPrefix
  }
  set noSendExpiryReclaimDerivationPrefix (v) {
    this.api.noSendExpiryReclaimDerivationPrefix = v
  }
  get noSendExpiryReclaimDerivationSuffix () {
    return this.api.noSendExpiryReclaimDerivationSuffix
  }
  set noSendExpiryReclaimDerivationSuffix (v) {
    this.api.noSendExpiryReclaimDerivationSuffix = v
  }
  get noSendExpiryReclaimSatoshis () {
    return this.api.noSendExpiryReclaimSatoshis
  }
  set noSendExpiryReclaimSatoshis (v) {
    this.api.noSendExpiryReclaimSatoshis = v
  }

  // Extended (computed / dependent entity) Properties
  // get labels() { return this.api.labels }
  // set labels(v: string[] | undefined) { this.api.labels = v }

  override get id (): number {
    return this.api.transactionId
  }

  override set id (v: number) {
    this.api.transactionId = v
  }

  override get entityName (): string {
    return 'transaction'
  }

  override get entityTable (): string {
    return 'transactions'
  }

  override equals (ei: TableTransaction, syncMap?: SyncMap | undefined): boolean {
    const eo = this.toApi()

    // Properties that are never updated
    if (
      eo.transactionId === ((syncMap != null) ? syncMap.transaction.idMap[verifyId(ei.transactionId)] : ei.transactionId) &&
      eo.reference === ei.reference &&
      eo.version === ei.version &&
      eo.lockTime === ei.lockTime &&
      eo.isOutgoing === ei.isOutgoing &&
      eo.status === ei.status &&
      eo.satoshis === ei.satoshis &&
      eo.txid === ei.txid &&
      eo.description === ei.description &&
      optionalArraysEqual(eo.rawTx, ei.rawTx) &&
      optionalArraysEqual(eo.inputBEEF, ei.inputBEEF) &&
      optionalArraysEqual(eo.noSendExpiryReclaimRawTx, ei.noSendExpiryReclaimRawTx) &&
      eo.noSendExpiryMode === ei.noSendExpiryMode &&
      eo.noSendExpiryValue === ei.noSendExpiryValue &&
      eo.noSendExpiryDeadline === ei.noSendExpiryDeadline &&
      eo.noSendExpiryState === ei.noSendExpiryState &&
      eo.noSendExpiryAnchorTxid === ei.noSendExpiryAnchorTxid &&
      eo.noSendExpiryAnchorVout === ei.noSendExpiryAnchorVout &&
      eo.noSendExpiryReleasedAt === ei.noSendExpiryReleasedAt &&
      eo.noSendExpiryObservedAt === ei.noSendExpiryObservedAt &&
      eo.noSendExpiryReclaimTxid === ei.noSendExpiryReclaimTxid &&
      eo.noSendExpiryReclaimDerivationPrefix === ei.noSendExpiryReclaimDerivationPrefix &&
      eo.noSendExpiryReclaimDerivationSuffix === ei.noSendExpiryReclaimDerivationSuffix &&
      eo.noSendExpiryReclaimSatoshis === ei.noSendExpiryReclaimSatoshis &&
      (eo.provenTxId == null) === (ei.provenTxId == null) &&
      !(ei.provenTxId && eo.provenTxId !== ((syncMap != null) ? syncMap.provenTx.idMap[verifyId(ei.provenTxId)] : ei.provenTxId))
    ) { return true }

    return false
  }

  static async mergeFind (
    storage: EntityStorage,
    userId: number,
    ei: TableTransaction,
    syncMap: SyncMap,
    trx?: TrxToken
  ): Promise<{ found: boolean, eo: EntityTransaction, eiId: number }> {
    // Prefer (userId, txid) when txid is known — txid is a globally stable
    // identifier, whereas `reference` is locally-assigned by whichever
    // storage first ingested the row. Two storages that independently
    // internalized the same txid will hold different references, and
    // matching by reference would insert a duplicate row instead of
    // merging. Fall through to reference when the txid lookup misses so
    // post-broadcast syncs land on an existing pre-broadcast row that
    // hasn't learned its txid yet.
    let ef: TableTransaction | undefined
    if (ei.txid) {
      ef = verifyOneOrNone(await storage.findTransactions({ partial: { txid: ei.txid, userId }, trx }))
    }
    if ((ef == null) && ei.reference) {
      ef = verifyOneOrNone(await storage.findTransactions({ partial: { reference: ei.reference, userId }, trx }))
    }
    return {
      found: ef != null,
      eo: new EntityTransaction(ef || { ...ei }),
      eiId: verifyId(ei.transactionId)
    }
  }

  override async mergeNew (storage: EntityStorage, userId: number, syncMap: SyncMap, trx?: TrxToken): Promise<void> {
    if (this.provenTxId) this.provenTxId = syncMap.provenTx.idMap[this.provenTxId]
    this.userId = userId
    this.transactionId = 0
    this.transactionId = await storage.insertTransaction(this.toApi(), trx)
  }

  override async mergeExisting (
    storage: EntityStorage,
    since: Date | undefined,
    ei: TableTransaction,
    syncMap: SyncMap,
    trx?: TrxToken
  ): Promise<boolean> {
    const currentExpiryRank = brc177NoSendExpiryStateRank(this.noSendExpiryState)
    const incomingExpiryRank = brc177NoSendExpiryStateRank(ei.noSendExpiryState)
    const lifecycleAdvanced = incomingExpiryRank > currentExpiryRank
    const incomingCarriesProof = carriesProofEvidence(ei)
    const addsProofEvidence = incomingCarriesProof && !carriesProofEvidence(this.api)
    const targetWinnerSupersedesReclaim =
      this.noSendExpiryState === 'reclaimed' &&
      (ei.noSendExpiryState === 'target-won' || incomingCarriesProof)
    const incomingIsNewer = ei.updated_at > this.updated_at
    const shouldMerge =
      lifecycleAdvanced ||
      addsProofEvidence ||
      (incomingIsNewer && (incomingExpiryRank >= currentExpiryRank || incomingCarriesProof))
    if (!shouldMerge) return false

    const currentExpiry = noSendExpirySnapshot(this.api)
    // Properties that are never updated:
    // transactionId
    // userId
    // reference

    // A stale storage can carry a more advanced BRC-177 state because wall
    // clocks differ. In that case merge only lifecycle data; overwriting the
    // rest of the row would regress newer proof and transaction state. The
    // one exception is positive local proof evidence, which must reach a
    // reclaiming storage so the race can be resolved safely.
    const mergeOrdinaryProperties =
      incomingIsNewer && (incomingExpiryRank >= currentExpiryRank || incomingCarriesProof)
    if (mergeOrdinaryProperties) {
      mergeOrdinaryTransactionProperties(this.api, ei, syncMap)
    } else if (incomingCarriesProof) {
      // Proof evidence is independently monotonic and cannot be discarded
      // merely because the proving store's wall clock is behind. Avoid
      // copying unrelated stale row fields while retaining the proof link.
      mergeProofEvidence(this.api, ei, syncMap)
    }
    mergeNoSendExpiryMetadata(this.api, currentExpiry, ei, lifecycleAdvanced, targetWinnerSupersedesReclaim)
    this.updated_at = new Date(Math.max(ei.updated_at.getTime(), this.updated_at.getTime()))
    // Knex serialization mutates its update object. Keep this entity's Date
    // and byte-array representation intact for any subsequent sync merge in
    // the same cycle.
    await storage.updateTransaction(this.id, { ...this.toApi() }, trx)
    if (targetWinnerSupersedesReclaim) {
      // Lifecycle rank deliberately gives a contradictory target proof the
      // conservative precedence. Output rows still use timestamp merging,
      // so quarantine reclaimed liquidity here even when clock skew would
      // otherwise leave that output spendable.
      await quarantineReclaimOutput(storage, this.api, this.noSendExpiryReclaimTxid, trx)
    }
    return true
  }

  async getProvenTx (storage: EntityStorage, trx?: TrxToken): Promise<EntityProvenTx | undefined> {
    if (!this.provenTxId) return undefined
    const p = verifyOneOrNone(
      await storage.findProvenTxs({
        partial: { provenTxId: this.provenTxId },
        trx
      })
    )
    if (p == null) return undefined
    return new EntityProvenTx(p)
  }
}
