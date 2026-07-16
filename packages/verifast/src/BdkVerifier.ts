import type { Transaction } from '@bsv/sdk'
import createBdkModule from './wasm/bdk-core.mjs'
import type BdkVerifierInterface from './BdkVerifierInterface.js'
import { mapVerifyFlags } from './flags.js'

/** Height used when an input's source UTXO mined-height is unobtainable (post-Chronicle). */
const POST_CHRONICLE_HEIGHT_FALLBACK = 943816

export enum BdkErrorDomain {
  OK = 0,
  SCRIPT = 1,
  DOS = 2,
  EXCEPTION = 3
}

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

/** Raised when BDK reports an exception domain or an unknown ABI domain. */
export class BdkVerificationError extends Error {
  constructor (public readonly result: BdkVerificationResult) {
    super(`BDK verification failed in domain ${result.domain} with code ${result.code}`)
    this.name = 'BdkVerificationError'
  }
}

/** Minimal embind vector surface used by the adapter. */
interface EmbindVector<T> {
  push_back: (value: T) => void
  delete: () => void
}

type EmbindVectorCtor<T> = new () => EmbindVector<T>

/** The subset of the BDK WASM module this adapter uses. */
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
  /** Bulk-copy ABI available in the bundled optimized module. */
  VerifyScriptArray?: (
    extendedTX: number[],
    utxoHeights: number[],
    blockHeight: number,
    consensus: boolean,
    customFlags: number[]
  ) => BdkVerificationResult
}

/** Async factory that loads/instantiates the BDK WASM module. */
export type BdkWasmFactory = () => Promise<BdkWasmModule>

function toVector<T> (Vector: EmbindVectorCtor<T>, values: T[]): EmbindVector<T> {
  const vec = new Vector()
  for (const value of values) vec.push_back(value)
  return vec
}

/**
 * Transaction script verifier backed by the BSV BDK engine compiled to WASM.
 * The bundled module is loaded lazily and memoised. A custom factory remains
 * supported for testing or for callers that maintain their own BDK build.
 */
export default class BdkVerifier implements BdkVerifierInterface {
  private module: BdkWasmModule | undefined
  private loading: Promise<BdkWasmModule> | undefined

  constructor (private readonly factory: BdkWasmFactory = createBdkModule) {}

  private async getModule (): Promise<BdkWasmModule> {
    if (this.module !== undefined) return this.module
    this.loading ??= this.factory().then((module) => {
      this.module = module
      return module
    })
    return await this.loading
  }

  /** Return BDK's structured result without collapsing its error domain. */
  async verifyScriptsDetailed (params: BdkVerifyParams): Promise<BdkVerificationResult> {
    const bdk = await this.getModule()
    const heights = params.tx.inputs.map(
      (input) => input.sourceTransaction?.merklePath?.blockHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
    )
    const customFlagValues = params.verifyFlags === undefined
      ? []
      : new Array<number>(params.tx.inputs.length).fill(mapVerifyFlags(params.verifyFlags))
    const extendedTXBytes = params.tx.toEF()

    // The bundled ABI copies each complete JS array into WASM linear memory
    // with TypedArray#set. Keep the vector path for callers using an older or
    // custom BDK module, but avoid hundreds of JS/WASM calls per transaction.
    if (bdk.VerifyScriptArray !== undefined) {
      return bdk.VerifyScriptArray(
        extendedTXBytes,
        heights,
        params.blockHeight,
        params.consensus,
        customFlagValues
      )
    }

    const extendedTX = toVector(bdk.VectorUInt8, extendedTXBytes)
    const utxoHeights = toVector(bdk.VectorInt32, heights)
    const customFlags = toVector(bdk.VectorUInt32, customFlagValues)

    try {
      return bdk.VerifyScript(
        extendedTX,
        utxoHeights,
        params.blockHeight,
        params.consensus,
        customFlags
      )
    } finally {
      extendedTX.delete()
      utxoHeights.delete()
      customFlags.delete()
    }
  }

  async verifyScripts (params: BdkVerifyParams): Promise<boolean> {
    const result = await this.verifyScriptsDetailed(params)
    if (result.domain === BdkErrorDomain.OK) return true
    if (result.domain === BdkErrorDomain.SCRIPT || result.domain === BdkErrorDomain.DOS) return false
    throw new BdkVerificationError(result)
  }
}
