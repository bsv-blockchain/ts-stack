import { StorageKnex } from '../../src/storage/StorageKnex'
import { _tu } from '../utils/TestUtilsWalletStorage'

describe('Knex sync state identity', () => {
  jest.setTimeout(99999999)

  let storage: StorageKnex

  beforeEach(async () => {
    const localSQLiteFile = await _tu.newTmpFile('syncstateidentity.sqlite', false, false, false)
    storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain: 'test',
      knex: _tu.createLocalSQLite(localSQLiteFile)
    })
    await storage.migrate('sync state identity test', '1'.repeat(64))
    await storage.makeAvailable()
  })

  afterEach(async () => {
    await storage.destroy()
  })

  async function race(storageIdentityKey: string) {
    const user = await _tu.insertTestUser(storage)
    const auth = { identityKey: user.identityKey, userId: user.userId }
    const results = await Promise.all([
      storage.findOrInsertSyncStateAuth(auth, storageIdentityKey, 'source'),
      storage.findOrInsertSyncStateAuth(auth, storageIdentityKey, 'source')
    ])
    const rows = await storage.findSyncStates({ partial: { userId: user.userId, storageIdentityKey } })
    return { results, rows }
  }

  test('concurrent first lookups both return the one inserted sync state', async () => {
    const { results, rows } = await race('race-source')

    expect(rows).toHaveLength(1)
    expect(results.map(r => r.syncState.syncStateId)).toEqual([rows[0].syncStateId, rows[0].syncStateId])
    expect(results.filter(r => r.isNew)).toHaveLength(1)
  })

  test('without the unique index the same race inserts duplicate sync states', async () => {
    await storage.knex.schema.alterTable('sync_states', table => {
      table.dropUnique(['userId', 'storageIdentityKey'], 'sync_states_user_storage_identity')
    })

    const { results, rows } = await race('race-source')

    expect(rows).toHaveLength(2)
    expect(results.every(r => r.isNew)).toBe(true)
  })

  test('rejects a second sync state for the same user and storage identity', async () => {
    const user = await _tu.insertTestUser(storage)
    const now = new Date()
    const row = {
      created_at: now,
      updated_at: now,
      syncStateId: 0,
      userId: user.userId,
      storageIdentityKey: 'source',
      storageName: 'first',
      status: 'unknown' as const,
      init: false,
      refNum: 'first-sync-state',
      syncMap: '{}'
    }
    await storage.insertSyncState({ ...row })

    await expect(
      storage.insertSyncState({ ...row, storageName: 'second', refNum: 'second-sync-state' })
    ).rejects.toThrow()
  })
})
