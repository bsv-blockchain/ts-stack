import type { OutputJSONObject } from '@bsv/sdk'
import type {
  LookupIndexGroup,
  LookupIndexLimits,
  LookupIndexMutation,
  LookupIndexRow
} from './LookupIndexCodec.js'

export interface LookupIndexCapacity {
  keys: number
  versions: number
  groups: number
  pins: number
  /** Logical stored JSON payload bytes; host disk/WAL quotas remain separate. */
  bytes: number
}
export interface LookupIndexConfiguration {
  binding: OutputJSONObject
  records: LookupIndexLimits
  capacity: LookupIndexCapacity
}
export interface LookupIndexHead {
  sequence: string
  recordedAt: string
  /** All independent row timers at or before this time have been recorded. */
  processedThrough: string
  /** Snapshot reads require W >= floor; the retained log starts strictly after floor. */
  retention: { floor: string; checkedAt: string }
  retained: LookupIndexCapacity
}
export interface LookupIndexCompactionLimits {
  groups: number
  versions: number
  pins: number
}
export interface LookupIndexCompaction {
  head: LookupIndexHead
  removed: LookupIndexCompactionLimits
}
export interface LookupIndexTimeAdvance {
  head: LookupIndexHead
  expired: number
  complete: boolean
}
export interface LookupIndexReadLimits {
  records: number
  bytes: number
}
export interface LookupIndexSnapshotPage {
  watermark: string
  rows: LookupIndexRow[]
  after: string | null
  scanned: number
  complete: boolean
}
export interface LookupIndexLogPage {
  groups: LookupIndexGroup[]
  through: string
  highWater: string
}

/**
 * Backend-neutral versioned query index, distinct from topic admission and a
 * provider session store. Every returned value is owned. Changes are indivisible;
 * commit compares the complete observed head and all row/absence predicates in
 * the same transaction that appends row versions, the group and the new head.
 * Reads never consume history. Missing promised history is an explicit failure.
 */
export interface LookupIndexStorage {
  readonly durability: 'durable' | 'volatile'
  readonly namespace: string
  readonly configuration: LookupIndexConfiguration
  head(): Promise<LookupIndexHead>
  row(key: string, at: string): Promise<LookupIndexRow | null>
  group(sequence: string): Promise<LookupIndexGroup>
  commit(mutation: LookupIndexMutation): Promise<LookupIndexGroup>
  /** Bounded durable independent-row expiry; partial work never advances the time floor. */
  advanceTime(at: string, maximumGroups: number): Promise<LookupIndexTimeAdvance>
  /** Storage pin only; a provider must commit this together with its complete original Open. */
  retainSnapshot(key: string, watermark: string, replayUntil: string): Promise<void>
  compact(at: string, limits: LookupIndexCompactionLimits): Promise<LookupIndexCompaction>
  snapshot(
    at: string,
    after: string | null,
    limits: LookupIndexReadLimits
  ): Promise<LookupIndexSnapshotPage>
  changes(after: string, limits: LookupIndexReadLimits): Promise<LookupIndexLogPage>
  close(): Promise<void>
}
