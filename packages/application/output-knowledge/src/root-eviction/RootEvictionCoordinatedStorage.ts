import type { OutputRootEvictionResult } from '@bsv/sdk'
import type {
  RootEvictionContracts,
  RootEvictionSelectedContract
} from './RootEvictionContracts.js'
import type {
  RootEvictionCheckedStorage,
  RootEvictionCommitGuard,
  RootEvictionObservation
} from './RootEvictionCommitContext.js'
import type { RootEvictionRetainedRequest } from './RootEvictionStorage.js'

/** Original local capability selection, atomically bound to its retained request. */
export interface RootEvictionCoordinatedRequest extends RootEvictionRetainedRequest {
  contract: RootEvictionSelectedContract
}

/** Optional companion: ordinary deterministic root journals remain supported. */
export interface RootEvictionCoordinatedStorage extends RootEvictionCheckedStorage {
  retainCoordinated(
    request: unknown,
    authenticatedRequester: string,
    selection: { manifest: unknown; selector: string; futureClockSeconds: string },
    contracts: RootEvictionContracts,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionCoordinatedRequest>>
  resultCoordinated(
    requester: string,
    requestId: string,
    selector: string,
    contracts: RootEvictionContracts,
    guard: RootEvictionCommitGuard
  ): Promise<
    RootEvictionObservation<{
      retained: RootEvictionCoordinatedRequest
      result: OutputRootEvictionResult
    }>
  >
}
