import type { SnapshotJournalDestinationLimits } from './SnapshotJournalProvider'
import { WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'

/** Durable capacity is distinct from one operation's allocation. These are
 * detached policy values, never an admission or a schema/authority verdict. */
export const snapshotJournalCopyLimits: Readonly<SnapshotJournalDestinationLimits> = Object.freeze({
  version: 2,
  maximumBytes: 17179869184,
  maximumPages: 2147483647,
  maximumIdentities: 2147483647,
  maximumMappings: 2147483647,
  maximumPendingAssociations: 4096,
  maximumMemberships: 2147483647,
  maximumRetirements: 2147483647,
  maximumProvenanceRows: 2147483647,
  maximumProvenanceBytes: 17179869184,
  maximumRows: 256,
  maximumPayloadBytes: 262144,
  maximumChanges: 1,
  maximumAllocationBytes: 16777216
})

export function journalCopyLimits(maxItems?: number, maxRoughSize?: number): SnapshotJournalDestinationLimits {
  if (maxItems !== undefined && (!Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 1000))
    throw new WERR_INVALID_PARAMETER('maxItems', 'an integer from 1 to 1000')
  if (
    maxRoughSize !== undefined &&
    (!Number.isSafeInteger(maxRoughSize) || maxRoughSize < 1 || maxRoughSize > 10000000)
  )
    throw new WERR_INVALID_PARAMETER('maxRoughSize', 'an integer from 1 to 10000000')
  return {
    ...snapshotJournalCopyLimits,
    maximumRows: Math.min(maxItems ?? 256, 256),
    maximumPayloadBytes: Math.min(maxRoughSize ?? 262144, 1048576)
  }
}
