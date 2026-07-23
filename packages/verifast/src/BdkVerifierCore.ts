import type { Script, Spend, Transaction } from '@bsv/sdk'
import type BdkVerifierInterface from './BdkVerifierInterface.js'
import { mapVerifyFlags } from './flags.js'

/** Height used when an input's source UTXO mined-height is unobtainable (post-Chronicle). */
export const POST_CHRONICLE_HEIGHT_FALLBACK = 943816

export enum BdkErrorDomain {
  OK = 0,
  SCRIPT = 1,
  DOS = 2,
  EXCEPTION = 3
}

export type BdkNetwork =
  | 'main'
  | 'test'
  | 'stn'
  | 'regtest'
  | 'ttn'
  | 'teratestnet'
  | 'terratestnet'
  | 'tstn'

export interface BdkVerificationResult {
  domain: number
  code: number
}

export interface BdkVerifyParams {
  tx: Transaction
  blockHeight: number
  consensus: boolean
  verifyFlags?: string | string[]
}

export type BdkVerifierMode = 'auto' | 'always'

export interface BdkVerifyFromEFParams {
  extendedTransaction: Uint8Array
  utxoHeights: readonly number[] | Int32Array
  blockHeight: number
  consensus: boolean
  verifyFlags?: string | string[]
  customFlags?: readonly number[] | Uint32Array
}

export interface BdkVerifySpendOptions {
  utxoHeight?: number
  blockHeight?: number
  consensus?: boolean
  verifyFlags?: string | string[]
}

export interface BdkSpendBatchItem extends BdkVerifySpendOptions {
  spend: Spend
}

export interface BdkVerifierOptions {
  network?: BdkNetwork
  /**
   * `auto` uses WASM only when it is ready and a source locking script is
   * signature-bearing or larger than `scriptByteThreshold`. `always` preserves
   * strict eager backend selection for callers that require it.
   */
  mode?: BdkVerifierMode
  /** Script byte length above which auto mode selects WASM. Defaults to 100. */
  scriptByteThreshold?: number
  maxBatchItems?: number
  maxBatchBytes?: number
  defaultUtxoHeight?: number
  defaultBlockHeight?: number
  defaultConsensus?: boolean
}

/** Default auto-routing boundary; scripts strictly larger than this use WASM. */
export const DEFAULT_VERIFAST_SCRIPT_BYTE_THRESHOLD = 100

const SIGNATURE_OPS = new Set<number>([
  0xac, // OP_CHECKSIG
  0xad, // OP_CHECKSIGVERIFY
  0xae, // OP_CHECKMULTISIG
  0xaf // OP_CHECKMULTISIGVERIFY
])

/**
 * Returns true when a locking script belongs to a workload class with a proven
 * WASM advantage: more than the byte threshold or an executed signature opcode.
 * Pushed data is not scanned as opcodes, avoiding false positives.
 */
export function isVeriFastCandidateScript (
  script: Script,
  scriptByteThreshold: number = DEFAULT_VERIFAST_SCRIPT_BYTE_THRESHOLD
): boolean {
  if (!Number.isSafeInteger(scriptByteThreshold) || scriptByteThreshold < 0) {
    throw new RangeError('scriptByteThreshold must be a non-negative safe integer')
  }
  if (script.toUint8Array().byteLength > scriptByteThreshold) return true
  return script.chunks.some(chunk => SIGNATURE_OPS.has(chunk.op))
}

/** Raised when BDK reports an exception domain, malformed result, or unknown ABI domain. */
export class BdkVerificationError extends Error {
  constructor (public readonly result: BdkVerificationResult) {
    super(`BDK verification failed in domain ${result.domain} with code ${result.code}`)
    this.name = 'BdkVerificationError'
  }
}

/** Minimal embind vector surface used by the legacy adapter. */
interface EmbindVector<T> {
  push_back: (value: T) => void
  delete: () => void
}

type EmbindVectorCtor<T> = new () => EmbindVector<T>

type BdkVerifyScriptBatchArray = (...args: [
  extendedTXs: Uint8Array,
  txOffsets: Uint32Array,
  utxoHeights: Int32Array,
  heightOffsets: Uint32Array,
  blockHeights: Int32Array,
  consensus: Uint8Array,
  customFlags: Uint32Array,
  customFlagOffsets: Uint32Array,
  network: number
]) => Int32Array

type BdkVerifySpendArray = (...args: [
  transaction: Uint8Array,
  inputIndex: number,
  lockingScript: Uint8Array,
  sourceSatoshis: number,
  utxoHeight: number,
  blockHeight: number,
  consensus: boolean,
  hasCustomFlags: boolean,
  customFlags: number,
  network: number
]) => BdkVerificationResult

type BdkVerifySpendBatchArray = (...args: [
  transactions: Uint8Array,
  transactionOffsets: Uint32Array,
  inputIndices: Uint32Array,
  lockingScripts: Uint8Array,
  lockingScriptOffsets: Uint32Array,
  sourceSatoshis: Float64Array,
  utxoHeights: Int32Array,
  blockHeights: Int32Array,
  consensus: Uint8Array,
  hasCustomFlags: Uint8Array,
  customFlags: Uint32Array,
  network: number
]) => Int32Array

/** The BDK WASM verifier ABI. New methods remain optional for custom older modules. */
export interface BdkWasmModule {
  VectorUInt8: EmbindVectorCtor<number>
  VectorInt32: EmbindVectorCtor<number>
  VectorUInt32: EmbindVectorCtor<number>
  VerifyScript: (
    extendedTX: EmbindVector<number>,
    utxoHeights: EmbindVector<number>,
    blockHeight: number,
    consensus: boolean,
    customFlags: EmbindVector<number>
  ) => BdkVerificationResult
  VerifyScriptArray?: (
    extendedTX: Uint8Array,
    utxoHeights: Int32Array,
    blockHeight: number,
    consensus: boolean,
    customFlags: Uint32Array
  ) => BdkVerificationResult
  VerifyScriptArrayNetwork?: (
    extendedTX: Uint8Array,
    utxoHeights: Int32Array,
    blockHeight: number,
    consensus: boolean,
    customFlags: Uint32Array,
    network: number
  ) => BdkVerificationResult
  VerifyScriptBatchArray?: BdkVerifyScriptBatchArray
  VerifySpendArray?: BdkVerifySpendArray
  VerifySpendBatchArray?: BdkVerifySpendBatchArray
}

/** Async factory that loads/instantiates the BDK WASM module. */
export type BdkWasmFactory = () => Promise<BdkWasmModule>

interface PackedArrays<T extends Uint8Array | Int32Array | Uint32Array> {
  values: T
  offsets: Uint32Array
}

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

function flagsForInputCount (
  inputCount: number,
  verifyFlags?: string | string[],
  customFlags?: readonly number[] | Uint32Array
): Uint32Array {
  if (customFlags !== undefined) {
    if (customFlags.length !== 0 && customFlags.length !== inputCount) {
      throw new RangeError('Custom flag count must be zero or match the input count')
    }
    return Uint32Array.from(customFlags)
  }
  if (verifyFlags === undefined) return new Uint32Array()
  return new Uint32Array(inputCount).fill(mapVerifyFlags(verifyFlags))
}

function packArrays<T extends Uint8Array | Int32Array | Uint32Array> (
  arrays: readonly T[],
  make: (length: number) => T
): PackedArrays<T> {
  const offsets = new Uint32Array(arrays.length + 1)
  let length = 0
  for (let index = 0; index < arrays.length; index++) {
    length += arrays[index].length
    if (length > 0xffffffff) throw new RangeError('Packed BDK batch exceeds 4 GiB offset space')
    offsets[index + 1] = length
  }
  const values = make(length)
  let position = 0
  for (const array of arrays) {
    values.set(array, position)
    position += array.length
  }
  return { values, offsets }
}

function decodeResults (flat: Int32Array, count: number): BdkVerificationResult[] {
  if (flat.length !== count * 2) {
    throw new BdkVerificationError({ domain: BdkErrorDomain.EXCEPTION, code: 0 })
  }
  return Array.from({ length: count }, (_, index) => ({
    domain: flat[index * 2],
    code: flat[index * 2 + 1]
  }))
}

function verdict (result: BdkVerificationResult): boolean {
  if (result.domain === BdkErrorDomain.OK) return true
  if (result.domain === BdkErrorDomain.SCRIPT || result.domain === BdkErrorDomain.DOS) return false
  throw new BdkVerificationError(result)
}

/**
 * Shared platform-neutral implementation. Node and browser entry points inject
 * different Emscripten loader glue but use this exact verifier and batch logic.
 */
export default class BdkVerifierCore implements BdkVerifierInterface {
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

  constructor (
    private readonly factory: BdkWasmFactory,
    options: BdkVerifierOptions = {}
  ) {
    this.network = NETWORK_IDS[options.network ?? 'main']
    this.mode = options.mode ?? 'auto'
    this.scriptByteThreshold = options.scriptByteThreshold ?? DEFAULT_VERIFAST_SCRIPT_BYTE_THRESHOLD
    this.maxBatchItems = options.maxBatchItems ?? 256
    this.maxBatchBytes = options.maxBatchBytes ?? 32 * 1024 * 1024
    this.defaultUtxoHeight = options.defaultUtxoHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
    this.defaultBlockHeight = options.defaultBlockHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
    this.defaultConsensus = options.defaultConsensus ?? true
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
    await this.getModule()
  }

  /** True only after the WASM module has finished loading successfully. */
  isReady (): boolean {
    return this.module !== undefined
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

    const extendedTX = toVector(bdk.VectorUInt8, params.extendedTransaction)
    const utxoHeights = toVector(bdk.VectorInt32, heights)
    const flags = toVector(bdk.VectorUInt32, customFlags)
    try {
      return bdk.VerifyScript(extendedTX, utxoHeights, params.blockHeight, params.consensus, flags)
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

  private verifyEFChunk (bdk: BdkWasmModule, chunk: readonly BdkVerifyFromEFParams[]): BdkVerificationResult[] {
    if (bdk.VerifyScriptBatchArray === undefined) {
      return chunk.map(params => this.verifyFromEFWithModule(bdk, params))
    }
    const transactions = packArrays(chunk.map(item => item.extendedTransaction), length => new Uint8Array(length))
    const heightsByItem = chunk.map(item => Int32Array.from(item.utxoHeights))
    const heights = packArrays(heightsByItem, length => new Int32Array(length))
    const flagsByItem = chunk.map((item, index) =>
      flagsForInputCount(heightsByItem[index].length, item.verifyFlags, item.customFlags)
    )
    const flags = packArrays(flagsByItem, length => new Uint32Array(length))
    const flat = bdk.VerifyScriptBatchArray(
      transactions.values,
      transactions.offsets,
      heights.values,
      heights.offsets,
      Int32Array.from(chunk.map(item => item.blockHeight)),
      Uint8Array.from(chunk.map(item => item.consensus ? 1 : 0)),
      flags.values,
      flags.offsets,
      this.network
    )
    return decodeResults(flat, chunk.length)
  }

  async verifyScriptsBatchDetailed (params: readonly BdkVerifyParams[]): Promise<BdkVerificationResult[]> {
    return await this.verifyScriptsBatchFromEFDetailed(params.map(item => this.transactionParams(item)))
  }

  async verifyScriptsBatchFromEFDetailed (params: readonly BdkVerifyFromEFParams[]): Promise<BdkVerificationResult[]> {
    if (params.length === 0) return []
    const bdk = await this.getModule()
    return this.chunkEFParams(params).flatMap(chunk => this.verifyEFChunk(bdk, chunk))
  }

  async verifyScriptsBatch (params: readonly BdkVerifyParams[]): Promise<boolean[]> {
    return (await this.verifyScriptsBatchDetailed(params)).map(verdict)
  }

  async verifyScriptsBatchFromEF (params: readonly BdkVerifyFromEFParams[]): Promise<boolean[]> {
    return (await this.verifyScriptsBatchFromEFDetailed(params)).map(verdict)
  }

  private spendContext (spend: Spend, options: BdkVerifySpendOptions = {}): {
    transaction: Uint8Array
    lockingScript: Uint8Array
    customFlags: number | undefined
    utxoHeight: number
    blockHeight: number
    consensus: boolean
  } {
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

  async verifySpendsBatchDetailed (items: readonly BdkSpendBatchItem[]): Promise<BdkVerificationResult[]> {
    if (items.length === 0) return []
    const bdk = await this.getModule()
    if (bdk.VerifySpendBatchArray === undefined) {
      return items.map(item => this.verifySpendWithModule(bdk, item.spend, item))
    }
    const verifySpendBatch = bdk.VerifySpendBatchArray

    const results: BdkVerificationResult[] = []
    let chunk: BdkSpendBatchItem[] = []
    let contexts: Array<ReturnType<BdkVerifierCore['spendContext']>> = []
    let chunkBytes = 0

    const flush = (): void => {
      if (chunk.length === 0) return
      const transactions = packArrays(contexts.map(item => item.transaction), length => new Uint8Array(length))
      const lockingScripts = packArrays(contexts.map(item => item.lockingScript), length => new Uint8Array(length))
      const flat = verifySpendBatch(
        transactions.values,
        transactions.offsets,
        Uint32Array.from(chunk.map(item => item.spend.inputIndex)),
        lockingScripts.values,
        lockingScripts.offsets,
        Float64Array.from(chunk.map(item => item.spend.sourceSatoshis)),
        Int32Array.from(contexts.map(item => item.utxoHeight)),
        Int32Array.from(contexts.map(item => item.blockHeight)),
        Uint8Array.from(contexts.map(item => item.consensus ? 1 : 0)),
        Uint8Array.from(contexts.map(item => item.customFlags === undefined ? 0 : 1)),
        Uint32Array.from(contexts.map(item => item.customFlags ?? 0)),
        this.network
      )
      results.push(...decodeResults(flat, chunk.length))
      chunk = []
      contexts = []
      chunkBytes = 0
    }

    for (const item of items) {
      const context = this.spendContext(item.spend, item)
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
}
