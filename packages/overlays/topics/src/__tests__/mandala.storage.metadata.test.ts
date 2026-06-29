import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient } from 'mongodb'
import { MandalaStorageManager } from '../mandala/MandalaStorageManager.js'

describe('MandalaStorageManager metadata', () => {
  let mongod: MongoMemoryServer, client: MongoClient, storage: MandalaStorageManager

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create()
    client = new MongoClient(mongod.getUri())
    await client.connect()
    storage = new MandalaStorageManager(client.db('test'))
  })
  afterAll(async () => { await client.close(); await mongod.stop() })

  it('stores and finds metadata by assetId, deletes by outpoint', async () => {
    await storage.storeMetadata({ txid: 'a'.repeat(64), outputIndex: 0, assetId: `${'a'.repeat(64)}.0` })
    const found = await storage.findMetadataByAssetId(`${'a'.repeat(64)}.0`)
    expect(found).toEqual([{ txid: 'a'.repeat(64), outputIndex: 0 }])
    await storage.deleteMetadata('a'.repeat(64), 0)
    expect(await storage.findMetadataByAssetId(`${'a'.repeat(64)}.0`)).toEqual([])
  })
})
