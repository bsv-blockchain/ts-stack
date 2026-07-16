import type {
  ActionBatchManifest,
  PrepareActionBatchCommitResult,
  PutActionBatchBlobArgs
} from '../../sdk/ActionBatch.interfaces'
import type { AuthId } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { actionBatchBlobDigest, verifyActionBatchManifestDigest } from '../../utility/actionBatchDigest'
import { verifyId } from '../../utility/utilityHelpers'
import { asArray } from '../../utility/utilityHelpers.noBuffer'
import type { StorageProvider } from '../StorageProvider'
import type { TableActionBatch } from '../schema/tables/TableActionBatch'

export const ACTION_BATCH_MAX_BLOB_BYTES = 8 * 1024 * 1024
export const ACTION_BATCH_MAX_CONCURRENT_UPLOADS = 4
export const ACTION_BATCH_MAX_INLINE_BYTES = 4 * 1024 * 1024

export function validateActionBatchInlinePayload (manifest: ActionBatchManifest): void {
  let totalBytes = manifest.dependencyBeef == null ? 0 : asArray(manifest.dependencyBeef).length
  const inlineBlobs = Object.entries(manifest.inlineBlobs ?? {})
    .map(([digest, value]) => ({ digest, bytes: asArray(value) }))
  totalBytes += inlineBlobs.reduce((sum, blob) => sum + blob.bytes.length, 0)
  for (const action of manifest.actions) {
    if (action.rawTx != null) totalBytes += asArray(action.rawTx).length
    if (action.lockingScriptDigests == null) {
      totalBytes += action.plan.outputs.reduce((sum, output) => sum + output.lockingScript.length / 2, 0)
    }
  }
  if (totalBytes > ACTION_BATCH_MAX_INLINE_BYTES) {
    throw new WERR_INVALID_PARAMETER('manifest', 'inline payload within provider limit')
  }
  for (const { digest, bytes } of inlineBlobs) {
    if (actionBatchBlobDigest(bytes) !== digest) {
      throw new WERR_INVALID_PARAMETER('inlineBlobs', `content matching digest ${digest}`)
    }
  }
}

function requireUploadableBatch (batch: TableActionBatch | undefined): TableActionBatch {
  if (batch == null || batch.status === 'committed' || batch.status === 'aborted') {
    throw new WERR_INVALID_OPERATION('action batch is not uploadable')
  }
  if (batch.hardExpiresAt.getTime() <= Date.now()) {
    throw new WERR_INVALID_OPERATION('action batch hard lifetime has expired')
  }
  return batch
}

function manifestDigests (manifest: ActionBatchManifest): string[] {
  const inline = manifest.inlineBlobs ?? {}
  const logicalDigests = manifest.actions
    .filter(action => action.rawTx == null)
    .map(action => action.rawTxDigest)
    .filter((digest): digest is string => digest != null)
  if (manifest.dependencyBeef == null && manifest.dependencyBeefDigest != null &&
    inline[manifest.dependencyBeefDigest] == null) logicalDigests.push(manifest.dependencyBeefDigest)
  for (const action of manifest.actions) {
    for (const digest of action.lockingScriptDigests ?? []) {
      if (digest != null && inline[digest] == null) logicalDigests.push(digest)
    }
  }
  return [...new Set(logicalDigests.flatMap(digest => {
    if (inline[digest] != null) return []
    return manifest.blobChunks?.[digest] ?? [digest]
  }))]
}

export async function prepareActionBatchCommit (
  storage: StorageProvider,
  auth: AuthId,
  manifest: ActionBatchManifest
): Promise<PrepareActionBatchCommitResult> {
  validateActionBatchInlinePayload(manifest)
  if (!verifyActionBatchManifestDigest(manifest)) throw new WERR_INVALID_PARAMETER('manifest.digest', 'valid')
  const userId = verifyId(auth.userId)
  return await storage.transaction(async trx => {
    const batch = requireUploadableBatch(
      await storage.findActionBatchForUpdate(userId, manifest.batchId, trx)
    )
    if (batch.manifestDigest != null && batch.manifestDigest !== manifest.digest) {
      throw new WERR_INVALID_OPERATION('action batch was already prepared with a different manifest')
    }
    const uploadDigests = manifestDigests(manifest)
    const missingDigests: string[] = []
    for (const digest of uploadDigests) {
      if (await storage.findActionBatchBlobRecord(batch.actionBatchId, digest, trx) == null) missingDigests.push(digest)
    }
    await storage.updateActionBatch(batch.actionBatchId, {
      status: batch.status === 'expired' ? 'expired' : 'prepared',
      manifestDigest: manifest.digest,
      uploadDigests: JSON.stringify(uploadDigests)
    }, trx)
    return {
      missingDigests,
      maxBlobBytes: ACTION_BATCH_MAX_BLOB_BYTES,
      maxConcurrentUploads: ACTION_BATCH_MAX_CONCURRENT_UPLOADS
    }
  })
}

export async function putActionBatchBlob (
  storage: StorageProvider,
  auth: AuthId,
  args: PutActionBatchBlobArgs
): Promise<void> {
  const userId = verifyId(auth.userId)
  const bytes = asArray(args.bytes)
  if (bytes.length > ACTION_BATCH_MAX_BLOB_BYTES) throw new WERR_INVALID_PARAMETER('bytes', 'within provider blob limit')
  if (actionBatchBlobDigest(bytes) !== args.digest) throw new WERR_INVALID_PARAMETER('digest', 'match bytes')
  await storage.transaction(async trx => {
    const batch = requireUploadableBatch(
      await storage.findActionBatchForUpdate(userId, args.batchId, trx)
    )
    const uploadDigests = batch.uploadDigests == null
      ? []
      : JSON.parse(batch.uploadDigests) as string[]
    if (batch.manifestDigest == null || !uploadDigests.includes(args.digest)) {
      throw new WERR_INVALID_PARAMETER('digest', 'requested by the prepared action batch manifest')
    }
    const now = new Date()
    await storage.putActionBatchBlobRecord({
      actionBatchBlobId: 0,
      actionBatchId: batch.actionBatchId,
      digest: args.digest,
      bytes,
      created_at: now,
      updated_at: now
    }, trx)
  })
}
