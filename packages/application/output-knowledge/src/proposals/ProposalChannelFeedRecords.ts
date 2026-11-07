import {
  canonicalOutputJSON,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import type { LookupIndexLimits, LookupIndexValue } from '../lookup/LookupIndexCodec.js'
import type { ProposalJournalLimits } from './ProposalJournal.js'
import type { ProposalChannelRecord, ProposalTransition } from './ProposalTransitions.js'

/** Fixed envelopes: 128 hex key bytes, uint64 positions/times and fixed event metadata. */
const ROW_OVERHEAD = 512
const GROUP_OVERHEAD = 512
export const proposalFeedEvent: Readonly<OutputJSONObject> = Object.freeze({
  kind: 'proposal-current-channel/1'
})

/**
 * Every next.proposal/state is a JSON subtree of the bounded journal payload.
 * These conservative envelopes therefore bound every single-channel future
 * row and before/after group, including a maximal finalization receipt. A batch
 * still passes the exact codec; this does not promise an arbitrarily large batch.
 */
export function assertProposalFeedRecordBounds(
  journal: Pick<ProposalJournalLimits, 'entryBytes'>,
  index: LookupIndexLimits
): void {
  if (
    !Number.isSafeInteger(journal.entryBytes) ||
    journal.entryBytes < 1 ||
    !Number.isSafeInteger(index.rowBytes) ||
    !Number.isSafeInteger(index.groupBytes) ||
    !Number.isSafeInteger(index.changes) ||
    index.changes < 1 ||
    journal.entryBytes + ROW_OVERHEAD > index.rowBytes ||
    2 * (journal.entryBytes + ROW_OVERHEAD) + GROUP_OVERHEAD > index.groupBytes
  )
    throw new OutputProtocolError(
      'invalid',
      'Proposal journal records exceed the sealed feed representation'
    )
}

/** Intent expiry is a proposal lifecycle event, not deletion of retained query membership. */
export function proposalFeedValue(record: ProposalChannelRecord): LookupIndexValue {
  return JSON.parse(
    canonicalOutputJSON({
      data: { version: 1, proposal: record.proposal, state: record.state },
      expiresAt: null
    })
  ) as LookupIndexValue
}

/**
 * Called only for a NEW committed transition inside the writer's actual gate.
 * Exact replays keep their original time and do not pass this freshness check.
 * Completion of an already reserved operation remains recoverable after expiry.
 */
export function assertProposalFeedCommitTime(
  previous: ProposalChannelRecord | undefined,
  transition: ProposalTransition,
  now: string
): void {
  const time = outputU64(now),
    next = transition.next
  if (previous && outputU64(next.state.recordedAt) < outputU64(previous.state.recordedAt))
    throw new OutputProtocolError('context-changed', 'Proposal lifecycle time moved backwards')
  if (outputU64(next.state.recordedAt) > time)
    throw new OutputProtocolError('context-changed', 'Proposal plan is ahead of the commit clock')
  const consumesIntent =
    previous !== undefined &&
    (previous.proposalId !== next.proposalId || next.state.status === 'finalizing')
  if (
    (consumesIntent && time >= outputU64(previous.proposal.body.expiresAt)) ||
    (next.state.status === 'active' && time >= outputU64(next.proposal.body.expiresAt))
  )
    throw new OutputProtocolError('expired', 'Proposal intent expired before its atomic commit')
}

export interface ProposalFeedWireLimits {
  maxBytes: number
  maxObservations: number
}
export const DEFAULT_PROPOSAL_FEED_WIRE: Readonly<ProposalFeedWireLimits> = Object.freeze({
  maxBytes: 4194304,
  maxObservations: 1024
})
const WIRE_ENVELOPE = 65536
const OBSERVATION_OVERHEAD = 65536

/**
 * BRC-192 strings have <=1024 UTF-8 bytes (<=6144 canonical escaped bytes).
 * A scope has at most five such strings; an observation's repeated service and
 * policy identifiers add at most two. Their names, hashes, sequence and bounded
 * observation ID fit the remainder of 64 KiB. Proposal+state JSON is counted
 * separately. Another 64 KiB covers the complete batch/group envelope and the
 * <=1024-character reference cursor. These intentionally conservative bounds
 * cover every permitted reader access string, not only today's connected peers.
 */
export function proposalFeedWireLimits(
  input: Partial<ProposalFeedWireLimits>,
  entryBytes: number
): Readonly<ProposalFeedWireLimits> {
  const wire = { ...DEFAULT_PROPOSAL_FEED_WIRE, ...input }
  if (
    Object.keys(wire).some(key => key !== 'maxBytes' && key !== 'maxObservations') ||
    !Number.isSafeInteger(wire.maxBytes) ||
    wire.maxBytes > 4194304 ||
    !Number.isSafeInteger(wire.maxObservations) ||
    wire.maxObservations < 3 ||
    wire.maxObservations > 1024 ||
    entryBytes + WIRE_ENVELOPE + 3 * OBSERVATION_OVERHEAD > wire.maxBytes
  )
    throw new OutputProtocolError(
      'invalid',
      'Proposal feed cannot guarantee a complete future wire group'
    )
  return Object.freeze(wire)
}

/** Before physical commit: the complete group remains consumable at the sealed advertised maxima. */
export function assertProposalFeedWireGroup(
  values: readonly LookupIndexValue[],
  wire: ProposalFeedWireLimits
): void {
  const observations = 3 * values.length
  let bytes = WIRE_ENVELOPE + observations * OBSERVATION_OVERHEAD
  for (const value of values)
    bytes += new TextEncoder().encode(canonicalOutputJSON(value.data)).length
  if (observations > wire.maxObservations || bytes > wire.maxBytes)
    throw new OutputProtocolError(
      'limited',
      'Proposal domain group exceeds its complete wire reservation'
    )
}
