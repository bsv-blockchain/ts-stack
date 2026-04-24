import { Setup } from '../../../src'
import { sdk, StorageSyncReader, wait } from '../../../src/index.client'
import { TaskCheckForProofs } from '../../../src/monitor/tasks/TaskCheckForProofs'
import { TaskClock } from '../../../src/monitor/tasks/TaskClock'
import { TaskNewHeader } from '../../../src/monitor/tasks/TaskNewHeader'
import { TaskPurge } from '../../../src/monitor/tasks/TaskPurge'
import { StorageMySQLDojoReader } from '../../../src/storage/sync'
import { _tu, TestSetup1Wallet } from '../../utils/TestUtilsWalletStorage'

import * as dotenv from 'dotenv'
dotenv.config()
const main_satoshi_shop = process.env.SATOSHI_SHOP_MAIN_IDENTITY || ''

/**
 * NOTICE: These tests are designed to chain one after the other.
 * Disable the "await WaitFor*()" lines to run them individually.
 *
 * The inital import from staging dojo takes around 100 seconds... be patient.
 */
describe('Wallet sync tests', () => {
  jest.setTimeout(99999999)

  beforeAll(async () => {})

  afterAll(async () => {})

  let doWait = false
  let done0 = false
  const waitFor0 = async () => {
    while (doWait && !done0) await wait(100)
  }
  let done1 = false
  const waitFor1 = async () => {
    while (doWait && !done1) await wait(100)
  }
  let done2 = false
  const waitFor2 = async () => {
    while (doWait && !done2) await wait(100)
  }

  const env = _tu.getEnv('test')
  const identityKeyTone = '03ac2d10bdb0023f4145cc2eba2fcd2ad3070cb2107b0b48170c46a9440e4cc3fe'
  const rootKeyHex = env.devKeys[identityKeyTone]

  test('0 sync staging dojo to local MySQL', async () => {
    console.log('Importing from staging dojo to local MySQL stagingdojotone')
    const chain: sdk.Chain = 'test'
    const connection = JSON.parse(process.env.TEST_DOJO_CONNECTION || '')
    const readerKnex = _tu.createMySQLFromConnection(connection)
    const reader = new StorageMySQLDojoReader({ chain, knex: readerKnex })
    const writer = await _tu.createMySQLTestWallet({
      databaseName: 'stagingdojotone',
      chain: 'test',
      rootKeyHex,
      dropAll: true
    })

    const identityKey = writer.identityKey
    await writer.storage.syncFromReader(identityKey, new StorageSyncReader({ identityKey }, reader))

    await reader.destroy()
    await writer.activeStorage.destroy()
    done0 = true
  })

  test.skip('0a sync production dojo to local MySQL', async () => {
    const chain: sdk.Chain = 'main'
    const env = _tu.getEnv(chain)
    console.log('Importing from production dojo to local MySQL productiondojotone')
    const identityKey = main_satoshi_shop
    const rootKeyHex = env.devKeys[identityKey]
    const connection = JSON.parse(process.env.MAIN_DOJO_CONNECTION || '')
    const readerKnex = _tu.createMySQLFromConnection(connection)
    const reader = new StorageMySQLDojoReader({ chain, knex: readerKnex })
    const writer = await _tu.createMySQLTestWallet({
      databaseName: 'main_satoshi_shop',
      chain: 'main',
      rootKeyHex,
      dropAll: true
    })

    await writer.storage.syncFromReader(identityKey, new StorageSyncReader({ identityKey }, reader))

    await reader.destroy()
    await writer.activeStorage.destroy()
  })

  test.skip('0b sweep mysql dojo sync to another wallet', async () => {
    const chain: sdk.Chain = 'main'
    const env = _tu.getEnv(chain)
    // const prod_faucet = '030b78da8101cd8929ec355c694c275fbaf4f73d4eaa104873463779cac69a2a01' // prod faucet
    // const identityKeyTone = process.env.MY_MAIN_IDENTITY || ''
    const identityKey = main_satoshi_shop
    const rootKeyHex = env.devKeys[identityKey]

    const sweepFrom = await _tu.createMySQLTestWallet({
      databaseName: 'main_satoshi_shop',
      chain,
      rootKeyHex
    })

    const sweepTo = await _tu.createTestWalletWithStorageClient({
      rootKeyHex: env.devKeys[env.identityKey],
      chain
    })

    //await sweepTo.activeStorage.updateProvenTxReq(2, { status: 'invalid' })
    //await sweepTo.activeStorage.updateTransactionStatus('failed', 2)

    await sweepFrom.wallet.sweepTo(sweepTo.wallet)

    await sweepTo.wallet.destroy()
    await sweepFrom.wallet.destroy()
  })

  test.skip('1 aggressively purge records from MySQL stagingdojotone', async () => {
    await waitFor0()

    const { monitor, activeStorage } = await _tu.createMySQLTestWallet({
      databaseName: 'stagingdojotone',
      chain: 'test',
      rootKeyHex
    })

    {
      const task = new TaskPurge(monitor, {
        purgeCompleted: true,
        purgeFailed: true,
        purgeSpent: true,
        purgeCompletedAge: 1,
        purgeFailedAge: 1,
        purgeSpentAge: 1
      })
      TaskPurge.checkNow = true
      monitor._tasks.push(task)
      await monitor.runTask('Purge')
    }

    await activeStorage.destroy()

    done1 = true
  })

  test.skip('2 sync pruned MySQL stagingdojotone to SQLite walletLegacyTestData', async () => {
    await waitFor1()
    console.log('syncing local MySQL stagingdojotone to local SQLite walletLegacyTestData in tmp folder')
    const reader = await _tu.createMySQLTestWallet({
      databaseName: 'stagingdojotone',
      chain: 'test',
      rootKeyHex
    })
    const writer = await _tu.createSQLiteTestWallet({
      databaseName: 'walletLegacyTestData',
      chain: 'test',
      rootKeyHex,
      dropAll: true
    })

    const identityKey = writer.identityKey
    await writer.storage.syncFromReader(identityKey, new StorageSyncReader({ identityKey }, reader.activeStorage))

    await reader.activeStorage.destroy()
    await writer.activeStorage.destroy()

    console.log('REMEMBER: copy walletLegacyTestData.sqlite from tmp up to data!')
    done2 = true
  })

  test.skip('3 sync pruned MySQL stagingdojotone to MySQL walletLegacyTestData', async () => {
    await waitFor2()
    console.log('syncing local MySQL stagingdojotone to local SQLite walletLegacyTestData in tmp folder')
    const reader = await _tu.createMySQLTestWallet({
      databaseName: 'stagingdojotone',
      chain: 'test',
      rootKeyHex
    })
    const writer = await _tu.createMySQLTestWallet({
      databaseName: 'walletLegacyTestData',
      chain: 'test',
      rootKeyHex,
      dropAll: true
    })

    const identityKey = writer.identityKey
    await writer.storage.syncFromReader(identityKey, new StorageSyncReader({ identityKey }, reader.activeStorage))

    await reader.activeStorage.destroy()
    await writer.activeStorage.destroy()
  })

  test('8b run monitor mainnet', async () => {
    if (Setup.noEnv('main')) return
    if (!Setup.getEnv('main').filePath) return

    // Only run if `Setup` style .env is present with a sqlite filePath...

    const c = await _tu.createWalletSetupEnv('main')

    await c.monitor.runOnce()

    await c.wallet.destroy()
  })
})
