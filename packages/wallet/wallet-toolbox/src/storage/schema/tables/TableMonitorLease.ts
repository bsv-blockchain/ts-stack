import * as sdk from '../../../sdk'

/**
 * V7 lease record so at most one Monitor daemon owns a given task at a time.
 *
 * The Monitor acquires a lease by upserting `(taskName, ownerId, expiresAt)`
 * and renews periodically. Stale leases (`expiresAt < now`) may be claimed by
 * another instance.
 */
export interface TableMonitorLease extends sdk.EntityTimeStamp {
  created_at: Date
  updated_at: Date
  /** Logical task name, e.g. 'proof-acquisition' */
  taskName: string
  /** Stable identifier for the owning Monitor instance */
  ownerId: string
  /** Lease expiry — claimants treat any row with expiresAt <= now() as free */
  expiresAt: Date
  /** Monotonic counter incremented on each successful renew */
  renewCount: number
  /** Optional free-text description of current activity */
  note?: string
}
