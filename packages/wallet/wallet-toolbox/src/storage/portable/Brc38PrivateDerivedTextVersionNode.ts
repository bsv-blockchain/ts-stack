import type { Knex } from 'knex'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import type { Brc38WorkingAllocation } from './Brc38WorkingAllocation'
import type { Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'
import type { Brc38PrivateDerivedTextLifetimes } from './Brc38PrivateDerivedTextLifetimesNode'
import { withBrc38PrivateContentVersion } from './Brc38PrivateContentVersionNode'
import type { Brc38PrivateContentDescriptor, Brc38PrivateContentVersion } from './Brc38PrivateContentVersionNode'
export type Brc38PrivateDerivedTextDescriptor = Brc38PrivateContentDescriptor
export type Brc38PrivateDerivedTextVersion = Brc38PrivateContentVersion

/** Preserve the structured producer's original minimum/default/UTF-8 contract.
 * Raw local content opts into a separate explicit format at the shared bounded
 * staging primitive; descriptor DATA never grants source or merge authority. */
export async function withBrc38PrivateDerivedTextVersion<T>(
  store: KnexBrc38StagingStore,
  policy: Readonly<{
    expiresAt: number
    maximumBytes: number
    maximumVersions?: number
    workingAllocation: Brc38WorkingAllocation
    signal?: AbortSignal
  }>,
  budget: Brc38ImportDecodedBudget,
  work: (version: Readonly<Brc38PrivateDerivedTextVersion>) => Promise<T>,
  borrowedReadDatabase?: Knex,
  selectedLifetimes?: Brc38PrivateDerivedTextLifetimes
): Promise<T> {
  return await withBrc38PrivateContentVersion(
    'structured-text',
    store,
    policy,
    budget,
    work,
    borrowedReadDatabase,
    selectedLifetimes
  )
}
