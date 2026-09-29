import { canonicalOutputJSON, Hash, OutputProtocolError, Utils } from '@bsv/sdk'
import type { ProposalChannelRecord, ProposalTransition } from './ProposalTransitions.js'

export interface ProposalJournalEntry {
  revision: string
  key: string
  transition: ProposalTransition
}

export interface ProposalJournalHead {
  revision: string
  entries: number
  bytes: number
  channels: number
}

export type ProposalCommitResult =
  | { status: 'committed' | 'replayed'; revision: string }
  | { status: 'conflict' | 'limited'; reason: string }

export interface ProposalJournalLimits {
  bytes: number
  entries: number
  entryBytes: number
  channels: number
  channelsPerAuthor: number
}

/** Private host storage port. No method is a remotely callable or authorized read by itself. */
export interface ProposalJournalStorage {
  readonly durability: 'volatile' | 'durable'
  readonly namespace: string
  readonly identity: string
  head(): Promise<ProposalJournalHead>
  getChannel(channelKey: string): Promise<ProposalChannelRecord | undefined>
  /** The latest retained state of this signed head, which may have been superseded. */
  getProposal(
    proposalId: string
  ): Promise<{ record: ProposalChannelRecord; current: boolean } | undefined>
  getOperation(
    caller: string,
    service: string,
    operationId: string
  ): Promise<ProposalChannelRecord | undefined>
  getCommit(key: string): Promise<ProposalJournalEntry | undefined>
  commit(transition: ProposalTransition): Promise<ProposalCommitResult>
  /** Bounded, ordered, strictly after revision. Full entries contain private data. */
  read(afterRevision: string, maximumEntries: number): Promise<ProposalJournalEntry[]>
  close(): Promise<void>
}

/** Local retry identity; reuse the exact frozen plan after an uncertain write. */
export function proposalCommitKey(transition: ProposalTransition): string {
  return Utils.toHex(
    Hash.sha256(Utils.toArray(`BRC194/local-commit/v1\0${canonicalOutputJSON(transition)}`, 'utf8'))
  )
}

export async function appendProposalWithRecovery(
  storage: Pick<ProposalJournalStorage, 'commit' | 'getCommit'>,
  transition: ProposalTransition
): Promise<ProposalCommitResult> {
  const owned = JSON.parse(canonicalOutputJSON(transition)) as ProposalTransition
  try {
    return await storage.commit(owned)
  } catch (error) {
    if (error instanceof OutputProtocolError && !['unavailable', 'limited'].includes(error.code))
      throw error
    // Absence does not prove rollback. Surface the original error and retain the
    // exact plan; never create a fresh operation or transaction to repair it.
    const saved = await storage.getCommit(proposalCommitKey(owned))
    if (saved && canonicalOutputJSON(saved.transition) === canonicalOutputJSON(owned))
      return { status: 'replayed', revision: saved.revision }
    throw error
  }
}
