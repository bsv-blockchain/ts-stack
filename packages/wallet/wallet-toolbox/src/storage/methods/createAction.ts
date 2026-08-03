import { Beef, OriginatorDomainNameStringUnder250Bytes, Random, Script, TelemetrySpan, Utils, Validation } from '@bsv/sdk'
import {
  generateChangeSdk,
  GenerateChangeSdkChangeInput,
  GenerateChangeSdkParams,
  GenerateChangeSdkResult,
  maxPossibleSatoshis
} from './generateChange'
import { StorageProvider, validateStorageFeeModel } from '../StorageProvider'
import {
  AuthId,
  StorageCreateActionResult,
  StorageCreateTransactionSdkInput,
  StorageCreateTransactionSdkOutput,
  StorageFeeModel,
  StorageGetBeefOptions,
  StorageProvidedBy,
  TrxToken
} from '../../sdk/WalletStorage.interfaces'
import {
  WERR_INTERNAL,
  WERR_INVALID_OPERATION,
  WERR_INVALID_PARAMETER,
  WERR_REVIEW_ACTIONS
} from '../../sdk/WERR_errors'
import {
  randomBytesBase64,
  verifyId,
  verifyInteger,
  verifyNumber,
  verifyOne,
  verifyOneOrNone,
  verifyTruthy
} from '../../utility/utilityHelpers'
import { TableOutputBasket } from '../schema/tables/TableOutputBasket'
import { TableOutput } from '../schema/tables/TableOutput'
import { asArray, asString } from '../../utility/utilityHelpers.noBuffer'
import { TableOutputTag } from '../schema/tables/TableOutputTag'
import { TableTransaction } from '../schema/tables/TableTransaction'
import { EntityProvenTx } from '../schema/entities/EntityProvenTx'
import { throwDummyReviewActions } from '../../Wallet'
import { createStorageServiceChargeScript } from './offsetKey'
import { WalletError } from '../../sdk'
import { isAutoSpendableChangeOutput } from './managedChange'
import type { ManagedChangeInputCandidate } from './availableManagedChange'
import { CanonicalChangeSelector, randomizeOutputVouts as randomizePlannedOutputVouts } from './actionPlanning'
import { TransactionStatus } from '../../sdk/types'

let disableDoubleSpendCheckForTest = true
export function setDisableDoubleSpendCheckForTest(v: boolean) {
  disableDoubleSpendCheckForTest = v
}

export async function createAction(
  storage: StorageProvider,
  auth: AuthId,
  vargs: Validation.ValidCreateActionArgs,
  _originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<StorageCreateActionResult> {
  if (!storage.telemetry.enabled) return await createActionCore(storage, auth, vargs)
  return await storage.telemetry.withSpan(
    'wallet.storage.create_action',
    {
      component: 'wallet-storage',
      carrier: vargs,
      attributes: {
        'action.fixed_input_count': vargs.inputs.length,
        'action.fixed_output_count': vargs.outputs.length,
        'action.known_txid_count': vargs.options.knownTxids?.length ?? 0,
        'action.is_delayed': vargs.isDelayed,
        'action.is_no_send': vargs.isNoSend
      }
    },
    async span => {
      const result = await createActionCore(storage, auth, vargs, span)
      span.end({
        attributes: {
          'action.result_input_count': result.inputs.length,
          'action.result_output_count': result.outputs.length,
          'action.input_beef_bytes': result.inputBeef?.length ?? 0
        }
      })
      return result
    }
  )
}

async function createActionCore(
  storage: StorageProvider,
  auth: AuthId,
  vargs: Validation.ValidCreateActionArgs,
  parent?: TelemetrySpan
): Promise<StorageCreateActionResult> {
  const logger = vargs.logger
  logger?.group('storage createAction')
  // stampLog(vargs, `start storage createTransactionSdk`)

  if (vargs.isTestWerrReviewActions) throwDummyReviewActions()

  if (!vargs.isNewTx)
  // The purpose of this function is to create the initial storage records associated
  // with a new transaction. It's an error if we have no new inputs or outputs...
  {
    throw new WERR_INTERNAL()
  }

  /**
   * Steps to create a transaction:
   * - Verify that all inputs either have proof in vargs.inputBEEF or that options.trustSelf === 'known' and input txid.vout are known valid to storage.
   * - Create a new transaction record with status 'unsigned' as the anchor for construction work and to new outputs.
   * - Create all transaction labels.
   * - Add new commission output
   * - Attempt to fund the transaction by allocating change outputs:
   *    - As each change output is selected it is simultaneously locked.
   * - Create all new output, basket, tag records
   * - If requested, create result Beef with complete proofs for all inputs used
   * - Create result inputs with source locking scripts
   * - Create result outputs with new locking scripts.
   * - Create and return result.
  */

  const userId = auth.userId!
  const validated = await traceStorageStep(
    storage,
    'wallet.storage.create_action.validate',
    parent,
    {
      'action.fixed_input_count': vargs.inputs.length,
      'action.fixed_output_count': vargs.outputs.length
    },
    async span => {
      const requiredInputs = await validateRequiredInputs(storage, userId, vargs)
      logger?.log('validated required inputs')
      const xoutputs = validateRequiredOutputs(storage, userId, vargs)
      logger?.log('validated required outputs')

      const changeBasketName = 'default'
      const changeBasket = verifyOne(
        await storage.findOutputBaskets({
          partial: { userId, name: changeBasketName }
        }),
        `Invalid outputGeneration basket "${changeBasketName}"`
      )
      logger?.log('found change basket')

      const noSendChangeIn = await validateNoSendChange(storage, userId, vargs, changeBasket)
      logger?.log('validated noSendChange')
      span?.end({
        attributes: {
          'action.validated_input_count': requiredInputs.xinputs.length,
          'action.validated_output_count': xoutputs.length,
          'action.no_send_change_input_count': noSendChangeIn.length,
          'action.validated_beef_tx_count': requiredInputs.beef.txs.length
        }
      })
      return { ...requiredInputs, xoutputs, changeBasket, noSendChangeIn }
    }
  )
  const { storageBeef, beef, xinputs, xoutputs, changeBasket, noSendChangeIn } = validated

  const feeModel = validateStorageFeeModel(storage.feeModel)
  logger?.log(`validated fee model ${JSON.stringify(feeModel)}`)

  const initialFundingPlan = await prepareFundingPlan(
    storage,
    [userId, vargs, xinputs, xoutputs, changeBasket, noSendChangeIn, feeModel, parent]
  )
  logger?.log(`planned funding from ${initialFundingPlan.availableChangeCount} change inputs`)

  // The selected source txids are known before the write transaction begins.
  // Start their one batched proof read now so PXC/network wait and BEEF
  // assembly overlap the independent transaction-record/funding/output writes.
  // A funding-claim retry is handled below by fetching only any residual roots.
  const allocatedBeefPrefetch = startAllocatedChangeBeefPrefetch(
    storage,
    vargs,
    initialFundingPlan.selected,
    beef,
    parent
  )

  const storageBeefBytes = storageBeef.toBinary()
  let newTx: TableTransaction | undefined
  let newTxCommitted = false
  try {
    const persisted = await storage.transaction(async trx => {
      const initialSatoshis = fundingPlanSatoshis(initialFundingPlan)
      newTx = await traceStorageStep(
        storage,
        'wallet.storage.create_action.create_record',
        parent,
        {
          'action.label_count': vargs.labels.length,
          'action.storage_beef_bytes': storageBeefBytes.length
        },
        async span => {
          const transaction = await createNewTxRecord(
            storage,
            userId,
            vargs,
            storageBeefBytes,
            initialSatoshis,
            trx
          )
          span?.end({ attributes: { 'action.transaction_record_created': true } })
          return transaction
        }
      )
      logger?.log('created new transaction record')

      const ctx: CreateTransactionSdkContext = {
        xinputs,
        xoutputs,
        changeBasket,
        noSendChangeIn,
        feeModel,
        transactionId: newTx.transactionId
      }

      const funded = await fundNewTransactionSdk(storage, userId, vargs, ctx, initialFundingPlan, parent, trx)
      logger?.log('funded new transaction')

      if (funded.maxPossibleSatoshisAdjustment != null) {
        const adjustment = funded.maxPossibleSatoshisAdjustment
        if (ctx.xoutputs[adjustment.fixedOutputIndex].satoshis !== maxPossibleSatoshis) throw new WERR_INTERNAL()
        ctx.xoutputs[adjustment.fixedOutputIndex].satoshis = adjustment.satoshis
        logger?.log('adjusted change outputs to max possible')
      }

      const satoshis = funded.changeOutputs.reduce((sum, output) => sum + output.satoshis, 0) -
        funded.allocatedChange.reduce((sum, output) => sum + output.satoshis, 0)
      if (satoshis !== initialSatoshis) {
        await storage.updateTransaction(newTx.transactionId, { satoshis }, trx)
        newTx.satoshis = satoshis
      }
      const storedOutputs = await traceStorageStep(
        storage,
        'wallet.storage.create_action.persist_outputs',
        parent,
        {
          'action.fixed_output_count': ctx.xoutputs.length,
          'action.change_output_count': funded.changeOutputs.length
        },
        async span => {
          const result = await createNewOutputs(storage, userId, vargs, ctx, funded.changeOutputs, trx)
          span?.end({ attributes: { 'action.persisted_output_count': result.outputs.length } })
          return result
        }
      )
      return { ...funded, ...storedOutputs, ctx }
    })
    newTxCommitted = true
    const committedTx = verifyTruthy(newTx)
    const { allocatedChange, derivationPrefix, outputs, changeVouts, ctx } = persisted
    logger?.log('created new output records')

    const inputBeef = await mergeAllocatedChangeBeefs(
      storage,
      vargs,
      allocatedChange,
      beef,
      allocatedBeefPrefetch,
      parent
    )
    logger?.log('merged allocated change beefs')

    const inputs = await traceStorageStep(
      storage,
      'wallet.storage.create_action.assemble_inputs',
      parent,
      {
        'action.fixed_input_count': ctx.xinputs.length,
        'action.funding_input_count': allocatedChange.length,
        'action.include_source_transactions': vargs.includeAllSourceTransactions
      },
      async span => {
        const assembled = await createNewInputs(storage, userId, vargs, ctx, allocatedChange)
        span?.end({ attributes: { 'action.result_input_count': assembled.length } })
        return assembled
      }
    )
    logger?.log('created new inputs')

    const r: StorageCreateActionResult = {
      reference: committedTx.reference,
      version: committedTx.version!,
      lockTime: committedTx.lockTime!,
      inputs,
      outputs,
      derivationPrefix,
      inputBeef,
      noSendChangeOutputVouts: vargs.isNoSend ? changeVouts : undefined
    }

    logger?.groupEnd()
    return r
  } catch (error) {
    // Always let an overlapped database read settle before cleanup destroys or
    // reuses the provider. Its error is surfaced on the success path above;
    // here the construction error remains authoritative.
    await allocatedBeefPrefetch
    if (newTx?.transactionId != null) {
      try {
        if (newTxCommitted) {
          await storage.updateTransactionStatus('failed', newTx.transactionId)
          logger?.log(`marked failed createAction transaction ${newTx.transactionId} after construction error`)
        } else {
          const failed = await createNewTxRecord(storage, userId, vargs, storageBeefBytes, 0, undefined, 'failed')
          logger?.log(`recorded failed createAction transaction ${failed.transactionId} after rollback`)
        }
      } catch (cleanupError) {
        logger?.log(`failed to clean up createAction transaction ${newTx.transactionId}: ${String(cleanupError)}`)
      }
    }
    logger?.groupEnd()
    throw error
  }
}

interface CreateTransactionSdkContext {
  xinputs: XValidCreateActionInput[]
  xoutputs: XValidCreateActionOutput[]
  changeBasket: TableOutputBasket
  noSendChangeIn: TableOutput[]
  feeModel: StorageFeeModel
  transactionId: number
}

interface XValidCreateActionInput extends Validation.ValidCreateActionInput {
  vin: number
  lockingScript: Script
  satoshis: number
  output?: TableOutput
}

export interface XValidCreateActionOutput extends Validation.ValidCreateActionOutput {
  vout: number
  providedBy: StorageProvidedBy
  purpose?: string
  derivationSuffix?: string
  keyOffset?: string
}

function makeDefaultOutput(userId: number, transactionId: number, satoshis: number, vout: number): TableOutput {
  const now = new Date()
  const output: TableOutput = {
    created_at: now,
    updated_at: now,
    outputId: 0,
    userId,
    transactionId,
    satoshis,
    vout,

    basketId: undefined,
    change: false,
    customInstructions: undefined,
    derivationPrefix: undefined,
    derivationSuffix: undefined,
    outputDescription: '',
    lockingScript: undefined,
    providedBy: 'you',
    purpose: '',
    senderIdentityKey: undefined,
    spendable: true,
    spendingDescription: undefined,
    spentBy: undefined,
    txid: undefined,
    type: ''
  }
  return output
}

/** Check known outputs for double-spend, mark them spent, return competing txid if found. */
async function markKnownInputsSpent(
  storage: StorageProvider,
  knownInputRows: Array<{ i: XValidCreateActionInput; o: TableOutput }>,
  transactionId: number
): Promise<string | undefined> {
  let doubleSpendTxid: string | undefined
  await storage.transaction(async trx => {
    const outputIds = knownInputRows.map(ni => verifyId(ni.o.outputId))
    const knownOutputsById = await storage.findOutputsByIds(outputIds, trx)
    for (const ni of knownInputRows) {
      const { i, o } = ni
      const o2 = knownOutputsById[verifyId(o.outputId)]
      if (!o2) throw new WERR_INTERNAL(`missing outputId ${o.outputId}`)
      if (o2.spentBy !== undefined && o2.spentBy !== null) {
        const spendingTx = await storage.findTransactionById(verifyId(o2.spentBy), trx)
        if (spendingTx?.txid) {
          doubleSpendTxid = spendingTx.txid
          return
        }
      }
      if (!o2.spendable) {
        throw new WERR_INVALID_PARAMETER(
          `inputs[${i.vin}]`,
          `spendable output. output ${o.txid}:${o.vout} appears to have been spent (spendable=${o2.spendable}).`
        )
      }
      await storage.updateOutput(
        verifyId(o.outputId),
        { spendable: false, spentBy: transactionId, spendingDescription: i.inputDescription },
        trx
      )
      o.spendable = false
      o.spentBy = transactionId
      o.spendingDescription = i.inputDescription
    }
  })
  return doubleSpendTxid
}

/** Build an SDK input record for a new-input row that has a backing output. */
async function buildSdkInputFromOutput(
  storage: StorageProvider,
  vargs: Validation.ValidCreateActionArgs,
  vin: number,
  i: XValidCreateActionInput | undefined,
  o: TableOutput,
  unlockLen: number | undefined
): Promise<StorageCreateTransactionSdkInput> {
  if (i == null && !unlockLen) throw new WERR_INTERNAL(`vin ${vin} non-fixedInput without unlockLen`)
  const sourceTransaction =
    vargs.includeAllSourceTransactions && vargs.isSignAction
      ? await storage.getRawTxOfKnownValidTransaction(o.txid)
      : undefined
  return {
    vin,
    sourceTxid: o.txid!,
    sourceVout: o.vout,
    sourceSatoshis: o.satoshis,
    sourceLockingScript: asString(o.lockingScript!),
    sourceTransaction,
    unlockingScriptLength: unlockLen || i!.unlockingScriptLength,
    providedBy: i != null && o.providedBy === 'storage' ? 'you-and-storage' : o.providedBy,
    type: o.type,
    spendingDescription: o.spendingDescription || undefined,
    derivationPrefix: o.derivationPrefix || undefined,
    derivationSuffix: o.derivationSuffix || undefined,
    senderIdentityKey: o.senderIdentityKey || undefined
  }
}

/** Build an SDK input record for a user-specified input with no corresponding stored output. */
function buildSdkInputFromXInput(vin: number, i: XValidCreateActionInput): StorageCreateTransactionSdkInput {
  return {
    vin,
    sourceTxid: i.outpoint.txid,
    sourceVout: i.outpoint.vout,
    sourceSatoshis: i.satoshis,
    sourceLockingScript: i.lockingScript.toHex(),
    unlockingScriptLength: i.unlockingScriptLength,
    providedBy: 'you',
    type: 'custom',
    spendingDescription: undefined,
    derivationPrefix: undefined,
    derivationSuffix: undefined,
    senderIdentityKey: undefined
  }
}

async function createNewInputs(
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  ctx: CreateTransactionSdkContext,
  allocatedChange: TableOutput[]
): Promise<StorageCreateTransactionSdkInput[]> {
  const r: StorageCreateTransactionSdkInput[] = []

  const newInputs: Array<{ i?: XValidCreateActionInput; o?: TableOutput; unlockLen?: number }> = []
  for (const i of ctx.xinputs) newInputs.push({ i, o: i.output })

  const knownInputRows = newInputs.filter(
    (ni): ni is { i: XValidCreateActionInput; o: TableOutput } => ni.i != null && ni.o != null
  )
  if (knownInputRows.length > 0) {
    const doubleSpendTxid = await markKnownInputsSpent(storage, knownInputRows, ctx.transactionId)
    if (doubleSpendTxid) {
      const beef = await getCompetingBeefForReview(storage, doubleSpendTxid)
      throw new WERR_REVIEW_ACTIONS(
        [{ txid: '', status: 'doubleSpend', competingTxs: [doubleSpendTxid], competingBeef: beef.toBinary() }],
        []
      )
    }
  }

  for (const o of allocatedChange) newInputs.push({ o, unlockLen: 107 })

  let vin = -1
  for (const { i, o, unlockLen } of newInputs) {
    vin++
    if (o != null) {
      r.push(await buildSdkInputFromOutput(storage, vargs, vin, i, o, unlockLen))
    } else {
      if (i == null) throw new WERR_INTERNAL(`vin ${vin} without output or xinput`)
      r.push(buildSdkInputFromXInput(vin, i))
    }
  }
  return r
}

async function getCompetingBeefForReview(storage: StorageProvider, txid: string): Promise<Beef> {
  try {
    return await storage.getBeefForTransaction(txid, {})
  } catch (e) {
    const walletError = WalletError.fromUnknown(e)
    if (walletError instanceof WERR_INVALID_PARAMETER || walletError.code === 'WERR_INVALID_PARAMETER') {
      const beef = new Beef()
      beef.mergeTxidOnly(txid)
      return beef
    }
    throw e
  }
}

/** Build the SDK descriptor for a persisted output. */
function describeNewOutput(
  o: TableOutput,
  tags: string[],
  txBaskets: Record<string, TableOutputBasket>
): { changeVout: number | undefined; ro: StorageCreateTransactionSdkOutput } {
  const changeVout = o.change && o.purpose === 'change' && o.providedBy === 'storage' ? o.vout : undefined
  const ro: StorageCreateTransactionSdkOutput = {
    vout: verifyInteger(o.vout),
    satoshis: Validation.validateSatoshis(o.satoshis, 'o.satoshis'),
    lockingScript: o.lockingScript == null ? '' : asString(o.lockingScript),
    providedBy: verifyTruthy(o.providedBy),
    purpose: o.purpose || undefined,
    basket: Object.values(txBaskets).find(b => b.basketId === o.basketId)?.name,
    tags,
    outputDescription: o.outputDescription,
    derivationSuffix: o.derivationSuffix,
    customInstructions: o.customInstructions
  }
  return { changeVout, ro }
}

/** Insert the output and attach its tags; return the SDK output descriptor. */
async function persistNewOutput(
  storage: StorageProvider,
  o: TableOutput,
  tags: string[],
  txTags: Record<string, TableOutputTag>,
  txBaskets: Record<string, TableOutputBasket>,
  trx?: TrxToken
): Promise<{ changeVout: number | undefined; ro: StorageCreateTransactionSdkOutput }> {
  o.outputId = await storage.insertOutput(o, trx)
  for (const tagName of new Set(tags)) {
    const tag = txTags[tagName]
    await storage.insertOutputTagMap({
      outputId: verifyId(o.outputId),
      outputTagId: verifyId(tag.outputTagId),
      created_at: new Date(),
      updated_at: new Date(),
      isDeleted: false
    }, trx)
  }
  return describeNewOutput(o, tags, txBaskets)
}

async function createNewOutputs(
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  ctx: CreateTransactionSdkContext,
  changeOutputs: TableOutput[],
  trx?: TrxToken
): Promise<{
  outputs: StorageCreateTransactionSdkOutput[]
  changeVouts: number[]
}> {
  const txBaskets: Record<string, TableOutputBasket> = {}
  const basketNames = [...new Set(ctx.xoutputs.map(x => x.basket).filter((v): v is string => !!v))]
  Object.assign(txBaskets, await storage.findOrInsertOutputBasketsBulk(userId, basketNames, trx))

  const txTags: Record<string, TableOutputTag> = {}
  const tagNames = [...new Set(ctx.xoutputs.flatMap(x => x.tags))]
  Object.assign(txTags, await storage.findOrInsertOutputTagsBulk(userId, tagNames, trx))

  const newOutputs: Array<{ o: TableOutput; tags: string[] }> = []

  for (const xo of ctx.xoutputs) {
    const lockingScript = asArray(xo.lockingScript)
    if (xo.purpose === 'service-charge') {
      const now = new Date()
      await storage.insertCommission({
        userId,
        transactionId: ctx.transactionId,
        lockingScript,
        satoshis: xo.satoshis,
        isRedeemed: false,
        keyOffset: verifyTruthy(xo.keyOffset),
        created_at: now,
        updated_at: now,
        commissionId: 0
      }, trx)
      const o = makeDefaultOutput(userId, ctx.transactionId, xo.satoshis, xo.vout)
      o.lockingScript = lockingScript
      o.providedBy = 'storage'
      o.purpose = 'storage-commission'
      o.type = 'custom'
      o.spendable = false
      newOutputs.push({ o, tags: [] })
    } else {
      const o = makeDefaultOutput(userId, ctx.transactionId, xo.satoshis, xo.vout)
      o.lockingScript = lockingScript
      o.basketId = xo.basket ? txBaskets[xo.basket].basketId : undefined
      o.customInstructions = xo.customInstructions
      o.outputDescription = xo.outputDescription
      o.providedBy = xo.providedBy
      o.purpose = xo.purpose || ''
      o.type = 'custom'
      newOutputs.push({ o, tags: xo.tags })
    }
  }

  for (const o of changeOutputs) {
    o.spendable = true
    newOutputs.push({ o, tags: [] })
  }

  if (vargs.options.randomizeOutputs)
    randomizePlannedOutputVouts(
      newOutputs.map(output => output.o),
      vargs.randomVals
    )

  // The overwhelmingly common path has no output tags. Those rows do not
  // need generated outputIds, so Knex can persist fixed and change outputs in
  // one multi-row statement. Tagged rows retain the established id-dependent
  // insertion path below.
  const untagged = newOutputs.filter(output => output.tags.length === 0)
  await storage.insertOutputs(untagged.map(output => output.o), trx)

  const outputs: StorageCreateTransactionSdkOutput[] = []
  const changeVouts: number[] = []
  for (const { o, tags } of newOutputs) {
    const { changeVout, ro } = tags.length === 0
      ? describeNewOutput(o, tags, txBaskets)
      : await persistNewOutput(storage, o, tags, txTags, txBaskets, trx)
    if (changeVout !== undefined) changeVouts.push(changeVout)
    outputs.push(ro)
  }

  return { outputs, changeVouts }
}

async function createNewTxRecord(
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  storageBeef: number[],
  satoshis = 0,
  trx?: TrxToken,
  status: TableTransaction['status'] = 'unsigned'
): Promise<TableTransaction> {
  const now = new Date()
  const newTx: TableTransaction = {
    created_at: now,
    updated_at: now,
    transactionId: 0,
    version: vargs.version,
    lockTime: vargs.lockTime,
    status,
    reference: randomBytesBase64(12),
    satoshis,
    userId,
    isOutgoing: true,
    inputBEEF: storageBeef,
    description: vargs.description,
    txid: undefined,
    rawTx: undefined
  }
  newTx.transactionId = await storage.insertTransaction(newTx, trx)

  const labelNames = [...new Set(vargs.labels)]
  const labels = await storage.findOrInsertTxLabelsBulk(userId, labelNames, trx)
  for (const label of labelNames) {
    const txLabel = labels[label]
    await storage.findOrInsertTxLabelMap(verifyId(newTx.transactionId), verifyId(txLabel.txLabelId), trx)
  }

  return newTx
}

/**
 * Convert vargs.outputs:
 *
 * lockingScript: HexString
 * satoshis: SatoshiValue
 * outputDescription: DescriptionString5to50Bytes
 * basket?: BasketStringUnder300Bytes
 * customInstructions?: string
 * tags: BasketStringUnderBytes[]
 *
 * to XValidCreateActionOutput (which aims for StorageCreateTransactionSdkOutput)
 *
 * adds:
 *   vout: number
 *   providedBy: StorageProvidedBy
 *   purpose?: string
 *   derivationSuffix?: string
 *   keyOffset?: string
 *
 * @param vargs
 * @returns xoutputs
 */
function validateRequiredOutputs(
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs
): XValidCreateActionOutput[] {
  const xoutputs: XValidCreateActionOutput[] = []
  let vout = -1
  for (const output of vargs.outputs) {
    vout++
    const xo: XValidCreateActionOutput = {
      ...output,
      vout,
      providedBy: 'you',
      purpose: undefined,
      derivationSuffix: undefined,
      keyOffset: undefined
    }
    xoutputs.push(xo)
  }

  if (storage.commissionSatoshis > 0 && storage.commissionPubKeyHex) {
    vout++
    const { script, keyOffset } = createStorageServiceChargeScript(storage.commissionPubKeyHex)
    xoutputs.push({
      lockingScript: script,
      satoshis: storage.commissionSatoshis,
      outputDescription: 'Storage Service Charge',
      basket: undefined,
      tags: [],

      vout,
      providedBy: 'storage',
      purpose: 'service-charge',
      keyOffset
    })
  }

  return xoutputs
}

/**
 * Verify that we are in posession of validity proof data for any inputs being proposed for a new transaction.
 *
 * `vargs.inputs` is the source of inputs.
 * `vargs.inputBEEF` may include new user supplied validity data.
 * 'vargs.options.trustSelf === 'known'` indicates whether we can rely on the storage database records.
 *
 * If there are no inputs, returns an empty `Beef`.
 *
 * Always pulls rawTx data into first level of validity chains so that parsed transaction data is available
 * and checks input sourceSatoshis as well as filling in input sourceLockingScript.
 *
 * This data may be pruned again before being returned to the user based on `vargs.options.knownTxids`.
 *
 * @param storage
 * @param userId
 * @param vargs
 * @returns {storageBeef} containing only validity proof data for only unknown required inputs.
 * @returns {beef} containing verified validity proof data for all required inputs.
 * @returns {xinputs} extended validated required inputs.
 */
async function validateRequiredInputs(
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs
): Promise<{
  storageBeef: Beef
  beef: Beef
  xinputs: XValidCreateActionInput[]
}> {
  // stampLog(vargs, `start storage verifyInputBeef`)

  const beef = new Beef()

  if (vargs.inputs.length === 0) return { storageBeef: beef, beef, xinputs: [] }

  if (vargs.inputBEEF != null) beef.mergeBeef(vargs.inputBEEF)

  const xinputs: XValidCreateActionInput[] = vargs.inputs.map((input, vin) => ({
    ...input,
    vin,
    satoshis: -1,
    lockingScript: new Script(),
    output: undefined
  }))

  const trustSelf = vargs.options.trustSelf === 'known'

  const preloadedOutputsByOutpoint = await storage.findOutputsByOutpoints(
    userId,
    xinputs.map(i => ({ txid: i.outpoint.txid, vout: i.outpoint.vout }))
  )
  const preloadedOutputIds = Object.values(preloadedOutputsByOutpoint).map(output => output.outputId)
  if ((await storage.findReservedActionBatchOutputIds(preloadedOutputIds)).length > 0) {
    throw new WERR_INVALID_PARAMETER('inputs', 'outputs not reserved by an active action batch')
  }

  const inputsByTxid: Record<string, XValidCreateActionInput[]> = {}
  for (const input of xinputs) {
    inputsByTxid[input.outpoint.txid] ||= []
    inputsByTxid[input.outpoint.txid].push(input)
  }

  const localKnownInputTxids: Record<string, boolean> = {}
  for (const [txid, txInputs] of Object.entries(inputsByTxid)) {
    localKnownInputTxids[txid] = txInputs.every(input => {
      const output = preloadedOutputsByOutpoint[`${input.outpoint.txid}.${input.outpoint.vout}`]
      return output?.lockingScript !== undefined && Number.isInteger(output?.satoshis)
    })
  }

  await validateBeefTxidOnlyEntries(beef, inputsByTxid, trustSelf, storage)
  await ensureBeefContainsAllInputTxids(beef, inputsByTxid, localKnownInputTxids, trustSelf, storage)

  if (!(await beef.verify(await storage.getServices().getChainTracker(), true))) {
    console.log(`verifyInputBeef failed, inputBEEF failed to verify.\n${beef.toLogString()}\n`)
    throw new WERR_INVALID_PARAMETER('inputBEEF', 'valid Beef when factoring options.trustSelf')
  }

  const storageBeef = beef.clone()

  for (const input of xinputs) {
    await resolveInputScript(storage, userId, vargs, input, beef, preloadedOutputsByOutpoint)
  }

  return { beef, storageBeef, xinputs }
}

/** Check all txidOnly entries in beef: require either trustSelf vouch or throw. */
async function validateBeefTxidOnlyEntries(
  beef: Beef,
  inputsByTxid: Record<string, XValidCreateActionInput[]>,
  trustSelf: boolean,
  storage: StorageProvider
): Promise<void> {
  for (const btx of beef.txs) {
    if (!btx.isTxidOnly) continue
    if (!trustSelf)
      throw new WERR_INVALID_PARAMETER('inputBEEF', `valid and contain complete proof data for ${btx.txid}`)
    if (inputsByTxid[btx.txid] == null) {
      const isKnown = await storage.verifyKnownValidTransaction(btx.txid)
      if (!isKnown)
        throw new WERR_INVALID_PARAMETER('inputBEEF', `valid and contain complete proof data for unknown ${btx.txid}`)
    }
  }
}

/** Ensure beef has an entry (or txidOnly) for every input txid. */
async function ensureBeefContainsAllInputTxids(
  beef: Beef,
  inputsByTxid: Record<string, XValidCreateActionInput[]>,
  localKnownInputTxids: Record<string, boolean>,
  trustSelf: boolean,
  storage: StorageProvider
): Promise<void> {
  for (const txid of Object.keys(inputsByTxid)) {
    let btx = beef.findTxid(txid)
    if (btx == null && localKnownInputTxids[txid]) continue
    if (btx == null && trustSelf) {
      if (await storage.verifyKnownValidTransaction(txid)) btx = beef.mergeTxidOnly(txid)
    }
    if (btx == null) {
      throw new WERR_INVALID_PARAMETER(
        'inputBEEF',
        `valid and contain proof data for possibly known ${txid}, beef ${beef.toLogString()}`
      )
    }
  }
}

/** Resolve satoshis and lockingScript for one xinput from either storage or the beef. */
function applyStoredInputScript(
  output: TableOutput,
  input: XValidCreateActionInput,
  vargs: Validation.ValidCreateActionArgs
): void {
  const { txid, vout } = input.outpoint
  if (output.change) {
    throw new WERR_INVALID_PARAMETER(
      `inputs[${input.vin}]`,
      'an unmanaged input. Change outputs are managed by your wallet.'
    )
  }
  input.output = output
  if (output.lockingScript === undefined || !Number.isInteger(output.satoshis)) {
    throw new WERR_INVALID_PARAMETER(`${txid}.${vout}`, 'output with valid lockingScript and satoshis')
  }
  if (!disableDoubleSpendCheckForTest && !output.spendable && !vargs.isNoSend) {
    throw new WERR_INVALID_PARAMETER(`${txid}.${vout}`, 'spendable output unless noSend is true')
  }
  input.satoshis = Validation.validateSatoshis(output.satoshis, 'output.satoshis')
  input.lockingScript = Script.fromBinary(asArray(output.lockingScript))
}

async function applyBeefInputScript(
  storage: StorageProvider,
  beef: Beef,
  input: XValidCreateActionInput
): Promise<void> {
  const { txid, vout } = input.outpoint
  let beefTx = beef.findTxid(txid)!
  if (beefTx.isTxidOnly) {
    const { rawTx, proven } = await storage.getProvenOrRawTx(txid)
    if (rawTx == null) {
      throw new WERR_INVALID_PARAMETER('inputBEEF', `valid and contain proof data for ${txid}`)
    }
    beefTx = beef.mergeRawTx(asArray(rawTx))
    if (proven != null) beef.mergeBump(new EntityProvenTx(proven).getMerklePath())
  }
  if (vout >= beefTx.tx!.outputs.length) {
    throw new WERR_INVALID_PARAMETER(`${txid}.${vout}`, 'valid outpoint')
  }
  const sourceOutput = beefTx.tx!.outputs[vout]
  input.satoshis = Validation.validateSatoshis(sourceOutput.satoshis, 'so.satoshis')
  input.lockingScript = sourceOutput.lockingScript
}

async function resolveInputScript(
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  input: XValidCreateActionInput,
  beef: Beef,
  preloadedOutputsByOutpoint: Record<string, TableOutput>
): Promise<void> {
  const { txid, vout } = input.outpoint
  let output: TableOutput | undefined = preloadedOutputsByOutpoint[`${txid}.${vout}`]
  output ??= verifyOneOrNone(await storage.findOutputs({ partial: { userId, txid, vout } }))
  if (output != null) {
    applyStoredInputScript(output, input, vargs)
  } else {
    await applyBeefInputScript(storage, beef, input)
  }
}

async function validateNoSendChange(
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  changeBasket: TableOutputBasket
): Promise<TableOutput[]> {
  const r: TableOutput[] = []

  if (!vargs.isNoSend) return []

  const noSendChange = vargs.options.noSendChange

  if (noSendChange && noSendChange.length > 0) {
    const byOutpoint = await storage.findOutputsByOutpoints(userId, noSendChange)
    for (const op of noSendChange) {
      const output = byOutpoint[`${op.txid}.${op.vout}`]
      // noSendChange is signed through the same BRC-29 path as allocated change.
      // It must satisfy the full managed-change policy, not merely share the
      // default basket or have a P2PKH-shaped locking script.
      if (
        !isAutoSpendableChangeOutput(output) ||
        !verifyNumber(output.satoshis) ||
        output.basketId !== changeBasket.basketId
      ) {
        throw new WERR_INVALID_PARAMETER('noSendChange outpoint', 'wallet-managed BRC-29 change')
      }
      if (r.some(o => o.outputId === output.outputId))
      // noSendChange duplicate OutPoints are not allowed.
      {
        throw new WERR_INVALID_PARAMETER('noSendChange outpoint', 'unique. Duplicates are not allowed.')
      }
      r.push(output)
    }
  }

  if ((await storage.findReservedActionBatchOutputIds(r.map(output => output.outputId))).length > 0) {
    throw new WERR_INVALID_PARAMETER('noSendChange', 'outputs not reserved by an active action batch')
  }

  return r
}

interface PreparedFundingPlan {
  params: GenerateChangeSdkParams
  result: GenerateChangeSdkResult
  selected: ManagedChangeInputCandidate[]
  availableChangeCount: number
}

type FundingClaimRequest = readonly [
  userId: number,
  basketId: number,
  excludeSending: boolean,
  transactionId: number,
  noSendChangeIn: TableOutput[],
  plan: PreparedFundingPlan,
  trx?: TrxToken
]

function fundingPlanSatoshis (plan: PreparedFundingPlan): number {
  return plan.result.changeOutputs.reduce((sum, output) => sum + output.satoshis, 0) -
    plan.selected.reduce((sum, output) => sum + output.satoshis, 0)
}

type FundingPlanContext = readonly [
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  xinputs: XValidCreateActionInput[],
  xoutputs: XValidCreateActionOutput[],
  changeBasket: TableOutputBasket,
  noSendChangeIn: TableOutput[],
  feeModel: StorageFeeModel,
  parent?: TelemetrySpan,
  trx?: TrxToken
]

type FundingClaim =
  | {
    outputs: TableOutput[]
    sourceTransactionCount: number
    hydratedScriptCount: number
    scriptSourceTransactionCount: number
    conflict?: undefined
  }
  | { outputs?: undefined, conflict: 'candidate' | 'noSendChange' }

type LockedFundingClaim =
  | { outputs: TableOutput[], sourceTransactionCount: number, conflict?: undefined }
  | { outputs?: undefined, sourceTransactionCount?: undefined, conflict: 'candidate' | 'noSendChange' }

class FundingClaimConflict extends Error {
  constructor (readonly conflict: 'candidate' | 'noSendChange') {
    super('createAction funding claim changed concurrently')
  }
}

async function traceStorageStep<T> (
  storage: StorageProvider,
  name: string,
  parent: TelemetrySpan | undefined,
  attributes: Readonly<Record<string, unknown>>,
  callback: (span?: TelemetrySpan) => Promise<T>
): Promise<T> {
  if (!storage.telemetry.enabled) return await callback()
  return await storage.telemetry.withSpan(
    name,
    { component: 'wallet-storage', parent: parent?.context, attributes },
    async span => await callback(span)
  )
}

function makeFundingParams (
  vargs: Validation.ValidCreateActionArgs,
  xinputs: XValidCreateActionInput[],
  xoutputs: XValidCreateActionOutput[],
  changeBasket: TableOutputBasket,
  feeModel: StorageFeeModel,
  availableChangeCount: number
): GenerateChangeSdkParams {
  return {
    fixedInputs: xinputs.map(input => ({
      satoshis: input.satoshis,
      unlockingScriptLength: input.unlockingScriptLength
    })),
    fixedOutputs: xoutputs.map(output => ({
      satoshis: output.satoshis,
      lockingScriptLength: output.lockingScript.length / 2
    })),
    feeModel,
    changeInitialSatoshis: Math.max(1, changeBasket.minimumDesiredUTXOValue),
    changeFirstSatoshis: Math.max(1, Math.round(changeBasket.minimumDesiredUTXOValue / 4)),
    changeLockingScriptLength: 25,
    changeUnlockingScriptLength: 107,
    targetNetCount: changeBasket.numberOfDesiredUTXOs - availableChangeCount,
    randomVals: vargs.randomVals
  }
}

async function prepareFundingPlan (
  storage: StorageProvider,
  context: FundingPlanContext
): Promise<PreparedFundingPlan> {
  const [userId, vargs, xinputs, xoutputs, changeBasket, noSendChangeIn, feeModel, parent, trx] = context
  const excludeSending = !vargs.isDelayed
  const candidates = await traceStorageStep(
    storage,
    'wallet.storage.create_action.funding_candidates',
    parent,
    { 'funding.exclude_sending': excludeSending },
    async span => {
      const outputs = await storage.findAvailableManagedChangeInputCandidates(
        userId,
        changeBasket.basketId,
        excludeSending,
        trx
      )
      span?.end({
        attributes: {
          'funding.candidate_count': outputs.length,
          'funding.candidate_satoshis': outputs.reduce((sum, output) => sum + output.satoshis, 0)
        }
      })
      return outputs
    }
  )
  const noSendIds = new Set(noSendChangeIn.map(output => output.outputId))
  const available = candidates.filter(output => !noSendIds.has(output.outputId))
  // Preserve the legacy target-net-count input: noSendChange was included in
  // countChangeInputs before it was consumed by the allocator.
  const params = makeFundingParams(vargs, xinputs, xoutputs, changeBasket, feeModel, candidates.length)

  return await traceStorageStep(
    storage,
    'wallet.storage.create_action.funding_plan',
    parent,
    {
      'funding.candidate_count': available.length,
      'funding.no_send_change_count': noSendChangeIn.length
    },
    async span => {
      const allocated = new Map<number, ManagedChangeInputCandidate>()
      const availableSelector = new CanonicalChangeSelector(available)
      const noSend = [...noSendChangeIn]
      const noSendById = new Map(noSendChangeIn.map(output => [output.outputId, output]))
      const allocate = async (
        targetSatoshis: number,
        exactSatoshis?: number
      ): Promise<GenerateChangeSdkChangeInput | undefined> => {
        let output: ManagedChangeInputCandidate | undefined = noSend.pop()
        output ??= availableSelector.take(targetSatoshis, exactSatoshis)
        if (output == null) return undefined
        allocated.set(output.outputId, output)
        return { outputId: output.outputId, satoshis: output.satoshis }
      }
      const release = async (outputId: number): Promise<void> => {
        const output = allocated.get(outputId)
        if (output == null) return
        allocated.delete(outputId)
        availableSelector.release(outputId)
        const noSendOutput = noSendById.get(outputId)
        if (noSendOutput != null) noSend.push(noSendOutput)
      }
      const result = await generateChangeSdk(params, allocate, release, vargs.logger, storage.telemetry)
      const selected = result.allocatedChangeInputs.map(input => verifyTruthy(allocated.get(input.outputId)))
      span?.end({
        attributes: {
          'funding.allocated_input_count': selected.length,
          'funding.change_output_count': result.changeOutputs.length,
          'funding.fee_satoshis': result.fee,
          'funding.transaction_size_bytes': result.size
        }
      })
      return {
        params,
        result,
        selected,
        availableChangeCount: candidates.length
      }
    }
  )
}

async function claimFundingPlan (
  storage: StorageProvider,
  request: FundingClaimRequest
): Promise<FundingClaim> {
  const [userId, basketId, excludeSending, transactionId, noSendChangeIn, plan, trx] = request
  if (plan.selected.length === 0) {
    return { outputs: [], sourceTransactionCount: 0, hydratedScriptCount: 0, scriptSourceTransactionCount: 0 }
  }
  const noSendIds = new Set(noSendChangeIn.map(output => output.outputId))
  const statuses: TransactionStatus[] = ['completed', 'unproven']
  if (!excludeSending) statuses.push('sending')

  const claim: LockedFundingClaim = await storage.transaction<LockedFundingClaim>(async claimTrx => {
    const currentById = await storage.findFundingOutputsForUpdate(
      userId,
      plan.selected.map(output => output.outputId),
      statuses,
      claimTrx
    )
    const transactionIds = [...new Set(Object.values(currentById).map(output => output.transactionId))]
    const claimed: TableOutput[] = []
    for (const planned of plan.selected) {
      const current = currentById[planned.outputId]
      if (
        current?.outputId !== planned.outputId ||
        current?.satoshis !== planned.satoshis ||
        current?.basketId !== basketId ||
        !isAutoSpendableChangeOutput(current) ||
        current?.txid !== planned.txid ||
        current?.vout !== planned.vout
      ) {
        return { conflict: noSendIds.has(planned.outputId) ? 'noSendChange' : 'candidate' } as const
      }
      claimed.push(current)
    }
    const updated = await storage.markChangeInputsSpent(claimed.map(output => output.outputId), transactionId, claimTrx)
    if (updated !== claimed.length) {
      throw new FundingClaimConflict(
        claimed.some(output => noSendIds.has(output.outputId)) ? 'noSendChange' : 'candidate'
      )
    }
    for (const output of claimed) {
      output.spendable = false
      output.spentBy = transactionId
    }
    return { outputs: claimed, sourceTransactionCount: transactionIds.length }
  }, trx).catch(error => {
    if (error instanceof FundingClaimConflict) return { conflict: error.conflict } as const
    throw error
  })
  if (claim.outputs == null) return claim
  const hydration = await hydrateFundingInputScripts(storage, claim.outputs, trx)
  return {
    outputs: claim.outputs,
    sourceTransactionCount: claim.sourceTransactionCount,
    ...hydration
  }
}

async function hydrateFundingInputScripts (
  storage: StorageProvider,
  outputs: TableOutput[],
  trx?: TrxToken
): Promise<{ hydratedScriptCount: number, scriptSourceTransactionCount: number }> {
  const missing = outputs.filter(output =>
    output.lockingScript?.length !== output.scriptLength &&
    output.scriptLength != null && output.scriptLength > 0 &&
    output.scriptOffset != null && output.scriptOffset > 0 &&
    output.txid != null && output.txid !== ''
  )
  if (missing.length === 0) return { hydratedScriptCount: 0, scriptSourceTransactionCount: 0 }

  const byTxid = new Map<string, TableOutput[]>()
  for (const output of missing) {
    const txid = verifyTruthy(output.txid)
    const group = byTxid.get(txid) ?? []
    group.push(output)
    byTxid.set(txid, group)
  }
  const groups = [...byTxid.entries()]
  let cursor = 0
  await Promise.all(
    Array.from({ length: Math.min(8, groups.length) }, async () => {
      while (cursor < groups.length) {
        const [txid, group] = groups[cursor++]
        if (group.length === 1) {
          await storage.validateOutputScript(group[0], trx)
          continue
        }
        const rawTx = await storage.getRawTxOfKnownValidTransaction(txid, undefined, undefined, trx)
        if (rawTx != null) {
          for (const output of group) {
            output.lockingScript = rawTx.slice(output.scriptOffset!, output.scriptOffset! + output.scriptLength!)
          }
        } else {
          for (const output of group) await storage.validateOutputScript(output, trx)
        }
      }
    })
  )
  return {
    hydratedScriptCount: missing.filter(output => output.lockingScript?.length === output.scriptLength).length,
    scriptSourceTransactionCount: groups.length
  }
}

async function fundNewTransactionSdk(
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  ctx: CreateTransactionSdkContext,
  initialPlan: PreparedFundingPlan,
  parent?: TelemetrySpan,
  trx?: TrxToken
): Promise<{
  allocatedChange: TableOutput[]
  changeOutputs: TableOutput[]
  derivationPrefix: string
  maxPossibleSatoshisAdjustment?: {
    fixedOutputIndex: number
    satoshis: number
  }
}> {
  let plan = initialPlan
  let allocatedChange: TableOutput[] | undefined
  let retryCount = 0
  await traceStorageStep(
    storage,
    'wallet.storage.create_action.funding_claim',
    parent,
    { 'funding.planned_input_count': initialPlan.selected.length },
    async span => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const claim = await claimFundingPlan(storage, [
          userId,
          ctx.changeBasket.basketId,
          !vargs.isDelayed,
          ctx.transactionId,
          ctx.noSendChangeIn,
          plan,
          trx
        ])
        if (claim.outputs != null) {
          allocatedChange = claim.outputs
          span?.end({
            attributes: {
              'funding.claim_retry_count': retryCount,
              'funding.source_transaction_count': claim.sourceTransactionCount,
              'funding.hydrated_script_count': claim.hydratedScriptCount,
              'funding.script_source_transaction_count': claim.scriptSourceTransactionCount
            }
          })
          return
        }
        if (claim.conflict === 'noSendChange') {
          throw new WERR_INVALID_PARAMETER('noSendChange', 'outputs that remain spendable during action planning')
        }
        retryCount++
        plan = await prepareFundingPlan(
          storage,
          [
            userId,
            vargs,
            ctx.xinputs,
            ctx.xoutputs,
            ctx.changeBasket,
            ctx.noSendChangeIn,
            ctx.feeModel,
            parent,
            trx
          ]
        )
      }
      throw new WERR_INVALID_OPERATION('wallet funding changed repeatedly during action planning; retry createAction')
    }
  )
  if (allocatedChange == null) throw new WERR_INTERNAL('funding plan was not claimed')
  const params = plan.params
  const gcr = plan.result

  const nextRandomVal = (): number => {
    let val = 0
    if (vargs.randomVals == null || vargs.randomVals.length === 0) {
      const bytes = Random(4)
      val = (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) / 0x100000000
    } else {
      val = vargs.randomVals.shift() || 0
      vargs.randomVals.push(val)
    }
    return val
  }

  /**
   * @returns a random integer betweenn min and max, inclussive.
   */
  const rand = (min: number, max: number): number => {
    if (max < min) throw new WERR_INVALID_PARAMETER('max', `less than min (${min}). max is (${max})`)
    return Math.floor(nextRandomVal() * (max - min + 1) + min)
  }

  const randomDerivation = (count: number): string => {
    let val: number[] = []
    if (vargs.randomVals == null || vargs.randomVals.length === 0) {
      val = Random(count)
    } else {
      for (let i = 0; i < count; i++) val.push(rand(0, 255))
    }
    return Utils.toBase64(val)
  }

  // Generate a derivation prefix for the payment
  const derivationPrefix = randomDerivation(16)

  const r: {
    allocatedChange: TableOutput[]
    changeOutputs: TableOutput[]
    derivationPrefix: string
    maxPossibleSatoshisAdjustment?: {
      fixedOutputIndex: number
      satoshis: number
    }
  } = {
    maxPossibleSatoshisAdjustment: gcr.maxPossibleSatoshisAdjustment,
    allocatedChange,
    changeOutputs: gcr.changeOutputs.map((o, i) => ({
      // what we knnow now and can insert into the database for this new transaction's change output
      created_at: new Date(),
      updated_at: new Date(),
      outputId: 0,
      userId,
      transactionId: ctx.transactionId,
      vout: params.fixedOutputs.length + i,
      satoshis: o.satoshis,
      basketId: ctx.changeBasket.basketId,
      spendable: false,
      change: true,
      type: 'P2PKH',
      derivationPrefix,
      derivationSuffix: randomDerivation(16),
      providedBy: 'storage',
      purpose: 'change',
      customInstructions: undefined,
      senderIdentityKey: undefined,
      outputDescription: '',

      // what will be known when transaction is signed
      txid: undefined,
      lockingScript: undefined,

      // when this output gets spent
      spentBy: undefined,
      spendingDescription: undefined
    })),
    derivationPrefix
  }

  return r
}

/**
 * Avoid returning any known raw transaction data by converting any known transaction
 * in the `beef` to txidOnly.
 * @returns undefined if `vargs.options.returnTXIDOnly` or trimmed `Beef`
 */
function trimInputBeef(beef: Beef, vargs: Validation.ValidCreateActionArgs): Uint8Array | undefined {
  if (vargs.options.returnTXIDOnly) return undefined
  const knownTxids = vargs.options.knownTxids ?? []
  const hasKnownTxid = makeKnownTxidLookup(knownTxids)
  // The returned BEEF normally contains only a handful of transactions. A
  // direct scan avoids materializing a second full index of a potentially
  // very large wallet history on every successful action.
  for (const btx of beef.txs) if (hasKnownTxid(btx.txid)) beef.makeTxidOnly(btx.txid)
  return beef.toUint8Array()
}

function makeKnownTxidLookup (knownTxids: string[]): (txid: string) => boolean {
  let lookups = 0
  let indexed: Set<string> | undefined
  return txid => {
    lookups++
    if (indexed != null) return indexed.has(txid)
    if (knownTxids.length > 64 && lookups > 4) {
      indexed = new Set(knownTxids)
      return indexed.has(txid)
    }
    return knownTxids.includes(txid)
  }
}

interface AllocatedChangeBeefPrefetchResult {
  beef?: Beef
  error?: unknown
  sourceCount: number
  txids: string[]
}

function missingAllocatedChangeTxids (
  allocatedChange: Array<{ txid?: string }>,
  beef: Beef,
  knownTxids: string[]
): string[] {
  const hasKnownTxid = makeKnownTxidLookup(knownTxids)
  return Array.from(
    new Set(
      allocatedChange
        .map(output => verifyTruthy(output.txid))
        .filter(txid => beef.findTxid(txid) == null && !hasKnownTxid(txid))
    )
  )
}

function startAllocatedChangeBeefPrefetch (
  storage: StorageProvider,
  vargs: Validation.ValidCreateActionArgs,
  allocatedChange: ManagedChangeInputCandidate[],
  beef: Beef,
  parent?: TelemetrySpan
): Promise<AllocatedChangeBeefPrefetchResult> {
  if (vargs.options.returnTXIDOnly) return Promise.resolve({ sourceCount: 0, txids: [] })
  const knownTxids = vargs.options.knownTxids ?? []
  const missing = missingAllocatedChangeTxids(allocatedChange, beef, knownTxids)
  if (missing.length === 0) return Promise.resolve({ sourceCount: 0, txids: [] })
  const options: StorageGetBeefOptions = {
    trustSelf: undefined,
    knownTxids,
    ignoreStorage: false,
    ignoreServices: true,
    ignoreNewProven: false,
    minProofLevel: undefined
  }
  return traceStorageStep(
    storage,
    'wallet.storage.create_action.beef_prefetch',
    parent,
    {
      'beef.planned_source_count': allocatedChange.length,
      'beef.missing_source_count': missing.length,
      'beef.storage_batch_count': missing.length === 0 ? 0 : 1
    },
    async span => {
      const fetched = await storage.getBeefForTransactions(missing, options)
      span?.end({
        attributes: {
          'beef.fetched_tx_count': fetched.txs.length,
          'beef.fetched_bump_count': fetched.bumps.length
        }
      })
      return fetched
    }
  ).then(
    prefetched => ({ beef: prefetched, sourceCount: missing.length, txids: missing }),
    error => ({ error, sourceCount: missing.length, txids: missing })
  )
}

function sameTxids (left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  const expected = new Set(left)
  return right.every(txid => expected.has(txid))
}

async function mergeAllocatedChangeBeefs(
  storage: StorageProvider,
  vargs: Validation.ValidCreateActionArgs,
  allocatedChange: TableOutput[],
  beef: Beef,
  prefetch: Promise<AllocatedChangeBeefPrefetchResult>,
  parent?: TelemetrySpan
): Promise<Uint8Array | undefined> {
  const options: StorageGetBeefOptions = {
    trustSelf: undefined,
    knownTxids: vargs.options.knownTxids,
    mergeToBeef: beef,
    ignoreStorage: false,
    ignoreServices: true,
    ignoreNewProven: false,
    minProofLevel: undefined
  }
  if (vargs.options.returnTXIDOnly) return undefined
  const knownTxids = vargs.options.knownTxids ?? []
  const requiredBeforePrefetch = missingAllocatedChangeTxids(allocatedChange, beef, knownTxids)
  const prefetched = await traceStorageStep(
    storage,
    'wallet.storage.create_action.beef_prefetch_join',
    parent,
    { 'beef.prefetch_source_count': 0 },
    async span => {
      const result = await prefetch
      span?.end({ attributes: { 'beef.prefetch_source_count': result.sourceCount } })
      return result
    }
  )
  // A claim retry may replace only part of the initial funding plan. Never
  // merge proofs for outputs the final transaction does not spend: apart from
  // unnecessary bytes, that would disclose unrelated wallet history.
  const usePrefetch = sameTxids(prefetched.txids, requiredBeforePrefetch)
  if (usePrefetch && prefetched.error != null) throw prefetched.error
  if (usePrefetch && prefetched.beef != null) beef.mergeBeef(prefetched.beef)

  // If a concurrent spender forced the funding claim to be replanned, only
  // the newly selected roots remain. The normal uncontended path is empty.
  const missing = missingAllocatedChangeTxids(allocatedChange, beef, knownTxids)
  let fetched: Beef | undefined
  await traceStorageStep(
    storage,
    'wallet.storage.create_action.beef_fetch',
    parent,
    {
      'beef.allocated_change_count': allocatedChange.length,
      'beef.distinct_source_count': new Set(allocatedChange.map(output => output.txid)).size,
      'beef.known_txid_count': knownTxids.length,
      'beef.missing_source_count': missing.length,
      'beef.fetch_concurrency': 1,
      'beef.prefetch_reused': usePrefetch
    },
    async span => {
      if (missing.length > 0) {
        fetched = await storage.getBeefForTransactions(missing, { ...options, mergeToBeef: undefined })
      }
      span?.end({
        attributes: {
          'beef.fetched_tx_count': fetched?.txs.length ?? 0,
          'beef.fetched_bump_count': fetched?.bumps.length ?? 0,
          'beef.storage_batch_count': missing.length === 0 ? 0 : 1
        }
      })
    }
  )
  await traceStorageStep(
    storage,
    'wallet.storage.create_action.beef_merge',
    parent,
    { 'beef.fragment_count': (usePrefetch && prefetched.beef != null ? 1 : 0) + (fetched == null ? 0 : 1) },
    async span => {
      if (fetched != null) beef.mergeBeef(fetched)
      span?.end({
        attributes: {
          'beef.merged_tx_count': beef.txs.length,
          'beef.merged_bump_count': beef.bumps.length
        }
      })
    }
  )
  return await traceStorageStep(
    storage,
    'wallet.storage.create_action.beef_trim_serialize',
    parent,
    {
      'beef.tx_count': beef.txs.length,
      'beef.bump_count': beef.bumps.length,
      'beef.known_txid_count': knownTxids.length
    },
    async span => {
      const result = trimInputBeef(beef, vargs)
      span?.end({ attributes: { 'beef.result_bytes': result?.length ?? 0 } })
      return result
    }
  )
}
