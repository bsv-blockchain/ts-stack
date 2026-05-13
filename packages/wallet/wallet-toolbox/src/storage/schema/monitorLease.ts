import { Knex } from 'knex'
import { TableMonitorLease } from './tables'

/**
 * monitor lease primitive.
 *
 * A `monitor_lease` row records the owner that may currently execute a named
 * task. Acquisition is opportunistic: a Monitor calls `tryClaimLease()` to
 * insert or take over a stale row; if it succeeds it owns the task until
 * `expiresAt`. While running it calls `renewLease()` to extend the deadline.
 * On clean shutdown it calls `releaseLease()`.
 *
 * The Knex driver expresses claim + takeover as a single conditional UPDATE
 * so that two contending Monitors cannot both believe they own the task — at
 * most one row write will succeed per (task, expiry) pair.
 */
export interface MonitorLeaseClaim {
  taskName: string
  ownerId: string
  ttlMs: number
  note?: string
}

export interface MonitorLeaseRenew {
  taskName: string
  ownerId: string
  ttlMs: number
  note?: string
}

export interface MonitorLeaseRelease {
  taskName: string
  ownerId: string
}

export interface MonitorLeaseResult {
  acquired: boolean
  lease?: TableMonitorLease
}

/**
 * Try to claim a lease on `taskName`. Succeeds iff:
 *   - no row exists for the task, OR
 *   - the existing row has `expiresAt <= now`, OR
 *   - the existing row's `ownerId` already equals the requested owner.
 *
 * On success the row is upserted with `expiresAt = now + ttlMs` and
 * `renewCount = renewCount + 1` (0 for fresh rows).
 */
export async function tryClaimLease (
  knex: Knex,
  claim: MonitorLeaseClaim,
  now: Date = new Date()
): Promise<MonitorLeaseResult> {
  const expiresAt = new Date(now.getTime() + claim.ttlMs)
  return await knex.transaction(async trx => {
    const existing = await trx('monitor_lease').where({ task_name: claim.taskName }).forUpdate().first()
    const canClaim =
      existing == null ||
      new Date(existing.expires_at).getTime() <= now.getTime() ||
      existing.owner_id === claim.ownerId
    if (!canClaim) return { acquired: false }

    if (existing == null) {
      await trx('monitor_lease').insert({
        task_name: claim.taskName,
        owner_id: claim.ownerId,
        expires_at: expiresAt,
        renew_count: 0,
        note: claim.note ?? null,
        created_at: now,
        updated_at: now
      })
    } else {
      await trx('monitor_lease')
        .where({ task_name: claim.taskName })
        .update({
          owner_id: claim.ownerId,
          expires_at: expiresAt,
          renew_count: existing.owner_id === claim.ownerId ? existing.renew_count + 1 : 0,
          note: claim.note ?? existing.note,
          updated_at: now
        })
    }

    const row = await trx('monitor_lease').where({ task_name: claim.taskName }).first()
    return { acquired: true, lease: mapRow(row) }
  })
}

/**
 * Extend the current owner's lease. Fails (returns `acquired: false`) when the
 * row does not exist, is owned by someone else, or has already expired.
 */
export async function renewLease (
  knex: Knex,
  renew: MonitorLeaseRenew,
  now: Date = new Date()
): Promise<MonitorLeaseResult> {
  const expiresAt = new Date(now.getTime() + renew.ttlMs)
  return await knex.transaction(async trx => {
    const existing = await trx('monitor_lease').where({ task_name: renew.taskName }).forUpdate().first()
    if (existing == null) return { acquired: false }
    if (existing.owner_id !== renew.ownerId) return { acquired: false }
    if (new Date(existing.expires_at).getTime() <= now.getTime()) return { acquired: false }
    await trx('monitor_lease')
      .where({ task_name: renew.taskName })
      .update({
        expires_at: expiresAt,
        renew_count: existing.renew_count + 1,
        note: renew.note ?? existing.note,
        updated_at: now
      })
    const row = await trx('monitor_lease').where({ task_name: renew.taskName }).first()
    return { acquired: true, lease: mapRow(row) }
  })
}

/**
 * Release the lease (no-op when not owned by the caller).
 * The row is deleted so subsequent claimants do not see an inherited
 * `renew_count`.
 */
export async function releaseLease (knex: Knex, release: MonitorLeaseRelease): Promise<boolean> {
  const deleted = await knex('monitor_lease')
    .where({ task_name: release.taskName, owner_id: release.ownerId })
    .delete()
  return deleted > 0
}

function mapRow (row: any): TableMonitorLease {
  return {
    created_at: new Date(row.created_at),
    updated_at: new Date(row.updated_at),
    taskName: row.task_name,
    ownerId: row.owner_id,
    expiresAt: new Date(row.expires_at),
    renewCount: row.renew_count,
    note: row.note ?? undefined
  }
}
