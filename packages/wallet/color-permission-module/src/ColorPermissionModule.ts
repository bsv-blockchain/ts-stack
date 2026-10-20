import {
  LockingScript,
  Signature,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  type AtomicBEEF,
  type BasketInsertion,
  type BEEF,
  type CreateActionArgs,
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
  parseProfileData,
  parseRemittances,
  parseTokenProofs,
  type ColorRemittance
} from './ColorPlan.js'
import {
  ASSETS_SELECTOR,
  assetBasket,
  COLOR_BASKET_NAMESPACE,
  COLOR_KEY_ID,
  colorProtocolID,
  colorTopic,
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

/** A selection only needs to outlive the createAction that reserves its inputs in storage. */
const UNLOCKING_SCRIPT_LENGTH = 108
const TOKEN_CARRIER_SATOSHIS = 1
const DEFAULT_SIGHASH = TransactionSignature.SIGHASH_ALL | TransactionSignature.SIGHASH_FORKID
const MAX_ENVELOPE_BYTES = 16 * 1024 * 1024
const MAX_RECEIPT_INSTRUCTION_BYTES = 1000
const LIST_PAGE_LIMIT = 10_000
const NOSEND_EXPIRY_LABEL_PREFIX = 'p nosend expiry '
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

/**
 * Rejects a transaction that may not be consensus-final. Without the chain context a
 * lock time is judged against, any nonzero lock time with a non-final sequence fails.
 */
function assertFinal(tx: Transaction): void {
  if (tx.lockTime !== 0 && tx.inputs.some(input => (input.sequence ?? 0xffffffff) !== 0xffffffff)) {
    throw new Error('BRC-207: a non-final transaction cannot be internalized')
  }
}

/** A send's per-asset totals and the token outputs that leave the wallet. */
interface PlannedSends {
  required: Map<string, bigint>
  destinations: Array<{
    outputIndex: number
    assetId: string
    amount: string
    lockingScript: string
  }>
}

/** Plan and action features this module version does not implement. */
function assertPlanSupported(plan: ColorPlan, args: CreateActionArgs): void {
  if ((args.inputs ?? []).length > 0) {
    throw new Error(
      'BRC-207: explicit inputs are not supported with a p color plan; use createSignature'
    )
  }
  if (
    plan.inputPositions.length > 0 ||
    plan.changePositions.length > 0 ||
    plan.sighashTypes.length > 0 ||
    (plan.tokenProofs ?? []).length > 0 ||
    Object.keys(plan.profileData ?? {}).length > 0
  ) {
    throw new Error(
      'BRC-207: plan positions, sighash overrides, token proofs and profile data are not supported'
    )
  }
}

/** The plan names exactly the assets the outputs move, with one transfer operation each. */
function assertPlanAssets(plan: ColorPlan, required: ReadonlyMap<string, bigint>): void {
  for (const assetId of plan.assets) {
    if (!required.has(assetId))
      throw new Error('BRC-207: plan.assets names an asset the action does not use')
  }
  const declared = new Set(
    plan.operations.map(operation => `${operation.assetId} ${operation.operation}`)
  )
  if (
    declared.size !== plan.operations.length ||
    declared.size !== required.size ||
    [...required.keys()].some(assetId => !declared.has(`${assetId} transfer`))
  ) {
    throw new Error('BRC-207: plan.operations must declare exactly one transfer per asset')
  }
}

/** Largest amount first. */
function byAmountDescending(a: { amount: bigint }, b: { amount: bigint }): number {
  if (a.amount === b.amount) return 0
  return a.amount > b.amount ? -1 : 1
}

interface InventoryRecord {
  output: WalletOutput
  assetId: string
  state?: InventoryState
  source: SourceOutput
}

interface InventoryView {
  record: InventoryRecord
  state: InventoryState
  tags: string[]
}

/** The token outputs of a namespace listing; reserved outputs are already classified. */
function inventoryRecords(outputs: WalletOutput[], beef: BEEF | undefined): InventoryRecord[] {
  const records: InventoryRecord[] = []
  for (const output of outputs) {
    const outpoint = parseOutpoint(output.outpoint)
    const lockingScript =
      beef === undefined
        ? LockingScript.fromHex(output.lockingScript ?? '')
        : Transaction.fromBEEF(beef, outpoint.txid).outputs[outpoint.vout].lockingScript
    const token = tryReadTokenOutput(lockingScript, outpoint)
    if (token === undefined) continue
    records.push({
      output,
      assetId: token.assetId,
      state: output.spendable ? undefined : 'reserved',
      source: { outpoint: output.outpoint, lockingScript, satoshis: output.satoshis }
    })
  }
  return records
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

/** A classified record with its stored tags and the computed state tag in place of any stored one. */
function inventoryView(record: InventoryRecord): InventoryView {
  const state = record.state as InventoryState
  const tags = [
    ...(record.output.tags ?? []).filter(tag => !tag.startsWith(STATE_TAG_PREFIX)),
    `${STATE_TAG_PREFIX}${state}`
  ]
  return { record, state, tags }
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
      case 'internalizeAction':
        await this.#internalizeAction(req.args as InternalizeActionArgs, req.originator)
        return { args: req.args }
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
    // A noSend action is a handoff: its receiver submits it.
    if (context.method === 'signAction' && context.action?.noSend === false) {
      await this.#submitSigned(res as SignActionResult)
    }
    return res
  }

  /* ----------------------------------------------------------------------
   * Receive
   * ---------------------------------------------------------------------- */

  /** Verifies every `p color` receipt; the caller must already have submitted the transaction. */
  async #internalizeAction(args: InternalizeActionArgs, originator: string): Promise<void> {
    if ((args.labels ?? []).some(label => label.startsWith(`${COLOR_BASKET_NAMESPACE} `))) {
      throw new Error('BRC-207: p color labels have no meaning in internalizeAction')
    }
    const tx = Transaction.fromAtomicBEEF(args.tx)
    assertFinal(tx)
    const receipts = args.outputs.flatMap(output => {
      const remittance = output.insertionRemittance
      return output.protocol === 'basket insertion' &&
        remittance?.basket.startsWith(`${COLOR_BASKET_NAMESPACE} `) === true
        ? [{ outputIndex: output.outputIndex, remittance }]
        : []
    })
    await eachInOrder(receipts, async ({ outputIndex, remittance }) => {
      await this.#verifyReceipt(tx, outputIndex, remittance, originator)
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

  /** Adds selected token inputs and per-asset change to a planned token send. */
  async #createAction(args: CreateActionArgs, originator: string): Promise<CreateActionArgs> {
    const labels = args.labels ?? []
    const plan = ColorPlan.fromLabels(labels)
    if (plan === undefined)
      throw new Error('BRC-207: a p color createAction requires a p color plan')
    assertPlanSupported(plan, args)
    const { sends, outputs } = await this.#planOutputs(plan, args.outputs ?? [], originator)
    assertPlanAssets(plan, sends.required)
    const handoff = labels.some(label => label.startsWith(NOSEND_EXPIRY_LABEL_PREFIX))
    // Storage locks the inputs when the wallet creates the action; until then they stay selected.
    const reserved = new Set<string>()
    try {
      const { inputs, changeOutputs } = await this.#fund(reserved, sends, handoff, originator)
      return {
        ...args,
        inputs: inputs.map(input => ({
          outpoint: input.outpoint,
          unlockingScriptLength: UNLOCKING_SCRIPT_LENGTH,
          inputDescription: 'BRC-207 token input'
        })),
        outputs: [...outputs, ...changeOutputs]
      }
    } finally {
      for (const outpoint of reserved) this.#selected.delete(outpoint)
    }
  }

  #reserve(reserved: Set<string>, inputs: readonly ManagedInput[]): void {
    for (const input of inputs) {
      this.#selected.add(input.outpoint)
      reserved.add(input.outpoint)
    }
  }

  #release(reserved: Set<string>, inputs: readonly ManagedInput[]): void {
    for (const input of inputs) {
      this.#selected.delete(input.outpoint)
      reserved.delete(input.outpoint)
    }
  }

  /** Classifies the requested outputs, totalling each asset the send moves. */
  async #planOutputs(
    plan: ColorPlan,
    requestedOutputs: CreateActionOutput[],
    originator: string
  ): Promise<{ sends: PlannedSends; outputs: CreateActionOutput[] }> {
    for (const remittance of plan.ownedOutputs) {
      if (remittance.outputIndex >= requestedOutputs.length) {
        throw new Error('BRC-207: plan.ownedOutputs names a missing output')
      }
    }
    const owned = new Map(plan.ownedOutputs.map(remittance => [remittance.outputIndex, remittance]))
    const sends: PlannedSends = { required: new Map(), destinations: [] }
    const outputs: CreateActionOutput[] = []
    await eachInOrder(requestedOutputs.entries(), async ([index, output]) => {
      outputs.push(await this.#planOutput(plan, index, output, owned.get(index), sends, originator))
    })
    return { sends, outputs }
  }

  /** One requested output: passed through, a token destination, or a token output this wallet keeps. */
  async #planOutput(
    plan: ColorPlan,
    index: number,
    output: CreateActionOutput,
    remittance: ColorRemittance | undefined,
    sends: PlannedSends,
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
    if (token.deploy) throw new Error('BRC-207: issuance is not supported by this module version')
    if (token.role !== 'value')
      throw new Error('BRC-207: authority operations are not supported by this module version')
    if (!plan.assets.includes(token.assetId))
      throw new Error('BRC-207: an output asset is missing from plan.assets')
    sends.required.set(token.assetId, (sends.required.get(token.assetId) ?? 0n) + token.amount)
    if (remittance !== undefined)
      return await this.#ownedOutput(token, output, remittance, originator)
    if (output.basket !== undefined) {
      throw new Error('BRC-207: only outputs in plan.ownedOutputs may enter a p color basket')
    }
    sends.destinations.push({
      outputIndex: index,
      assetId: token.assetId,
      amount: token.amount.toString(),
      lockingScript: output.lockingScript
    })
    return output
  }

  /** A token output of the send that this wallet keeps, placed in its asset's basket. */
  async #ownedOutput(
    token: TokenOutput,
    output: CreateActionOutput,
    remittance: ColorRemittance,
    originator: string
  ): Promise<CreateActionOutput> {
    if (remittance.assetId !== token.assetId)
      throw new Error('BRC-207: an owned output remittance names another asset')
    await this.#assertOwned(token, remittance, remittance.senderIdentityKey, originator)
    const basket = assetBasket(token.assetId, 'value')
    if (output.basket !== undefined && output.basket !== basket) {
      throw new Error('BRC-207: an owned output names the wrong p color basket')
    }
    return {
      ...output,
      basket,
      customInstructions: custodyInstructions(this.#custody(remittance))
    }
  }

  /**
   * Selects and reserves each asset's inputs, asks the user to approve the send, splits for a
   * handoff, and returns the token inputs and change outputs.
   */
  async #fund(
    reserved: Set<string>,
    sends: PlannedSends,
    handoff: boolean,
    originator: string
  ): Promise<{ inputs: ManagedInput[]; changeOutputs: CreateActionOutput[] }> {
    const selections = new Map<string, ManagedInput[]>()
    await eachInOrder(sends.required, async ([assetId, amount]) => {
      await this.#assertSupportedAsset(assetId)
      const selected = await this.#selectInputs(assetId, amount, originator)
      this.#reserve(reserved, selected)
      selections.set(assetId, selected)
    })
    await this.#approve(originator, {
      type: 'color_send',
      handoff,
      assets: [...sends.required].map(([assetId, amount]) => ({
        assetId,
        amount: amount.toString(),
        inputAmount: sumAmounts(selections.get(assetId) ?? []).toString()
      })),
      destinations: sends.destinations
    })
    const inputs: ManagedInput[] = []
    const changeOutputs: CreateActionOutput[] = []
    await eachInOrder(sends.required, async ([assetId, amount]) => {
      const selected = selections.get(assetId) ?? []
      const assetInputs =
        handoff && sumAmounts(selected) > amount
          ? await this.#splitExact(reserved, assetId, selected, amount, sends, originator)
          : selected
      inputs.push(...assetInputs)
      const change = sumAmounts(assetInputs) - amount
      if (change > 0n)
        changeOutputs.push((await this.#newManagedOutput(assetId, change, originator)).output)
    })
    return { inputs, changeOutputs }
  }

  /** Replaces a handoff's inputs with one split output of exactly `amount`, which it reserves. */
  async #splitExact(
    reserved: Set<string>,
    assetId: string,
    selected: ManagedInput[],
    amount: bigint,
    sends: PlannedSends,
    originator: string
  ): Promise<ManagedInput[]> {
    const exact = await this.#split(
      assetId,
      selected,
      amount,
      sends.destinations.filter(destination => destination.assetId === assetId),
      originator
    )
    this.#release(reserved, selected)
    this.#reserve(reserved, [exact])
    return [exact]
  }

  /** Selects admitted, unspent value outputs of one asset covering `amount`, largest first. */
  async #selectInputs(
    assetId: string,
    amount: bigint,
    originator: string
  ): Promise<ManagedInput[]> {
    const candidates = (await this.#candidates(assetId, originator)).sort(byAmountDescending)
    const rejected = new Set<string>()
    for (;;) {
      const chosen: Candidate[] = []
      for (const candidate of candidates) {
        if (sumAmounts(chosen) >= amount) break
        if (!rejected.has(candidate.outpoint)) chosen.push(candidate)
      }
      if (sumAmounts(chosen) < amount)
        throw new Error(`BRC-207: insufficient spendable balance of ${assetId}`)
      // Custody is read only for chosen outputs; an unreadable record is skipped, not fatal.
      const inputs = await Promise.all(
        chosen.map(async candidate => await this.#readableInput(candidate, originator))
      )
      const unreadable = chosen.filter((_, index) => inputs[index] === undefined)
      for (const candidate of unreadable) rejected.add(candidate.outpoint)
      if (unreadable.length > 0) continue
      const selected = inputs as ManagedInput[]
      const admitted = await this.#spendable(assetId, selected)
      const missing = selected.filter(input => !admitted.has(input.outpoint))
      if (missing.length === 0) return selected
      for (const input of missing) rejected.add(input.outpoint)
    }
  }

  /** One asset's value outputs, read from their locking scripts, excluding those a send has selected. */
  async #candidates(assetId: string, originator: string): Promise<Candidate[]> {
    const outputs = await this.#listBasket(assetBasket(assetId, 'value'), originator, {})
    return outputs.flatMap(output => {
      if (this.#selected.has(output.outpoint) || output.customInstructions === undefined) return []
      const source = this.#sourceOutput(output)
      const token = tryReadTokenOutput(source.lockingScript, parseOutpoint(output.outpoint))
      if (token?.assetId !== assetId || token.role !== 'value' || token.deploy) return []
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

  /** A `p color` basket output as a managed value input, or undefined when it is not one. */
  async #managedInput(output: WalletOutput, originator: string): Promise<ManagedInput | undefined> {
    const source = this.#sourceOutput(output)
    const token = readTokenOutput(source.lockingScript, parseOutpoint(output.outpoint))
    if (token?.role !== 'value' || token.deploy || output.customInstructions === undefined)
      return undefined
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
    return { ...source, assetId: token.assetId, amount: token.amount, custody }
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
        inputs: selected.map(input => ({
          outpoint: input.outpoint,
          unlockingScriptLength: UNLOCKING_SCRIPT_LENGTH,
          inputDescription: 'BRC-207 token input'
        })),
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

  /** Signs the action's inputs that spend this wallet's `p color` outputs, after a fresh spendability check. */
  async #signAction(
    args: SignActionArgs,
    action: PermissionsModuleAction | undefined,
    originator: string
  ): Promise<SignActionArgs> {
    if (action === undefined) return args
    const inputs = await this.#actionInputs(action.transaction, originator)
    if (inputs.length === 0) return args
    const assetIds = [...new Set(inputs.map(input => input.assetId))]
    const stale = await Promise.all(
      assetIds.map(async assetId => {
        const assetInputs = inputs.filter(input => input.assetId === assetId)
        const admitted = await this.#spendable(assetId, assetInputs)
        return assetInputs.some(input => !admitted.has(input.outpoint))
      })
    )
    const staleIndex = stale.indexOf(true)
    if (staleIndex >= 0) {
      throw new Error(`BRC-207: a ${assetIds[staleIndex]} input is no longer spendable`)
    }
    return {
      ...args,
      spends: {
        ...args.spends,
        ...(await this.#signInputs(
          action.transaction,
          inputs,
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
        includeCustomInstructions: true,
        limit: LIST_PAGE_LIMIT
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

  /** Submits a signed token transaction to the topic of every asset among its outputs. */
  async #submitSigned(result: SignActionResult): Promise<void> {
    if (result?.tx === undefined) return
    const tx = Transaction.fromAtomicBEEF(result.tx)
    const txid = tx.id('hex')
    const assetIds = new Set(
      tx.outputs.flatMap(
        (output, vout) => tryReadTokenOutput(output.lockingScript, { txid, vout })?.assetId ?? []
      )
    )
    if (assetIds.size > 0) await this.#submit([...assetIds], result.tx)
  }

  /** Submits to each asset topic and fails unless every token output of that asset is admitted. */
  async #submit(assetIds: string[], beef: AtomicBEEF): Promise<void> {
    const tx = Transaction.fromAtomicBEEF(beef)
    const txid = tx.id('hex')
    const steak = await this.#provider.submit(assetIds, Array.from(beef))
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
      ['tokenProofs', 'profileData'],
      'signature envelope'
    )
    if (envelope.version !== 1) throw new Error('BRC-207: signature envelope version must be 1')
    if (
      parseTokenProofs(envelope.tokenProofs, 'signature envelope tokenProofs', MAX_ENVELOPE_BYTES)
        .length > 0
    ) {
      throw new Error('BRC-207: token proofs are not supported by this module version')
    }
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
    const admitted = await this.#spendable(token.assetId, [
      { outpoint, lockingScript: source.lockingScript, satoshis: source.satoshis }
    ])
    if (!admitted.has(outpoint))
      throw new Error('BRC-207: the signed input is not admitted and unspent in its overlay')
    const preimage = this.#preimage(
      tx,
      inputIndex,
      { outpoint, lockingScript: source.lockingScript, satoshis: source.satoshis },
      sighashType
    )
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
        includeLabels: args.includeLabels,
        limit: LIST_PAGE_LIMIT
      },
      originator
    )
    const beef = entireTransactions ? listed.BEEF : undefined
    const records = inventoryRecords(listed.outputs, beef)
    const supported = await this.#classifyInventory(records)
    const views = records
      .filter(record => supported.has(record.assetId))
      .map(record => inventoryView(record))
      .filter(view => matchesTags(view.tags, args.tags ?? [], args.tagQueryMode))
    const limit = args.limit ?? 10
    const offset = args.offset ?? 0
    const ordered = offset < 0 ? [...views].reverse() : views
    const start = offset < 0 ? -offset - 1 : offset
    // Only the returned page is decrypted.
    const result: ListOutputsResult = {
      totalOutputs: views.length,
      outputs: await Promise.all(
        ordered
          .slice(start, start + limit)
          .map(async view => await this.#inventoryOutput(view, args, originator))
      )
    }
    if (beef !== undefined) result.BEEF = beef
    return result
  }

  /** Authenticates each held asset and states its unreserved outputs; returns the supported assets. */
  async #classifyInventory(records: InventoryRecord[]): Promise<Set<string>> {
    const assetIds = [...new Set(records.map(record => record.assetId))]
    const supported = await Promise.all(
      assetIds.map(async assetId => await this.#classifyAsset(assetId, records))
    )
    return new Set(assetIds.filter((_, index) => supported[index]))
  }

  async #classifyAsset(assetId: string, records: InventoryRecord[]): Promise<boolean> {
    try {
      await this.#assertSupportedAsset(assetId)
    } catch {
      // An unsupported or unauthenticated asset is not a validated holding.
      return false
    }
    const unclassified = records.filter(
      record => record.assetId === assetId && record.state === undefined
    )
    if (unclassified.length === 0) return true
    const admitted = await this.#spendable(
      assetId,
      unclassified.map(record => record.source)
    )
    for (const record of unclassified)
      record.state = admitted.has(record.output.outpoint) ? 'available' : 'pending'
    return true
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

  #custody(remittance: ColorRemittance): Custody {
    return {
      assetId: remittance.assetId,
      derivationPrefix: remittance.derivationPrefix,
      derivationSuffix: remittance.derivationSuffix,
      senderIdentityKey: remittance.senderIdentityKey
    }
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
        if (vout !== 0)
          throw new Error(
            'BRC-207: legacy nonzero-index assets are not supported by this module version'
          )
        const outpoint = outpointString(txid, 0)
        const deploy = readOutputList(await this.#provider.admission(assetId, [outpoint]), [
          outpoint
        ]).get(outpoint)
        if (deploy === undefined)
          throw new Error(`BRC-207: the overlay has no admitted deploy for ${assetId}`)
        if (!isDeployOutput(deploy.lockingScript, { txid, vout: 0 })) {
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
    const outpoints = outputs.map(output => output.outpoint)
    const listed = readOutputList(await this.#provider.spendability(assetId, outpoints), outpoints)
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
        async ({ index, input }) => await this.#unlock(template, index, input, originator)
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
        hashToDirectlySign: hash256(this.#preimage(tx, inputIndex, input, DEFAULT_SIGHASH))
      },
      originator
    )
    const der = Signature.fromDER(signature)
    const checksig = new TransactionSignature(der.r, der.s, DEFAULT_SIGHASH).toChecksigFormat()
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
