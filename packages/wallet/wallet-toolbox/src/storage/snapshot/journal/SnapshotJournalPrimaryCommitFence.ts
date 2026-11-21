import { isOwnedNativeSqlite } from '../../schema/ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

function invalid(): never {
  throw new WERR_INVALID_OPERATION('Journal source primary commit fence is unavailable')
}

/** This is a short SQL primary-selection fence, not a retained source lease.
 * The caller acquires the destination manager's scheduled commit ownership,
 * then opens a fresh physically bound source transaction. Never wait for a
 * manager queue while holding this source SQL fence. Acquire current rows before establishing a read
 * view, verify full current source authority, then retain these locks through
 * ONE bounded destination transaction and its physical cleanup. No payload,
 * proof, transport preparation or observer belongs inside this callback.
 * Source rollback releases the fence even when the destination reply is lost.
 */
export async function withSnapshotJournalPrimaryCommitFence<T>(
  k: Knex.Transaction,
  userId: number,
  verify: () => Promise<void>,
  commit: () => Promise<T>
): Promise<T> {
  if (
    !k.isTransaction ||
    !Number.isSafeInteger(userId) ||
    userId < 1 ||
    typeof verify !== 'function' ||
    typeof commit !== 'function'
  )
    invalid()
  const client = String(k.client.config.client)
  const sqlite = client === 'sqlite3' || client === 'better-sqlite3' || isOwnedNativeSqlite(k)
  if (!sqlite && client !== 'mysql' && client !== 'mysql2') invalid()
  if (sqlite) {
    const timeouts: Array<{ timeout: number }> = await k.raw('PRAGMA busy_timeout')
    const modes: Array<{ journal_mode: string }> = await k.raw('PRAGMA journal_mode')
    if (timeouts.length !== 1 || timeouts[0].timeout !== 0 || modes.length !== 1 || modes[0].journal_mode !== 'wal')
      invalid()
    // First operation obtains SQLite's reservation without capturing an old
    // read view. A busy source fails immediately and leaves no queued writer.
    if (
      (await k('users')
        .where({ userId })
        .update({ userId: k.ref('userId') })) !== 1
    )
      invalid()
  } else {
    const users = await k('users').where({ userId }).select('userId').limit(2).forUpdate().noWait()
    if (users.length !== 1) invalid()
    // Primary changes advance the epoch in the user's transaction. Lock the
    // epoch key/gap as well, so direct epoch writers cannot cross this fence.
    const epochs = await k('snapshot_sync_primary_epochs')
      .where({ userId })
      .select('userId')
      .limit(2)
      .forUpdate()
      .noWait()
    const settings = await k('settings')
      .select(k.raw('substr(storageIdentityKey,1,257) AS storageIdentityKey'))
      .limit(2)
      .forUpdate()
      .noWait()
    if (epochs.length > 1 || settings.length !== 1) invalid()
  }
  await verify()
  return await commit()
}
