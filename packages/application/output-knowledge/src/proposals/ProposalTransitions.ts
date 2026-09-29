import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  Hash,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  OutputProtocolError,
  outputU64,
  parseOutputChain,
  parseOutputJSON,
  parseOutputProposalFinalize,
  parseOutputProposalFinalizeResponse,
  outputString,
  Utils,
  type OutputProposalState,
  type OutputSignedProposal
} from '@bsv/sdk'
import type { ProposalClockPolicy, ProposalScope } from './ProposalPolicy.js'
import { ProposalPolicyRegistry, validateProposalWindow } from './ProposalPolicyRegistry.js'

/** Persist this job in the same transaction that reserves the proposal head. */
export interface ProposalAdmissionJob {
  caller: string
  operationId: string
  txid: string
  rawTransaction: string
  beef: string
  requestedAt: string
}

/** Local record, never accepted directly from a remote caller. */
export interface ProposalChannelRecord {
  version: 1
  proposalId: string
  proposal: OutputSignedProposal
  state: OutputProposalState
  admission?: ProposalAdmissionJob
}

export type ProposalLifecycleEvent =
  | { kind: 'proposal'; proposalId: string; proposal: OutputSignedProposal }
  | { kind: 'proposal-state'; proposalId: string; state: OutputProposalState }

/**
 * A plan, not a commit receipt. Storage must atomically compare expectedToken,
 * retain next, claim any new (caller, service, operationId), and append events.
 */
export interface ProposalTransition {
  expectedToken: string | null
  next: ProposalChannelRecord
  events: ProposalLifecycleEvent[]
  changed: boolean
}

export type ProposalAdmissionOutcome = {
  operationId: string
  txid: string
} & (
  | { status: 'unresolved' }
  | { status: 'rejected'; reason: string }
  | {
      status: 'admitted'
      steak: Extract<OutputProposalState, { status: 'finalized' }>['steak']
      assessmentContextId: string
    }
)

/** Pure lifecycle decisions. Authentication, current host access and durable CAS are host ports. */
export class ProposalTransitions {
  private readonly scope: ProposalScope
  private readonly clock: ProposalClockPolicy

  constructor(
    private readonly policies: ProposalPolicyRegistry,
    scope: ProposalScope,
    clock: ProposalClockPolicy
  ) {
    this.scope = { chain: parseOutputChain(scope.chain), service: outputString(scope.service) }
    this.clock = { ...clock }
    if (outputU64(clock.maxLifetimeSeconds) === 0n)
      throw new OutputProtocolError('invalid', 'Proposal lifetime must be positive')
    outputU64(clock.futureSkewSeconds)
  }

  /** Persist this exact local configuration alongside the journal namespace. */
  configuration(): {
    scope: ProposalScope
    clock: ProposalClockPolicy
    policies: ReturnType<ProposalPolicyRegistry['describe']>
  } {
    return structuredClone({
      scope: this.scope,
      clock: this.clock,
      policies: this.policies.describe()
    })
  }

  /** Validate a local commit plan against its current stored head before atomic persistence. */
  check(current: ProposalChannelRecord | undefined, input: unknown): ProposalTransition {
    const value = parseOutputJSON(canonicalOutputJSON(input))
    closedOutputObject(value, ['expectedToken', 'next', 'events', 'changed'])
    if (typeof value.changed !== 'boolean' || !Array.isArray(value.events))
      throw new OutputProtocolError('invalid', 'Invalid proposal transition plan')
    if (value.expectedToken !== null) outputHex32(value.expectedToken)
    const previous = current === undefined ? undefined : this.parse(current)
    if (value.expectedToken !== (previous ? proposalRecordToken(previous) : null))
      throw new OutputProtocolError('conflict', 'Proposal head changed')
    const next = this.parse(value.next)
    const planned =
      !value.changed && previous ? unchanged(previous) : this.reconstruct(previous, next)
    if (canonicalOutputJSON(planned) !== canonicalOutputJSON(value))
      throw new OutputProtocolError(
        'invalid',
        'Proposal transition does not match its lifecycle effects'
      )
    return planned
  }

  /** Validate owned local replay material without reinterpreting expiry or consulting a network. */
  parse(input: unknown): ProposalChannelRecord {
    const value = parseOutputJSON(canonicalOutputJSON(input))
    closedOutputObject(value, ['version', 'proposalId', 'proposal', 'state'], ['admission'])
    const proposal = this.policies.validate(value.proposal, this.scope)
    const proposalId = outputHex32(value.proposalId)
    if (value.version !== 1 || proposalId !== outputPacketDigest('proposal', proposal.body))
      throw new OutputProtocolError('invalid', 'Invalid proposal record version or digest')
    const state = parseOutputProposalFinalizeResponse({
      version: 1,
      proposalId,
      state: value.state
    }).state
    const bound = 'operationId' in state
    if (bound !== (value.admission !== undefined))
      throw new OutputProtocolError('invalid', 'Proposal state and admission job differ')
    if ((state.status === 'withdrawn') !== (proposal.body.operation === 'withdraw'))
      throw new OutputProtocolError(
        'invalid',
        'Proposal withdrawal state differs from signed operation'
      )
    const admission = bound ? this.parseJob(value.admission, proposal, state) : undefined
    return { version: 1, proposalId, proposal, state, ...(admission ? { admission } : {}) }
  }

  /** Identical signed-body retries retain the original head and transition clock. */
  put(
    current: ProposalChannelRecord | undefined,
    input: unknown,
    caller: string,
    now: string
  ): ProposalTransition {
    const proposal = this.policies.validate(input, this.scope)
    this.authorize('put', proposal, caller)
    outputU64(now)
    const previous = current === undefined ? undefined : this.parse(current)
    return this.update(previous, proposal, now)
  }

  private update(
    previous: ProposalChannelRecord | undefined,
    proposal: OutputSignedProposal,
    now: string
  ): ProposalTransition {
    const proposalId = outputPacketDigest('proposal', proposal.body)
    if (previous?.proposalId === proposalId) return unchanged(previous)
    validateProposalWindow(proposal.body, now, this.clock)
    if (previous) {
      this.requireActive(previous, now)
      this.policies.successor(previous.proposal, proposal)
    } else if (proposal.body.revision !== '0' || proposal.body.operation !== 'update') {
      throw new OutputProtocolError('conflict', 'A new channel requires revision-zero update')
    }
    const next: ProposalChannelRecord = {
      version: 1,
      proposalId,
      proposal,
      state: {
        status: proposal.body.operation === 'withdraw' ? 'withdrawn' : 'active',
        recordedAt: now
      }
    }
    return changed(previous, next, true)
  }

  private reconstruct(
    previous: ProposalChannelRecord | undefined,
    next: ProposalChannelRecord
  ): ProposalTransition {
    if (!previous || previous.proposalId !== next.proposalId)
      return this.update(previous, next.proposal, next.state.recordedAt)
    if (next.state.status === 'expired') return this.expire(previous, next.state.recordedAt)
    if (next.state.status === 'finalizing' && next.admission) {
      const job = next.admission
      return this.reserve(
        previous,
        job.caller,
        {
          version: 1,
          service: next.proposal.body.service,
          proposalId: next.proposalId,
          operationId: job.operationId,
          txid: job.txid,
          beef: job.beef
        },
        job.rawTransaction,
        next.state.recordedAt
      )
    }
    if (next.state.status === 'finalized' || next.state.status === 'finalization-failed') {
      const state = next.state
      const result: ProposalAdmissionOutcome =
        state.status === 'finalized'
          ? {
              status: 'admitted',
              operationId: state.operationId,
              txid: state.txid,
              steak: state.steak,
              assessmentContextId: state.assessmentContextId
            }
          : {
              status: 'rejected',
              operationId: state.operationId,
              txid: state.txid,
              reason: state.reason
            }
      return this.complete(previous, result, state.recordedAt)
    }
    return unchanged(previous)
  }

  /** Timer expiry is serialized with update/withdraw/reserve, never cancellation of a reserved job. */
  expire(current: ProposalChannelRecord, now: string): ProposalTransition {
    const previous = this.parse(current)
    const clock = outputU64(now)
    if (previous.state.status !== 'active' || clock < outputU64(previous.proposal.body.expiresAt))
      return unchanged(previous)
    return changed(previous, { ...previous, state: { status: 'expired', recordedAt: now } })
  }

  /**
   * verifiedRaw must come from complete BEEF verification by a trusted host port.
   * This method checks the relation, not evidence validity. Commit the returned
   * reservation and operation binding before invoking any admission effect.
   */
  reserve(
    current: ProposalChannelRecord,
    caller: string,
    input: unknown,
    verifiedRaw: string,
    now: string
  ): ProposalTransition {
    const previous = this.parse(current)
    const request = parseOutputProposalFinalize(input)
    this.authorize('finalize', previous.proposal, caller)
    outputU64(now)
    if (request.service !== this.scope.service || request.proposalId !== previous.proposalId)
      throw new OutputProtocolError('conflict', 'Finalization must name the current proposal')
    this.policies.finalization(previous.proposal, verifiedRaw, request.txid)
    if (previous.admission) {
      const job = previous.admission
      if (
        job.caller === caller &&
        job.operationId === request.operationId &&
        (job.txid !== request.txid || job.rawTransaction !== verifiedRaw)
      )
        throw new OutputProtocolError(
          'conflict',
          'Finalization operation is already bound to different bytes'
        )
      return unchanged(previous)
    }
    this.requireActive(previous, now)
    const admission: ProposalAdmissionJob = {
      caller,
      operationId: request.operationId,
      txid: request.txid,
      rawTransaction: verifiedRaw,
      beef: request.beef,
      requestedAt: now
    }
    return changed(previous, {
      ...previous,
      admission,
      state: {
        status: 'finalizing',
        recordedAt: now,
        operationId: request.operationId,
        txid: request.txid
      }
    })
  }

  /** Link the exact durable topic result; uncertainty and late callbacks never rewrite a terminal outcome. */
  complete(
    current: ProposalChannelRecord,
    outcome: ProposalAdmissionOutcome,
    now: string
  ): ProposalTransition {
    const previous = this.parse(current)
    outputU64(now)
    if (
      previous.admission?.operationId !== outcome.operationId ||
      previous.admission.txid !== outcome.txid
    )
      throw new OutputProtocolError(
        'conflict',
        'Admission result does not match the reserved operation'
      )
    if (previous.state.status !== 'finalizing' || outcome.status === 'unresolved')
      return unchanged(previous)
    const common = { recordedAt: now, operationId: outcome.operationId, txid: outcome.txid }
    const state = parseOutputProposalFinalizeResponse({
      version: 1,
      proposalId: previous.proposalId,
      state:
        outcome.status === 'admitted'
          ? {
              ...common,
              status: 'finalized',
              steak: outcome.steak,
              assessmentContextId: outcome.assessmentContextId
            }
          : {
              ...common,
              status: 'finalization-failed',
              reason: outcome.reason,
              globalOutcome: 'unknown'
            }
    }).state
    return changed(previous, { ...previous, state })
  }

  private authorize(
    action: 'put' | 'finalize',
    proposal: OutputSignedProposal,
    caller: string
  ): void {
    if (!this.policies.permits(action, proposal, caller))
      throw new OutputProtocolError(
        'unauthorized',
        'Proposal policy does not authorize this caller'
      )
  }

  private requireActive(record: ProposalChannelRecord, now: string): void {
    if (record.state.status !== 'active')
      throw new OutputProtocolError('conflict', 'Proposal channel is no longer active')
    if (outputU64(now) >= outputU64(record.proposal.body.expiresAt))
      throw new OutputProtocolError('expired', 'Current proposal head has expired')
  }

  private parseJob(
    input: unknown,
    proposal: OutputSignedProposal,
    state: Extract<OutputProposalState, { operationId: string }>
  ): ProposalAdmissionJob {
    closedOutputObject(input, [
      'caller',
      'operationId',
      'txid',
      'rawTransaction',
      'beef',
      'requestedAt'
    ])
    const caller = outputIdentity(input.caller)
    outputU64(input.requestedAt)
    decodeOutputBytes(input.beef)
    if (
      input.operationId !== state.operationId ||
      input.txid !== state.txid ||
      typeof input.rawTransaction !== 'string'
    )
      throw new OutputProtocolError('invalid', 'Proposal admission binding differs from state')
    this.authorize('finalize', proposal, caller)
    this.policies.finalization(proposal, input.rawTransaction, state.txid)
    return {
      caller,
      operationId: state.operationId,
      txid: state.txid,
      rawTransaction: input.rawTransaction,
      beef: input.beef as string,
      requestedAt: input.requestedAt as string
    }
  }
}

/** Local CAS token, not a BRC wire digest or an authentication proof. */
export function proposalRecordToken(record: ProposalChannelRecord): string {
  return Utils.toHex(
    Hash.sha256(Utils.toArray(`BRC194/local-record/v1\0${canonicalOutputJSON(record)}`, 'utf8'))
  )
}

function unchanged(record: ProposalChannelRecord): ProposalTransition {
  return {
    expectedToken: proposalRecordToken(record),
    next: structuredClone(record),
    events: [],
    changed: false
  }
}

function changed(
  previous: ProposalChannelRecord | undefined,
  next: ProposalChannelRecord,
  publication = false
): ProposalTransition {
  const events: ProposalLifecycleEvent[] = []
  if (publication)
    events.push({ kind: 'proposal', proposalId: next.proposalId, proposal: next.proposal })
  events.push({ kind: 'proposal-state', proposalId: next.proposalId, state: next.state })
  return structuredClone({
    expectedToken: previous ? proposalRecordToken(previous) : null,
    next,
    events,
    changed: true
  })
}
