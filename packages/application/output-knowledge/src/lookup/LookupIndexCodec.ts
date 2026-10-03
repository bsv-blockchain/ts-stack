import {
  canonicalOutputJSON,
  closedOutputObject,
  Hash,
  incrementOutputU64,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  Utils,
  type OutputJSONObject
} from '@bsv/sdk'
import { lookupIndexKey } from './LookupIndexKey.js'

/** Prepared index data, not a Bitcoin validity or disclosure decision. */
export interface LookupIndexValue {
  data: OutputJSONObject
  expiresAt: string | null
}
export interface LookupIndexRow {
  key: string
  revision: string
  value: LookupIndexValue
}
export interface LookupIndexEdit {
  key: string
  /** null is an absence predicate, not an unconditional write. */
  previous: string | null
  next: LookupIndexValue | null
}
export interface LookupIndexMutation {
  /** The complete index head observed while preparing this domain change. */
  base: string
  evaluatedAt: string
  edits: LookupIndexEdit[]
  event: OutputJSONObject
}
export interface LookupIndexGroup {
  sequence: string
  recordedAt: string
  changes: { key: string; before: LookupIndexRow | null; after: LookupIndexRow | null }[]
  event: OutputJSONObject
}
export interface LookupIndexLimits {
  rowBytes: number
  groupBytes: number
  changes: number
}
export const DEFAULT_LOOKUP_INDEX_LIMITS: Readonly<LookupIndexLimits> = Object.freeze({
  rowBytes: 1048576,
  groupBytes: 4194304,
  changes: 1024
})

function object(input: unknown): OutputJSONObject {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new OutputProtocolError('invalid', 'Lookup index data must be a JSON object')
  return input as OutputJSONObject
}
function entries(input: unknown, maximum: number): unknown[] {
  if (!Array.isArray(input) || input.length > maximum)
    throw new OutputProtocolError('limited', 'Lookup domain group change limit')
  return input
}
function uniqueKeys(values: readonly { key: string }[]): void {
  if (new Set(values.map(value => value.key)).size !== values.length)
    throw new OutputProtocolError('invalid', 'A lookup domain group repeats an index key')
}

/**
 * Owned, bounded versioned-index records shared by durable backend adapters.
 * Planning is pure: the backend must compare base, read the rows, write every
 * version and append the complete group in ONE transaction. A consumer's query
 * policy derives observations separately, preserving this domain group boundary.
 */
export class LookupIndexCodec {
  readonly limits: Readonly<LookupIndexLimits>
  constructor(limits: Partial<LookupIndexLimits> = {}) {
    const selected = { ...DEFAULT_LOOKUP_INDEX_LIMITS, ...limits }
    for (const key of Object.keys(selected) as (keyof LookupIndexLimits)[])
      if (
        !Object.hasOwn(DEFAULT_LOOKUP_INDEX_LIMITS, key) ||
        !Number.isSafeInteger(selected[key]) ||
        selected[key] < 1 ||
        selected[key] > DEFAULT_LOOKUP_INDEX_LIMITS[key]
      )
        throw new OutputProtocolError('invalid', 'Invalid lookup index capacity')
    this.limits = Object.freeze(selected)
  }

  private owned(input: unknown, bytes: number): unknown {
    return parseOutputJSON(canonicalOutputJSON(input, { bytes }), { bytes })
  }

  value(input: unknown): LookupIndexValue {
    const value = this.owned(input, this.limits.rowBytes)
    closedOutputObject(value, ['data', 'expiresAt'])
    if (value.expiresAt !== null) outputU64(value.expiresAt)
    return { data: object(value.data), expiresAt: value.expiresAt as string | null }
  }

  row(input: unknown): LookupIndexRow {
    const value = this.owned(input, this.limits.rowBytes)
    closedOutputObject(value, ['key', 'revision', 'value'])
    if (outputU64(value.revision) === 0n)
      throw new OutputProtocolError('invalid', 'Lookup row revision must be positive')
    return {
      key: lookupIndexKey(value.key),
      revision: value.revision as string,
      value: this.value(value.value)
    }
  }

  mutation(input: unknown): LookupIndexMutation {
    const value = this.owned(input, this.limits.groupBytes)
    closedOutputObject(value, ['base', 'evaluatedAt', 'edits', 'event'])
    const base = outputU64(value.base)
    const evaluatedAt = outputU64(value.evaluatedAt)
    const edits = entries(value.edits, this.limits.changes).map(input => {
      closedOutputObject(input, ['key', 'previous', 'next'])
      if (
        input.previous !== null &&
        (outputU64(input.previous) === 0n || outputU64(input.previous) > base)
      )
        throw new OutputProtocolError(
          'invalid',
          'Lookup row predicate is outside the observed head'
        )
      const next = input.next === null ? null : this.value(input.next)
      if (next !== null && next.expiresAt !== null && outputU64(next.expiresAt) <= evaluatedAt)
        throw new OutputProtocolError('invalid', 'Cannot publish an already expired lookup row')
      return {
        key: lookupIndexKey(input.key),
        previous: input.previous as string | null,
        next
      }
    })
    uniqueKeys(edits)
    return {
      base: value.base as string,
      evaluatedAt: value.evaluatedAt as string,
      edits,
      event: object(value.event)
    }
  }

  /** Exact retry key for a mutation at its original head; never a new write identity. */
  mutationKey(input: LookupIndexMutation): string {
    const text = canonicalOutputJSON(this.mutation(input), { bytes: this.limits.groupBytes })
    return Utils.toHex(Hash.sha256(Utils.toArray('output-lookup-index/1\0' + text, 'utf8')))
  }

  plan(input: LookupIndexMutation, current: readonly (LookupIndexRow | null)[]): LookupIndexGroup {
    const mutation = this.mutation(input)
    if (current.length !== mutation.edits.length)
      throw new OutputProtocolError('unavailable', 'Lookup mutation lost its complete read set')
    const rows = this.owned(current, this.limits.groupBytes) as (LookupIndexRow | null)[]
    const sequence = incrementOutputU64(mutation.base)
    const changes = mutation.edits.map((edit, index) => {
      const before = rows[index] === null ? null : this.row(rows[index])
      if (
        (before !== null && before.key !== edit.key) ||
        (before?.revision ?? null) !== edit.previous
      )
        throw new OutputProtocolError('conflict', 'Lookup mutation read predicate changed')
      return {
        key: edit.key,
        before,
        after:
          edit.next === null
            ? null
            : this.row({ key: edit.key, revision: sequence, value: edit.next })
      }
    })
    return this.group({
      sequence,
      recordedAt: mutation.evaluatedAt,
      changes,
      event: mutation.event
    })
  }

  group(input: unknown): LookupIndexGroup {
    const value = this.owned(input, this.limits.groupBytes)
    closedOutputObject(value, ['sequence', 'recordedAt', 'changes', 'event'])
    const sequence = outputU64(value.sequence)
    if (sequence === 0n) throw new OutputProtocolError('invalid', 'Lookup group sequence is zero')
    const recordedAt = outputU64(value.recordedAt)
    const changes = entries(value.changes, this.limits.changes).map(input => {
      closedOutputObject(input, ['key', 'before', 'after'])
      const key = lookupIndexKey(input.key)
      const before = input.before === null ? null : this.row(input.before)
      const after = input.after === null ? null : this.row(input.after)
      if (before !== null && (before.key !== key || outputU64(before.revision) >= sequence))
        throw new OutputProtocolError('invalid', 'Lookup group has an invalid prior row')
      if (
        after !== null &&
        (after.key !== key ||
          after.revision !== value.sequence ||
          (after.value.expiresAt !== null && outputU64(after.value.expiresAt) <= recordedAt))
      )
        throw new OutputProtocolError('invalid', 'Lookup group has an invalid replacement row')
      return { key, before, after }
    })
    uniqueKeys(changes)
    return {
      sequence: value.sequence as string,
      recordedAt: value.recordedAt as string,
      changes,
      event: object(value.event)
    }
  }

  /** Reconstruct an original mutation for exact retry recovery after its commit. */
  original(input: LookupIndexGroup): LookupIndexMutation {
    const group = this.group(input)
    return this.mutation({
      base: (outputU64(group.sequence) - 1n).toString(),
      evaluatedAt: group.recordedAt,
      edits: group.changes.map(change => ({
        key: change.key,
        previous: change.before?.revision ?? null,
        next: change.after?.value ?? null
      })),
      event: group.event
    })
  }
}
