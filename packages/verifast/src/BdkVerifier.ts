import type { Transaction } from '@bsv/sdk'
import type BdkVerifierInterface from './BdkVerifierInterface.js'
import { mapVerifyFlags } from './flags.js'

/** Height used when an input's source UTXO mined-height is unobtainable (post-Chronicle). */
const POST_CHRONICLE_HEIGHT_FALLBACK = 943816

/** Return code from BDK VerifyScript that denotes "all scripts valid". */
const BDK_SUCCESS = 1

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
  ) => number
}

/** Async factory that loads/instantiates the BDK WASM module (e.g. `createBdkModule`). */
export type BdkWasmFactory = () => Promise<BdkWasmModule>

function toVector<T> (ctor: EmbindVectorCtor<T>, values: T[]): EmbindVector<T> {
  const vec = new ctor()
  for (const v of values) vec.push_back(v)
  return vec
}

/**
 * BdkVerifierInterface implementation backed by the BSV BDK engine compiled to WASM.
 * Strict: a non-success return code => false; any thrown error propagates.
 */
export default class BdkVerifier implements BdkVerifierInterface {
  private module: BdkWasmModule | undefined
  private loading: Promise<BdkWasmModule> | undefined

  /** @param factory loads the WASM module; invoked once, memoised. */
  constructor (private readonly factory: BdkWasmFactory) {}

  private async getModule (): Promise<BdkWasmModule> {
    if (this.module !== undefined) return this.module
    if (this.loading === undefined) {
      this.loading = this.factory().then((m) => { this.module = m; return m })
    }
    return await this.loading
  }

  async verifyScripts (params: {
    tx: Transaction
    blockHeight: number
    consensus: boolean
    verifyFlags?: string | string[]
  }): Promise<boolean> {
    const bdk = await this.getModule()

    const heights = params.tx.inputs.map(
      (input) => input.sourceTransaction?.merklePath?.blockHeight ?? POST_CHRONICLE_HEIGHT_FALLBACK
    )

    const extendedTX = toVector(bdk.VectorUInt8, params.tx.toEF())
    const utxoHeights = toVector(bdk.VectorInt32, heights)
    const customFlags = toVector(
      bdk.VectorUInt32,
      [mapVerifyFlags(params.verifyFlags)].filter((f) => f !== 0)
    )

    try {
      const result = bdk.VerifyScript(
        extendedTX,
        utxoHeights,
        params.blockHeight,
        params.consensus,
        customFlags
      )
      return result === BDK_SUCCESS
    } finally {
      extendedTX.delete()
      utxoHeights.delete()
      customFlags.delete()
    }
  }
}
