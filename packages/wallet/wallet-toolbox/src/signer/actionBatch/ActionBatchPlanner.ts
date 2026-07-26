import { Beef, Transaction, Utils, Validation } from '@bsv/sdk'
import { ActionBatchFundingOutput, BeginActionBatchResult } from '../../sdk/ActionBatch.interfaces'
import {
  StorageCreateActionResult,
  StorageCreateTransactionSdkInput,
  StorageCreateTransactionSdkOutput,
  StorageProvidedBy
} from '../../sdk/WalletStorage.interfaces'
import { WERR_INTERNAL, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { randomBytesBase64, verifyTruthy } from '../../utility/utilityHelpers'
import { asArray, asString } from '../../utility/utilityHelpers.noBuffer'
import { beefForTxids } from '../../utility/beefForTxids'
import { createStorageServiceChargeScript } from '../../storage/methods/offsetKey'
import {
  generateChangeSdk,
  GenerateChangeSdkChangeInput,
  maxPossibleSatoshis
} from '../../storage/methods/generateChange'
import { randomizeOutputVouts, repeatableRandom, selectCanonicalChange } from '../../storage/methods/actionPlanning'

export interface ActionBatchPlannedAction {
  dcr: StorageCreateActionResult
  consumedOutpoints: string[]
  commissionKeyOffset?: string
}

export interface PlannerOutput extends ActionBatchFundingOutput {
  basketName?: string
  tags?: string[]
}

export interface ActionBatchPlannerState {
  begin: BeginActionBatchResult
  sharedBeef: Beef
  reserved: Map<string, PlannerOutput>
  explicit: Map<string, PlannerOutput>
  staged: Map<string, PlannerOutput>
  discardedStagedTxids: Set<string>
  consumed: Set<string>
  estimatedChangeCount: number
}

function outpointOf(output: Pick<ActionBatchFundingOutput, 'txid' | 'vout'>): string {
  if (output.txid == null) throw new WERR_INTERNAL('batch planner output is missing txid')
  return `${output.txid}.${output.vout}`
}

function randomDerivation(count: number, random: () => number): string {
  const bytes: number[] = []
  for (let i = 0; i < count; i++) bytes.push(Math.floor(random() * 256))
  return Utils.toBase64(bytes)
}

function outputFromBeef(beef: Beef, outpoint: { txid: string; vout: number }): PlannerOutput | undefined {
  const transaction = beef.findTxid(outpoint.txid)?.tx
  if (transaction == null) return undefined
  const output = transaction?.outputs[outpoint.vout]
  if (output == null) return undefined
  const now = new Date()
  return {
    outputId: -1,
    userId: 0,
    transactionId: 0,
    spendable: true,
    change: false,
    outputDescription: '',
    vout: outpoint.vout,
    satoshis: Validation.validateSatoshis(output.satoshis, 'source output satoshis'),
    providedBy: 'you',
    purpose: '',
    type: 'custom',
    txid: outpoint.txid,
    lockingScript: undefined,
    sourceTransaction: undefined,
    created_at: now,
    updated_at: now
  }
}

function requireManagedChange(output: PlannerOutput | undefined, name: string): PlannerOutput {
  if (
    output == null ||
    !output.change ||
    output.type !== 'P2PKH' ||
    output.providedBy !== 'storage' ||
    output.purpose !== 'change' ||
    output.derivationPrefix == null ||
    output.derivationSuffix == null
  ) {
    throw new WERR_INVALID_PARAMETER(name, 'wallet-managed BRC-29 change')
  }
  return output
}

function resolveInputOutput(state: ActionBatchPlannerState, outpoint: { txid: string; vout: number }): PlannerOutput {
  const key = `${outpoint.txid}.${outpoint.vout}`
  return (
    state.staged.get(key) ??
    state.explicit.get(key) ??
    state.reserved.get(key) ??
    (!state.discardedStagedTxids.has(outpoint.txid) ? outputFromBeef(state.sharedBeef, outpoint) : undefined) ??
    (() => {
      throw new WERR_INVALID_PARAMETER('inputBEEF', `proof data for ${key}`)
    })()
  )
}

export function plannerOutputLockingScript(state: ActionBatchPlannerState, output: PlannerOutput): number[] {
  if (output.lockingScript != null) return asArray(output.lockingScript)
  if (output.txid == null) throw new WERR_INTERNAL('batch planner output is missing txid')
  const script = state.sharedBeef.findTxid(output.txid)?.tx?.outputs[output.vout]?.lockingScript
  if (script == null)
    throw new WERR_INTERNAL(`batch planner output ${output.txid}.${output.vout} is missing its script`)
  return script.toBinary()
}

function sdkInputFromExplicit(
  state: ActionBatchPlannerState,
  input: Validation.ValidCreateActionInput,
  vin: number,
  output: PlannerOutput,
  isSignAction: boolean
): StorageCreateTransactionSdkInput {
  let providedBy: StorageProvidedBy = output.providedBy
  if (output.providedBy === 'storage') providedBy = 'you-and-storage'
  return {
    vin,
    sourceTxid: verifyTruthy(output.txid),
    sourceVout: output.vout,
    sourceSatoshis: output.satoshis,
    sourceLockingScript: asString(plannerOutputLockingScript(state, output)),
    sourceTransaction: isSignAction ? sourceTransactionFor(state, output) : undefined,
    unlockingScriptLength: input.unlockingScriptLength,
    providedBy,
    type: output.type,
    spendingDescription: input.inputDescription,
    derivationPrefix: output.derivationPrefix,
    derivationSuffix: output.derivationSuffix,
    senderIdentityKey: output.senderIdentityKey
  }
}

function sdkInputFromFunding(
  state: ActionBatchPlannerState,
  output: PlannerOutput,
  vin: number,
  isSignAction: boolean
): StorageCreateTransactionSdkInput {
  return {
    vin,
    sourceTxid: verifyTruthy(output.txid),
    sourceVout: output.vout,
    sourceSatoshis: output.satoshis,
    sourceLockingScript: asString(plannerOutputLockingScript(state, output)),
    sourceTransaction: isSignAction ? sourceTransactionFor(state, output) : undefined,
    unlockingScriptLength: 107,
    providedBy: 'storage',
    type: 'P2PKH',
    spendingDescription: undefined,
    derivationPrefix: verifyTruthy(output.derivationPrefix),
    derivationSuffix: verifyTruthy(output.derivationSuffix),
    senderIdentityKey: output.senderIdentityKey
  }
}

function sourceTransactionFor(
  state: ActionBatchPlannerState,
  output: PlannerOutput
): number[] | Uint8Array | undefined {
  if (output.sourceTransaction != null) return output.sourceTransaction
  if (output.txid == null) return undefined
  return state.sharedBeef.findTxid(output.txid)?.tx?.toUint8Array()
}

function trimInputBeef(
  state: ActionBatchPlannerState,
  args: Validation.ValidCreateActionArgs,
  inputs: StorageCreateTransactionSdkInput[]
): Uint8Array | undefined {
  if (args.options.returnTXIDOnly) return undefined
  const beef = beefForTxids(
    state.sharedBeef,
    inputs.map(input => input.sourceTxid)
  )
  if (args.inputBEEF != null) beef.mergeBeef(args.inputBEEF)
  for (const txid of args.options.knownTxids) if (beef.findTxid(txid) != null) beef.makeTxidOnly(txid)
  return beef.toUint8Array()
}

function requestedOutputs(args: Validation.ValidCreateActionArgs): StorageCreateTransactionSdkOutput[] {
  return args.outputs.map((output, vout) => ({
    ...output,
    vout,
    providedBy: 'you'
  }))
}

interface FundingPlan {
  allocated: PlannerOutput[]
  changeSatoshis: number[]
  maxPossibleSatoshisAdjustment?: { fixedOutputIndex: number; satoshis: number }
}

async function planFunding(
  state: ActionBatchPlannerState,
  args: Validation.ValidCreateActionArgs,
  explicit: PlannerOutput[],
  noSendChange: PlannerOutput[]
): Promise<FundingPlan> {
  const available = [...state.reserved.values()].filter(output => !state.consumed.has(outpointOf(output)))
  const allocated = new Map<number, PlannerOutput>()
  const noSend = [...noSendChange]
  const changeBasket = state.begin.changeBasket
  const params = {
    fixedInputs: explicit.map((output, index) => ({
      satoshis: output.satoshis,
      unlockingScriptLength: args.inputs[index].unlockingScriptLength
    })),
    fixedOutputs: [
      ...args.outputs.map(output => ({
        satoshis: output.satoshis,
        lockingScriptLength: output.lockingScript.length / 2
      })),
      ...(state.begin.commissionSatoshis > 0
        ? [{ satoshis: state.begin.commissionSatoshis, lockingScriptLength: 25 }]
        : [])
    ],
    feeModel: state.begin.feeModel,
    changeInitialSatoshis: Math.max(1, changeBasket.minimumDesiredUTXOValue),
    changeFirstSatoshis: Math.max(1, Math.round(changeBasket.minimumDesiredUTXOValue / 4)),
    changeLockingScriptLength: 25,
    changeUnlockingScriptLength: 107,
    targetNetCount: changeBasket.numberOfDesiredUTXOs - state.estimatedChangeCount,
    randomVals: args.randomVals
  }
  const allocate = async (
    targetSatoshis: number,
    exactSatoshis?: number
  ): Promise<GenerateChangeSdkChangeInput | undefined> => {
    let output = noSend.pop()
    output ??= selectCanonicalChange(
      available.filter(candidate => !allocated.has(candidate.outputId)),
      targetSatoshis,
      exactSatoshis
    )
    if (output == null) return undefined
    allocated.set(output.outputId, output)
    return { outputId: output.outputId, satoshis: output.satoshis }
  }
  const release = async (outputId: number): Promise<void> => {
    const output = allocated.get(outputId)
    if (output == null) return
    allocated.delete(outputId)
    if (noSendChange.includes(output)) noSend.push(output)
  }
  const result = await generateChangeSdk(params, allocate, release, args.logger)
  return {
    allocated: result.allocatedChangeInputs.map(input => verifyTruthy(allocated.get(input.outputId))),
    changeSatoshis: result.changeOutputs.map(output => output.satoshis),
    maxPossibleSatoshisAdjustment: result.maxPossibleSatoshisAdjustment
  }
}

function makeChangeOutputs(
  state: ActionBatchPlannerState,
  fixedOutputCount: number,
  changeSatoshis: number[],
  derivationPrefix: string,
  random: () => number
): StorageCreateTransactionSdkOutput[] {
  return changeSatoshis.map((satoshis, index) => ({
    vout: fixedOutputCount + index,
    satoshis,
    lockingScript: '',
    providedBy: 'storage',
    purpose: 'change',
    basket: state.begin.changeBasket.name,
    tags: [],
    outputDescription: '',
    derivationSuffix: randomDerivation(16, random)
  }))
}

export async function planAction(
  state: ActionBatchPlannerState,
  args: Validation.ValidCreateActionArgs
): Promise<ActionBatchPlannedAction> {
  const seenOutpoints = new Set<string>()
  for (const outpoint of [...args.inputs.map(input => input.outpoint), ...args.options.noSendChange]) {
    const key = `${outpoint.txid}.${outpoint.vout}`
    if (seenOutpoints.has(key)) {
      throw new WERR_INVALID_PARAMETER('inputs', `unique inputs; ${key} is repeated`)
    }
    if (state.consumed.has(key)) {
      throw new WERR_INVALID_PARAMETER('inputs', `unspent inputs; ${key} is already consumed by this action batch`)
    }
    seenOutpoints.add(key)
  }
  const explicit = args.inputs.map(input => resolveInputOutput(state, input.outpoint))
  for (const output of explicit) {
    if (output.change)
      throw new WERR_INVALID_PARAMETER('inputs', 'unmanaged inputs; use noSendChange for managed change')
  }
  const noSendChange = args.options.noSendChange.map(outpoint =>
    requireManagedChange(resolveInputOutput(state, outpoint), `noSendChange ${outpoint.txid}.${outpoint.vout}`)
  )
  const funding = await planFunding(state, args, explicit, noSendChange)
  const derivationRandom = repeatableRandom(args.randomVals)
  const derivationPrefix = randomDerivation(16, derivationRandom)
  const outputs = requestedOutputs(args)
  let commissionKeyOffset: string | undefined
  if (state.begin.commissionSatoshis > 0 && state.begin.commissionPubKeyHex != null) {
    const commission = createStorageServiceChargeScript(state.begin.commissionPubKeyHex)
    commissionKeyOffset = commission.keyOffset
    outputs.push({
      vout: outputs.length,
      satoshis: state.begin.commissionSatoshis,
      lockingScript: commission.script,
      providedBy: 'storage',
      purpose: 'storage-commission',
      outputDescription: 'Storage Service Charge',
      tags: []
    })
  }
  if (funding.maxPossibleSatoshisAdjustment != null) {
    const adjustment = funding.maxPossibleSatoshisAdjustment
    if (outputs[adjustment.fixedOutputIndex]?.satoshis !== maxPossibleSatoshis) throw new WERR_INTERNAL()
    outputs[adjustment.fixedOutputIndex].satoshis = adjustment.satoshis
  }
  const fixedOutputCount = outputs.length
  outputs.push(
    ...makeChangeOutputs(state, fixedOutputCount, funding.changeSatoshis, derivationPrefix, derivationRandom)
  )
  // Legacy output randomization starts a fresh deterministic stream. Keeping
  // that boundary is required for byte-for-byte parity with createAction.
  if (args.options.randomizeOutputs) randomizeOutputVouts(outputs, args.randomVals)

  const inputs = [
    ...explicit.map((output, vin) => sdkInputFromExplicit(state, args.inputs[vin], vin, output, args.isSignAction)),
    ...funding.allocated.map((output, index) =>
      sdkInputFromFunding(state, output, explicit.length + index, args.isSignAction)
    )
  ]
  const consumedOutpoints = funding.allocated.map(outpointOf)
  for (const input of args.inputs) consumedOutpoints.push(`${input.outpoint.txid}.${input.outpoint.vout}`)
  for (const outpoint of consumedOutpoints) state.consumed.add(outpoint)
  state.estimatedChangeCount += funding.changeSatoshis.length - funding.allocated.length

  const reference = randomBytesBase64(12)
  const dcr: StorageCreateActionResult = {
    reference,
    version: args.version,
    lockTime: args.lockTime,
    inputs,
    outputs,
    derivationPrefix,
    inputBeef: trimInputBeef(state, args, inputs),
    noSendChangeOutputVouts: args.isNoSend
      ? outputs.filter(output => output.purpose === 'change').map(output => output.vout)
      : undefined
  }
  return { dcr, consumedOutpoints, commissionKeyOffset }
}

export function addPlannerOutputs(
  target: Map<string, PlannerOutput>,
  outputs: ActionBatchFundingOutput[],
  basketName?: string
): void {
  for (const output of outputs)
    target.set(outpointOf(output), {
      ...output,
      sourceTransaction: undefined,
      basketName
    })
}

export function stageTransactionOutputs(
  state: ActionBatchPlannerState,
  tx: Transaction,
  dcr: StorageCreateActionResult
): void {
  state.discardedStagedTxids.delete(tx.id('hex'))
  const now = new Date()
  for (const output of dcr.outputs) {
    const isChange = output.providedBy === 'storage' && output.purpose === 'change'
    const staged: PlannerOutput = {
      outputId: -(state.staged.size + 1),
      userId: 0,
      transactionId: 0,
      basketId: isChange ? state.begin.changeBasket.basketId : undefined,
      basketName: output.basket,
      tags: output.tags,
      spendable: true,
      change: isChange,
      outputDescription: output.outputDescription,
      vout: output.vout,
      satoshis: output.satoshis,
      providedBy: output.providedBy,
      purpose: output.purpose ?? '',
      type: isChange ? 'P2PKH' : 'custom',
      txid: tx.id('hex'),
      derivationPrefix: isChange ? dcr.derivationPrefix : undefined,
      derivationSuffix: output.derivationSuffix,
      customInstructions: output.customInstructions,
      lockingScript: undefined,
      created_at: now,
      updated_at: now
    }
    state.staged.set(outpointOf(staged), staged)
  }
}

export function mergePlannerBeef(state: ActionBatchPlannerState, tx: Transaction): void {
  state.sharedBeef.mergeRawTx(tx.toUint8Array())
}
