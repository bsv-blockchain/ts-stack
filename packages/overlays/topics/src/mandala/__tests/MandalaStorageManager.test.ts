import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { MandalaStorageManager } from '../MandalaStorageManager.js'

describe('MandalaStorageManager', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let store: MandalaStorageManager

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('mandala_test')
  })
  afterAll(async () => { await client.close(); await mongo.stop() })
  beforeEach(async () => {
    await db.dropDatabase()
    store = new MandalaStorageManager(db)
  })

  it('stores and finds tokens by assetId and outpoint', async () => {
    const now = new Date()
    await store.storeToken({ txid: 'aa', outputIndex: 0, assetId: 'x.0', amount: 5, identityKey: '02cc', createdAt: now })
    expect(await store.findByAssetId('x.0')).toEqual([{ txid: 'aa', outputIndex: 0 }])
    expect(await store.findByOutpoint('aa', 0)).toEqual([{ txid: 'aa', outputIndex: 0 }])
    expect(await store.findByAssetId('y.0')).toEqual([])
  })

  it('tracks balances internally and deletes tokens', async () => {
    await store.adjustBalance('02cc', 5)
    await store.adjustBalance('02cc', -2)
    expect(await store.getBalance('02cc')).toBe(3)
    await store.storeToken({ txid: 'aa', outputIndex: 0, assetId: 'x.0', amount: 5, identityKey: '02cc', createdAt: new Date() })
    await store.deleteToken('aa', 0)
    expect(await store.findByOutpoint('aa', 0)).toEqual([])
  })

  it('retains linkage records (no TTL index on linkageRecords)', async () => {
    await store.storeLinkage({
      txid: 'aa', outputIndex: 0, identityKey: '02cc',
      linkage: { prover: '02aa', verifier: '02bb', counterparty: '02cc', protocolID: [2, 'mandala token'], keyID: 'k', encryptedLinkage: [1], encryptedLinkageProof: [0], proofType: 0 },
      createdAt: new Date()
    })
    const indexes = await db.collection('mandalaLinkageRecords').indexes()
    expect(indexes.some(i => 'expireAfterSeconds' in i)).toBe(false)
  })
})
