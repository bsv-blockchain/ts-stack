import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import type { GetMerklePathResult } from '../../sdk/WalletServices.interfaces'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { StaleSyncProofError, validateSyncProof, markSyncProofReconciled } from '../methods/validateSyncProof'
import type { SyncProofValidationStorage } from '../methods/validateSyncProof'
import type { TableProvenTx } from '../schema/tables/TableProvenTx'

/** Obtain replacement metadata; never alter transaction bytes, IDs or timestamps. */
async function refreshSyncProof(storage: SyncProofValidationStorage, candidate: TableProvenTx): Promise<TableProvenTx> {
  const services = storage.getServices()
  let current: TableProvenTx | undefined
  const validate = async ({ merklePath }: GetMerklePathResult): Promise<void> => {
    if (merklePath == null) throw new Error('Current proof unavailable')
    const header = await services.getHeaderForHeight(merklePath.blockHeight)
    const replacement = {
      ...candidate,
      height: merklePath.blockHeight,
      index: merklePath.path[0]?.find(leaf => leaf.txid === true && leaf.hash === candidate.txid)?.offset ?? -1,
      merklePath: merklePath.toBinary(),
      merkleRoot: merklePath.computeRoot(candidate.txid),
      blockHash: asString(doubleSha256BE(header))
    }
    // Recheck raw bytes, membership, root and active header before authorizing
    // any global proof replacement. A provider's success response is insufficient.
    await validateSyncProof(storage, replacement)
    markSyncProofReconciled(replacement)
    current = replacement
  }
  try {
    if (services.getValidatedMerklePath != null) {
      await services.getValidatedMerklePath(candidate.txid, validate)
    } else {
      // Custom services remain compatible; one bounded lookup, fully validated.
      await validate(await services.getMerklePath(candidate.txid))
    }
    if (current != null) return current
  } catch {
    // Report a recoverable sync error, without leaking provider response data.
  }
  throw new WERR_INVALID_PARAMETER('provenTx',
    'a server-verified proof. Merkle root is not active at the recorded height and a current proof could not be verified. ' +
    'Ask the source provider to reconcile this transaction, then resume synchronization; saved wallet data is unchanged.')
}

/** Validate a whole RPC page with at most eight proofs in flight and no database writes. */
export async function validateSyncProofs(storage: SyncProofValidationStorage, candidates: TableProvenTx[]): Promise<void> {
  let next = 0
  let failed = false
  const validated: TableProvenTx[] = []
  const workers = Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (!failed && next < candidates.length) {
      const index = next++
      const candidate = candidates[index]
      try {
        try {
          await validateSyncProof(storage, candidate)
          validated[index] = candidate
        } catch (error) {
          if (!(error instanceof StaleSyncProofError)) throw error
          validated[index] = await refreshSyncProof(storage, candidate)
        }
      } catch (error) {
        failed = true
        throw error
      }
    }
  })
  // Drain started checks before rejecting; no proof work outlives the request.
  const results = await Promise.allSettled(workers)
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason
  }
  for (let i = 0; i < validated.length; i++) candidates[i] = validated[i]
}
