import { outputString, OutputProtocolError, type OutputJSONObject } from '@bsv/sdk'
import { ProposalJournalState } from './ProposalJournalState.js'
import type {
  ProposalJournalLimits,
  ProposalJournalStorage,
  ProposalCommitResult,
  ProposalJournalEntry,
  ProposalJournalHead
} from './ProposalJournal.js'
import type {
  ProposalTransitions,
  ProposalTransition,
  ProposalChannelRecord
} from './ProposalTransitions.js'

/** Volatile reference adapter. It cannot promise recovery after process loss. */
export class MemoryProposalJournal implements ProposalJournalStorage {
  readonly durability = 'volatile' as const
  readonly contextRetention = 'proposal-journal-context/1' as const
  readonly completionReservation = 'proposal-journal-completion/1' as const
  private readonly state: ProposalJournalState
  private closed = false

  constructor(
    readonly namespace: string,
    readonly identity: string,
    lifecycle: ProposalTransitions,
    limits: Partial<ProposalJournalLimits> = {}
  ) {
    outputString(namespace)
    this.state = new ProposalJournalState(lifecycle, identity, limits)
  }

  async head(): Promise<ProposalJournalHead> {
    return this.ready().head()
  }
  async getLimits(): Promise<ProposalJournalLimits> {
    return { ...this.ready().limits }
  }
  async getChannelEntry(key: string): Promise<ProposalJournalEntry | undefined> {
    return this.ready().channelEntry(key)
  }
  async getChannel(key: string): Promise<ProposalChannelRecord | undefined> {
    return this.ready().channel(key)
  }
  async getProposal(
    id: string
  ): Promise<{ record: ProposalChannelRecord; current: boolean } | undefined> {
    return this.ready().proposal(id)
  }
  async getProposalEntry(id: string): Promise<ProposalJournalEntry | undefined> {
    return this.ready().proposalEntry(id)
  }
  async getOperation(
    caller: string,
    service: string,
    operationId: string
  ): Promise<ProposalChannelRecord | undefined> {
    return this.ready().operation(caller, service, operationId)
  }
  async getCommit(key: string): Promise<ProposalJournalEntry | undefined> {
    return this.ready().commit(key)
  }
  async read(after: string, maximum: number): Promise<ProposalJournalEntry[]> {
    return this.ready().read(after, maximum)
  }
  async close(): Promise<void> {
    this.closed = true
  }

  async commit(
    transition: ProposalTransition,
    local?: OutputJSONObject
  ): Promise<ProposalCommitResult> {
    const state = this.ready(),
      prepared = state.prepare(transition, local),
      result = state.plan(prepared)
    if (result.status === 'committed') state.apply(prepared, result.revision)
    return result
  }

  private ready(): ProposalJournalState {
    if (this.closed) throw new OutputProtocolError('unavailable', 'Proposal journal is closed')
    return this.state
  }
}
