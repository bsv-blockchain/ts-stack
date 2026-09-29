import {
  canonicalOutputJSON,
  closedOutputObject,
  incrementOutputU64,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  OutputProtocolError,
  type OutputJSONObject
} from '@bsv/sdk'
import { proposalChannelKey } from './ProposalPolicyRegistry.js'
import {
  ProposalTransitions,
  type ProposalChannelRecord,
  type ProposalTransition
} from './ProposalTransitions.js'
import {
  type ProposalCommitResult,
  type ProposalJournalEntry,
  type ProposalJournalHead,
  type ProposalJournalLimits
} from './ProposalJournal.js'
import {
  proposalPayload,
  validateProposalLocalContext,
  type ProposalPayload
} from './ProposalJournalPayload.js'

const defaults: Readonly<ProposalJournalLimits> = Object.freeze({
  bytes: 64 * 1024 * 1024,
  entryBytes: 4194304,
  entries: 4096,
  channels: 1024,
  channelsPerAuthor: 128
})

export type PreparedProposalCommit = ProposalPayload

/** Shared bounded, deterministic journal index; SQLite persists the same immutable entries. */
export class ProposalJournalState {
  readonly limits: ProposalJournalLimits
  readonly configuration: string
  readonly serviceIdentity: string
  private readonly entries: ProposalJournalEntry[] = []
  private readonly commits = new Map<string, ProposalJournalEntry>()
  private readonly channels = new Map<string, { record: ProposalChannelRecord; revision: string }>()
  private readonly proposals = new Map<string, ProposalChannelRecord>()
  private readonly operations = new Map<string, string>()
  private readonly authors = new Map<string, number>()
  private retainedBytes = 0
  private pendingAdmissions = 0

  constructor(
    readonly lifecycle: ProposalTransitions,
    identity: string,
    limits: Partial<ProposalJournalLimits> = {}
  ) {
    this.limits = { ...defaults, ...limits }
    for (const [key, limit] of Object.entries(this.limits)) {
      if (
        !Object.hasOwn(defaults, key) ||
        !Number.isSafeInteger(limit) ||
        limit <= 0 ||
        limit > defaults[key as keyof ProposalJournalLimits]
      )
        throw new OutputProtocolError('invalid', 'Invalid proposal journal limit')
    }
    if (
      this.limits.entryBytes > this.limits.bytes ||
      this.limits.channelsPerAuthor > this.limits.channels
    )
      throw new OutputProtocolError('invalid', 'Inconsistent proposal journal limits')
    this.configuration = canonicalOutputJSON({
      format: 'proposal-journal/1',
      identity: outputIdentity(identity),
      ...lifecycle.configuration()
    })
    this.serviceIdentity = canonicalOutputJSON({ identity, ...lifecycle.configuration().scope })
  }

  head(): ProposalJournalHead {
    return {
      revision: this.entries.at(-1)?.revision ?? '0',
      entries: this.entries.length,
      bytes: this.retainedBytes,
      channels: this.channels.size,
      reserved: {
        bytes: this.pendingAdmissions * this.limits.entryBytes,
        entries: this.pendingAdmissions
      }
    }
  }

  channel(key: string): ProposalChannelRecord | undefined {
    const record = this.channels.get(key)?.record
    return record && structuredClone(record)
  }

  proposal(id: string): { record: ProposalChannelRecord; current: boolean } | undefined {
    outputHex32(id)
    const record = this.proposals.get(id)
    return (
      record && {
        record: structuredClone(record),
        current:
          this.channels.get(proposalChannelKey(record.proposal.body))?.record.proposalId === id
      }
    )
  }

  operation(
    caller: string,
    service: string,
    operationId: string
  ): ProposalChannelRecord | undefined {
    const id = this.operations.get(operationKey(caller, service, operationId))
    return id === undefined ? undefined : this.proposal(id)?.record
  }

  commit(key: string): ProposalJournalEntry | undefined {
    outputHex32(key)
    const entry = this.commits.get(key)
    return entry && structuredClone(entry)
  }

  prepare(input: ProposalTransition, local?: OutputJSONObject): PreparedProposalCommit {
    return proposalPayload(input, this.limits.entryBytes, local)
  }

  plan(prepared: PreparedProposalCommit, replay = false): ProposalCommitResult {
    const existing = this.commits.get(prepared.key)
    if (existing) return this.replayed(existing, prepared.local)
    const next = this.lifecycle.parse(prepared.transition.next)
    const channel = proposalChannelKey(next.proposal.body)
    const previous = this.channels.get(channel)
    let checked: ProposalTransition
    try {
      checked = this.lifecycle.check(previous?.record, prepared.transition)
    } catch (error) {
      if (error instanceof OutputProtocolError && error.code === 'conflict')
        return { status: 'conflict', reason: error.message }
      throw error
    }
    if (!checked.changed)
      return this.replayed(this.entries[Number(previous!.revision) - 1], prepared.local)
    const job = next.admission
    if (job) {
      const claimed = this.operations.get(
        operationKey(job.caller, next.proposal.body.service, job.operationId)
      )
      if (claimed !== undefined && claimed !== next.proposalId)
        return { status: 'conflict', reason: 'Proposal operation already names another proposal' }
    }
    if (this.exceedsLimits(prepared.bytes, next, previous?.record, replay))
      return {
        status: 'limited',
        reason: 'Proposal retention limit; retain terminal fences and pending work'
      }
    return { status: 'committed', revision: incrementOutputU64(this.head().revision) }
  }

  /** Apply only after a durable commit, or when replaying a verified committed prefix. */
  apply(prepared: PreparedProposalCommit, revision: string, replay = false): void {
    const plan = this.plan(prepared, replay)
    if (plan.status !== 'committed' || plan.revision !== revision)
      throw new OutputProtocolError('unavailable', 'Invalid proposal journal history')
    const entry: ProposalJournalEntry = {
      revision,
      key: prepared.key,
      transition: structuredClone(prepared.transition),
      ...(prepared.local !== undefined
        ? { local: structuredClone(prepared.local), localDigest: prepared.localDigest }
        : {})
    }
    const record = entry.transition.next
    const key = proposalChannelKey(record.proposal.body)
    this.pendingAdmissions += pending(record) - pending(this.channels.get(key)?.record)
    if (!this.channels.has(key))
      this.authors.set(
        record.proposal.body.author,
        (this.authors.get(record.proposal.body.author) ?? 0) + 1
      )
    this.entries.push(entry)
    this.commits.set(entry.key, entry)
    this.channels.set(key, { record, revision })
    this.proposals.set(record.proposalId, record)
    if (record.admission)
      this.operations.set(
        operationKey(
          record.admission.caller,
          record.proposal.body.service,
          record.admission.operationId
        ),
        record.proposalId
      )
    this.retainedBytes += prepared.bytes
  }

  replay(input: unknown): void {
    closedOutputObject(input, ['revision', 'key', 'transition'], ['local', 'localDigest'])
    outputU64(input.revision)
    validateProposalLocalContext(
      input.local as OutputJSONObject | undefined,
      input.localDigest as string | undefined
    )
    const prepared = this.prepare(
      input.transition as ProposalTransition,
      input.local as OutputJSONObject | undefined
    )
    if (input.key !== prepared.key)
      throw new OutputProtocolError('unavailable', 'Proposal journal integrity mismatch')
    // Earlier body-only journals did not reserve completion space. Preserve
    // their historical decisions; apply the new promise only to future writes.
    this.apply(prepared, input.revision as string, true)
  }

  read(after: string, maximum: number): ProposalJournalEntry[] {
    const position = outputU64(after)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256)
      throw new OutputProtocolError('invalid', 'Invalid proposal journal read bound')
    const result: ProposalJournalEntry[] = []
    let bytes = 0
    for (const entry of this.entries) {
      if (outputU64(entry.revision) <= position) continue
      const size = this.prepare(entry.transition, entry.local).bytes
      if (result.length === maximum || (result.length > 0 && bytes + size > this.limits.entryBytes))
        break
      result.push(structuredClone(entry))
      bytes += size
    }
    return result
  }

  private exceedsLimits(
    bytes: number,
    record: ProposalChannelRecord,
    previous: ProposalChannelRecord | undefined,
    replay: boolean
  ): boolean {
    return (
      this.entries.length >= this.limits.entries ||
      this.retainedBytes + bytes > this.limits.bytes ||
      (previous === undefined &&
        (this.channels.size >= this.limits.channels ||
          (this.authors.get(record.proposal.body.author) ?? 0) >= this.limits.channelsPerAuthor)) ||
      (!replay && this.exceedsReservedCapacity(bytes, record, previous))
    )
  }

  private replayed(entry: ProposalJournalEntry, local?: OutputJSONObject): ProposalCommitResult {
    if (
      local !== undefined &&
      (entry.local === undefined || canonicalOutputJSON(entry.local) !== canonicalOutputJSON(local))
    )
      throw new OutputProtocolError(
        'context-changed',
        'Proposal commit already has a different local context'
      )
    return { status: 'replayed', revision: entry.revision }
  }

  private exceedsReservedCapacity(
    bytes: number,
    record: ProposalChannelRecord,
    previous: ProposalChannelRecord | undefined
  ): boolean {
    const delta = pending(record) - pending(previous)
    // A terminal receipt releases its reserved slot. Legacy overcommitted jobs
    // may still complete if the actual retained-byte/entry bounds permit it.
    if (delta < 0) return false
    const pendingAfter = this.pendingAdmissions + delta
    return (
      this.entries.length + 1 + pendingAfter > this.limits.entries ||
      this.retainedBytes + bytes + pendingAfter * this.limits.entryBytes > this.limits.bytes
    )
  }
}

function pending(record: ProposalChannelRecord | undefined): number {
  return record?.state.status === 'finalizing' ? 1 : 0
}

function operationKey(caller: string, service: string, operationId: string): string {
  outputIdentity(caller)
  outputString(service)
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operationId))
    throw new OutputProtocolError('invalid', 'Invalid proposal operation identifier')
  return canonicalOutputJSON([caller, service, operationId])
}
