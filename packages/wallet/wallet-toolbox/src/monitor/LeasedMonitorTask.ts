import { TransactionService } from '../storage/schema/transactionService'

/**
 * Helper that wraps a long-running monitor task body in `monitor_lease`
 * acquire / renew / release semantics.
 *
 * Usage:
 * ```typescript
 * const helper = new LeasedMonitorTask(txSvc)
 * const { ran } = await helper.run('proof-acquisition', ownerId, 30_000, async () => {
 *   // task body runs only when lease is acquired
 * })
 * if (!ran) {
 *   console.log('lease held by another instance – skipping')
 * }
 * ```
 *
 * Lease renewal is driven by a `setInterval` firing at `ttlMs * 0.4` so the
 * lease is always refreshed well before it would expire (40 % window). The
 * interval is cleared in the `finally` block before `releaseLease` is called.
 *
 * Logging writes to `console.log` so that lease activity is visible in the
 * same stream as other Monitor diagnostics.
 */
export class LeasedMonitorTask {
  constructor (private readonly svc: TransactionService) {}

  /**
   * Attempt to claim the named lease and, if successful, execute `body`.
   *
   * @param taskName  Logical task identifier stored in `monitor_lease.task_name`.
   * @param ownerId   Stable identifier for this Monitor instance.
   * @param ttlMs     Lease TTL in milliseconds.  Renewal fires at `ttlMs * 0.4`.
   * @param body      Async work to perform while holding the lease.
   *
   * @returns `{ ran: true }` when the lease was acquired and `body` completed
   *          (even if `body` threw — the error is re-thrown after cleanup).
   *          `{ ran: false }` when another owner holds a live lease.
   */
  async run (
    taskName: string,
    ownerId: string,
    ttlMs: number,
    body: () => Promise<void>
  ): Promise<{ ran: boolean }> {
    const claim = await this.svc.tryClaimLease({ taskName, ownerId, ttlMs })
    if (!claim.acquired) {
      console.log(`[LeasedMonitorTask] ${taskName}: lease held by another owner — skipping`)
      return { ran: false }
    }

    console.log(`[LeasedMonitorTask] ${taskName}: lease acquired by ${ownerId} (ttl=${ttlMs}ms)`)

    // Renew at 40 % of TTL so there is always a healthy margin before expiry.
    const renewIntervalMs = Math.max(1000, Math.floor(ttlMs * 0.4))
    let renewFailures = 0
    const renewTimer = setInterval(async () => {
      try {
        const result = await this.svc.renewLease({ taskName, ownerId, ttlMs })
        if (result.acquired) {
          renewFailures = 0
          console.log(`[LeasedMonitorTask] ${taskName}: lease renewed (renewCount=${result.lease?.renewCount ?? '?'})`)
        } else {
          renewFailures++
          console.log(`[LeasedMonitorTask] ${taskName}: lease renew failed (attempt ${renewFailures}) — may have been taken over`)
        }
      } catch (err: unknown) {
        renewFailures++
        const msg = err instanceof Error ? err.message : String(err)
        console.log(`[LeasedMonitorTask] ${taskName}: lease renew error (attempt ${renewFailures}): ${msg}`)
      }
    }, renewIntervalMs)

    try {
      await body()
      return { ran: true }
    } finally {
      clearInterval(renewTimer)
      try {
        const released = await this.svc.releaseLease({ taskName, ownerId })
        console.log(`[LeasedMonitorTask] ${taskName}: lease released by ${ownerId} (deleted=${released})`)
      } catch (releaseErr: unknown) {
        const msg = releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
        console.log(`[LeasedMonitorTask] ${taskName}: lease release error: ${msg}`)
      }
    }
  }
}
