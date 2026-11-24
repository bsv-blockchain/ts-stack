import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputU64,
  OutputProtocolError,
  type OutputScope,
  type OutputSignedProposal
} from '@bsv/sdk'
import { outputGroupIdentity, type ReceivedSourceGroup } from '../SourceMembership.js'
import { proposalEnvelopeIdentity, ProposalSourcePolicy } from './ProposalSourcePolicy.js'

/** Local references only; never provider assertions or Bitcoin verdicts. */
export interface ProposalReceiptReference {
  group: string
  observationId: string
  envelope: string
}
export interface ProposalReceiptStamp {
  reference: ProposalReceiptReference
  firstReceivedAt: string
}
export interface ProposalVerification {
  reference: ProposalReceiptReference
  firstReceivedAt: string
  status: 'verified' | 'invalid' | 'unsupported' | 'unauthorized'
}
interface Receipt {
  stamp: ProposalReceiptStamp
  scope: OutputScope
  proposal: OutputSignedProposal
}
interface Candidate {
  reference: ProposalReceiptReference
  scope: OutputScope
  proposal: OutputSignedProposal
}
const identity = (reference: ProposalReceiptReference): string => canonicalOutputJSON(reference)
function reference(
  row: ReceivedSourceGroup,
  observationId: string,
  proposal: OutputSignedProposal
): ProposalReceiptReference {
  return {
    group: outputGroupIdentity(row.scope, row.generation, row.group.id),
    observationId,
    envelope: proposalEnvelopeIdentity(proposal)
  }
}

/**
 * Bounded exact-envelope qualification. Receipt stamps come from the local
 * receive transaction. Collection validates new work; applying retained work
 * checks its binding without repeating signature cryptography during replay.
 */
export class ProposalVerificationPool {
  private readonly receipts = new Map<string, Receipt>()
  private readonly checks = new Map<string, ProposalVerification>()
  private retainedBytes = 0
  constructor(
    private readonly policy: ProposalSourcePolicy,
    private readonly maximum = 4096,
    private readonly maximumBytes = 16 * 1024 * 1024
  ) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 4096)
      throw new OutputProtocolError('invalid', 'Invalid retained proposal bound')
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1 || maximumBytes > 16 * 1024 * 1024)
      throw new OutputProtocolError('invalid', 'Invalid retained proposal byte bound')
  }

  private candidates(rows: readonly ReceivedSourceGroup[]): Map<string, Candidate> {
    const additions = new Map<string, Candidate>()
    for (const row of rows) {
      if (row.status === 'quarantined') continue
      for (const observation of row.group.observations) {
        if (observation.kind !== 'proposal') continue
        const selected = reference(row, observation.id, observation.payload.proposal)
        if (!this.receipts.has(identity(selected)))
          additions.set(identity(selected), {
            reference: selected,
            scope: row.scope,
            proposal: observation.payload.proposal
          })
      }
    }
    return additions
  }

  /** Plan stamps before receive commit; replay uses the retained exact values. */
  stamps(rows: readonly ReceivedSourceGroup[], now: string): ProposalReceiptStamp[] {
    outputU64(now)
    return [...this.candidates(rows).values()].map(({ reference }) => ({
      reference,
      firstReceivedAt: now
    }))
  }

  receive(rows: readonly ReceivedSourceGroup[], stamps: readonly ProposalReceiptStamp[]): void {
    const candidates = this.candidates(rows)
    if (candidates.size !== stamps.length)
      throw new OutputProtocolError('invalid', 'Proposal receipt stamp set differs')
    if (this.receipts.size + stamps.length > this.maximum)
      throw new OutputProtocolError('limited', 'Proposal retained receipt capacity')
    const additions = new Map<string, Receipt>()
    for (const stamp of stamps) {
      closedOutputObject(stamp, ['reference', 'firstReceivedAt'])
      closedOutputObject(stamp.reference, ['group', 'observationId', 'envelope'])
      outputHex32(stamp.reference.envelope)
      outputU64(stamp.firstReceivedAt)
      const key = identity(stamp.reference)
      if (!candidates.has(key) || additions.has(key))
        throw new OutputProtocolError(
          'invalid',
          'Local proposal stamp differs from received envelope'
        )
      const { scope, proposal } = candidates.get(key)!
      additions.set(key, structuredClone({ stamp, scope, proposal }))
    }
    const bytes = [...additions.values()].reduce(
      (total, item) => total + new TextEncoder().encode(canonicalOutputJSON(item)).length,
      0
    )
    if (this.retainedBytes + bytes > this.maximumBytes)
      throw new OutputProtocolError('limited', 'Proposal retained byte capacity')
    for (const [key, receipt] of additions) this.receipts.set(key, receipt)
    this.retainedBytes += bytes
  }

  pending(): ProposalReceiptStamp[] {
    return [...this.receipts]
      .filter(([key]) => !this.checks.has(key))
      .map(([, value]) => structuredClone(value.stamp))
  }

  /** One signature/policy check; the worker owns the count/deadline/abort budget. */
  verify(stamp: ProposalReceiptStamp): ProposalVerification {
    const retained = this.receipts.get(identity(stamp.reference))
    if (!retained || canonicalOutputJSON(retained.stamp) !== canonicalOutputJSON(stamp))
      throw new OutputProtocolError('invalid', 'Unknown local proposal verification work')
    let status: ProposalVerification['status'] = 'verified'
    try {
      this.policy.validate(retained.proposal, retained.scope, retained.stamp.firstReceivedAt)
    } catch (error) {
      if (
        !(error instanceof OutputProtocolError) ||
        !['invalid', 'unsupported', 'unauthorized'].includes(error.code)
      )
        throw error
      status = error.code as ProposalVerification['status']
    }
    return { ...structuredClone(stamp), status }
  }

  apply(work: readonly ProposalVerification[]): void {
    if (work.length > this.maximum)
      throw new OutputProtocolError('limited', 'Proposal decision capacity')
    const additions = new Map<string, ProposalVerification>()
    for (const item of work) {
      closedOutputObject(item, ['reference', 'firstReceivedAt', 'status'])
      closedOutputObject(item.reference, ['group', 'observationId', 'envelope'])
      const key = identity(item.reference),
        retainedAt = this.receipts.get(key)?.stamp.firstReceivedAt
      if (
        retainedAt === undefined ||
        retainedAt !== item.firstReceivedAt ||
        !['verified', 'invalid', 'unsupported', 'unauthorized'].includes(item.status)
      )
        throw new OutputProtocolError(
          'invalid',
          'Retained proposal decision differs from local receipt'
        )
      if (additions.has(key))
        throw new OutputProtocolError('invalid', 'Proposal verification decision was repeated')
      const previous = this.checks.get(key)
      if (previous && canonicalOutputJSON(previous) !== canonicalOutputJSON(item))
        throw new OutputProtocolError('invalid', 'Conflicting retained proposal decision')
      additions.set(key, structuredClone(item))
    }
    for (const [key, item] of additions) this.checks.set(key, item)
  }

  check(
    row: ReceivedSourceGroup,
    observationId: string,
    proposal: OutputSignedProposal
  ): ProposalVerification | undefined {
    const found = this.checks.get(identity(reference(row, observationId, proposal)))
    return found && structuredClone(found)
  }
}
