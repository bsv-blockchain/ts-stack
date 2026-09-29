import {
  canonicalOutputJSON,
  closedOutputObject,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputProposalFinalize,
  parseOutputProposalGet,
  type OutputCapabilitySelection,
  type OutputProposalFinalize,
  type OutputProposalFinalizeResponse,
  type OutputProposalGetResponse,
  type OutputProposalPutResponse,
  type OutputSignedProposal
} from '@bsv/sdk'
import {
  ProposalCapabilityContracts,
  type ProposalCapabilityTrust
} from './ProposalCapabilityContracts.js'
import {
  appendProposalWithRecovery,
  type ProposalJournalEntry,
  type ProposalJournalStorage
} from './ProposalJournal.js'
import type { ProposalAction } from './ProposalPolicy.js'
import { proposalChannelKey } from './ProposalPolicyRegistry.js'
import {
  proposalCompletionBytes,
  proposalRetentionDeadline,
  proposalServiceLocal,
  proposalTerminalResponseBytes,
  proposalVerificationContext,
  restoreProposalServiceContext,
  type ProposalServiceContext
} from './ProposalServiceContext.js'
import type {
  ProposalAdmissionJob,
  ProposalAdmissionOutcome,
  ProposalChannelRecord,
  ProposalTransition,
  ProposalTransitions
} from './ProposalTransitions.js'
import type { VerificationContext } from '../ports.js'

/** Supplied by the authenticated transport, never copied from an unverified request body. */
export interface ProposalServiceCaller {
  caller: string
  capabilityDigest: string
}

export interface ProposalServiceEvidence {
  /** Complete BEEF/Script/chain verification. Return the exact verified raw transaction bytes. */
  verify(request: OutputProposalFinalize, proposal: OutputSignedProposal): Promise<string>
  /** Optional richer result, retained atomically before admission. Never supplied by a remote caller. */
  verifyWithContext?(
    request: OutputProposalFinalize,
    proposal: OutputSignedProposal
  ): Promise<ProposalVerifiedEvidence>
}

export interface ProposalVerifiedEvidence {
  rawTransaction: string
  verificationContext: VerificationContext
}

export interface ProposalServiceAdmission {
  /** Bound every canonical outcome before effects; oversized results must never be committed. */
  readonly maximumOutcomeBytes: number
  /** Require the original verification context; missing legacy material cannot be synthesized. */
  readonly requiresVerificationContext?: boolean
  /**
   * Idempotently admit or reconcile this exact durable job. Concurrent calls and
   * restart must join the same operation; absence alone never establishes rollback.
   * Only a durable ordinary topic receipt may return admitted. The optional
   * context describes the reservation's evidence verification, not current
   * unspentness. assessmentContextId names the actual durable topic assessment,
   * which may predate this reservation; never relabel a recovered receipt with
   * the supplied verification context. No wallet effects.
   */
  recover(
    job: ProposalAdmissionJob,
    proposal: OutputSignedProposal,
    selection: OutputCapabilitySelection,
    verificationContext?: VerificationContext
  ): Promise<ProposalAdmissionOutcome>
}

export interface ProposalServiceOptions {
  lifecycle: ProposalTransitions
  storage: ProposalJournalStorage
  trust: ProposalCapabilityTrust
  /** May return a promise; the resolved value is validated as a signed capability. */
  manifest(): unknown
  now(): string
  access(
    action: ProposalAction,
    proposal: OutputSignedProposal,
    caller: string
  ): boolean | Promise<boolean>
  evidence: ProposalServiceEvidence
  admission: ProposalServiceAdmission
}

type ServiceJournal = ProposalJournalStorage &
  Required<Pick<ProposalJournalStorage, 'getLimits' | 'getChannelEntry' | 'getProposalEntry'>>

/**
 * Durable BRC-194 application service behind an authenticated transport. This
 * layer owns no HTTP, discovery, payment, wallet or Bitcoin verification shortcut.
 * Evidence/admission ports and the transport require independent qualification.
 */
export class ProposalService {
  private readonly storage: ServiceJournal
  private readonly contracts: ProposalCapabilityContracts
  private readonly scope: ReturnType<ProposalTransitions['configuration']>['scope']
  private readonly maximumOutcomeBytes: number
  private readonly requiresVerificationContext: boolean

  constructor(private readonly options: ProposalServiceOptions) {
    const { storage, lifecycle, trust, admission } = options
    if (
      storage.durability !== 'durable' ||
      storage.contextRetention !== 'proposal-journal-context/1' ||
      storage.completionReservation !== 'proposal-journal-completion/1' ||
      !storage.getLimits ||
      !storage.getChannelEntry ||
      !storage.getProposalEntry
    )
      throw new OutputProtocolError(
        'unsupported',
        'Proposal service requires durable context and completion storage'
      )
    if (storage.identity !== outputIdentity(trust.identity))
      throw new OutputProtocolError(
        'context-changed',
        'Proposal storage and provider identity differ'
      )
    this.maximumOutcomeBytes = admission.maximumOutcomeBytes
    if (
      admission.requiresVerificationContext !== undefined &&
      typeof admission.requiresVerificationContext !== 'boolean'
    )
      throw new OutputProtocolError('invalid', 'Invalid verification context requirement')
    this.requiresVerificationContext = admission.requiresVerificationContext === true
    if (
      this.requiresVerificationContext &&
      typeof options.evidence.verifyWithContext !== 'function'
    )
      throw new OutputProtocolError(
        'unsupported',
        'Admission requires a context-retaining evidence port'
      )
    if (
      !Number.isSafeInteger(this.maximumOutcomeBytes) ||
      this.maximumOutcomeBytes < 128 ||
      this.maximumOutcomeBytes > 1048576
    )
      throw new OutputProtocolError('invalid', 'Invalid proposal admission outcome limit')
    this.storage = storage as ServiceJournal
    this.contracts = new ProposalCapabilityContracts(lifecycle, trust)
    this.scope = lifecycle.configuration().scope
  }

  async put(
    input: unknown,
    authenticated: ProposalServiceCaller
  ): Promise<OutputProposalPutResponse> {
    const caller = this.caller(authenticated)
    const packet = this.request(input)
    const value = packet.value
    closedOutputObject(value, ['version', 'proposal'])
    if (value.version !== 1) throw new OutputProtocolError('invalid', 'Invalid proposal version')
    const proposal = this.options.lifecycle.validate(value.proposal)
    await this.authorize('put', proposal, caller.caller)
    const existing = await this.storage.getChannelEntry(proposalChannelKey(proposal.body))
    const proposalId = outputPacketDigest('proposal', proposal.body)
    let selection: OutputCapabilitySelection
    if (existing?.transition.next.proposalId === proposalId) {
      selection = this.recovery(existing, caller)
    } else {
      const selected = await this.select(caller, proposal)
      selection = selected.selection
      this.boundRequest(packet.bytes, selection)
      await this.authorize('put', proposal, caller.caller)
      const plan = this.options.lifecycle.put(
        existing?.transition.next,
        proposal,
        caller.caller,
        this.now()
      )
      this.fresh(selected.record)
      const local: ProposalServiceContext = {
        format: 'proposal-service/1',
        publication: selected.record,
        retainUntil: proposalRetentionDeadline(plan.next, selection)
      }
      this.response({ version: 1, proposal, state: plan.next.state }, selection)
      await this.commit(plan, local)
    }
    this.boundRequest(packet.bytes, selection)
    await this.authorize('put', proposal, caller.caller)
    return this.response(
      { version: 1, proposalId, status: 'recorded', expiresAt: proposal.body.expiresAt },
      selection
    )
  }

  async get(
    input: unknown,
    authenticated: ProposalServiceCaller
  ): Promise<OutputProposalGetResponse> {
    const caller = this.caller(authenticated)
    const packet = this.request(input)
    const request = parseOutputProposalGet(packet.value)
    if (request.service !== this.scope.service) throw missing()
    const key = proposalChannelKey({ ...request, chain: this.scope.chain })
    let entry = await this.storage.getChannelEntry(key)
    if (!entry) throw missing()
    await this.authorize('read', entry.transition.next.proposal, caller.caller)
    const selection = this.recovery(entry, caller)
    this.boundRequest(packet.bytes, selection)
    // Expiry competes through the same durable CAS as updates and finalization.
    await this.expireEntry(entry)
    entry = await this.storage.getChannelEntry(key)
    if (!entry) throw missing()
    await this.authorize('read', entry.transition.next.proposal, caller.caller)
    const currentSelection = this.recovery(entry, caller)
    const { proposal, state } = entry.transition.next
    return this.response({ version: 1, proposal, state }, currentSelection)
  }

  async finalize(
    input: unknown,
    authenticated: ProposalServiceCaller
  ): Promise<OutputProposalFinalizeResponse> {
    const caller = this.caller(authenticated)
    const packet = this.request(input)
    const request = parseOutputProposalFinalize(packet.value)
    if (request.service !== this.scope.service) throw missing()
    const entry = await this.storage.getProposalEntry(request.proposalId)
    if (!entry) throw missing()
    const record = entry.transition.next
    await this.authorize('finalize', record.proposal, caller.caller)
    const operation = await this.storage.getOperation(
      caller.caller,
      request.service,
      request.operationId
    )
    if (operation && operation.proposalId !== request.proposalId)
      throw new OutputProtocolError('conflict', 'Finalization operation names another proposal')
    if (record.admission) {
      const selection = this.recovery(entry, caller)
      this.boundRequest(packet.bytes, selection)
      await this.checkRetry(record, request, caller.caller)
    } else {
      await this.reserve(entry, request, packet.bytes, caller)
    }
    await this.reconcile(request.proposalId)
    const saved = await this.storage.getProposalEntry(request.proposalId)
    if (!saved) throw new OutputProtocolError('unavailable', 'Reserved proposal state is missing')
    await this.authorize('finalize', saved.transition.next.proposal, caller.caller)
    const selection = this.recovery(saved, caller)
    return this.response(
      { version: 1, proposalId: request.proposalId, state: saved.transition.next.state },
      selection
    )
  }

  /** Trusted worker entry: finish only previously reserved work, independently of caller read access. */
  async reconcile(proposalId: string): Promise<void> {
    const entry = await this.storage.getProposalEntry(outputHex32(proposalId))
    if (entry?.transition.next.state.status !== 'finalizing') return
    const record = entry.transition.next
    const local = this.local(entry)
    const selection = this.contracts.restore(local.admission)
    if (this.requiresVerificationContext && local.verificationContext === undefined)
      throw new OutputProtocolError(
        'unavailable',
        'Original proposal verification context is missing'
      )
    const job = structuredClone(record.admission!)
    const proposal = structuredClone(record.proposal)
    const outcome =
      local.verificationContext === undefined
        ? await this.options.admission.recover(job, proposal, selection)
        : await this.options.admission.recover(
            job,
            proposal,
            selection,
            structuredClone(local.verificationContext)
          )
    canonicalOutputJSON(outcome, { bytes: this.maximumOutcomeBytes })
    const plan = this.options.lifecycle.complete(record, outcome, this.now())
    if (!plan.changed) return
    local.retainUntil = proposalRetentionDeadline(plan.next, selection, local.retainUntil)
    local.retainUntil = proposalRetentionDeadline(
      plan.next,
      this.contracts.restore(local.publication),
      local.retainUntil
    )
    await this.commit(plan, local)
  }

  /** Trusted timer entry. Iterate installed channel keys with a bounded host scheduler. */
  async expire(channelKey: string): Promise<void> {
    const entry = await this.storage.getChannelEntry(channelKey)
    if (entry) await this.expireEntry(entry)
  }

  private async reserve(
    entry: ProposalJournalEntry,
    request: OutputProposalFinalize,
    requestBytes: number,
    caller: ProposalServiceCaller
  ): Promise<void> {
    const record = entry.transition.next
    let local = this.local(entry)
    if (record.state.status !== 'active')
      throw new OutputProtocolError('conflict', 'Proposal is no longer active')
    if (outputU64(this.now()) >= outputU64(record.proposal.body.expiresAt))
      throw new OutputProtocolError('expired', 'Proposal has expired')
    const selected = await this.select(caller, record.proposal)
    this.boundRequest(requestBytes, selected.selection)
    const verified = await this.verifyForReservation(request, record)
    const raw = verified.rawTransaction
    await this.authorize('finalize', record.proposal, caller.caller)
    this.fresh(selected.record)
    const plan = this.options.lifecycle.reserve(record, caller.caller, request, raw, this.now())
    local.admission = selected.record
    if (verified.verificationContext !== undefined)
      local = {
        ...local,
        format: 'proposal-service/2',
        verificationContext: verified.verificationContext
      }
    local.retainUntil = proposalRetentionDeadline(plan.next, selected.selection, local.retainUntil)
    const maximumResponseBytes = Math.min(
      selected.selection.profile.maxResponseBytes,
      this.contracts.restore(local.publication).profile.maxResponseBytes
    )
    if (proposalTerminalResponseBytes(plan.next, this.maximumOutcomeBytes) > maximumResponseBytes)
      throw new OutputProtocolError(
        'limited',
        'Selected profile cannot carry bounded admission result'
      )
    const limits = await this.storage.getLimits()
    if (proposalCompletionBytes(plan, local, this.maximumOutcomeBytes) > limits.entryBytes)
      throw new OutputProtocolError(
        'limited',
        'Insufficient entry capacity for bounded admission receipt'
      )
    await this.authorize('finalize', record.proposal, caller.caller)
    this.fresh(selected.record)
    // Recheck clock after asynchronous access/storage calls before reserving.
    const latest = this.options.lifecycle.reserve(record, caller.caller, request, raw, this.now())
    await this.commit(latest, local)
  }

  private async verifyForReservation(
    request: OutputProposalFinalize,
    record: ProposalChannelRecord
  ) {
    const evidence = this.options.evidence
    if (evidence.verifyWithContext === undefined) {
      if (this.requiresVerificationContext)
        throw new OutputProtocolError(
          'unsupported',
          'Admission requires a context-retaining evidence port'
        )
      return {
        rawTransaction: await evidence.verify(
          structuredClone(request),
          structuredClone(record.proposal)
        )
      }
    }
    const verified = await evidence.verifyWithContext(
      structuredClone(request),
      structuredClone(record.proposal)
    )
    closedOutputObject(verified, ['rawTransaction', 'verificationContext'])
    return {
      rawTransaction: verified.rawTransaction,
      verificationContext: proposalVerificationContext(verified.verificationContext, record)
    }
  }

  private async checkRetry(
    record: ProposalChannelRecord,
    request: OutputProposalFinalize,
    caller: string
  ): Promise<void> {
    const job = record.admission!
    // A different authorized operation discovers the original binding. It does
    // not claim its ID, verify a replacement, or start another transaction.
    if (job.caller !== caller || job.operationId !== request.operationId) return
    if (request.txid !== job.txid)
      throw new OutputProtocolError('conflict', 'Finalization retry names a different transaction')
    // Exact persisted evidence can recover offline. Different proof bytes earn
    // equivalence only through complete verification of the same raw transaction.
    const raw =
      request.beef === job.beef
        ? job.rawTransaction
        : await this.options.evidence.verify(
            structuredClone(request),
            structuredClone(record.proposal)
          )
    if (raw !== job.rawTransaction)
      throw new OutputProtocolError('conflict', 'Finalization retry changed transaction bytes')
    this.options.lifecycle.reserve(record, caller, request, raw, this.now())
  }

  private async expireEntry(entry: ProposalJournalEntry): Promise<void> {
    const plan = this.options.lifecycle.expire(entry.transition.next, this.now())
    if (!plan.changed) return
    try {
      await this.commit(plan, this.local(entry))
    } catch (error) {
      // A concurrent update/finalization owns the head; never overwrite it.
      if (!(error instanceof OutputProtocolError && error.code === 'conflict')) throw error
    }
  }

  private local(entry: ProposalJournalEntry): ProposalServiceContext {
    return restoreProposalServiceContext(entry.local, entry.transition.next, this.contracts)
  }

  private recovery(
    entry: ProposalJournalEntry,
    caller: ProposalServiceCaller
  ): OutputCapabilitySelection {
    const local = this.local(entry)
    const selected = [local.publication, local.admission].find(
      contract => contract?.digest === caller.capabilityDigest
    )
    if (!selected)
      throw new OutputProtocolError(
        'context-changed',
        'Use the retained proposal capability selector'
      )
    if (
      entry.transition.next.state.status !== 'finalizing' &&
      outputU64(this.now()) >= outputU64(local.retainUntil)
    )
      throw new OutputProtocolError('expired', 'Proposal recovery interval has ended')
    return this.contracts.restore(selected)
  }

  private async select(caller: ProposalServiceCaller, proposal: OutputSignedProposal) {
    const selected = this.contracts.retain(await this.options.manifest(), this.now())
    if (selected.record.digest !== caller.capabilityDigest)
      throw new OutputProtocolError('context-changed', 'Proposal capability selector changed')
    this.contracts.requirePolicy(selected.record, proposal.body.policy)
    return selected
  }

  private fresh(record: ProposalServiceContext['publication']): void {
    this.contracts.retain(record.manifest, this.now())
  }

  private async authorize(
    action: ProposalAction,
    proposal: OutputSignedProposal,
    caller: string
  ): Promise<void> {
    if (
      !this.options.lifecycle.permits(action, proposal, caller) ||
      !(await this.options.access(action, structuredClone(proposal), caller))
    ) {
      if (action === 'read') throw missing()
      throw new OutputProtocolError('unauthorized', 'Proposal caller is not currently authorized')
    }
  }

  private async commit(plan: ProposalTransition, local: ProposalServiceContext): Promise<void> {
    const result = await appendProposalWithRecovery(this.storage, plan, proposalServiceLocal(local))
    if (result.status === 'limited' || result.status === 'conflict')
      throw new OutputProtocolError(result.status, result.reason)
  }

  private caller(input: ProposalServiceCaller): ProposalServiceCaller {
    return {
      caller: outputIdentity(input.caller),
      capabilityDigest: outputHex32(input.capabilityDigest)
    }
  }
  private now(): string {
    const now = this.options.now()
    outputU64(now)
    return now
  }
  private request(input: unknown): { value: unknown; bytes: number } {
    const encoded =
      typeof input === 'string' || input instanceof Uint8Array
        ? input
        : canonicalOutputJSON(input, { bytes: 1048576 })
    const bytes =
      typeof encoded === 'string' ? new TextEncoder().encode(encoded).length : encoded.byteLength
    return { value: parseOutputJSON(encoded, { bytes: 1048576 }), bytes }
  }
  private boundRequest(bytes: number, selection: OutputCapabilitySelection): void {
    if (bytes > selection.profile.maxRequestBytes)
      throw new OutputProtocolError('limited', 'Request exceeds selected proposal profile limit')
  }
  private response<T>(body: T, selection: OutputCapabilitySelection): T {
    return JSON.parse(canonicalOutputJSON(body, { bytes: selection.profile.maxResponseBytes })) as T
  }
}

function missing(): OutputProtocolError {
  return new OutputProtocolError('not-found', 'Proposal not found')
}
