import { ChainTracker, MerklePath } from '@bsv/sdk'
import { WalletError } from '../sdk/WalletError'
import { GetMerklePathResult, WalletServices } from '../sdk/WalletServices.interfaces'
import { WERR_INVALID_OPERATION } from '../sdk/WERR_errors'

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
  if (result.merklePath == null) {
    throw result.error ?? new WERR_INVALID_OPERATION('Proof provider returned no Merkle path')
  }

  const paths = (Array.isArray(result.merklePath as unknown)
    ? result.merklePath
    : [result.merklePath]) as unknown as MerklePath[]
  const canonical = []
  for (const path of paths) {
    const markedLeaf = path.path[0]?.find(candidate => candidate.txid === true)
    if (markedLeaf != null && markedLeaf.hash !== txid) continue

    const merkleRoot = path.computeRoot(txid)
    if (
      result.header != null &&
      (path.blockHeight !== result.header.height || merkleRoot !== result.header.merkleRoot)
    ) {
      continue
    }
    if (!(await chaintracker.isValidRootForHeight(merkleRoot, path.blockHeight))) continue
    canonical.push(path)
  }

  if (canonical.length === 0) {
    throw new WERR_INVALID_OPERATION('Proof provider returned no Merkle path on the active chain')
  }
  result.merklePath = canonical[0]
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

  const result = await services.getMerklePath(txid)
  const returnedProof = result.merklePath != null
  try {
    await validate(result)
    return result
  } catch (cause) {
    if (returnedProof && services.getValidatedMerklePath != null) {
      const fallback = await services.getValidatedMerklePath(txid, validate)
      try {
        await validate(fallback)
        return fallback
      } catch (fallbackCause) {
        return {
          error: WalletError.fromUnknown(fallbackCause),
          notes: [...(result.notes ?? []), ...(fallback.notes ?? [])]
        }
      }
    }
    return {
      error: WalletError.fromUnknown(cause),
      notes: result.notes ?? []
    }
  }
}
