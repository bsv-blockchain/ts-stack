import type {
  AsyncCryptoBackend,
  AsyncCryptoOperation,
  Spend
} from '@bsv/sdk'
import {
  decodeResults,
  flagsForInputCount,
  packArrays,
  verdict
} from './BdkBatch.js'
import type BdkVerifierInterface from './BdkVerifierInterface.js'
import { mapVerifyFlags } from './flags.js'
import {
  DEFAULT_VERIFAST_SCRIPT_BYTE_THRESHOLD,
  POST_CHRONICLE_HEIGHT_FALLBACK,
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

function toVector<T> (Vector: EmbindVectorCtor<T>, values: Iterable<T>): EmbindVector<T> {
  const vec = new Vector()
  for (const value of values) vec.push_back(value)
  return vec
}

interface OptionalBackendGlobal {
  __bsvSdkAsyncCryptoBackendV1?: AsyncCryptoBackend
  __bsvSdkScriptVerificationBackendV1?: BdkVerifierCore
}

function backendGlobal (): typeof globalThis & OptionalBackendGlobal {
  return globalThis as typeof globalThis & OptionalBackendGlobal
}

/**
 * Shared platform-neutral implementation. Node and browser entry points inject
 * different Emscripten loader glue but use this exact verifier and batch logic.
 */
export default class BdkVerifierCore implements BdkVerifierInterface, AsyncCryptoBackend {
  private module: BdkWasmModule | undefined
  private loading: Promise<BdkWasmModule> | undefined
  private preloadScheduled = false
  private readonly network: number
  private readonly mode: BdkVerifierMode
  private readonly scriptByteThreshold: number
  private readonly maxBatchItems: number
  private readonly maxBatchBytes: number
  private readonly defaultUtxoHeight: number
  private readonly defaultBlockHeight: number
  private readonly defaultConsensus: boolean
  private readonly registeredAsDefault: boolean
  private modulePrepared = false

  constructor (
    private readonly factory: BdkWasmFactory,
    options: BdkVerifierOptions = {},
    private readonly workerScheduler?: BdkWorkerScheduler
  ) {
    this.network = NETWORK_IDS[options.network ?? 'main']
    this.mode = options.mode ?? 'auto'
    this.scriptByteThreshold = options.scriptByteThreshold ?? DEFAULT_VERIFAST_SCRIPT_BYTE_THRESHOLD
    this.maxBatchItems = options.maxBatchItems ?? 256
    this.maxBatchBytes = options.maxBatchBytes ?? 32 * 1024 * 1024
    this.defaultUtxoHeight = options.defaultUtxoHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
    this.defaultBlockHeight = options.defaultBlockHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
    this.defaultConsensus = options.defaultConsensus ?? true
    this.registeredAsDefault = options.registerAsDefault ?? true
    if (this.mode !== 'auto' && this.mode !== 'always') {
      throw new RangeError("mode must be either 'auto' or 'always'")
    }
    if (!Number.isSafeInteger(this.scriptByteThreshold) || this.scriptByteThreshold < 0) {
      throw new RangeError('scriptByteThreshold must be a non-negative safe integer')
    }
    if (!Number.isSafeInteger(this.maxBatchItems) || this.maxBatchItems < 1) {
      throw new RangeError('maxBatchItems must be a positive safe integer')
    }
    if (!Number.isSafeInteger(this.maxBatchBytes) || this.maxBatchBytes < 1) {
      throw new RangeError('maxBatchBytes must be a positive safe integer')
    }
    if (
      options.batchWorkers !== undefined &&
      (!Number.isSafeInteger(options.batchWorkers) ||
        options.batchWorkers < 1 ||
        options.batchWorkers > 16)
    ) {
      throw new RangeError('batchWorkers must be a safe integer from 1 to 16')
    }
    if (
      !Number.isSafeInteger(options.batchWorkerThreshold ?? 32) ||
      (options.batchWorkerThreshold ?? 32) < 2
    ) {
      throw new RangeError('batchWorkerThreshold must be a safe integer of at least 2')
    }
    if (this.registeredAsDefault) {
      const registry = backendGlobal()
      registry.__bsvSdkAsyncCryptoBackendV1 = this
      registry.__bsvSdkScriptVerificationBackendV1 = this
    }
  }

  private async getModule (): Promise<BdkWasmModule> {
    if (this.module !== undefined) return this.module
    this.loading ??= this.factory().then((module) => {
      this.module = module
      return module
    })
    return await this.loading
  }

  /** Load and instantiate the optional backend before latency-sensitive work. */
  async preload (): Promise<void> {
    const module = await this.getModule()
    if (this.modulePrepared) return
    module.PrepareVerification?.()
    module.PrepareSigning?.()
    this.modulePrepared = true
  }

  /**
   * Warm both the main module and the explicit large-batch worker pool.
   * Single-item verification never waits for or dispatches through this pool.
   */
  async preloadBatch (): Promise<void> {
    await this.preload()
    if (this.workerScheduler !== undefined && this.module !== undefined) {
      await this.workerScheduler.preload(this.module)
    }
  }

  /** True only after the WASM module has finished loading successfully. */
  isReady (): boolean {
    return this.module !== undefined
  }

  /** Stop using this instance as the SDK's optional default backend. */
  dispose (): void {
    this.workerScheduler?.terminate()
    if (!this.registeredAsDefault) return
    const registry = backendGlobal()
    if (registry.__bsvSdkAsyncCryptoBackendV1 === this) {
      delete registry.__bsvSdkAsyncCryptoBackendV1
    }
    if (registry.__bsvSdkScriptVerificationBackendV1 === this) {
      delete registry.__bsvSdkScriptVerificationBackendV1
    }
  }

  supportsCrypto (operation: AsyncCryptoOperation): boolean {
    const bdk = this.module
    if (bdk === undefined) return false
    switch (operation) {
      case 'signDigest': return bdk.SignDigest !== undefined
      case 'verifyDigest': return bdk.VerifyDigest !== undefined
      case 'verifyDigestBatch': return bdk.VerifyDigestBatchArray !== undefined
      case 'publicKeyFromPrivate': return bdk.PublicKeyFromPrivate !== undefined
      case 'multiplyPublicKey': return bdk.MultiplyPublicKey !== undefined
      case 'tweakPublicKeyAdd': return bdk.TweakPublicKeyAdd !== undefined
      case 'tweakPrivateKeyAdd': return bdk.TweakPrivateKeyAdd !== undefined
    }
  }

  private schedulePreload (): void {
    if (this.module !== undefined || this.loading !== undefined || this.preloadScheduled) return
    this.preloadScheduled = true
    setTimeout(() => {
      this.preloadScheduled = false
      void this.preload().catch(() => {})
    }, 0)
  }

  private prepareCandidate (): boolean {
    if (this.mode === 'always') return true
    if (this.isReady()) return true
    // Auto mode never waits on cold WASM. A later eligible call can use the
    // completed load, while this call keeps the exact JavaScript path.
    this.schedulePreload()
    return false
  }

  /** Selection hook consumed by Transaction.verify without coupling the SDK to this package. */
  shouldVerifyScripts (params: BdkVerifyParams): boolean {
    if (this.mode === 'always') return true
    const candidate = params.tx.inputs.some(input => {
      const sourceOutput = input.sourceTransaction?.outputs[input.sourceOutputIndex]
      return sourceOutput !== undefined &&
        isVeriFastCandidateScript(sourceOutput.lockingScript, this.scriptByteThreshold)
    })
    return candidate && this.prepareCandidate()
  }

  /** Selection hook consumed by Spend.validateWith. */
  shouldVerifySpend (spend: Spend): boolean {
    if (this.mode === 'always') return true
    if (this.module !== undefined && this.module.VerifySpendArray === undefined) return false
    return isVeriFastCandidateScript(spend.lockingScript, this.scriptByteThreshold) &&
      this.prepareCandidate()
  }

  private transactionParams (params: BdkVerifyParams): BdkVerifyFromEFParams {
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

  private verifyFromEFWithModule (
    bdk: BdkWasmModule,
    params: BdkVerifyFromEFParams
  ): BdkVerificationResult {
    const heights = Int32Array.from(params.utxoHeights)
    const customFlags = flagsForInputCount(heights.length, params.verifyFlags, params.customFlags)

    if (bdk.VerifyScriptArrayNetwork !== undefined) {
      return bdk.VerifyScriptArrayNetwork(
        params.extendedTransaction, heights, params.blockHeight,
        params.consensus, customFlags, this.network
      )
    }
    if (this.network !== NETWORK_IDS.main) {
      throw new Error('The loaded BDK module does not support explicit networks')
    }
    if (bdk.VerifyScriptArray !== undefined) {
      return bdk.VerifyScriptArray(
        params.extendedTransaction, heights, params.blockHeight,
        params.consensus, customFlags
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
    const extendedTX = toVector(VectorUInt8, params.extendedTransaction)
    const utxoHeights = toVector(VectorInt32, heights)
    const flags = toVector(VectorUInt32, customFlags)
    try {
      return verifyScript(
        extendedTX, utxoHeights, params.blockHeight, params.consensus, flags
      )
    } finally {
      extendedTX.delete()
      utxoHeights.delete()
      flags.delete()
    }
  }

  async verifyScriptsDetailed (params: BdkVerifyParams): Promise<BdkVerificationResult> {
    return await this.verifyScriptsFromEFDetailed(this.transactionParams(params))
  }

  async verifyScriptsFromEFDetailed (params: BdkVerifyFromEFParams): Promise<BdkVerificationResult> {
    return this.verifyFromEFWithModule(await this.getModule(), params)
  }

  async verifyScripts (params: BdkVerifyParams): Promise<boolean> {
    return verdict(await this.verifyScriptsDetailed(params))
  }

  async verifyScriptsFromEF (params: BdkVerifyFromEFParams): Promise<boolean> {
    return verdict(await this.verifyScriptsFromEFDetailed(params))
  }

  private chunkEFParams (params: readonly BdkVerifyFromEFParams[]): BdkVerifyFromEFParams[][] {
    const chunks: BdkVerifyFromEFParams[][] = []
    let chunk: BdkVerifyFromEFParams[] = []
    let bytes = 0
    for (const item of params) {
      const itemBytes = item.extendedTransaction.byteLength + item.utxoHeights.length * 4 +
        (item.customFlags?.length ?? 0) * 4
      if (itemBytes > this.maxBatchBytes) {
        throw new RangeError(`A BDK batch item exceeds maxBatchBytes (${this.maxBatchBytes})`)
      }
      if (chunk.length > 0 && (chunk.length >= this.maxBatchItems || bytes + itemBytes > this.maxBatchBytes)) {
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

  private packEFChunk (
    chunk: readonly BdkVerifyFromEFParams[]
  ): ScriptBatchPayload {
    const transactions = packArrays(chunk.map(item => item.extendedTransaction), length => new Uint8Array(length))
    const heightsByItem = chunk.map(item => Int32Array.from(item.utxoHeights))
    const heights = packArrays(heightsByItem, length => new Int32Array(length))
    const flagsByItem = chunk.map((item, index) =>
      flagsForInputCount(heightsByItem[index].length, item.verifyFlags, item.customFlags)
    )
    const flags = packArrays(flagsByItem, length => new Uint32Array(length))
    return {
      extendedTransactions: transactions.values,
      transactionOffsets: transactions.offsets,
      utxoHeights: heights.values,
      heightOffsets: heights.offsets,
      blockHeights: Int32Array.from(chunk.map(item => item.blockHeight)),
      consensus: Uint8Array.from(chunk.map(item => item.consensus ? 1 : 0)),
      customFlags: flags.values,
      customFlagOffsets: flags.offsets,
      network: this.network
    }
  }

  private verifyEFChunk (bdk: BdkWasmModule, chunk: readonly BdkVerifyFromEFParams[]): BdkVerificationResult[] {
    if (bdk.VerifyScriptBatchArray === undefined) {
      return chunk.map(params => this.verifyFromEFWithModule(bdk, params))
    }
    const payload = this.packEFChunk(chunk)
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

  async verifyScriptsBatchDetailed (params: readonly BdkVerifyParams[]): Promise<BdkVerificationResult[]> {
    return await this.verifyScriptsBatchFromEFDetailed(params.map(item => this.transactionParams(item)))
  }

  async verifyScriptsBatchFromEFDetailed (params: readonly BdkVerifyFromEFParams[]): Promise<BdkVerificationResult[]> {
    if (params.length === 0) return []
    if (this.workerScheduler?.shouldUse(
      params.length, async () => await this.preloadBatch()
    ) === true) {
      const chunks = this.workerScheduler.parallelChunks(
        params,
        item => item.extendedTransaction.byteLength +
          item.utxoHeights.length * 4 +
          (item.customFlags?.length ?? 0) * 4
      )
      if (chunks.length > 1) {
        const results = await this.workerScheduler.execute(chunks.map(chunk => ({
          operation: 'verifyScripts' as const,
          payload: this.packEFChunk(chunk)
        })))
        return results.flatMap((result, index) => {
          if (!(result instanceof Int32Array)) {
            throw new Error('BDK script worker returned an invalid result type')
          }
          return decodeResults(result, chunks[index].length)
        })
      }
    }
    const bdk = await this.getModule()
    return this.chunkEFParams(params).flatMap(chunk => this.verifyEFChunk(bdk, chunk))
  }

  async verifyScriptsBatch (params: readonly BdkVerifyParams[]): Promise<boolean[]> {
    return (await this.verifyScriptsBatchDetailed(params)).map(verdict)
  }

  async verifyScriptsBatchFromEF (params: readonly BdkVerifyFromEFParams[]): Promise<boolean[]> {
    return (await this.verifyScriptsBatchFromEFDetailed(params)).map(verdict)
  }

  private spendContext (
    spend: Spend,
    options: BdkVerifySpendOptions = {}
  ): BdkSpendContext {
    const verifyFlags = options.verifyFlags ?? (spend.verifyFlags === undefined ? undefined : [...spend.verifyFlags])
    return {
      transaction: spend.toTransactionUint8Array(),
      lockingScript: spend.lockingScript.toUint8Array(),
      customFlags: verifyFlags === undefined ? undefined : mapVerifyFlags(verifyFlags),
      utxoHeight: options.utxoHeight ?? this.defaultUtxoHeight,
      blockHeight: options.blockHeight ?? this.defaultBlockHeight,
      consensus: options.consensus ?? this.defaultConsensus
    }
  }

  private verifySpendWithModule (
    bdk: BdkWasmModule,
    spend: Spend,
    options: BdkVerifySpendOptions = {}
  ): BdkVerificationResult {
    if (bdk.VerifySpendArray === undefined) {
      throw new Error('The loaded BDK module does not support Spend verification')
    }
    const context = this.spendContext(spend, options)
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
      this.network
    )
  }

  async verifySpendDetailed (spend: Spend, options: BdkVerifySpendOptions = {}): Promise<BdkVerificationResult> {
    return this.verifySpendWithModule(await this.getModule(), spend, options)
  }

  async verifySpend (spend: Spend, options: BdkVerifySpendOptions = {}): Promise<boolean> {
    return verdict(await this.verifySpendDetailed(spend, options))
  }

  verifySpendSync (spend: Spend, options: BdkVerifySpendOptions = {}): boolean {
    if (this.module === undefined) {
      throw new Error('Synchronous Spend verification requires a preloaded BDK module')
    }
    return verdict(this.verifySpendWithModule(this.module, spend, options))
  }

  private packSpendChunk (
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
      consensus: Uint8Array.from(contexts.map(item => item.consensus ? 1 : 0)),
      hasCustomFlags: Uint8Array.from(
        contexts.map(item => item.customFlags === undefined ? 0 : 1)
      ),
      customFlags: Uint32Array.from(contexts.map(item => item.customFlags ?? 0)),
      network: this.network
    }
  }

  async verifySpendsBatchDetailed (items: readonly BdkSpendBatchItem[]): Promise<BdkVerificationResult[]> {
    if (items.length === 0) return []
    const allContexts = items.map(item => this.spendContext(item.spend, item))
    if (this.workerScheduler?.shouldUse(
      items.length, async () => await this.preloadBatch()
    ) === true) {
      const indexedItems = items.map((item, index) => ({
        item,
        context: allContexts[index]
      }))
      const chunks = this.workerScheduler.parallelChunks(
        indexedItems,
        entry => entry.context.transaction.byteLength +
          entry.context.lockingScript.byteLength + 32
      )
      if (chunks.length > 1) {
        const results = await this.workerScheduler.execute(chunks.map(chunk => ({
          operation: 'verifySpends' as const,
          payload: this.packSpendChunk(
            chunk.map(entry => entry.item),
            chunk.map(entry => entry.context)
          )
        })))
        return results.flatMap((result, index) => {
          if (!(result instanceof Int32Array)) {
            throw new Error('BDK Spend worker returned an invalid result type')
          }
          return decodeResults(result, chunks[index].length)
        })
      }
    }
    const bdk = await this.getModule()
    if (bdk.VerifySpendBatchArray === undefined) {
      return items.map(item => this.verifySpendWithModule(bdk, item.spend, item))
    }
    const verifySpendBatch = bdk.VerifySpendBatchArray

    const results: BdkVerificationResult[] = []
    let chunk: BdkSpendBatchItem[] = []
    let contexts: BdkSpendContext[] = []
    let chunkBytes = 0

    const flush = (): void => {
      if (chunk.length === 0) return
      const payload = this.packSpendChunk(chunk, contexts)
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
      if (itemBytes > this.maxBatchBytes) {
        throw new RangeError(`A BDK Spend batch item exceeds maxBatchBytes (${this.maxBatchBytes})`)
      }
      if (chunk.length > 0 && (chunk.length >= this.maxBatchItems || chunkBytes + itemBytes > this.maxBatchBytes)) {
        flush()
      }
      chunk.push(item)
      contexts.push(context)
      chunkBytes += itemBytes
    }
    flush()
    return results
  }

  async verifySpendsBatch (items: readonly BdkSpendBatchItem[]): Promise<boolean[]> {
    return (await this.verifySpendsBatchDetailed(items)).map(verdict)
  }

  private requiredCryptoMethod<K extends keyof BdkWasmModule> (
    bdk: BdkWasmModule,
    method: K
  ): NonNullable<BdkWasmModule[K]> {
    const implementation = bdk[method]
    if (implementation === undefined) {
      throw new Error(`The loaded BDK module does not support ${String(method)}`)
    }
    return implementation as NonNullable<BdkWasmModule[K]>
  }

  async signDigest (privateKey: Uint8Array, digest: Uint8Array): Promise<Uint8Array> {
    const bdk = await this.getModule()
    return this.requiredCryptoMethod(bdk, 'SignDigest')(privateKey, digest)
  }

  async verifyDigest (
    publicKey: Uint8Array,
    digest: Uint8Array,
    signature: Uint8Array
  ): Promise<boolean> {
    const bdk = await this.getModule()
    return this.requiredCryptoMethod(bdk, 'VerifyDigest')(
      publicKey, digest, signature
    )
  }

  private packDigestBatch (
    items: readonly BdkDigestVerification[]
  ): DigestBatchPayload {
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
      if (items[index].digest.length !== 32) {
        throw new RangeError('Each digest must contain exactly 32 bytes')
      }
      digests.set(items[index].digest, index * 32)
    }
    const packedBytes = publicKeys.values.byteLength +
      signatures.values.byteLength + digests.byteLength
    if (packedBytes > this.maxBatchBytes) {
      throw new RangeError(`A digest batch exceeds maxBatchBytes (${this.maxBatchBytes})`)
    }
    return {
      publicKeys: publicKeys.values,
      publicKeyOffsets: publicKeys.offsets,
      digests,
      signatures: signatures.values,
      signatureOffsets: signatures.offsets
    }
  }

  async verifyDigestBatch (
    items: readonly BdkDigestVerification[]
  ): Promise<boolean[]> {
    if (items.length === 0) return []
    if (this.workerScheduler?.shouldUse(
      items.length, async () => await this.preloadBatch()
    ) === true) {
      const chunks = this.workerScheduler.parallelChunks(
        items,
        item => item.publicKey.byteLength +
          item.digest.byteLength +
          item.signature.byteLength
      )
      if (chunks.length > 1) {
        const results = await this.workerScheduler.execute(chunks.map(chunk => ({
          operation: 'verifyDigests' as const,
          payload: this.packDigestBatch(chunk)
        })))
        return results.flatMap((result, index) => {
          if (!(result instanceof Uint8Array) || result.length !== chunks[index].length) {
            throw new Error('BDK digest worker returned an invalid result')
          }
          return Array.from(result, verdict => verdict === 1)
        })
      }
    }
    if (items.length > this.maxBatchItems) {
      const results: boolean[] = []
      for (let offset = 0; offset < items.length; offset += this.maxBatchItems) {
        results.push(...await this.verifyDigestBatch(
          items.slice(offset, offset + this.maxBatchItems)
        ))
      }
      return results
    }
    const bdk = await this.getModule()
    const verifyBatch = this.requiredCryptoMethod(bdk, 'VerifyDigestBatchArray')
    const payload = this.packDigestBatch(items)
    const results = verifyBatch(
      payload.publicKeys,
      payload.publicKeyOffsets,
      payload.digests,
      payload.signatures,
      payload.signatureOffsets
    )
    if (results.length !== items.length) {
      throw new Error('BDK returned an invalid digest batch result count')
    }
    return Array.from(results, result => result === 1)
  }

  async publicKeyFromPrivate (privateKey: Uint8Array): Promise<Uint8Array> {
    const bdk = await this.getModule()
    return this.requiredCryptoMethod(bdk, 'PublicKeyFromPrivate')(privateKey)
  }

  async multiplyPublicKey (
    publicKey: Uint8Array,
    scalar: Uint8Array
  ): Promise<Uint8Array> {
    const bdk = await this.getModule()
    return this.requiredCryptoMethod(bdk, 'MultiplyPublicKey')(publicKey, scalar)
  }

  async tweakPublicKeyAdd (
    publicKey: Uint8Array,
    tweak: Uint8Array
  ): Promise<Uint8Array> {
    const bdk = await this.getModule()
    return this.requiredCryptoMethod(bdk, 'TweakPublicKeyAdd')(publicKey, tweak)
  }

  async tweakPrivateKeyAdd (
    privateKey: Uint8Array,
    tweak: Uint8Array
  ): Promise<Uint8Array> {
    const bdk = await this.getModule()
    return this.requiredCryptoMethod(bdk, 'TweakPrivateKeyAdd')(privateKey, tweak)
  }
}
