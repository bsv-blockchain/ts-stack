import { EntitySyncState, sdk } from '../../../src'
import { _tu, logger } from '../../utils/TestUtilsWalletStorage'
import { specOpInvalidChange } from '../../../src/sdk'
import { createOneSatTestOutput, createSetup, LocalWalletTestOptions } from '../../utils/localWalletMethods'

const chain: sdk.Chain = 'test'

const options: LocalWalletTestOptions = {
  setActiveClient: false,
  useMySQLConnectionForClient: true,
  useTestIdentityKey: true,
  useIdentityKey2: false
}

describe('localWallet tests', () => {
  jest.setTimeout(99999999)

  //  test('00', () => {})
  //  if (_tu.noTestEnv(chain)) return

  test('0 monitor runOnce', async () => {
    const setup = await createSetup(chain, options)
    const key = await setup.wallet.getPublicKey({ identityKey: true })
    expect(key.publicKey.toString()).toBe(setup.identityKey)
    await setup.monitor.runOnce()
    await setup.wallet.destroy()
  })

  test('0a monitor runOnce call history', async () => {
    const setup = await createSetup(chain, options)
    const key = await setup.wallet.getPublicKey({ identityKey: true })
    expect(key.publicKey.toString()).toBe(setup.identityKey)
    await setup.services.getRawTx('6dd8e416dfaf14c04899ccad2bf76a67c1d5598fece25cf4dcb7a076012b7d8d')
    await setup.services.getRawTx('ac9cced61e2491be55061ce6577e0c59b909922ba92d5cc1cd754b10d721ab0e')
    await setup.monitor.runOnce()
    await setup.services.getRawTx('0000e416dfaf14c04899ccad2bf76a67c1d5598fece25cf4dcb7a076012b7d8d')
    await setup.services.getRawTx('0000ced61e2491be55061ce6577e0c59b909922ba92d5cc1cd754b10d721ab0e')
    logger(await setup.monitor.runTask('MonitorCallHistory'))
    await setup.wallet.destroy()
  })

  test('2 create 1 sat delayed', async () => {
    const setup = await createSetup(chain, options)
    try {
      const car = await createOneSatTestOutput(setup, {}, 1)
      expect(car.txid).toMatch(/^[0-9a-f]{64}$/)
      //await trackReqByTxid(setup, car.txid!)
    } finally {
      await setup.wallet.destroy()
    }
  })

  test('2a create 1 sat immediate', async () => {
    const setup = await createSetup(chain, options)
    try {
      const car = await createOneSatTestOutput(setup, { acceptDelayedBroadcast: false }, 1)
      expect(car.txid).toMatch(/^[0-9a-f]{64}$/)
      // await trackReqByTxid(setup, car.txid!)
    } finally {
      await setup.wallet.destroy()
    }
  })

  test('2b create 2 nosend and sendWith', async () => {
    const setup = await createSetup(chain, options)
    try {
      const car = await createOneSatTestOutput(setup, { noSend: true }, 2)
      expect(car.txid).toMatch(/^[0-9a-f]{64}$/)
      expect(car.sendWithResults).toHaveLength(2)
      //await trackReqByTxid(setup, car.txid!)
    } finally {
      await setup.wallet.destroy()
    }
  })

  test('3 return active to cloud client', async () => {
    const setup = await createSetup(chain, options)
    const localBalance = await setup.wallet.balance()
    const log = await setup.storage.setActive(setup.clientStorageIdentityKey!)
    console.log(log)
    console.log(`ACTIVE STORAGE: ${setup.storage.getActiveStoreName()}`)
    const clientBalance = await setup.wallet.balance()
    expect(localBalance).toBe(clientBalance)
    await setup.wallet.destroy()
  })

  test('5 review synchunk', async () => {
    const setup = await createSetup(chain, options)
    const identityKey = setup.identityKey
    const reader = setup.activeStorage
    const readerSettings = reader.getSettings()
    const writer = setup.storage._backups![0].storage
    const writerSettings = writer.getSettings()
    const ss = await EntitySyncState.fromStorage(writer, identityKey, readerSettings)
    const args = ss.makeRequestSyncChunkArgs(identityKey, writerSettings.storageIdentityKey)
    const chunk = await reader.getSyncChunk(args)
    expect(chunk.userIdentityKey).toBe(identityKey)
    expect(chunk.fromStorageIdentityKey).toBe(readerSettings.storageIdentityKey)
    expect(chunk.toStorageIdentityKey).toBe(writerSettings.storageIdentityKey)
    expect(
      [chunk.provenTxs, chunk.provenTxReqs, chunk.transactions, chunk.outputs, chunk.certificates].every(
        section => section === undefined || Array.isArray(section)
      )
    ).toBe(true)
    await setup.wallet.destroy()
  })

  test('6 backup', async () => {
    const setup = await createSetup(chain, options)
    const log = await setup.storage.updateBackups()
    console.log(log)
    expect(log).toContain('BACKUP CURRENT ACTIVE')
    expect(log).toContain('syncToWriter complete')
    await setup.wallet.destroy()
  })
})
