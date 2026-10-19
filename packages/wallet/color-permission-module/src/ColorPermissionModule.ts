import {
  LockingScript,
  Signature,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  type AtomicBEEF,
  type CreateActionArgs,
  type CreateActionOutput,
  type CreateActionResult,
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
import { Bsv21Binary } from '@bsv/templates'
import {
  maybeDecryptMetadata,
  sdk as toolbox,
  type PermissionsModule,
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
import { readOutputList } from './overlay.js'
import {
  exactMembers,
  jsonByteArray,
  jsonObject,
  jsonUint32,
  parseStrictJsonBytes
} from './strictJson.js'
import { readTokenOutput, type TokenOutput } from './tokenOutputs.js'
import type {
  ColorOverlayProvider,
  ColorPermissionModuleOptions,
  ColorTokenAccessHandler
} from './types.js'

const SESSION_TIMEOUT_MS = 60_000
/** A selection only needs to outlive the createAction that reserves its inputs in storage. */
const SELECTION_TIMEOUT_MS = 60_000
const PENDING_TIMEOUT_MS = 15 * 60_000
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

interface ManagedInput extends SourceOutput {
  assetId: string
  amount: bigint
  custody: Custody
}

/** A createAction this module funded with token inputs, through to its signing. */
interface PendingAction {
  inputs: ManagedInput[]
  assetIds: string[]
  noSend: boolean
  originator: string
  expires: number
  template?: Transaction
}

type InventoryState = 'available' | 'reserved' | 'pending'

function sumAmounts(inputs: readonly ManagedInput[]): bigint {
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
  readonly #readGrants = new Map<string, number>()
  /** Actions awaiting their createAction result, keyed by each selected input outpoint. */
  readonly #selected = new Map<string, PendingAction>()
  /** Signable actions keyed by their reference. */
  readonly #signable = new Map<string, PendingAction>()
  /** Actions being signed, keyed by each token input outpoint. */
  readonly #signing = new Map<string, PendingAction>()
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

  /** Clears in-memory grants and pending action state. */
  dispose(): void {
    this.#readGrants.clear()
    this.#selected.clear()
    this.#signable.clear()
    this.#signing.clear()
    this.#supportedAssets.clear()
  }

  /** Protocol- and basket-routed calls: key and signature operations and the read views. */
  async handleRequest(
    req: PermissionsModuleRequest,
    next: PermissionsModuleNext
  ): Promise<unknown> {
    this.#expire()
    switch (req.method) {
      case 'getPublicKey':
      case 'verifySignature':
        this.#parseKeyArgs(req.args as { protocolID?: unknown; keyID?: unknown })
        return await next(req.args)
      case 'createSignature':
        return await this.#createSignature(req.args as CreateSignatureArgs, req.originator, next)
      case 'listOutputs':
        return await this.#listOutputs(req.args as ListOutputsArgs, req.originator, next)
      case 'relinquishOutput':
        if (parseAssetBasket((req.args as { basket: string }).basket) === undefined) {
          throw new Error('BRC-207: only per-asset baskets hold outputs that can be relinquished')
        }
        return await next(req.args)
      default:
        throw new Error(`BRC-207: ${req.method} is not available in the p color namespace`)
    }
  }

  /** Label- and basket-routed actions. */
  async onRequest(req: PermissionsModuleRequest): Promise<{ args: object }> {
    this.#expire()
    switch (req.method) {
      case 'createAction':
        return { args: await this.#createAction(req.args as CreateActionArgs, req.originator) }
      case 'signAction':
        return { args: await this.#signAction(req.args as SignActionArgs) }
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
    context: { method: string; originator: string }
  ): Promise<unknown> {
    if (context.method === 'createAction') this.#bindSignableAction(res as CreateActionResult)
    if (context.method === 'signAction') await this.#submitSigned(res as SignActionResult)
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
    const txid = tx.id('hex')
    for (const output of args.outputs) {
      const remittance = output.insertionRemittance
      if (
        output.protocol !== 'basket insertion' ||
        !remittance?.basket.startsWith(`${COLOR_BASKET_NAMESPACE} `)
      ) {
        continue
      }
      const target = parseAssetBasket(remittance.basket)
      if (target === undefined)
        throw new Error('BRC-207: a receipt must name a per-asset value or authority basket')
      const custody = parseCustody(
        remittance.customInstructions ?? '',
        MAX_RECEIPT_INSTRUCTION_BYTES,
        'receipt customInstructions'
      )
      const source = tx.outputs[output.outputIndex]
      if (source?.satoshis === undefined)
        throw new Error('BRC-207: the receipt names a missing output')
      const token = readTokenOutput(source.lockingScript, { txid, vout: output.outputIndex })
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
      const outpoint = outpointString(txid, output.outputIndex)
      const admitted = await this.#spendable(token.assetId, [
        { outpoint, lockingScript: source.lockingScript, satoshis: source.satoshis }
      ])
      if (!admitted.has(outpoint)) {
        throw new Error(
          'BRC-207: the received output is not admitted and unspent in its asset overlay'
        )
      }
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
    const owned = new Map(plan.ownedOutputs.map(remittance => [remittance.outputIndex, remittance]))
    const requestedOutputs = args.outputs ?? []
    for (const remittance of plan.ownedOutputs) {
      if (remittance.outputIndex >= requestedOutputs.length) {
        throw new Error('BRC-207: plan.ownedOutputs names a missing output')
      }
    }
    const required = new Map<string, bigint>()
    const destinations: Array<{
      outputIndex: number
      assetId: string
      amount: string
      lockingScript: string
    }> = []
    const outputs: CreateActionOutput[] = []
    for (const [index, output] of requestedOutputs.entries()) {
      const remittance = owned.get(index)
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
        outputs.push(output)
        continue
      }
      if (token.deploy) throw new Error('BRC-207: issuance is not supported by this module version')
      if (token.role !== 'value')
        throw new Error('BRC-207: authority operations are not supported by this module version')
      if (!plan.assets.includes(token.assetId))
        throw new Error('BRC-207: an output asset is missing from plan.assets')
      required.set(token.assetId, (required.get(token.assetId) ?? 0n) + token.amount)
      if (remittance === undefined) {
        if (output.basket !== undefined) {
          throw new Error('BRC-207: only outputs in plan.ownedOutputs may enter a p color basket')
        }
        destinations.push({
          outputIndex: index,
          assetId: token.assetId,
          amount: token.amount.toString(),
          lockingScript: output.lockingScript
        })
        outputs.push(output)
        continue
      }
      if (remittance.assetId !== token.assetId)
        throw new Error('BRC-207: an owned output remittance names another asset')
      await this.#assertOwned(token, remittance, remittance.senderIdentityKey, originator)
      const basket = assetBasket(token.assetId, 'value')
      if (output.basket !== undefined && output.basket !== basket) {
        throw new Error('BRC-207: an owned output names the wrong p color basket')
      }
      outputs.push({
        ...output,
        basket,
        customInstructions: custodyInstructions(this.#custody(remittance))
      })
    }
    for (const assetId of plan.assets) {
      if (!required.has(assetId))
        throw new Error('BRC-207: plan.assets names an asset the action does not use')
    }
    const expected = [...required.keys()].map(assetId => `${assetId} transfer`).sort()
    const declared = plan.operations
      .map(operation => `${operation.assetId} ${operation.operation}`)
      .sort()
    if (expected.join('\n') !== declared.join('\n')) {
      throw new Error('BRC-207: plan.operations must declare exactly one transfer per asset')
    }

    const handoff = labels.some(label => label.startsWith(NOSEND_EXPIRY_LABEL_PREFIX))
    const pending: PendingAction = {
      inputs: [],
      assetIds: [...required.keys()],
      noSend: args.options?.noSend === true,
      originator,
      expires: Date.now() + SELECTION_TIMEOUT_MS
    }
    try {
      const selections = new Map<string, ManagedInput[]>()
      for (const [assetId, amount] of required) {
        await this.#assertSupportedAsset(assetId)
        const selected = await this.#selectInputs(assetId, amount, originator)
        for (const input of selected) this.#selected.set(input.outpoint, pending)
        selections.set(assetId, selected)
      }
      await this.#approve(originator, {
        type: 'color_send',
        handoff,
        assets: [...required].map(([assetId, amount]) => ({
          assetId,
          amount: amount.toString(),
          inputAmount: sumAmounts(selections.get(assetId) ?? []).toString()
        })),
        destinations
      })
      const changeOutputs: CreateActionOutput[] = []
      for (const [assetId, amount] of required) {
        let selected = selections.get(assetId) ?? []
        if (handoff && sumAmounts(selected) > amount) {
          const exact = await this.#split(
            assetId,
            selected,
            amount,
            destinations.filter(destination => destination.assetId === assetId),
            originator
          )
          for (const input of selected) this.#selected.delete(input.outpoint)
          this.#selected.set(exact.outpoint, pending)
          selected = [exact]
        }
        pending.inputs.push(...selected)
        const change = sumAmounts(selected) - amount
        if (change > 0n)
          changeOutputs.push((await this.#newManagedOutput(assetId, change, originator)).output)
      }
      // A handoff split can take longer than a selection lives; time it from here.
      pending.expires = Date.now() + SELECTION_TIMEOUT_MS
      return {
        ...args,
        inputs: pending.inputs.map(input => ({
          outpoint: input.outpoint,
          unlockingScriptLength: UNLOCKING_SCRIPT_LENGTH,
          inputDescription: 'BRC-207 token input'
        })),
        outputs: [...outputs, ...changeOutputs]
      }
    } catch (error) {
      for (const [outpoint, action] of this.#selected)
        if (action === pending) this.#selected.delete(outpoint)
      throw error
    }
  }

  /** Selects admitted, unspent value outputs of one asset covering `amount`, largest first. */
  async #selectInputs(
    assetId: string,
    amount: bigint,
    originator: string
  ): Promise<ManagedInput[]> {
    const candidates = (await this.#managedOutputs(assetId, originator)).sort((a, b) =>
      a.amount === b.amount ? 0 : a.amount > b.amount ? -1 : 1
    )
    const rejected = new Set<string>()
    for (;;) {
      const selected: ManagedInput[] = []
      for (const candidate of candidates) {
        if (sumAmounts(selected) >= amount) break
        if (!rejected.has(candidate.outpoint)) selected.push(candidate)
      }
      if (sumAmounts(selected) < amount)
        throw new Error(`BRC-207: insufficient spendable balance of ${assetId}`)
      const admitted = await this.#spendable(assetId, selected)
      const missing = selected.filter(input => !admitted.has(input.outpoint))
      if (missing.length === 0) return selected
      for (const input of missing) rejected.add(input.outpoint)
    }
  }

  /** The value outputs of one asset this wallet can sign for, excluding inputs already in use. */
  async #managedOutputs(assetId: string, originator: string): Promise<ManagedInput[]> {
    const managed: ManagedInput[] = []
    for (const output of await this.#listBasket(assetBasket(assetId, 'value'), originator, {})) {
      if (this.#selected.has(output.outpoint) || this.#signing.has(output.outpoint)) continue
      const source = this.#sourceOutput(output)
      const token = readTokenOutput(source.lockingScript, parseOutpoint(output.outpoint))
      if (
        token?.assetId !== assetId ||
        token.role !== 'value' ||
        output.customInstructions === undefined
      )
        continue
      const custody = parseCustody(
        await maybeDecryptMetadata(this.#wallet, output.customInstructions, originator),
        undefined,
        'managed output customInstructions'
      )
      if (!selectsAsset(custody.assetId, token)) continue
      managed.push({ ...source, assetId, amount: token.amount, custody })
    }
    return managed
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
        outputs: [exact.output, rest.output],
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
    const spends: Record<number, { unlockingScript: string }> = {}
    for (const input of selected) {
      const index = template.inputs.findIndex(
        candidate => inputOutpoint(candidate) === input.outpoint
      )
      if (index < 0) throw new Error('BRC-207: the split transaction omits a token input')
      spends[index] = { unlockingScript: await this.#unlock(template, index, input, originator) }
    }
    const signed = await this.#wallet.signAction(
      { reference: signable.reference, spends },
      originator
    )
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
        lockingScript: new Bsv21Binary()
          .lock(assetId, amount, hash160(toArray(publicKey, 'hex')))
          .toHex(),
        satoshis: TOKEN_CARRIER_SATOSHIS,
        basket: assetBasket(assetId, 'value'),
        customInstructions: custodyInstructions(custody),
        outputDescription: 'BRC-207 token change'
      }
    }
  }

  /** Correlates a signable createAction result with the action this module funded. */
  #bindSignableAction(result: CreateActionResult): void {
    const signable = result?.signableTransaction
    if (signable == null) return
    const template = Transaction.fromAtomicBEEF(signable.tx)
    const pending = template.inputs
      .map(input => this.#selected.get(inputOutpoint(input)))
      .find(Boolean)
    if (pending === undefined) return
    for (const input of pending.inputs) this.#selected.delete(input.outpoint)
    pending.template = template
    pending.expires = Date.now() + PENDING_TIMEOUT_MS
    this.#signable.set(signable.reference, pending)
  }

  /** Signs this module's token inputs after refreshing their overlay spendability. */
  async #signAction(args: SignActionArgs): Promise<SignActionArgs> {
    const pending = this.#signable.get(args.reference)
    if (pending?.template === undefined) return args
    this.#signable.delete(args.reference)
    for (const assetId of pending.assetIds) {
      const inputs = pending.inputs.filter(input => input.assetId === assetId)
      const admitted = await this.#spendable(assetId, inputs)
      if (inputs.some(input => !admitted.has(input.outpoint))) {
        throw new Error(`BRC-207: a ${assetId} input is no longer spendable`)
      }
    }
    const template = pending.template
    const spends = { ...args.spends }
    for (const input of pending.inputs) {
      const index = template.inputs.findIndex(
        candidate => inputOutpoint(candidate) === input.outpoint
      )
      if (index < 0) throw new Error('BRC-207: the signable transaction omits a token input')
      spends[index] = {
        unlockingScript: await this.#unlock(template, index, input, pending.originator)
      }
    }
    pending.noSend = (args.options?.noSend ?? pending.noSend) === true
    pending.expires = Date.now() + PENDING_TIMEOUT_MS
    for (const input of pending.inputs) this.#signing.set(input.outpoint, pending)
    return { ...args, spends }
  }

  /** Submits a signed, processed token transaction to every asset topic it involves. */
  async #submitSigned(result: SignActionResult): Promise<void> {
    if (result?.tx === undefined) return
    const tx = Transaction.fromAtomicBEEF(result.tx)
    const pending = tx.inputs.map(input => this.#signing.get(inputOutpoint(input))).find(Boolean)
    if (pending === undefined) return
    for (const input of pending.inputs) this.#signing.delete(input.outpoint)
    if (!pending.noSend) await this.#submit(pending.assetIds, result.tx)
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
    for (const remittance of ownedOutputs) {
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
    }
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
    const beef = entireTransactions && listed.BEEF !== undefined ? listed.BEEF : undefined
    const records: Array<{
      output: WalletOutput
      assetId: string
      state?: InventoryState
      source: SourceOutput
    }> = []
    for (const output of listed.outputs) {
      const outpoint = parseOutpoint(output.outpoint)
      const lockingScript =
        beef === undefined
          ? LockingScript.fromHex(output.lockingScript ?? '')
          : Transaction.fromBEEF(beef, outpoint.txid).outputs[outpoint.vout].lockingScript
      let token: TokenOutput | undefined
      try {
        token = readTokenOutput(lockingScript, outpoint)
      } catch {
        continue
      }
      if (token === undefined) continue
      records.push({
        output,
        assetId: token.assetId,
        state: output.spendable ? undefined : 'reserved',
        source: { outpoint: output.outpoint, lockingScript, satoshis: output.satoshis }
      })
    }
    const supported = new Set<string>()
    for (const assetId of new Set(records.map(record => record.assetId))) {
      try {
        await this.#assertSupportedAsset(assetId)
        supported.add(assetId)
      } catch {
        // An unsupported or unauthenticated asset is not a validated holding.
      }
      const unclassified = records.filter(
        record => record.assetId === assetId && record.state === undefined
      )
      if (!supported.has(assetId) || unclassified.length === 0) continue
      const admitted = await this.#spendable(
        assetId,
        unclassified.map(record => record.source)
      )
      for (const record of unclassified)
        record.state = admitted.has(record.output.outpoint) ? 'available' : 'pending'
    }
    const filterTags = args.tags ?? []
    const matching = []
    for (const record of records.filter(record => supported.has(record.assetId))) {
      const state = record.state as InventoryState
      const tags = [
        ...(record.output.tags ?? []).filter(tag => !tag.startsWith(STATE_TAG_PREFIX)),
        `${STATE_TAG_PREFIX}${state}`
      ]
      const matches =
        filterTags.length === 0 ||
        (args.tagQueryMode === 'all'
          ? filterTags.every(tag => tags.includes(tag))
          : filterTags.some(tag => tags.includes(tag)))
      if (!matches) continue
      const output: WalletOutput = {
        satoshis: record.output.satoshis,
        spendable: state === 'available',
        outpoint: record.output.outpoint
      }
      if (args.include === 'locking scripts')
        output.lockingScript = record.source.lockingScript.toHex()
      if (
        args.includeCustomInstructions === true &&
        record.output.customInstructions !== undefined
      ) {
        output.customInstructions = await maybeDecryptMetadata(
          this.#wallet,
          record.output.customInstructions,
          originator
        )
      }
      if (args.includeTags === true) output.tags = tags
      if (args.includeLabels === true) output.labels = record.output.labels
      matching.push(output)
    }
    const limit = args.limit ?? 10
    const offset = args.offset ?? 0
    const ordered = offset < 0 ? [...matching].reverse() : matching
    const start = offset < 0 ? -offset - 1 : offset
    const result: ListOutputsResult = {
      totalOutputs: matching.length,
      outputs: ordered.slice(start, start + limit)
    }
    if (beef !== undefined) result.BEEF = beef
    return result
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
        if (readTokenOutput(deploy.lockingScript, { txid, vout: 0 })?.deploy !== true) {
          throw new Error(`BRC-207: ${assetId} is not a BRC-162 deploy`)
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

  /** Inventory and balance reads need a session grant, as BTMS listing does. */
  async #authorizeRead(originator: string): Promise<void> {
    const granted = this.#readGrants.get(originator)
    if (granted !== undefined && Date.now() - granted < SESSION_TIMEOUT_MS) return
    await this.#approve(originator, { type: 'color_access' })
    this.#readGrants.set(originator, Date.now())
  }

  #expire(now = Date.now()): void {
    for (const [originator, granted] of this.#readGrants) {
      if (now - granted >= SESSION_TIMEOUT_MS) this.#readGrants.delete(originator)
    }
    for (const map of [this.#selected, this.#signable, this.#signing]) {
      for (const [key, pending] of map) if (pending.expires <= now) map.delete(key)
    }
  }
}
