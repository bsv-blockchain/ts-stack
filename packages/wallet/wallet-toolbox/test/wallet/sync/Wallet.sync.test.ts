import { verifyOne, verifyOneOrNone, verifyTruthy, wait, Wallet, WalletStorageManager } from '../../../src/index.client'
import { StorageKnex } from '../../../src/storage/StorageKnex'
import { _tu, logger, TestWalletNoSetup } from '../../utils/TestUtilsWalletStorage'

describe('Wallet sync tests', () => {
  jest.setTimeout(99999999)

  const env = _tu.getEnvFlags('test')

  beforeAll(async () => {})

  afterAll(async () => {})

  test('0 syncToWriter initial-no changes-1 change', async () => {
    const {
      identityKey,
      storage: storageManager,
      activeStorage: storage
    } = await _tu.createLegacyWalletSQLiteCopy('walletSyncTest1aSource')
    const localSQLiteFile = await _tu.newTmpFile('walleltSyncTest0tmp.sqlite', true, false, false)
    const knexSQLite = _tu.createLocalSQLite(localSQLiteFile)
    const tmpStore = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain: env.chain,
      knex: knexSQLite
    })
    //await tmpStore.dropAllData()
    await tmpStore.migrate('walletSyncTest0tmp', '1'.repeat(64))
    const dstSettings = await tmpStore.makeAvailable()

    const srcSettings = await storage.makeAvailable()
    const manager = new WalletStorageManager(identityKey, storage, [tmpStore])

    const auth = await manager.getAuth()
    {
      const r = await manager.syncToWriter(auth, tmpStore)
      expect(r.inserts).toBeGreaterThan(1000)
      expect(r.updates).toBe(2)
    }
    {
      const r = await manager.syncToWriter(auth, tmpStore)
      expect(r.inserts).toBe(0)
      expect(r.updates).toBe(0)
    }
    {
      _tu.insertTestOutputBasket(storage, auth.userId)
      await wait(1000)
      const r = await manager.syncToWriter(auth, tmpStore)
      expect(r.inserts).toBe(1)
      expect(r.updates).toBe(0)
    }
    await tmpStore.destroy()
    await storageManager.destroy()
  })

  test('1a setActive to backup and back to original without backup first', async () => {
    // wallet will be the original active wallet, a backup is added, then setActive is used to initiate backup in each direction.
    const ctx = await _tu.createLegacyWalletSQLiteCopy('walletSyncTest1aSource')
    const { activeStorage: backup, wallet: backupWallet } = await _tu.createSQLiteTestWallet({
      databaseName: 'walletSyncTest1aBackup',
      rootKeyHex: ctx.rootKey.toHex(),
      dropAll: true
    })
    await ctx.storage.addWalletStorageProvider(backup)

    await setActiveTwice(ctx, false, backup, backupWallet)

    await setActiveTwice(ctx, false, backup, backupWallet)

    await ctx.storage.destroy()
  })

  test('1b setActive to backup and back to original with backup first', async () => {
    // wallet will be the original active wallet, a backup is added, then setActive is used to initiate backup in each direction.
    const ctx = await _tu.createLegacyWalletSQLiteCopy('walletSyncTest1bSource')
    const backup = (
      await _tu.createSQLiteTestWallet({
        databaseName: 'walletSyncTest1bBackup',
        dropAll: true
      })
    ).activeStorage
    await ctx.storage.addWalletStorageProvider(backup)

    await setActiveTwice(ctx, true, backup)

    await setActiveTwice(ctx, true, backup)

    await ctx.storage.destroy()
  })
})

async function setActiveTwice(
  ctx: TestWalletNoSetup,
  withBackupFirst: boolean,
  backup: StorageKnex,
  backupWallet?: Wallet
) {
  const { storage: storageManager, activeStorage: original, userId: originalUserId } = ctx

  if (withBackupFirst) {
    if (storageManager.isActiveEnabled) await storageManager.updateBackups()
    else
      await expect(storageManager.updateBackups()).rejects.toThrow(
        `WalletStorageManager is not accessing user's active storage or there are conflicting active stores configured.`
      )
  }

  const backupIdentityKey = (await backup.makeAvailable()).storageIdentityKey
  const originalIdentityKey = (await original.makeAvailable()).storageIdentityKey
  expect(backupIdentityKey).not.toBe(originalIdentityKey)

  const originalAuth = { ...(await storageManager.getAuth()) }
  expect(originalAuth.userId).toBe(originalUserId)
  const originalTransactions = await original.findTransactions({
    partial: { userId: originalAuth.userId }
  })

  const originalUserBefore = verifyTruthy(await original.findUserById(originalAuth.userId!))
  const backupUserBefore = verifyOneOrNone(
    await backup.findUsers({
      partial: { identityKey: originalAuth.identityKey }
    })
  )

  expect(originalUserBefore.activeStorage === undefined || originalUserBefore.activeStorage === originalIdentityKey)

  let now = Date.now()

  expect(originalUserBefore.updated_at.getTime()).toBeLessThan(now)
  expect(!backupUserBefore || backupUserBefore.updated_at.getTime() < now).toBe(true)

  expect(storageManager.getActiveStore()).toBe(originalIdentityKey)
  expect(storageManager.getActiveUser().activeStorage).toBe(originalIdentityKey)

  // sync to backup and make it active.
  const log = await storageManager.setActive(backupIdentityKey)
  logger(log)

  expect(storageManager.getActiveStore()).toBe(backupIdentityKey)
  expect(storageManager.getActiveUser().activeStorage).toBe(backupIdentityKey)
  expect(storageManager.getBackupStores()).toEqual([originalIdentityKey])

  let originalUserAfter = verifyTruthy(await original.findUserById(originalAuth.userId!))
  let backupUserAfter = verifyOne(
    await backup.findUsers({
      partial: { identityKey: originalAuth.identityKey }
    })
  )

  expect(originalUserAfter.updated_at.getTime()).toBeGreaterThanOrEqual(now)
  expect(backupUserAfter.updated_at.getTime()).toBeGreaterThanOrEqual(now)
  expect(originalUserAfter.activeStorage).toBe(backupIdentityKey)
  expect(backupUserAfter.activeStorage).toBe(backupIdentityKey)

  await expect(
    ctx.wallet.relinquishOutput({
      basket: 'xyzzy',
      output: `${'1'.repeat(64)}.42`
    })
  ).rejects.toThrow('Result must exist and be unique.')
  if (backupWallet) {
    backupWallet.storage._isAvailable = false
    backupWallet.storage._active!.user = undefined
    await backupWallet.storage.makeAvailable()
    await expect(
      backupWallet.relinquishOutput({
        basket: 'xyzzy',
        output: `${'1'.repeat(64)}.42`
      })
    ).rejects.toThrow('Result must exist and be unique.')
  }

  const backupAuth = await storageManager.getAuth()
  const backupTransactions = await backup.findTransactions({
    partial: { userId: backupAuth.userId }
  })

  now = Date.now()

  // sync back to original and make it active.
  const log2 = await storageManager.setActive(original.getSettings().storageIdentityKey)
  logger(log2)

  originalUserAfter = verifyTruthy(await original.findUserById(originalAuth.userId!))
  backupUserAfter = verifyOne(
    await backup.findUsers({
      partial: { identityKey: originalAuth.identityKey }
    })
  )

  expect(originalUserAfter.updated_at.getTime()).toBeGreaterThanOrEqual(now)
  expect(backupUserAfter.updated_at.getTime()).toBeGreaterThanOrEqual(now)
  expect(originalUserAfter.activeStorage).toBe(originalIdentityKey)
  expect(backupUserAfter.activeStorage).toBe(originalIdentityKey)

  await expect(
    ctx.wallet.relinquishOutput({
      basket: 'xyzzy',
      output: `${'1'.repeat(64)}.42`
    })
  ).rejects.toThrow('Result must exist and be unique.')
  if (backupWallet) {
    backupWallet.storage._isAvailable = false
    backupWallet.storage._active!.user = undefined
    await backupWallet.storage.makeAvailable()
    await expect(
      backupWallet.relinquishOutput({
        basket: 'xyzzy',
        output: `${'1'.repeat(64)}.42`
      })
    ).rejects.toThrow(
      `WalletStorageManager is not accessing user's active storage or there are conflicting active stores configured.`
    )
  }
}
