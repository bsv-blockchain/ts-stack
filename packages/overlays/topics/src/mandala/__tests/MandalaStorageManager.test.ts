import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { MandalaStorageManager } from '../MandalaStorageManager.js'
import { defaultAssetState } from '../AssetStateReducer.js'

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

describe('MandalaStorageManager admin state + history', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('mandala_admin_test')
  })
  afterAll(async () => { await client.close(); await mongo.stop() })
  beforeEach(async () => { await db.dropDatabase() })

  it('getAssetState returns defaults when absent, then round-trips putAssetState', async () => {
    const mgr = new MandalaStorageManager(db) // db from the existing harness
    expect(await mgr.getAssetState('x.0')).toEqual(defaultAssetState('x.0'))
    const next = { ...defaultAssetState('x.0'), isPaused: true, blockedIdentities: ['02aa'] }
    await mgr.putAssetState(next)
    expect(await mgr.getAssetState('x.0')).toEqual(next)
  })

  it('nextAdmitSeq is monotonic', async () => {
    const mgr = new MandalaStorageManager(db)
    const a = await mgr.nextAdmitSeq()
    const b = await mgr.nextAdmitSeq()
    expect(b).toBe(a + 1)
  })

  it('admin history is returned ordered by (height, offset, admitSeq)', async () => {
    const mgr = new MandalaStorageManager(db)
    const base = { assetId: 'a.0', outputIndex: 1, actionDetails: { kind: 'pause' as const, assetId: 'a.0' }, createdAt: new Date() }
    await mgr.appendAdminHistory({ ...base, txid: 't3', height: 100, offset: 2, admitSeq: 5 })
    await mgr.appendAdminHistory({ ...base, txid: 't1', height: 100, offset: 1, admitSeq: 9 })
    await mgr.appendAdminHistory({ ...base, txid: 't4', height: Number.MAX_SAFE_INTEGER, offset: 0, admitSeq: 3 })
    await mgr.appendAdminHistory({ ...base, txid: 't2', height: 99, offset: 9, admitSeq: 1 })
    const got = (await mgr.findAdminHistoryByAssetId('a.0')).map(e => e.txid)
    expect(got).toEqual(['t2', 't1', 't3', 't4'])
  })
})
