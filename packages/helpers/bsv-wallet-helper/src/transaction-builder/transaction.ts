import {
  WalletInterface,
  LockingScript,
  Transaction,
  CreateActionOutput,
  CreateActionOptions,
  SatoshisPerKilobyte,
  Beef
} from '@bsv/sdk'

import P2PKH from '../script-templates/p2pkh'
import OrdP2PKH from '../script-templates/ordinal'

import OrdLock from '../script-templates/ordlock'
import { WalletDerivationParams } from '../types/wallet'
import { getDerivation } from '../utils'
import { addOpReturnData } from '../utils/opreturn'
import { DEFAULT_SAT_PER_KB } from '../utils/constants'
import {
  BuildParams,
  InputConfig,
  OutputConfig,
  isDerivationParams,
  AddP2PKHOutputParams,
  AddChangeOutputParams,
  AddOrdinalP2PKHOutputParams,
  AddOrdLockOutputParams,
  AddCustomOutputParams,
  AddP2PKHInputParams,
  AddOrdinalP2PKHInputParams,
  AddOrdLockInputParams,
  AddCustomInputParams
} from './types'

/** Address string, wallet derivation params, or undefined (BRC-29 auto-derive). */
type AddressOrParams = string | WalletDerivationParams | undefined
type AddressedOutputConfig = Extract<OutputConfig, { type: 'p2pkh' | 'ordinalP2PKH' | 'change' }>

interface DerivationInfo {
  outputIndex: number
  derivationPrefix: string
  derivationSuffix: string
}

interface ActionInputConfig {
  outpoint: string
  inputDescription: string
  unlockingScriptLength: number
}

interface PreimageInput {
  sourceTransaction: Transaction
  sourceOutputIndex: number
  unlockingScriptTemplate: any
}

interface PreimageOutput {
  lockingScript: LockingScript
  satoshis?: number
  change?: boolean
}

interface InputArtifacts {
  unlockingScriptTemplates: any[]
  actionInputs: ActionInputConfig[]
  preimageInputs: PreimageInput[]
}

interface OutputArtifacts {
  actionOutputs: CreateActionOutput[]
  preimageOutputs: PreimageOutput[]
}

const BOOLEAN_ACTION_OPTIONS = [
  'signAndProcess',
  'acceptDelayedBroadcast',
  'returnTXIDOnly',
  'noSend',
  'randomizeOutputs'
] as const

function validateBooleanActionOptions(options: CreateActionOptions): void {
  for (const key of BOOLEAN_ACTION_OPTIONS) {
    const value = options[key]
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`${key} must be a boolean`)
    }
  }
}

function validateStringArrayOption(
  value: unknown,
  optionName: string,
  itemDescription: string
): void {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new TypeError(`${optionName} must be an array`)
  for (let index = 0; index < value.length; index++) {
    if (typeof value[index] !== 'string') {
      throw new TypeError(`${optionName}[${index}] must be a string (${itemDescription})`)
    }
  }
}

export function isHexPublicKey(value: string): boolean {
  return /^[0-9a-fA-F]+$/.test(value) && (value.length === 66 || value.length === 130)
}

/**
 * Builder class for configuring individual transaction inputs.
 *
 * This class allows you to chain methods to add more inputs/outputs or
 * access transaction-level methods like build().
 */
export class InputBuilder {
  constructor(
    private readonly parent: TransactionBuilder,
    private readonly inputConfig: InputConfig
  ) {}

  /**
   * Sets the description for THIS input only.
   *
   * @param desc - Description for this specific input
   * @returns This InputBuilder for further input configuration
   */
  inputDescription(desc: string): this {
    if (typeof desc !== 'string') {
      throw new TypeError('Input description must be a string')
    }
    this.inputConfig.description = desc
    return this
  }

  /**
   * Adds a P2PKH input to the transaction.
   *
   * @param params - Object containing input parameters
   * @returns A new InputBuilder for the new input
   */
  addP2PKHInput(params: AddP2PKHInputParams): InputBuilder {
    return this.parent.addP2PKHInput(params)
  }

  /**
   * Adds an ordinalP2PKH input to the transaction.
   *
   * @param params - Object containing input parameters
   * @returns A new InputBuilder for the new input
   */
  addOrdinalP2PKHInput(params: AddOrdinalP2PKHInputParams): InputBuilder {
    return this.parent.addOrdinalP2PKHInput(params)
  }

  /**
   * Adds an OrdLock input to the transaction.
   *
   * @param params - Object containing input parameters
   * @returns A new InputBuilder for the new input
   */
  addOrdLockInput(params: AddOrdLockInputParams): InputBuilder {
    return this.parent.addOrdLockInput(params)
  }

  /**
   * Adds a custom input with a pre-built unlocking script template.
   *
   * @param params - Object containing input parameters
   * @returns A new InputBuilder for the new input
   */
  addCustomInput(params: AddCustomInputParams): InputBuilder {
    return this.parent.addCustomInput(params)
  }

  /**
   * Adds a P2PKH output to the transaction.
   *
   * @param params - Object with publicKey/walletParams, satoshis, and optional description
   * @returns A new OutputBuilder for the new output
   */
  addP2PKHOutput(params: AddP2PKHOutputParams): OutputBuilder {
    return this.parent.addP2PKHOutput(params)
  }

  /**
   * Adds a change output that automatically calculates the change amount.
   *
   * @param params - Optional object with publicKey/walletParams and description
   * @returns A new OutputBuilder for the new output
   */
  addChangeOutput(params?: AddChangeOutputParams): OutputBuilder {
    return this.parent.addChangeOutput(params)
  }

  /**
   * Adds an ordinalP2PKH (1Sat Ordinal + P2PKH) output to the transaction.
   *
   * @param params - Object with publicKey/walletParams, satoshis, and optional inscription, metadata, description
   * @returns A new OutputBuilder for the new output
   */
  addOrdinalP2PKHOutput(params: AddOrdinalP2PKHOutputParams): OutputBuilder {
    return this.parent.addOrdinalP2PKHOutput(params)
  }

  /**
   * Adds an OrdLock output to the transaction.
   *
   * @param params - Object containing output parameters
   * @returns A new OutputBuilder for configuring this output
   */
  addOrdLockOutput(params: AddOrdLockOutputParams): OutputBuilder {
    return this.parent.addOrdLockOutput(params)
  }

  /**
   * Adds a custom output with a pre-built locking script.
   *
   * @param params - Object with lockingScript, satoshis, and optional description
   * @returns A new OutputBuilder for the new output
   */
  addCustomOutput(params: AddCustomOutputParams): OutputBuilder {
    return this.parent.addCustomOutput(params)
  }

  /**
   * Sets transaction-level options (convenience proxy to TransactionTemplate).
   *
   * @param opts - Transaction options (randomizeOutputs, etc.)
   * @returns The parent TransactionBuilder for transaction-level chaining
   */
  options(opts: CreateActionOptions): TransactionBuilder {
    return this.parent.options(opts)
  }

  /**
   * Builds the transaction using wallet.createAction() (convenience proxy to TransactionTemplate).
   *
   * @param params - Build parameters (optional)
   * @returns Promise resolving to txid and tx from wallet.createAction(), or preview object if params.preview=true
   */
  async build(params?: BuildParams): Promise<any> {
    return await this.parent.build(params)
  }

  /**
   * Preview the transaction without executing it (convenience proxy to TransactionTemplate).
   * Equivalent to calling build({ preview: true }).
   *
   * @returns Promise resolving to the createAction arguments object
   */
  async preview(): Promise<any> {
    return await this.parent.build({ preview: true })
  }
}

/**
 * Builder class for configuring individual transaction outputs.
 *
 * This class allows you to chain methods to configure a specific output,
 * such as adding OP_RETURN data. It also allows adding more outputs or
 * accessing transaction-level methods like build().
 */
export class OutputBuilder {
  constructor(
    private readonly parent: TransactionBuilder,
    private readonly outputConfig: OutputConfig
  ) {}

  /**
   * Adds OP_RETURN data to THIS output only.
   *
   * @param fields - Array of data fields. Each field can be a UTF-8 string, hex string, or byte array
   * @returns This OutputBuilder for further output configuration
   */
  addOpReturn(fields: Array<string | number[]>): this {
    if (!Array.isArray(fields) || fields.length === 0) {
      throw new Error('addOpReturn requires a non-empty array of fields')
    }
    this.outputConfig.opReturnFields = fields
    return this
  }

  /**
   * Sets the basket for THIS output only.
   *
   * @param value - Basket name/identifier
   * @returns This OutputBuilder for further output configuration
   */
  basket(value: string): this {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('basket requires a non-empty string')
    }
    this.outputConfig.basket = value
    return this
  }

  /**
   * Sets custom instructions for THIS output only.
   *
   * @param value - Custom instructions (typically JSON string)
   * @returns This OutputBuilder for further output configuration
   */
  customInstructions(value: string): this {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('customInstructions requires a non-empty string')
    }
    this.outputConfig.customInstructions = value
    return this
  }

  /**
   * Adds a P2PKH output to the transaction.
   *
   * @param params - Object with publicKey/walletParams, satoshis, and optional description
   * @returns A new OutputBuilder for the new output
   */
  addP2PKHOutput(params: AddP2PKHOutputParams): OutputBuilder {
    return this.parent.addP2PKHOutput(params)
  }

  /**
   * Adds a change output that automatically calculates the change amount.
   *
   * @param params - Optional object with publicKey/walletParams and description
   * @returns A new OutputBuilder for the new output
   */
  addChangeOutput(params?: AddChangeOutputParams): OutputBuilder {
    return this.parent.addChangeOutput(params)
  }

  /**
   * Adds a P2PKH input to the transaction.
   *
   * @param params - Object containing input parameters
   * @returns A new InputBuilder for the new input
   */
  addP2PKHInput(params: AddP2PKHInputParams): InputBuilder {
    return this.parent.addP2PKHInput(params)
  }

  /**
   * Adds an ordinalP2PKH input to the transaction.
   *
   * @param params - Object containing input parameters
   * @returns A new InputBuilder for the new input
   */
  addOrdinalP2PKHInput(params: AddOrdinalP2PKHInputParams): InputBuilder {
    return this.parent.addOrdinalP2PKHInput(params)
  }

  addOrdLockInput(params: AddOrdLockInputParams): InputBuilder {
    return this.parent.addOrdLockInput(params)
  }

  /**
   * Adds a custom input with a pre-built unlocking script template.
   *
   * @param params - Object containing input parameters
   * @returns A new InputBuilder for the new input
   */
  addCustomInput(params: AddCustomInputParams): InputBuilder {
    return this.parent.addCustomInput(params)
  }

  /**
   * Adds an ordinalP2PKH (1Sat Ordinal + P2PKH) output to the transaction.
   *
   * @param params - Object with publicKey/walletParams, satoshis, and optional inscription, metadata, description
   * @returns A new OutputBuilder for the new output
   */
  addOrdinalP2PKHOutput(params: AddOrdinalP2PKHOutputParams): OutputBuilder {
    return this.parent.addOrdinalP2PKHOutput(params)
  }

  addOrdLockOutput(params: AddOrdLockOutputParams): OutputBuilder {
    return this.parent.addOrdLockOutput(params)
  }

  /**
   * Adds a custom output with a pre-built locking script.
   *
   * @param params - Object with lockingScript, satoshis, and optional description
   * @returns A new OutputBuilder for the new output
   */
  addCustomOutput(params: AddCustomOutputParams): OutputBuilder {
    return this.parent.addCustomOutput(params)
  }

  /**
   * Sets the description for THIS output only.
   *
   * @param desc - Description for this specific output
   * @returns This OutputBuilder for further output configuration
   */
  outputDescription(desc: string): this {
    if (typeof desc !== 'string') {
      throw new TypeError('Output description must be a string')
    }
    this.outputConfig.description = desc
    return this
  }

  /**
   * Sets transaction-level options (convenience proxy to TransactionTemplate).
   *
   * @param opts - Transaction options (randomizeOutputs, etc.)
   * @returns The parent TransactionBuilder for transaction-level chaining
   */
  options(opts: CreateActionOptions): TransactionBuilder {
    return this.parent.options(opts)
  }

  /**
   * Builds the transaction using wallet.createAction() (convenience proxy to TransactionTemplate).
   *
   * @param params - Build parameters (optional)
   * @returns Promise resolving to txid and tx from wallet.createAction(), or preview object if params.preview=true
   */
  async build(params?: BuildParams): Promise<any> {
    return await this.parent.build(params)
  }

  /**
   * Preview the transaction without executing it (convenience proxy to TransactionTemplate).
   * Equivalent to calling build({ preview: true }).
   *
   * @returns Promise resolving to the createAction arguments object
   */
  async preview(): Promise<any> {
    return await this.parent.build({ preview: true })
  }
}

/**
 * TransactionBuilder - Builder class for creating BSV transactions with fluent API.
 *
 * This class provides a chainable interface for building transactions with multiple
 * outputs, metadata, and wallet integration. It simplifies the process of creating
 * transactions by abstracting away the low-level details of locking scripts and
 * wallet interactions.
 */
export class TransactionBuilder {
  private readonly wallet: WalletInterface
  private _transactionDescription?: string
  private readonly inputs: InputConfig[] = []
  private readonly outputs: OutputConfig[] = []
  private transactionOptions: CreateActionOptions = {}

  /**
   * Creates a new TransactionBuilder.
   *
   * @param wallet - BRC-100 compatible wallet interface for signing and key derivation
   * @param description - Optional description for the entire transaction
   */
  constructor(wallet: WalletInterface, description?: string) {
    if (!wallet) {
      throw new Error('Wallet is required for TransactionBuilder')
    }
    this.wallet = wallet
    this._transactionDescription = description
  }

  /**
   * Sets the transaction-level description.
   *
   * @param desc - Description for the entire transaction
   * @returns This TransactionBuilder for further chaining
   */
  transactionDescription(desc: string): this {
    if (typeof desc !== 'string') {
      throw new TypeError('Description must be a string')
    }
    this._transactionDescription = desc
    return this
  }

  /**
   * Sets transaction-level options.
   *
   * @param opts - Transaction options (randomizeOutputs, trustSelf, signAndProcess, etc.)
   * @returns This TransactionBuilder for further chaining
   */
  options(opts: CreateActionOptions): this {
    if (!opts || typeof opts !== 'object') {
      throw new Error('Options must be an object')
    }

    validateBooleanActionOptions(opts)

    // Validate trustSelf
    if (opts.trustSelf !== undefined) {
      const validTrustSelfValues = ['known', 'all']
      if (typeof opts.trustSelf !== 'string' || !validTrustSelfValues.includes(opts.trustSelf)) {
        throw new Error('trustSelf must be either "known" or "all"')
      }
    }

    validateStringArrayOption(opts.knownTxids, 'knownTxids', 'hex txid')
    validateStringArrayOption(opts.noSendChange, 'noSendChange', 'outpoint format')
    validateStringArrayOption(opts.sendWith, 'sendWith', 'hex txid')

    this.transactionOptions = { ...this.transactionOptions, ...opts }
    return this
  }

  /**
   * Adds a P2PKH input to the transaction.
   *
   * @param params - Object containing input parameters
   * @param params.sourceTransaction - The source transaction containing the output to spend
   * @param params.sourceOutputIndex - The index of the output in the source transaction
   * @param params.walletParams - Optional wallet derivation parameters
   * @param params.description - Optional description for this input
   * @param params.signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
   * @param params.anyoneCanPay - Allow other inputs to be added later (default: false)
   * @param params.sourceSatoshis - Optional amount in satoshis
   * @param params.lockingScript - Optional locking script
   * @returns An InputBuilder for the new input
   */
  addP2PKHInput(params: AddP2PKHInputParams): InputBuilder {
    // Validate parameters
    if (!params.sourceTransaction || typeof params.sourceTransaction !== 'object') {
      throw new Error('sourceTransaction is required and must be a Transaction object')
    }
    if (typeof params.sourceTransaction.id !== 'function') {
      throw new TypeError(
        'sourceTransaction must be a valid Transaction object with an id() method'
      )
    }
    if (typeof params.sourceOutputIndex !== 'number' || params.sourceOutputIndex < 0) {
      throw new Error('sourceOutputIndex must be a non-negative number')
    }
    if (params.description !== undefined && typeof params.description !== 'string') {
      throw new Error('description must be a string')
    }

    const inputConfig: InputConfig = {
      type: 'p2pkh',
      sourceTransaction: params.sourceTransaction,
      sourceOutputIndex: params.sourceOutputIndex,
      description: params.description,
      walletParams: params.walletParams,
      signOutputs: params.signOutputs ?? 'all',
      anyoneCanPay: params.anyoneCanPay ?? false,
      sourceSatoshis: params.sourceSatoshis,
      lockingScript: params.lockingScript
    }

    this.inputs.push(inputConfig)
    return new InputBuilder(this, inputConfig)
  }

  /**
   * Adds an OrdLock input to the transaction.
   *
   * @param params - Object containing input parameters
   * @param params.kind - 'cancel' (wallet signature) or 'purchase' (outputs blob + preimage)
   * @returns An InputBuilder for the new input
   */
  addOrdLockInput(params: AddOrdLockInputParams): InputBuilder {
    // Validate parameters
    if (!params.sourceTransaction || typeof params.sourceTransaction !== 'object') {
      throw new Error('sourceTransaction is required and must be a Transaction object')
    }
    if (typeof params.sourceTransaction.id !== 'function') {
      throw new TypeError(
        'sourceTransaction must be a valid Transaction object with an id() method'
      )
    }
    if (typeof params.sourceOutputIndex !== 'number' || params.sourceOutputIndex < 0) {
      throw new Error('sourceOutputIndex must be a non-negative number')
    }
    if (params.description !== undefined && typeof params.description !== 'string') {
      throw new Error('description must be a string')
    }
    if (params.kind !== undefined && params.kind !== 'cancel' && params.kind !== 'purchase') {
      throw new Error("kind must be 'cancel' or 'purchase'")
    }

    const inputConfig: InputConfig = {
      type: 'ordLock',
      sourceTransaction: params.sourceTransaction,
      sourceOutputIndex: params.sourceOutputIndex,
      description: params.description,
      kind: params.kind,
      walletParams: params.walletParams,
      signOutputs: params.signOutputs ?? 'all',
      anyoneCanPay: params.anyoneCanPay ?? false,
      sourceSatoshis: params.sourceSatoshis,
      lockingScript: params.lockingScript
    }

    this.inputs.push(inputConfig)
    return new InputBuilder(this, inputConfig)
  }

  /**
   * Adds an ordinalP2PKH input to the transaction.
   *
   * @param params - Object containing input parameters
   * @param params.sourceTransaction - The source transaction containing the output to spend
   * @param params.sourceOutputIndex - The index of the output in the source transaction
   * @param params.walletParams - Optional wallet derivation parameters
   * @param params.description - Optional description for this input
   * @param params.signOutputs - Signature scope: 'all', 'none', or 'single' (default: 'all')
   * @param params.anyoneCanPay - Allow other inputs to be added later (default: false)
   * @param params.sourceSatoshis - Optional amount in satoshis
   * @param params.lockingScript - Optional locking script
   * @returns An InputBuilder for the new input
   */
  addOrdinalP2PKHInput(params: AddOrdinalP2PKHInputParams): InputBuilder {
    // Validate parameters
    if (!params.sourceTransaction || typeof params.sourceTransaction !== 'object') {
      throw new Error('sourceTransaction is required and must be a Transaction object')
    }
    if (typeof params.sourceTransaction.id !== 'function') {
      throw new TypeError(
        'sourceTransaction must be a valid Transaction object with an id() method'
      )
    }
    if (typeof params.sourceOutputIndex !== 'number' || params.sourceOutputIndex < 0) {
      throw new Error('sourceOutputIndex must be a non-negative number')
    }
    if (params.description !== undefined && typeof params.description !== 'string') {
      throw new Error('description must be a string')
    }

    const inputConfig: InputConfig = {
      type: 'ordinalP2PKH',
      sourceTransaction: params.sourceTransaction,
      sourceOutputIndex: params.sourceOutputIndex,
      description: params.description,
      walletParams: params.walletParams,
      signOutputs: params.signOutputs ?? 'all',
      anyoneCanPay: params.anyoneCanPay ?? false,
      sourceSatoshis: params.sourceSatoshis,
      lockingScript: params.lockingScript
    }

    this.inputs.push(inputConfig)
    return new InputBuilder(this, inputConfig)
  }

  /**
   * Adds a custom input with a pre-built unlocking script template.
   *
   * @param params - Object containing input parameters
   * @param params.unlockingScriptTemplate - The unlocking script template for this input
   * @param params.sourceTransaction - The source transaction containing the output to spend
   * @param params.sourceOutputIndex - The index of the output in the source transaction
   * @param params.description - Optional description for this input
   * @param params.sourceSatoshis - Optional amount in satoshis
   * @param params.lockingScript - Optional locking script
   * @returns An InputBuilder for the new input
   */
  addCustomInput(params: AddCustomInputParams): InputBuilder {
    // Validate parameters
    if (!params.unlockingScriptTemplate) {
      throw new Error('unlockingScriptTemplate is required for custom input')
    }
    if (typeof params.unlockingScriptTemplate.estimateLength !== 'function') {
      throw new TypeError('unlockingScriptTemplate must have an estimateLength() method')
    }
    if (!params.sourceTransaction || typeof params.sourceTransaction !== 'object') {
      throw new Error('sourceTransaction is required and must be a Transaction object')
    }
    if (typeof params.sourceTransaction.id !== 'function') {
      throw new TypeError(
        'sourceTransaction must be a valid Transaction object with an id() method'
      )
    }
    if (typeof params.sourceOutputIndex !== 'number' || params.sourceOutputIndex < 0) {
      throw new Error('sourceOutputIndex must be a non-negative number')
    }
    if (params.description !== undefined && typeof params.description !== 'string') {
      throw new Error('description must be a string')
    }

    const inputConfig: InputConfig = {
      type: 'custom',
      unlockingScriptTemplate: params.unlockingScriptTemplate,
      sourceTransaction: params.sourceTransaction,
      sourceOutputIndex: params.sourceOutputIndex,
      description: params.description,
      sourceSatoshis: params.sourceSatoshis,
      lockingScript: params.lockingScript
    }

    this.inputs.push(inputConfig)
    return new InputBuilder(this, inputConfig)
  }

  /**
   * Adds a P2PKH output to the transaction.
   *
   * @param params - Object containing output parameters
   * @returns An OutputBuilder for configuring this output
   */
  addP2PKHOutput(params: AddP2PKHOutputParams): OutputBuilder {
    // Validate parameters
    if (typeof params.satoshis !== 'number' || params.satoshis < 0) {
      throw new TypeError('satoshis must be a non-negative number')
    }
    if (params.description !== undefined && typeof params.description !== 'string') {
      throw new Error('description must be a string')
    }

    // Determine addressOrParams from named parameters
    let addressOrParams: AddressOrParams
    if ('publicKey' in params) {
      addressOrParams = params.publicKey
    } else if ('address' in params) {
      addressOrParams = params.address
    } else if ('walletParams' in params) {
      addressOrParams = params.walletParams
    }
    // else undefined for BRC-29 auto-derivation

    const outputConfig: OutputConfig = {
      type: 'p2pkh',
      satoshis: params.satoshis,
      description: params.description,
      addressOrParams
    }

    this.outputs.push(outputConfig)
    return new OutputBuilder(this, outputConfig)
  }

  private validateBuildConfiguration(): void {
    if (this.outputs.length === 0) {
      throw new Error('At least one output is required to build a transaction')
    }
    const hasChangeOutputs = this.outputs.some(output => output.type === 'change')
    if (hasChangeOutputs && this.inputs.length === 0) {
      throw new Error('Change outputs require at least one input')
    }
  }

  private createUnlockingScriptTemplate(config: InputConfig): any {
    switch (config.type) {
      case 'p2pkh':
      case 'ordinalP2PKH': {
        return new P2PKH(this.wallet).unlock({
          protocolID: config.walletParams?.protocolID,
          keyID: config.walletParams?.keyID,
          counterparty: config.walletParams?.counterparty,
          signOutputs: config.signOutputs,
          anyoneCanPay: config.anyoneCanPay
        })
      }
      case 'ordLock': {
        const ordLock = new OrdLock(this.wallet)
        if (config.kind === 'purchase') {
          return ordLock.purchaseUnlock({
            sourceSatoshis: config.sourceSatoshis,
            lockingScript: config.lockingScript
          })
        }
        return ordLock.cancelUnlock({
          protocolID: config.walletParams?.protocolID,
          keyID: config.walletParams?.keyID,
          counterparty: config.walletParams?.counterparty,
          signOutputs: config.signOutputs,
          anyoneCanPay: config.anyoneCanPay,
          sourceSatoshis: config.sourceSatoshis,
          lockingScript: config.lockingScript
        })
      }
      case 'custom':
        return config.unlockingScriptTemplate
      default:
        throw new Error(`Unsupported input type: ${(config as any).type}`)
    }
  }

  private buildInputArtifacts(): InputArtifacts {
    const unlockingScriptTemplates: any[] = []
    const actionInputs: ActionInputConfig[] = []
    const preimageInputs: PreimageInput[] = []

    for (const config of this.inputs) {
      const unlockingScriptTemplate = this.createUnlockingScriptTemplate(config)
      unlockingScriptTemplates.push(unlockingScriptTemplate)
      const txid = config.sourceTransaction.id('hex')
      actionInputs.push({
        outpoint: `${txid}.${config.sourceOutputIndex}`,
        inputDescription: config.description || 'Transaction input',
        unlockingScriptLength: 0
      })
      preimageInputs.push({
        sourceTransaction: config.sourceTransaction,
        sourceOutputIndex: config.sourceOutputIndex,
        unlockingScriptTemplate
      })
    }
    return { unlockingScriptTemplates, actionInputs, preimageInputs }
  }

  private resolveOutputAddress(
    config: AddressedOutputConfig,
    outputIndex: number,
    derivationInfo: DerivationInfo[]
  ): Exclude<AddressOrParams, undefined> {
    if (config.addressOrParams) return config.addressOrParams
    const derivation = getDerivation()
    const [derivationPrefix, derivationSuffix] = derivation.keyID.split(' ')
    derivationInfo.push({ outputIndex, derivationPrefix, derivationSuffix })
    return {
      protocolID: derivation.protocolID,
      keyID: derivation.keyID,
      counterparty: 'self'
    }
  }

  private async createP2PKHLockingScript(
    addressOrParams: Exclude<AddressOrParams, undefined>,
    treatStringAsPublicKey = false
  ): Promise<LockingScript> {
    const p2pkh = new P2PKH(this.wallet)
    if (isDerivationParams(addressOrParams)) {
      return await p2pkh.lock({ walletParams: addressOrParams })
    }
    if (treatStringAsPublicKey || isHexPublicKey(addressOrParams)) {
      return await p2pkh.lock({ publicKey: addressOrParams })
    }
    return await p2pkh.lock({ address: addressOrParams })
  }

  private async createOrdinalLockingScript(
    config: Extract<OutputConfig, { type: 'ordinalP2PKH' }>,
    addressOrParams: Exclude<AddressOrParams, undefined>
  ): Promise<LockingScript> {
    const ordinal = new OrdP2PKH(this.wallet)
    const common = { inscription: config.inscription, metadata: config.metadata }
    if (isDerivationParams(addressOrParams)) {
      return await ordinal.lock({ walletParams: addressOrParams, ...common })
    }
    if (isHexPublicKey(addressOrParams)) {
      return await ordinal.lock({ publicKey: addressOrParams, ...common })
    }
    return await ordinal.lock({ address: addressOrParams, ...common })
  }

  private async createOutputLockingScript(
    config: OutputConfig,
    outputIndex: number,
    derivationInfo: DerivationInfo[]
  ): Promise<LockingScript> {
    switch (config.type) {
      case 'p2pkh':
        return await this.createP2PKHLockingScript(
          this.resolveOutputAddress(config, outputIndex, derivationInfo)
        )
      case 'ordinalP2PKH':
        return await this.createOrdinalLockingScript(
          config,
          this.resolveOutputAddress(config, outputIndex, derivationInfo)
        )
      case 'ordLock':
        return await new OrdLock(this.wallet).lock(config.ordLockParams)
      case 'custom':
        return config.lockingScript
      case 'change':
        return await this.createP2PKHLockingScript(
          this.resolveOutputAddress(config, outputIndex, derivationInfo),
          true
        )
      default:
        throw new Error(`Unsupported output type: ${(config as any).type}`)
    }
  }

  private customInstructionsForOutput(
    config: OutputConfig,
    outputIndex: number,
    derivationInfo: DerivationInfo[]
  ): string | undefined {
    const derivation = derivationInfo.find(item => item.outputIndex === outputIndex)
    if (derivation == null) return config.customInstructions
    const instructions = JSON.stringify({
      derivationPrefix: derivation.derivationPrefix,
      derivationSuffix: derivation.derivationSuffix
    })
    return config.customInstructions == null
      ? instructions
      : config.customInstructions + instructions
  }

  private createActionOutput(
    config: OutputConfig,
    lockingScript: LockingScript,
    customInstructions: string | undefined
  ): CreateActionOutput {
    const output: CreateActionOutput = {
      lockingScript: lockingScript.toHex(),
      satoshis: config.type === 'change' ? 0 : config.satoshis,
      outputDescription:
        config.description || (config.type === 'change' ? 'Change' : 'Transaction output')
    }
    if (customInstructions != null && customInstructions !== '') {
      output.customInstructions = customInstructions
    }
    if (config.basket != null && config.basket !== '') output.basket = config.basket
    return output
  }

  private async buildOutputArtifacts(): Promise<OutputArtifacts> {
    const actionOutputs: CreateActionOutput[] = []
    const preimageOutputs: PreimageOutput[] = []
    const derivationInfo: DerivationInfo[] = []

    for (let outputIndex = 0; outputIndex < this.outputs.length; outputIndex++) {
      const config = this.outputs[outputIndex]
      let lockingScript = await this.createOutputLockingScript(config, outputIndex, derivationInfo)
      if (config.opReturnFields != null && config.opReturnFields.length > 0) {
        lockingScript = addOpReturnData(lockingScript, config.opReturnFields)
      }
      const customInstructions = this.customInstructionsForOutput(
        config,
        outputIndex,
        derivationInfo
      )
      actionOutputs.push(this.createActionOutput(config, lockingScript, customInstructions))
      preimageOutputs.push(
        config.type === 'change'
          ? { lockingScript, change: true }
          : { lockingScript, satoshis: config.satoshis }
      )
    }
    return { actionOutputs, preimageOutputs }
  }

  private createPreimageTransaction(
    preimageInputs: PreimageInput[],
    preimageOutputs: PreimageOutput[]
  ): Transaction {
    const transaction = new Transaction()
    for (const input of preimageInputs) transaction.addInput(input)
    for (const output of preimageOutputs) {
      transaction.addOutput(
        output.change === true
          ? { lockingScript: output.lockingScript, change: true }
          : { satoshis: output.satoshis, lockingScript: output.lockingScript }
      )
    }
    return transaction
  }

  private async populateUnlockingScriptLengths(
    transaction: Transaction,
    templates: any[],
    actionInputs: ActionInputConfig[]
  ): Promise<void> {
    for (let index = 0; index < templates.length; index++) {
      const template = templates[index]
      const estimateLength = template?.estimateLength
      if (typeof estimateLength !== 'function') {
        throw new TypeError('unlockingScriptTemplate must have an estimateLength() method')
      }
      let length: number
      if (estimateLength.length >= 2) {
        length = await estimateLength.call(template, transaction, index)
      } else if (estimateLength.length === 1) {
        length = await estimateLength.call(template, transaction)
      } else {
        length = await estimateLength.call(template)
      }
      const inputConfig = this.inputs[index]
      if (inputConfig?.type === 'ordLock' && inputConfig.kind === 'purchase') {
        length += 68
      }
      actionInputs[index].unlockingScriptLength = length
    }
  }

  private applyCalculatedChangeOutputs(
    transaction: Transaction,
    actionOutputs: CreateActionOutput[]
  ): void {
    const outputIndicesToRemove: number[] = []
    for (let index = 0; index < this.outputs.length; index++) {
      if (this.outputs[index].type !== 'change') continue
      const preimageOutput = transaction.outputs[index]
      if (preimageOutput == null) {
        outputIndicesToRemove.push(index)
        continue
      }
      if (preimageOutput.satoshis === undefined) {
        throw new Error(`Change output at index ${index} has no satoshis after fee calculation`)
      }
      actionOutputs[index].satoshis = preimageOutput.satoshis
    }
    for (let index = outputIndicesToRemove.length - 1; index >= 0; index--) {
      actionOutputs.splice(outputIndicesToRemove[index], 1)
    }
  }

  private buildInputBEEF(preimageInputs: PreimageInput[]): number[] {
    if (preimageInputs.length === 1) return preimageInputs[0].sourceTransaction.toBEEF()
    const mergedBeef = new Beef()
    for (const input of preimageInputs) mergedBeef.mergeBeef(input.sourceTransaction.toBEEF())
    return mergedBeef.toBinary()
  }

  private async preparePreimage(
    inputArtifacts: InputArtifacts,
    outputArtifacts: OutputArtifacts
  ): Promise<number[] | undefined> {
    if (inputArtifacts.preimageInputs.length === 0) return undefined
    const transaction = this.createPreimageTransaction(
      inputArtifacts.preimageInputs,
      outputArtifacts.preimageOutputs
    )
    await this.populateUnlockingScriptLengths(
      transaction,
      inputArtifacts.unlockingScriptTemplates,
      inputArtifacts.actionInputs
    )
    await transaction.fee(new SatoshisPerKilobyte(DEFAULT_SAT_PER_KB))
    await transaction.sign()
    this.applyCalculatedChangeOutputs(transaction, outputArtifacts.actionOutputs)
    return this.buildInputBEEF(inputArtifacts.preimageInputs)
  }

  private async signCreatedAction(actionResult: any, templates: any[]): Promise<any> {
    if (this.inputs.length === 0) {
      return { txid: actionResult.txid, tx: actionResult.tx }
    }
    if (actionResult?.signableTransaction == null) {
      throw new Error('Failed to create signable transaction')
    }

    const { reference } = actionResult.signableTransaction
    const transaction = Transaction.fromBEEF(actionResult.signableTransaction.tx)
    for (let index = 0; index < this.inputs.length; index++) {
      transaction.inputs[index].unlockingScriptTemplate = templates[index]
      transaction.inputs[index].sourceTransaction = this.inputs[index].sourceTransaction
    }
    await transaction.sign()

    const spends: { [key: string]: { unlockingScript: string } } = {}
    for (let index = 0; index < this.inputs.length; index++) {
      const unlockingScript = transaction.inputs[index].unlockingScript?.toHex()
      if (unlockingScript == null || unlockingScript === '') {
        throw new Error(`Missing unlocking script for input ${index}`)
      }
      spends[String(index)] = { unlockingScript }
    }
    const signedAction = await this.wallet.signAction({ reference, spends })
    return { txid: signedAction.txid, tx: signedAction.tx }
  }

  /**
   * Adds an OrdLock output to the transaction.
   *
   * @param params - OrdLock locking params plus `satoshis` for the locked output itself.
   * @returns An OutputBuilder for configuring this output
   */
  addOrdLockOutput(params: AddOrdLockOutputParams): OutputBuilder {
    // Validate parameters
    if (typeof params.satoshis !== 'number' || params.satoshis < 0) {
      throw new TypeError('satoshis must be a non-negative number')
    }
    if (params.description !== undefined && typeof params.description !== 'string') {
      throw new Error('description must be a string')
    }

    const { satoshis, description, ...ordLockParams } = params

    const outputConfig: OutputConfig = {
      type: 'ordLock',
      satoshis,
      description,
      ordLockParams
    }

    this.outputs.push(outputConfig)
    return new OutputBuilder(this, outputConfig)
  }

  /**
   * Adds a change output to the transaction.
   *
   * @param params - Optional object containing output parameters
   * @returns An OutputBuilder for configuring this output
   */
  addChangeOutput(params?: AddChangeOutputParams): OutputBuilder {
    // Validate parameters
    if (params?.description !== undefined && typeof params.description !== 'string') {
      throw new Error('description must be a string')
    }

    // Determine addressOrParams from named parameters
    let addressOrParams: AddressOrParams
    if (params != null && 'publicKey' in params) {
      addressOrParams = params.publicKey
    } else if (params != null && 'walletParams' in params) {
      addressOrParams = params.walletParams
    }
    // else undefined for BRC-29 auto-derivation

    const outputConfig: OutputConfig = {
      type: 'change',
      description: params?.description || 'Change',
      addressOrParams
    }

    this.outputs.push(outputConfig)
    return new OutputBuilder(this, outputConfig)
  }

  /**
   * Adds an ordinalP2PKH output to the transaction.
   *
   * @param params - Object containing output parameters
   * @returns An OutputBuilder for configuring this output
   */
  addOrdinalP2PKHOutput(params: AddOrdinalP2PKHOutputParams): OutputBuilder {
    // Validate parameters
    if (typeof params.satoshis !== 'number' || params.satoshis < 0) {
      throw new TypeError('satoshis must be a non-negative number')
    }
    if (params.description !== undefined && typeof params.description !== 'string') {
      throw new Error('description must be a string')
    }

    // Determine addressOrParams from named parameters
    let addressOrParams: AddressOrParams
    if ('publicKey' in params) {
      addressOrParams = params.publicKey
    } else if ('address' in params) {
      addressOrParams = params.address
    } else if ('walletParams' in params) {
      addressOrParams = params.walletParams
    }
    // else undefined for BRC-29 auto-derivation

    const outputConfig: OutputConfig = {
      type: 'ordinalP2PKH',
      satoshis: params.satoshis,
      description: params.description,
      addressOrParams,
      inscription: params.inscription,
      metadata: params.metadata
    }

    this.outputs.push(outputConfig)
    return new OutputBuilder(this, outputConfig)
  }

  /**
   * Adds a custom output with a pre-built locking script.
   *
   * This is useful for advanced use cases where you need to use a locking script
   * that isn't directly supported by the builder methods.
   *
   * @param params - Object containing lockingScript, satoshis, and optional description
   * @returns An OutputBuilder for configuring this output
   */
  addCustomOutput(params: AddCustomOutputParams): OutputBuilder {
    // Validate parameters
    if (!params.lockingScript || typeof params.lockingScript.toHex !== 'function') {
      throw new Error('lockingScript must be a LockingScript instance')
    }
    if (typeof params.satoshis !== 'number' || params.satoshis < 0) {
      throw new TypeError('satoshis must be a non-negative number')
    }
    if (params.description !== undefined && typeof params.description !== 'string') {
      throw new Error('description must be a string')
    }

    const outputConfig: OutputConfig = {
      type: 'custom',
      satoshis: params.satoshis,
      description: params.description,
      lockingScript: params.lockingScript
    }

    this.outputs.push(outputConfig)
    return new OutputBuilder(this, outputConfig)
  }

  /**
   * Builds the transaction using wallet.createAction().
   *
   * This method creates locking scripts for all outputs, applies OP_RETURN metadata
   * where specified, calls wallet.createAction() with unlockingScriptLength first,
   * then signs the transaction and calls signAction() to complete and broadcast.
   *
   * @param params - Build parameters (optional). Use { preview: true } to return the createAction arguments without executing
   * @returns Promise resolving to txid and tx from wallet.signAction(), or preview object if params.preview=true
   * @throws Error if no outputs are configured or if locking script creation fails
   */
  async build(params?: BuildParams): Promise<any> {
    this.validateBuildConfiguration()
    const inputArtifacts = this.buildInputArtifacts()
    const outputArtifacts = await this.buildOutputArtifacts()
    const inputBEEF = await this.preparePreimage(inputArtifacts, outputArtifacts)

    // Build the createAction arguments object with unlockingScriptLength
    const createActionArgs = {
      description: this._transactionDescription || 'Transaction',
      ...(inputBEEF != null && { inputBEEF }),
      ...(inputArtifacts.actionInputs.length > 0 && { inputs: inputArtifacts.actionInputs }),
      ...(outputArtifacts.actionOutputs.length > 0 && { outputs: outputArtifacts.actionOutputs }),
      options: { ...this.transactionOptions }
    }

    // If preview mode, return the arguments object without calling createAction
    if (params?.preview) {
      return createActionArgs
    }

    const actionResult = await this.wallet.createAction(createActionArgs)
    return await this.signCreatedAction(actionResult, inputArtifacts.unlockingScriptTemplates)
  }

  /**
   * Preview the transaction without executing it.
   * Equivalent to calling build({ preview: true }).
   *
   * @returns Promise resolving to the createAction arguments object
   */
  async preview(): Promise<any> {
    return await this.build({ preview: true })
  }

  /**
   * Create a minimal P2PKH payment and execute it.
   *
   * This convenience method adds a single P2PKH output to the given destination
   * (either a hex public key or a base58 address), disables output randomization,
   * then calls build().
   *
   * @param to - Destination (hex public key or base58 address)
   * @param satoshis - Amount to send in satoshis (must be non-negative)
   * @returns Promise resolving to txid and tx from wallet.createAction()/wallet.signAction()
   * @throws Error if to is not a string
   * @throws Error if satoshis is not a non-negative number
   */
  async pay(to: string, satoshis: number): Promise<any> {
    if (typeof to !== 'string') {
      throw new TypeError('to must be a string')
    }
    if (typeof satoshis !== 'number' || satoshis < 0) {
      throw new TypeError('satoshis must be a non-negative number')
    }

    if (isHexPublicKey(to)) {
      this.addP2PKHOutput({ publicKey: to, satoshis })
    } else {
      this.addP2PKHOutput({ address: to, satoshis })
    }

    this.options({ randomizeOutputs: false })

    return await this.build()
  }
}
