import type { BdkWasmModule } from '../BdkVerifierCore.js'

export interface ScriptBatchPayload {
  extendedTransactions: Uint8Array
  transactionOffsets: Uint32Array
  utxoHeights: Int32Array
  heightOffsets: Uint32Array
  blockHeights: Int32Array
  consensus: Uint8Array
  customFlags: Uint32Array
  customFlagOffsets: Uint32Array
  network: number
}

export interface SpendBatchPayload {
  transactions: Uint8Array
  transactionOffsets: Uint32Array
  inputIndices: Uint32Array
  lockingScripts: Uint8Array
  lockingScriptOffsets: Uint32Array
  sourceSatoshis: Float64Array
  utxoHeights: Int32Array
  blockHeights: Int32Array
  consensus: Uint8Array
  hasCustomFlags: Uint8Array
  customFlags: Uint32Array
  network: number
}

export interface DigestBatchPayload {
  publicKeys: Uint8Array
  publicKeyOffsets: Uint32Array
  digests: Uint8Array
  signatures: Uint8Array
  signatureOffsets: Uint32Array
}

export type BdkWorkerRequest =
  | {
    id: number
    operation: 'preload'
    verificationTables?: Uint8Array
  }
  | { id: number, operation: 'verifyScripts', payload: ScriptBatchPayload }
  | { id: number, operation: 'verifySpends', payload: SpendBatchPayload }
  | { id: number, operation: 'verifyDigests', payload: DigestBatchPayload }

export type BdkWorkerRequestWithoutId =
  BdkWorkerRequest extends infer Request
    ? Request extends { id: number }
      ? Omit<Request, 'id'>
      : never
    : never

export type BdkWorkerResult = Int32Array | Uint8Array

export type BdkWorkerResponse =
  | { id: number, result: BdkWorkerResult }
  | { id: number, error: string }

export type WorkerModuleFactory = () => Promise<BdkWasmModule>

function requiredMethod<K extends keyof BdkWasmModule> (
  module: BdkWasmModule,
  method: K
): NonNullable<BdkWasmModule[K]> {
  const implementation = module[method]
  if (implementation === undefined) {
    throw new Error(`The BDK worker module does not support ${String(method)}`)
  }
  return implementation as NonNullable<BdkWasmModule[K]>
}

export function requestTransferables (request: BdkWorkerRequest): ArrayBuffer[] {
  if (request.operation === 'preload') return []
  return Object.values(request.payload)
    .filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
    .map(value => value.buffer as ArrayBuffer)
}

export function resultTransferables (result: BdkWorkerResult): ArrayBuffer[] {
  return [result.buffer as ArrayBuffer]
}

export function createWorkerRequestHandler (
  factory: WorkerModuleFactory,
  respond: (response: BdkWorkerResponse, transfer: ArrayBuffer[]) => void
): (request: BdkWorkerRequest) => Promise<void> {
  let modulePromise: Promise<BdkWasmModule> | undefined
  const getModule = async (): Promise<BdkWasmModule> => {
    modulePromise ??= factory()
    return await modulePromise
  }

  return async request => {
    try {
      const module = await getModule()
      let result: BdkWorkerResult
      switch (request.operation) {
        case 'preload':
          if (
            request.verificationTables !== undefined &&
            module.ImportVerificationTables !== undefined
          ) {
            module.ImportVerificationTables(request.verificationTables)
          } else {
            module.PrepareVerification?.()
          }
          result = new Uint8Array()
          break
        case 'verifyScripts': {
          const payload = request.payload
          result = requiredMethod(module, 'VerifyScriptBatchArray')(
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
          break
        }
        case 'verifySpends': {
          const payload = request.payload
          result = requiredMethod(module, 'VerifySpendBatchArray')(
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
          break
        }
        case 'verifyDigests': {
          const payload = request.payload
          result = requiredMethod(module, 'VerifyDigestBatchArray')(
            payload.publicKeys,
            payload.publicKeyOffsets,
            payload.digests,
            payload.signatures,
            payload.signatureOffsets
          )
          break
        }
      }
      respond({ id: request.id, result }, resultTransferables(result))
    } catch (error) {
      respond({
        id: request.id,
        error: error instanceof Error ? error.message : String(error)
      }, [])
    }
  }
}
