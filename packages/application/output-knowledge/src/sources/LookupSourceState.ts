import {
  canonicalOutputJSON,
  parseOutputJSON,
  closedOutputObject,
  outputU64,
  outputHex32,
  incrementOutputU64,
  validateOutputLookupContinuation,
  OutputProtocolError,
  type OutputJSONObject,
  type OutputLookupOpen,
  type OutputLookupCheckpoint,
  type OutputRetainedCapability
} from '@bsv/sdk'
import { knowledgeMutation, type MutationLookup } from '../storage/Journal.js'
import type { SourceBatch } from '../ports.js'
import { LookupSourceFraming, lookupSourceCheckpoint } from './LookupSourceFraming.js'
import { DEFAULT_OPERATION_STATE_LIMITS } from '../operations/OperationStateStore.js'

export interface LookupSourceOriginal {
  /** Validated using the SDK retention helpers under the installed local trust policy. */
  contract: OutputRetainedCapability
  open: OutputLookupOpen
}
export interface LookupSourceState {
  format: 'output-live-lookup-source/1'
  job: string
  minimumReceived: string
  original: LookupSourceOriginal
  previous: OutputLookupCheckpoint | null
  previousReceipt: { key: string; received: string } | null
  pending: SourceBatch | null
}
const format = 'output-live-lookup-source/1'
const maximumU64 = '18446744073709551615'

/**
 * Local state transitions for one saved opening. The caller supplies actual
 * durable receipt lookups and persists each result with control-store CAS.
 * This codec performs no HTTP, Bitcoin verification or storage writes.
 */
export class LookupSourceStateCodec {
  private readonly original: LookupSourceOriginal
  private readonly originalJSON: string

  constructor(
    original: LookupSourceOriginal,
    private readonly framing: LookupSourceFraming,
    readonly stateBytes: number
  ) {
    if (
      !Number.isSafeInteger(stateBytes) ||
      stateBytes < 1 ||
      stateBytes > DEFAULT_OPERATION_STATE_LIMITS.stateBytes
    )
      throw new OutputProtocolError('invalid', 'Invalid lookup control-state capacity')
    const open = framing.opening(original.open)
    this.originalJSON = canonicalOutputJSON(
      { contract: original.contract, open },
      { bytes: stateBytes }
    )
    this.original = JSON.parse(this.originalJSON) as LookupSourceOriginal
  }

  initial(minimumReceived: string): LookupSourceState {
    outputU64(minimumReceived)
    return this.parse({
      format,
      job: '0',
      minimumReceived,
      original: this.original,
      previous: null,
      previousReceipt: null,
      pending: null
    })
  }

  parse(input: unknown): LookupSourceState {
    const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: this.stateBytes }), {
      bytes: this.stateBytes
    })
    closedOutputObject(value, [
      'format',
      'job',
      'minimumReceived',
      'original',
      'previous',
      'previousReceipt',
      'pending'
    ])
    if (value.format !== format)
      throw new OutputProtocolError('unsupported', 'Unknown lookup source state version')
    outputU64(value.job)
    outputU64(value.minimumReceived)
    if (canonicalOutputJSON(value.original) !== this.originalJSON)
      throw new OutputProtocolError('context-changed', 'Original lookup opening changed')
    const previous = value.previous === null ? null : this.framing.checkpoint(value.previous)
    const previousReceipt = this.parseReceipt(
      value.previousReceipt,
      value.minimumReceived as string
    )
    const pending = value.pending === null ? null : this.framing.parse(value.pending)
    if (
      (value.job === '0') !== (previous === null) ||
      (previous === null) !== (previousReceipt === null)
    )
      throw new OutputProtocolError('invalid', 'Lookup job lost its committed predecessor')
    this.checkPending(previous, pending)
    return {
      format,
      job: value.job as string,
      minimumReceived: value.minimumReceived as string,
      original: JSON.parse(this.originalJSON) as LookupSourceOriginal,
      previous,
      previousReceipt,
      pending
    }
  }

  private parseReceipt(input: unknown, minimum: string): LookupSourceState['previousReceipt'] {
    if (input === null) return null
    closedOutputObject(input, ['key', 'received'])
    const position = outputU64(input.received)
    if (position === 0n || position > outputU64(minimum))
      throw new OutputProtocolError('invalid', 'Invalid lookup predecessor receipt position')
    return { key: outputHex32(input.key), received: input.received as string }
  }

  private checkPending(
    previous: LookupSourceState['previous'],
    pending: LookupSourceState['pending']
  ): void {
    if (pending?.coverage.status === 'reset-required') {
      if (
        previous === null ||
        canonicalOutputJSON(pending) !==
          canonicalOutputJSON(this.framing.reset(previous, pending.provenance.receivedAt))
      )
        throw new OutputProtocolError('invalid', 'Continuity reset lost its exact predecessor')
    } else if (pending !== null) {
      const next = lookupSourceCheckpoint(pending)
      if (previous === null) {
        if (next.phase !== 'snapshot')
          throw new OutputProtocolError('invalid', 'Opening must establish a snapshot')
      } else {
        // This SDK continuity predicate checks metadata and group order. Actual
        // negotiated HTTP limits were checked by the authenticated transport.
        validateOutputLookupContinuation(previous, {
          ...next,
          groups: pending.groups,
          limits: this.original.open.limits
        })
      }
    }
  }

  value(input: LookupSourceState): OutputJSONObject {
    return parseOutputJSON(canonicalOutputJSON(this.parse(input), { bytes: this.stateBytes }), {
      bytes: this.stateBytes
    }) as OutputJSONObject
  }

  reserveMinimum(input: LookupSourceState, received: string): LookupSourceState {
    const state = this.parse(input)
    if (outputU64(received) < outputU64(state.minimumReceived))
      throw new OutputProtocolError('reset-required', 'Core journal precedes retained lookup state')
    return this.parse({ ...state, minimumReceived: received })
  }

  capture(input: LookupSourceState, packet: unknown, receivedAt: string): LookupSourceState {
    const state = this.parse(input)
    if (state.pending !== null)
      throw new OutputProtocolError('conflict', 'Lookup job already has a captured response')
    const pending = this.framing.fromLookup(packet, this.original.open.limits.maxBytes, receivedAt)
    return this.parse({ ...state, pending })
  }

  reset(input: LookupSourceState, receivedAt: string): LookupSourceState {
    const state = this.parse(input)
    if (state.pending !== null || state.previous === null)
      throw new OutputProtocolError('conflict', 'Continuity reset requires a committed predecessor')
    return this.parse({ ...state, pending: this.framing.reset(state.previous, receivedAt) })
  }

  advance(input: LookupSourceState, lookup: MutationLookup): LookupSourceState {
    const state = this.parse(input)
    if (state.pending === null)
      throw new OutputProtocolError('conflict', 'Lookup job has no captured response')
    if (state.pending.coverage.status === 'reset-required')
      throw new OutputProtocolError('reset-required', 'Continuity reset requires a new generation')
    if (lookup.status === 'unavailable')
      throw new OutputProtocolError('unavailable', 'Lookup receipt cannot be established')
    if (lookup.status === 'absent')
      throw new OutputProtocolError('conflict', 'Lookup response has not been durably received')
    const mutation = knowledgeMutation({ kind: 'receive', batch: state.pending })
    if (
      lookup.entry.key !== mutation.key ||
      canonicalOutputJSON(lookup.entry.body) !== canonicalOutputJSON(mutation.body)
    )
      throw new OutputProtocolError(
        'equivocation',
        'Durable lookup receipt differs from captured response'
      )
    const received = outputU64(lookup.entry.revision.received)
    if (received === 0n)
      throw new OutputProtocolError('reset-required', 'Committed lookup receipt has no revision')
    return this.parse({
      ...state,
      job: incrementOutputU64(state.job),
      minimumReceived:
        received > outputU64(state.minimumReceived)
          ? lookup.entry.revision.received
          : state.minimumReceived,
      previous: lookupSourceCheckpoint(state.pending),
      previousReceipt: { key: lookup.entry.key, received: lookup.entry.revision.received },
      pending: null
    })
  }

  /** Preflight both complete source receipt and complete control-state framing. */
  maximumWireBytes(): number {
    const pending = this.framing.maximumEnvelope()
    // false is one byte longer than true. Snapshot is the longest phase tag.
    const previous = { ...lookupSourceCheckpoint(pending), snapshotComplete: false }
    const frame = {
      format,
      job: maximumU64,
      minimumReceived: maximumU64,
      original: this.original,
      previous,
      previousReceipt: { key: 'f'.repeat(64), received: maximumU64 },
      pending
    }
    const overhead = new TextEncoder().encode(canonicalOutputJSON(frame)).length
    const allowance = Math.min(
      this.original.open.limits.maxBytes,
      this.framing.maximumWireBytes(),
      this.stateBytes - overhead
    )
    if (allowance < 1)
      throw new OutputProtocolError('limited', 'Control capacity cannot hold a lookup response')
    return allowance
  }
}
