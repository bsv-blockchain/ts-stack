import {
  Beef,
  Script,
  Validation
} from '@bsv/sdk'
import {
  AbortActionBatchResult,
  ActionBatchCommitAction,
  ActionBatchFundingOutput,
  ActionBatchManifest,
  BeginActionBatchArgs,
  BeginActionBatchResult,
  CommitActionBatchByDigestArgs,
  CommitActionBatchResult,
  ExtendActionBatchArgs,
  ExtendActionBatchResult,
  RenewActionBatchResult,
  StorageCapabilities
} from '../../sdk/ActionBatch.interfaces'
import { AuthId, TrxToken } from '../../sdk/WalletStorage.interfaces'
import { ProvenTxReqStatus, TransactionStatus } from '../../sdk/types'
import { WERR_INTERNAL, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { verifyId, verifyOne } from '../../utility/utilityHelpers'
import { verifyActionBatchManifestDigest } from '../../utility/actionBatchDigest'
import { supportedActionBatchPackEncodings } from '../../utility/actionBatchPack'
import { validateStorageFeeModel } from '../StorageProvider'
import type { StorageProvider } from '../StorageProvider'
import { EntityProvenTxReq } from '../schema/entities/EntityProvenTxReq'
import { TableActionBatch } from '../schema/tables/TableActionBatch'
import { TableCommission } from '../schema/tables/TableCommission'
import { TableOutput } from '../schema/tables/TableOutput'
import { TableOutputBasket } from '../schema/tables/TableOutputBasket'
import { TableOutputTag } from '../schema/tables/TableOutputTag'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { TableTxLabel } from '../schema/tables/TableTxLabel'
import { isAutoSpendableChangeOutput } from './managedChange'
import { parseTxScriptOffsets } from '../../utility/parseTxScriptOffsets'
import { shareReqsWithWorld } from './processAction'
import type { GetReqsAndBeefResult } from './processAction'
import { classifyReqStatus } from '../storageProviderHelpers'
import { transactionSize } from './utils'
import { selectCanonicalChange } from './actionPlanning'
import {
  ACTION_BATCH_MAX_BLOB_BYTES,
  ACTION_BATCH_MAX_CONCURRENT_UPLOADS,
  ACTION_BATCH_MAX_INLINE_BYTES,
  ACTION_BATCH_MAX_PACK_BYTES,
  ACTION_BATCH_MAX_PACK_ITEMS,
  validateActionBatchInlinePayload,
  validateCompactManifest
} from './actionBatchBlobs'
import { validateManifestActions } from './actionBatchValidation'
import type { ValidatedBatchAction } from './actionBatchValidation'

export const ACTION_BATCH_LEASE_MS = 15 * 60 * 1000
export const ACTION_BATCH_HARD_LIFETIME_MS = 60 * 60 * 1000
const INITIAL_RESERVATION_LIMIT = 8
const INITIAL_EXTRA_OUTPUTS = 3
export const ACTION_BATCH_MAX_RESERVATION_EXTENSION_OUTPUTS = 64

export function getActionBatchCapabilities (): StorageCapabilities {
  return {
    actionBatch: {
      version: 1,
      maxInlineBytes: ACTION_BATCH_MAX_INLINE_BYTES,
      maxBlobBytes: ACTION_BATCH_MAX_BLOB_BYTES,
      maxConcurrentUploads: ACTION_BATCH_MAX_CONCURRENT_UPLOADS,
      leaseMs: ACTION_BATCH_LEASE_MS,
      hardLifetimeMs: ACTION_BATCH_HARD_LIFETIME_MS,
      compactBegin: true,
      manifestVersion: 2,
      commitByDigest: true,
      packedUploads: {
        version: 1,
        maxPackBytes: ACTION_BATCH_MAX_PACK_BYTES,
        maxItems: ACTION_BATCH_MAX_PACK_ITEMS,
        encodings: supportedActionBatchPackEncodings(),
        // Require a prepared manifest to authorize every persisted digest.
        // Clients still support eager uploads for providers that can enforce
        // an equivalent bounded authorization policy.
        eager: false
      }
    }
  }
}

function activeExpiry (batch: TableActionBatch, now = new Date()): boolean {
  return batch.status !== 'active' && batch.status !== 'prepared' ||
    batch.expiresAt.getTime() <= now.getTime() ||
    batch.hardExpiresAt.getTime() <= now.getTime()
}

function canExpire (batch: TableActionBatch, now = new Date()): boolean {
  return (batch.status === 'active' || batch.status === 'prepared') &&
    (batch.expiresAt.getTime() <= now.getTime() || batch.hardExpiresAt.getTime() <= now.getTime())
}

async function releaseBatchState (
  storage: StorageProvider,
  batch: TableActionBatch,
  status: 'aborted' | 'committed' | 'expired',
  trx?: TrxToken
): Promise<void> {
  await storage.deleteActionBatchOutputReservations(batch.actionBatchId, trx)
  await storage.deleteActionBatchBlobRecords(batch.actionBatchId, trx)
  await storage.updateActionBatch(batch.actionBatchId, {
    status,
    manifest: undefined,
    uploadDigests: undefined
  }, trx)
}

export async function cleanupExpiredActionBatches (storage: StorageProvider): Promise<number> {
  const now = new Date()
  const expired = await storage.findExpiredActionBatches(now)
  let released = 0
  for (const batch of expired) {
    await storage.transaction(async trx => {
      const current = await storage.findActionBatchForUpdate(batch.userId, batch.batchId, trx)
      if (current == null || !canExpire(current, now)) return
      await releaseBatchState(storage, current, 'expired', trx)
      released++
    })
  }
  return released
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
  args: Validation.ValidCreateActionArgs,
  allowDeferredProofs: boolean
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
      if (allowDeferredProofs) continue
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
  inputSatoshis: number,
  outputScriptLengths?: number[]
): number {
  const outputSatoshis = args.outputs.reduce((sum, output) => sum + output.satoshis, 0) + storage.commissionSatoshis
  const inputLengths = args.inputs.map(input => input.unlockingScriptLength)
  const outputLengths = outputScriptLengths ?? args.outputs.map(output => output.lockingScript.length / 2)
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
  fillLimit: boolean,
  planningCosts: {
    firstChangeCost: number
    marginalInputFee: number
  }
): TableOutput[] {
  const remaining = candidates
    .filter(output => output.satoshis > planningCosts.marginalInputFee)
  const chosen: TableOutput[] = []
  // A reservation is useful to generateChangeSdk only after it also covers
  // the marginal funding-input fee and leaves an economically viable first
  // change output. Without this buffer, a tiny target repeatedly selects dust
  // that satisfies the nominal deficit but can never close the real plan.
  let deficit = targetSatoshis + planningCosts.firstChangeCost
  while (deficit > 0 && chosen.length < limit) {
    const output = selectCanonicalChange(
      remaining,
      deficit + planningCosts.marginalInputFee
    )
    if (output == null) break
    chosen.push(output)
    remaining.splice(remaining.indexOf(output), 1)
    deficit -= output.satoshis - planningCosts.marginalInputFee
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

function reservationPlanningCosts (
  storage: StorageProvider,
  basket: TableOutputBasket
): { firstChangeCost: number, marginalInputFee: number } {
  const satsPerKb = validateStorageFeeModel(storage.feeModel).value ?? 0
  const minimumSpendSize = transactionSize([107], [25])
  const minimumSpendFee = Math.ceil(minimumSpendSize * satsPerKb / 1000)
  const dustFloor = Math.max(1, minimumSpendFee * 2)
  const marginalInputSize = transactionSize([107], []) - transactionSize([], [])
  const marginalOutputSize = transactionSize([], [25]) - transactionSize([], [])
  const desiredFirstChange = Math.max(
    dustFloor,
    Math.max(1, Math.round(basket.minimumDesiredUTXOValue / 4))
  )
  return {
    firstChangeCost: desiredFirstChange + Math.ceil(marginalOutputSize * satsPerKb / 1000),
    marginalInputFee: Math.ceil(marginalInputSize * satsPerKb / 1000)
  }
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
    const outpoints = unique.map(output => {
      if (output.txid == null) throw new WERR_INVALID_OPERATION('action batch output is missing its txid')
      return { txid: output.txid, vout: output.vout }
    })
    const current = await storage.findOutputsByOutpointsForUpdate(
      batch.userId,
      outpoints,
      transaction
    )
    for (const output of unique) {
      const stored = output.txid == null ? undefined : current[`${output.txid}.${output.vout}`]
      if (stored == null || !stored.spendable || stored.spentBy != null) {
        throw new WERR_INVALID_OPERATION('one or more action batch outputs are no longer spendable')
      }
    }
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
    if (output.txid != null && beef.findTxid(output.txid) == null) {
      beef.mergeBeef(await storage.getBeefForTransaction(output.txid, {
        knownTxids: args.options.knownTxids,
        ignoreServices: true
      }))
    }
    result.push(copy)
  }
  return { outputs: result, beef: beef.toUint8Array() }
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
  const outputScriptLengths = args.firstActionOutputScriptLengths
  if (outputScriptLengths != null && (
    outputScriptLengths.length !== args.firstAction.outputs.length ||
    outputScriptLengths.some(length => !Number.isSafeInteger(length) || length < 0) ||
    args.firstAction.outputs.some((output, index) =>
      output.lockingScript.length > 0 &&
      output.lockingScript.length / 2 !== outputScriptLengths[index]
    )
  )) {
    throw new WERR_INVALID_PARAMETER(
      'firstActionOutputScriptLengths',
      'valid byte lengths aligned with firstAction outputs'
    )
  }
  const changeBasket = verifyOne(await storage.findOutputBaskets({ partial: { userId, name: 'default' } }))
  const explicit = await resolveExplicitOutputs(
    storage,
    userId,
    args.firstAction,
    outputScriptLengths != null
  )
  const noSendChange = await resolveNoSendChangeOutputs(storage, userId, args.firstAction)
  const fixedOutputIds = new Set([...explicit.outputs, ...noSendChange.outputs].map(output => output.outputId))
  const available = (await storage.findAvailableManagedChangeInputs(
    userId, changeBasket.basketId, !args.firstAction.isDelayed
  )).filter(output => !fixedOutputIds.has(output.outputId))
  const target = estimateFirstActionTarget(
    storage,
    args.firstAction,
    explicit.inputSatoshis + noSendChange.inputSatoshis,
    outputScriptLengths
  )
  const fixedOutputs = [...explicit.outputs, ...noSendChange.outputs]
  const requiredCapacity = Math.max(0, INITIAL_RESERVATION_LIMIT - fixedOutputs.length)
  const funding = chooseReservationPool(
    available,
    target,
    requiredCapacity,
    INITIAL_EXTRA_OUTPUTS,
    false,
    reservationPlanningCosts(storage, changeBasket)
  )
  const batch = newBatch(userId, args.batchId)
  await storage.transaction(async trx => {
    await storage.insertActionBatch(batch, trx)
    await reserveOutputs(storage, batch, [...fixedOutputs, ...funding], trx)
  })
  let fundingResult: Awaited<ReturnType<typeof makeFundingResult>>
  try {
    fundingResult = await makeFundingResult(storage, args.firstAction, [...funding, ...fixedOutputs])
  } catch (error) {
    await storage.transaction(async trx => await releaseBatchState(storage, batch, 'aborted', trx))
    throw error
  }
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
  const available = await storage.findAvailableManagedChangeInputs(userId, basket.basketId, false)
  if (!Number.isSafeInteger(args.requestedOutputs) || args.requestedOutputs < 0) {
    throw new WERR_INVALID_PARAMETER('requestedOutputs', 'non-negative safe integer')
  }
  const requestedCount = Math.min(
    args.requestedOutputs,
    ACTION_BATCH_MAX_RESERVATION_EXTENSION_OUTPUTS
  )
  const funding = chooseReservationPool(
    available,
    Math.max(1, args.targetSatoshis),
    requestedCount,
    0,
    true,
    reservationPlanningCosts(storage, basket)
  )
  const explicitByOutpoint = await storage.findOutputsByOutpoints(userId, args.explicitOutpoints)
  const explicit = Object.values(explicitByOutpoint)
    .filter(output => !alreadyReserved.includes(output.outputId))
  const fundingShape = argsToFundingShape(args.includeSourceTransactions)
  const fundingResult = await makeFundingResult(storage, fundingShape, [...funding, ...explicit])
  const expiresAt = new Date(Math.min(
    batch.hardExpiresAt.getTime(),
    Date.now() + ACTION_BATCH_LEASE_MS
  ))
  await storage.transaction(async trx => {
    const current = requireLiveBatch(await storage.findActionBatchForUpdate(userId, args.batchId, trx))
    await reserveOutputs(storage, current, [...funding, ...explicit], trx)
    await storage.updateActionBatch(current.actionBatchId, { expiresAt }, trx)
  })
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
  return await storage.transaction(async trx => {
    const batch = requireLiveBatch(await storage.findActionBatchForUpdate(userId, batchId, trx))
    const expiresAt = new Date(Math.min(batch.hardExpiresAt.getTime(), Date.now() + ACTION_BATCH_LEASE_MS))
    await storage.updateActionBatch(batch.actionBatchId, { expiresAt }, trx)
    return { expiresAt: expiresAt.toISOString() }
  })
}

async function reacquireManifestInputs (
  storage: StorageProvider,
  userId: number,
  batch: TableActionBatch,
  validated: { actions: ValidatedBatchAction[] },
  trx: TrxToken
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

  const stored = await storage.findOutputsByOutpointsForUpdate(userId, outpoints, trx)
  await storage.deleteActionBatchOutputReservations(batch.actionBatchId, trx)
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
}

function transactionStatuses (action: ActionBatchCommitAction): { tx: TransactionStatus, req: ProvenTxReqStatus } {
  if (action.metadata.isNoSend) return { tx: 'nosend', req: 'nosend' }
  if (action.metadata.isDelayed) return { tx: 'unprocessed', req: 'unsent' }
  return { tx: 'unprocessed', req: 'unprocessed' }
}

async function persistLabels (
  storage: StorageProvider,
  transactionId: number,
  labels: string[],
  labelsByName: ReadonlyMap<string, TableTxLabel>,
  trx: TrxToken
): Promise<void> {
  for (const label of new Set(labels)) {
    const row = labelsByName.get(label)
    if (row == null) throw new WERR_INTERNAL(`missing preloaded transaction label ${label}`)
    await storage.findOrInsertTxLabelMap(transactionId, verifyId(row.txLabelId), trx)
  }
}

function outputBasketId (
  isChange: boolean,
  basket: string | undefined,
  baskets: Record<string, TableOutputBasket>
): number | undefined {
  if (isChange) return baskets.default?.basketId
  return basket == null ? undefined : baskets[basket].basketId
}

async function persistOutputTags (
  storage: StorageProvider,
  outputId: number,
  tagNames: string[],
  tags: Record<string, TableOutputTag>,
  trx: TrxToken
): Promise<void> {
  for (const tagName of new Set(tagNames)) {
    const tag = tags[tagName]
    await storage.findOrInsertOutputTagMap(outputId, verifyId(tag.outputTagId), trx)
  }
}

async function persistOutputCommission (
  storage: StorageProvider,
  row: TableOutput,
  action: ActionBatchCommitAction,
  transactionId: number,
  trx: TrxToken
): Promise<void> {
  if (row.lockingScript == null) {
    throw new WERR_INTERNAL('commission locking script must be retained')
  }
  const commission: TableCommission = {
    commissionId: 0,
    userId: row.userId,
    transactionId,
    satoshis: row.satoshis,
    keyOffset: action.commissionKeyOffset ?? '',
    isRedeemed: false,
    lockingScript: row.lockingScript,
    created_at: row.created_at,
    updated_at: row.updated_at
  }
  await storage.insertCommission(commission, trx)
}

async function persistOutputs (
  storage: StorageProvider,
  userId: number,
  transactionId: number,
  validated: ValidatedBatchAction,
  baskets: Record<string, TableOutputBasket>,
  tags: Record<string, TableOutputTag>,
  trx: TrxToken
): Promise<TableOutput[]> {
  const { action, tx, rawTx } = validated
  const offsets = parseTxScriptOffsets(rawTx)
  const rows: TableOutput[] = []
  for (const planned of action.plan.outputs) {
    const output = tx.outputs[planned.vout]
    const isChange = planned.providedBy === 'storage' && planned.purpose === 'change'
    const isCommission = planned.providedBy === 'storage' &&
      (planned.purpose === 'storage-commission' || planned.purpose === 'service-charge')
    const offset = offsets.outputs[planned.vout]
    const lockingScript = offset.length <= storage.getSettings().maxOutputScript || isCommission
      ? output.lockingScript.toBinary()
      : undefined
    const now = new Date()
    const row: TableOutput = {
      outputId: 0,
      userId,
      transactionId,
      basketId: outputBasketId(isChange, planned.basket, baskets),
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
      lockingScript,
      created_at: now,
      updated_at: now
    }
    row.outputId = await storage.insertOutput(row, trx)
    await persistOutputTags(storage, row.outputId, planned.tags, tags, trx)
    if (isCommission) await persistOutputCommission(storage, row, action, transactionId, trx)
    rows.push(row)
  }
  return rows
}

async function persistAction (
  ...[
    storage,
    userId,
    validated,
    reservedOutputIds,
    storedByOutpoint,
    stagedByOutpoint,
    labelsByName,
    baskets,
    tags,
    trx
  ]: [
    storage: StorageProvider,
    userId: number,
    validated: ValidatedBatchAction,
    reservedOutputIds: Set<number>,
    storedByOutpoint: Readonly<Record<string, TableOutput>>,
    stagedByOutpoint: Map<string, TableOutput>,
    labelsByName: ReadonlyMap<string, TableTxLabel>,
    baskets: Record<string, TableOutputBasket>,
    tags: Record<string, TableOutputTag>,
    trx: TrxToken
  ]
): Promise<EntityProvenTxReq> {
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
  await persistLabels(storage, transaction.transactionId, action.metadata.labels, labelsByName, trx)

  for (const input of action.plan.inputs) {
    const outpoint = `${input.sourceTxid}.${input.sourceVout}`
    let output = stagedByOutpoint.get(outpoint)
    output ??= storedByOutpoint[outpoint]
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

  const outputRows = await persistOutputs(
    storage,
    userId,
    transaction.transactionId,
    validated,
    baskets,
    tags,
    trx
  )
  for (const output of outputRows) stagedByOutpoint.set(`${action.txid}.${output.vout}`, output)

  const req = EntityProvenTxReq.fromTxid(
    action.txid,
    rawTx,
    validated.externalInputBeef
  )
  req.status = statuses.req
  req.addNotifyTransactionId(transaction.transactionId)
  return await req.insertOrMerge(storage, trx)
}

async function persistManifestAtomically (
  storage: StorageProvider,
  userId: number,
  batch: TableActionBatch,
  manifest: ActionBatchManifest,
  validated: { actions: ValidatedBatchAction[], dependencyBeef: Uint8Array, beef: Beef }
): Promise<{
    batch: TableActionBatch
    alreadyCommitted: boolean
    share?: GetReqsAndBeefResult
  }> {
  return await storage.transaction(async trx => {
    const current = await storage.findActionBatchForUpdate(userId, batch.batchId, trx)
    if (current == null) throw new WERR_INVALID_OPERATION('action batch was not found')
    if (current.status === 'committed') {
      if (current.manifestDigest !== manifest.digest) {
        throw new WERR_INVALID_OPERATION('batch committed with another manifest')
      }
      return { batch: current, alreadyCommitted: true }
    }
    if (current.status === 'aborted') throw new WERR_INVALID_OPERATION('aborted action batch cannot be committed')
    if (current.manifestDigest != null && current.manifestDigest !== manifest.digest) {
      throw new WERR_INVALID_OPERATION('batch prepared with another manifest')
    }
    const needsReacquire = current.status === 'expired' || activeExpiry(current)
    if (needsReacquire) {
      if (current.hardExpiresAt.getTime() <= Date.now()) {
        throw new WERR_INVALID_OPERATION('action batch hard lifetime has expired')
      }
      await reacquireManifestInputs(storage, userId, current, validated, trx)
    } else {
      requireLiveBatch(current)
    }
    const reservedOutputIds = new Set(await storage.findActionBatchOutputIds(current.actionBatchId, trx))
    const stagedTxids = new Set(validated.actions.map(({ action }) => action.txid))
    const inputOutpoints = [...new Map(validated.actions.flatMap(({ action }) => action.plan.inputs)
      .filter(input => !stagedTxids.has(input.sourceTxid))
      .map(input => [`${input.sourceTxid}.${input.sourceVout}`, {
        txid: input.sourceTxid,
        vout: input.sourceVout
      }])).values()]
    const storedByOutpoint = await storage.findOutputsByOutpointsForUpdate(
      userId,
      inputOutpoints,
      trx
    )
    const allBasketNames = validated.actions.flatMap(({ action }) =>
      action.plan.outputs.flatMap(output => output.basket == null ? [] : [output.basket])
    )
    if (validated.actions.some(({ action }) =>
      action.plan.outputs.some(output => output.purpose === 'change')
    )) allBasketNames.push('default')
    const baskets = await storage.findOrInsertOutputBasketsBulk(
      userId,
      [...new Set(allBasketNames)],
      trx
    )
    const tags = await storage.findOrInsertOutputTagsBulk(
      userId,
      [...new Set(validated.actions.flatMap(({ action }) =>
        action.plan.outputs.flatMap(output => output.tags)
      ))],
      trx
    )
    const labelNames = [...new Set(validated.actions.flatMap(({ action }) => action.metadata.labels))]
    const labelsByName = new Map(Object.entries(
      await storage.findOrInsertTxLabelsBulk(userId, labelNames, trx)
    ))
    const stagedByOutpoint = new Map<string, TableOutput>()
    const reqsByTxid = new Map<string, EntityProvenTxReq>()
    for (const action of validated.actions) {
      const req = await persistAction(
        storage,
        userId,
        action,
        reservedOutputIds,
        storedByOutpoint,
        stagedByOutpoint,
        labelsByName,
        baskets,
        tags,
        trx
      )
      reqsByTxid.set(action.action.txid, req)
    }
    await storage.deleteActionBatchOutputReservations(current.actionBatchId, trx)
    await storage.deleteActionBatchBlobRecords(current.actionBatchId, trx)
    await storage.updateActionBatch(current.actionBatchId, {
      status: 'committed',
      manifestDigest: manifest.digest
    }, trx)
    current.status = 'committed'
    current.manifestDigest = manifest.digest
    const details = manifest.sendWith.map(txid => {
      const req = reqsByTxid.get(txid)
      if (req == null) return undefined
      const reqApi = req.toApi()
      const detail: GetReqsAndBeefResult['details'][number] = {
        txid,
        req: reqApi,
        status: 'unknown'
      }
      classifyReqStatus(detail, reqApi)
      return detail
    })
    return {
      batch: current,
      alreadyCommitted: false,
      share: details.every(detail => detail != null)
        ? {
            beef: validated.beef,
            details: details.filter((detail): detail is NonNullable<typeof detail> => detail != null),
            verified: true
          }
        : undefined
    }
  })
}

async function completeCommittedBatch (
  storage: StorageProvider,
  userId: number,
  batch: TableActionBatch,
  manifest: ActionBatchManifest,
  alreadyCommitted: boolean,
  share?: GetReqsAndBeefResult
): Promise<CommitActionBatchResult> {
  if (batch.result != null) {
    const saved = JSON.parse(batch.result) as CommitActionBatchResult
    return {
      batchId: saved.batchId,
      manifestDigest: saved.manifestDigest,
      committedTxids: saved.committedTxids,
      alreadyCommitted: true,
      sendWithResults: saved.sendWithResults,
      notDelayedResults: saved.notDelayedResults,
      log: saved.log
    }
  }
  const { swr, ndr } = await shareReqsWithWorld(
    storage,
    userId,
    manifest.sendWith,
    manifest.isDelayed,
    share
  )
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

async function commitActionBatchOnce (
  storage: StorageProvider,
  userId: number,
  manifest: ActionBatchManifest
): Promise<CommitActionBatchResult> {
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
  const persisted = await persistManifestAtomically(storage, userId, batch, manifest, validated)
  return await completeCommittedBatch(
    storage,
    userId,
    persisted.batch,
    manifest,
    persisted.alreadyCommitted,
    persisted.share
  )
}

interface ActiveBatchCommit {
  digest: string
  promise: Promise<CommitActionBatchResult>
}

const activeBatchCommits = new WeakMap<StorageProvider, Map<string, ActiveBatchCommit>>()

export async function commitActionBatch (
  storage: StorageProvider,
  auth: AuthId,
  manifest: ActionBatchManifest
): Promise<CommitActionBatchResult> {
  validateActionBatchInlinePayload(manifest)
  if (!verifyActionBatchManifestDigest(manifest)) throw new WERR_INVALID_PARAMETER('manifest.digest', 'valid')
  validateCompactManifest(manifest)
  const userId = verifyId(auth.userId)
  let commits = activeBatchCommits.get(storage)
  if (commits == null) {
    commits = new Map()
    activeBatchCommits.set(storage, commits)
  }
  const key = `${userId}:${manifest.batchId}`
  const active = commits.get(key)
  if (active != null) {
    if (active.digest !== manifest.digest) {
      throw new WERR_INVALID_OPERATION('action batch commit is active with another manifest')
    }
    return await active.promise
  }
  const promise = commitActionBatchOnce(storage, userId, manifest)
    .finally(() => { commits?.delete(key) })
  commits.set(key, { digest: manifest.digest, promise })
  return await promise
}

export async function commitActionBatchByDigest (
  storage: StorageProvider,
  auth: AuthId,
  args: CommitActionBatchByDigestArgs
): Promise<CommitActionBatchResult> {
  const userId = verifyId(auth.userId)
  const batch = await storage.findActionBatch(userId, args.batchId)
  if (batch?.manifestDigest !== args.digest || batch?.manifest == null) {
    throw new WERR_INVALID_OPERATION('prepared action batch manifest was not found')
  }
  const manifest = JSON.parse(batch.manifest) as ActionBatchManifest
  if (manifest.format !== 2 || manifest.batchId !== args.batchId || manifest.digest !== args.digest ||
    !verifyActionBatchManifestDigest(manifest)) {
    throw new WERR_INVALID_OPERATION('prepared action batch manifest is invalid')
  }
  return await commitActionBatch(storage, auth, manifest)
}

export async function abortActionBatch (
  storage: StorageProvider,
  auth: AuthId,
  batchId: string
): Promise<AbortActionBatchResult> {
  const userId = verifyId(auth.userId)
  return await storage.transaction(async trx => {
    const batch = await storage.findActionBatchForUpdate(userId, batchId, trx)
    if (batch == null || batch.status === 'aborted') return { aborted: true }
    if (batch.status === 'committed') return { aborted: false }
    await releaseBatchState(storage, batch, 'aborted', trx)
    return { aborted: true }
  })
}
