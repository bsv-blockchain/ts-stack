import type { RootEvictionObservation } from './RootEvictionCommitContext.js'
import type { RootEvictionHead } from './RootEvictionStorage.js'

/**
 * Installed local maintenance authority, never inferred from a peer identity.
 * Callbacks run synchronously inside the journal gate, without network I/O,
 * signing, mutation or reentry. No chain-context permission is needed to expire
 * a request: expiry rejects work and cannot establish Bitcoin eligibility.
 */
export interface RootEvictionMaintenanceGuard {
  clock(): string
  authorize(head: Readonly<RootEvictionHead>, now: string): boolean
}

export interface RootEvictionPendingPage {
  /** Strictly increasing permanent request digests; no signed bodies are disclosed. */
  digests: string[]
  /** Exclusive cursor; absent at the end of this local scan. */
  next?: string
}

/** Optional local recovery companion; existing journal interfaces are unchanged. */
export interface RootEvictionMaintenanceStorage {
  readonly durability: 'durable'
  /**
   * At most 64 pending request references. This is a changing local work scan,
   * not a wire snapshot. After its end, begin again without a cursor so requests
   * inserted before a prior cursor are eventually visited. A lost wake or cursor
   * is safe: restart from the beginning. Retained request capacity bounds a pass.
   */
  pendingPage(
    input: { maximum: number; after?: string },
    guard: RootEvictionMaintenanceGuard
  ): Promise<RootEvictionObservation<RootEvictionPendingPage>>
  /**
   * Reject only still-pending targets whose deadline or frozen policy has passed.
   * Sample the clock after acquiring the same gate as evaluation. Original
   * contracts and completed actions remain unchanged. This does not apply a peer
   * suppression, restore membership or grant permission to disclose a result.
   */
  expirePending(
    digest: string,
    guard: RootEvictionMaintenanceGuard
  ): Promise<RootEvictionObservation<{ expiredTargets: number[]; pendingTargets: number[] }>>
  close(): Promise<void>
}
