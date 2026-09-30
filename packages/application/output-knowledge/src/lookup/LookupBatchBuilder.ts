import {
  canonicalOutputJSON,
  closedOutputObject,
  negotiateOutputLookupLimits,
  outputHex32,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputLookupBatch,
  parseOutputScope,
  type OutputLookupBatch,
  type OutputLookupLimits,
  type OutputScope,
  type OutputSourceGroup
} from '@bsv/sdk'
import { LookupCursorCodec, type LookupCursorPosition } from './LookupCursorCodec.js'
import { LookupLimitError } from './LookupLimitError.js'
import type { LookupIndexStorage, LookupIndexSnapshotPage } from './LookupIndexStorage.js'
import type { LookupQueryView } from './LookupQueryRegistry.js'

export interface LookupBatchBoundary {
  session: string
  secret: string
  scope: OutputScope
  watermark: string
  time: string
  expiresAt: string
  replayUntil: string
}
export interface LookupBuiltBatch {
  batch: OutputLookupBatch
  /** Bounded index work, including rows/groups irrelevant to this query. */
  scanned: number
}
interface Assembly extends LookupBuiltBatch {
  groupBytes: number
  observations: number
}
const byteLength = (value: unknown): number =>
  new TextEncoder().encode(canonicalOutputJSON(value)).length

function boundary(input: LookupBatchBoundary): LookupBatchBoundary {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 65536 }), { bytes: 65536 })
  closedOutputObject(value, [
    'session',
    'secret',
    'scope',
    'watermark',
    'time',
    'expiresAt',
    'replayUntil'
  ])
  const result = {
    session: outputHex32(value.session),
    secret: outputHex32(value.secret),
    scope: parseOutputScope(value.scope),
    watermark: outputU64(value.watermark).toString(),
    time: outputU64(value.time).toString(),
    expiresAt: outputU64(value.expiresAt).toString(),
    replayUntil: outputU64(value.replayUntil).toString()
  }
  if (
    outputU64(result.time) >= outputU64(result.expiresAt) ||
    outputU64(result.expiresAt) > outputU64(result.replayUntil)
  )
    throw new OutputProtocolError('invalid', 'Invalid lookup response boundary deadlines')
  return result
}
function cancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new OutputProtocolError('cancelled', 'Lookup response construction cancelled')
}

function checkSnapshotPage(
  page: LookupIndexSnapshotPage,
  watermark: string,
  after: string | null
): void {
  const stationary =
    page.scanned === 0 && page.complete && page.after === after && page.rows.length === 0
  const advanced =
    page.scanned === 1 &&
    page.after !== null &&
    (after === null || page.after > after) &&
    page.rows.length <= 1 &&
    (page.rows.length === 0 || page.rows[0].key === page.after)
  if (
    page.watermark !== watermark ||
    typeof page.complete !== 'boolean' ||
    (!stationary && !advanced)
  )
    throw new OutputProtocolError(
      'reset-required',
      'Lookup snapshot scan lost its bounded position'
    )
}

/**
 * Bounded read-only paging, separate from Open persistence, current authorization,
 * clock advancement and long-poll ownership. The service supplies a highWater
 * captured by a complete advanceTime(T), and pins retained sessions before reads.
 * Only one bounded row/domain group is hydrated at a time. Returned observations
 * are not disclosed until the session store's final current-authorization gate.
 */
export class LookupBatchBuilder {
  constructor(
    private readonly index: LookupIndexStorage,
    readonly maximumScans = 128
  ) {
    if (!Number.isSafeInteger(maximumScans) || maximumScans < 1 || maximumScans > 1024)
      throw new OutputProtocolError('invalid', 'Invalid lookup response scan budget')
  }

  async build(
    input: LookupBatchBoundary,
    query: LookupQueryView,
    incomingCursor: string | null,
    requested: OutputLookupLimits,
    maximums: OutputLookupLimits,
    highWater: string,
    signal?: AbortSignal
  ): Promise<LookupBuiltBatch> {
    cancelled(signal)
    const saved = boundary(input)
    const limits = negotiateOutputLookupLimits(requested, maximums)
    const codec = new LookupCursorCodec(saved.secret, saved.session, saved.scope.epoch)
    const position: LookupCursorPosition =
      incomingCursor === null
        ? { phase: 'snapshot', watermark: saved.watermark, after: null }
        : codec.open(incomingCursor)
    this.checkPosition(saved, position, highWater)
    const batch: OutputLookupBatch = {
      version: 1,
      session: saved.session,
      scope: saved.scope,
      phase: position.phase,
      groups: [],
      cursor: incomingCursor ?? codec.seal(position),
      snapshotComplete: position.phase === 'live',
      through: position.phase === 'live' ? position.through : saved.watermark,
      highWater,
      expiresAt: saved.expiresAt,
      replayUntil: saved.replayUntil,
      limits
    }
    const state: Assembly = { batch, scanned: 0, groupBytes: 0, observations: 0 }
    if (byteLength(batch) > limits.maxBytes) throw this.limit(batch, null, maximums)
    if (position.phase === 'snapshot')
      await this.snapshot(state, saved, query, position, codec, maximums, signal)
    else await this.live(state, query, codec, maximums, signal)
    cancelled(signal)
    return { batch: parseOutputLookupBatch(state.batch, limits.maxBytes), scanned: state.scanned }
  }

  private checkPosition(
    saved: LookupBatchBoundary,
    position: LookupCursorPosition,
    highWater: string
  ): void {
    if (
      outputU64(highWater) < outputU64(saved.watermark) ||
      (position.phase === 'snapshot' && position.watermark !== saved.watermark) ||
      (position.phase === 'live' &&
        (outputU64(position.through) < outputU64(saved.watermark) ||
          outputU64(position.through) > outputU64(highWater)))
    )
      throw new OutputProtocolError(
        'reset-required',
        'Lookup cursor is outside retained index continuity'
      )
  }

  private async snapshot(
    state: Assembly,
    saved: LookupBatchBoundary,
    query: LookupQueryView,
    position: Extract<LookupCursorPosition, { phase: 'snapshot' }>,
    codec: LookupCursorCodec,
    maximums: OutputLookupLimits,
    signal?: AbortSignal
  ): Promise<void> {
    let after = position.after
    for (let step = 0; step < this.maximumScans; step++) {
      cancelled(signal)
      const page = await this.index.snapshot(saved.watermark, after, { records: 1, bytes: 4194304 })
      cancelled(signal)
      checkSnapshotPage(page, saved.watermark, after)
      const group =
        page.rows.length === 0
          ? null
          : query.snapshot(page.rows[0], saved.session, saved.watermark, saved.time)
      const next: LookupCursorPosition = page.complete
        ? { phase: 'live', through: saved.watermark }
        : { phase: 'snapshot', watermark: saved.watermark, after: page.after }
      const candidate = {
        ...state.batch,
        groups: [],
        cursor: codec.seal(next),
        snapshotComplete: page.complete
      }
      state.scanned += page.scanned
      if (!this.append(state, candidate, group, maximums)) return
      if (page.complete) return // The final snapshot response never includes live groups.
      after = page.after
    }
  }

  private async live(
    state: Assembly,
    query: LookupQueryView,
    codec: LookupCursorCodec,
    maximums: OutputLookupLimits,
    signal?: AbortSignal
  ): Promise<void> {
    for (
      let step = 0;
      step < this.maximumScans && outputU64(state.batch.through) < outputU64(state.batch.highWater);
      step++
    ) {
      cancelled(signal)
      const sequence = (outputU64(state.batch.through) + 1n).toString()
      // Direct bounded group read avoids wrapping a maximum-size domain group in
      // another index-page envelope. Every sequence through captured highWater exists.
      const domain = await this.index.group(sequence)
      cancelled(signal)
      if (domain.sequence !== sequence)
        throw new OutputProtocolError('reset-required', 'Lookup log lost its contiguous sequence')
      const group = query.live(domain)
      const candidate = {
        ...state.batch,
        groups: [],
        through: sequence,
        cursor: codec.seal({ phase: 'live', through: sequence })
      }
      state.scanned++
      if (!this.append(state, candidate, group, maximums)) return
    }
  }

  private append(
    state: Assembly,
    candidate: OutputLookupBatch,
    group: OutputSourceGroup | null,
    maximums: OutputLookupLimits
  ): boolean {
    const separator = state.batch.groups.length === 0 ? 0 : 1
    const extra = group === null ? 0 : byteLength(group) + separator
    const observations = state.observations + (group?.observations.length ?? 0)
    if (
      byteLength(candidate) + state.groupBytes + extra > candidate.limits.maxBytes ||
      observations > candidate.limits.maxObservations
    ) {
      if (state.batch.groups.length > 0) return false
      throw this.limit(candidate, group, maximums)
    }
    candidate.groups = state.batch.groups
    if (group !== null) candidate.groups.push(group)
    state.batch = candidate
    state.groupBytes += extra
    state.observations = observations
    return true
  }

  private limit(
    batch: OutputLookupBatch,
    group: OutputSourceGroup | null,
    maximums: OutputLookupLimits
  ): LookupLimitError {
    const selectedMaximums = negotiateOutputLookupLimits(maximums, maximums)
    const observations = group?.observations.length ?? 0
    const envelope = {
      ...batch,
      groups: [],
      // A permanent failure must hold for ANY permitted read limits. A larger
      // echoed observation count or wait could otherwise manufacture overflow.
      limits: {
        maxBytes: selectedMaximums.maxBytes,
        maxObservations: Math.max(1, observations),
        waitMs: 0
      }
    }
    const groupBytes = group === null ? 0 : byteLength(group)
    let size = byteLength(envelope) + groupBytes
    if (size > selectedMaximums.maxBytes || observations > selectedMaximums.maxObservations)
      return new LookupLimitError({ kind: 'permanent-group' })
    // Include the allowance's own decimal digits. Starting at the maximum only
    // decreases its width (at most seven digits under this profile).
    for (let step = 0; step < 8 && envelope.limits.maxBytes !== size; step++) {
      envelope.limits.maxBytes = size
      size = byteLength(envelope) + groupBytes
    }
    return new LookupLimitError({
      kind: group === null ? 'envelope' : 'group',
      minimumBytes: size,
      ...(observations > 0 ? { minimumObservations: observations } : {})
    })
  }
}
