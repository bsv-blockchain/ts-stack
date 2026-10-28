import {
  copyBrc38AuthenticatedStreamBrowserOptions,
  stageAuthenticatedBrc39StreamBrowserImport,
  type Brc38AuthenticatedStreamBrowserOptions
} from './Brc38AuthenticatedStreamStageBrowser'
import { Brc38PrivateIdbStage } from './Brc38PrivateIdbStage'
import { inspectBrc38PrivateIdbStreamedProof, type Brc38IdbStreamedProofPolicy } from './Brc38IdbStreamedProof'
import { brc38WorkingAllocation, type Brc38WorkingAllocation, type Brc38WorkingCharge } from './Brc38WorkingAllocation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { brc38StageTables, type Brc38StageTable } from './Brc38SemanticStage'
import type { SyncProofValidationStorage } from '../methods/validateSyncProof'

export interface Brc38AuthenticatedIdbPreviewOptions {
  readonly source: Brc38AuthenticatedStreamBrowserOptions
  readonly proofStorage: SyncProofValidationStorage
  readonly proof: Brc38IdbStreamedProofPolicy
  readonly workingAllocation: Brc38WorkingAllocation
}
/** Preview DATA. No sealed source handle, cached authentication/proof/semantic
 * verdict or activation token is returned. The actual restore/publication call
 * freshly consumes and authenticates the COMPLETE original envelope again. */
export interface Brc38AuthenticatedIdbPreview {
  readonly version: 1
  readonly mode: 'isolated-restore'
  readonly previewId: string
  readonly bindingSha256: string
  readonly archiveSha256: string
  readonly identityKey: string
  readonly chain: 'main' | 'test'
  readonly sourceStorageIdentityKey: string
  readonly targetStorageIdentityKey: string
  readonly originalActiveStorage: string | null
  readonly originalLimitsJson: string
  readonly expiresAt: number
  readonly totalRows: number
  readonly counts: Readonly<Record<Brc38StageTable, number>>
  readonly maximumMappedIdsRequired: number
}
function invalid(): never {
  throw new Error('Browser import preview differs from its original source/resources/profile')
}

/** Full authenticated encrypted source, all13 semantics and current-chain proof
 * inspection, without opening any destination writer. Actual private source
 * retirement and drainage precede delivery. Preview preserves source selection
 * as data and cannot select an active wallet or modify a managed profile. */
export async function previewAuthenticatedBrc39BrowserImport(
  source: AsyncIterable<Uint8Array>,
  password: string,
  selected: Brc38AuthenticatedIdbPreviewOptions
): Promise<Readonly<Brc38AuthenticatedIdbPreview>> {
  const options = copyBrc38AuthenticatedStreamBrowserOptions(selected.source),
    storage = selected.proofStorage,
    proof = Object.freeze({ ...selected.proof }),
    working = brc38WorkingAllocation(selected.workingAllocation),
    expiresAt = options.limits.expiresAt,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now())
  if (
    working === undefined ||
    proof.workingAllocation !== working ||
    working.maximum > options.limits.maximumRowAllocationBytes ||
    options.streamedFields === undefined ||
    options.streamedStructuredFields === undefined
  )
    invalid()
  const check = () => {
    options.signal?.throwIfAborted()
    proof.signal?.throwIfAborted()
    if (Date.now() >= expiresAt || performance.now() >= deadline) invalid()
  }
  let stage: Brc38PrivateIdbStage | undefined, allowance: Brc38WorkingCharge | undefined
  const failed = new Set<Brc38StagingCleanupError>(),
    cleanup = async () => {
      const causes: unknown[] = []
      try {
        await stage?.discard(new Error('Browser authenticated preview source retirement'))
        stage = undefined
      } catch (cause) {
        causes.push(cause)
      }
      for (const value of failed)
        try {
          await value.retryCleanup()
          failed.delete(value)
        } catch (cause) {
          causes.push(cause)
        }
      if (causes.length !== 0)
        throw new Brc38StagingCleanupError(
          causes,
          'Browser preview retains actual original source/proof cleanup',
          cleanup
        )
      allowance?.close()
    }
  try {
    check()
    stage = (await stageAuthenticatedBrc39StreamBrowserImport(source, password, options)).stage
    check()
    allowance = working.claim(16384 + 32 * options.limits.maximumRowBytes)
    let metadata: Awaited<ReturnType<Brc38PrivateIdbStage['sealedMetadata']>> | undefined = await stage.sealedMetadata()
    const active = metadata.header.user.activeStorage
    if (
      !(active === undefined || active === null || typeof active === 'string') ||
      (typeof active === 'string' && new TextEncoder().encode(active).byteLength > 256)
    )
      invalid()
    // Exactly the nine independent numeric ID-map families. Compound relation
    // keys and operational sync-state identities are remapped by their parents.
    const mappedTables = [
      'provenTxs',
      'outputBaskets',
      'outputTags',
      'txLabels',
      'transactions',
      'outputs',
      'certificates',
      'commissions',
      'provenTxReqs'
    ] as const
    const counts = {} as Record<Brc38StageTable, number>
    for (const table of brc38StageTables) counts[table] = metadata.counts[table]
    const preview: Brc38AuthenticatedIdbPreview = Object.freeze({
      version: 1,
      mode: 'isolated-restore',
      previewId: crypto.randomUUID(),
      bindingSha256: metadata.bindingSha256,
      archiveSha256: metadata.binding.archiveSha256,
      identityKey: metadata.binding.identityKey,
      chain: metadata.binding.chain,
      sourceStorageIdentityKey: metadata.binding.sourceStorageIdentityKey,
      targetStorageIdentityKey: metadata.binding.targetStorageIdentityKey,
      originalActiveStorage: active ?? null,
      originalLimitsJson: metadata.originalLimitsJson,
      expiresAt,
      totalRows: metadata.rows + 1,
      counts: Object.freeze(counts),
      maximumMappedIdsRequired: mappedTables.reduce((total, table) => total + counts[table], 0)
    })
    metadata = undefined
    allowance.resize(8192)
    for (let index = 0; index < counts.provenTxs; index++) {
      check()
      await inspectBrc38PrivateIdbStreamedProof(stage, storage, index, proof, expiresAt)
    }
    check()
    await cleanup()
    check()
    return preview
  } catch (cause) {
    if (cause instanceof Brc38StagingCleanupError) failed.add(cause)
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError([cause, error_], 'Browser preview retains concrete cleanup', cleanup)
    }
    throw cause
  }
}
