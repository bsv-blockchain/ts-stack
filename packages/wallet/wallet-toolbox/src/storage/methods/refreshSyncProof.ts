import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import type { GetMerklePathResult } from '../../sdk/WalletServices.interfaces'
import { doubleSha256BE } from '../../utility/utilityHelpers'
import { asString } from '../../utility/utilityHelpers.noBuffer'
import { validateSyncProof, markSyncProofReconciled } from './validateSyncProof'
import type { SyncProofValidationStorage } from './validateSyncProof'
import type { TableProvenTx } from '../schema/tables/TableProvenTx'

/** Obtain replacement metadata; never alter transaction bytes, IDs or timestamps. */
export async function refreshSyncProof(
  storage: SyncProofValidationStorage,
  candidate: TableProvenTx
): Promise<TableProvenTx> {
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
  throw new WERR_INVALID_PARAMETER(
    'provenTx',
    'a server-verified proof. Merkle root is not active at the recorded height and a current proof could not be verified. ' +
      'Ask the source provider to reconcile this transaction, then resume synchronization; saved wallet data is unchanged.'
  )
}
