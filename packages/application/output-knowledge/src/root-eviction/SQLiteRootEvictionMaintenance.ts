import { outputAssert, outputHex32 } from '@bsv/sdk'
import { synchronousPromise } from '../internal/synchronousPromise.js'
import { rootCommitContext, type RootEvictionObservation } from './RootEvictionCommitContext.js'
import type {
  RootEvictionMaintenanceGuard,
  RootEvictionMaintenanceStorage,
  RootEvictionPendingPage
} from './RootEvictionMaintenanceStorage.js'
import { RootEvictionRequests } from './RootEvictionRequests.js'
import type { RootEvictionConfiguration } from './RootEvictionStorage.js'
import { SQLiteRootEvictionDatabase } from './SQLiteRootEvictionDatabase.js'

/**
 * Trusted Node recovery worker on an existing root journal. Uses the same sealed
 * configuration, WAL/FULL durability and cross-process transaction gate as the
 * decision and final-enqueue ports. It never creates or upgrades a journal.
 */
export class SQLiteRootEvictionMaintenance implements RootEvictionMaintenanceStorage {
  readonly durability = 'durable' as const
  private readonly database: SQLiteRootEvictionDatabase
  private readonly requests: RootEvictionRequests

  private constructor(path: string, configuration: RootEvictionConfiguration) {
    this.database = new SQLiteRootEvictionDatabase(path, configuration, undefined)
    this.requests = new RootEvictionRequests(this.database)
  }

  static open(
    path: string,
    configuration: RootEvictionConfiguration
  ): SQLiteRootEvictionMaintenance {
    return new SQLiteRootEvictionMaintenance(path, configuration)
  }

  private work<T>(
    guard: RootEvictionMaintenanceGuard,
    work: (now: string) => T
  ): Promise<RootEvictionObservation<T>> {
    return synchronousPromise(() =>
      this.database.transaction(() => {
        const head = this.database.head()
        const observedAt = rootCommitContext(head, {
          expectedPolicyDigest: head.policyDigest,
          clock: guard.clock,
          authorize: guard.authorize,
          // Expiry cannot create eligibility and must survive unavailable chain evidence.
          contextCurrent: () => true
        })
        const value = work(observedAt)
        return { value, head: this.database.head(), observedAt }
      })
    )
  }

  pendingPage(
    input: { maximum: number; after?: string },
    guard: RootEvictionMaintenanceGuard
  ): Promise<RootEvictionObservation<RootEvictionPendingPage>> {
    return this.work(guard, () => {
      outputAssert(
        Object.keys(input).every(key => key === 'maximum' || key === 'after') &&
          Number.isSafeInteger(input.maximum) &&
          input.maximum >= 1 &&
          input.maximum <= 64,
        'Invalid root maintenance page bound'
      )
      const after = input.after === undefined ? '' : outputHex32(input.after)
      // The immutable digest PK and bounded permanent request/action capacities
      // bound this scan. Do not load up to 64 MiB of proof packets just to schedule.
      const rows = this.database.all(
        `SELECT r.digest FROM root_requests r WHERE r.digest>? AND
         (SELECT count(*) FROM root_actions a WHERE a.request_digest=r.digest)<r.targets
         ORDER BY r.digest LIMIT ?`,
        after,
        input.maximum + 1
      )
      const digests = rows.slice(0, input.maximum).map(row => outputHex32(row.digest))
      return {
        digests,
        ...(rows.length > input.maximum ? { next: digests.at(-1) } : {})
      }
    })
  }

  expirePending(
    digest: string,
    guard: RootEvictionMaintenanceGuard
  ): Promise<RootEvictionObservation<{ expiredTargets: number[]; pendingTargets: number[] }>> {
    return this.work(guard, now => {
      const record = this.requests.byDigest(digest)
      outputAssert(record, 'Root maintenance request is not retained', 'not-found')
      const before = this.requests.pending(record)
      this.requests.expire(record, now)
      const pendingTargets = this.requests.pending(record)
      return {
        expiredTargets: before.filter(index => !pendingTargets.includes(index)),
        pendingTargets
      }
    })
  }

  close(): Promise<void> {
    return synchronousPromise(() => this.database.close())
  }
}
