import type {
  DigestVerification,
  Script,
  Spend,
  Transaction
} from '@bsv/sdk'

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

export interface BdkSpendContext {
  transaction: Uint8Array
  lockingScript: Uint8Array
  customFlags: number | undefined
  utxoHeight: number
  blockHeight: number
  consensus: boolean
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
  /** Worker count for explicitly large batches. Defaults conservatively from logical cores. */
  batchWorkers?: number
  /** Minimum item count before a warm worker pool is used. Defaults to 32. */
  batchWorkerThreshold?: number
  defaultUtxoHeight?: number
  defaultBlockHeight?: number
  defaultConsensus?: boolean
  /** Register this instance for automatic warm-only SDK routing. Defaults to true. */
  registerAsDefault?: boolean
}

export type BdkDigestVerification = DigestVerification

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
export interface EmbindVector<T> {
  push_back: (value: T) => void
  delete: () => void
}

export type EmbindVectorCtor<T> = new () => EmbindVector<T>

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

type BdkVerifyDigestBatchArray = (...args: [
  publicKeys: Uint8Array,
  publicKeyOffsets: Uint32Array,
  digests: Uint8Array,
  signatures: Uint8Array,
  signatureOffsets: Uint32Array
]) => Uint8Array

/** The BDK WASM verifier ABI. New methods remain optional for custom older modules. */
export interface BdkWasmModule {
  VectorUInt8?: EmbindVectorCtor<number>
  VectorInt32?: EmbindVectorCtor<number>
  VectorUInt32?: EmbindVectorCtor<number>
  VerifyScript?: (
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
  PrepareVerification?: () => void
  PrepareSigning?: () => void
  ExportVerificationTables?: () => Uint8Array
  ImportVerificationTables?: (snapshot: Uint8Array) => void
  SignDigest?: (privateKey: Uint8Array, digest: Uint8Array) => Uint8Array
  VerifyDigest?: (
    publicKey: Uint8Array,
    digest: Uint8Array,
    signature: Uint8Array
  ) => boolean
  VerifyDigestBatchArray?: BdkVerifyDigestBatchArray
  PublicKeyFromPrivate?: (privateKey: Uint8Array) => Uint8Array
  MultiplyPublicKey?: (publicKey: Uint8Array, scalar: Uint8Array) => Uint8Array
  TweakPublicKeyAdd?: (publicKey: Uint8Array, tweak: Uint8Array) => Uint8Array
  TweakPrivateKeyAdd?: (privateKey: Uint8Array, tweak: Uint8Array) => Uint8Array
}

/** Async factory that loads/instantiates the BDK WASM module. */
export type BdkWasmFactory = () => Promise<BdkWasmModule>
