import type { OutputRootEvictionResult } from '@bsv/sdk'
import type { RootEvictionContracts } from './RootEvictionContracts.js'
import type {
  RootEvictionCoordinatedRequest,
  RootEvictionCoordinatedStorage
} from './RootEvictionCoordinatedStorage.js'
import type {
  RootEvictionCommitGuard,
  RootEvictionObservation
} from './RootEvictionCommitContext.js'

/** Original operation and current observation for a separately authorized root worker. */
export interface RootEvictionRecoveredRequest {
  retained: RootEvictionCoordinatedRequest
  result: OutputRootEvictionResult
}

/** Optional trusted-local recovery companion; never expose an unauthenticated digest reader. */
export interface RootEvictionRecoveryStorage extends RootEvictionCoordinatedStorage {
  /**
   * Resolve only the saved signed capability, without current discovery or
   * requester impersonation. The guard authorizes this installed worker and
   * rechecks current policy/context inside the journal gate. Missing legacy
   * selection is unavailable; it is never manufactured. Run independent root
   * maintenance expiry even when this context-dependent recovery is unavailable.
   */
  recoverCoordinated(
    digest: string,
    contracts: RootEvictionContracts,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionRecoveredRequest>>
}
