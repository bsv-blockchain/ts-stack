import {
  Beef,
  OriginatorDomainNameStringUnder250Bytes,
  Random,
  ReviewActionResult,
  Script,
  Utils,
  Validation
} from '@bsv/sdk'
import {
  generateChangeSdk,
  GenerateChangeSdkChangeInput,
  GenerateChangeSdkParams,
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
  StorageProvidedBy
} from '../../sdk/WalletStorage.interfaces'
import {
  WERR_INSUFFICIENT_FUNDS,
  WERR_INTERNAL,
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
import { transactionSize } from './utils'

let disableDoubleSpendCheckForTest = true
export function setDisableDoubleSpendCheckForTest (v: boolean) {
  disableDoubleSpendCheckForTest = v
}

export async function createAction (
  storage: StorageProvider,
  auth: AuthId,
  vargs: Validation.ValidCreateActionArgs,
  originator?: OriginatorDomainNameStringUnder250Bytes
): Promise<StorageCreateActionResult> {
  const logger = vargs.logger
  logger?.group('storage createAction')
  // stampLog(vargs, `start storage createTransactionSdk`)

  if (vargs.isTestWerrReviewActions) throwDummyReviewActions()

  if (!vargs.isNewTx)
    // The purpose of this function is to create the initial storage records associated
    // with a new transaction. It's an error if we have no new inputs or outputs...
    {throw new WERR_INTERNAL()}

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
  const { storageBeef, beef, xinputs } = await validateRequiredInputs(storage, userId, vargs)
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

  const availableChangeCount = await storage.countChangeInputs(userId, changeBasket.basketId, !vargs.isDelayed)
  logger?.log(`counted change inputs ${availableChangeCount}`)

  const feeModel = validateStorageFeeModel(storage.feeModel)
  logger?.log(`validated fee model ${JSON.stringify(feeModel)}`)

  await preflightInsufficientFundsFastPath(vargs, xinputs, xoutputs, noSendChangeIn, availableChangeCount, feeModel)
  logger?.log('passed insufficient-funds preflight')

  const newTx = await createNewTxRecord(storage, userId, vargs, storageBeef)
  logger?.log('created new transaction record')

  const ctx: CreateTransactionSdkContext = {
    xinputs,
    xoutputs,
    changeBasket,
    noSendChangeIn,
    availableChangeCount,
    feeModel,
    transactionId: newTx.transactionId
  }

  const { allocatedChange, changeOutputs, derivationPrefix, maxPossibleSatoshisAdjustment } =
    await fundNewTransactionSdk(storage, userId, vargs, ctx)
  logger?.log('funded new transaction')

  if (maxPossibleSatoshisAdjustment != null) {
    const a = maxPossibleSatoshisAdjustment
    if (ctx.xoutputs[a.fixedOutputIndex].satoshis !== maxPossibleSatoshis) throw new WERR_INTERNAL()
    ctx.xoutputs[a.fixedOutputIndex].satoshis = a.satoshis
    logger?.log('adjusted change outputs to max possible')
  }

  // The satoshis of the transaction is the satoshis we get back in change minus the satoshis we spend.
  const satoshis =
    changeOutputs.reduce((a, e) => a + e.satoshis, 0) - allocatedChange.reduce((a, e) => a + e.satoshis, 0)
  await storage.updateTransaction(newTx.transactionId, { satoshis })

  const { outputs, changeVouts } = await createNewOutputs(storage, userId, vargs, ctx, changeOutputs)
  logger?.log('created new output records')

  const inputBeef = await mergeAllocatedChangeBeefs(storage, userId, vargs, allocatedChange, beef)
  logger?.log('merged allocated change beefs')

  const inputs = await createNewInputs(storage, userId, vargs, ctx, allocatedChange)
  logger?.log('created new inputs')

  const r: StorageCreateActionResult = {
    reference: newTx.reference,
    version: newTx.version!,
    lockTime: newTx.lockTime!,
    inputs,
    outputs,
    derivationPrefix,
    inputBeef,
    noSendChangeOutputVouts: vargs.isNoSend ? changeVouts : undefined
  }

  logger?.groupEnd()
  return r
}

interface CreateTransactionSdkContext {
  xinputs: XValidCreateActionInput[]
  xoutputs: XValidCreateActionOutput[]
  changeBasket: TableOutputBasket
  noSendChangeIn: TableOutput[]
  availableChangeCount: number
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

function makeDefaultOutput (userId: number, transactionId: number, satoshis: number, vout: number): TableOutput {
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
async function markKnownInputsSpent (
  storage: StorageProvider,
  knownInputRows: Array<{ i: XValidCreateActionInput, o: TableOutput }>,
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
        if (spendingTx?.txid) { doubleSpendTxid = spendingTx.txid; return }
      }
      if (!o2.spendable) {
        throw new WERR_INVALID_PARAMETER(
          `inputs[${i.vin}]`,
          `spendable output. output ${o.txid}:${o.vout} appears to have been spent (spendable=${o2.spendable}).`
        )
      }
      await storage.updateOutput(verifyId(o.outputId), { spendable: false, spentBy: transactionId, spendingDescription: i.inputDescription }, trx)
      o.spendable = false
      o.spentBy = transactionId
      o.spendingDescription = i.inputDescription
    }
  })
  return doubleSpendTxid
}

/** Build an SDK input record for a new-input row that has a backing output. */
async function buildSdkInputFromOutput (
  storage: StorageProvider,
  vargs: Validation.ValidCreateActionArgs,
  vin: number,
  i: XValidCreateActionInput | undefined,
  o: TableOutput,
  unlockLen: number | undefined
): Promise<StorageCreateTransactionSdkInput> {
  if ((i == null) && !unlockLen) throw new WERR_INTERNAL(`vin ${vin} non-fixedInput without unlockLen`)
  const sourceTransaction = vargs.includeAllSourceTransactions && vargs.isSignAction
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
    providedBy: (i != null) && o.providedBy === 'storage' ? 'you-and-storage' : o.providedBy,
    type: o.type,
    spendingDescription: o.spendingDescription || undefined,
    derivationPrefix: o.derivationPrefix || undefined,
    derivationSuffix: o.derivationSuffix || undefined,
    senderIdentityKey: o.senderIdentityKey || undefined
  }
}

/** Build an SDK input record for a user-specified input with no corresponding stored output. */
function buildSdkInputFromXInput (vin: number, i: XValidCreateActionInput): StorageCreateTransactionSdkInput {
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

async function createNewInputs (
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
    (ni): ni is { i: XValidCreateActionInput, o: TableOutput } => ni.i != null && ni.o != null
  )
  if (knownInputRows.length > 0) {
    const doubleSpendTxid = await markKnownInputsSpent(storage, knownInputRows, ctx.transactionId)
    if (doubleSpendTxid) {
      const beef = await storage.getBeefForTransaction(doubleSpendTxid, {})
      throw new WERR_REVIEW_ACTIONS([{ txid: '', status: 'doubleSpend', competingTxs: [doubleSpendTxid], competingBeef: beef.toBinary() }], [])
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

/** Randomly reassign vout values across newOutputs using either the provided randomVals or crypto-random bytes. */
function randomizeOutputVouts (
  newOutputs: Array<{ o: TableOutput; tags: string[] }>,
  randomVals?: number[]
): void {
  const vals = [...(randomVals || [])]
  const nextRandom = (): number => {
    if (vals.length > 0) {
      const v = vals.shift()!
      vals.push(v)
      return v
    }
    const bytes = Random(4)
    return (((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0) / 0x100000000
  }
  const newVouts = Array.from({ length: newOutputs.length }, (_, i) => i)
  for (let cur = newVouts.length; cur > 0; cur--) {
    const rnd = Math.floor(nextRandom() * cur)
    ;[newVouts[cur - 1], newVouts[rnd]] = [newVouts[rnd], newVouts[cur - 1]]
  }
  let vout = -1
  for (const no of newOutputs) {
    vout++
    if (no.o.vout !== vout) throw new WERR_INTERNAL(`new output ${vout} has out of order vout ${no.o.vout}`)
    no.o.vout = newVouts[vout]
  }
}

/** Insert the output and attach its tags; return the SDK output descriptor. */
async function persistNewOutput (
  storage: StorageProvider,
  o: TableOutput,
  tags: string[],
  txTags: Record<string, TableOutputTag>,
  txBaskets: Record<string, TableOutputBasket>
): Promise<{ changeVout: number | undefined; ro: StorageCreateTransactionSdkOutput }> {
  o.outputId = await storage.insertOutput(o)
  const changeVout = (o.change && o.purpose === 'change' && o.providedBy === 'storage') ? o.vout : undefined
  for (const tagName of new Set(tags)) {
    const tag = txTags[tagName]
    await storage.insertOutputTagMap({
      outputId: verifyId(o.outputId),
      outputTagId: verifyId(tag.outputTagId),
      created_at: new Date(),
      updated_at: new Date(),
      isDeleted: false
    })
  }
  const ro: StorageCreateTransactionSdkOutput = {
    vout: verifyInteger(o.vout),
    satoshis: Validation.validateSatoshis(o.satoshis, 'o.satoshis'),
    lockingScript: (o.lockingScript == null) ? '' : asString(o.lockingScript),
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

async function createNewOutputs (
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  ctx: CreateTransactionSdkContext,
  changeOutputs: TableOutput[]
): Promise<{
    outputs: StorageCreateTransactionSdkOutput[]
    changeVouts: number[]
  }> {
  const txBaskets: Record<string, TableOutputBasket> = {}
  const basketNames = [...new Set(ctx.xoutputs.map(x => x.basket).filter((v): v is string => !!v))]
  Object.assign(txBaskets, await storage.findOrInsertOutputBasketsBulk(userId, basketNames))

  const txTags: Record<string, TableOutputTag> = {}
  const tagNames = [...new Set(ctx.xoutputs.flatMap(x => x.tags))]
  Object.assign(txTags, await storage.findOrInsertOutputTagsBulk(userId, tagNames))

  const newOutputs: Array<{ o: TableOutput; tags: string[] }> = []

  for (const xo of ctx.xoutputs) {
    const lockingScript = asArray(xo.lockingScript)
    if (xo.purpose === 'service-charge') {
      const now = new Date()
      await storage.insertCommission({ userId, transactionId: ctx.transactionId, lockingScript, satoshis: xo.satoshis, isRedeemed: false, keyOffset: verifyTruthy(xo.keyOffset), created_at: now, updated_at: now, commissionId: 0 })
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

  if (vargs.options.randomizeOutputs) randomizeOutputVouts(newOutputs, vargs.randomVals)

  const outputs: StorageCreateTransactionSdkOutput[] = []
  const changeVouts: number[] = []
  for (const { o, tags } of newOutputs) {
    const { changeVout, ro } = await persistNewOutput(storage, o, tags, txTags, txBaskets)
    if (changeVout !== undefined) changeVouts.push(changeVout)
    outputs.push(ro)
  }

  return { outputs, changeVouts }
}

async function createNewTxRecord (
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  storageBeef: Beef
): Promise<TableTransaction> {
  const now = new Date()
  const newTx: TableTransaction = {
    created_at: now,
    updated_at: now,
    transactionId: 0,
    version: vargs.version,
    lockTime: vargs.lockTime,
    status: 'unsigned',
    reference: randomBytesBase64(12),
    satoshis: 0, // updated after fundingTransaction
    userId,
    isOutgoing: true,
    inputBEEF: storageBeef.toBinary(),
    description: vargs.description,
    txid: undefined,
    rawTx: undefined
  }
  newTx.transactionId = await storage.insertTransaction(newTx)

  for (const label of vargs.labels) {
    const txLabel = await storage.findOrInsertTxLabel(userId, label)
    await storage.findOrInsertTxLabelMap(verifyId(newTx.transactionId), verifyId(txLabel.txLabelId))
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
function validateRequiredOutputs (
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
async function validateRequiredInputs (
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
async function validateBeefTxidOnlyEntries (
  beef: Beef,
  inputsByTxid: Record<string, XValidCreateActionInput[]>,
  trustSelf: boolean,
  storage: StorageProvider
): Promise<void> {
  for (const btx of beef.txs) {
    if (!btx.isTxidOnly) continue
    if (!trustSelf) throw new WERR_INVALID_PARAMETER('inputBEEF', `valid and contain complete proof data for ${btx.txid}`)
    if (inputsByTxid[btx.txid] == null) {
      const isKnown = await storage.verifyKnownValidTransaction(btx.txid)
      if (!isKnown) throw new WERR_INVALID_PARAMETER('inputBEEF', `valid and contain complete proof data for unknown ${btx.txid}`)
    }
  }
}

/** Ensure beef has an entry (or txidOnly) for every input txid. */
async function ensureBeefContainsAllInputTxids (
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
      throw new WERR_INVALID_PARAMETER('inputBEEF', `valid and contain proof data for possibly known ${txid}, beef ${beef.toLogString()}`)
    }
  }
}

/** Resolve satoshis and lockingScript for one xinput from either storage or the beef. */
async function resolveInputScript (
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
    if (output.change) throw new WERR_INVALID_PARAMETER(`inputs[${input.vin}]`, 'an unmanaged input. Change outputs are managed by your wallet.')
    input.output = output
    if (output.lockingScript === undefined || !Number.isInteger(output.satoshis)) {
      throw new WERR_INVALID_PARAMETER(`${txid}.${vout}`, 'output with valid lockingScript and satoshis')
    }
    if (!disableDoubleSpendCheckForTest && !output.spendable && !vargs.isNoSend) {
      throw new WERR_INVALID_PARAMETER(`${txid}.${vout}`, 'spendable output unless noSend is true')
    }
    input.satoshis = Validation.validateSatoshis(output.satoshis, 'output.satoshis')
    input.lockingScript = Script.fromBinary(asArray(output.lockingScript))
  } else {
    let btx = beef.findTxid(txid)!
    if (btx.isTxidOnly) {
      const { rawTx, proven } = await storage.getProvenOrRawTx(txid)
      if (rawTx == null) throw new WERR_INVALID_PARAMETER('inputBEEF', `valid and contain proof data for ${txid}`)
      btx = beef.mergeRawTx(asArray(rawTx))
      if (proven != null) beef.mergeBump(new EntityProvenTx(proven).getMerklePath())
    }
    if (vout >= btx.tx!.outputs.length) throw new WERR_INVALID_PARAMETER(`${txid}.${vout}`, 'valid outpoint')
    const so = btx.tx!.outputs[vout]
    input.satoshis = Validation.validateSatoshis(so.satoshis, 'so.satoshis')
    input.lockingScript = so.lockingScript
  }
}

async function validateNoSendChange (
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  changeBasket: TableOutputBasket
): Promise<TableOutput[]> {
  const r: TableOutput[] = []

  if (!vargs.isNoSend) return []

  const noSendChange = vargs.options.noSendChange

  if (noSendChange && noSendChange.length > 0) {
    for (const op of noSendChange) {
      const output = verifyOneOrNone(
        await storage.findOutputs({
          partial: { userId, txid: op.txid, vout: op.vout }
        })
      )
      // noSendChange is not marked spendable until sent, may not already be spent, and must have a valid greater than zero satoshis
      if (
        output?.providedBy !== 'storage' ||
        output.purpose !== 'change' ||
        !output.spendable ||
        Number.isInteger(output.spentBy) ||
        !verifyNumber(output.satoshis) ||
        output.basketId !== changeBasket.basketId
      )
        {throw new WERR_INVALID_PARAMETER('noSendChange outpoint', 'valid')}
      if (r.some(o => o.outputId === output.outputId))
        // noSendChange duplicate OutPoints are not allowed.
        {throw new WERR_INVALID_PARAMETER('noSendChange outpoint', 'unique. Duplicates are not allowed.')}
      r.push(output)
    }
  }

  return r
}

async function preflightInsufficientFundsFastPath (
  vargs: Validation.ValidCreateActionArgs,
  xinputs: XValidCreateActionInput[],
  xoutputs: XValidCreateActionOutput[],
  noSendChangeIn: TableOutput[],
  availableChangeCount: number,
  feeModel: StorageFeeModel
): Promise<void> {
  if (feeModel.model !== 'sat/kb' || !feeModel.value) return

  const fixedInputSatoshis = xinputs.reduce((a, e) => a + e.satoshis, 0)
  const noSendSatoshis = noSendChangeIn.reduce((a, e) => a + Number(e.satoshis || 0), 0)

  const spending = xoutputs.reduce((a, e) => a + e.satoshis, 0)
  const minSize = transactionSize(
    xinputs.map(i => i.unlockingScriptLength || 0),
    xoutputs.map(o => Math.floor(o.lockingScript.length / 2))
  )
  const minFee = Math.ceil((minSize / 1000) * feeModel.value)
  const minRequired = spending + minFee

  const fixedAvailable = fixedInputSatoshis + noSendSatoshis
  if (fixedAvailable >= minRequired) return

  // Keep common successful path cheap:
  // - If there are zero change candidates, failure is certain.
  // Otherwise, defer to the main funding allocator.
  const deficit = minRequired - fixedAvailable
  if (availableChangeCount <= 0) {
    throw new WERR_INSUFFICIENT_FUNDS(minRequired, deficit)
  }
}

async function fundNewTransactionSdk (
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  ctx: CreateTransactionSdkContext
): Promise<{
    allocatedChange: TableOutput[]
    changeOutputs: TableOutput[]
    derivationPrefix: string
    maxPossibleSatoshisAdjustment?: {
      fixedOutputIndex: number
      satoshis: number
    }
  }> {
  const params: GenerateChangeSdkParams = {
    fixedInputs: ctx.xinputs.map(xi => ({
      satoshis: xi.satoshis,
      unlockingScriptLength: xi.unlockingScriptLength
    })),
    fixedOutputs: ctx.xoutputs.map(xo => ({
      satoshis: xo.satoshis,
      lockingScriptLength: xo.lockingScript.length / 2
    })),
    feeModel: ctx.feeModel,
    changeInitialSatoshis: Math.max(1, ctx.changeBasket.minimumDesiredUTXOValue),
    changeFirstSatoshis: Math.max(1, Math.round(ctx.changeBasket.minimumDesiredUTXOValue / 4)),
    changeLockingScriptLength: 25,
    changeUnlockingScriptLength: 107,
    targetNetCount: ctx.changeBasket.numberOfDesiredUTXOs - ctx.availableChangeCount,
    randomVals: vargs.randomVals
  }

  const noSendChange = [...ctx.noSendChangeIn]
  const outputs: Record<number, TableOutput> = {}

  const allocateChangeInput = async (
    targetSatoshis: number,
    exactSatoshis?: number
  ): Promise<GenerateChangeSdkChangeInput | undefined> => {
    // noSendChange gets allocated first...typically only one input...just allocate in order...
    if (noSendChange.length > 0) {
      const o = noSendChange.pop()!
      outputs[o.outputId] = o
      // allocate the output in storage, noSendChange is by definition spendable false and part of noSpend transaction batch.
      await storage.updateOutput(o.outputId, {
        spendable: false,
        spentBy: ctx.transactionId
      })
      o.spendable = false
      o.spentBy = ctx.transactionId
      const r: GenerateChangeSdkChangeInput = {
        outputId: o.outputId,
        satoshis: o.satoshis
      }
      return r
    }

    const basketId = ctx.changeBasket.basketId
    const o = await storage.allocateChangeInput(
      userId,
      basketId,
      targetSatoshis,
      exactSatoshis,
      !vargs.isDelayed,
      ctx.transactionId
    )
    if (o == null) return undefined
    outputs[o.outputId] = o
    const r: GenerateChangeSdkChangeInput = {
      outputId: o.outputId,
      satoshis: o.satoshis
    }
    return r
  }

  const releaseChangeInput = async (outputId: number): Promise<void> => {
    const nsco = ctx.noSendChangeIn.find(o => o.outputId === outputId)
    if (nsco != null) {
      noSendChange.push(nsco)
      return
    }
    await storage.updateOutput(outputId, {
      spendable: true,
      spentBy: undefined
    })
  }

  const gcr = await generateChangeSdk(params, allocateChangeInput, releaseChangeInput, vargs.logger)

  const nextRandomVal = (): number => {
    let val = 0
    if ((vargs.randomVals == null) || vargs.randomVals.length === 0) {
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
    if ((vargs.randomVals == null) || vargs.randomVals.length === 0) {
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
    allocatedChange: gcr.allocatedChangeInputs.map(i => outputs[i.outputId]),
    changeOutputs: gcr.changeOutputs.map(
      (o, i) =>
        ({
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
        })
    ),
    derivationPrefix
  }

  return r
}

/**
 * Avoid returning any known raw transaction data by converting any known transaction
 * in the `beef` to txidOnly.
 * @returns undefined if `vargs.options.returnTXIDOnly` or trimmed `Beef`
 */
function trimInputBeef (beef: Beef, vargs: Validation.ValidCreateActionArgs): number[] | undefined {
  if (vargs.options.returnTXIDOnly) return undefined
  const knownTxids: Record<string, boolean> = {}
  for (const txid of vargs.options.knownTxids || []) knownTxids[txid] = true
  for (const txid of beef.txs.map(btx => btx.txid)) if (knownTxids[txid]) beef.makeTxidOnly(txid)
  return beef.toBinary()
}

async function mergeAllocatedChangeBeefs (
  storage: StorageProvider,
  userId: number,
  vargs: Validation.ValidCreateActionArgs,
  allocatedChange: TableOutput[],
  beef: Beef
): Promise<number[] | undefined> {
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
  for (const o of allocatedChange) {
    if ((beef.findTxid(o.txid!) == null) && !(vargs.options.knownTxids ?? []).some(txid => txid === o.txid)) {
      await storage.getBeefForTransaction(o.txid!, options)
    }
  }
  return trimInputBeef(beef, vargs)
}
