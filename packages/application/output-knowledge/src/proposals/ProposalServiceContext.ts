import {
  canonicalOutputJSON,
  closedOutputObject,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  type OutputCapabilitySelection,
  type OutputJSONObject,
  type OutputRetainedCapability
} from '@bsv/sdk'
import type { ProposalCapabilityContracts } from './ProposalCapabilityContracts.js'
import type { ProposalChannelRecord, ProposalTransition } from './ProposalTransitions.js'

export interface ProposalServiceContext {
  format: 'proposal-service/1'
  publication: OutputRetainedCapability
  admission?: OutputRetainedCapability
  retainUntil: string
}

export function proposalServiceLocal(context: ProposalServiceContext): OutputJSONObject {
  return parseOutputJSON(canonicalOutputJSON(context)) as OutputJSONObject
}

/** Only local journal bytes may enter here. Both original selections remain recoverable. */
export function restoreProposalServiceContext(
  local: OutputJSONObject | undefined,
  record: ProposalChannelRecord,
  contracts: ProposalCapabilityContracts
): ProposalServiceContext {
  if (local === undefined)
    throw new OutputProtocolError('unavailable', 'Proposal service recovery context is missing')
  closedOutputObject(local, ['format', 'publication', 'retainUntil'], ['admission'])
  if (local.format !== 'proposal-service/1')
    throw new OutputProtocolError('unsupported', 'Unknown proposal service context')
  outputU64(local.retainUntil)
  contracts.requirePolicy(local.publication, record.proposal.body.policy)
  if ((local.admission !== undefined) !== (record.admission !== undefined))
    throw new OutputProtocolError(
      'unavailable',
      'Proposal admission contract is missing or misplaced'
    )
  if (local.admission !== undefined)
    contracts.requirePolicy(local.admission, record.proposal.body.policy)
  return JSON.parse(canonicalOutputJSON(local)) as ProposalServiceContext
}

export function proposalRetentionDeadline(
  record: ProposalChannelRecord,
  selection: OutputCapabilitySelection,
  previous = '0'
): string {
  let basis = outputU64(record.proposal.body.expiresAt)
  const recorded = outputU64(record.state.recordedAt)
  // Exact U64 seconds require BigInt; Math.max cannot represent this domain.
  if (recorded > basis) basis = recorded
  const deadline = basis + outputU64(selection.profile.parameters.retentionSeconds)
  // Detect overflow before making a retention promise or starting admission.
  outputU64(deadline.toString())
  if (outputU64(previous) >= deadline) return previous
  return deadline.toString()
}

/**
 * Preflight both copies of any terminal state (record and event), including the
 * largest timestamp/deadline. Outcome ports must enforce their declared bound
 * before effects. These are capacity bytes, not a fabricated admission receipt.
 */
export function proposalCompletionBytes(
  plan: ProposalTransition,
  context: ProposalServiceContext,
  maximumOutcomeBytes: number
): number {
  const frame = {
    storageFormat: 'output-proposal-entry/1',
    transition: {
      expectedToken: '0'.repeat(64),
      next: { ...plan.next, state: null },
      events: [{ kind: 'proposal-state', proposalId: plan.next.proposalId, state: null }],
      changed: true
    },
    local: { ...context, retainUntil: '18446744073709551615' },
    localDigest: '0'.repeat(64)
  }
  const bytes = new TextEncoder().encode(canonicalOutputJSON(frame)).length
  // Changing outcome.status to state.status and adding recordedAt/globalOutcome
  // costs less than 128 bytes, even for a rejected outcome and a U64 timestamp.
  return bytes - 8 + 2 * (maximumOutcomeBytes + 128)
}

export function proposalTerminalResponseBytes(
  record: ProposalChannelRecord,
  maximumOutcomeBytes: number
): number {
  const bodies = [
    { version: 1, proposal: record.proposal, state: null },
    { version: 1, proposalId: record.proposalId, state: null }
  ]
  return (
    Math.max(...bodies.map(body => new TextEncoder().encode(canonicalOutputJSON(body)).length)) -
    4 +
    maximumOutcomeBytes +
    128
  )
}
