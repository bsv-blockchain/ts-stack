import type { TXIDHexString, Validation } from '@bsv/sdk'
import type { TableOutput, TableOutputBasket } from '../storage/schema/tables'
import type {
  StorageCreateActionResult,
  StorageCreateTransactionSdkInput,
  StorageFeeModel,
  StorageProcessActionResults
} from './WalletStorage.interfaces'

export type ActionBatchPackEncoding = 'identity' | 'gzip' | 'brotli'

/** Internal Wallet Toolbox capabilities. These do not extend the BRC-100 wallet interface. */
export interface StorageCapabilities {
  actionBatch?: {
    version: 1
    maxInlineBytes: number
    maxBlobBytes: number
    maxConcurrentUploads: number
    leaseMs: number
    hardLifetimeMs: number
    /** Large first actions may omit bytes that will be uploaded at commit. */
    compactBegin?: boolean
    /**
     * Compact manifests derive source and output scripts from the transaction
     * graph instead of transferring duplicate script strings and blobs.
     */
    manifestVersion?: 2
    /** A prepared compact manifest may be committed by its semantic digest. */
    commitByDigest?: boolean
    /** Multiple logical blobs may share one authenticated binary request. */
    packedUploads?: {
      version: 1
      maxPackBytes: number
      maxItems: number
      encodings: ActionBatchPackEncoding[]
      /** Packs may be uploaded before the final manifest is prepared. */
      eager: boolean
    }
  }
}

export interface ActionBatchFundingOutput extends TableOutput {
  sourceTransaction?: number[] | Uint8Array
}

export interface BeginActionBatchArgs {
  batchId: string
  firstAction: Validation.ValidCreateActionArgs
  /**
   * Exact output-script byte lengths when a large first action is sent in
   * compact form with empty script fields. This internal storage extension
   * avoids sending scripts and input proof data before chunked upload begins.
   */
  firstActionOutputScriptLengths?: number[]
}

export interface BeginActionBatchResult {
  batchId: string
  expiresAt: string
  hardExpiresAt: string
  changeBasket: TableOutputBasket
  feeModel: StorageFeeModel
  commissionSatoshis: number
  commissionPubKeyHex?: string
  availableChangeCount: number
  reservedOutputs: ActionBatchFundingOutput[]
  explicitOutputs: ActionBatchFundingOutput[]
  inputBeef?: number[] | Uint8Array
}

export interface ExtendActionBatchArgs {
  batchId: string
  targetSatoshis: number
  requestedOutputs: number
  explicitOutpoints: Array<{ txid: string, vout: number }>
  includeSourceTransactions: boolean
}

export interface ExtendActionBatchResult {
  expiresAt: string
  reservedOutputs: ActionBatchFundingOutput[]
  explicitOutputs: ActionBatchFundingOutput[]
  inputBeef?: number[] | Uint8Array
}

export interface RenewActionBatchResult {
  expiresAt: string
}

export interface ActionBatchCommitMetadata {
  description: string
  labels: string[]
  isNoSend: boolean
  isDelayed: boolean
  inputs: Validation.ValidCreateActionInput[]
  outputs: Validation.ValidCreateActionOutput[]
}

export interface ActionBatchCommitInput extends Omit<StorageCreateTransactionSdkInput, 'sourceLockingScript'> {
  /**
   * Version-1 manifests carry this value. Version-2 manifests derive it from
   * the proven source output and therefore omit it.
   */
  sourceLockingScript?: string
}

export interface ActionBatchCommitPlan extends Omit<StorageCreateActionResult, 'inputs'> {
  inputs: ActionBatchCommitInput[]
}

export interface ActionBatchCommitAction {
  reference: string
  txid: TXIDHexString
  rawTx?: number[] | Uint8Array
  rawTxDigest?: string
  /** Content-addressed locking scripts aligned to plan.outputs for compact workspaces. */
  lockingScriptDigests?: Array<string | undefined>
  /** Version 2 derives the scripts identified above from rawTx. */
  deriveLockingScripts?: boolean
  plan: ActionBatchCommitPlan
  metadata: ActionBatchCommitMetadata
  commissionKeyOffset?: string
}

export interface ActionBatchManifest {
  /** Omitted for the original manifest format. */
  format?: 2
  batchId: string
  digest: string
  actions: ActionBatchCommitAction[]
  /** Content-addressed blobs carried in the commit request when the batch is below the inline limit. */
  inlineBlobs?: Record<string, number[] | Uint8Array>
  /** Physical chunk digests for logical blobs larger than the provider's advertised blob limit. */
  blobChunks?: Record<string, string[]>
  dependencyBeef?: number[] | Uint8Array
  dependencyBeefDigest?: string
  sendWith: TXIDHexString[]
  isDelayed: boolean
}

export interface PrepareActionBatchCommitResult {
  missingDigests: string[]
  maxBlobBytes: number
  maxConcurrentUploads: number
}

export interface PutActionBatchBlobArgs {
  batchId: string
  digest: string
  bytes: number[] | Uint8Array
}

export interface ActionBatchPackItem {
  digest: string
  bytes: number[] | Uint8Array
}

export interface PutActionBatchPackArgs {
  batchId: string
  items: ActionBatchPackItem[]
  maxPackBytes: number
  maxItems: number
  preferredEncodings?: ActionBatchPackEncoding[]
}

export interface CommitActionBatchByDigestArgs {
  batchId: string
  digest: string
}

export interface CommitActionBatchResult extends StorageProcessActionResults {
  batchId: string
  manifestDigest: string
  committedTxids: TXIDHexString[]
  alreadyCommitted: boolean
}

export interface AbortActionBatchResult {
  aborted: boolean
}
