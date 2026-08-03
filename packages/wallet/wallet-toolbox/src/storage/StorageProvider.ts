import {
  AbortActionResult,
  Beef,
  InternalizeActionArgs,
  ListActionsResult,
  ListOutputsResult,
  PubKeyHex,
  ListCertificatesResult,
  TrustSelf,
  RelinquishCertificateArgs,
  RelinquishOutputArgs,
  AbortActionArgs,
  Validation,
  WalletLoggerInterface,
  ChainTracker,
  Transaction
} from '@bsv/sdk'
import type { SpendVerifierInterface } from '@bsv/sdk'
import {
  classifyReqStatus,
  mergeInputsIntoBeef,
  mergeInputBeefs,
  notifyTransactionsOfProof
} from './storageProviderHelpers'
import { getBeefForTransaction } from './methods/getBeefForTransaction'
import { GetReqsAndBeefDetail, GetReqsAndBeefResult, processAction } from './methods/processAction'
import { attemptToPostReqsToNetwork, PostReqsToNetworkResult } from './methods/attemptToPostReqsToNetwork'
import { listCertificates } from './methods/listCertificates'
import { createAction } from './methods/createAction'
import { internalizeAction } from './methods/internalizeAction'
import { StorageReaderWriter, StorageReaderWriterOptions } from './StorageReaderWriter'
import { EntityProvenTx, EntityProvenTxReq, EntitySyncState, EntityTransaction } from './schema/entities'
import { ServicesCallHistory, WalletServices } from '../sdk/WalletServices.interfaces'
import {
  AuthId,
  FindCertificatesArgs,
  FindOutputBasketsArgs,
  FindOutputsArgs,
  FindStaleMerkleRootsArgs,
  ProcessSyncChunkResult,
  ProvenOrRawTx,
  PurgeParams,
  PurgeResults,
  RequestSyncChunkArgs,
  StorageCreateActionResult,
  StorageFeeModel,
  StorageGetBeefOptions,
  StorageInternalizeActionResult,
  StorageProcessActionArgs,
  StorageProcessActionResults,
  StorageProvenOrReq,
  SyncChunk,
  TrxToken,
  UpdateProvenTxReqWithNewProvenTxArgs,
  UpdateProvenTxReqWithNewProvenTxResult,
  WalletStorageProvider
} from '../sdk/WalletStorage.interfaces'
import { Chain, TransactionStatus } from '../sdk/types'
import { TableProvenTxReq, TableProvenTxReqDynamics } from '../../src/storage/schema/tables/TableProvenTxReq'
import { TableOutputBasket } from '../../src/storage/schema/tables/TableOutputBasket'
import { TableTransaction } from '../../src/storage/schema/tables/TableTransaction'
import { TableOutput, TableOutputX } from '../../src/storage/schema/tables/TableOutput'
import { TableOutputTag } from '../../src/storage/schema/tables/TableOutputTag'
import { TableTxLabel } from '../../src/storage/schema/tables/TableTxLabel'
import { TableMonitorEvent } from '../../src/storage/schema/tables/TableMonitorEvent'
import { TableUser } from '../../src/storage/schema/tables/TableUser'
import { TableCertificateX } from './schema/tables/TableCertificate'
import {
  WERR_INTERNAL,
  WERR_INVALID_MERKLE_ROOT,
  WERR_INVALID_OPERATION,
  WERR_INVALID_PARAMETER,
  WERR_MISSING_PARAMETER,
  WERR_NOT_IMPLEMENTED,
  WERR_UNAUTHORIZED
} from '../sdk/WERR_errors'
import { verifyId, verifyOne, verifyOneOrNone, verifyTruthy } from '../utility/utilityHelpers'
import { WalletError } from '../sdk/WalletError'
import { asArray, asString } from '../utility/utilityHelpers.noBuffer'
import { TableActionBatch, TableActionBatchBlob, TableActionBatchOutput } from './schema/tables/TableActionBatch'
import {
  AbortActionBatchResult,
  ActionBatchManifest,
  BeginActionBatchArgs,
  BeginActionBatchResult,
  CommitActionBatchByDigestArgs,
  CommitActionBatchResult,
  ExtendActionBatchArgs,
  ExtendActionBatchResult,
  PrepareActionBatchCommitResult,
  PutActionBatchBlobArgs,
  PutActionBatchPackArgs,
  RenewActionBatchResult,
  StorageCapabilities
} from '../sdk/ActionBatch.interfaces'
import {
  abortActionBatch as abortBatch,
  beginActionBatch as beginBatch,
  cleanupExpiredActionBatches,
  commitActionBatch as commitBatch,
  commitActionBatchByDigest as commitBatchByDigest,
  extendActionBatch as extendBatch,
  getActionBatchCapabilities,
  renewActionBatch as renewBatch
} from './methods/actionBatch'
import {
  prepareActionBatchCommit as prepareBatchCommit,
  putActionBatchBlob as putBatchBlob,
  putActionBatchPack as putBatchPack
} from './methods/actionBatchBlobs'
import { availableManagedChange } from './methods/availableManagedChange'

export abstract class StorageProvider extends StorageReaderWriter implements WalletStorageProvider {
  isDirty = false
  _services?: WalletServices
  feeModel: StorageFeeModel
  commissionSatoshis: number
  commissionPubKeyHex?: PubKeyHex
  maxRecursionDepth?: number
  readonly scriptVerifier?: SpendVerifierInterface

  static defaultOptions(): { feeModel: StorageFeeModel; commissionSatoshis: number; commissionPubKeyHex: undefined } {
    const opts: { feeModel: StorageFeeModel; commissionSatoshis: number; commissionPubKeyHex: undefined } = {
      feeModel: { model: 'sat/kb', value: 100 },
      commissionSatoshis: 0,
      commissionPubKeyHex: undefined
    }
    return opts
  }

  static createStorageBaseOptions(chain: Chain): StorageProviderOptions {
    const options: StorageProviderOptions = {
      ...StorageProvider.defaultOptions(),
      chain
    }
    return options
  }

  constructor(options: StorageProviderOptions) {
    super(options)
    this.feeModel = options.feeModel
    this.commissionPubKeyHex = options.commissionPubKeyHex
    this.commissionSatoshis = options.commissionSatoshis
    this.maxRecursionDepth = 12
    this.scriptVerifier = options.scriptVerifier
  }

  abstract reviewStatus(args: { agedLimit: Date; trx?: TrxToken }): Promise<{ log: string }>

  abstract purgeData(params: PurgeParams, trx?: TrxToken): Promise<PurgeResults>

  abstract allocateChangeInput(
    userId: number,
    basketId: number,
    targetSatoshis: number,
    exactSatoshis: number | undefined,
    excludeSending: boolean,
    transactionId: number
  ): Promise<TableOutput | undefined>

  /** Mark a planned set of change inputs spent within the caller's transaction. */
  async markChangeInputsSpent(outputIds: number[], transactionId: number, trx: TrxToken): Promise<number> {
    let updated = 0
    const current = await this.findOutputsByIds(outputIds, trx)
    for (const outputId of outputIds) {
      const output = current[outputId]
      if (output == null || !output.spendable || output.spentBy != null) continue
      updated += await this.updateOutput(outputId, { spendable: false, spentBy: transactionId }, trx)
    }
    return updated
  }

  /** Return unreserved wallet-managed outputs eligible for automatic funding. */
  async findAvailableManagedChangeInputs(
    userId: number,
    basketId: number,
    excludeSending: boolean,
    trx?: TrxToken
  ): Promise<TableOutput[]> {
    return await availableManagedChange(this, userId, basketId, excludeSending, trx)
  }

  /** Read the current status of a set of source transactions without loading raw transaction bytes. */
  async findTransactionStatusesByIds(
    userId: number,
    transactionIds: number[],
    trx?: TrxToken
  ): Promise<Map<number, TransactionStatus>> {
    const statuses = new Map<number, TransactionStatus>()
    for (const transactionId of new Set(transactionIds)) {
      const transaction = await this.findTransactionById(transactionId, trx, true)
      if (transaction?.userId === userId) statuses.set(transactionId, transaction.status)
    }
    return statuses
  }

  abstract getProvenOrRawTx(txid: string, trx?: TrxToken): Promise<ProvenOrRawTx>
  abstract getRawTxOfKnownValidTransaction(
    txid?: string,
    offset?: number,
    length?: number,
    trx?: TrxToken
  ): Promise<number[] | undefined>

  abstract getLabelsForTransactionId(transactionId?: number, trx?: TrxToken): Promise<TableTxLabel[]>
  abstract getTagsForOutputId(outputId: number, trx?: TrxToken): Promise<TableOutputTag[]>

  abstract listActions(auth: AuthId, args: Validation.ValidListActionsArgs): Promise<ListActionsResult>
  abstract listOutputs(auth: AuthId, args: Validation.ValidListOutputsArgs): Promise<ListOutputsResult>

  abstract countChangeInputs(userId: number, basketId: number, excludeSending: boolean): Promise<number>

  async insertActionBatch(_batch: TableActionBatch, _trx?: TrxToken): Promise<number> {
    throw new WERR_NOT_IMPLEMENTED()
  }
  async findActionBatch(_userId: number, _batchId: string, _trx?: TrxToken): Promise<TableActionBatch | undefined> {
    throw new WERR_NOT_IMPLEMENTED()
  }
  async findActionBatchForUpdate(
    userId: number,
    batchId: string,
    trx: TrxToken
  ): Promise<TableActionBatch | undefined> {
    return await this.findActionBatch(userId, batchId, trx)
  }

  async findExpiredActionBatches(_now: Date, _trx?: TrxToken): Promise<TableActionBatch[]> {
    throw new WERR_NOT_IMPLEMENTED()
  }
  async updateActionBatch(
    _actionBatchId: number,
    _update: Partial<TableActionBatch>,
    _trx?: TrxToken
  ): Promise<number> {
    throw new WERR_NOT_IMPLEMENTED()
  }
  async deleteActionBatch(_actionBatchId: number, _trx?: TrxToken): Promise<void> {
    throw new WERR_NOT_IMPLEMENTED()
  }
  async reserveActionBatchOutputs(_reservations: TableActionBatchOutput[], _trx?: TrxToken): Promise<void> {
    throw new WERR_NOT_IMPLEMENTED()
  }

  async findActionBatchOutputIds(_actionBatchId: number, _trx?: TrxToken): Promise<number[]> {
    throw new WERR_NOT_IMPLEMENTED()
  }
  async findReservedActionBatchOutputIds(_outputIds: number[], _trx?: TrxToken): Promise<number[]> {
    return []
  }
  async deleteActionBatchOutputReservations(_actionBatchId: number, _trx?: TrxToken): Promise<void> {
    throw new WERR_NOT_IMPLEMENTED()
  }
  async putActionBatchBlobRecord(_blob: TableActionBatchBlob, _trx?: TrxToken): Promise<void> {
    throw new WERR_NOT_IMPLEMENTED()
  }
  async findActionBatchBlobRecord(
    _actionBatchId: number,
    _digest: string,
    _trx?: TrxToken
  ): Promise<TableActionBatchBlob | undefined> {
    throw new WERR_NOT_IMPLEMENTED()
  }
  async findActionBatchBlobRecords(
    actionBatchId: number,
    digests: string[],
    trx?: TrxToken
  ): Promise<TableActionBatchBlob[]> {
    return (await Promise.all(
      digests.map(async digest => await this.findActionBatchBlobRecord(actionBatchId, digest, trx))
    )).filter((blob): blob is TableActionBatchBlob => blob != null)
  }
  async putActionBatchBlobRecords(blobs: TableActionBatchBlob[], trx?: TrxToken): Promise<void> {
    for (const blob of blobs) await this.putActionBatchBlobRecord(blob, trx)
  }

  async deleteActionBatchBlobRecords(_actionBatchId: number, _trx?: TrxToken): Promise<void> {
    throw new WERR_NOT_IMPLEMENTED()
  }

  async getCapabilities(): Promise<StorageCapabilities> {
    return this.supportsActionBatchPersistence() ? getActionBatchCapabilities() : {}
  }

  protected supportsActionBatchPersistence(): boolean {
    return false
  }

  async beginActionBatch(auth: AuthId, args: BeginActionBatchArgs): Promise<BeginActionBatchResult> {
    if (!this.supportsActionBatchPersistence())
      throw new WERR_NOT_IMPLEMENTED('actionBatch capability is not available')
    return await beginBatch(this, auth, args)
  }

  async extendActionBatch(auth: AuthId, args: ExtendActionBatchArgs): Promise<ExtendActionBatchResult> {
    return await extendBatch(this, auth, args)
  }

  async renewActionBatch(auth: AuthId, batchId: string): Promise<RenewActionBatchResult> {
    return await renewBatch(this, auth, batchId)
  }

  async prepareActionBatchCommit(auth: AuthId, manifest: ActionBatchManifest): Promise<PrepareActionBatchCommitResult> {
    return await prepareBatchCommit(this, auth, manifest)
  }

  async putActionBatchBlob(auth: AuthId, args: PutActionBatchBlobArgs): Promise<void> {
    return await putBatchBlob(this, auth, args)
  }

  async putActionBatchPack(auth: AuthId, args: PutActionBatchPackArgs): Promise<void> {
    return await putBatchPack(this, auth, args)
  }

  async commitActionBatch(auth: AuthId, manifest: ActionBatchManifest): Promise<CommitActionBatchResult> {
    return await commitBatch(this, auth, manifest)
  }

  async commitActionBatchByDigest(
    auth: AuthId,
    args: CommitActionBatchByDigestArgs
  ): Promise<CommitActionBatchResult> {
    return await commitBatchByDigest(this, auth, args)
  }

  async abortActionBatch(auth: AuthId, batchId: string): Promise<AbortActionBatchResult> {
    return await abortBatch(this, auth, batchId)
  }

  async findOutputsByIds(outputIds: number[], trx?: TrxToken): Promise<Record<number, TableOutput>> {
    const byId: Record<number, TableOutput> = {}
    for (const outputId of outputIds) {
      const o = verifyOneOrNone(await this.findOutputs({ partial: { outputId }, trx }))
      if (o?.outputId !== undefined) byId[o.outputId] = o
    }
    return byId
  }

  async findStaleMerkleRoots(args: FindStaleMerkleRootsArgs): Promise<string[]> {
    let provenTxs = await this.findProvenTxs({ partial: { height: args.height } })
    provenTxs = provenTxs.filter(ptx => ptx.merkleRoot !== args.merkleRoot)
    const roots = Array.from(new Set(provenTxs.map(ptx => ptx.merkleRoot)))
    return roots
  }

  async findOutputsByOutpoints(
    userId: number,
    outpoints: Array<{ txid: string; vout: number }>,
    trx?: TrxToken
  ): Promise<Record<string, TableOutput>> {
    const byOutpoint: Record<string, TableOutput> = {}
    for (const { txid, vout } of outpoints) {
      const o = verifyOneOrNone(await this.findOutputs({ partial: { userId, txid, vout }, trx }))
      if (o?.txid !== undefined && o.vout !== undefined) byOutpoint[`${o.txid}.${o.vout}`] = o
    }
    return byOutpoint
  }

  async findOutputsByOutpointsForUpdate(
    userId: number,
    outpoints: Array<{ txid: string; vout: number }>,
    trx: TrxToken,
    noScript = false
  ): Promise<Record<string, TableOutput>> {
    const byOutpoint = await this.findOutputsByOutpoints(userId, outpoints, trx)
    // Backends that cannot skip hydration remain correct; optimized backends may
    // use noScript to keep raw-transaction I/O outside the write lock.
    void noScript
    return byOutpoint
  }

  async findOrInsertOutputBasketsBulk(
    userId: number,
    names: string[],
    trx?: TrxToken
  ): Promise<Record<string, TableOutputBasket>> {
    const byName: Record<string, TableOutputBasket> = {}
    for (const name of names) byName[name] = await this.findOrInsertOutputBasket(userId, name, trx)
    return byName
  }

  async findOrInsertOutputTagsBulk(
    userId: number,
    tags: string[],
    trx?: TrxToken
  ): Promise<Record<string, TableOutputTag>> {
    const byTag: Record<string, TableOutputTag> = {}
    for (const tag of tags) byTag[tag] = await this.findOrInsertOutputTag(userId, tag, trx)
    return byTag
  }

  async findOrInsertTxLabelsBulk(
    userId: number,
    labels: string[],
    trx?: TrxToken
  ): Promise<Record<string, TableTxLabel>> {
    const byLabel: Record<string, TableTxLabel> = {}
    for (const label of labels) byLabel[label] ??= await this.findOrInsertTxLabel(userId, label, trx)
    return byLabel
  }

  async sumSpendableSatoshisInBasket(
    userId: number,
    basketId: number,
    excludeSending: boolean,
    trx?: TrxToken
  ): Promise<number> {
    const status: TransactionStatus[] = ['completed', 'unproven']
    if (!excludeSending) status.push('sending')
    const rows = await this.findOutputs({
      partial: { userId, spendable: true, basketId },
      txStatus: status,
      noScript: true,
      trx
    })
    return rows.filter(r => r.spentBy == null).reduce((a, r) => a + (r.satoshis ?? 0), 0)
  }

  abstract findCertificatesAuth(auth: AuthId, args: FindCertificatesArgs): Promise<TableCertificateX[]>
  abstract findOutputBasketsAuth(auth: AuthId, args: FindOutputBasketsArgs): Promise<TableOutputBasket[]>
  abstract findOutputsAuth(auth: AuthId, args: FindOutputsArgs): Promise<TableOutput[]>
  abstract insertCertificateAuth(auth: AuthId, certificate: TableCertificateX): Promise<number>

  abstract adminStats(adminIdentityKey: string): Promise<AdminStatsResult>

  async recentlyActiveUsers(limit = 50, trx?: TrxToken): Promise<TableUser[]> {
    const outputs = await this.findOutputs({
      partial: {},
      noScript: true,
      trx
    })

    const latestByUserId = new Map<number, Date>()
    for (const output of outputs) {
      if (output.userId === undefined) continue
      const createdAt = this.validateDate(output.created_at)
      const prior = latestByUserId.get(output.userId)
      if (prior == null || createdAt > prior) {
        latestByUserId.set(output.userId, createdAt)
      }
    }

    const sortedUserIds = Array.from(latestByUserId.entries())
      .sort((a, b) => b[1].getTime() - a[1].getTime())
      .slice(0, limit)
      .map(([userId]) => userId)

    const users = await Promise.all(sortedUserIds.map(async userId => await this.findUserById(userId, trx)))
    return users.filter((user): user is TableUser => user != null)
  }

  override isStorageProvider(): boolean {
    return true
  }

  setServices(v: WalletServices): void {
    this._services = v
  }

  getServices(): WalletServices {
    if (this._services == null) throw new WERR_INVALID_OPERATION('Must setServices first.')
    return this._services
  }

  private async findAbortableTransaction(
    userId: number,
    args: AbortActionArgs,
    trx: TrxToken
  ): Promise<{ tx: TableTransaction; reference: string | undefined }> {
    let reference: string | undefined = args.reference
    let tx = verifyOneOrNone(
      await this.findTransactions({
        partial: { reference, userId },
        noRawTx: true,
        trx
      })
    )
    if (tx == null && args.reference.length === 64) {
      reference = undefined
      tx = verifyOneOrNone(
        await this.findTransactions({
          partial: { txid: args.reference, userId },
          noRawTx: true,
          trx
        })
      )
    }
    const unAbortableStatus: TransactionStatus[] = ['completed', 'failed', 'sending', 'unproven']
    if (tx == null || !tx.isOutgoing || unAbortableStatus.includes(tx.status)) {
      throw new WERR_INVALID_PARAMETER(
        'reference',
        'an inprocess, outgoing action that has not been signed and shared to the network.'
      )
    }
    return { tx, reference }
  }

  private async checkAbortChainProtection(
    tx: TableTransaction,
    args: AbortActionArgs,
    trx: TrxToken
  ): Promise<{ skipped: boolean; serviceUnreachable: boolean }> {
    if (tx.txid == null || tx.txid === '' || tx.status !== 'nosend') {
      return { skipped: false, serviceUnreachable: false }
    }

    let serviceUnreachable = false
    let chainStatus: 'mined' | 'known' | 'unknown' | undefined
    try {
      const result = await this.getServices().getStatusForTxids([tx.txid])
      if (result.status !== 'success') {
        serviceUnreachable = true
      } else {
        chainStatus = result.results.find(item => item.txid === tx.txid)?.status
      }
    } catch {
      serviceUnreachable = true
    }
    if (chainStatus !== 'mined' && chainStatus !== 'known') {
      return { skipped: false, serviceUnreachable }
    }

    const req = await EntityProvenTxReq.fromStorageTxid(this, tx.txid, trx)
    if (req != null) {
      req.addHistoryNote({
        what: 'abortAction-skipped-onchain',
        reference: args.reference,
        chainStatus
      })
      await req.updateStorageDynamicProperties(this, trx)
    }
    return { skipped: true, serviceUnreachable }
  }

  private async invalidateAbortedTransaction(
    tx: TableTransaction,
    userId: number,
    reference: string | undefined,
    originalReference: string,
    serviceUnreachable: boolean,
    trx: TrxToken
  ): Promise<AbortActionResult> {
    await this.updateTransactionStatus('failed', tx.transactionId, userId, reference, trx)
    if (tx.txid != null && tx.txid !== '') {
      const req = await EntityProvenTxReq.fromStorageTxid(this, tx.txid, trx)
      if (req != null) {
        req.addHistoryNote(
          serviceUnreachable
            ? { what: 'abortAction-offline-fallback', reference: originalReference }
            : { what: 'abortAction', reference: originalReference }
        )
        req.status = 'invalid'
        await req.updateStorageDynamicProperties(this, trx)
      }
    }
    return { aborted: true }
  }

  async abortAction(auth: AuthId, args: AbortActionArgs): Promise<AbortActionResult> {
    if (auth.userId == null) throw new WERR_INVALID_PARAMETER('auth.userId', 'valid')

    const userId = auth.userId
    const r = await this.transaction(async trx => {
      const { tx, reference } = await this.findAbortableTransaction(userId, args, trx)
      // Chain-status protection for signed nosend txs.
      //
      // Background: a nosend tx (created via createAction({noSend:true}))
      // can be externally broadcast by the caller and reach 'mined' or
      // mempool-'known' status before any internalizeAction or Monitor
      // cycle has retired its 'nosend' status in storage. If abortAction
      // is invoked on it in that window, the destructive transitions
      // below (transactions.status='failed' + proven_tx_reqs.status='invalid')
      // orphan every output the tx produced — including auto-fund change
      // outputs the wallet itself emitted — because listOutputs filters
      // them out of the spendable set on parent-tx 'failed' status.
      //
      // Protection: if the tx has a txid AND status is 'nosend', ask
      // the network whether it already knows about the tx before
      // invalidating. getStatusForTxids returns 'mined' | 'known' |
      // 'unknown' per StatusForTxidResult (WalletServices.interfaces.ts).
      // Refuse the abort for 'mined' OR 'known' — a tx that's broadcast
      // and propagating in mempool returns 'known' (depth===0) and
      // protecting it avoids orphaning during the propagation window.
      //
      // Service-unreachable handling: proceed with abort. Refusal is
      // reserved for positive on-chain confirmation. When the network
      // confirmation pathway is itself unavailable (services throw or
      // gracefully return r.status !== 'success'), confirmation is not
      // possible — and per the BRC-100 contract callers retain the
      // ability to abort offline. The fallback writes a forensic
      // history note ('abortAction-offline-fallback') so an operator
      // can grep for aborts that proceeded under uncertainty. This
      // hole can never be 100% closed against externally-broadcast
      // chain-confirmed txs while offline; the audit trail makes it
      // recoverable.
      const protection = await this.checkAbortChainProtection(tx, args, trx)
      if (protection.skipped) {
        // Commit the audit note before translating this sentinel to aborted:false.
        return { __abortAction: 'skipped-onchain' as const }
      }
      return await this.invalidateAbortedTransaction(
        tx,
        userId,
        reference,
        args.reference,
        protection.serviceUnreachable,
        trx
      )
    })
    if ('__abortAction' in r) {
      // Tone Engel review feedback (PR #122 comment 4444566147 item 3):
      // do not throw on chain-confirmed refusal — surface it via the
      // return value so callers can branch on it. Refusal is positive
      // chain confirmation only; service-unreachable proceeds with
      // abort and returns aborted:true with an audit-trail note.
      return { aborted: false }
    }
    return r
  }

  async internalizeAction(auth: AuthId, args: InternalizeActionArgs): Promise<StorageInternalizeActionResult> {
    return await internalizeAction(this, auth, args)
  }

  /**
   * Given an array of transaction txids with current ProvenTxReq ready-to-share status,
   * lookup their ProvenTxReqApi req records.
   * For the txids with reqs and status still ready to send construct a single merged beef.
   *
   * @param txids
   * @param knownTxids
   * @param trx
   */
  async getReqsAndBeefToShareWithWorld(
    txids: string[],
    knownTxids: string[],
    trx?: TrxToken
  ): Promise<GetReqsAndBeefResult> {
    const r: GetReqsAndBeefResult = {
      beef: new Beef(),
      details: []
    }

    for (const txid of txids) {
      const d: GetReqsAndBeefDetail = {
        txid,
        // status: 'readyToSend' | 'alreadySent' | 'error' | 'unknown'
        status: 'unknown'
        // req?: TableProvenTxReq
        // proven?: TableProvenTx
        // error?: string
      }
      r.details.push(d)
      try {
        d.proven = verifyOneOrNone(await this.findProvenTxs({ partial: { txid }, trx }))
        if (d.proven != null) {
          d.status = 'alreadySent'
          continue
        }

        d.req = verifyOneOrNone(await this.findProvenTxReqs({ partial: { txid }, trx }))
        if (d.req == null) {
          d.status = 'error'
          d.error = `ERR_UNKNOWN_TXID: ${txid} was not found.`
        } else {
          classifyReqStatus(d, d.req)
        }

        if (d.status === 'readyToSend') {
          await this.mergeReqToBeefToShareExternally(d.req as TableProvenTxReq, r.beef, knownTxids, trx)
        }
      } catch (error_: unknown) {
        const e = WalletError.fromUnknown(error_)
        d.error = `${e.name}: ${e.message}`
      }
    }
    return r
  }

  async mergeReqToBeefToShareExternally(
    req: TableProvenTxReq,
    mergeToBeef: Beef,
    knownTxids: string[],
    trx?: TrxToken
  ): Promise<void> {
    const { rawTx, inputBEEF: beef } = req
    if (rawTx == null || beef == null) throw new WERR_INTERNAL('req rawTx and beef must be valid.')
    mergeToBeef.mergeRawTx(asArray(rawTx))
    mergeToBeef.mergeBeef(asArray(beef))
    await mergeInputsIntoBeef(
      asArray(rawTx),
      mergeToBeef,
      knownTxids,
      trx,
      async (txid, beef, _trust, knownTxids, trx) => {
        await this.getValidBeefForKnownTxid(txid, beef, undefined, knownTxids, trx)
      }
    )
  }

  /**
   * Checks if txid is a known valid ProvenTx and returns it if found.
   * Next checks if txid is a current ProvenTxReq and returns that if found.
   * If `newReq` is provided and an existing ProvenTxReq isn't found,
   * use `newReq` to create a new ProvenTxReq.
   *
   * This is safe "findOrInsert" operation using retry if unique index constraint
   * is violated by a race condition insert.
   *
   * @param txid
   * @param newReq
   * @param trx
   * @returns
   */
  private async upsertProvenTxReq(
    txid: string,
    newReq: TableProvenTxReq | undefined,
    trx: TrxToken | undefined
  ): Promise<TableProvenTxReq | undefined> {
    const existing = verifyOneOrNone(await this.findProvenTxReqs({ partial: { txid }, trx }))
    if (existing == null && newReq == null) return undefined
    if (existing == null) {
      await this.insertProvenTxReq(newReq as TableProvenTxReq, trx)
      return newReq
    }
    if (newReq != null) {
      const req1 = new EntityProvenTxReq(existing)
      req1.mergeHistory(newReq, undefined, true)
      req1.mergeNotifyTransactionIds(newReq)
      await req1.updateStorageDynamicProperties(this, trx)
    }
    return existing
  }

  async getProvenOrReq(txid: string, newReq?: TableProvenTxReq, trx?: TrxToken): Promise<StorageProvenOrReq> {
    if (newReq != null && txid !== newReq.txid) throw new WERR_INVALID_PARAMETER('newReq', 'same txid')

    const r: StorageProvenOrReq = { proven: undefined, req: undefined }

    r.proven = verifyOneOrNone(await this.findProvenTxs({ partial: { txid }, trx }))
    if (r.proven != null) return r

    for (let retry = 0; ; retry++) {
      try {
        r.req = await this.upsertProvenTxReq(txid, newReq, trx)
        break
      } catch (error_: unknown) {
        if (retry > 0) throw error_
      }
    }

    return r
  }

  async updateTransactionsStatus(transactionIds: number[], status: TransactionStatus, trx?: TrxToken): Promise<void> {
    await this.transaction(async trx => {
      for (const id of transactionIds) {
        await this.updateTransactionStatus(status, id, undefined, undefined, trx)
      }
    }, trx)
  }

  private async releaseInputsAllocatedToFailedTransaction(tx: TableTransaction, trx?: TrxToken): Promise<void> {
    const t = new EntityTransaction(tx)
    const inputs = await t.getInputs(this, trx)
    for (const input of inputs) {
      // input is a prior output belonging to userId that references this transaction either by `spentBy`
      // or by txid and vout.
      await this.updateOutput(verifyId(input.outputId), { spendable: true, spentBy: undefined }, trx)
    }
  }

  private async markFailedTransactionOutputsNotSpendable(tx: TableTransaction, trx?: TrxToken): Promise<void> {
    const outputs = await this.findOutputs({
      partial: { transactionId: verifyId(tx.transactionId) },
      trx
    })
    for (const output of outputs) {
      if (!output.spendable && output.spentBy == null) continue
      await this.updateOutput(verifyId(output.outputId), { spendable: false, spentBy: undefined }, trx)
    }
  }

  /**
   * For all `status` values besides 'failed', just updates the transaction records status property.
   *
   * For 'status' of 'failed', attempts to make outputs previously allocated as inputs to this transaction usable again
   * and makes outputs generated by this transaction non-spendable.
   *
   * @param status
   * @param transactionId
   * @param userId
   * @param reference
   * @param trx
   */
  async updateTransactionStatus(
    status: TransactionStatus,
    transactionId?: number,
    userId?: number,
    reference?: string,
    trx?: TrxToken
  ): Promise<void> {
    if (transactionId == null && !(userId != null && reference != null && reference !== '')) {
      throw new WERR_MISSING_PARAMETER('either transactionId or userId and reference')
    }

    await this.transaction(async trx => {
      const where: Partial<TableTransaction> = {}
      if (transactionId != null) where.transactionId = transactionId
      if (userId != null) where.userId = userId
      if (reference != null && reference !== '') where.reference = reference

      const tx = verifyOne(await this.findTransactions({ partial: where, noRawTx: true, trx }))

      // if (tx.status === status)
      // no change required. Assume inputs and outputs spendable and spentBy are valid for status.
      // return

      // Once completed, this method cannot be used to "uncomplete" transaction.
      if ((status !== 'completed' && tx.status === 'completed') || tx.provenTxId != null) {
        throw new WERR_INVALID_OPERATION('The status of a "completed" transaction cannot be changed.')
      }
      // It is not possible to un-fail a transaction. Information is lost and not recoverable.
      if (status !== 'failed' && tx.status === 'failed') {
        throw new WERR_INVALID_OPERATION('A "failed" transaction may not be un-failed by this method.')
      }

      switch (status) {
        case 'failed':
          await this.releaseInputsAllocatedToFailedTransaction(tx, trx)
          await this.markFailedTransactionOutputsNotSpendable(tx, trx)
          break
        case 'nosend':
        case 'unsigned':
        case 'unprocessed':
        case 'sending':
        case 'unproven':
        case 'completed':
          break
        default:
          throw new WERR_INVALID_PARAMETER('status', `not be ${status}`)
      }

      await this.updateTransaction(tx.transactionId, { status }, trx)
    }, trx)
  }

  async createAction(auth: AuthId, args: Validation.ValidCreateActionArgs): Promise<StorageCreateActionResult> {
    if (auth.userId == null) throw new WERR_UNAUTHORIZED()
    if (this.supportsActionBatchPersistence()) await cleanupExpiredActionBatches(this)
    return await createAction(this, auth, args)
  }

  async processAction(auth: AuthId, args: StorageProcessActionArgs): Promise<StorageProcessActionResults> {
    if (auth.userId == null) throw new WERR_UNAUTHORIZED()
    return await processAction(this, auth, args)
  }

  async attemptToPostReqsToNetwork(
    reqs: EntityProvenTxReq[],
    trx?: TrxToken,
    logger?: WalletLoggerInterface
  ): Promise<PostReqsToNetworkResult> {
    return await attemptToPostReqsToNetwork(this, reqs, trx, logger)
  }

  async listCertificates(auth: AuthId, args: Validation.ValidListCertificatesArgs): Promise<ListCertificatesResult> {
    return await listCertificates(this, auth, args)
  }

  async verifyKnownValidTransaction(txid: string, trx?: TrxToken): Promise<boolean> {
    const { proven, rawTx } = await this.getProvenOrRawTx(txid, trx)
    return proven !== undefined || rawTx !== undefined
  }

  /**
   * Pulls data from storage to build a valid beef for a txid.
   *
   * Optionally merges the data into an existing beef.
   * Optionally requires a minimum number of proof levels.
   *
   * @param txid
   * @param mergeToBeef
   * @param trustSelf
   * @param knownTxids
   * @param trx
   * @param requiredLevels
   * @returns
   */
  async getValidBeefForKnownTxid(
    txid: string,
    mergeToBeef?: Beef,
    trustSelf?: TrustSelf,
    knownTxids?: string[],
    trx?: TrxToken,
    requiredLevels?: number
  ): Promise<Beef> {
    const beef = await this.getValidBeefForTxid(txid, mergeToBeef, trustSelf, knownTxids, trx, requiredLevels)
    if (beef == null) throw new WERR_INVALID_PARAMETER('txid', `known to storage. ${txid} is not known.`)
    return beef
  }

  /**
   * Handles the proven-tx branch of getValidBeefForTxid.
   *
   * Returns the beef if the proof was merged and we can stop, or `undefined` to
   * signal that the caller should fall through to the rawTx path.  May also
   * populate `r.rawTx` so the rawTx path can proceed without re-fetching.
   */
  private async handleProvenTxBranch(
    txid: string,
    r: ProvenOrRawTx,
    beef: Beef,
    trustSelf: TrustSelf | undefined,
    requiredLevels: number | undefined,
    chainTracker: ChainTracker | undefined,
    skipInvalidProofs: boolean | undefined
  ): Promise<Beef | undefined> {
    const proven = r.proven
    if (proven == null) return undefined
    if ((requiredLevels ?? 0) > 0) {
      // Need more levels — caller should proceed via rawTx path
      r.rawTx = proven.rawTx
      return undefined
    }
    if (trustSelf === 'known') {
      beef.mergeTxidOnly(txid)
      return beef
    }
    const mp = new EntityProvenTx(proven).getMerklePath()
    if (chainTracker != null) {
      const root = mp.computeRoot()
      const isValid = await chainTracker.isValidRootForHeight(root, proven.height)
      if (!isValid) {
        if (skipInvalidProofs !== true) throw new WERR_INVALID_MERKLE_ROOT(proven.blockHash, proven.height, root, txid)
        // Proof is currently invalid — recurse deeper via rawTx path
        r.rawTx = proven.rawTx
        r.proven = undefined
        return undefined
      }
    }
    // Proof is good — merge and return
    beef.mergeRawTx(proven.rawTx)
    beef.mergeBump(mp)
    return beef
  }

  async getValidBeefForTxid(
    ...[
      txid,
      mergeToBeef,
      trustSelf,
      knownTxids,
      trx,
      requiredLevels,
      chainTracker,
      skipInvalidProofs
    ]: [
      txid: string,
      mergeToBeef?: Beef,
      trustSelf?: TrustSelf,
      knownTxids?: string[],
      trx?: TrxToken,
      requiredLevels?: number,
      chainTracker?: ChainTracker,
      skipInvalidProofs?: boolean
    ]
  ): Promise<Beef | undefined> {
    const beef = mergeToBeef ?? new Beef()
    const r = await this.getProvenOrRawTx(txid, trx)

    // --- proven-tx path ---
    if (r.proven != null) {
      const result = await this.handleProvenTxBranch(
        txid,
        r,
        beef,
        trustSelf,
        requiredLevels,
        chainTracker,
        skipInvalidProofs
      )
      if (result != null || r.rawTx == null) return result
    }

    // --- rawTx path ---
    if (r.rawTx == null) return undefined

    if (trustSelf === 'known') {
      beef.mergeTxidOnly(txid)
    } else {
      beef.mergeRawTx(r.rawTx)
      if (r.inputBEEF != null) beef.mergeBeef(r.inputBEEF)
      if ((requiredLevels ?? 0) > 0) requiredLevels = (requiredLevels as number) - 1
      await mergeInputBeefs(
        r.rawTx,
        beef,
        trustSelf,
        knownTxids,
        trx,
        requiredLevels,
        async (sourceTXID, beef, trustSelf, knownTxids, trx, requiredLevels) => {
          await this.getValidBeefForKnownTxid(sourceTXID, beef, trustSelf, knownTxids, trx, requiredLevels)
        }
      )
    }
    return beef
  }

  async getBeefForTransaction(txid: string, options: StorageGetBeefOptions): Promise<Beef> {
    const beef = await getBeefForTransaction(this, txid, options)
    return beef
  }

  async findMonitorEventById(id: number, trx?: TrxToken): Promise<TableMonitorEvent | undefined> {
    return verifyOneOrNone(await this.findMonitorEvents({ partial: { id }, trx }))
  }

  async relinquishCertificate(auth: AuthId, args: RelinquishCertificateArgs): Promise<number> {
    const vargs = Validation.validateRelinquishCertificateArgs(args)
    const cert = verifyOne(
      await this.findCertificates({
        partial: {
          certifier: vargs.certifier,
          serialNumber: vargs.serialNumber,
          type: vargs.type
        }
      })
    )
    return await this.updateCertificate(cert.certificateId, {
      isDeleted: true
    })
  }

  async relinquishOutput(auth: AuthId, args: RelinquishOutputArgs): Promise<number> {
    const vargs = Validation.validateRelinquishOutputArgs(args)
    const { txid, vout } = Validation.parseWalletOutpoint(vargs.output)
    const output = verifyOne(await this.findOutputs({ partial: { userId: auth.userId, txid, vout } }))
    return await this.updateOutput(output.outputId, { basketId: undefined })
  }

  async processSyncChunk(args: RequestSyncChunkArgs, chunk: SyncChunk): Promise<ProcessSyncChunkResult> {
    const user = verifyTruthy(await this.findUserByIdentityKey(args.identityKey))
    const ss = new EntitySyncState(
      verifyOne(
        await this.findSyncStates({
          partial: {
            storageIdentityKey: args.fromStorageIdentityKey,
            userId: user.userId
          }
        })
      )
    )
    const r = await ss.processSyncChunk(this, args, chunk)
    return r
  }

  /**
   * Handles storage changes when a valid MerklePath and mined block header are found for a ProvenTxReq txid.
   *
   * Performs the following storage updates (typically):
   * 1. Lookup the exising `ProvenTxReq` record for its rawTx
   * 2. Insert a new ProvenTx record using properties from `args` and rawTx, yielding a new provenTxId
   * 3. Update ProvenTxReq record with status 'completed' and new provenTxId value (and history of status changed)
   * 4. Unpack notify transactionIds from req and update each transaction's status to 'completed', provenTxId value.
   * 5. Update ProvenTxReq history again to record that transactions have been notified.
   * 6. Return results...
   *
   * Alterations of "typically" to handle:
   */
  async updateProvenTxReqWithNewProvenTx(
    args: UpdateProvenTxReqWithNewProvenTxArgs
  ): Promise<UpdateProvenTxReqWithNewProvenTxResult> {
    const req = await EntityProvenTxReq.fromStorageId(this, args.provenTxReqId)
    let proven: EntityProvenTx
    if (req.provenTxId != null && req.provenTxId > 0) {
      // Someone beat us to it, grab what we need for results...
      proven = new EntityProvenTx(verifyOne(await this.findProvenTxs({ partial: { txid: args.txid } })))
      if (req.status !== 'completed' || req.provenTxId !== proven.provenTxId) {
        req.status = 'completed'
        req.provenTxId = proven.provenTxId
        await req.updateStorageDynamicProperties(this)
      }
    } else {
      proven = await this.transaction(async trx => {
        const { proven: api } = await this.findOrInsertProvenTx(
          {
            created_at: new Date(),
            updated_at: new Date(),
            provenTxId: 0,
            txid: args.txid,
            height: args.height,
            index: args.index,
            merklePath: args.merklePath,
            rawTx: req.rawTx,
            blockHash: args.blockHash,
            merkleRoot: args.merkleRoot
          },
          trx
        )
        const found = new EntityProvenTx(api)
        if (req.status !== 'completed' || req.provenTxId !== found.provenTxId) {
          req.status = 'completed'
          req.provenTxId = found.provenTxId
          await req.updateStorageDynamicProperties(this, trx)
        }
        return found
      })
    }

    await this.reconcileProvenTxReqTransactions(req, proven)

    const r: UpdateProvenTxReqWithNewProvenTxResult = {
      status: req.status,
      history: req.apiHistory,
      provenTxId: proven.provenTxId,
      notified: req.notified,
      notify: req.apiNotify
    }
    return r
  }

  /**
   * Reconcile completed proof requests whose transaction fan-out previously
   * failed or whose durable notification state drifted.
   *
   * This is called by TaskReviewStatus so a completed request with
   * `notified = false` is retried and can become eligible for normal purge.
   */
  async reconcileCompletedProvenTxReqs(): Promise<{ log: string }> {
    let log = ''
    const reqs = await this.findProvenTxReqs({
      partial: { status: 'completed', notified: false }
    })

    for (const reqApi of reqs) {
      const req = new EntityProvenTxReq(reqApi)
      if (req.provenTxId == null || req.provenTxId <= 0) {
        log += `completed req ${req.id} cannot reconcile without provenTxId\n`
        continue
      }

      const provenApi = verifyOneOrNone(
        await this.findProvenTxs({
          partial: { provenTxId: req.provenTxId }
        })
      )
      if (provenApi == null) {
        log += `completed req ${req.id} cannot reconcile missing provenTx ${req.provenTxId}\n`
        continue
      }

      await this.reconcileProvenTxReqTransactions(req, new EntityProvenTx(provenApi))
      if (req.notified) log += `completed req ${req.id} transaction notifications reconciled\n`
    }

    return { log }
  }

  private async prepareProofRecoveryOutputVerdicts(
    transactions: TableTransaction[]
  ): Promise<Map<number, boolean | undefined>> {
    const verdicts = new Map<number, boolean | undefined>()
    if (transactions.length === 0) return verdicts
    const services = this.getServices()
    for (const transaction of transactions) {
      const outputs = await this.findOutputs({
        partial: {
          userId: transaction.userId,
          transactionId: transaction.transactionId
        }
      })
      for (const output of outputs) {
        const outputId = verifyId(output.outputId)
        await this.validateOutputScript(output)
        verdicts.set(
          outputId,
          output.lockingScript == null ? undefined : await services.isUtxo(output)
        )
      }
    }
    return verdicts
  }

  private async restoreProofRecoveryInputs(
    tx: TableTransaction,
    bsvtx: Transaction,
    indent: number,
    trx: TrxToken
  ): Promise<string> {
    let log = ''
    for (const [vin, input] of bsvtx.inputs.entries()) {
      const sourceTXID = input.sourceTXID
      if (sourceTXID == null) {
        log += ' '.repeat(indent + 2) + `input ${vin} has no source transaction id\n`
        continue
      }
      const outputs = await this.findOutputs({
        partial: {
          userId: tx.userId,
          txid: sourceTXID,
          vout: input.sourceOutputIndex
        },
        trx
      })
      if (outputs.length !== 1) {
        log += ' '.repeat(indent + 2) + `input ${vin} not matched to user's outputs\n`
        continue
      }
      const output = outputs[0]
      log +=
        ' '.repeat(indent + 2) +
        `input ${vin} matched to output ${output.outputId} updated spentBy ${tx.transactionId}\n`
      await this.updateOutput(
        verifyId(output.outputId),
        { spendable: false, spentBy: tx.transactionId },
        trx
      )
    }
    return log
  }

  private async restoreProofRecoveryOutputs(
    tx: TableTransaction,
    outputVerdicts: Map<number, boolean | undefined>,
    indent: number,
    trx: TrxToken
  ): Promise<string> {
    let log = ''
    const outputs = await this.findOutputs({
      partial: { userId: tx.userId, transactionId: tx.transactionId },
      trx
    })
    for (const output of outputs) {
      const outputId = verifyId(output.outputId)
      if (!outputVerdicts.has(outputId)) {
        throw new WERR_INTERNAL(
          `Output ${outputId} changed while preparing proof recovery.`
        )
      }
      const isUtxo = outputVerdicts.get(outputId)
      if (isUtxo == null) {
        log +=
          ' '.repeat(indent + 2) +
          `output ${output.outputId} does not have a valid locking script\n`
        continue
      }
      if (isUtxo === output.spendable) {
        log += ' '.repeat(indent + 2) + `output ${output.outputId} unchanged\n`
        continue
      }
      log +=
        ' '.repeat(indent + 2) +
        `output ${output.outputId} set to ${isUtxo ? 'spendable' : 'spent'}\n`
      await this.updateOutput(outputId, { spendable: isUtxo }, trx)
    }
    return log
  }

  private async restoreTransactionForProof(
    tx: TableTransaction,
    bsvtx: Transaction | undefined,
    preparedTransactionIds: Set<number>,
    outputVerdicts: Map<number, boolean | undefined>,
    indent: number,
    trx: TrxToken
  ): Promise<string> {
    if (bsvtx == null || !preparedTransactionIds.has(tx.transactionId)) {
      throw new WERR_INTERNAL(
        `Transaction ${tx.transactionId} changed while preparing proof recovery.`
      )
    }
    await this.updateTransaction(tx.transactionId, { status: 'unproven' }, trx)
    let log =
      ' '.repeat(indent) +
      `transaction ${tx.transactionId} status is now 'unproven'\n`
    log += await this.restoreProofRecoveryInputs(tx, bsvtx, indent, trx)
    log += await this.restoreProofRecoveryOutputs(tx, outputVerdicts, indent, trx)
    return log
  }

  /**
   * Restore every failed local copy of a transaction before proof completion.
   * Also heals the request's notification set from the authoritative txid
   * lookup so TaskUnFail cannot omit a local copy after notification drift.
   */
  async unfailTransactionsForProof(
    req: EntityProvenTxReq,
    indent = 0,
    requestUpdate?: Pick<TableProvenTxReqDynamics, 'status' | 'attempts'>
  ): Promise<string> {
    const transactions = await this.findTransactions({
      partial: { txid: req.txid },
      noRawTx: true
    })
    const transactionsToRepair = transactions.filter(
      transaction => requestUpdate != null || transaction.status === 'failed'
    )
    // Proof completion is the hot path. If no failed transaction needs repair,
    // notification reconciliation below will perform the required atomic work;
    // avoid an otherwise empty refresh/write transaction here.
    if (transactionsToRepair.length === 0 && requestUpdate == null) return ''

    // Refresh only after deciding recovery is required, while the caller has
    // not yet applied an intended request transition. TaskUnFail passes that
    // transition separately so it is persisted atomically with bookkeeping.
    await req.refreshFromStorage(this)
    const preparedTransactionIds = new Set(transactionsToRepair.map(transaction => transaction.transactionId))
    const bsvtx = transactionsToRepair.length > 0 ? Transaction.fromBinary(req.rawTx) : undefined

    // UTXO checks can call external services. Complete every check before
    // opening the write transaction so network latency never holds DB locks.
    const outputVerdicts =
      await this.prepareProofRecoveryOutputVerdicts(transactionsToRepair)

    return await this.transaction(async trx => {
      let log = ''
      await req.refreshFromStorage(this, trx)
      const currentTransactions = await this.findTransactions({
        partial: { txid: req.txid },
        noRawTx: true,
        trx
      })
      const knownNotificationIds = new Set(req.notify.transactionIds ?? [])

      if (requestUpdate != null) {
        req.status = requestUpdate.status
        req.attempts = requestUpdate.attempts
      }

      for (const tx of currentTransactions) {
        if (!knownNotificationIds.has(tx.transactionId)) {
          req.addNotifyTransactionId(tx.transactionId)
          knownNotificationIds.add(tx.transactionId)
        }
        const shouldRepair = requestUpdate != null || tx.status === 'failed'
        if (!shouldRepair) continue
        log += await this.restoreTransactionForProof(
          tx,
          bsvtx,
          preparedTransactionIds,
          outputVerdicts,
          indent,
          trx
        )
      }

      await req.updateStorageDynamicProperties(this, trx)
      return log
    })
  }

  private async reconcileProvenTxReqTransactions(req: EntityProvenTxReq, proven: EntityProvenTx): Promise<void> {
    // A transaction can be internalized concurrently by several users. Their
    // transaction rows share a txid but race while merging the JSON notify
    // list, so a last-writer-wins update can omit one local copy. A valid proof
    // is authoritative for every local transaction with this txid: discover
    // them from the indexed transaction table and atomically heal both the
    // durable notify set and any row that missed the original completion.
    // Keep the clean proof-completion path identical to the normal notification
    // transaction. Only leave it when failed rows require external UTXO checks,
    // which must run without an open transaction.
    let repairAttempts = 0
    for (;;) {
      const needsRepair = await this.transaction(async trx => {
        await req.refreshFromStorage(this, trx)
        const transactions = await this.findTransactions({ partial: { txid: req.txid }, trx })
        if (transactions.some(transaction => transaction.status === 'failed')) return true

        const knownNotificationIds = new Set(req.notify.transactionIds ?? [])
        for (const transaction of transactions) {
          if (!knownNotificationIds.has(transaction.transactionId)) {
            req.addNotifyTransactionId(transaction.transactionId)
            knownNotificationIds.add(transaction.transactionId)
          }
        }
        const transactionIdsNeedingProof = transactions
          .filter(transaction => transaction.status !== 'completed' || transaction.provenTxId !== proven.provenTxId)
          .map(transaction => transaction.transactionId)
        const updatesSucceeded = await notifyTransactionsOfProof(
          transactionIdsNeedingProof,
          proven.provenTxId,
          note => req.addHistoryNote(note),
          async (id, update) => {
            await this.updateTransaction(id, update, trx)
          }
        )
        const completedTransactions = await this.findTransactions({ partial: { txid: req.txid }, trx })
        req.notified =
          updatesSucceeded &&
          completedTransactions.every(
            transaction => transaction.status === 'completed' && transaction.provenTxId === proven.provenTxId
          )
        await req.updateStorageDynamicProperties(this, trx)
        return false
      })

      if (!needsRepair) return
      if (repairAttempts >= 2) {
        throw new WERR_INTERNAL(`Transactions for ${req.txid} repeatedly changed to failed during proof recovery.`)
      }
      repairAttempts++
      await this.unfailTransactionsForProof(req)
    }
  }

  /**
   * For each spendable output in the 'default' basket of the authenticated user,
   * verify that the output script, satoshis, vout and txid match that of an output
   * still in the mempool of at least one service provider.
   *
   * @returns object with invalidSpendableOutputs array. A good result is an empty array.
   */
  async confirmSpendableOutputs(): Promise<{
    invalidSpendableOutputs: TableOutput[]
  }> {
    const invalidSpendableOutputs: TableOutput[] = []
    const users = await this.findUsers({ partial: {} })
    const services = this.getServices()

    for (const { userId } of users) {
      const defaultBasket = verifyOne(await this.findOutputBaskets({ partial: { userId, name: 'default' } }))
      const outputs = await this.findOutputs({
        partial: { userId, basketId: defaultBasket.basketId, spendable: true }
      })

      for (const o of outputs) {
        if (!o.spendable) continue
        const isUtxo = await this.checkOutputIsUtxo(o, services)
        if (!isUtxo) invalidSpendableOutputs.push(o)
      }
    }
    return { invalidSpendableOutputs }
  }

  private async checkOutputIsUtxo(
    o: TableOutput,
    services: {
      hashOutputScript: (s: string) => string
      getUtxoStatus: (hash: string, fmt: undefined, outpoint: string) => Promise<{ isUtxo?: boolean }>
    }
  ): Promise<boolean> {
    if (o.lockingScript == null || o.lockingScript.length === 0) return false
    const hash = services.hashOutputScript(asString(o.lockingScript))
    const r = await services.getUtxoStatus(hash, undefined, `${o.txid ?? ''}.${o.vout ?? ''}`)
    return r.isUtxo === true
  }

  async updateProvenTxReqDynamics(
    id: number,
    update: Partial<TableProvenTxReqDynamics>,
    trx?: TrxToken
  ): Promise<number> {
    const partial: Partial<TableProvenTxReq> = {}
    if (update.updated_at != null) partial.updated_at = update.updated_at
    if (update.provenTxId != null && update.provenTxId > 0) partial.provenTxId = update.provenTxId
    if (update.status != null) partial.status = update.status
    if (Number.isInteger(update.attempts)) partial.attempts = update.attempts
    if (update.notified !== undefined) partial.notified = update.notified
    if (update.batch != null && update.batch !== '') partial.batch = update.batch
    if (update.history != null && update.history !== '') partial.history = update.history
    if (update.notify != null && update.notify !== '') partial.notify = update.notify
    if (update.wasBroadcast !== undefined) partial.wasBroadcast = update.wasBroadcast ?? false
    if (Number.isInteger(update.rebroadcastAttempts)) partial.rebroadcastAttempts = update.rebroadcastAttempts ?? 0

    return await this.updateProvenTxReq(id, partial, trx)
  }

  async extendOutput(
    o: TableOutput,
    includeBasket = false,
    includeTags = false,
    trx?: TrxToken
  ): Promise<TableOutputX> {
    const ox = o as TableOutputX
    if (includeBasket && ox.basketId != null && ox.basketId > 0)
      ox.basket = await this.findOutputBasketById(o.basketId as number, trx)
    if (includeTags) {
      ox.tags = await this.getTagsForOutputId(o.outputId)
    }
    return o
  }

  async validateOutputScript(o: TableOutput, trx?: TrxToken): Promise<void> {
    // without offset and length values return what we have (make no changes)
    if (
      o.scriptLength == null ||
      o.scriptLength === 0 ||
      o.scriptOffset == null ||
      o.scriptOffset === 0 ||
      o.txid == null ||
      o.txid === ''
    )
      return
    // if there is an outputScript and its length is the expected length return what we have.
    if (o.lockingScript?.length === o.scriptLength) return

    // outputScript is missing or has incorrect length...

    const script = await this.getRawTxOfKnownValidTransaction(o.txid, o.scriptOffset, o.scriptLength, trx)
    if (script == null) return
    o.lockingScript = script
  }
}

export interface StorageProviderOptions extends StorageReaderWriterOptions {
  chain: Chain
  feeModel: StorageFeeModel
  /**
   * Transactions created by this Storage can charge a fee per transaction.
   * A value of zero disables commission fees.
   */
  commissionSatoshis: number
  /**
   * If commissionSatoshis is greater than zero, must be a valid public key hex string.
   * The actual locking script for each commission will use a public key derived
   * from this key by information stored in the commissions table.
   */
  commissionPubKeyHex?: PubKeyHex
  /**
   * Optional verifier for server-side action-batch script checks. This Wallet
   * Toolbox extension leaves the BRC-100 wallet interface unchanged.
   */
  scriptVerifier?: SpendVerifierInterface
}

export function validateStorageFeeModel(v?: StorageFeeModel): StorageFeeModel {
  const r: StorageFeeModel = {
    model: 'sat/kb',
    value: 100
  }
  if (typeof v === 'object') {
    if (v.model !== 'sat/kb') throw new WERR_INVALID_PARAMETER('StorageFeeModel.model', '"sat/kb"')
    if (typeof v.value === 'number') {
      r.value = v.value
    }
  }
  return r
}

export interface StorageAdminStats {
  requestedBy: string
  when: string
  usersDay: number
  usersWeek: number
  usersMonth: number
  usersTotal: number
  transactionsDay: number
  transactionsWeek: number
  transactionsMonth: number
  transactionsTotal: number
  txCompletedDay: number
  txCompletedWeek: number
  txCompletedMonth: number
  txCompletedTotal: number
  txFailedDay: number
  txFailedWeek: number
  txFailedMonth: number
  txFailedTotal: number
  txAbandonedDay: number
  txAbandonedWeek: number
  txAbandonedMonth: number
  txAbandonedTotal: number
  txUnprocessedDay: number
  txUnprocessedWeek: number
  txUnprocessedMonth: number
  txUnprocessedTotal: number
  txSendingDay: number
  txSendingWeek: number
  txSendingMonth: number
  txSendingTotal: number
  txUnprovenDay: number
  txUnprovenWeek: number
  txUnprovenMonth: number
  txUnprovenTotal: number
  txUnsignedDay: number
  txUnsignedWeek: number
  txUnsignedMonth: number
  txUnsignedTotal: number
  txNosendDay: number
  txNosendWeek: number
  txNosendMonth: number
  txNosendTotal: number
  txNonfinalDay: number
  txNonfinalWeek: number
  txNonfinalMonth: number
  txNonfinalTotal: number
  txUnfailDay: number
  txUnfailWeek: number
  txUnfailMonth: number
  txUnfailTotal: number
  satoshisDefaultDay: number
  satoshisDefaultWeek: number
  satoshisDefaultMonth: number
  satoshisDefaultTotal: number
  satoshisOtherDay: number
  satoshisOtherWeek: number
  satoshisOtherMonth: number
  satoshisOtherTotal: number
  basketsDay: number
  basketsWeek: number
  basketsMonth: number
  basketsTotal: number
  labelsDay: number
  labelsWeek: number
  labelsMonth: number
  labelsTotal: number
  tagsDay: number
  tagsWeek: number
  tagsMonth: number
  tagsTotal: number
}

export interface AdminStatsResult extends StorageAdminStats {
  servicesStats?: ServicesCallHistory
  monitorStats?: ServicesCallHistory
}
