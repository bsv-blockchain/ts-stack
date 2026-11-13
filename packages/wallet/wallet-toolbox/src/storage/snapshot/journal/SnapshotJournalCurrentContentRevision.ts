import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import type { StorageKnex } from '../../StorageKnex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'
import type { SnapshotSyncContentPosition, SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import { readKnexSnapshotArchiveHeader } from '../archive/KnexSnapshotArchiveSource'
import { readSnapshotJournalObservationConfiguration } from './SnapshotJournalLifecycle'
import { reserveSnapshotJournalCaptureFence } from './SnapshotJournalCaptureFence'
import { snapshotJournalRevision, type SnapshotJournalRevision } from './SnapshotJournalRevision'
import { snapshotJournalRevisionText } from './SnapshotJournalRevisionSql'
import { readSnapshotJournalContentRevision } from './SnapshotJournalContentRevision'

/** Comparison DATA inside the original destination writer. Its caller must
 * already hold the actual user/session/primary writer and validate the physical
 * provider root. No transport, callback or retained source is created here. */
export async function readCurrentSnapshotJournalContentRevision(
  storage: StorageKnex,
  k: Knex.Transaction,
  identityKey: string,
  since?: SnapshotSyncContentPosition
): Promise<Readonly<SnapshotSyncContentRevision> | undefined> {
  if (!k.isTransaction || storage.toDb(k) !== k)
    throw new WERR_INVALID_OPERATION('Current content revision requires its original destination transaction')
  const configuration = await readSnapshotJournalObservationConfiguration(k)
  if (configuration === undefined) return undefined
  const mysql = ['mysql', 'mysql2'].includes(String(k.client.config.client))
  let highWater: SnapshotJournalRevision | undefined
  if (mysql) {
    try {
      // Every owned MySQL data observer holds this clock FOR SHARE until its
      // writer commits. The exclusive NOWAIT barrier cannot jump over an
      // allocated-but-uncommitted revision. Optional bookkeeping may abstain
      // on this exact lock refusal; transaction-aborting errors propagate.
      highWater = await reserveSnapshotJournalCaptureFence(k)
    } catch (error) {
      if (
        error instanceof Error &&
        Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ER_LOCK_NOWAIT' &&
        Object.getOwnPropertyDescriptor(error, 'errno')?.value === 3572
      )
        return undefined
      throw error
    }
    if (highWater === undefined) return undefined
  } else {
    // lockUser has already obtained SQLite's actual write reservation. Every
    // preceding data writer is committed and no sibling writer can intervene.
    const rows: Array<{ revision: unknown; enabled: unknown }> = await k('snapshot_journal_clock')
      .where('id', 1)
      .select({ revision: snapshotJournalRevisionText(k, 'revision') }, 'enabled')
      .limit(2)
    if (rows.length !== 1 || rows[0].enabled !== 1)
      throw new WERR_INVALID_OPERATION('Current content clock changed inside its destination writer')
    highWater = snapshotJournalRevision(rows[0].revision)
  }
  const floors: Array<{ floor: unknown }> = await k('snapshot_journal_retention')
    .where('id', 1)
    .select({ floor: snapshotJournalRevisionText(k, 'floor') })
    .limit(2)
  if (floors.length !== 1) throw new WERR_INVALID_OPERATION('Current content retention owner is unavailable')
  const header = await readKnexSnapshotArchiveHeader(storage, identityKey, k),
    epochs: Array<{ epoch: unknown }> = await k('snapshot_sync_primary_epochs')
      .where('userId', header.header.user.userId)
      .select({ epoch: snapshotJournalRevisionText(k, 'epoch') })
      .limit(2)
  if (epochs.length > 1 || header.header.sourceStorage.chain !== storage.chain)
    throw new WERR_INVALID_OPERATION('Current content profile or primary epoch changed')
  const binding = createHash('sha256')
    .update('snapshot-sync-destination-content-binding-v1\n')
    .update(
      JSON.stringify([
        configuration.epoch,
        configuration.source,
        header.header.sourceSchema,
        header.header.sourceStorage.storageIdentityKey,
        header.header.user.userId,
        header.header.user.identityKey,
        storage.chain
      ])
    )
    .digest('hex')
  return await readSnapshotJournalContentRevision(
    k,
    {
      binding,
      floor: snapshotJournalRevision(floors[0].floor),
      highWater,
      sourceStorage: header.header.sourceStorage,
      user: header.header.user,
      primaryEpoch: snapshotJournalRevision(epochs[0]?.epoch ?? '0')
    },
    since
  )
}
