import type {
  ActionBatchManifest,
  PrepareActionBatchCommitResult,
  PutActionBatchBlobArgs,
  PutActionBatchPackArgs
} from '../../sdk/ActionBatch.interfaces'
import type { AuthId } from '../../sdk/WalletStorage.interfaces'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import { actionBatchBlobDigest, verifyActionBatchManifestDigest } from '../../utility/actionBatchDigest'
import { verifyId } from '../../utility/utilityHelpers'
import { asUint8Array } from '../../utility/utilityHelpers.noBuffer'
import { actionBatchPackLength } from '../../utility/actionBatchPack'
import type { StorageProvider } from '../StorageProvider'
import type { TableActionBatch } from '../schema/tables/TableActionBatch'

export const ACTION_BATCH_MAX_BLOB_BYTES = 8 * 1024 * 1024
export const ACTION_BATCH_MAX_CONCURRENT_UPLOADS = 4
export const ACTION_BATCH_MAX_INLINE_BYTES = 4 * 1024 * 1024
export const ACTION_BATCH_MAX_PACK_BYTES = 8 * 1024 * 1024
export const ACTION_BATCH_MAX_PACK_ITEMS = 4096

export function validateActionBatchInlinePayload (manifest: ActionBatchManifest): void {
  let totalBytes = manifest.dependencyBeef == null ? 0 : manifest.dependencyBeef.length
  const inlineBlobs = Object.entries(manifest.inlineBlobs ?? {})
    .map(([digest, value]) => ({ digest, bytes: asUint8Array(value) }))
  totalBytes += inlineBlobs.reduce((sum, blob) => sum + blob.bytes.length, 0)
  for (const action of manifest.actions) {
    if (action.rawTx != null) totalBytes += action.rawTx.length
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

export function manifestPhysicalDigests (manifest: ActionBatchManifest): string[] {
  const inline = manifest.inlineBlobs ?? {}
  const logicalDigests = manifest.actions
    .filter(action => action.rawTx == null)
    .map(action => action.rawTxDigest)
    .filter((digest): digest is string => digest != null)
  if (manifest.dependencyBeef == null && manifest.dependencyBeefDigest != null &&
    inline[manifest.dependencyBeefDigest] == null) logicalDigests.push(manifest.dependencyBeefDigest)
  for (const action of manifest.actions) {
    if (action.deriveLockingScripts === true) continue
    for (const digest of action.lockingScriptDigests ?? []) {
      if (digest != null && inline[digest] == null) logicalDigests.push(digest)
    }
  }
  return [...new Set(logicalDigests.flatMap(digest => {
    if (inline[digest] != null) return []
    return manifest.blobChunks?.[digest] ?? [digest]
  }))]
}

export function validateCompactManifest (
  manifest: ActionBatchManifest,
  requireUploaded: boolean = false
): void {
  if (manifest.format !== 2) return
  if (requireUploaded && (
    manifest.inlineBlobs != null ||
    manifest.dependencyBeef != null ||
    manifest.actions.some(action => action.rawTx != null)
  )) {
    throw new WERR_INVALID_PARAMETER('manifest', 'digest-only bytes in a prepared format-2 manifest')
  }
  for (const action of manifest.actions) {
    if (action.deriveLockingScripts !== true ||
      action.lockingScriptDigests?.length !== action.plan.outputs.length) {
      throw new WERR_INVALID_PARAMETER('actions', 'format-2 derived output scripts')
    }
    if (action.plan.inputs.some(input =>
      input.sourceLockingScript != null || input.sourceTransaction != null
    )) {
      throw new WERR_INVALID_PARAMETER('actions', 'format-2 derived source scripts')
    }
    if (action.plan.outputs.some(output => output.lockingScript !== '') ||
      action.metadata.outputs.some(output => output.lockingScript !== '')) {
      throw new WERR_INVALID_PARAMETER('actions', 'format-2 compact output metadata')
    }
  }
}

export async function prepareActionBatchCommit (
  storage: StorageProvider,
  auth: AuthId,
  manifest: ActionBatchManifest
): Promise<PrepareActionBatchCommitResult> {
  validateActionBatchInlinePayload(manifest)
  if (!verifyActionBatchManifestDigest(manifest)) throw new WERR_INVALID_PARAMETER('manifest.digest', 'valid')
  validateCompactManifest(manifest, true)
  const userId = verifyId(auth.userId)
  return await storage.transaction(async trx => {
    const batch = requireUploadableBatch(
      await storage.findActionBatchForUpdate(userId, manifest.batchId, trx)
    )
    if (batch.manifestDigest != null && batch.manifestDigest !== manifest.digest) {
      throw new WERR_INVALID_OPERATION('action batch was already prepared with a different manifest')
    }
    const uploadDigests = manifestPhysicalDigests(manifest)
    const present = new Set(
      (await storage.findActionBatchBlobRecords(batch.actionBatchId, uploadDigests, trx))
        .map(blob => blob.digest)
    )
    const missingDigests = uploadDigests.filter(digest => !present.has(digest))
    await storage.updateActionBatch(batch.actionBatchId, {
      status: batch.status === 'expired' ? 'expired' : 'prepared',
      manifestDigest: manifest.digest,
      manifest: manifest.format === 2 ? JSON.stringify(manifest) : undefined,
      uploadDigests: JSON.stringify(uploadDigests)
    }, trx)
    return {
      missingDigests,
      maxBlobBytes: ACTION_BATCH_MAX_BLOB_BYTES,
      maxConcurrentUploads: ACTION_BATCH_MAX_CONCURRENT_UPLOADS
    }
  })
}

export async function putActionBatchPack (
  storage: StorageProvider,
  auth: AuthId,
  args: PutActionBatchPackArgs
): Promise<void> {
  const userId = verifyId(auth.userId)
  if (args.items.length === 0 || args.items.length > ACTION_BATCH_MAX_PACK_ITEMS ||
    actionBatchPackLength(args.items) > ACTION_BATCH_MAX_PACK_BYTES) {
    throw new WERR_INVALID_PARAMETER('items', 'within the provider pack limits')
  }
  const items = args.items.map(item => ({
    digest: item.digest,
    bytes: asUint8Array(item.bytes)
  }))
  for (const item of items) {
    if (actionBatchBlobDigest(item.bytes) !== item.digest) {
      throw new WERR_INVALID_PARAMETER('digest', 'match bytes')
    }
  }
  await storage.transaction(async trx => {
    const batch = requireUploadableBatch(
      await storage.findActionBatchForUpdate(userId, args.batchId, trx)
    )
    const uploadDigests = batch.uploadDigests == null
      ? []
      : JSON.parse(batch.uploadDigests) as string[]
    const allowedDigests = new Set(uploadDigests)
    if (batch.manifestDigest == null || items.some(item => !allowedDigests.has(item.digest))) {
      throw new WERR_INVALID_PARAMETER('digest', 'requested by the prepared action batch manifest')
    }
    const now = new Date()
    await storage.putActionBatchBlobRecords(items.map(item => ({
      actionBatchBlobId: 0,
      actionBatchId: batch.actionBatchId,
      digest: item.digest,
      bytes: item.bytes,
      created_at: now,
      updated_at: now
    })), trx)
  })
}

export async function putActionBatchBlob (
  storage: StorageProvider,
  auth: AuthId,
  args: PutActionBatchBlobArgs
): Promise<void> {
  const userId = verifyId(auth.userId)
  const bytes = asUint8Array(args.bytes)
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
