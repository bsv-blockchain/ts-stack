import { ChainTracker, MerklePath } from '@bsv/sdk'
import { WalletError } from '../sdk/WalletError'
import { GetMerklePathResult, WalletServices } from '../sdk/WalletServices.interfaces'
import { WERR_INVALID_OPERATION } from '../sdk/WERR_errors'
import {
  copyMerklePath,
  copyValidatedBlockHeader,
  normalizeTxid,
  snapshotMerklePathResult
} from './validateMerklePathResult'

/**
 * Reject proof-provider results unless at least one returned path proves the
 * requested transaction against the active chain. Invalid paths are removed
 * before the result is returned so a stale path cannot precede a valid one.
 */
export async function validateCanonicalMerklePathResult(
  txid: string,
  result: GetMerklePathResult,
  chaintracker: ChainTracker
): Promise<void> {
  const requestedTxid = normalizeTxid(txid)
  const snapshot = snapshotMerklePathResult(result, true) as GetMerklePathResult & {
    merklePath?: MerklePath | MerklePath[]
  }
  if (snapshot.merklePath == null) {
    throw snapshot.error ?? new WERR_INVALID_OPERATION('Proof provider returned no Merkle path')
  }

  const paths = Array.isArray(snapshot.merklePath) ? snapshot.merklePath : [snapshot.merklePath]
  const header = snapshot.header == null ? undefined : copyValidatedBlockHeader(snapshot.header, false, false)
  const canonical: MerklePath[] = []
  for (const path of paths) {
    try {
      const proof = copyMerklePath(requestedTxid, path)
      if (header != null && (proof.merklePath.blockHeight !== header.height || proof.root !== header.merkleRoot)) {
        continue
      }
      if ((await chaintracker.isValidRootForHeight(proof.root, proof.merklePath.blockHeight)) !== true) continue
      canonical.push(proof.merklePath)
    } catch {
      // A malformed or unrelated path is not allowed to hide a later valid
      // candidate in a legacy multi-proof response.
    }
  }

  if (canonical.length === 0) {
    throw new WERR_INVALID_OPERATION('Proof provider returned no Merkle path on the active chain')
  }
  Object.assign(result, {
    ...snapshot,
    merklePath: canonical[0],
    ...(header == null ? {} : { header })
  })
}

/**
 * Obtain a canonical proof with provider failover when the service supports
 * it. Custom WalletServices implementations without the optional failover
 * method still fail closed after validating their single lookup.
 */
export async function getCanonicalMerklePath(
  services: WalletServices,
  chaintracker: ChainTracker,
  txid: string
): Promise<GetMerklePathResult> {
  const validate = async (result: GetMerklePathResult): Promise<void> => {
    await validateCanonicalMerklePathResult(txid, result, chaintracker)
  }

  let result: GetMerklePathResult
  try {
    result = snapshotMerklePathResult(await services.getMerklePath(normalizeTxid(txid)), true) as GetMerklePathResult
  } catch (cause) {
    return { error: WalletError.fromUnknown(cause), notes: [] }
  }
  const returnedProof = result.merklePath != null
  try {
    await validate(result)
    return result
  } catch (cause) {
    if (returnedProof && services.getValidatedMerklePath != null) {
      let fallbackNotes: GetMerklePathResult['notes'] = []
      try {
        const fallback = await services.getValidatedMerklePath(normalizeTxid(txid), validate)
        const snapshot = snapshotMerklePathResult(fallback, true) as GetMerklePathResult
        fallbackNotes = snapshot.notes ?? []
        await validate(snapshot)
        return snapshot
      } catch (error_) {
        return {
          error: WalletError.fromUnknown(error_),
          notes: [...(result.notes ?? []), ...fallbackNotes]
        }
      }
    }
    return {
      error: WalletError.fromUnknown(cause),
      notes: result.notes ?? []
    }
  }
}
