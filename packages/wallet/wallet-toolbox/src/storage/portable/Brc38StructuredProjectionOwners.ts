import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Brc38JsonMemberIndex } from './Brc38StructuredJson'
import type { SyncMap } from '../schema/entities/EntityBase'

/** Backend callbacks bind actual independently owned source, index and map
 * actors. Callback/descriptor membership is not source or semantic authority.
 * Implementations must freshly check actual actors/schema/profile/lifetime on
 * every operation; no earlier gate result is stored by the portable core. */
export interface Brc38StructuredProjectionOwners {
  readonly check: () => void
  readonly openIndex: (
    policy: Readonly<{
      sourceBytes: number
      maximumTemporaryIndexBytes: number
      maximumTemporaryPhysicalBytes: number
      maximumMembers: number
      maximumAllocationBytes?: number
      workingAllocation?: Brc38WorkingAllocation
      expiresAt: number
      signal?: AbortSignal
    }>
  ) => Promise<Brc38JsonMemberIndex>
  readonly readMappings: (
    entity: keyof SyncMap,
    incoming: readonly number[]
  ) => Promise<readonly (number | undefined)[]>
}
