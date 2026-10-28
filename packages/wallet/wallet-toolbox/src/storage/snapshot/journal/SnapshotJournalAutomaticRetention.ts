import type { SnapshotJournalMaintenanceRequest, SnapshotJournalMaintenanceResult } from './SnapshotJournalMaintenance'
import type { SnapshotJournalMaintenanceOptions } from './SnapshotJournalMaintenanceTask'
import type { SnapshotJournalCollectionCursor } from './SnapshotJournalCollection'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'

import type { SnapshotJournalAutomaticRetentionPolicy } from './SnapshotJournalTypes'
export type { SnapshotJournalAutomaticRetentionPolicy } from './SnapshotJournalTypes'
export const DEFAULT_SNAPSHOT_JOURNAL_AUTOMATIC_RETENTION = Object.freeze({
  minimumEvents: 1000000,
  maximumCollectionPages: 2
})
export function snapshotJournalAutomaticRetentionPolicy(
  input: false | SnapshotJournalAutomaticRetentionPolicy | undefined
): Readonly<SnapshotJournalAutomaticRetentionPolicy> | false {
  if (input === false) return false
  const selected = input ?? DEFAULT_SNAPSHOT_JOURNAL_AUTOMATIC_RETENTION
  if (
    !Number.isSafeInteger(selected.minimumEvents) ||
    selected.minimumEvents < 0 ||
    !Number.isSafeInteger(selected.maximumCollectionPages) ||
    selected.maximumCollectionPages < 1 ||
    selected.maximumCollectionPages > 8
  )
    throw new RangeError('Invalid automatic journal retention bounds')
  return Object.freeze({
    minimumEvents: selected.minimumEvents,
    maximumCollectionPages: selected.maximumCollectionPages
  })
}
/** Continuation positions are DATA only. Current configuration is supplied afresh
 * for each pass and actual maintenance repeats native authority inside each
 * writer. No timer, pool, source lifetime or verdict is retained between passes. */
export class SnapshotJournalAutomaticRetention {
  private position?: SnapshotJournalCollectionCursor
  private stream: 'scope' | 'physical' = 'scope'
  private running = false
  async run(
    current: {
      epoch: string
      ceiling: SnapshotJournalRevision
      receiptPolicy: SnapshotJournalMaintenanceRequest['receiptPolicy']
    },
    policy: Readonly<SnapshotJournalAutomaticRetentionPolicy>,
    maintain: (
      request: SnapshotJournalMaintenanceRequest,
      options: SnapshotJournalMaintenanceOptions
    ) => Promise<SnapshotJournalMaintenanceResult>,
    drain: () => Promise<void>,
    options: SnapshotJournalMaintenanceOptions = {}
  ): Promise<void> {
    if (this.running) throw new Error('Automatic journal retention already owns a pass')
    const bounded = snapshotJournalAutomaticRetentionPolicy(policy)
    if (bounded === false) throw new Error('Automatic retention run requires an enabled policy')
    const configuration = {
      epoch: current.epoch,
      ceiling: snapshotJournalRevision(current.ceiling),
      receiptPolicy: {
        receiptLimit: current.receiptPolicy.receiptLimit,
        receiptLifetimeMs: current.receiptPolicy.receiptLifetimeMs
      }
    }
    const lifetimeMs = options.lifetimeMs ?? 5000,
      signal = options.signal
    if (!Number.isSafeInteger(lifetimeMs) || lifetimeMs < 1 || lifetimeMs > 30000)
      throw new RangeError('Invalid automatic journal retention lifetime')
    const expiresAt = Date.now() + lifetimeMs,
      started = performance.now()
    const remaining = () => {
      signal?.throwIfAborted()
      const budget = Math.floor(Math.min(expiresAt - Date.now(), lifetimeMs - (performance.now() - started)))
      if (budget < 1) throw new SnapshotResourceLimitError('Automatic journal retention pass expired')
      return budget
    }
    this.running = true
    const operation = async (input: SnapshotJournalMaintenanceRequest['operation']) => {
      const operationOptions = { lifetimeMs: remaining(), signal }
      let outcome: { value: SnapshotJournalMaintenanceResult } | { error: unknown }
      try {
        outcome = { value: await maintain({ ...configuration, operation: input }, operationOptions) }
      } catch (error) {
        outcome = { error }
      }
      try {
        await drain()
      } catch (error_) {
        if ('error' in outcome && error_ !== outcome.error)
          throw new AggregateError([outcome.error, error_], 'Journal retention and physical cleanup failed', {
            cause: outcome.error
          })
        throw error_
      }
      if ('error' in outcome) throw outcome.error
      return outcome.value
    }
    try {
      remaining()
      const retained = await operation({
        kind: 'retention',
        events: snapshotJournalRevision(String(bounded.minimumEvents))
      })
      if (retained.kind !== 'retention' || retained.value === undefined)
        throw new SnapshotResourceLimitError('Journal clock no longer admits retention')
      const floor = retained.value.floor
      if (this.position !== undefined && this.position.epoch !== configuration.epoch) {
        this.position = undefined
        this.stream = 'scope'
      }
      for (let page = 0; page < bounded.maximumCollectionPages; page++) {
        remaining()
        const after =
          this.position === undefined ? undefined : { ...this.position, floor, key: { ...this.position.key } }
        const collected = await operation({
          kind: 'collect',
          page: {
            epoch: configuration.epoch,
            floor,
            stream: this.stream,
            limit: 256,
            ...(after === undefined ? {} : { after })
          }
        })
        if (collected.kind !== 'collect' || collected.value === undefined)
          throw new SnapshotResourceLimitError('Journal clock no longer admits collection')
        if (collected.value.complete) {
          this.position = undefined
          this.stream = this.stream === 'scope' ? 'physical' : 'scope'
        } else {
          if (collected.value.after === undefined)
            throw new Error('Journal collector failed to advance its bounded keyset')
          this.position = { ...collected.value.after, key: { ...collected.value.after.key } }
        }
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        remaining()
      }
    } finally {
      this.running = false
    }
  }
}
