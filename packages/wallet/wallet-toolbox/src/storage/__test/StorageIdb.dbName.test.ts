import 'fake-indexeddb/auto'
import { PrivateKey } from '@bsv/sdk'
import { randomUUID } from 'node:crypto'
import { StorageIdb, StorageIdbOptions } from '../StorageIdb'
import { SetupClient } from '../../SetupClient'

function options(dbName?: string): StorageIdbOptions {
  return {
    chain: 'test',
    commissionSatoshis: 0,
    commissionPubKeyHex: undefined,
    feeModel: { model: 'sat/kb', value: 1 },
    ...(dbName != null ? { dbName } : {})
  }
}

async function open(dbName?: string): Promise<StorageIdb> {
  const storage = new StorageIdb(options(dbName))
  await storage.migrate('dbName test', PrivateKey.fromRandom().toHex())
  await storage.makeAvailable()
  return storage
}

describe('StorageIdb database name', () => {
  test('defaults to the shared per-chain database', () => {
    expect(new StorageIdb(options()).dbName).toBe('wallet-toolbox-testnet')
  })

  test('refuses a blank name instead of opening an unnamed database', () => {
    expect(() => new StorageIdb(options(''))).toThrow('dbName')
    expect(() => new StorageIdb(options('  '))).toThrow('dbName')
  })

  test('named stores keep their users apart', async () => {
    const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
    const a = await open(`dbName-a-${randomUUID()}`)
    const b = await open(`dbName-b-${randomUUID()}`)
    try {
      await a.findOrInsertUser(identityKey)
      expect(await a.findUsers({ partial: { identityKey } })).toHaveLength(1)
      expect(await b.findUsers({ partial: { identityKey } })).toHaveLength(0)
    } finally {
      await a.destroy()
      await b.destroy()
    }
  })

  test('createStorageIdb opens the requested database and keeps databaseName as the storage name', async () => {
    const dbName = `dbName-setup-${randomUUID()}`
    const storage = await SetupClient.createStorageIdb({
      chain: 'test',
      rootKeyHex: PrivateKey.fromRandom().toHex(),
      databaseName: 'setup storage',
      dbName
    })
    try {
      expect(storage.dbName).toBe(dbName)
      expect((await storage.makeAvailable()).storageName).toBe('setup storage')
    } finally {
      await storage.destroy()
    }
  })
})
