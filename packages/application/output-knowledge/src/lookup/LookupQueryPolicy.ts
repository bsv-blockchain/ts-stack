import type { OutputJSON, OutputJSONObject, OutputObservation, OutputScope } from '@bsv/sdk'
import type { LookupIndexGroup, LookupIndexRow } from './LookupIndexCodec.js'

type WithoutIdentity<T> = T extends unknown ? Omit<T, 'id' | 'scope'> : never
export type LookupObservationTemplate = WithoutIdentity<OutputObservation>

/** Owned immutable query inputs; current disclosure authorization is a separate gate. */
export interface LookupQueryContext {
  scope: OutputScope
  principal: string | null
  query: OutputJSON
  parameters: OutputJSONObject
}

/**
 * Locally installed deterministic code. A remote rule identifier never loads code.
 * These methods must not perform I/O, consult mutable state/time, or depend on
 * response limits/session IDs. Snapshot ordering is canonical index-key order;
 * the registered rules must define how application records receive those keys.
 * Every transition receives one complete before/after domain group, preserving
 * atomic membership/context/spend/proposal changes as one observation group.
 */
export interface LookupQueryPolicy {
  readonly id: string
  parameters(input: unknown): OutputJSONObject
  /** Bounded deterministic prepared JSON; the original wire query keeps its digest. */
  query(input: OutputJSON, parameters: OutputJSONObject): OutputJSON
  snapshot(row: LookupIndexRow, context: LookupQueryContext): LookupObservationTemplate[]
  transition(group: LookupIndexGroup, context: LookupQueryContext): LookupObservationTemplate[]
}

export interface LookupQueryInstallation {
  policy: LookupQueryPolicy
  parameters: OutputJSONObject
}
export interface LookupQueryDescription {
  rules: { id: string; parameters: OutputJSONObject }
  rulesDigest: string
}
