import type {
  AsyncCryptoBackend,
  AsyncCryptoOperation
} from '@bsv/sdk/primitives/AsyncCryptoBackend'
import type Spend from '@bsv/sdk/script/Spend'
import type SpendVerificationContext from '@bsv/sdk/script/SpendVerificationContext'
import { decodeResults, flagsForInputCount, packArrays, uint32, verdict } from './BdkBatch.js'
import type BdkVerifierInterface from './BdkVerifierInterface.js'
import { mapVerifyFlags } from './flags.js'
import {
  DEFAULT_VERIFAST_SCRIPT_BYTE_THRESHOLD,
  POST_CHRONICLE_HEIGHT_FALLBACK,
  isStandardP2PKHScript,
  isVeriFastCandidateScript,
  type BdkDigestVerification,
  type BdkNetwork,
  type BdkSpendBatchItem,
  type BdkSpendContext,
  type BdkVerificationResult,
  type BdkVerifierMode,
  type BdkVerifierOptions,
  type BdkVerifyFromEFParams,
  type BdkVerifyParams,
  type BdkVerifySpendOptions,
  type BdkWasmFactory,
  type BdkWasmModule,
  type EmbindVector,
  type EmbindVectorCtor
} from './BdkVerifierTypes.js'
import type BdkWorkerScheduler from './workers/BdkWorkerScheduler.js'
import type {
  DigestBatchPayload,
  ScriptBatchPayload,
  SpendBatchPayload
} from './workers/BdkWorkerProtocol.js'

export * from './BdkVerifierTypes.js'

const NETWORK_IDS: Record<BdkNetwork, number> = {
  main: 0,
  test: 1,
  stn: 2,
  regtest: 3,
  ttn: 4,
  teratestnet: 4,
  terratestnet: 4,
  tstn: 5
}

function bdkHeight(value: number, name: string): number {
  if (value >>> 0 !== value || value > 0x7fffffff) {
    throw new RangeError(`${name} must be a non-negative int32 integer`)
  }
  return value
}

function booleanValue(value: boolean, name: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`${name} must be a boolean`)
  return value
}

function byteArray(value: Uint8Array, name: string): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`)
  return value
}

function fixedByteArray(value: Uint8Array, length: number, name: string): Uint8Array {
  byteArray(value, name)
  if (value.length !== length) throw new RangeError(`${name} must contain exactly ${length} bytes`)
  return value
}

function publicKeyBytes(value: Uint8Array, name = 'publicKey'): Uint8Array {
  byteArray(value, name)
  if (value.length !== 33 && value.length !== 65) {
    throw new RangeError(`${name} must contain a 33-byte compressed or 65-byte uncompressed key`)
  }
  return value
}

function signatureBytes(value: Uint8Array, name = 'signature'): Uint8Array {
  byteArray(value, name)
  if (value.length < 8 || value.length > 72) {
    throw new RangeError(`${name} must contain an 8-to-72-byte DER signature`)
  }
  return value
}

function heightsArray(value: readonly number[] | Int32Array): Int32Array {
  if (!Array.isArray(value) && !(value instanceof Int32Array)) {
    throw new TypeError('utxoHeights must be an array or Int32Array')
  }
  return Int32Array.from(value, (height, index) => bdkHeight(height, `utxoHeights[${index}]`))
}

function digestVerdicts(value: Uint8Array, count: number): boolean[] {
  if (!(value instanceof Uint8Array) || value.length !== count) {
    throw new Error('BDK returned an invalid digest batch result')
  }
  return Array.from(value, (result, index) => {
    if (result !== 0 && result !== 1) {
      throw new Error(`BDK returned invalid digest verdict ${result} at index ${index}`)
    }
    return result === 1
  })
}

type NormalizedEFParams = Omit<
  BdkVerifyFromEFParams,
  'utxoHeights' | 'verifyFlags' | 'customFlags'
> & {
  utxoHeights: Int32Array
  customFlags: Uint32Array
}

function efBytes(item: NormalizedEFParams): number {
  return (
    item.extendedTransaction.byteLength + (item.utxoHeights.length + item.customFlags.length) * 4
  )
}

function digestBytes(item: BdkDigestVerification): number {
  return item.publicKey.byteLength + item.digest.byteLength + item.signature.byteLength
}

function chunksBySize<T>(
  items: readonly T[],
  maxItems: number,
  maxBytes: number,
  size: (item: T) => number
): T[][] {
  const chunks: T[][] = []
  let chunk: T[] = []
  let bytes = 0
  for (const item of items) {
    const itemBytes = size(item)
    if (chunk.length > 0 && (chunk.length >= maxItems || bytes + itemBytes > maxBytes)) {
      chunks.push(chunk)
      chunk = []
      bytes = 0
    }
    chunk.push(item)
    bytes += itemBytes
  }
  if (chunk.length > 0) chunks.push(chunk)
  return chunks
}

function safeIntegerAtLeast(value: number, minimum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum)
    throw new RangeError(`${name} must be a safe integer of at least ${minimum}`)
}

function toVector<T>(Vector: EmbindVectorCtor<T>, values: Iterable<T>): EmbindVector<T> {
  const vec = new Vector()
  for (const value of values) vec.push_back(value)
  return vec
}

interface OptionalBackendGlobal {
  __bsvSdkAsyncCryptoBackendV1?: AsyncCryptoBackend
  __bsvSdkScriptVerificationBackendV1?: BdkVerifierCore
}

function backendGlobal(): typeof globalThis & OptionalBackendGlobal {
  return globalThis as typeof globalThis & OptionalBackendGlobal
}

/**
 * Shared platform-neutral implementation. Node and browser entry points inject
 * different Emscripten loader glue but use this exact verifier and batch logic.
 */
export default class BdkVerifierCore implements BdkVerifierInterface, AsyncCryptoBackend {
  readonly #factory: BdkWasmFactory
  readonly #workerScheduler?: BdkWorkerScheduler
  #module: BdkWasmModule | undefined
  #loading: Promise<BdkWasmModule> | undefined
  #preloadScheduled = false
  readonly #network: number
  readonly #mode: BdkVerifierMode
  readonly #scriptByteThreshold: number
  readonly #maxBatchItems: number
  readonly #maxBatchBytes: number
  readonly #defaultUtxoHeight: number
  readonly #defaultBlockHeight: number
  readonly #defaultConsensus: boolean
  readonly #registeredAsDefault: boolean
  #modulePrepared = false
  #disposed = false

  constructor(
    factory: BdkWasmFactory,
    options: BdkVerifierOptions = {},
    workerScheduler?: BdkWorkerScheduler
  ) {
    this.#factory = factory
    this.#workerScheduler = workerScheduler
    const network = options.network ?? 'main'
    if (!Object.hasOwn(NETWORK_IDS, network)) throw new RangeError('network is not supported')
    this.#network = NETWORK_IDS[network]
    this.#mode = options.mode ?? 'auto'
    this.#scriptByteThreshold =
      options.scriptByteThreshold ?? DEFAULT_VERIFAST_SCRIPT_BYTE_THRESHOLD
    this.#maxBatchItems = options.maxBatchItems ?? 256
    this.#maxBatchBytes = options.maxBatchBytes ?? 32 * 1024 * 1024
    this.#defaultUtxoHeight = options.defaultUtxoHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
    this.#defaultBlockHeight = options.defaultBlockHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
    this.#defaultConsensus = options.defaultConsensus ?? true
    this.#registeredAsDefault = options.registerAsDefault ?? true
    if (this.#mode !== 'auto' && this.#mode !== 'always') {
      throw new RangeError("mode must be either 'auto' or 'always'")
    }
    safeIntegerAtLeast(this.#scriptByteThreshold, 0, 'scriptByteThreshold')
    safeIntegerAtLeast(this.#maxBatchItems, 1, 'maxBatchItems')
    safeIntegerAtLeast(this.#maxBatchBytes, 1, 'maxBatchBytes')
    if (
      options.batchWorkers !== undefined &&
      (!Number.isSafeInteger(options.batchWorkers) ||
        options.batchWorkers < 1 ||
        options.batchWorkers > 16)
    ) {
      throw new RangeError('batchWorkers must be a safe integer from 1 to 16')
    }
    safeIntegerAtLeast(options.batchWorkerThreshold ?? 32, 2, 'batchWorkerThreshold')
    bdkHeight(this.#defaultUtxoHeight, 'defaultUtxoHeight')
    bdkHeight(this.#defaultBlockHeight, 'defaultBlockHeight')
    booleanValue(this.#defaultConsensus, 'defaultConsensus')
    booleanValue(this.#registeredAsDefault, 'registerAsDefault')
    if (this.#registeredAsDefault) {
      const registry = backendGlobal()
      registry.__bsvSdkAsyncCryptoBackendV1 = this
      registry.__bsvSdkScriptVerificationBackendV1 = this
    }
  }

  async #getModule(): Promise<BdkWasmModule> {
    if (this.#disposed) throw new Error('BDK verifier has been disposed')
    if (this.#module !== undefined) return this.#module
    if (this.#loading === undefined) {
      const loading = Promise.resolve()
        .then(async () => await this.#factory())
        .then(module => {
          if (this.#disposed) throw new Error('BDK verifier has been disposed')
          this.#module = module
          return module
        })
      this.#loading = loading
      void loading
        .finally(() => {
          if (this.#loading === loading) this.#loading = undefined
        })
        .catch(() => {})
    }
    return await this.#loading
  }

  /** Load and instantiate the optional backend before latency-sensitive work. */
  async preload(): Promise<void> {
    const module = await this.#getModule()
    if (this.#modulePrepared) return
    module.PrepareVerification?.()
    module.PrepareSigning?.()
    this.#modulePrepared = true
  }

  /**
   * Warm both the main module and the explicit large-batch worker pool.
   * Single-item verification never waits for or dispatches through this pool.
   */
  async preloadBatch(): Promise<void> {
    await this.preload()
    if (this.#workerScheduler !== undefined && this.#module !== undefined) {
      await this.#workerScheduler.preload(this.#module)
    }
  }

  /** True only after the WASM module has finished loading successfully. */
  isReady(): boolean {
    return !this.#disposed && this.#module !== undefined
  }

  /** Stop using this instance as the SDK's optional default backend. */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    this.#workerScheduler?.terminate()
    this.#module = undefined
    this.#loading = undefined
    this.#modulePrepared = false
    if (!this.#registeredAsDefault) return
    const registry = backendGlobal()
    if (registry.__bsvSdkAsyncCryptoBackendV1 === this) {
      delete registry.__bsvSdkAsyncCryptoBackendV1
    }
    if (registry.__bsvSdkScriptVerificationBackendV1 === this) {
      delete registry.__bsvSdkScriptVerificationBackendV1
    }
  }

  supportsCrypto(operation: AsyncCryptoOperation): boolean {
    const bdk = this.#module
    if (bdk === undefined) return false
    switch (operation) {
      case 'signDigest':
        return bdk.SignDigest !== undefined
      case 'verifyDigest':
        return bdk.VerifyDigest !== undefined
      case 'verifyDigestBatch':
        return bdk.VerifyDigestBatchArray !== undefined
      case 'publicKeyFromPrivate':
        return bdk.PublicKeyFromPrivate !== undefined
      case 'multiplyPublicKey':
        return bdk.MultiplyPublicKey !== undefined
      case 'tweakPublicKeyAdd':
        return bdk.TweakPublicKeyAdd !== undefined
      case 'tweakPrivateKeyAdd':
        return bdk.TweakPrivateKeyAdd !== undefined
    }
  }

  #schedulePreload(): void {
    if (
      this.#disposed ||
      this.#module !== undefined ||
      this.#loading !== undefined ||
      this.#preloadScheduled
    )
      return
    this.#preloadScheduled = true
    setTimeout(() => {
      this.#preloadScheduled = false
      void this.preload().catch(() => {})
    }, 0)
  }

  #prepareCandidate(): boolean {
    if (this.#disposed) return false
    if (this.#mode === 'always') return true
    if (this.isReady()) return true
    // Auto mode never waits on cold WASM. A later eligible call can use the
    // completed load, while this call keeps the exact JavaScript path.
    this.#schedulePreload()
    return false
  }

  /** Selection hook consumed by Transaction.verify without coupling the SDK to this package. */
  shouldVerifyScripts(params: BdkVerifyParams): boolean {
    if (params.memoryLimit !== undefined) return false
    if (this.#mode === 'always') return !this.#disposed
    const sourceOutputs = params.tx.inputs.map(
      input => input.sourceTransaction?.outputs[input.sourceOutputIndex]
    )
    if (
      !params.consensus &&
      params.tx.version <= 1 &&
      sourceOutputs.some(
        output => output === undefined || !isStandardP2PKHScript(output.lockingScript)
      )
    ) {
      return false
    }
    const candidate = sourceOutputs.some(sourceOutput => {
      return (
        sourceOutput !== undefined &&
        isVeriFastCandidateScript(sourceOutput.lockingScript, this.#scriptByteThreshold)
      )
    })
    return candidate && this.#prepareCandidate()
  }

  /** Selection hook consumed by Spend.validateWith. */
  shouldVerifySpend(spend: Spend, context?: SpendVerificationContext): boolean {
    if (spend.hasExplicitMemoryLimit) return false
    if (this.#mode === 'always') return !this.#disposed
    if (
      context?.consensus !== true &&
      spend.transactionVersion <= 1 &&
      !isStandardP2PKHScript(spend.lockingScript)
    )
      return false
    if (this.#module !== undefined && this.#module.VerifySpendArray === undefined) return false
    return (
      isVeriFastCandidateScript(spend.lockingScript, this.#scriptByteThreshold) &&
      this.#prepareCandidate()
    )
  }

  #transactionParams(params: BdkVerifyParams): BdkVerifyFromEFParams {
    if (params.memoryLimit !== undefined) {
      throw new Error('VeriFast cannot enforce a custom script memory limit')
    }
    return {
      extendedTransaction: params.tx.toEFBinary(),
      utxoHeights: params.tx.inputs.map(
        input => input.sourceTransaction?.merklePath?.blockHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
      ),
      blockHeight: params.blockHeight,
      consensus: params.consensus,
      verifyFlags: params.verifyFlags
    }
  }

  #normalizeEFParams(params: BdkVerifyFromEFParams): NormalizedEFParams {
    const heights = heightsArray(params.utxoHeights)
    return {
      extendedTransaction: byteArray(params.extendedTransaction, 'extendedTransaction'),
      utxoHeights: heights,
      blockHeight: bdkHeight(params.blockHeight, 'blockHeight'),
      consensus: booleanValue(params.consensus, 'consensus'),
      customFlags: flagsForInputCount(heights.length, params.verifyFlags, params.customFlags)
    }
  }

  #verifyFromEFWithModule(
    bdk: BdkWasmModule,
    normalized: NormalizedEFParams
  ): BdkVerificationResult {
    const heights = normalized.utxoHeights
    const customFlags = normalized.customFlags

    if (bdk.VerifyScriptArrayNetwork !== undefined) {
      return bdk.VerifyScriptArrayNetwork(
        normalized.extendedTransaction,
        heights,
        normalized.blockHeight,
        normalized.consensus,
        customFlags,
        this.#network
      )
    }
    if (this.#network !== NETWORK_IDS.main) {
      throw new Error('The loaded BDK module does not support explicit networks')
    }
    if (bdk.VerifyScriptArray !== undefined) {
      return bdk.VerifyScriptArray(
        normalized.extendedTransaction,
        heights,
        normalized.blockHeight,
        normalized.consensus,
        customFlags
      )
    }

    const VectorUInt8 = bdk.VectorUInt8
    const VectorInt32 = bdk.VectorInt32
    const VectorUInt32 = bdk.VectorUInt32
    const verifyScript = bdk.VerifyScript
    if (
      VectorUInt8 === undefined ||
      VectorInt32 === undefined ||
      VectorUInt32 === undefined ||
      verifyScript === undefined
    ) {
      throw new Error('The loaded BDK module does not support script verification')
    }
    const extendedTX = toVector(VectorUInt8, normalized.extendedTransaction)
    const utxoHeights = toVector(VectorInt32, heights)
    const flags = toVector(VectorUInt32, customFlags)
    try {
      return verifyScript(
        extendedTX,
        utxoHeights,
        normalized.blockHeight,
        normalized.consensus,
        flags
      )
    } finally {
      extendedTX.delete()
      utxoHeights.delete()
      flags.delete()
    }
  }

  async verifyScriptsDetailed(params: BdkVerifyParams): Promise<BdkVerificationResult> {
    return await this.verifyScriptsFromEFDetailed(this.#transactionParams(params))
  }

  async verifyScriptsFromEFDetailed(params: BdkVerifyFromEFParams): Promise<BdkVerificationResult> {
    return this.#verifyFromEFWithModule(await this.#getModule(), this.#normalizeEFParams(params))
  }

  async verifyScripts(params: BdkVerifyParams): Promise<boolean> {
    return verdict(await this.verifyScriptsDetailed(params))
  }

  async verifyScriptsFromEF(params: BdkVerifyFromEFParams): Promise<boolean> {
    return verdict(await this.verifyScriptsFromEFDetailed(params))
  }

  #packEFChunk(chunk: readonly NormalizedEFParams[]): ScriptBatchPayload {
    const transactions = packArrays(
      chunk.map(item => item.extendedTransaction),
      length => new Uint8Array(length)
    )
    const heightsByItem = chunk.map(item => item.utxoHeights)
    const heights = packArrays(heightsByItem, length => new Int32Array(length))
    const flagsByItem = chunk.map(item => item.customFlags)
    const flags = packArrays(flagsByItem, length => new Uint32Array(length))
    return {
      extendedTransactions: transactions.values,
      transactionOffsets: transactions.offsets,
      utxoHeights: heights.values,
      heightOffsets: heights.offsets,
      blockHeights: Int32Array.from(chunk.map(item => item.blockHeight)),
      consensus: Uint8Array.from(chunk.map(item => (item.consensus ? 1 : 0))),
      customFlags: flags.values,
      customFlagOffsets: flags.offsets,
      network: this.#network
    }
  }

  #verifyEFChunk(
    bdk: BdkWasmModule,
    chunk: readonly NormalizedEFParams[]
  ): BdkVerificationResult[] {
    if (bdk.VerifyScriptBatchArray === undefined) {
      return chunk.map(params => this.#verifyFromEFWithModule(bdk, params))
    }
    const payload = this.#packEFChunk(chunk)
    const flat = bdk.VerifyScriptBatchArray(
      payload.extendedTransactions,
      payload.transactionOffsets,
      payload.utxoHeights,
      payload.heightOffsets,
      payload.blockHeights,
      payload.consensus,
      payload.customFlags,
      payload.customFlagOffsets,
      payload.network
    )
    return decodeResults(flat, chunk.length)
  }

  async verifyScriptsBatchDetailed(
    params: readonly BdkVerifyParams[]
  ): Promise<BdkVerificationResult[]> {
    return await this.verifyScriptsBatchFromEFDetailed(
      params.map(item => this.#transactionParams(item))
    )
  }

  async verifyScriptsBatchFromEFDetailed(
    params: readonly BdkVerifyFromEFParams[]
  ): Promise<BdkVerificationResult[]> {
    if (params.length === 0) return []
    const normalized = params.map(item => this.#normalizeEFParams(item))
    if (
      this.#workerScheduler?.shouldUse(normalized.length, async () => await this.preloadBatch()) ===
      true
    ) {
      const chunks = this.#workerScheduler.parallelChunks(normalized, efBytes)
      if (chunks.length > 1) {
        const results = await this.#workerScheduler.execute(
          chunks.map(chunk => ({
            operation: 'verifyScripts' as const,
            payload: this.#packEFChunk(chunk)
          }))
        )
        return results.flatMap((result, index) => {
          if (!(result instanceof Int32Array)) {
            throw new TypeError('BDK script worker returned an invalid result type')
          }
          return decodeResults(result, chunks[index].length)
        })
      }
    }
    const bdk = await this.#getModule()
    return chunksBySize(normalized, this.#maxBatchItems, this.#maxBatchBytes, efBytes).flatMap(
      chunk => this.#verifyEFChunk(bdk, chunk)
    )
  }

  async verifyScriptsBatch(params: readonly BdkVerifyParams[]): Promise<boolean[]> {
    return (await this.verifyScriptsBatchDetailed(params)).map(verdict)
  }

  async verifyScriptsBatchFromEF(params: readonly BdkVerifyFromEFParams[]): Promise<boolean[]> {
    return (await this.verifyScriptsBatchFromEFDetailed(params)).map(verdict)
  }

  #spendContext(
    spend: Spend,
    options: BdkVerifySpendOptions = {},
    transaction?: Uint8Array
  ): BdkSpendContext {
    if (!Number.isSafeInteger(spend.sourceSatoshis) || spend.sourceSatoshis < 0) {
      throw new RangeError('sourceSatoshis must be a non-negative safe integer')
    }
    uint32(spend.inputIndex, 'inputIndex')
    const inputCount = spend.allInputs?.length ?? spend.otherInputs.length + 1
    if (spend.inputIndex >= inputCount)
      throw new RangeError('inputIndex is outside the transaction')
    const verifyFlags =
      options.verifyFlags ?? (spend.verifyFlags === undefined ? undefined : [...spend.verifyFlags])
    const context = {
      transaction: transaction ?? spend.toTransactionUint8Array(),
      lockingScript: spend.lockingScript.toUint8Array(),
      customFlags: verifyFlags === undefined ? undefined : mapVerifyFlags(verifyFlags),
      utxoHeight: options.utxoHeight ?? this.#defaultUtxoHeight,
      blockHeight: options.blockHeight ?? this.#defaultBlockHeight,
      consensus: options.consensus ?? this.#defaultConsensus
    }
    byteArray(context.transaction, 'transaction')
    byteArray(context.lockingScript, 'lockingScript')
    bdkHeight(context.utxoHeight, 'utxoHeight')
    bdkHeight(context.blockHeight, 'blockHeight')
    booleanValue(context.consensus, 'consensus')
    return context
  }

  #verifySpendWithModule(
    bdk: BdkWasmModule,
    spend: Spend,
    options: BdkVerifySpendOptions = {}
  ): BdkVerificationResult {
    if (bdk.VerifySpendArray === undefined) {
      throw new Error('The loaded BDK module does not support Spend verification')
    }
    const context = this.#spendContext(spend, options)
    return bdk.VerifySpendArray(
      context.transaction,
      spend.inputIndex,
      context.lockingScript,
      spend.sourceSatoshis,
      context.utxoHeight,
      context.blockHeight,
      context.consensus,
      context.customFlags !== undefined,
      context.customFlags ?? 0,
      this.#network
    )
  }

  async verifySpendDetailed(
    spend: Spend,
    options: BdkVerifySpendOptions = {}
  ): Promise<BdkVerificationResult> {
    return this.#verifySpendWithModule(await this.#getModule(), spend, options)
  }

  async verifySpend(spend: Spend, options: BdkVerifySpendOptions = {}): Promise<boolean> {
    return verdict(await this.verifySpendDetailed(spend, options))
  }

  verifySpendSync(spend: Spend, options: BdkVerifySpendOptions = {}): boolean {
    if (this.#module === undefined) {
      throw new Error('Synchronous Spend verification requires a preloaded BDK module')
    }
    return verdict(this.#verifySpendWithModule(this.#module, spend, options))
  }

  #packSpendChunk(
    items: readonly BdkSpendBatchItem[],
    contexts: readonly BdkSpendContext[]
  ): SpendBatchPayload {
    const transactions = packArrays(
      contexts.map(item => item.transaction),
      length => new Uint8Array(length)
    )
    const lockingScripts = packArrays(
      contexts.map(item => item.lockingScript),
      length => new Uint8Array(length)
    )
    return {
      transactions: transactions.values,
      transactionOffsets: transactions.offsets,
      inputIndices: Uint32Array.from(items.map(item => item.spend.inputIndex)),
      lockingScripts: lockingScripts.values,
      lockingScriptOffsets: lockingScripts.offsets,
      sourceSatoshis: Float64Array.from(items.map(item => item.spend.sourceSatoshis)),
      utxoHeights: Int32Array.from(contexts.map(item => item.utxoHeight)),
      blockHeights: Int32Array.from(contexts.map(item => item.blockHeight)),
      consensus: Uint8Array.from(contexts.map(item => (item.consensus ? 1 : 0))),
      hasCustomFlags: Uint8Array.from(
        contexts.map(item => (item.customFlags === undefined ? 0 : 1))
      ),
      customFlags: Uint32Array.from(contexts.map(item => item.customFlags ?? 0)),
      network: this.#network
    }
  }

  async verifySpendsBatchDetailed(
    items: readonly BdkSpendBatchItem[]
  ): Promise<BdkVerificationResult[]> {
    if (items.length === 0) return []
    const serializedTransactions: Array<{
      inputs: NonNullable<Spend['allInputs']>
      outputs: Spend['outputs']
      version: number
      lockTime: number
      bytes: Uint8Array
    }> = []
    const allContexts = items.map(item => {
      const spend = item.spend
      const existing =
        spend.allInputs === undefined
          ? undefined
          : serializedTransactions.find(
              candidate =>
                candidate.inputs === spend.allInputs &&
                candidate.outputs === spend.outputs &&
                candidate.version === spend.transactionVersion &&
                candidate.lockTime === spend.lockTime
            )
      const transaction = existing?.bytes ?? spend.toTransactionUint8Array()
      if (existing === undefined && spend.allInputs !== undefined) {
        serializedTransactions.push({
          inputs: spend.allInputs,
          outputs: spend.outputs,
          version: spend.transactionVersion,
          lockTime: spend.lockTime,
          bytes: transaction
        })
      }
      return this.#spendContext(spend, item, transaction)
    })
    if (
      this.#workerScheduler?.shouldUse(items.length, async () => await this.preloadBatch()) === true
    ) {
      const indexedItems = items.map((item, index) => ({
        item,
        context: allContexts[index]
      }))
      const chunks = this.#workerScheduler.parallelChunks(
        indexedItems,
        entry => entry.context.transaction.byteLength + entry.context.lockingScript.byteLength + 32
      )
      if (chunks.length > 1) {
        const results = await this.#workerScheduler.execute(
          chunks.map(chunk => ({
            operation: 'verifySpends' as const,
            payload: this.#packSpendChunk(
              chunk.map(entry => entry.item),
              chunk.map(entry => entry.context)
            )
          }))
        )
        return results.flatMap((result, index) => {
          if (!(result instanceof Int32Array)) {
            throw new TypeError('BDK Spend worker returned an invalid result type')
          }
          return decodeResults(result, chunks[index].length)
        })
      }
    }
    const bdk = await this.#getModule()
    if (bdk.VerifySpendBatchArray === undefined) {
      return items.map(item => this.#verifySpendWithModule(bdk, item.spend, item))
    }
    const verifySpendBatch = bdk.VerifySpendBatchArray

    const results: BdkVerificationResult[] = []
    let chunk: BdkSpendBatchItem[] = []
    let contexts: BdkSpendContext[] = []
    let chunkBytes = 0

    const flush = (): void => {
      if (chunk.length === 0) return
      const payload = this.#packSpendChunk(chunk, contexts)
      const flat = verifySpendBatch(
        payload.transactions,
        payload.transactionOffsets,
        payload.inputIndices,
        payload.lockingScripts,
        payload.lockingScriptOffsets,
        payload.sourceSatoshis,
        payload.utxoHeights,
        payload.blockHeights,
        payload.consensus,
        payload.hasCustomFlags,
        payload.customFlags,
        payload.network
      )
      results.push(...decodeResults(flat, chunk.length))
      chunk = []
      contexts = []
      chunkBytes = 0
    }

    for (let index = 0; index < items.length; index++) {
      const item = items[index]
      const context = allContexts[index]
      const itemBytes = context.transaction.byteLength + context.lockingScript.byteLength + 32
      if (
        chunk.length > 0 &&
        (chunk.length >= this.#maxBatchItems || chunkBytes + itemBytes > this.#maxBatchBytes)
      ) {
        flush()
      }
      chunk.push(item)
      contexts.push(context)
      chunkBytes += itemBytes
    }
    flush()
    return results
  }

  async verifySpendsBatch(items: readonly BdkSpendBatchItem[]): Promise<boolean[]> {
    return (await this.verifySpendsBatchDetailed(items)).map(verdict)
  }

  #requiredCryptoMethod<K extends keyof BdkWasmModule>(
    bdk: BdkWasmModule,
    method: K
  ): NonNullable<BdkWasmModule[K]> {
    const implementation = bdk[method]
    if (implementation === undefined) {
      throw new Error(`The loaded BDK module does not support ${String(method)}`)
    }
    return implementation as NonNullable<BdkWasmModule[K]>
  }

  async signDigest(privateKey: Uint8Array, digest: Uint8Array): Promise<Uint8Array> {
    fixedByteArray(privateKey, 32, 'privateKey')
    fixedByteArray(digest, 32, 'digest')
    const bdk = await this.#getModule()
    return signatureBytes(this.#requiredCryptoMethod(bdk, 'SignDigest')(privateKey, digest))
  }

  async verifyDigest(
    publicKey: Uint8Array,
    digest: Uint8Array,
    signature: Uint8Array
  ): Promise<boolean> {
    publicKeyBytes(publicKey)
    fixedByteArray(digest, 32, 'digest')
    signatureBytes(signature)
    const bdk = await this.#getModule()
    const result = this.#requiredCryptoMethod(bdk, 'VerifyDigest')(publicKey, digest, signature)
    if (typeof result !== 'boolean')
      throw new TypeError('VerifyDigest returned a non-boolean result')
    return result
  }

  #packDigestBatch(items: readonly BdkDigestVerification[]): DigestBatchPayload {
    for (let index = 0; index < items.length; index++) {
      publicKeyBytes(items[index].publicKey, `items[${index}].publicKey`)
      fixedByteArray(items[index].digest, 32, `items[${index}].digest`)
      signatureBytes(items[index].signature, `items[${index}].signature`)
    }
    const publicKeys = packArrays(
      items.map(item => item.publicKey),
      length => new Uint8Array(length)
    )
    const signatures = packArrays(
      items.map(item => item.signature),
      length => new Uint8Array(length)
    )
    const digests = new Uint8Array(items.length * 32)
    for (let index = 0; index < items.length; index++) {
      digests.set(items[index].digest, index * 32)
    }
    return {
      publicKeys: publicKeys.values,
      publicKeyOffsets: publicKeys.offsets,
      digests,
      signatures: signatures.values,
      signatureOffsets: signatures.offsets
    }
  }

  async verifyDigestBatch(items: readonly BdkDigestVerification[]): Promise<boolean[]> {
    if (items.length === 0) return []
    if (
      this.#workerScheduler?.shouldUse(items.length, async () => await this.preloadBatch()) === true
    ) {
      const chunks = this.#workerScheduler.parallelChunks(items, digestBytes)
      if (chunks.length > 1) {
        const results = await this.#workerScheduler.execute(
          chunks.map(chunk => ({
            operation: 'verifyDigests' as const,
            payload: this.#packDigestBatch(chunk)
          }))
        )
        return results.flatMap((result, index) => {
          return digestVerdicts(result as Uint8Array, chunks[index].length)
        })
      }
    }
    const chunks = chunksBySize(items, this.#maxBatchItems, this.#maxBatchBytes, digestBytes)
    if (chunks.length > 1) {
      const results: boolean[] = []
      for (const batch of chunks) {
        results.push(...(await this.verifyDigestBatch(batch)))
      }
      return results
    }
    const bdk = await this.#getModule()
    const verifyBatch = this.#requiredCryptoMethod(bdk, 'VerifyDigestBatchArray')
    const payload = this.#packDigestBatch(items)
    const results = verifyBatch(
      payload.publicKeys,
      payload.publicKeyOffsets,
      payload.digests,
      payload.signatures,
      payload.signatureOffsets
    )
    return digestVerdicts(results, items.length)
  }

  async #compressedPublicKey(
    method: 'PublicKeyFromPrivate' | 'MultiplyPublicKey' | 'TweakPublicKeyAdd',
    values: [Uint8Array] | [Uint8Array, Uint8Array]
  ): Promise<Uint8Array> {
    const implementation = this.#requiredCryptoMethod(await this.#getModule(), method) as (
      ...args: Uint8Array[]
    ) => Uint8Array
    const result = implementation(...values)
    byteArray(result, `${method} result`)
    if (result.length !== 33) throw new Error(`${method} returned a non-compressed key`)
    return result
  }

  async publicKeyFromPrivate(privateKey: Uint8Array): Promise<Uint8Array> {
    fixedByteArray(privateKey, 32, 'privateKey')
    return this.#compressedPublicKey('PublicKeyFromPrivate', [privateKey])
  }

  async multiplyPublicKey(publicKey: Uint8Array, scalar: Uint8Array): Promise<Uint8Array> {
    publicKeyBytes(publicKey)
    fixedByteArray(scalar, 32, 'scalar')
    return this.#compressedPublicKey('MultiplyPublicKey', [publicKey, scalar])
  }

  async tweakPublicKeyAdd(publicKey: Uint8Array, tweak: Uint8Array): Promise<Uint8Array> {
    publicKeyBytes(publicKey)
    fixedByteArray(tweak, 32, 'tweak')
    return this.#compressedPublicKey('TweakPublicKeyAdd', [publicKey, tweak])
  }

  async tweakPrivateKeyAdd(privateKey: Uint8Array, tweak: Uint8Array): Promise<Uint8Array> {
    fixedByteArray(privateKey, 32, 'privateKey')
    fixedByteArray(tweak, 32, 'tweak')
    const bdk = await this.#getModule()
    return fixedByteArray(
      this.#requiredCryptoMethod(bdk, 'TweakPrivateKeyAdd')(privateKey, tweak),
      32,
      'TweakPrivateKeyAdd result'
    )
  }
}
