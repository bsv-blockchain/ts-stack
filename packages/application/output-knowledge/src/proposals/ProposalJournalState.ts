import {
  canonicalOutputJSON,
  closedOutputObject,
  incrementOutputU64,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputJSON
} from '@bsv/sdk'
import { proposalChannelKey } from './ProposalPolicyRegistry.js'
import {
  ProposalTransitions,
  type ProposalChannelRecord,
  type ProposalTransition
} from './ProposalTransitions.js'
import {
  proposalCommitKey,
  type ProposalCommitResult,
  type ProposalJournalEntry,
  type ProposalJournalHead,
  type ProposalJournalLimits
} from './ProposalJournal.js'

const defaults: Readonly<ProposalJournalLimits> = Object.freeze({
  bytes: 64 * 1024 * 1024,
  entryBytes: 4194304,
  entries: 4096,
  channels: 1024,
  channelsPerAuthor: 128
})

export interface PreparedProposalCommit {
  key: string
  text: string
  bytes: number
  transition: ProposalTransition
}

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
      channels: this.channels.size
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

  prepare(input: ProposalTransition): PreparedProposalCommit {
    const text = canonicalOutputJSON(input, { bytes: this.limits.entryBytes })
    const transition = parseOutputJSON(text) as unknown as ProposalTransition
    return {
      key: proposalCommitKey(transition),
      text,
      transition,
      bytes: new TextEncoder().encode(text).length
    }
  }

  plan(prepared: PreparedProposalCommit): ProposalCommitResult {
    const existing = this.commits.get(prepared.key)
    if (existing) return { status: 'replayed', revision: existing.revision }
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
    if (!checked.changed) return { status: 'replayed', revision: previous!.revision }
    const job = next.admission
    if (job) {
      const claimed = this.operations.get(
        operationKey(job.caller, next.proposal.body.service, job.operationId)
      )
      if (claimed !== undefined && claimed !== next.proposalId)
        return { status: 'conflict', reason: 'Proposal operation already names another proposal' }
    }
    if (this.exceedsLimits(prepared.bytes, next, previous === undefined))
      return {
        status: 'limited',
        reason: 'Proposal retention limit; retain terminal fences and pending work'
      }
    return { status: 'committed', revision: incrementOutputU64(this.head().revision) }
  }

  /** Apply only after a durable commit, or when replaying a verified committed prefix. */
  apply(prepared: PreparedProposalCommit, revision: string): void {
    const plan = this.plan(prepared)
    if (plan.status !== 'committed' || plan.revision !== revision)
      throw new OutputProtocolError('unavailable', 'Invalid proposal journal history')
    const entry: ProposalJournalEntry = {
      revision,
      key: prepared.key,
      transition: structuredClone(prepared.transition)
    }
    const record = entry.transition.next
    const key = proposalChannelKey(record.proposal.body)
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
    closedOutputObject(input, ['revision', 'key', 'transition'])
    outputU64(input.revision)
    const prepared = this.prepare(input.transition as ProposalTransition)
    if (input.key !== prepared.key)
      throw new OutputProtocolError('unavailable', 'Proposal journal integrity mismatch')
    this.apply(prepared, input.revision as string)
  }

  read(after: string, maximum: number): ProposalJournalEntry[] {
    const position = outputU64(after)
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256)
      throw new OutputProtocolError('invalid', 'Invalid proposal journal read bound')
    const result: ProposalJournalEntry[] = []
    let bytes = 0
    for (const entry of this.entries) {
      if (outputU64(entry.revision) <= position) continue
      const size = new TextEncoder().encode(canonicalOutputJSON(entry.transition)).length
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
    newChannel: boolean
  ): boolean {
    return (
      this.entries.length >= this.limits.entries ||
      this.retainedBytes + bytes > this.limits.bytes ||
      (newChannel &&
        (this.channels.size >= this.limits.channels ||
          (this.authors.get(record.proposal.body.author) ?? 0) >= this.limits.channelsPerAuthor))
    )
  }
}

function operationKey(caller: string, service: string, operationId: string): string {
  outputIdentity(caller)
  outputString(service)
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(operationId))
    throw new OutputProtocolError('invalid', 'Invalid proposal operation identifier')
  return canonicalOutputJSON([caller, service, operationId])
}
