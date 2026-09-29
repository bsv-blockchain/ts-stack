import {
  canonicalOutputJSON,
  Hash,
  OutputProtocolError,
  Utils,
  type OutputJSONObject
} from '@bsv/sdk'
import type { ProposalChannelRecord, ProposalTransition } from './ProposalTransitions.js'

export interface ProposalJournalEntry {
  revision: string
  key: string
  transition: ProposalTransition
  /** Locally validated capability/recovery context, never a remote assertion by itself. */
  local?: OutputJSONObject
  localDigest?: string
}

export interface ProposalJournalHead {
  revision: string
  entries: number
  bytes: number
  channels: number
  /** Capacity held for terminal receipts of pending jobs, separate from already retained bytes. */
  reserved?: { bytes: number; entries: number }
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
  /** Required before a host can rely on atomic retention of selected capability contracts. */
  readonly contextRetention?: 'proposal-journal-context/1'
  /** New reservations hold one maximum-sized terminal entry before any external admission. */
  readonly completionReservation?: 'proposal-journal-completion/1'
  head(): Promise<ProposalJournalHead>
  getChannel(channelKey: string): Promise<ProposalChannelRecord | undefined>
  /** The latest retained state of this signed head, which may have been superseded. */
  getProposal(
    proposalId: string
  ): Promise<{ record: ProposalChannelRecord; current: boolean } | undefined>
  /** Optional indexed read of that proposal's latest atomic record, events and local context. */
  getProposalEntry?(proposalId: string): Promise<ProposalJournalEntry | undefined>
  getOperation(
    caller: string,
    service: string,
    operationId: string
  ): Promise<ProposalChannelRecord | undefined>
  getCommit(key: string): Promise<ProposalJournalEntry | undefined>
  commit(transition: ProposalTransition, local?: OutputJSONObject): Promise<ProposalCommitResult>
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
  storage: Pick<ProposalJournalStorage, 'commit' | 'getCommit' | 'contextRetention'>,
  transition: ProposalTransition,
  local?: OutputJSONObject
): Promise<ProposalCommitResult> {
  if (local !== undefined && storage.contextRetention !== 'proposal-journal-context/1')
    throw new OutputProtocolError(
      'unsupported',
      'Proposal storage cannot retain an atomic local context'
    )
  const owned = JSON.parse(canonicalOutputJSON(transition)) as ProposalTransition
  const ownedLocal =
    local === undefined ? undefined : (JSON.parse(canonicalOutputJSON(local)) as OutputJSONObject)
  try {
    return await storage.commit(owned, ownedLocal)
  } catch (error) {
    if (error instanceof OutputProtocolError && !['unavailable', 'limited'].includes(error.code))
      throw error
    // Absence does not prove rollback. Surface the original error and retain the
    // exact plan; never create a fresh operation or transaction to repair it.
    const saved = await storage.getCommit(proposalCommitKey(owned))
    if (
      saved &&
      canonicalOutputJSON(saved.transition) === canonicalOutputJSON(owned) &&
      (ownedLocal === undefined ||
        (saved.local !== undefined &&
          canonicalOutputJSON(saved.local) === canonicalOutputJSON(ownedLocal)))
    )
      return { status: 'replayed', revision: saved.revision }
    throw error
  }
}
