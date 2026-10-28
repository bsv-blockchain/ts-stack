import { outputU64, OutputProtocolError } from '@bsv/sdk'
import type { ProposalJournalHead, ProposalJournalLimits } from './ProposalJournal.js'
import type { LookupIndexConfiguration, LookupIndexHead } from '../lookup/LookupIndexStorage.js'

/** Persistent obligations, counted independently from retained event payloads. */
export interface ProposalFeedObligations {
  active: number
  finalizing: number
}
const MAX_U64 = 18446744073709551615n

/**
 * The compound namespace reserves a worst-case expiry journal entry for each
 * active channel. Native journal state already holds terminal entries for every
 * finalizing channel. Both need one future index version and complete log group.
 * Conservative byte bounds avoid guessing the eventual admission receipt size.
 * Validate after staging each whole transaction, before physical commit/effects.
 */
export function assertProposalFeedCapacity(
  journal: ProposalJournalHead,
  index: LookupIndexHead,
  obligations: ProposalFeedObligations,
  journalLimits: ProposalJournalLimits,
  indexConfiguration: LookupIndexConfiguration
): void {
  for (const count of [obligations.active, obligations.finalizing])
    if (!Number.isSafeInteger(count) || count < 0 || count > journalLimits.channels)
      throw new OutputProtocolError('unavailable', 'Invalid retained proposal feed obligations')
  const future = obligations.active + obligations.finalizing
  if (
    future > journal.channels ||
    journal.reserved?.entries !== obligations.finalizing ||
    journal.reserved.bytes !== obligations.finalizing * journalLimits.entryBytes
  )
    throw new OutputProtocolError(
      'unavailable',
      'Proposal feed obligations differ from journal state'
    )
  const { capacity, records } = indexConfiguration
  const expiryBytes = obligations.active * journalLimits.entryBytes
  const futureBytes = future * (records.rowBytes + records.groupBytes)
  if (
    journal.entries + future > journalLimits.entries ||
    journal.bytes + journal.reserved.bytes + expiryBytes > journalLimits.bytes ||
    index.retained.versions + future > capacity.versions ||
    index.retained.groups + future > capacity.groups ||
    index.retained.bytes + futureBytes > capacity.bytes ||
    outputU64(journal.revision) + BigInt(future) > MAX_U64 ||
    outputU64(index.sequence) + BigInt(future) > MAX_U64
  )
    throw new OutputProtocolError(
      'limited',
      'Proposal feed cannot reserve its future lifecycle records'
    )
}
