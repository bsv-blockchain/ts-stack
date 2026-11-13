import { assertKnexPrimaryOrdinaryWrite } from './KnexPrimaryHandoffAdmission'
import type { Knex } from 'knex'
import type { StorageKnex } from './StorageKnex'
import type { AuthId, TrxToken } from '../sdk/WalletStorage.interfaces'
import type { StorageActiveWrite } from './StorageActiveWrite'
import { WERR_INVALID_OPERATION, WERR_NOT_ACTIVE, WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { verifySnapshotSyncPrimaryFence } from './schema/snapshotSyncMigration'
import { snapshotJournalRevision } from './snapshot/journal/SnapshotJournalRevision'

interface Role {
  identityKey: string
  storageIdentity: string
  epoch: string
}

/** Restricts one real authenticated operation to its original actual SQL role.
 * It cannot create a source actor, grant a primary, or authorize sync DATA.
 * The closure holds comparison values only; every use opens and verifies the
 * actual owning database transaction. No connection survives a callback.
 */
export async function captureKnexActiveWrite(
  storage: StorageKnex,
  auth: AuthId,
  usable: () => boolean
): Promise<StorageActiveWrite> {
  const root = storage.knex
  const providerIdentity = storage.getSettings().storageIdentityKey
  const userId = auth.userId
  if (
    !Number.isSafeInteger(userId) ||
    userId! < 1 ||
    typeof auth.identityKey !== 'string' ||
    !auth.identityKey ||
    auth.identityKey.length > 130
  )
    throw new WERR_UNAUTHORIZED()
  const identityKey = auth.identityKey.toLowerCase()
  const mysql = ['mysql', 'mysql2'].includes(String(root.client.config.client))
  const actualRole = async (trx: Knex): Promise<Role> => {
    if (!usable()) throw new WERR_INVALID_OPERATION('Active wallet writer admission is stopped')
    await verifySnapshotSyncPrimaryFence(trx)
    const users: Array<{ identityKey: string; activeStorage: string | null }> = await trx('users')
      .where({ userId })
      .select(
        trx.raw('substr(??,1,131) AS ??', ['identityKey', 'identityKey']),
        trx.raw('substr(??,1,131) AS ??', ['activeStorage', 'activeStorage'])
      )
      .limit(2)
    const settings: Array<{ storageIdentity: string; chain: string }> = await trx('settings')
      .select(trx.raw('substr(??,1,131) AS ??', ['storageIdentityKey', 'storageIdentity']), 'chain')
      .limit(2)
    const epochs: Array<{ epoch: string }> = await trx('snapshot_sync_primary_epochs')
      .where({ userId })
      .select(trx.raw(mysql ? 'CAST(epoch AS CHAR) AS epoch' : 'CAST(epoch AS TEXT) AS epoch'))
      .limit(2)
    if (
      users.length !== 1 ||
      users[0].identityKey.toLowerCase() !== identityKey ||
      settings.length !== 1 ||
      settings[0].chain !== storage.chain ||
      settings[0].storageIdentity !== providerIdentity ||
      !settings[0].storageIdentity ||
      settings[0].storageIdentity.length > 130 ||
      epochs.length > 1
    )
      throw new WERR_UNAUTHORIZED()
    if (users[0].activeStorage !== settings[0].storageIdentity)
      throw new WERR_NOT_ACTIVE('The authenticated wallet operation requires the actual active storage provider')
    const epoch = snapshotJournalRevision(epochs[0]?.epoch ?? '0')
    await assertKnexPrimaryOrdinaryWrite(storage, trx, userId!, epoch, users[0].activeStorage)
    return { identityKey, storageIdentity: settings[0].storageIdentity, epoch }
  }
  // No transaction spans preparation. A concurrent capture race can only make
  // the later locked comparison fail; no mutation is authorized by these reads.
  const expected = await actualRole(root)
  const owned = new WeakSet<object>()
  const check = async (trx: Knex): Promise<void> => {
    const role = await actualRole(trx)
    if (
      role.identityKey !== expected.identityKey ||
      role.storageIdentity !== expected.storageIdentity ||
      role.epoch !== expected.epoch
    )
      throw new WERR_NOT_ACTIVE(
        'The authenticated wallet operation belongs to an obsolete active storage provider generation'
      )
  }
  const transaction = async <T>(scope: (trx: TrxToken) => Promise<T>, prior?: TrxToken): Promise<T> => {
    if (!usable()) throw new WERR_INVALID_OPERATION('Active wallet writer admission is stopped')
    if (typeof scope !== 'function') throw new WERR_INVALID_OPERATION('Active writer requires SQL work')
    if (prior !== undefined) {
      if ((typeof prior !== 'object' && typeof prior !== 'function') || prior === null || !owned.has(prior))
        throw new WERR_INVALID_OPERATION('Active writer transaction belongs to another operation')
      await check(prior as Knex.Transaction)
      const result = await scope(prior)
      await check(prior as Knex.Transaction)
      return result
    }
    return await storage.transaction(async token => {
      const trx = token as Knex.Transaction
      if (mysql) {
        // Lock current rows before any repeatable-read view. Epoch and settings
        // use the same lock order as primary cutover. No transport belongs here.
        const users = await trx('users').where({ userId }).select('userId').limit(2).forUpdate()
        if (users.length !== 1) throw new WERR_UNAUTHORIZED()
        await trx('snapshot_sync_primary_epochs').where({ userId }).select('userId').limit(2).forUpdate()
        await trx('settings').select('storageIdentityKey').limit(2).forShare()
      } else {
        // Acquire the real SQLite writer before creating a read view. An actual
        // role change then serializes with this bounded financial transaction.
        const changed = await trx('users')
          .where({ userId })
          .update({ userId: trx.ref('userId') })
        if (changed !== 1) throw new WERR_UNAUTHORIZED()
      }
      owned.add(trx)
      try {
        await check(trx)
        const result = await scope(token)
        await check(trx)
        return result
      } finally {
        owned.delete(trx)
      }
    })
  }
  return { prepareOutsideManager: true, transaction, assertCurrent: async () => await check(root) }
}
