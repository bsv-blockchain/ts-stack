import { Hash, Utils } from '@bsv/sdk'
import { ActionBatchManifest } from '../sdk/ActionBatch.interfaces'
import { asArray } from './utilityHelpers.noBuffer'

export function actionBatchBlobDigest (bytes: number[] | Uint8Array): string {
  return Utils.toHex(Hash.sha256(asArray(bytes)))
}

/**
 * Digest only the semantic manifest. Inline bytes are represented by their
 * content digest so inline and uploaded forms have the same idempotency key.
 */
export function actionBatchManifestDigest (manifest: Omit<ActionBatchManifest, 'digest'>): string {
  const payload = {
    batchId: manifest.batchId,
    actions: manifest.actions.map(action => ({
      reference: action.reference,
      txid: action.txid,
      rawTxDigest: action.rawTxDigest ?? actionBatchBlobDigest(action.rawTx ?? []),
      lockingScriptDigests: action.lockingScriptDigests ?? action.plan.outputs.map(output =>
        output.lockingScript.length === 0 ? undefined : actionBatchBlobDigest(asArray(output.lockingScript))
      ),
      plan: {
        inputs: action.plan.inputs,
        outputs: action.plan.outputs.map(output => ({ ...output, lockingScript: '' })),
        noSendChangeOutputVouts: action.plan.noSendChangeOutputVouts,
        derivationPrefix: action.plan.derivationPrefix,
        version: action.plan.version,
        lockTime: action.plan.lockTime,
        reference: action.plan.reference
      },
      metadata: {
        ...action.metadata,
        outputs: action.metadata.outputs.map(output => ({ ...output, lockingScript: '' }))
      },
      commissionKeyOffset: action.commissionKeyOffset
    })),
    dependencyBeefDigest: manifest.dependencyBeefDigest ?? actionBatchBlobDigest(manifest.dependencyBeef ?? []),
    sendWith: manifest.sendWith,
    isDelayed: manifest.isDelayed
  }
  return actionBatchBlobDigest(Utils.toArray(JSON.stringify(payload), 'utf8'))
}

export function verifyActionBatchManifestDigest (manifest: ActionBatchManifest): boolean {
  const { digest: _digest, ...withoutDigest } = manifest
  return manifest.digest === actionBatchManifestDigest(withoutDigest)
}
