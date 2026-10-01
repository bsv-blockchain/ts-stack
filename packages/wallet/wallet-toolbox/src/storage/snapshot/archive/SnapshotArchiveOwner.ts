import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import { SnapshotArchiveAdmissionLimitError } from './SnapshotArchiveAdmission'
import { snapshotArchiveLimits } from './SnapshotArchive'
import type { SnapshotArchiveRequestOwner } from './SnapshotArchiveRequest'

const table = 'snapshot_archive_owners'

/** The durable request is fenced, but its source has not proved cleanup yet. */
export class SnapshotArchiveCleanupPendingError extends WERR_INVALID_OPERATION {
  constructor() {
    super('Snapshot archive source cleanup is pending')
  }
}

/** Call only inside the shared capacity-locked claim transaction. */
export async function reserveSnapshotArchiveOwner(k: Knex, owner: SnapshotArchiveRequestOwner): Promise<void> {
  const rows: Array<{ slot: number }> = await k(table).select('slot').limit(snapshotArchiveLimits.archives)
  const occupied = new Set(rows.map(row => row.slot))
  const slot = Array.from({ length: snapshotArchiveLimits.archives }, (_, index) => index).find(
    index => !occupied.has(index)
  )
  if (slot === undefined) throw new SnapshotArchiveAdmissionLimitError('Snapshot archive source capacity is occupied')
  await k(table).insert({ slot, ...owner, archiveId: null })
}

/** Associate the source with its archive in the same transaction as begin(). */
export async function assignSnapshotArchiveOwner(
  k: Knex,
  owner: SnapshotArchiveRequestOwner,
  archiveId: string
): Promise<void> {
  if (await k.schema.hasTable(table)) await k(table).where(owner).update({ archiveId })
}

/** Local owner acknowledgement follows awaited physical source and pool cleanup. */
export async function releaseSnapshotArchiveOwner(k: Knex, owner: SnapshotArchiveRequestOwner): Promise<void> {
  await k(table).where(owner).delete()
}

/** Legacy local archive stores can precede this additive source-owner schema. */
export async function hasSnapshotArchiveOwner(
  k: Knex,
  key: { identityKey: string; requestId: string } | { identityKey: string; archiveId: string }
): Promise<boolean> {
  if (!(await k.schema.hasTable(table))) return false
  return (await k(table).where(key).first('slot')) !== undefined
}
