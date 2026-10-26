import type { ProposalJournalEntry } from './ProposalJournal.js'

/** Trusted local selector, never authority copied from a remote request. */
export type ProposalJournalResponseReference =
  | { kind: 'channel'; channelKey: string }
  | { kind: 'proposal'; proposalId: string }
  | { kind: 'control' }

/**
 * Optional companion for the actual synchronous network enqueue, after signing.
 * Bodies are bounded to four MiB; selected contract limits may be smaller.
 * All proposal writers must share this gate. Current access writers must use the
 * same gate or an explicitly coherent local policy mechanism. No callback may
 * await, schedule later effects, close or reenter the journal.
 */
export interface ProposalJournalSend {
  readonly responseEnqueue: 'proposal-journal-send/1'
  enqueueResponse(
    candidate: { reference: ProposalJournalResponseReference; bytes: Uint8Array },
    /**
     * Recheck current access, original contract/retention and the exact outgoing
     * response against this owned, current record. Undefined means missing (or
     * control), not permission. Both arguments are owned copies. Return exactly
     * true only when disclosure is valid; throw for a more specific stale result.
     */
    validate: (entry: ProposalJournalEntry | undefined, bytes: Uint8Array) => boolean,
    /** The actual native enqueue. A buffered res.send before signing is insufficient. */
    enqueue: (bytes: Uint8Array) => undefined
  ): Promise<void>
}
