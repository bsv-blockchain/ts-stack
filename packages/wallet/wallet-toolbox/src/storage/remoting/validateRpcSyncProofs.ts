import { StaleSyncProofError, validateSyncProof } from '../methods/validateSyncProof'
import type { SyncProofValidationStorage } from '../methods/validateSyncProof'
import type { TableProvenTx } from '../schema/tables/TableProvenTx'
import { refreshSyncProof } from '../methods/refreshSyncProof'

/** Validate a whole RPC page with at most eight proofs in flight and no database writes. */
export async function validateSyncProofs(
  storage: SyncProofValidationStorage,
  candidates: TableProvenTx[]
): Promise<void> {
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
