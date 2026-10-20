import {
  Beef,
  LockingScript,
  Signature,
  Spend,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  type AtomicBEEF,
  type BasketInsertion,
  type CreateActionArgs,
  type CreateActionInput,
  type CreateActionOutput,
  type CreateSignatureArgs,
  type InternalizeActionArgs,
  type ListOutputsArgs,
  type ListOutputsResult,
  type SignActionArgs,
  type SignActionResult,
  type WalletCounterparty,
  type WalletInterface,
  type WalletOutput
} from '@bsv/sdk'
import { hash160, hash256 } from '@bsv/sdk/primitives/Hash'
import Random from '@bsv/sdk/primitives/Random'
import { toArray, toBase64, toHex } from '@bsv/sdk/primitives/utils'
import { OneColor } from '@bsv/templates'
import {
  encryptMetadata,
  maybeDecryptMetadata,
  sdk as toolbox,
  type PermissionsModule,
  type PermissionsModuleAction,
  type PermissionsModuleNext,
  type PermissionsModuleRequest
} from '@bsv/wallet-toolbox-client'
import {
  ColorPlan,
  type ColorOperationName,
  parseProfileData,
  parseRemittances,
  type ColorRemittance
} from './ColorPlan.js'
import {
  ASSETS_SELECTOR,
  assetBasket,
  COLOR_BASKET_NAMESPACE,
  COLOR_KEY_ID,
  colorProtocolID,
  colorTopic,
  DISCOVERY_TOPIC,
  ISSUE,
  outpointString,
  parseAssetBasket,
  parseAssetId,
  parseAssetSelector,
  parseBalanceSelector,
  parseColorProtocolID,
  parseOutpoint,
  validateIdentityKey,
  validateRemittanceString,
  type TokenRole
} from './identifiers.js'
import { eachInOrder } from './inOrder.js'
import { readOutputList } from './overlay.js'
import {
  exactMembers,
  jsonByteArray,
  jsonObject,
  jsonUint32,
  parseStrictJsonBytes
} from './strictJson.js'
import { isDeployOutput, readTokenOutput, type TokenOutput } from './tokenOutputs.js'
import type {
  ColorOverlayProvider,
  ColorPermissionModuleOptions,
  ColorTokenAccessHandler
} from './types.js'

const UNLOCKING_SCRIPT_LENGTH = 108
const TOKEN_CARRIER_SATOSHIS = 1
const DEFAULT_SIGHASH = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024
const MAX_RECEIPT_INSTRUCTION_BYTES = 1000
const LIST_PAGE_LIMIT = 10_000
const SUBMIT_ATTEMPTS = 3
const NOSEND_EXPIRY_LABEL_PREFIX = 'p nosend expiry '
const PROOF_LABEL_PREFIX = 'p color proof '
const STATE_TAG_PREFIX = 'color_state_'
const UTF8 = new TextEncoder()

/** The derivation tuple a managed output's key was created with; `assetId` is `ISSUE` for a deploy. */
interface Custody {
  assetId: string
  derivationPrefix: string
  derivationSuffix: string
  senderIdentityKey: string
}

interface SourceOutput {
  outpoint: string
  lockingScript: LockingScript
  satoshis: number
}

/** A basket output that may be selected, read from its locking script before any custody is read. */
interface Candidate extends SourceOutput {
  token: TokenOutput
  amount: bigint
  customInstructions: string
}

interface ManagedInput extends SourceOutput {
  assetId: string
  role: TokenRole
  amount: bigint
  custody: Custody
}

type InventoryState = 'available' | 'reserved' | 'pending'

function sumAmounts(inputs: ReadonlyArray<{ amount: bigint }>): bigint {
  return inputs.reduce((total, input) => total + input.amount, 0n)
}

function inputOutpoint(input: Transaction['inputs'][number]): string {
  const txid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
  if (txid === undefined) throw new Error('BRC-207: transaction input has no source transaction ID')
  return outpointString(txid, input.sourceOutputIndex)
}

/**
 * Drops `p color proof` labels unread. They carry BRC-176 lineage packets for modules that
 * validate them and are never stored. This module relies on overlay admission and spendability
 * instead; a wallet that wants BRC-176 supplies its own color module.
 */
function withoutProofLabels(labels: readonly string[]): string[] {
  return labels.filter(label => !label.startsWith(PROOF_LABEL_PREFIX))
}

function custodyOf(remittance: ColorRemittance): Custody {
  const { assetId, derivationPrefix, derivationSuffix, senderIdentityKey } = remittance
  return { assetId, derivationPrefix, derivationSuffix, senderIdentityKey }
}

function tokenInputs(inputs: readonly ManagedInput[]): CreateActionInput[] {
  return inputs.map(input => ({
    outpoint: input.outpoint,
    unlockingScriptLength: UNLOCKING_SCRIPT_LENGTH,
    inputDescription: 'BRC-207 token input'
  }))
}

function custodyInstructions(custody: Custody): string {
  return JSON.stringify({ version: 1, ...custody })
}

/** Parses the receipt-format custody JSON stored in, or supplied as, an output's custom instructions. */
function parseCustody(text: string, maxBytes: number | undefined, label: string): Custody {
  const bytes = UTF8.encode(text)
  if (maxBytes !== undefined && bytes.length > maxBytes)
    throw new Error(`BRC-207: ${label} exceeds ${maxBytes} bytes`)
  const object = jsonObject(parseStrictJsonBytes(bytes, label), label)
  exactMembers(
    object,
    ['version', 'assetId', 'derivationPrefix', 'derivationSuffix', 'senderIdentityKey'],
    ['profileData'],
    label
  )
  if (object.version !== 1) throw new Error(`BRC-207: ${label} version must be 1`)
  const profileData = parseProfileData(object.profileData, `${label}.profileData`)
  if (profileData !== undefined && Object.keys(profileData).length > 0) {
    throw new Error(`BRC-207: ${label}.profileData names a profile the asset does not require`)
  }
  return {
    assetId: parseAssetSelector(object.assetId),
    derivationPrefix: validateRemittanceString(
      object.derivationPrefix,
      `${label}.derivationPrefix`
    ),
    derivationSuffix: validateRemittanceString(
      object.derivationSuffix,
      `${label}.derivationSuffix`
    ),
    senderIdentityKey: validateIdentityKey(object.senderIdentityKey, `${label}.senderIdentityKey`)
  }
}

/** True when a custody selector names the output's asset: `ISSUE` exactly for its deploy. */
function selectsAsset(selector: string, token: TokenOutput): boolean {
  return selector === ISSUE ? token.deploy : !token.deploy && selector === token.assetId
}

/** One asset's token units and authority outputs on one side of a transaction. */
interface Holding {
  value: bigint
  authority: number
}

/** What the caller's explicit inputs contribute to one asset, and how much of it is foreign. */
interface ExplicitHolding extends Holding {
  foreignValue: bigint
  foreignAuthority: number
}

/** The caller's explicit inputs and what they contribute per asset. */
interface ExplicitInputs {
  inputs: CreateActionInput[]
  managed: ManagedInput[]
  holdings: Map<string, ExplicitHolding>
}

/** The requested outputs' token totals per existing asset, the deploy, and the outputs that leave the wallet. */
interface PlannedOutputs {
  holdings: Map<string, Holding>
  deploy?: { operation: ColorOperationName }
  destinations: Array<{
    outputIndex: number
    assetId: string
    role: TokenRole
    amount: string
    lockingScript: string
  }>
}

/** One existing asset's funding: its selected inputs, token change and resulting outputs. */
interface AssetFunding {
  assetId: string
  selected: ManagedInput[]
  change: bigint
  outputs: Holding
}

const AUTHORITY_OPERATIONS: readonly ColorOperationName[] = [
  'authority-split',
  'authority-combine',
  'authority-transfer',
  'authority-end'
]

function holding<T extends Holding>(totals: Map<string, T>, assetId: string, empty: () => T): T {
  let entry = totals.get(assetId)
  if (entry === undefined) {
    entry = empty()
    totals.set(assetId, entry)
  }
  return entry
}

function emptyHolding(): Holding {
  return { value: 0n, authority: 0 }
}

function emptyExplicitHolding(): ExplicitHolding {
  return { value: 0n, authority: 0, foreignValue: 0n, foreignAuthority: 0 }
}

/** The BRC-207 authority operation for a transaction's authority input and output counts. */
function authorityOperation(inputs: number, outputs: number): ColorOperationName {
  if (outputs === 0) return 'authority-end'
  if (outputs < inputs) return 'authority-combine'
  return outputs === inputs ? 'authority-transfer' : 'authority-split'
}

/** Authority inputs to select for a declared authority operation when the caller supplies none. */
function authorityInputsFor(operation: ColorOperationName, outputs: number): number {
  if (operation === 'authority-transfer') return outputs
  if (operation === 'authority-combine') return outputs + 1
  return 1
}

/**
 * The operations BRC-207 requires for one existing asset: value inputs fund value outputs
 * first, the rest of the inputs is burned and the rest of the outputs is minted.
 */
function requiredOperations(inputs: Holding, outputs: Holding): ColorOperationName[] {
  if (inputs.authority === 0 && outputs.authority > 0)
    throw new Error('BRC-207: an authority output needs an authority input of the same asset')
  const { transferred, burned, minted } = supplyChange(inputs, outputs)
  if (minted > 0n && inputs.authority === 0)
    throw new Error('BRC-207: token outputs exceed the authenticated input balance')
  const operations: ColorOperationName[] = []
  if (transferred > 0n) operations.push('transfer')
  if (burned > 0n) operations.push('burn')
  if (minted > 0n) operations.push('mint')
  if (inputs.authority > 0) operations.push(authorityOperation(inputs.authority, outputs.authority))
  return operations
}

function declaredOperations(plan: ColorPlan, assetId: string): Set<ColorOperationName> {
  return new Set(
    plan.operations.filter(operation => operation.assetId === assetId).map(op => op.operation)
  )
}

/** Fails unless the plan declares exactly the operations the asset's transaction requires. */
function assertOperations(plan: ColorPlan, assetId: string, required: ColorOperationName[]): void {
  const declared = declaredOperations(plan, assetId)
  if (declared.size !== required.length || required.some(operation => !declared.has(operation))) {
    throw new Error(
      `BRC-207: ${assetId} requires the operations [${required.join(', ')}] but the plan declares [${[...declared].join(', ')}]`
    )
  }
}

/** Supply accounting: value inputs fund value outputs first; the rest is burned or minted. */
function supplyChange(
  inputs: Holding,
  outputs: Holding
): { transferred: bigint; burned: bigint; minted: bigint } {
  const transferred = outputs.value < inputs.value ? outputs.value : inputs.value
  return {
    transferred,
    burned: inputs.value - transferred,
    minted: outputs.value - transferred
  }
}

/**
 * What the user approves for a funded action: every asset leg, with this wallet's and foreign
 * inputs, kept and outgoing outputs and the supply change; satoshi totals and fee; the
 * signatures the module releases; and the lock time.
 */
function actionConsent(
  plan: ColorPlan,
  createArgs: CreateActionArgs,
  tx: Transaction,
  tokens: TransactionTokens,
  managed: readonly ManagedInput[],
  scopes: ReadonlyMap<string, number>
): Record<string, unknown> {
  const requested = createArgs.outputs ?? []
  const kept = (index: number): boolean =>
    requested[index]?.basket?.startsWith(`${COLOR_BASKET_NAMESPACE} `) === true ||
    plan.ownedOutputs.some(remittance => remittance.outputIndex === index)
  const txid = tx.id('hex')
  const outputs = tx.outputs.map((output, vout) => ({
    vout,
    token: readTokenOutput(output.lockingScript, { txid, vout }),
    satoshis: output.satoshis ?? 0
  }))
  const assets = [...new Set([...tokens.inputs.keys(), ...tokens.outputs.keys()])].map(assetId => {
    const own = managed.filter(input => input.assetId === assetId)
    const inputs = tokens.inputs.get(assetId) ?? emptyHolding()
    const all = tokens.outputs.get(assetId) ?? emptyHolding()
    const keptOutputs = outputs.filter(
      output => output.token?.assetId === assetId && !output.token.deploy && kept(output.vout)
    )
    const { transferred, burned, minted } = supplyChange(inputs, all)
    return {
      assetId,
      operations: requiredOperations(inputs, all),
      inputAmount: sumAmounts(own).toString(),
      foreignAmount: (inputs.value - sumAmounts(own)).toString(),
      authorityInputs: own.filter(input => input.role === 'authority').length,
      foreignAuthorityInputs:
        inputs.authority - own.filter(input => input.role === 'authority').length,
      keptAmount: sumAmounts(keptOutputs.map(output => output.token!)).toString(),
      keptAuthorities: keptOutputs.filter(output => output.token!.role === 'authority').length,
      outgoingAmount: (all.value - sumAmounts(keptOutputs.map(output => output.token!))).toString(),
      outgoingAuthorities:
        all.authority - keptOutputs.filter(output => output.token!.role === 'authority').length,
      transferred: transferred.toString(),
      burned: burned.toString(),
      minted: minted.toString()
    }
  })
  const inputSatoshis = tx.inputs.reduce(
    (total, input) =>
      total + (input.sourceTransaction!.outputs[input.sourceOutputIndex].satoshis ?? 0),
    0
  )
  const outputSatoshis = outputs.reduce((total, output) => total + output.satoshis, 0)
  return {
    type: 'color_send',
    handoff: (createArgs.labels ?? []).some(label => label.startsWith(NOSEND_EXPIRY_LABEL_PREFIX)),
    ...(tokens.deploy === undefined
      ? {}
      : {
          deploy: {
            operation: deployOperation(tokens.deploy),
            amount: tokens.deploy.amount.toString(),
            owned: plan.ownedOutputs.some(remittance => remittance.outputIndex === 0)
          }
        }),
    assets,
    destinations: outputs
      .filter(output => output.vout < requested.length && !kept(output.vout))
      .map(output => ({
        outputIndex: output.vout,
        satoshis: output.satoshis,
        lockingScript: tx.outputs[output.vout].lockingScript.toHex(),
        ...(output.token === undefined
          ? {}
          : {
              assetId: output.token.deploy ? ISSUE : output.token.assetId,
              role: output.token.role,
              amount: output.token.amount.toString()
            })
      })),
    satoshis: {
      inputs: inputSatoshis,
      outputs: outputSatoshis,
      fee: inputSatoshis - outputSatoshis
    },
    signatures: managed.map(input => ({
      outpoint: input.outpoint,
      inputIndex: tx.inputs.findIndex(candidate => inputOutpoint(candidate) === input.outpoint),
      sighashType: scopes.get(input.outpoint) ?? DEFAULT_SIGHASH
    })),
    lockTime: tx.lockTime
  }
}

/** Plan and action features this module version does not implement. */
function assertPlanSupported(plan: ColorPlan, args: CreateActionArgs, handoff: boolean): void {
  if (Object.keys(plan.profileData ?? {}).length > 0) {
    throw new Error('BRC-207: plan.profileData is not supported')
  }
  if (handoff && (args.inputs ?? []).length > 0) {
    throw new Error('BRC-207: explicit inputs are not supported with a BRC-177 handoff')
  }
  if (plan.changePositions.length > 0 && args.options?.randomizeOutputs !== false) {
    throw new Error('BRC-207: plan.changePositions requires options.randomizeOutputs false')
  }
}

/** Explicit inputs in their final places, with the module's token inputs in the remaining slots. */
function orderInputs(
  explicit: readonly CreateActionInput[],
  added: readonly CreateActionInput[],
  positions: ColorPlan['inputPositions']
): CreateActionInput[] {
  const all = [...explicit, ...added]
  if (positions.length === 0) return all
  const slots = new Map<number, CreateActionInput>()
  for (const { outpoint, index } of positions) {
    const input = explicit.find(candidate => candidate.outpoint === outpoint)
    if (input === undefined)
      throw new Error(
        'BRC-207: plan.inputPositions names an outpoint that is not an explicit input'
      )
    if (index >= all.length || slots.has(index))
      throw new Error('BRC-207: plan.inputPositions cannot be satisfied')
    slots.set(index, input)
  }
  const placed = new Set(slots.values())
  const rest = all.filter(input => !placed.has(input))
  return Array.from({ length: all.length }, (_, index) => slots.get(index) ?? rest.shift()!)
}

/**
 * Requested outputs at their own indices, then token change, each asset's change at its pinned
 * index if it has one. A change position cannot displace a requested output.
 */
function placeChange(
  outputs: readonly CreateActionOutput[],
  changes: ReadonlyArray<{ assetId: string; output: CreateActionOutput }>,
  positions: ColorPlan['changePositions']
): CreateActionOutput[] {
  const slots = new Map<number, CreateActionOutput>()
  for (const { assetId, index } of positions) {
    if (index < outputs.length)
      throw new Error('BRC-207: plan.changePositions conflict with the requested outputs')
    const change = changes.find(candidate => candidate.assetId === assetId)
    if (change === undefined || index >= outputs.length + changes.length)
      throw new Error('BRC-207: plan.changePositions cannot be satisfied')
    slots.set(index, change.output)
  }
  const placed = new Set(slots.values())
  const rest = changes.map(change => change.output).filter(output => !placed.has(output))
  return [
    ...outputs,
    ...Array.from(
      { length: changes.length },
      (_, offset) => slots.get(outputs.length + offset) ?? rest.shift()!
    )
  ]
}

/** Token inputs of `tx` other than those in `except`, read from their source transactions. */
function tokenSources(
  tx: Transaction,
  managed: ReadonlySet<string>
): Array<SourceOutput & { assetId: string; token: TokenOutput }> {
  return tx.inputs.flatMap(input => {
    const outpoint = inputOutpoint(input)
    const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
    if (managed.has(outpoint) || source?.satoshis === undefined) return []
    const token = tryReadTokenOutput(source.lockingScript, parseOutpoint(outpoint))
    if (token === undefined) return []
    return [
      {
        outpoint,
        lockingScript: source.lockingScript,
        satoshis: source.satoshis,
        assetId: token.assetId,
        token
      }
    ]
  })
}

/**
 * The existing assets among a transaction's token inputs (read from `inputs`, which carries their
 * sources) and outputs, and whether output 0 is a deploy: the topics it is submitted to.
 */
function submissionAssets(
  tx: Transaction,
  inputs: Transaction = tx
): { assetIds: string[]; deploy: boolean } {
  const txid = tx.id('hex')
  const outputs = tx.outputs.map((output, vout) =>
    tryReadTokenOutput(output.lockingScript, { txid, vout })
  )
  const assetIds = new Set([
    ...tokenSources(inputs, new Set()).map(input => input.assetId),
    ...outputs.flatMap(token => (token === undefined || token.deploy ? [] : [token.assetId]))
  ])
  return { assetIds: [...assetIds], deploy: outputs[0]?.deploy === true }
}

/** Runs one input's unlocking script against its source output; throws when it does not unlock. */
function assertUnlocks(tx: Transaction, inputIndex: number): void {
  const input = tx.inputs[inputIndex]
  const source = input.sourceTransaction?.outputs[input.sourceOutputIndex]
  if (source?.satoshis === undefined || input.unlockingScript === undefined)
    throw new Error(`BRC-207: transaction input ${inputIndex} lacks its source or unlocking script`)
  new Spend({
    sourceTXID: input.sourceTransaction!.id('hex'),
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis: source.satoshis,
    lockingScript: source.lockingScript,
    transactionVersion: tx.version,
    otherInputs: tx.inputs.filter((_, index) => index !== inputIndex),
    outputs: tx.outputs,
    inputIndex,
    unlockingScript: input.unlockingScript,
    inputSequence: input.sequence ?? 0xffffffff,
    lockTime: tx.lockTime
  }).validate()
}

function addToken(totals: Map<string, Holding>, token: TokenOutput): void {
  const entry = holding(totals, token.assetId, emptyHolding)
  if (token.role === 'value') entry.value += token.amount
  else entry.authority += 1
}

/** A foreign input's source output from the caller's inputBEEF, if it is there. */
function foreignSource(beef: Beef | undefined, outpoint: string): SourceOutput | undefined {
  const { txid, vout } = parseOutpoint(outpoint)
  const output = beef?.findTxid(txid)?.tx?.outputs[vout]
  if (output?.satoshis === undefined) return undefined
  return { outpoint, lockingScript: output.lockingScript, satoshis: output.satoshis }
}

/** A transaction's token inputs and outputs per existing asset, and its deploy output. */
interface TransactionTokens {
  consumed: Array<SourceOutput & { assetId: string; token: TokenOutput }>
  inputs: Map<string, Holding>
  outputs: Map<string, Holding>
  deploy?: TokenOutput
}

/** Reads every input's source and every output; an input without its source fails. */
function transactionTokens(tx: Transaction): TransactionTokens {
  tx.inputs.forEach((input, index) => {
    if (input.sourceTransaction === undefined)
      throw new Error(`BRC-207: input ${index} has no source transaction to authenticate`)
  })
  const txid = tx.id('hex')
  const consumed = tokenSources(tx, new Set())
  const inputs = new Map<string, Holding>()
  for (const source of consumed) addToken(inputs, source.token)
  const outputs = new Map<string, Holding>()
  let deploy: TokenOutput | undefined
  tx.outputs.forEach((output, vout) => {
    const token = readTokenOutput(output.lockingScript, { txid, vout })
    if (token?.deploy === true) deploy = token
    else if (token !== undefined) addToken(outputs, token)
  })
  return { consumed, inputs, outputs, deploy }
}

function deployOperation(token: TokenOutput): ColorOperationName {
  return token.amount > 0n ? 'deploy-fixed' : 'deploy-authority'
}

/** Fails unless the plan's operations and assets are exactly what the transaction performs. */
function assertTransactionOperations(plan: ColorPlan, tokens: TransactionTokens): void {
  const assetIds = new Set([...tokens.inputs.keys(), ...tokens.outputs.keys()])
  assertPlanAssets(plan, new Set([...assetIds, ...(tokens.deploy === undefined ? [] : [ISSUE])]))
  if (tokens.deploy !== undefined) assertOperations(plan, ISSUE, [deployOperation(tokens.deploy)])
  for (const assetId of assetIds)
    assertOperations(
      plan,
      assetId,
      requiredOperations(
        tokens.inputs.get(assetId) ?? emptyHolding(),
        tokens.outputs.get(assetId) ?? emptyHolding()
      )
    )
}

/** Satoshi change comes after every module-placed output, where the wallet appends it. */
function assertSatoshiChangePosition(plan: ColorPlan, outputCount: number): void {
  const pinned = plan.changePositions.find(position => position.assetId === null)
  if (pinned === undefined || pinned.index === outputCount) return
  throw new Error(
    pinned.index < outputCount
      ? 'BRC-207: plan.changePositions conflict with the requested outputs'
      : 'BRC-207: plan.changePositions cannot be satisfied'
  )
}

/** The sighash type for each managed input; an override must name one the module signs. */
function sighashScopes(plan: ColorPlan, managed: ReadonlySet<string>): Map<string, number> {
  const scopes = new Map<string, number>()
  for (const { outpoint, sighashType } of plan.sighashTypes) {
    if (!managed.has(outpoint))
      throw new Error('BRC-207: plan.sighashTypes names an input this wallet does not sign')
    scopes.set(outpoint, sighashType)
  }
  return scopes
}

/** The plan names exactly the assets among the action's token inputs and outputs. */
function assertPlanAssets(plan: ColorPlan, involved: ReadonlySet<string>): void {
  if (plan.assets.length !== involved.size || plan.assets.some(assetId => !involved.has(assetId)))
    throw new Error('BRC-207: plan.assets must name exactly the assets the action moves')
}

/** Largest amount first. */
function byAmountDescending(a: { amount: bigint }, b: { amount: bigint }): number {
  if (a.amount === b.amount) return 0
  return a.amount > b.amount ? -1 : 1
}

interface InventoryRecord {
  output: WalletOutput
  assetId: string
  source: SourceOutput
}

interface InventoryView {
  record: InventoryRecord
  state: InventoryState
  tags: string[]
}

/** The token outputs of a namespace listing. */
function inventoryRecords(outputs: WalletOutput[], beef: Beef | undefined): InventoryRecord[] {
  const records: InventoryRecord[] = []
  for (const output of outputs) {
    const outpoint = parseOutpoint(output.outpoint)
    const lockingScript =
      beef === undefined
        ? LockingScript.fromHex(output.lockingScript ?? '')
        : beef.findTxid(outpoint.txid)?.tx?.outputs[outpoint.vout]?.lockingScript
    if (lockingScript === undefined) continue
    const token = tryReadTokenOutput(lockingScript, outpoint)
    if (token === undefined) continue
    records.push({
      output,
      assetId: token.assetId,
      source: { outpoint: output.outpoint, lockingScript, satoshis: output.satoshis }
    })
  }
  return records
}

/** Reserved by a pending action, else available when its overlay admits it, else pending. */
function inventoryState(record: InventoryRecord, admitted: ReadonlySet<string>): InventoryState {
  if (!record.output.spendable) return 'reserved'
  return admitted.has(record.output.outpoint) ? 'available' : 'pending'
}

function tryReadTokenOutput(
  lockingScript: LockingScript,
  outpoint: ReturnType<typeof parseOutpoint>
): TokenOutput | undefined {
  try {
    return readTokenOutput(lockingScript, outpoint)
  } catch {
    return undefined
  }
}

/** A record with its stored tags and the computed state tag in place of any stored one. */
function inventoryView(record: InventoryRecord, admitted: ReadonlySet<string>): InventoryView {
  const state = inventoryState(record, admitted)
  const tags = [
    ...(record.output.tags ?? []).filter(tag => !tag.startsWith(STATE_TAG_PREFIX)),
    `${STATE_TAG_PREFIX}${state}`
  ]
  return { record, state, tags }
}

/** A BEEF holding only the transactions of the returned page. */
function pageBeef(beef: Beef, page: readonly InventoryView[]): number[] {
  const result = new Beef()
  for (const txid of new Set(page.map(view => parseOutpoint(view.record.output.outpoint).txid))) {
    const tx = beef.findAtomicTransaction(txid)
    if (tx !== undefined) result.mergeTransaction(tx)
  }
  return result.toBinary()
}

function matchesTags(
  tags: readonly string[],
  filter: readonly string[],
  mode: ListOutputsArgs['tagQueryMode']
): boolean {
  if (filter.length === 0) return true
  return mode === 'all'
    ? filter.every(tag => tags.includes(tag))
    : filter.some(tag => tags.includes(tag))
}

/**
 * BRC-207 `color` wallet module for BRC-162 fungible tokens.
 *
 * Register it as `permissionModules: { color }` on a WalletPermissionsManager. It
 * verifies and accepts receipts, funds token sends from its per-asset baskets and
 * signs their inputs during `signAction`, signs app-built transactions through
 * `createSignature`, and answers the `p color assets` and `p color balance` views.
 */
export class ColorPermissionModule implements PermissionsModule {
  readonly #wallet: WalletInterface
  readonly #provider: ColorOverlayProvider
  readonly #requestTokenAccess: ColorTokenAccessHandler
  /** Outputs a send in progress has selected, so a concurrent send does not select them too. */
  readonly #selected = new Set<string>()
  readonly #supportedAssets = new Map<string, Promise<void>>()
  #identityKey?: Promise<string>

  constructor(options: ColorPermissionModuleOptions) {
    if (options?.wallet == null) throw new TypeError('BRC-207: wallet is required')
    if (options.provider == null) throw new TypeError('BRC-207: provider is required')
    if (typeof options.requestTokenAccess !== 'function') {
      throw new TypeError('BRC-207: requestTokenAccess is required')
    }
    this.#wallet = options.wallet
    this.#provider = options.provider
    this.#requestTokenAccess = options.requestTokenAccess
  }

  /** Clears in-memory selections and asset checks. */
  dispose(): void {
    this.#selected.clear()
    this.#supportedAssets.clear()
  }

  /** Protocol- and basket-routed calls: key and signature operations and the read views. */
  async handleRequest(
    req: PermissionsModuleRequest,
    next: PermissionsModuleNext
  ): Promise<unknown> {
    switch (req.method) {
      case 'getPublicKey':
      case 'verifySignature':
        this.#parseKeyArgs(req.args as { protocolID?: unknown; keyID?: unknown })
        return await next(req.args)
      case 'createSignature':
        return await this.#createSignature(req.args as CreateSignatureArgs, req.originator, next)
      case 'listOutputs':
        return await this.#listOutputs(req.args as ListOutputsArgs, req.originator, next)
      case 'relinquishOutput': {
        const { basket, output } = req.args as { basket: string; output: string }
        const target = parseAssetBasket(basket)
        if (target === undefined) {
          throw new Error('BRC-207: only per-asset baskets hold outputs that can be relinquished')
        }
        await this.#approve(req.originator, {
          type: 'color_relinquish',
          assetId: target.assetId,
          role: target.role,
          outpoint: output
        })
        return await next(req.args)
      }
      default:
        throw new Error(`BRC-207: ${req.method} is not available in the p color namespace`)
    }
  }

  /** Label- and basket-routed actions. */
  async onRequest(req: PermissionsModuleRequest): Promise<{ args: object }> {
    switch (req.method) {
      case 'createAction':
        return { args: await this.#createAction(req.args as CreateActionArgs, req.originator) }
      case 'signAction':
        return {
          args: await this.#signAction(req.args as SignActionArgs, req.action, req.originator)
        }
      case 'internalizeAction': {
        const args = req.args as InternalizeActionArgs
        await this.#internalizeAction(args, req.originator)
        return { args: { ...args, labels: withoutProofLabels(args.labels ?? []) } }
      }
      case 'listActions':
        await this.#authorizeRead(req.originator)
        return { args: req.args }
      default:
        throw new Error(`BRC-207: ${req.method} is not available in the p color namespace`)
    }
  }

  async onResponse(
    res: unknown,
    context: { method: string; originator: string; action?: PermissionsModuleAction }
  ): Promise<unknown> {
    if (context.method === 'signAction' && context.action !== undefined) {
      await this.#fileDeploy(res as SignActionResult, context.action, context.originator)
      // A noSend action is a handoff: its receiver submits it.
      if (!context.action.noSend)
        await this.#submitSigned(res as SignActionResult, context.action.transaction)
    }
    return res
  }

  /**
   * Files a signed deploy this wallet keeps in its asset's value or authority basket, now that
   * the asset ID is final. The deploy keeps its `ISSUE` key; it stays pending until admitted.
   */
  async #fileDeploy(
    result: SignActionResult,
    action: PermissionsModuleAction,
    originator: string
  ): Promise<void> {
    if (result?.tx === undefined) return
    const tx = Transaction.fromAtomicBEEF(result.tx)
    const txid = tx.id('hex')
    const deploy = tryReadTokenOutput(tx.outputs[0]?.lockingScript ?? new LockingScript(), {
      txid,
      vout: 0
    })
    const owned = ColorPlan.fromLabels(action.createArgs?.labels)?.ownedOutputs.some(
      remittance => remittance.outputIndex === 0 && remittance.assetId === ISSUE
    )
    if (deploy?.deploy !== true || owned !== true) return
    await this.#wallet.listOutputs(
      {
        basket: toolbox.specOpSetOutputBasket,
        tags: [outpointString(txid, 0), assetBasket(deploy.assetId, deploy.role)]
      },
      originator
    )
  }

  /* ----------------------------------------------------------------------
   * Receive
   * ---------------------------------------------------------------------- */

  /** Verifies every `p color` receipt; the caller must already have submitted the transaction. */
  async #internalizeAction(args: InternalizeActionArgs, originator: string): Promise<void> {
    if (
      withoutProofLabels(args.labels ?? []).some(label =>
        label.startsWith(`${COLOR_BASKET_NAMESPACE} `)
      )
    ) {
      throw new Error(
        'BRC-207: p color labels other than proof labels have no meaning in internalizeAction'
      )
    }
    const tx = Transaction.fromAtomicBEEF(args.tx)
    const receipts = args.outputs.flatMap(output => {
      const remittance = output.insertionRemittance
      return output.protocol === 'basket insertion' &&
        remittance?.basket.startsWith(`${COLOR_BASKET_NAMESPACE} `) === true
        ? [{ outputIndex: output.outputIndex, remittance }]
        : []
    })
    if (receipts.length === 0) return
    await this.#assertCompletedTransaction(tx)
    await eachInOrder(receipts, async ({ outputIndex, remittance }) => {
      await this.#verifyReceipt(tx, outputIndex, remittance, originator)
    })
  }

  /**
   * Checks a received transaction: every input unlocks its source, every consumed token input
   * was admitted to its asset overlay, and each asset's outputs follow BRC-162's supply rules.
   */
  async #assertCompletedTransaction(tx: Transaction): Promise<void> {
    for (let index = 0; index < tx.inputs.length; index++) assertUnlocks(tx, index)
    const { consumed, inputs, outputs } = transactionTokens(tx)
    await eachInOrder(new Set([...inputs.keys(), ...outputs.keys()]), async assetId => {
      await this.#assertSupportedAsset(assetId)
      const sources = consumed.filter(source => source.assetId === assetId)
      if (sources.length > 0) {
        const admitted = await this.#listed('admission', assetId, sources)
        if (sources.some(source => !admitted.has(source.outpoint)))
          throw new Error(`BRC-207: a consumed ${assetId} input was never admitted to its overlay`)
      }
      requiredOperations(
        inputs.get(assetId) ?? emptyHolding(),
        outputs.get(assetId) ?? emptyHolding()
      )
    })
  }

  /** One receipt: its custody, its output's asset, owner and basket, and overlay admission. */
  async #verifyReceipt(
    tx: Transaction,
    outputIndex: number,
    remittance: BasketInsertion,
    originator: string
  ): Promise<void> {
    const target = parseAssetBasket(remittance.basket)
    if (target === undefined)
      throw new Error('BRC-207: a receipt must name a per-asset value or authority basket')
    const custody = parseCustody(
      remittance.customInstructions ?? '',
      MAX_RECEIPT_INSTRUCTION_BYTES,
      'receipt customInstructions'
    )
    const source = tx.outputs[outputIndex]
    if (source?.satoshis === undefined)
      throw new Error('BRC-207: the receipt names a missing output')
    const txid = tx.id('hex')
    const token = readTokenOutput(source.lockingScript, { txid, vout: outputIndex })
    if (token === undefined)
      throw new Error('BRC-207: the received output is not a BRC-162 token output')
    if (!selectsAsset(custody.assetId, token)) {
      throw new Error('BRC-207: the receipt instructions name a different asset than the output')
    }
    if (target.assetId !== token.assetId || target.role !== token.role) {
      throw new Error('BRC-207: the receipt basket does not match the received output')
    }
    await this.#assertOwned(token, custody, custody.senderIdentityKey, originator)
    await this.#assertSupportedAsset(token.assetId)
    const outpoint = outpointString(txid, outputIndex)
    const admitted = await this.#spendable(token.assetId, [
      { outpoint, lockingScript: source.lockingScript, satoshis: source.satoshis }
    ])
    if (!admitted.has(outpoint)) {
      throw new Error(
        'BRC-207: the received output is not admitted and unspent in its asset overlay'
      )
    }
  }

  /* ----------------------------------------------------------------------
   * Send
   * ---------------------------------------------------------------------- */

  /** Checks a planned token action and adds its selected token inputs and per-asset change. */
  async #createAction(args: CreateActionArgs, originator: string): Promise<CreateActionArgs> {
    const labels = args.labels ?? []
    const plan = ColorPlan.fromLabels(labels)
    if (plan === undefined)
      throw new Error('BRC-207: a p color createAction requires a p color plan')
    const handoff = labels.some(label => label.startsWith(NOSEND_EXPIRY_LABEL_PREFIX))
    assertPlanSupported(plan, args, handoff)
    const { planned, outputs } = await this.#planOutputs(plan, args, originator)
    // Storage locks the inputs when the wallet creates the action; until then they stay selected.
    const reserved = new Set<string>()
    try {
      const explicit = await this.#explicitInputs(args, originator)
      this.#reserve(reserved, explicit.managed)
      const { inputs, changes } = await this.#fund(
        reserved,
        plan,
        planned,
        explicit,
        handoff,
        originator
      )
      sighashScopes(plan, new Set([...explicit.managed, ...inputs].map(input => input.outpoint)))
      const placed = placeChange(
        outputs,
        changes,
        plan.changePositions.filter(position => position.assetId !== null)
      )
      assertSatoshiChangePosition(plan, placed.length)
      return {
        ...args,
        labels: withoutProofLabels(labels),
        inputs: orderInputs(explicit.inputs, tokenInputs(inputs), plan.inputPositions),
        outputs: placed
      }
    } finally {
      for (const outpoint of reserved) this.#selected.delete(outpoint)
    }
  }

  #reserve(reserved: Set<string>, inputs: ReadonlyArray<{ outpoint: string }>): void {
    for (const input of inputs) {
      this.#selected.add(input.outpoint)
      reserved.add(input.outpoint)
    }
  }

  #release(reserved: Set<string>, inputs: ReadonlyArray<{ outpoint: string }>): void {
    for (const input of inputs) {
      this.#selected.delete(input.outpoint)
      reserved.delete(input.outpoint)
    }
  }

  /**
   * Classifies the caller's inputs: this wallet's `p color` outputs are managed and signed by the
   * module; foreign token inputs count only once their asset's overlay admits them; other inputs
   * pass through unchanged.
   */
  async #explicitInputs(args: CreateActionArgs, originator: string): Promise<ExplicitInputs> {
    const inputs = args.inputs ?? []
    const explicit: ExplicitInputs = { inputs: [...inputs], managed: [], holdings: new Map() }
    if (inputs.length === 0) return explicit
    const outpoints = new Set(inputs.map(input => input.outpoint))
    if (outpoints.size !== inputs.length) throw new Error('BRC-207: duplicate explicit input')
    const listed = await this.#wallet.listOutputs(
      {
        basket: toolbox.specOpBasketPrefixOutputs,
        tags: [COLOR_BASKET_NAMESPACE],
        include: 'locking scripts',
        includeCustomInstructions: true
      },
      originator
    )
    const own = new Map(
      listed.outputs
        .filter(output => outpoints.has(output.outpoint))
        .map(output => [output.outpoint, output])
    )
    const beef = args.inputBEEF === undefined ? undefined : Beef.fromBinary(args.inputBEEF)
    await eachInOrder(inputs, async input => {
      const output = own.get(input.outpoint)
      if (output === undefined) return await this.#foreignInput(explicit, beef, input.outpoint)
      if (!output.spendable)
        throw new Error('BRC-207: an explicit p color input is reserved by another action')
      const managed = await this.#managedInput(output, originator)
      if (managed === undefined)
        throw new Error('BRC-207: an explicit p color input is not a managed token output')
      await this.#assertSupportedAsset(managed.assetId)
      if (
        !(await this.#spendable(managed.assetId, [managed])).has(managed.outpoint) &&
        !(await this.#resubmitHeld(managed.assetId, managed.role, [managed], originator)).has(
          managed.outpoint
        )
      )
        throw new Error('BRC-207: an explicit p color input is not admitted and unspent')
      explicit.managed.push(managed)
      const totals = holding(explicit.holdings, managed.assetId, emptyExplicitHolding)
      if (managed.role === 'value') totals.value += managed.amount
      else totals.authority += 1
    })
    return explicit
  }

  /** Counts a foreign token input once its overlay admits it; other foreign inputs add nothing. */
  async #foreignInput(
    explicit: ExplicitInputs,
    beef: Beef | undefined,
    outpoint: string
  ): Promise<void> {
    // A source missing from inputBEEF is resolved from the wallet and checked at signAction.
    const source = foreignSource(beef, outpoint)
    const token =
      source === undefined
        ? undefined
        : readTokenOutput(source.lockingScript, parseOutpoint(outpoint))
    if (token === undefined) return
    await this.#assertSupportedAsset(token.assetId)
    if (!(await this.#spendable(token.assetId, [source!])).has(outpoint))
      throw new Error('BRC-207: a foreign token input is not admitted and unspent in its overlay')
    const totals = holding(explicit.holdings, token.assetId, emptyExplicitHolding)
    if (token.role === 'value') {
      totals.value += token.amount
      totals.foreignValue += token.amount
    } else {
      totals.authority += 1
      totals.foreignAuthority += 1
    }
  }

  /** Classifies the requested outputs, totalling each asset's value and authority outputs. */
  async #planOutputs(
    plan: ColorPlan,
    args: CreateActionArgs,
    originator: string
  ): Promise<{ planned: PlannedOutputs; outputs: CreateActionOutput[] }> {
    const requested = args.outputs ?? []
    for (const remittance of plan.ownedOutputs) {
      if (remittance.outputIndex >= requested.length) {
        throw new Error('BRC-207: plan.ownedOutputs names a missing output')
      }
    }
    const owned = new Map(plan.ownedOutputs.map(remittance => [remittance.outputIndex, remittance]))
    const planned: PlannedOutputs = { holdings: new Map(), destinations: [] }
    const outputs: CreateActionOutput[] = []
    await eachInOrder(requested.entries(), async ([index, output]) => {
      outputs.push(
        await this.#planOutput(plan, args, index, output, owned.get(index), planned, originator)
      )
    })
    return { planned, outputs }
  }

  /** One requested output: passed through, a token destination, or a token output this wallet keeps. */
  async #planOutput(
    plan: ColorPlan,
    args: CreateActionArgs,
    index: number,
    output: CreateActionOutput,
    remittance: ColorRemittance | undefined,
    planned: PlannedOutputs,
    originator: string
  ): Promise<CreateActionOutput> {
    const token = readTokenOutput(LockingScript.fromHex(output.lockingScript), {
      txid: '00'.repeat(32),
      vout: index
    })
    if (token === undefined) {
      if (remittance !== undefined)
        throw new Error('BRC-207: plan.ownedOutputs names a non-token output')
      if (output.basket?.startsWith(`${COLOR_BASKET_NAMESPACE} `) === true) {
        throw new Error('BRC-207: a p color basket can only receive BRC-162 token outputs')
      }
      return output
    }
    if (token.deploy)
      return await this.#deployOutput(args, output, token, remittance, planned, originator)
    if (!plan.assets.includes(token.assetId))
      throw new Error('BRC-207: an output asset is missing from plan.assets')
    const totals = holding(planned.holdings, token.assetId, emptyHolding)
    if (token.role === 'value') totals.value += token.amount
    else totals.authority += 1
    if (remittance !== undefined)
      return await this.#ownedOutput(token, output, remittance, originator)
    if (output.basket !== undefined) {
      throw new Error('BRC-207: only outputs in plan.ownedOutputs may enter a p color basket')
    }
    planned.destinations.push({
      outputIndex: index,
      assetId: token.assetId,
      role: token.role,
      amount: token.amount.toString(),
      lockingScript: output.lockingScript
    })
    return output
  }

  /**
   * The action's deploy, which BRC-162 requires at output 0. An owned deploy keeps its `ISSUE`
   * key; its asset basket is assigned once the transaction ID is final.
   */
  async #deployOutput(
    args: CreateActionArgs,
    output: CreateActionOutput,
    token: TokenOutput,
    remittance: ColorRemittance | undefined,
    planned: PlannedOutputs,
    originator: string
  ): Promise<CreateActionOutput> {
    if (args.options?.randomizeOutputs !== false)
      throw new Error('BRC-207: a deploy requires options.randomizeOutputs false')
    if (output.basket !== undefined)
      throw new Error(
        "BRC-207: a deploy output's basket is assigned once its transaction is signed"
      )
    planned.deploy = { operation: deployOperation(token) }
    if (remittance === undefined) {
      planned.destinations.push({
        outputIndex: 0,
        assetId: ISSUE,
        role: token.role,
        amount: token.amount.toString(),
        lockingScript: output.lockingScript
      })
      return output
    }
    if (remittance.assetId !== ISSUE)
      throw new Error('BRC-207: a deploy output remittance must use ISSUE')
    await this.#assertOwned(token, remittance, remittance.senderIdentityKey, originator)
    // Without a p color basket the manager does not encrypt its custody, so it is encrypted here.
    return {
      ...output,
      customInstructions: await encryptMetadata(
        this.#wallet,
        custodyInstructions(custodyOf(remittance)),
        originator
      )
    }
  }

  /** A token output of the action that this wallet keeps, placed in its asset's basket. */
  async #ownedOutput(
    token: TokenOutput,
    output: CreateActionOutput,
    remittance: ColorRemittance,
    originator: string
  ): Promise<CreateActionOutput> {
    if (remittance.assetId !== token.assetId)
      throw new Error('BRC-207: an owned output remittance names another asset')
    await this.#assertOwned(token, remittance, remittance.senderIdentityKey, originator)
    const basket = assetBasket(token.assetId, token.role)
    if (output.basket !== undefined && output.basket !== basket) {
      throw new Error('BRC-207: an owned output names the wrong p color basket')
    }
    return {
      ...output,
      basket,
      customInstructions: custodyInstructions(custodyOf(remittance))
    }
  }

  /**
   * Funds each asset the plan involves, checks its operations, splits for a handoff, and returns
   * the selected inputs and token change. The user approves the funded action at signAction.
   */
  async #fund(
    reserved: Set<string>,
    plan: ColorPlan,
    planned: PlannedOutputs,
    explicit: ExplicitInputs,
    handoff: boolean,
    originator: string
  ): Promise<{
    inputs: ManagedInput[]
    changes: Array<{ assetId: string; output: CreateActionOutput }>
  }> {
    const assetIds = new Set([
      ...planned.holdings.keys(),
      ...explicit.holdings.keys(),
      ...plan.operations.flatMap(operation =>
        operation.assetId === ISSUE ? [] : [operation.assetId]
      )
    ])
    assertPlanAssets(plan, new Set([...assetIds, ...(planned.deploy === undefined ? [] : [ISSUE])]))
    if (planned.deploy !== undefined) assertOperations(plan, ISSUE, [planned.deploy.operation])
    const funding: AssetFunding[] = []
    await eachInOrder(assetIds, async assetId => {
      await this.#assertSupportedAsset(assetId)
      funding.push(
        await this.#fundAsset(
          reserved,
          plan,
          assetId,
          planned.holdings.get(assetId) ?? emptyHolding(),
          explicit.holdings.get(assetId) ?? emptyExplicitHolding(),
          originator
        )
      )
    })
    const inputs: ManagedInput[] = []
    const changes: Array<{ assetId: string; output: CreateActionOutput }> = []
    await eachInOrder(funding, async asset => {
      const value = asset.selected.filter(input => input.role === 'value')
      const needed =
        asset.outputs.value - asset.change - (explicit.holdings.get(asset.assetId)?.value ?? 0n)
      const split =
        handoff && asset.change > 0n
          ? await this.#splitExact(reserved, asset.assetId, value, needed, planned, originator)
          : undefined
      inputs.push(...(split ?? asset.selected))
      if (split === undefined && asset.change > 0n)
        changes.push({
          assetId: asset.assetId,
          output: (await this.#newManagedOutput(asset.assetId, asset.change, originator)).output
        })
    })
    return { inputs, changes }
  }

  /**
   * Selects one asset's value inputs for a transfer and authority inputs for a declared authority
   * operation, then checks the resulting operations against the plan. Value is selected, with
   * change, only when the asset's operations are a transfer without a mint or burn.
   */
  async #fundAsset(
    reserved: Set<string>,
    plan: ColorPlan,
    assetId: string,
    requested: Holding,
    explicit: ExplicitHolding,
    originator: string
  ): Promise<AssetFunding> {
    const declared = declaredOperations(plan, assetId)
    const selected: ManagedInput[] = []
    const automatic = declared.has('transfer') && !declared.has('mint') && !declared.has('burn')
    if (automatic && requested.value > explicit.value) {
      selected.push(
        ...(await this.#selectInputs(
          reserved,
          assetId,
          'value',
          requested.value - explicit.value,
          originator
        ))
      )
    }
    const authorityOperation = AUTHORITY_OPERATIONS.find(operation => declared.has(operation))
    const authorityCount =
      authorityOperation === undefined || explicit.authority > 0
        ? 0
        : authorityInputsFor(authorityOperation, requested.authority)
    if (authorityCount > 0) {
      selected.push(
        ...(await this.#selectInputs(
          reserved,
          assetId,
          'authority',
          BigInt(authorityCount),
          originator
        ))
      )
    }
    const selectedValue = sumAmounts(selected)
    const value = explicit.value + selectedValue
    // Change returns what selection adds beyond the need; excess explicit value is a burn.
    const change = selectedValue > 0n ? value - requested.value : 0n
    const inputs = { value, authority: explicit.authority + authorityCount }
    const outputs = { value: requested.value + change, authority: requested.authority }
    assertOperations(plan, assetId, requiredOperations(inputs, outputs))
    return { assetId, selected, change, outputs }
  }

  /** Replaces a handoff's value inputs with one split output of exactly `amount`, which it reserves. */
  async #splitExact(
    reserved: Set<string>,
    assetId: string,
    selected: ManagedInput[],
    amount: bigint,
    planned: PlannedOutputs,
    originator: string
  ): Promise<ManagedInput[]> {
    const exact = await this.#split(
      assetId,
      selected,
      amount,
      planned.destinations.filter(destination => destination.assetId === assetId),
      originator
    )
    this.#release(reserved, selected)
    this.#reserve(reserved, [exact])
    return [exact]
  }

  /**
   * Selects admitted, unspent outputs of one asset's value or authority basket: value outputs
   * covering `target` units, largest first, or `target` authority outputs.
   */
  async #selectInputs(
    reserved: Set<string>,
    assetId: string,
    role: TokenRole,
    target: bigint,
    originator: string
  ): Promise<ManagedInput[]> {
    const weight = (candidate: Candidate): bigint => (role === 'value' ? candidate.amount : 1n)
    const candidates = (await this.#candidates(assetId, role, originator)).sort(byAmountDescending)
    const rejected = new Set<string>()
    for (;;) {
      const chosen: Candidate[] = []
      let total = 0n
      for (const candidate of candidates) {
        if (total >= target) break
        if (rejected.has(candidate.outpoint)) continue
        chosen.push(candidate)
        total += weight(candidate)
      }
      if (total < target)
        throw new Error(
          `BRC-207: insufficient spendable ${role === 'value' ? 'balance' : 'authority'} of ${assetId}`
        )
      // Chosen outputs are held while they are checked, so a concurrent action cannot choose them.
      this.#reserve(reserved, chosen)
      // Custody is read only for chosen outputs; an unreadable record is skipped, not fatal.
      const inputs = await Promise.all(
        chosen.map(async candidate => await this.#readableInput(candidate, originator))
      )
      const unreadable = chosen.filter((_, index) => inputs[index] === undefined)
      for (const candidate of unreadable) rejected.add(candidate.outpoint)
      this.#release(reserved, unreadable)
      if (unreadable.length > 0) continue
      const selected = inputs as ManagedInput[]
      const admitted = await this.#spendable(assetId, selected)
      const unlisted = selected.filter(input => !admitted.has(input.outpoint))
      const recovered = await this.#resubmitHeld(assetId, role, unlisted, originator)
      const missing = unlisted.filter(input => !recovered.has(input.outpoint))
      if (missing.length === 0) return selected
      for (const input of missing) rejected.add(input.outpoint)
      this.#release(reserved, missing)
    }
  }

  /**
   * Resubmits the wallet's own copies of the transactions behind held outputs that the overlay
   * does not report, as BTMS does when it selects, and returns the outputs it then admits.
   */
  async #resubmitHeld(
    assetId: string,
    role: TokenRole,
    outputs: readonly SourceOutput[],
    originator: string
  ): Promise<Set<string>> {
    if (outputs.length === 0) return new Set()
    const txids = new Set(outputs.map(output => parseOutpoint(output.outpoint).txid))
    const beef = new Beef()
    for (let offset = 0; [...txids].some(txid => beef.findTxid(txid) === undefined);) {
      const page = await this.#wallet.listOutputs(
        {
          basket: assetBasket(assetId, role),
          include: 'entire transactions',
          limit: LIST_PAGE_LIMIT,
          offset
        },
        originator
      )
      if (page.BEEF !== undefined) beef.mergeBeef(page.BEEF)
      offset += page.outputs.length
      if (page.outputs.length < LIST_PAGE_LIMIT) break
    }
    await eachInOrder(txids, async txid => {
      if (beef.findTxid(txid) === undefined) return
      const atomic = beef.toBinaryAtomic(txid)
      const { assetIds, deploy } = submissionAssets(Transaction.fromAtomicBEEF(atomic))
      // A refused resubmission leaves the output unlisted; the spendability check decides.
      await this.#provider
        .submit([...(deploy ? [DISCOVERY_TOPIC] : []), ...assetIds.map(colorTopic)], atomic)
        .catch(() => undefined)
    })
    return await this.#spendable(assetId, outputs)
  }

  /** One basket's token outputs of the asset, read from their locking scripts, excluding selected ones. */
  async #candidates(assetId: string, role: TokenRole, originator: string): Promise<Candidate[]> {
    const outputs = await this.#listBasket(assetBasket(assetId, role), originator, {})
    return outputs.flatMap(output => {
      if (this.#selected.has(output.outpoint) || output.customInstructions === undefined) return []
      const source = this.#sourceOutput(output)
      const token = tryReadTokenOutput(source.lockingScript, parseOutpoint(output.outpoint))
      if (token?.assetId !== assetId || token.role !== role) return []
      return [
        { ...source, token, amount: token.amount, customInstructions: output.customInstructions }
      ]
    })
  }

  /** A chosen candidate with its custody, or undefined when its custody record is unreadable. */
  async #readableInput(
    candidate: Candidate,
    originator: string
  ): Promise<ManagedInput | undefined> {
    try {
      const { outpoint, lockingScript, satoshis, token, customInstructions } = candidate
      return await this.#custodyInput(
        { outpoint, lockingScript, satoshis, token },
        customInstructions,
        originator
      )
    } catch {
      return undefined
    }
  }

  /** A `p color` basket output as a managed token input, or undefined when it is not one. */
  async #managedInput(output: WalletOutput, originator: string): Promise<ManagedInput | undefined> {
    const source = this.#sourceOutput(output)
    const token = readTokenOutput(source.lockingScript, parseOutpoint(output.outpoint))
    if (token === undefined || output.customInstructions === undefined) return undefined
    return await this.#custodyInput({ ...source, token }, output.customInstructions, originator)
  }

  /** Decrypts and parses an output's custody tuple; undefined when it names another asset. */
  async #custodyInput(
    output: SourceOutput & { token: TokenOutput },
    customInstructions: string,
    originator: string
  ): Promise<ManagedInput | undefined> {
    const custody = parseCustody(
      await maybeDecryptMetadata(this.#wallet, customInstructions, originator),
      undefined,
      'managed output customInstructions'
    )
    if (!selectsAsset(custody.assetId, output.token)) return undefined
    const { token, ...source } = output
    return { ...source, assetId: token.assetId, role: token.role, amount: token.amount, custody }
  }

  /**
   * Before a handoff, splits the selected inputs into an output of exactly `amount`
   * and token change, broadcast and submitted with the user's approval of its fee.
   */
  async #split(
    assetId: string,
    selected: ManagedInput[],
    amount: bigint,
    destinations: unknown[],
    originator: string
  ): Promise<ManagedInput> {
    const change = sumAmounts(selected) - amount
    const exact = await this.#newManagedOutput(assetId, amount, originator)
    const rest = await this.#newManagedOutput(assetId, change, originator)
    // The split goes to the underlying wallet directly, so its custody is encrypted here.
    const outputs = await Promise.all(
      [exact.output, rest.output].map(async output => ({
        ...output,
        customInstructions: await encryptMetadata(
          this.#wallet,
          output.customInstructions as string,
          originator
        )
      }))
    )
    const created = await this.#wallet.createAction(
      {
        description: 'Split tokens for a handoff',
        labels: ColorPlan.toLabels({
          version: 1,
          assets: [assetId],
          ownedOutputs: [
            { outputIndex: 0, ...exact.custody },
            { outputIndex: 1, ...rest.custody }
          ],
          operations: [{ assetId, operation: 'transfer' }],
          inputPositions: [],
          changePositions: [],
          sighashTypes: []
        }),
        inputs: tokenInputs(selected),
        outputs,
        options: { randomizeOutputs: false, signAndProcess: false }
      },
      originator
    )
    const signable = created.signableTransaction
    if (signable == null) throw new Error('BRC-207: the split action was not returned for signing')
    const template = Transaction.fromAtomicBEEF(signable.tx)
    let fee: number
    try {
      fee = template.getFee()
    } catch (error) {
      await this.#wallet.abortAction({ reference: signable.reference }, originator)
      throw error
    }
    const approved = await this.#requestTokenAccess(
      originator,
      JSON.stringify({
        type: 'color_split',
        assetId,
        amount: amount.toString(),
        change: change.toString(),
        destinations,
        fee
      })
    )
    if (approved !== true) {
      await this.#wallet.abortAction({ reference: signable.reference }, originator)
      throw new Error('BRC-207: the user declined the token split')
    }
    let signed: SignActionResult
    try {
      const spends = await this.#signInputs(
        template,
        selected,
        new Map(),
        originator,
        'BRC-207: the split transaction omits a token input'
      )
      signed = await this.#wallet.signAction({ reference: signable.reference, spends }, originator)
    } catch (error) {
      await this.#wallet
        .abortAction({ reference: signable.reference }, originator)
        .catch(() => undefined)
      throw error
    }
    if (signed.txid === undefined || signed.tx === undefined) {
      throw new Error('BRC-207: the split transaction was not returned')
    }
    await this.#submit([assetId], signed.tx)
    return {
      outpoint: outpointString(signed.txid, 0),
      lockingScript: LockingScript.fromHex(exact.output.lockingScript),
      satoshis: TOKEN_CARRIER_SATOSHIS,
      assetId,
      role: 'value',
      amount,
      custody: exact.custody
    }
  }

  /** A fresh wallet-owned value output in the asset's basket, keyed to this wallet. */
  async #newManagedOutput(
    assetId: string,
    amount: bigint,
    originator: string
  ): Promise<{ output: CreateActionOutput; custody: Custody }> {
    const custody: Custody = {
      assetId,
      derivationPrefix: toBase64(Random(16)),
      derivationSuffix: toBase64(Random(16)),
      senderIdentityKey: await this.#identity()
    }
    const publicKey = await this.#publicKey(custody, custody.senderIdentityKey, originator)
    return {
      custody,
      output: {
        lockingScript: new OneColor()
          .lock(assetId, amount, hash160(toArray(publicKey, 'hex')))
          .toHex(),
        satoshis: TOKEN_CARRIER_SATOSHIS,
        basket: assetBasket(assetId, 'value'),
        customInstructions: custodyInstructions(custody),
        outputDescription: 'BRC-207 token change'
      }
    }
  }

  /**
   * Checks the funded action against its plan, rechecks every token input's spendability, asks
   * the user to approve the final layout, and signs the inputs that spend this wallet's
   * `p color` outputs.
   */
  async #signAction(
    args: SignActionArgs,
    action: PermissionsModuleAction | undefined,
    originator: string
  ): Promise<SignActionArgs> {
    if (action === undefined) return args
    const createArgs = action.createArgs
    const plan = ColorPlan.fromLabels(createArgs?.labels)
    if (createArgs === undefined || plan === undefined)
      throw new Error("BRC-207: signAction needs the action's p color createAction arguments")
    const tx = action.transaction
    const tokens = transactionTokens(tx)
    assertTransactionOperations(plan, tokens)
    const satoshiChange = plan.changePositions.find(position => position.assetId === null)
    if (satoshiChange !== undefined && satoshiChange.index >= tx.outputs.length)
      throw new Error('BRC-207: the funded action has no satoshi change for plan.changePositions')
    const managed = await this.#actionInputs(tx, originator)
    const scopes = sighashScopes(plan, new Set(managed.map(input => input.outpoint)))
    await eachInOrder(new Set(tokens.consumed.map(input => input.assetId)), async assetId => {
      const assetInputs = tokens.consumed.filter(input => input.assetId === assetId)
      const admitted = await this.#spendable(assetId, assetInputs)
      if (assetInputs.some(input => !admitted.has(input.outpoint)))
        throw new Error(`BRC-207: a ${assetId} input is no longer spendable`)
    })
    await this.#approve(originator, actionConsent(plan, createArgs, tx, tokens, managed, scopes))
    return {
      ...args,
      spends: {
        ...args.spends,
        ...(await this.#signInputs(
          tx,
          managed,
          scopes,
          originator,
          'BRC-207: the signable transaction omits a token input'
        ))
      }
    }
  }

  /** The transaction's inputs that spend this wallet's `p color` outputs, with their stored custody. */
  async #actionInputs(tx: Transaction, originator: string): Promise<ManagedInput[]> {
    const outpoints = new Set(tx.inputs.map(input => inputOutpoint(input)))
    // The action's own inputs are reserved by it, which this listing includes.
    const listed = await this.#wallet.listOutputs(
      {
        basket: toolbox.specOpBasketPrefixOutputs,
        tags: [COLOR_BASKET_NAMESPACE],
        include: 'locking scripts',
        includeCustomInstructions: true
      },
      originator
    )
    const managed = await Promise.all(
      listed.outputs
        .filter(output => outpoints.has(output.outpoint))
        .map(async output => await this.#managedInput(output, originator))
    )
    return managed.filter(input => input !== undefined)
  }

  /**
   * Submits a signed token transaction to the topic of every asset among its inputs and outputs,
   * and a deploy to the discovery topic.
   */
  async #submitSigned(result: SignActionResult, template: Transaction): Promise<void> {
    if (result?.tx === undefined) return
    const { assetIds, deploy } = submissionAssets(Transaction.fromAtomicBEEF(result.tx), template)
    if (assetIds.length > 0 || deploy) await this.#submit(assetIds, result.tx, deploy)
  }

  /** Submits a transaction, trying again up to `SUBMIT_ATTEMPTS` times before reporting the failure. */
  async #submit(assetIds: string[], beef: AtomicBEEF, deploy = false): Promise<void> {
    let failure: unknown
    for (let attempt = 0; attempt < SUBMIT_ATTEMPTS; attempt++) {
      try {
        return await this.#submitOnce(assetIds, beef, deploy)
      } catch (error) {
        failure = error
      }
    }
    throw failure
  }

  /**
   * Submits to each asset topic, and a deploy to the discovery topic, and fails unless every
   * token output is admitted. A deploy's own asset must then be admitted by its asset overlay.
   */
  async #submitOnce(assetIds: string[], beef: AtomicBEEF, deploy: boolean): Promise<void> {
    const tx = Transaction.fromAtomicBEEF(beef)
    const txid = tx.id('hex')
    const topics = [...(deploy ? [DISCOVERY_TOPIC] : []), ...assetIds.map(colorTopic)]
    const steak = await this.#provider.submit(topics, Array.from(beef))
    for (const assetId of assetIds) {
      const admitted = steak?.[colorTopic(assetId)]?.outputsToAdmit ?? []
      const missing = tx.outputs
        .map((output, vout) => ({
          token: readTokenOutput(output.lockingScript, { txid, vout }),
          vout
        }))
        .filter(({ token, vout }) => token?.assetId === assetId && !admitted.includes(vout))
        .map(({ vout }) => vout)
      if (missing.length > 0) {
        throw new Error(
          `BRC-207: ${colorTopic(assetId)} did not admit outputs ${missing.join(', ')} of ${txid}; ` +
            'the transaction was processed and its overlay state needs reconciliation'
        )
      }
    }
    if (!deploy) return
    if (!(steak?.[DISCOVERY_TOPIC]?.outputsToAdmit ?? []).includes(0))
      throw new Error(`BRC-207: ${DISCOVERY_TOPIC} did not admit the deploy of ${txid}`)
    const output = tx.outputs[0]
    const outpoint = outpointString(txid, 0)
    const admitted = await this.#spendable(`${txid}_0`, [
      { outpoint, lockingScript: output.lockingScript, satoshis: output.satoshis ?? 0 }
    ])
    if (!admitted.has(outpoint))
      throw new Error(
        `BRC-207: deployment ${txid} was processed; its per-asset admission remains pending`
      )
  }

  /* ----------------------------------------------------------------------
   * App-built transactions (createSignature)
   * ---------------------------------------------------------------------- */

  /** Signs one managed input of an app-built transaction described by a 207 signature envelope. */
  async #createSignature(
    args: CreateSignatureArgs,
    originator: string,
    next: PermissionsModuleNext
  ): Promise<unknown> {
    if (args.hashToDirectlySign !== undefined) {
      throw new Error(
        'BRC-207: p color signatures take a signature envelope, not hashToDirectlySign'
      )
    }
    const selector = this.#parseKeyArgs(args)
    if (args.data === undefined || args.data.length > MAX_ENVELOPE_BYTES) {
      throw new Error('BRC-207: the signature envelope is missing or exceeds 16 MiB')
    }
    const envelope = jsonObject(
      parseStrictJsonBytes(args.data, 'signature envelope'),
      'signature envelope'
    )
    exactMembers(
      envelope,
      ['version', 'tx', 'inputIndex', 'sighashType', 'ownedOutputs'],
      ['profileData'],
      'signature envelope'
    )
    if (envelope.version !== 1) throw new Error('BRC-207: signature envelope version must be 1')
    if (
      Object.keys(parseProfileData(envelope.profileData, 'signature envelope profileData') ?? {})
        .length > 0
    ) {
      throw new Error(
        'BRC-207: signature envelope profileData names a profile the asset does not require'
      )
    }
    const tx = Transaction.fromAtomicBEEF(
      jsonByteArray(envelope.tx, 'signature envelope tx', MAX_ENVELOPE_BYTES)
    )
    const inputIndex = jsonUint32(envelope.inputIndex, 'signature envelope inputIndex')
    const sighashType = jsonUint32(envelope.sighashType, 'signature envelope sighashType')
    if (sighashType > 255) throw new Error('BRC-207: sighashType must be in 0..255')
    const ownedOutputs = parseRemittances(envelope.ownedOutputs, 'signature envelope ownedOutputs')
    const input = tx.inputs[inputIndex]
    const sourceTransaction = input?.sourceTransaction
    const source = sourceTransaction?.outputs[input.sourceOutputIndex]
    if (sourceTransaction === undefined || source?.satoshis === undefined) {
      throw new Error('BRC-207: the envelope must carry the signed input source transaction')
    }
    const sourceTXID = sourceTransaction.id('hex')
    const token = readTokenOutput(source.lockingScript, {
      txid: sourceTXID,
      vout: input.sourceOutputIndex
    })
    if (token === undefined || !selectsAsset(selector.assetId, token)) {
      throw new Error(
        'BRC-207: the protocol asset selector does not match the signed source output'
      )
    }
    await this.#assertOwned(token, selector, args.counterparty ?? 'anyone', originator)
    await this.#assertSupportedAsset(token.assetId)
    await Promise.all(
      ownedOutputs.map(async remittance => {
        const output = tx.outputs[remittance.outputIndex]
        const owned =
          output === undefined
            ? undefined
            : readTokenOutput(output.lockingScript, {
                txid: '00'.repeat(32),
                vout: remittance.outputIndex
              })
        if (owned === undefined || owned.deploy || remittance.assetId !== owned.assetId) {
          throw new Error('BRC-207: an envelope remittance does not match its output')
        }
        await this.#assertOwned(owned, remittance, remittance.senderIdentityKey, originator)
      })
    )
    const outpoint = outpointString(sourceTXID, input.sourceOutputIndex)
    const signed = { outpoint, lockingScript: source.lockingScript, satoshis: source.satoshis }
    const admitted = await this.#spendable(token.assetId, [signed])
    if (!admitted.has(outpoint))
      throw new Error('BRC-207: the signed input is not admitted and unspent in its overlay')
    const preimage = this.#preimage(tx, inputIndex, signed, sighashType)
    await this.#approve(originator, {
      type: 'color_signature',
      assetId: token.assetId,
      role: token.role,
      amount: token.amount.toString(),
      outpoint,
      inputIndex,
      sighashType,
      outputs: tx.outputs.length
    })
    return await next({
      protocolID: args.protocolID,
      keyID: args.keyID,
      counterparty: args.counterparty,
      privileged: args.privileged,
      privilegedReason: args.privilegedReason,
      seekPermission: args.seekPermission,
      hashToDirectlySign: hash256(preimage)
    })
  }

  /* ----------------------------------------------------------------------
   * Read views
   * ---------------------------------------------------------------------- */

  async #listOutputs(
    args: ListOutputsArgs,
    originator: string,
    next: PermissionsModuleNext
  ): Promise<unknown> {
    if (args.basket === ASSETS_SELECTOR) {
      await this.#authorizeRead(originator)
      return await this.#inventory(args, originator)
    }
    const balance = parseBalanceSelector(args.basket)
    if (balance !== undefined) {
      await this.#authorizeRead(originator)
      return await this.#balance(balance.assetId, balance.role, args, originator)
    }
    if (parseAssetBasket(args.basket) !== undefined) {
      await this.#authorizeRead(originator)
      return await next(args)
    }
    throw new Error('BRC-207: unknown p color basket selector')
  }

  /** `p color balance`: exact sum of available token units, or count of available authorities. */
  async #balance(
    assetId: string,
    role: TokenRole,
    args: ListOutputsArgs,
    originator: string
  ): Promise<ListOutputsResult> {
    await this.#assertSupportedAsset(assetId)
    const held = (await this.#listBasket(assetBasket(assetId, role), originator, args))
      .map(output => {
        const source = this.#sourceOutput(output)
        return {
          ...source,
          token: readTokenOutput(source.lockingScript, parseOutpoint(output.outpoint))
        }
      })
      .filter(output => output.token?.assetId === assetId && output.token.role === role)
    const admitted = held.length > 0 ? await this.#spendable(assetId, held) : new Set<string>()
    const total = held
      .filter(output => admitted.has(output.outpoint))
      .reduce((sum, output) => sum + (role === 'value' ? output.token!.amount : 1n), 0n)
    return { totalOutputs: total.toString(), outputs: [] }
  }

  /** `p color assets`: every held token output across all per-asset baskets, with its state. */
  async #inventory(args: ListOutputsArgs, originator: string): Promise<ListOutputsResult> {
    const entireTransactions = args.include === 'entire transactions'
    const listed = await this.#wallet.listOutputs(
      {
        basket: toolbox.specOpBasketPrefixOutputs,
        tags: [COLOR_BASKET_NAMESPACE],
        include: entireTransactions ? 'entire transactions' : 'locking scripts',
        includeCustomInstructions: args.includeCustomInstructions,
        includeTags: true,
        includeLabels: args.includeLabels
      },
      originator
    )
    const beef =
      entireTransactions && listed.BEEF !== undefined ? Beef.fromBinary(listed.BEEF) : undefined
    const records = inventoryRecords(listed.outputs, beef)
    const admitted = await this.#admittedByAsset(records)
    const views = records
      .flatMap(record => {
        const assetAdmitted = admitted.get(record.assetId)
        return assetAdmitted === undefined ? [] : [inventoryView(record, assetAdmitted)]
      })
      .filter(view => matchesTags(view.tags, args.tags ?? [], args.tagQueryMode))
    const limit = args.limit ?? 10
    const offset = args.offset ?? 0
    const ordered = offset < 0 ? [...views].reverse() : views
    const start = offset < 0 ? -offset - 1 : offset
    const page = ordered.slice(start, start + limit)
    // Only the returned page is decrypted and carried in the BEEF.
    const result: ListOutputsResult = {
      totalOutputs: views.length,
      outputs: await Promise.all(
        page.map(async view => await this.#inventoryOutput(view, args, originator))
      )
    }
    if (beef !== undefined) result.BEEF = pageBeef(beef, page)
    return result
  }

  /** The outputs each supported asset's overlay admits; unsupported assets are absent. */
  async #admittedByAsset(records: InventoryRecord[]): Promise<Map<string, Set<string>>> {
    const assetIds = [...new Set(records.map(record => record.assetId))]
    const admitted = await Promise.all(
      assetIds.map(async assetId => await this.#admittedFor(assetId, records))
    )
    return new Map(
      assetIds.flatMap((assetId, index) => {
        const set = admitted[index]
        return set === undefined ? [] : [[assetId, set] as const]
      })
    )
  }

  async #admittedFor(
    assetId: string,
    records: InventoryRecord[]
  ): Promise<Set<string> | undefined> {
    const { txid, vout } = parseAssetId(assetId)
    // The wallet's own deploy is authenticated by its own bytes before any overlay admits it.
    const deploy = records.find(record => record.output.outpoint === outpointString(txid, vout))
    try {
      if (deploy === undefined || !isDeployOutput(deploy.source.lockingScript, { txid, vout }))
        await this.#assertSupportedAsset(assetId)
    } catch {
      // An unsupported or unauthenticated asset is not a validated holding.
      return undefined
    }
    const unreserved = records.filter(
      record => record.assetId === assetId && record.output.spendable
    )
    if (unreserved.length === 0) return new Set()
    return await this.#spendable(
      assetId,
      unreserved.map(record => record.source)
    )
  }

  /** One inventory record as a BRC-100 output with the fields the caller asked for. */
  async #inventoryOutput(
    view: InventoryView,
    args: ListOutputsArgs,
    originator: string
  ): Promise<WalletOutput> {
    const { record, state, tags } = view
    const output: WalletOutput = {
      satoshis: record.output.satoshis,
      spendable: state === 'available',
      outpoint: record.output.outpoint
    }
    if (args.include === 'locking scripts')
      output.lockingScript = record.source.lockingScript.toHex()
    if (args.includeCustomInstructions === true && record.output.customInstructions !== undefined) {
      output.customInstructions = await maybeDecryptMetadata(
        this.#wallet,
        record.output.customInstructions,
        originator
      )
    }
    if (args.includeTags === true) output.tags = tags
    if (args.includeLabels === true) output.labels = record.output.labels
    return output
  }

  /* ----------------------------------------------------------------------
   * Shared helpers
   * ---------------------------------------------------------------------- */

  /** Validates a `p color` key reference and returns its asset selector and remittance strings. */
  #parseKeyArgs(args: {
    protocolID?: unknown
    keyID?: unknown
  }): ReturnType<typeof parseColorProtocolID> {
    if (args.keyID !== COLOR_KEY_ID) throw new Error('BRC-207: p color keys use keyID "color"')
    return parseColorProtocolID(args.protocolID)
  }

  async #identity(): Promise<string> {
    this.#identityKey ??= this.#wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => publicKey)
    return await this.#identityKey
  }

  async #publicKey(
    custody: Pick<Custody, 'assetId' | 'derivationPrefix' | 'derivationSuffix'>,
    counterparty: WalletCounterparty,
    originator: string
  ): Promise<string> {
    const { publicKey } = await this.#wallet.getPublicKey(
      {
        protocolID: colorProtocolID(
          custody.assetId,
          custody.derivationPrefix,
          custody.derivationSuffix
        ),
        keyID: COLOR_KEY_ID,
        counterparty,
        forSelf: true
      },
      originator
    )
    return publicKey
  }

  /** Fails unless the output is a P2PKH remainder locked to this wallet's derived `p color` key. */
  async #assertOwned(
    token: TokenOutput,
    custody: Pick<Custody, 'assetId' | 'derivationPrefix' | 'derivationSuffix'>,
    counterparty: WalletCounterparty,
    originator: string
  ): Promise<void> {
    if (token.pubKeyHash === undefined)
      throw new Error('BRC-207: a managed token output must have a P2PKH remainder')
    const publicKey = await this.#publicKey(custody, counterparty, originator)
    if (toHex(hash160(toArray(publicKey, 'hex'))) !== toHex(token.pubKeyHash)) {
      throw new Error("BRC-207: the token output is not locked to this wallet's p color key")
    }
  }

  /**
   * Authenticates the asset's deploy through the overlay and fails when it declares
   * required processing profiles. The deploy bytes hash to the asset ID, so no SPV is needed.
   */
  async #assertSupportedAsset(assetId: string): Promise<void> {
    let check = this.#supportedAssets.get(assetId)
    if (check === undefined) {
      check = (async () => {
        const { txid, vout } = parseAssetId(assetId)
        const outpoint = outpointString(txid, vout)
        const deploy = readOutputList(await this.#provider.admission(assetId, [outpoint]), [
          outpoint
        ]).get(outpoint)
        if (deploy === undefined)
          throw new Error(`BRC-207: the overlay has no admitted deploy for ${assetId}`)
        if (!isDeployOutput(deploy.lockingScript, { txid, vout })) {
          throw new Error(`BRC-207: ${assetId} is not a token deploy`)
        }
      })()
      this.#supportedAssets.set(assetId, check)
      check.catch(() => this.#supportedAssets.delete(assetId))
    }
    await check
  }

  /** The queried outputs the overlay reports admitted and unspent, matched to their source bytes. */
  async #spendable(assetId: string, outputs: readonly SourceOutput[]): Promise<Set<string>> {
    return await this.#listed('spendability', assetId, outputs)
  }

  /** The queried outputs a `color-spendability` or `color-admission` answer lists, matched to their source bytes. */
  async #listed(
    query: 'spendability' | 'admission',
    assetId: string,
    outputs: readonly SourceOutput[]
  ): Promise<Set<string>> {
    const outpoints = outputs.map(output => output.outpoint)
    const listed = readOutputList(await this.#provider[query](assetId, outpoints), outpoints)
    for (const output of outputs) {
      const answer = listed.get(output.outpoint)
      if (
        answer !== undefined &&
        (answer.satoshis !== output.satoshis ||
          answer.lockingScript.toHex() !== output.lockingScript.toHex())
      ) {
        throw new Error(
          `BRC-207: the overlay answer for ${output.outpoint} does not match its source output`
        )
      }
    }
    return new Set(listed.keys())
  }

  /** All spendable outputs of one basket, with locking scripts and custom instructions. */
  async #listBasket(
    basket: string,
    originator: string,
    filter: Pick<ListOutputsArgs, 'tags' | 'tagQueryMode'>
  ): Promise<WalletOutput[]> {
    const outputs: WalletOutput[] = []
    for (;;) {
      const page = await this.#wallet.listOutputs(
        {
          basket,
          tags: filter.tags,
          tagQueryMode: filter.tagQueryMode,
          include: 'locking scripts',
          includeCustomInstructions: true,
          limit: LIST_PAGE_LIMIT,
          offset: outputs.length
        },
        originator
      )
      outputs.push(...page.outputs)
      if (page.outputs.length < LIST_PAGE_LIMIT) return outputs
    }
  }

  #sourceOutput(output: WalletOutput): SourceOutput {
    if (output.lockingScript === undefined)
      throw new Error('BRC-207: the wallet omitted a locking script')
    return {
      outpoint: output.outpoint,
      lockingScript: LockingScript.fromHex(output.lockingScript),
      satoshis: output.satoshis
    }
  }

  #preimage(tx: Transaction, inputIndex: number, source: SourceOutput, scope: number): number[] {
    if ((scope & 0x1f) === TransactionSignature.SIGHASH_SINGLE && inputIndex >= tx.outputs.length) {
      throw new Error('BRC-207: SIGHASH_SINGLE requires an output at the signed input index')
    }
    const { txid, vout } = parseOutpoint(source.outpoint)
    return TransactionSignature.format({
      sourceTXID: txid,
      sourceOutputIndex: vout,
      sourceSatoshis: source.satoshis,
      transactionVersion: tx.version,
      otherInputs: tx.inputs.filter((_, index) => index !== inputIndex),
      allInputs: tx.inputs,
      outputs: tx.outputs,
      inputIndex,
      subscript: source.lockingScript,
      inputSequence: tx.inputs[inputIndex].sequence ?? 0xffffffff,
      lockTime: tx.lockTime,
      scope
    })
  }

  /** Unlocking scripts for this module's inputs of `template`, keyed by input index. */
  async #signInputs(
    template: Transaction,
    inputs: readonly ManagedInput[],
    scopes: ReadonlyMap<string, number>,
    originator: string,
    missing: string
  ): Promise<Record<number, { unlockingScript: string }>> {
    const indexed = inputs.map(input => {
      const index = template.inputs.findIndex(
        candidate => inputOutpoint(candidate) === input.outpoint
      )
      if (index < 0) throw new Error(missing)
      return { index, input }
    })
    const scripts = await Promise.all(
      indexed.map(
        async ({ index, input }) =>
          await this.#unlock(
            template,
            index,
            input,
            scopes.get(input.outpoint) ?? DEFAULT_SIGHASH,
            originator
          )
      )
    )
    return Object.fromEntries(
      indexed.map(({ index }, position) => [index, { unlockingScript: scripts[position] }])
    )
  }

  /** P2PKH unlocking script for a managed input, signed with its `p color` key. */
  async #unlock(
    tx: Transaction,
    inputIndex: number,
    input: ManagedInput,
    scope: number,
    originator: string
  ): Promise<string> {
    const protocolID = colorProtocolID(
      input.custody.assetId,
      input.custody.derivationPrefix,
      input.custody.derivationSuffix
    )
    const counterparty = input.custody.senderIdentityKey
    const { signature } = await this.#wallet.createSignature(
      {
        protocolID,
        keyID: COLOR_KEY_ID,
        counterparty,
        hashToDirectlySign: hash256(this.#preimage(tx, inputIndex, input, scope))
      },
      originator
    )
    const der = Signature.fromDER(signature)
    const checksig = new TransactionSignature(der.r, der.s, scope).toChecksigFormat()
    const publicKey = toArray(await this.#publicKey(input.custody, counterparty, originator), 'hex')
    return new UnlockingScript([
      { op: checksig.length, data: checksig },
      { op: publicKey.length, data: publicKey }
    ]).toHex()
  }

  async #approve(originator: string, request: Record<string, unknown>): Promise<void> {
    const approved = await this.#requestTokenAccess(originator, JSON.stringify(request))
    if (approved !== true)
      throw new Error(`BRC-207: the user declined the ${String(request.type)} request`)
  }

  /** Every `p color` read asks the host; the host decides whether an existing grant covers it. */
  async #authorizeRead(originator: string): Promise<void> {
    await this.#approve(originator, { type: 'color_access' })
  }
}
