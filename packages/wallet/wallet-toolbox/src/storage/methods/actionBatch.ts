import {
  Beef,
  Script,
  Transaction,
  Validation
} from '@bsv/sdk'
import {
  AbortActionBatchResult,
  ActionBatchCommitAction,
  ActionBatchFundingOutput,
  ActionBatchManifest,
  BeginActionBatchArgs,
  BeginActionBatchResult,
  CommitActionBatchResult,
  ExtendActionBatchArgs,
  ExtendActionBatchResult,
  PrepareActionBatchCommitResult,
  PutActionBatchBlobArgs,
  RenewActionBatchResult,
  StorageCapabilities
} from '../../sdk/ActionBatch.interfaces'
import { AuthId, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { ProvenTxReqStatus, TransactionStatus } from '../../sdk/types'
import { WERR_INTERNAL, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { verifyId, verifyOne } from '../../utility/utilityHelpers'
import { asArray, asString } from '../../utility/utilityHelpers.noBuffer'
import { actionBatchBlobDigest, verifyActionBatchManifestDigest } from '../../utility/actionBatchDigest'
import { beefForTxids } from '../../utility/beefForTxids'
import { verifyUnlockScripts } from '../../signer/methods/completeSignedTransaction'
import { validateStorageFeeModel } from '../StorageProvider'
import type { StorageProvider } from '../StorageProvider'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { TableActionBatch, TableActionBatchBlob, TableActionBatchOutput } from '../schema/tables/TableActionBatch'
import { TableCommission } from '../schema/tables/TableCommission'
import { TableOutput } from '../schema/tables/TableOutput'
import { TableOutputBasket } from '../schema/tables/TableOutputBasket'
import { TableOutputTag } from '../schema/tables/TableOutputTag'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { isAutoSpendableChangeOutput } from './managedChange'
import { parseTxScriptOffsets } from '../../utility/parseTxScriptOffsets'
import { shareReqsWithWorld } from './processAction'
import { transactionSize } from './utils'
import { selectCanonicalChange } from './actionPlanning'

export const ACTION_BATCH_LEASE_MS = 15 * 60 * 1000
export const ACTION_BATCH_HARD_LIFETIME_MS = 60 * 60 * 1000
export const ACTION_BATCH_MAX_INLINE_BYTES = 4 * 1024 * 1024
export const ACTION_BATCH_MAX_BLOB_BYTES = 8 * 1024 * 1024
export const ACTION_BATCH_MAX_CONCURRENT_UPLOADS = 4
const INITIAL_RESERVATION_LIMIT = 8
const INITIAL_EXTRA_OUTPUTS = 3
const MAX_RESERVED_HEADROOM = 64

export function getActionBatchCapabilities (): StorageCapabilities {
  return {
    actionBatch: {
      version: 1,
      maxInlineBytes: ACTION_BATCH_MAX_INLINE_BYTES,
      maxBlobBytes: ACTION_BATCH_MAX_BLOB_BYTES,
      maxConcurrentUploads: ACTION_BATCH_MAX_CONCURRENT_UPLOADS,
      leaseMs: ACTION_BATCH_LEASE_MS,
      hardLifetimeMs: ACTION_BATCH_HARD_LIFETIME_MS
    }
  }
}

function activeExpiry (batch: TableActionBatch, now = new Date()): boolean {
  return batch.status !== 'active' && batch.status !== 'prepared' ||
    batch.expiresAt.getTime() <= now.getTime() ||
    batch.hardExpiresAt.getTime() <= now.getTime()
}

async function releaseBatchState (
  storage: StorageProvider,
  batch: TableActionBatch,
  status: 'aborted' | 'committed' | 'expired',
  trx?: TrxToken
): Promise<void> {
  await storage.deleteActionBatchOutputReservations(batch.actionBatchId, trx)
  await storage.deleteActionBatchBlobRecords(batch.actionBatchId, trx)
  await storage.updateActionBatch(batch.actionBatchId, { status }, trx)
}

export async function cleanupExpiredActionBatches (storage: StorageProvider): Promise<number> {
  const expired = await storage.findExpiredActionBatches(new Date())
  for (const batch of expired) {
    await storage.transaction(async trx => await releaseBatchState(storage, batch, 'expired', trx))
  }
  return expired.length
}

async function availableManagedChange (
  storage: StorageProvider,
  userId: number,
  basketId: number,
  excludeSending: boolean,
  trx?: TrxToken
): Promise<TableOutput[]> {
  const statuses: TransactionStatus[] = ['completed', 'unproven']
  if (!excludeSending) statuses.push('sending')
  const outputs = (await storage.findOutputs({
    partial: { userId, basketId, spendable: true },
    txStatus: statuses,
    trx
  })).filter(isAutoSpendableChangeOutput)
  const reserved = new Set(await storage.findReservedActionBatchOutputIds(outputs.map(o => o.outputId), trx))
  return outputs.filter(output => output.spentBy == null && !reserved.has(output.outputId))
}

function sourceOutputFromBeef (
  beef: Beef,
  outpoint: { txid: string, vout: number }
): { satoshis: number, lockingScript: Script } | undefined {
  const tx = beef.findTxid(outpoint.txid)?.tx
  const output = tx?.outputs[outpoint.vout]
  if (output == null) return undefined
  return { satoshis: Validation.validateSatoshis(output.satoshis, 'source output satoshis'), lockingScript: output.lockingScript }
}

async function resolveExplicitOutputs (
  storage: StorageProvider,
  userId: number,
  args: Validation.ValidCreateActionArgs
): Promise<{ outputs: TableOutput[], inputSatoshis: number }> {
  const byOutpoint = await storage.findOutputsByOutpoints(userId, args.inputs.map(input => input.outpoint))
  const beef = args.inputBEEF == null ? new Beef() : Beef.fromBinary(args.inputBEEF)
  const outputs: TableOutput[] = []
  let inputSatoshis = 0
  for (const input of args.inputs) {
    const output = byOutpoint[`${input.outpoint.txid}.${input.outpoint.vout}`]
    if (output != null) {
      await storage.validateOutputScript(output)
      outputs.push(output)
      inputSatoshis += output.satoshis
      continue
    }
    const source = sourceOutputFromBeef(beef, input.outpoint)
    if (source == null) {
      throw new WERR_INVALID_PARAMETER('inputBEEF', `proof data for ${input.outpoint.txid}.${input.outpoint.vout}`)
    }
    inputSatoshis += source.satoshis
  }
  return { outputs, inputSatoshis }
}

async function resolveNoSendChangeOutputs (
  storage: StorageProvider,
  userId: number,
  args: Validation.ValidCreateActionArgs
): Promise<{ outputs: TableOutput[], inputSatoshis: number }> {
  const outpoints = args.options.noSendChange
  const byOutpoint = await storage.findOutputsByOutpoints(userId, outpoints)
  const outputs: TableOutput[] = []
  let inputSatoshis = 0
  for (const outpoint of outpoints) {
    const key = `${outpoint.txid}.${outpoint.vout}`
    const output = byOutpoint[key]
    if (output == null || !output.spendable || output.spentBy != null || !isAutoSpendableChangeOutput(output)) {
      throw new WERR_INVALID_PARAMETER('noSendChange', `spendable wallet-managed output ${key}`)
    }
    await storage.validateOutputScript(output)
    outputs.push(output)
    inputSatoshis += output.satoshis
  }
  return { outputs, inputSatoshis }
}

function estimateFirstActionTarget (
  storage: StorageProvider,
  args: Validation.ValidCreateActionArgs,
  inputSatoshis: number
): number {
  const outputSatoshis = args.outputs.reduce((sum, output) => sum + output.satoshis, 0) + storage.commissionSatoshis
  const inputLengths = args.inputs.map(input => input.unlockingScriptLength)
  const outputLengths = args.outputs.map(output => output.lockingScript.length / 2)
  if (storage.commissionSatoshis > 0) outputLengths.push(25)
  outputLengths.push(25)
  const fee = validateStorageFeeModel(storage.feeModel).value ?? 0
  const minFee = Math.ceil(transactionSize([...inputLengths, 107], outputLengths) * fee / 1000)
  return Math.max(1, outputSatoshis + minFee - inputSatoshis)
}

function chooseReservationPool (
  candidates: TableOutput[],
  targetSatoshis: number,
  limit: number,
  extras: number,
  fillLimit: boolean
): TableOutput[] {
  const remaining = [...candidates]
  const chosen: TableOutput[] = []
  let deficit = targetSatoshis
  while (deficit > 0 && chosen.length < limit) {
    const output = selectCanonicalChange(remaining, deficit)
    if (output == null) break
    chosen.push(output)
    remaining.splice(remaining.indexOf(output), 1)
    deficit -= output.satoshis
  }
  const desiredCount = fillLimit ? limit : Math.min(limit, chosen.length + extras)
  while (remaining.length > 0 && chosen.length < desiredCount) {
    const output = selectCanonicalChange(remaining, targetSatoshis)
    if (output == null) break
    chosen.push(output)
    remaining.splice(remaining.indexOf(output), 1)
  }
  return chosen
}

async function reserveOutputs (
  storage: StorageProvider,
  batch: TableActionBatch,
  outputs: TableOutput[],
  trx?: TrxToken
): Promise<void> {
  const now = new Date()
  const unique = [...new Map(outputs.map(output => [output.outputId, output])).values()]
  const reserve = async (transaction: TrxToken): Promise<void> => {
    const conflicts = await storage.findReservedActionBatchOutputIds(unique.map(output => output.outputId), transaction)
    if (conflicts.length > 0) throw new WERR_INVALID_OPERATION('one or more action batch outputs were concurrently reserved')
    await storage.reserveActionBatchOutputs(unique.map(output => ({
      actionBatchId: batch.actionBatchId,
      outputId: output.outputId,
      created_at: now,
      updated_at: now
    })), transaction)
  }
  if (trx != null) await reserve(trx)
  else await storage.transaction(reserve)
}

async function makeFundingResult (
  storage: StorageProvider,
  args: Validation.ValidCreateActionArgs,
  outputs: TableOutput[]
): Promise<{ outputs: ActionBatchFundingOutput[], beef?: Uint8Array }> {
  const beef = new Beef()
  const result: ActionBatchFundingOutput[] = []
  for (const output of outputs) {
    await storage.validateOutputScript(output)
    const copy: ActionBatchFundingOutput = { ...output }
    if (args.isSignAction && args.includeAllSourceTransactions) {
      copy.sourceTransaction = await storage.getRawTxOfKnownValidTransaction(output.txid)
    }
    if (!args.options.returnTXIDOnly && output.txid != null && beef.findTxid(output.txid) == null) {
      beef.mergeBeef(await storage.getBeefForTransaction(output.txid, {
        knownTxids: args.options.knownTxids,
        ignoreServices: true
      }))
    }
    result.push(copy)
  }
  return { outputs: result, beef: args.options.returnTXIDOnly ? undefined : beef.toUint8Array() }
}

function newBatch (userId: number, batchId: string): TableActionBatch {
  const now = new Date()
  return {
    actionBatchId: 0,
    userId,
    batchId,
    status: 'active',
    expiresAt: new Date(now.getTime() + ACTION_BATCH_LEASE_MS),
    hardExpiresAt: new Date(now.getTime() + ACTION_BATCH_HARD_LIFETIME_MS),
    created_at: now,
    updated_at: now
  }
}

export async function beginActionBatch (
  storage: StorageProvider,
  auth: AuthId,
  args: BeginActionBatchArgs
): Promise<BeginActionBatchResult> {
  const userId = verifyId(auth.userId)
  await cleanupExpiredActionBatches(storage)
  if (await storage.findActionBatch(userId, args.batchId) != null) {
    throw new WERR_INVALID_PARAMETER('batchId', 'unique')
  }
  const changeBasket = verifyOne(await storage.findOutputBaskets({ partial: { userId, name: 'default' } }))
  const explicit = await resolveExplicitOutputs(storage, userId, args.firstAction)
  const noSendChange = await resolveNoSendChangeOutputs(storage, userId, args.firstAction)
  const fixedOutputIds = new Set([...explicit.outputs, ...noSendChange.outputs].map(output => output.outputId))
  const available = (await availableManagedChange(
    storage, userId, changeBasket.basketId, !args.firstAction.isDelayed
  )).filter(output => !fixedOutputIds.has(output.outputId))
  const target = estimateFirstActionTarget(
    storage, args.firstAction, explicit.inputSatoshis + noSendChange.inputSatoshis
  )
  const fixedOutputs = [...explicit.outputs, ...noSendChange.outputs]
  const requiredCapacity = Math.max(0, INITIAL_RESERVATION_LIMIT - fixedOutputs.length)
  const funding = chooseReservationPool(available, target, requiredCapacity, INITIAL_EXTRA_OUTPUTS, false)
  const batch = newBatch(userId, args.batchId)
  await storage.transaction(async trx => {
    await storage.insertActionBatch(batch, trx)
    await reserveOutputs(storage, batch, [...fixedOutputs, ...funding], trx)
  })
  const fundingResult = await makeFundingResult(storage, args.firstAction, [...funding, ...fixedOutputs])
  const explicitIds = new Set(fixedOutputs.map(output => output.outputId))
  return {
    batchId: batch.batchId,
    expiresAt: batch.expiresAt.toISOString(),
    hardExpiresAt: batch.hardExpiresAt.toISOString(),
    changeBasket,
    feeModel: validateStorageFeeModel(storage.feeModel),
    commissionSatoshis: storage.commissionSatoshis,
    commissionPubKeyHex: storage.commissionPubKeyHex,
    availableChangeCount: available.length,
    reservedOutputs: fundingResult.outputs.filter(output => funding.some(candidate => candidate.outputId === output.outputId)),
    explicitOutputs: fundingResult.outputs.filter(output => explicitIds.has(output.outputId)),
    inputBeef: fundingResult.beef
  }
}

function requireLiveBatch (batch: TableActionBatch | undefined): TableActionBatch {
  if (batch == null || activeExpiry(batch)) throw new WERR_INVALID_OPERATION('action batch is not active')
  return batch
}

function requireUploadableBatch (batch: TableActionBatch | undefined): TableActionBatch {
  if (batch == null || batch.status === 'committed' || batch.status === 'aborted') {
    throw new WERR_INVALID_OPERATION('action batch is not uploadable')
  }
  if (batch.hardExpiresAt.getTime() <= Date.now()) {
    throw new WERR_INVALID_OPERATION('action batch hard lifetime has expired')
  }
  return batch
}

export async function extendActionBatch (
  storage: StorageProvider,
  auth: AuthId,
  args: ExtendActionBatchArgs
): Promise<ExtendActionBatchResult> {
  const userId = verifyId(auth.userId)
  await cleanupExpiredActionBatches(storage)
  const batch = requireLiveBatch(await storage.findActionBatch(userId, args.batchId))
  const basket = verifyOne(await storage.findOutputBaskets({ partial: { userId, name: 'default' } }))
  const alreadyReserved = await storage.findActionBatchOutputIds(batch.actionBatchId)
  const available = await availableManagedChange(storage, userId, basket.basketId, false)
  const requestedCount = Math.min(
    Math.max(0, args.requestedOutputs),
    Math.max(0, MAX_RESERVED_HEADROOM - alreadyReserved.length)
  )
  const funding = chooseReservationPool(available, Math.max(1, args.targetSatoshis), requestedCount, 0, true)
  const explicitByOutpoint = await storage.findOutputsByOutpoints(userId, args.explicitOutpoints)
  const explicit = Object.values(explicitByOutpoint)
    .filter(output => !alreadyReserved.includes(output.outputId))
  const expiresAt = new Date(Math.min(
    batch.hardExpiresAt.getTime(),
    Date.now() + ACTION_BATCH_LEASE_MS
  ))
  await storage.transaction(async trx => {
    await reserveOutputs(storage, batch, [...funding, ...explicit], trx)
    await storage.updateActionBatch(batch.actionBatchId, { expiresAt }, trx)
  })
  const fundingShape = argsToFundingShape(args.includeSourceTransactions)
  const fundingResult = await makeFundingResult(storage, fundingShape, [...funding, ...explicit])
  return {
    expiresAt: expiresAt.toISOString(),
    reservedOutputs: fundingResult.outputs.filter(output => funding.some(candidate => candidate.outputId === output.outputId)),
    explicitOutputs: fundingResult.outputs.filter(output => explicit.some(candidate => candidate.outputId === output.outputId)),
    inputBeef: fundingResult.beef
  }
}

function argsToFundingShape (includeSourceTransactions: boolean): Validation.ValidCreateActionArgs {
  return {
    inputs: [], outputs: [], labels: [], description: 'action batch extension', version: 1, lockTime: 0,
    options: {
      acceptDelayedBroadcast: true, returnTXIDOnly: false, noSend: true, sendWith: [], signAndProcess: true,
      knownTxids: [], noSendChange: [], randomizeOutputs: true
    },
    isSendWith: false, isNewTx: true, isRemixChange: false, isNoSend: true, isDelayed: true,
    isTestWerrReviewActions: false,
    isSignAction: includeSourceTransactions,
    includeAllSourceTransactions: includeSourceTransactions
  }
}

export async function renewActionBatch (
  storage: StorageProvider,
  auth: AuthId,
  batchId: string
): Promise<RenewActionBatchResult> {
  const userId = verifyId(auth.userId)
  const batch = requireLiveBatch(await storage.findActionBatch(userId, batchId))
  const expiresAt = new Date(Math.min(batch.hardExpiresAt.getTime(), Date.now() + ACTION_BATCH_LEASE_MS))
  await storage.updateActionBatch(batch.actionBatchId, { expiresAt })
  return { expiresAt: expiresAt.toISOString() }
}

function manifestDigests (manifest: ActionBatchManifest): string[] {
  const inline = manifest.inlineBlobs ?? {}
  const logicalDigests = manifest.actions
    .filter(action => action.rawTx == null)
    .map(action => action.rawTxDigest)
    .filter((digest): digest is string => digest != null)
  if (manifest.dependencyBeef == null && manifest.dependencyBeefDigest != null &&
    inline[manifest.dependencyBeefDigest] == null) logicalDigests.push(manifest.dependencyBeefDigest)
  for (const action of manifest.actions) {
    for (const digest of action.lockingScriptDigests ?? []) {
      if (digest != null && inline[digest] == null) logicalDigests.push(digest)
    }
  }
  return [...new Set(logicalDigests.flatMap(digest => {
    if (inline[digest] != null) return []
    return manifest.blobChunks?.[digest] ?? [digest]
  }))]
}

export async function prepareActionBatchCommit (
  storage: StorageProvider,
  auth: AuthId,
  manifest: ActionBatchManifest
): Promise<PrepareActionBatchCommitResult> {
  if (!verifyActionBatchManifestDigest(manifest)) throw new WERR_INVALID_PARAMETER('manifest.digest', 'valid')
  const userId = verifyId(auth.userId)
  const batch = requireUploadableBatch(await storage.findActionBatch(userId, manifest.batchId))
  if (batch.manifestDigest != null && batch.manifestDigest !== manifest.digest) {
    throw new WERR_INVALID_OPERATION('action batch was already prepared with a different manifest')
  }
  const missingDigests: string[] = []
  for (const digest of manifestDigests(manifest)) {
    if (await storage.findActionBatchBlobRecord(batch.actionBatchId, digest) == null) missingDigests.push(digest)
  }
  await storage.updateActionBatch(batch.actionBatchId, {
    status: batch.status === 'expired' ? 'expired' : 'prepared',
    manifestDigest: manifest.digest
  })
  return {
    missingDigests,
    maxBlobBytes: ACTION_BATCH_MAX_BLOB_BYTES,
    maxConcurrentUploads: ACTION_BATCH_MAX_CONCURRENT_UPLOADS
  }
}

export async function putActionBatchBlob (
  storage: StorageProvider,
  auth: AuthId,
  args: PutActionBatchBlobArgs
): Promise<void> {
  const userId = verifyId(auth.userId)
  const batch = requireUploadableBatch(await storage.findActionBatch(userId, args.batchId))
  const bytes = asArray(args.bytes)
  if (bytes.length > ACTION_BATCH_MAX_BLOB_BYTES) throw new WERR_INVALID_PARAMETER('bytes', 'within provider blob limit')
  if (actionBatchBlobDigest(bytes) !== args.digest) throw new WERR_INVALID_PARAMETER('digest', 'match bytes')
  const now = new Date()
  await storage.putActionBatchBlobRecord({
    actionBatchBlobId: 0,
    actionBatchId: batch.actionBatchId,
    digest: args.digest,
    bytes,
    created_at: now,
    updated_at: now
  })
}

async function resolveManifestBytes (
  storage: StorageProvider,
  batch: TableActionBatch,
  inline: number[] | Uint8Array | undefined,
  digest: string | undefined,
  name: string,
  chunkDigests?: string[]
): Promise<number[]> {
  if (inline != null) {
    const bytes = asArray(inline)
    if (digest != null && actionBatchBlobDigest(bytes) !== digest) throw new WERR_INVALID_PARAMETER(name, 'match digest')
    return bytes
  }
  if (digest == null) throw new WERR_INVALID_PARAMETER(name, 'inline bytes or digest')
  if (chunkDigests != null) {
    if (chunkDigests.length === 0) throw new WERR_INVALID_PARAMETER(name, 'one or more blob chunks')
    const chunks: number[][] = []
    let totalBytes = 0
    for (const chunkDigest of chunkDigests) {
      const chunk = await storage.findActionBatchBlobRecord(batch.actionBatchId, chunkDigest)
      if (chunk == null) throw new WERR_INVALID_OPERATION(`missing action batch blob ${chunkDigest}`)
      if (actionBatchBlobDigest(chunk.bytes) !== chunkDigest) {
        throw new WERR_INVALID_OPERATION(`corrupt action batch blob ${chunkDigest}`)
      }
      chunks.push(chunk.bytes)
      totalBytes += chunk.bytes.length
    }
    const bytes = new Array<number>(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      for (let index = 0; index < chunk.length; index++) bytes[offset++] = chunk[index]
    }
    if (actionBatchBlobDigest(bytes) !== digest) throw new WERR_INVALID_PARAMETER(name, 'chunks matching digest')
    return bytes
  }
  const blob = await storage.findActionBatchBlobRecord(batch.actionBatchId, digest)
  if (blob == null) throw new WERR_INVALID_OPERATION(`missing action batch blob ${digest}`)
  if (actionBatchBlobDigest(blob.bytes) !== digest) throw new WERR_INVALID_OPERATION(`corrupt action batch blob ${digest}`)
  return blob.bytes
}

interface ValidatedBatchAction {
  action: ActionBatchCommitAction
  tx: Transaction
  rawTx: number[]
  inputBeef: number[]
}

async function materializeActionScripts (
  storage: StorageProvider,
  batch: TableActionBatch,
  manifest: ActionBatchManifest,
  action: ActionBatchCommitAction
): Promise<ActionBatchCommitAction> {
  if (action.lockingScriptDigests == null) return action
  if (action.lockingScriptDigests.length !== action.plan.outputs.length) {
    throw new WERR_INVALID_PARAMETER('lockingScriptDigests', 'align with planned outputs')
  }
  const scripts: string[] = []
  for (let index = 0; index < action.plan.outputs.length; index++) {
    const digest = action.lockingScriptDigests[index]
    scripts.push(digest == null
      ? action.plan.outputs[index].lockingScript
      : asString(await resolveManifestBytes(
        storage,
        batch,
        manifest.inlineBlobs?.[digest],
        digest,
        `locking script ${index}`,
        manifest.blobChunks?.[digest]
      )))
  }
  return {
    ...action,
    plan: {
      ...action.plan,
      outputs: action.plan.outputs.map((output, index) => ({ ...output, lockingScript: scripts[index] }))
    },
    metadata: {
      ...action.metadata,
      outputs: action.metadata.outputs.map((output, index) => ({ ...output, lockingScript: scripts[index] }))
    }
  }
}

async function validateManifestActions (
  storage: StorageProvider,
  batch: TableActionBatch,
  manifest: ActionBatchManifest
): Promise<{ actions: ValidatedBatchAction[], dependencyBeef: number[] }> {
  const dependencyBeef = await resolveManifestBytes(
    storage,
    batch,
    manifest.dependencyBeef ?? (manifest.dependencyBeefDigest == null
      ? undefined
      : manifest.inlineBlobs?.[manifest.dependencyBeefDigest]),
    manifest.dependencyBeefDigest,
    'dependencyBeef',
    manifest.dependencyBeefDigest == null ? undefined : manifest.blobChunks?.[manifest.dependencyBeefDigest]
  )
  const beef = dependencyBeef.length === 0 ? new Beef() : Beef.fromBinary(dependencyBeef)
  const batchTxids = new Set(manifest.actions.map(action => action.txid))
  const seenTxids = new Set<string>()
  const spentOutpoints = new Set<string>()
  const actions: ValidatedBatchAction[] = []
  for (const compactAction of manifest.actions) {
    const action = await materializeActionScripts(storage, batch, manifest, compactAction)
    if (seenTxids.has(action.txid)) throw new WERR_INVALID_PARAMETER('actions', 'unique txids')
    if (action.reference !== action.plan.reference) throw new WERR_INVALID_PARAMETER('reference', 'match plan')
    const rawTx = await resolveManifestBytes(
      storage,
      batch,
      action.rawTx ?? (action.rawTxDigest == null ? undefined : manifest.inlineBlobs?.[action.rawTxDigest]),
      action.rawTxDigest,
      `rawTx ${action.txid}`,
      action.rawTxDigest == null ? undefined : manifest.blobChunks?.[action.rawTxDigest]
    )
    const tx = Transaction.fromBinary(rawTx)
    if (tx.id('hex') !== action.txid) throw new WERR_INVALID_PARAMETER('txid', 'match raw transaction')
    if (tx.version !== action.plan.version || tx.lockTime !== action.plan.lockTime) {
      throw new WERR_INVALID_PARAMETER('transaction', 'match planned version and lockTime')
    }
    if (tx.inputs.length !== action.plan.inputs.length || tx.outputs.length !== action.plan.outputs.length) {
      throw new WERR_INVALID_PARAMETER('transaction', 'match planned input and output counts')
    }
    for (const planned of action.plan.inputs) {
      const input = tx.inputs[planned.vin]
      if (input == null || input.sourceTXID !== planned.sourceTxid || input.sourceOutputIndex !== planned.sourceVout) {
        throw new WERR_INVALID_PARAMETER('inputs', 'match planned transaction outpoints')
      }
    }
    for (const input of tx.inputs) {
      const sourceTxid = input.sourceTXID
      if (sourceTxid == null) throw new WERR_INVALID_PARAMETER('input.sourceTXID', 'valid')
      const outpoint = `${sourceTxid}.${input.sourceOutputIndex}`
      if (spentOutpoints.has(outpoint)) throw new WERR_INVALID_PARAMETER('actions', `not double spend ${outpoint}`)
      spentOutpoints.add(outpoint)
      if (batchTxids.has(sourceTxid) && !seenTxids.has(sourceTxid)) {
        throw new WERR_INVALID_PARAMETER('actions', 'topologically ordered')
      }
    }
    let inputSatoshis = 0
    for (const planned of action.plan.inputs) inputSatoshis += planned.sourceSatoshis
    const outputSatoshis = tx.outputs.reduce(
      (sum, output) => sum + Validation.validateSatoshis(output.satoshis, 'transaction output satoshis'),
      0
    )
    const feePaid = inputSatoshis - outputSatoshis
    const feeRate = validateStorageFeeModel(storage.feeModel).value ?? 0
    if (feePaid < Math.ceil(rawTx.length * feeRate / 1000)) {
      throw new WERR_INVALID_PARAMETER('transaction fee', 'meet the active storage fee model')
    }
    for (let i = 0; i < action.metadata.outputs.length; i++) {
      const requested = action.metadata.outputs[i]
      const planned = action.plan.outputs[i]
      const transactionOutput = planned == null ? undefined : tx.outputs[planned.vout]
      if (planned == null || transactionOutput == null || requested.satoshis !== planned.satoshis ||
        (requested.lockingScript !== '' && requested.lockingScript !== planned.lockingScript) ||
        transactionOutput.satoshis !== planned.satoshis || transactionOutput.lockingScript.toHex() !== planned.lockingScript) {
        throw new WERR_INVALID_PARAMETER('outputs', 'match requested outputs')
      }
    }
    const inputBeef = asArray(beefForTxids(
      beef,
      action.plan.inputs.map(input => input.sourceTxid)
    ).toUint8Array())
    beef.mergeRawTx(rawTx)
    seenTxids.add(action.txid)
    actions.push({ action, tx, rawTx, inputBeef })
  }
  for (const { action } of actions) verifyUnlockScripts(action.txid, beef)
  if (!(await beef.verify(await storage.getServices().getChainTracker(), true))) {
    throw new WERR_INVALID_PARAMETER('manifest', 'valid dependency graph')
  }
  return { actions, dependencyBeef }
}

async function reacquireManifestInputs (
  storage: StorageProvider,
  userId: number,
  batch: TableActionBatch,
  validated: { actions: ValidatedBatchAction[] }
): Promise<void> {
  if (batch.hardExpiresAt.getTime() <= Date.now()) {
    throw new WERR_INVALID_OPERATION('action batch hard lifetime has expired')
  }
  const stagedTxids = new Set(validated.actions.map(({ action }) => action.txid))
  const outpoints = [...new Map(validated.actions.flatMap(({ action }) => action.plan.inputs)
    .filter(input => !stagedTxids.has(input.sourceTxid))
    .map(input => [`${input.sourceTxid}.${input.sourceVout}`, {
      txid: input.sourceTxid,
      vout: input.sourceVout,
      providedBy: input.providedBy
    }])).values()]

  await storage.transaction(async trx => {
    await storage.deleteActionBatchOutputReservations(batch.actionBatchId, trx)
    const stored = await storage.findOutputsByOutpoints(userId, outpoints, trx)
    const outputs: TableOutput[] = []
    for (const outpoint of outpoints) {
      const key = `${outpoint.txid}.${outpoint.vout}`
      const output = stored[key]
      if (output == null) {
        if (outpoint.providedBy === 'storage' || outpoint.providedBy === 'you-and-storage') {
          throw new WERR_INVALID_OPERATION(`reserved input ${key} is no longer available`)
        }
        continue
      }
      if (!output.spendable || output.spentBy != null) {
        throw new WERR_INVALID_OPERATION(`input ${key} is no longer spendable`)
      }
      outputs.push(output)
    }
    const conflicts = await storage.findReservedActionBatchOutputIds(outputs.map(output => output.outputId), trx)
    if (conflicts.length > 0) {
      throw new WERR_INVALID_OPERATION('one or more expired action batch inputs were reserved elsewhere')
    }
    const now = new Date()
    await storage.reserveActionBatchOutputs(outputs.map(output => ({
      actionBatchId: batch.actionBatchId,
      outputId: output.outputId,
      created_at: now,
      updated_at: now
    })), trx)
    await storage.updateActionBatch(batch.actionBatchId, {
      status: 'active',
      expiresAt: new Date(Math.min(batch.hardExpiresAt.getTime(), now.getTime() + ACTION_BATCH_LEASE_MS))
    }, trx)
  })
}

function transactionStatuses (action: ActionBatchCommitAction): { tx: TransactionStatus, req: ProvenTxReqStatus } {
  if (action.metadata.isNoSend) return { tx: 'nosend', req: 'nosend' }
  if (action.metadata.isDelayed) return { tx: 'unprocessed', req: 'unsent' }
  return { tx: 'unprocessed', req: 'unprocessed' }
}

async function persistLabels (
  storage: StorageProvider,
  userId: number,
  transactionId: number,
  labels: string[],
  trx: TrxToken
): Promise<void> {
  for (const label of new Set(labels)) {
    const row = await storage.findOrInsertTxLabel(userId, label, trx)
    await storage.findOrInsertTxLabelMap(transactionId, verifyId(row.txLabelId), trx)
  }
}

async function persistOutputs (
  storage: StorageProvider,
  userId: number,
  transactionId: number,
  validated: ValidatedBatchAction,
  trx: TrxToken
): Promise<TableOutput[]> {
  const { action, tx, rawTx } = validated
  const basketNames = [...new Set(action.plan.outputs.map(output => output.basket).filter((name): name is string => name != null))]
  if (action.plan.outputs.some(output => output.purpose === 'change')) basketNames.push('default')
  const baskets = await storage.findOrInsertOutputBasketsBulk(userId, [...new Set(basketNames)], trx)
  const tagNames = [...new Set(action.plan.outputs.flatMap(output => output.tags))]
  const tags = await storage.findOrInsertOutputTagsBulk(userId, tagNames, trx)
  const offsets = parseTxScriptOffsets(rawTx)
  const rows: TableOutput[] = []
  for (let index = 0; index < action.plan.outputs.length; index++) {
    const planned = action.plan.outputs[index]
    const output = tx.outputs[planned.vout]
    const isChange = planned.providedBy === 'storage' && planned.purpose === 'change'
    const isCommission = planned.providedBy === 'storage' &&
      (planned.purpose === 'storage-commission' || planned.purpose === 'service-charge')
    const offset = offsets.outputs[planned.vout]
    const lockingScript = output.lockingScript.toBinary()
    const now = new Date()
    const row: TableOutput = {
      outputId: 0,
      userId,
      transactionId,
      basketId: isChange ? baskets.default?.basketId : (planned.basket == null ? undefined : baskets[planned.basket].basketId),
      spendable: !isCommission,
      change: isChange,
      outputDescription: planned.outputDescription,
      vout: planned.vout,
      satoshis: planned.satoshis,
      providedBy: planned.providedBy,
      purpose: isCommission ? 'storage-commission' : (planned.purpose ?? ''),
      type: isChange ? 'P2PKH' : 'custom',
      txid: action.txid,
      derivationPrefix: isChange ? action.plan.derivationPrefix : undefined,
      derivationSuffix: isChange ? planned.derivationSuffix : undefined,
      customInstructions: planned.customInstructions,
      scriptLength: offset.length,
      scriptOffset: offset.offset,
      lockingScript: offset.length > storage.getSettings().maxOutputScript ? undefined : lockingScript,
      created_at: now,
      updated_at: now
    }
    row.outputId = await storage.insertOutput(row, trx)
    for (const tagName of new Set(planned.tags)) {
      const tag: TableOutputTag = tags[tagName]
      await storage.findOrInsertOutputTagMap(row.outputId, verifyId(tag.outputTagId), trx)
    }
    if (isCommission) {
      const commission: TableCommission = {
        commissionId: 0,
        userId,
        transactionId,
        satoshis: planned.satoshis,
        keyOffset: action.commissionKeyOffset ?? '',
        isRedeemed: false,
        lockingScript,
        created_at: now,
        updated_at: now
      }
      await storage.insertCommission(commission, trx)
    }
    rows.push(row)
  }
  return rows
}

async function persistAction (
  storage: StorageProvider,
  userId: number,
  validated: ValidatedBatchAction,
  reservedOutputIds: Set<number>,
  stagedByOutpoint: Map<string, TableOutput>,
  trx: TrxToken
): Promise<void> {
  const { action, tx, rawTx } = validated
  const statuses = transactionStatuses(action)
  const managedInputSatoshis = action.plan.inputs
    .filter(input => input.vin >= action.metadata.inputs.length)
    .reduce((sum, input) => sum + input.sourceSatoshis, 0)
  const changeOutputSatoshis = action.plan.outputs
    .filter(output => output.purpose === 'change')
    .reduce((sum, output) => sum + output.satoshis, 0)
  const now = new Date()
  const transaction: TableTransaction = {
    transactionId: 0,
    userId,
    status: statuses.tx,
    reference: action.reference,
    isOutgoing: true,
    satoshis: changeOutputSatoshis - managedInputSatoshis,
    description: action.metadata.description,
    version: tx.version,
    lockTime: tx.lockTime,
    txid: action.txid,
    created_at: now,
    updated_at: now
  }
  transaction.transactionId = await storage.insertTransaction(transaction, trx)
  await persistLabels(storage, userId, transaction.transactionId, action.metadata.labels, trx)

  for (const input of action.plan.inputs) {
    const outpoint = `${input.sourceTxid}.${input.sourceVout}`
    let output = stagedByOutpoint.get(outpoint)
    output ??= (await storage.findOutputsByOutpoints(userId, [{ txid: input.sourceTxid, vout: input.sourceVout }], trx))[outpoint]
    if (output == null) continue
    if (output.spentBy != null || !output.spendable) throw new WERR_INVALID_OPERATION(`input ${outpoint} is no longer spendable`)
    if (!stagedByOutpoint.has(outpoint) && !reservedOutputIds.has(output.outputId)) {
      throw new WERR_INVALID_OPERATION(`input ${outpoint} was not reserved by this action batch`)
    }
    await storage.updateOutput(output.outputId, {
      spendable: false,
      spentBy: transaction.transactionId,
      spendingDescription: action.metadata.inputs[input.vin]?.inputDescription
    }, trx)
    output.spendable = false
    output.spentBy = transaction.transactionId
  }

  const outputRows = await persistOutputs(storage, userId, transaction.transactionId, validated, trx)
  for (const output of outputRows) stagedByOutpoint.set(`${action.txid}.${output.vout}`, output)

  const req = EntityProvenTxReq.fromTxid(action.txid, rawTx, validated.inputBeef)
  req.status = statuses.req
  req.addNotifyTransactionId(transaction.transactionId)
  await req.insertOrMerge(storage, trx)
}

async function persistManifestAtomically (
  storage: StorageProvider,
  userId: number,
  batch: TableActionBatch,
  manifest: ActionBatchManifest,
  validated: { actions: ValidatedBatchAction[], dependencyBeef: number[] }
): Promise<void> {
  const reservedOutputIds = new Set(await storage.findActionBatchOutputIds(batch.actionBatchId))
  await storage.transaction(async trx => {
    const stagedByOutpoint = new Map<string, TableOutput>()
    for (const action of validated.actions) {
      await persistAction(storage, userId, action, reservedOutputIds, stagedByOutpoint, trx)
    }
    await storage.deleteActionBatchOutputReservations(batch.actionBatchId, trx)
    await storage.deleteActionBatchBlobRecords(batch.actionBatchId, trx)
    await storage.updateActionBatch(batch.actionBatchId, {
      status: 'committed',
      manifestDigest: manifest.digest
    }, trx)
  })
}

async function completeCommittedBatch (
  storage: StorageProvider,
  userId: number,
  batch: TableActionBatch,
  manifest: ActionBatchManifest,
  alreadyCommitted: boolean
): Promise<CommitActionBatchResult> {
  if (batch.result != null) {
    const saved = JSON.parse(batch.result) as CommitActionBatchResult
    return { ...saved, alreadyCommitted: true }
  }
  const { swr, ndr } = await shareReqsWithWorld(storage, userId, manifest.sendWith, manifest.isDelayed)
  const result: CommitActionBatchResult = {
    batchId: manifest.batchId,
    manifestDigest: manifest.digest,
    committedTxids: manifest.actions.map(action => action.txid),
    alreadyCommitted,
    sendWithResults: swr,
    notDelayedResults: ndr
  }
  await storage.updateActionBatch(batch.actionBatchId, { result: JSON.stringify(result) })
  return result
}

export async function commitActionBatch (
  storage: StorageProvider,
  auth: AuthId,
  manifest: ActionBatchManifest
): Promise<CommitActionBatchResult> {
  if (!verifyActionBatchManifestDigest(manifest)) throw new WERR_INVALID_PARAMETER('manifest.digest', 'valid')
  const userId = verifyId(auth.userId)
  const batch = await storage.findActionBatch(userId, manifest.batchId)
  if (batch == null) throw new WERR_INVALID_OPERATION('action batch was not found')
  if (batch.status === 'committed') {
    if (batch.manifestDigest !== manifest.digest) throw new WERR_INVALID_OPERATION('batch committed with another manifest')
    return await completeCommittedBatch(storage, userId, batch, manifest, true)
  }
  if (batch.status === 'aborted') throw new WERR_INVALID_OPERATION('aborted action batch cannot be committed')
  const needsReacquire = batch.status === 'expired' || activeExpiry(batch)
  if (!needsReacquire) requireLiveBatch(batch)
  else if (batch.hardExpiresAt.getTime() <= Date.now()) {
    throw new WERR_INVALID_OPERATION('action batch hard lifetime has expired')
  }
  if (batch.manifestDigest != null && batch.manifestDigest !== manifest.digest) {
    throw new WERR_INVALID_OPERATION('batch prepared with another manifest')
  }
  const validated = await validateManifestActions(storage, batch, manifest)
  if (needsReacquire) await reacquireManifestInputs(storage, userId, batch, validated)
  await persistManifestAtomically(storage, userId, batch, manifest, validated)
  batch.status = 'committed'
  batch.manifestDigest = manifest.digest
  return await completeCommittedBatch(storage, userId, batch, manifest, false)
}

export async function abortActionBatch (
  storage: StorageProvider,
  auth: AuthId,
  batchId: string
): Promise<AbortActionBatchResult> {
  const userId = verifyId(auth.userId)
  const batch = await storage.findActionBatch(userId, batchId)
  if (batch == null || batch.status === 'aborted') return { aborted: true }
  if (batch.status === 'committed') return { aborted: false }
  await storage.transaction(async trx => await releaseBatchState(storage, batch, 'aborted', trx))
  return { aborted: true }
}
