import { jest } from '@jest/globals'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { MandalaStorageManager } from '../MandalaStorageManager.js'
import { defaultAssetState } from '../AssetStateReducer.js'
import type { AssetAdminState } from '../AssetStateReducer.js'
import type {
  AdminHistoryEntry,
  MandalaAuthorityRecord,
  MandalaLinkageRecord,
  MandalaMetadataRecord,
  MandalaOwnerRecord,
  MandalaTokenRecord
} from '../types.js'

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const TOPIC = 'tm_mandala'
const TXID_A = 'aa'.repeat(32)
const TXID_B = 'bb'.repeat(32)
const TXID_C = 'cc'.repeat(32)
const TOKEN = `${'11'.repeat(32)}_0`
const OTHER_TOKEN = `${'22'.repeat(32)}_0`
const ALICE = `02${'a1'.repeat(32)}`
const BOB = `03${'b2'.repeat(32)}`
const CREATED = new Date('2026-10-02T00:00:00.000Z')

const ownerRow = (over: Partial<MandalaOwnerRecord> = {}): MandalaOwnerRecord => ({
  txid: TXID_A,
  outputIndex: 1,
  topic: TOPIC,
  tokenId: TOKEN,
  role: 'value',
  amount: 5,
  identityKey: ALICE,
  createdAt: CREATED,
  ...over
})

const tokenRow = (over: Partial<MandalaTokenRecord> = {}): MandalaTokenRecord => ({
  txid: TXID_A,
  outputIndex: 1,
  tokenId: TOKEN,
  amount: 5,
  identityKey: ALICE,
  createdAt: CREATED,
  ...over
})

const authorityRow = (over: Partial<MandalaAuthorityRecord> = {}): MandalaAuthorityRecord => ({
  txid: TXID_A,
  outputIndex: 0,
  topic: TOPIC,
  tokenId: TOKEN,
  identityKey: ALICE,
  createdAt: CREATED,
  ...over
})

const historyRow = (over: Partial<AdminHistoryEntry> = {}): AdminHistoryEntry => ({
  tokenId: TOKEN,
  txid: TXID_A,
  outputIndex: 0,
  kind: 'pause',
  detailsHex: 'a0',
  commitment: '00'.repeat(32),
  delta: 0,
  height: 100,
  offset: 0,
  admitSeq: 1,
  createdAt: CREATED,
  ...over
})

const assetState = (over: Partial<AssetAdminState> = {}): AssetAdminState => ({
  tokenId: TOKEN,
  isPaused: false,
  accessMode: 'denylist',
  blockedIdentities: [],
  allowedIdentities: [],
  frozenOutpoints: [],
  evictedOutpoints: [],
  feeRatePerKb: null,
  lastProcessedHeight: 0,
  lastProcessedOffset: 0,
  lastAdmitSeq: 0,
  ...over
})

type IndexShape = { key: Record<string, unknown>; unique: boolean }

// createIndex calls run concurrently, so the listing order is not part of the contract
const bySignature = (a: IndexShape, b: IndexShape): number =>
  JSON.stringify(a.key).localeCompare(JSON.stringify(b.key))

const indexShapes = async (db: Db, name: string): Promise<IndexShape[]> =>
  (await db.collection(name).indexes())
    .filter(index => index.name !== '_id_')
    .map(index => ({ key: index.key as Record<string, unknown>, unique: index.unique === true }))
    .sort(bySignature)

const expectIndexes = async (db: Db, name: string, expected: IndexShape[]): Promise<void> => {
  expect(await indexShapes(db, name)).toEqual([...expected].sort(bySignature))
}

describe('MandalaStorageManager', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let store: MandalaStorageManager

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create()
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('mandala_storage_test')
  }, 60_000)
  afterAll(async () => {
    await client.close()
    await mongo.stop()
  }, 60_000)
  beforeEach(async () => {
    await db.dropDatabase()
    store = new MandalaStorageManager(db)
  })

  describe('indexes (spec 6.6)', () => {
    it('builds every collection index on first use', async () => {
      await store.getAssetState(TOKEN)
      await expectIndexes(db, 'mandalaOwners', [
        { key: { txid: 1, outputIndex: 1, topic: 1 }, unique: true }
      ])
      await expectIndexes(db, 'mandalaTokens', [
        { key: { txid: 1, outputIndex: 1 }, unique: true },
        { key: { tokenId: 1 }, unique: false },
        { key: { identityKey: 1 }, unique: false }
      ])
      await expectIndexes(db, 'mandalaAuthorities', [
        { key: { txid: 1, outputIndex: 1 }, unique: true },
        { key: { topic: 1, tokenId: 1 }, unique: false }
      ])
      await expectIndexes(db, 'mandalaLinkageRecords', [
        { key: { txid: 1, outputIndex: 1 }, unique: false },
        { key: { identityKey: 1 }, unique: false }
      ])
      await expectIndexes(db, 'mandalaBalances', [{ key: { identityKey: 1 }, unique: true }])
      await expectIndexes(db, 'mandalaMetadata', [{ key: { tokenId: 1 }, unique: true }])
      await expectIndexes(db, 'mandalaAssetStates', [{ key: { tokenId: 1 }, unique: true }])
      await expectIndexes(db, 'mandalaAdminHistory', [
        { key: { tokenId: 1, height: 1, offset: 1, admitSeq: 1 }, unique: false },
        { key: { tokenId: 1, txid: 1, outputIndex: 1 }, unique: false },
        { key: { txid: 1 }, unique: false }
      ])
    })

    it('enforces the unique keys of the journal and both owner indexes', async () => {
      await store.getAssetState(TOKEN)
      const owners = db.collection('mandalaOwners')
      await owners.insertOne({ txid: TXID_A, outputIndex: 1, topic: TOPIC })
      await expect(
        owners.insertOne({ txid: TXID_A, outputIndex: 1, topic: TOPIC })
      ).rejects.toMatchObject({ code: 11000 })
      // the journal key includes the topic: the same outpoint on another topic is a new row
      await owners.insertOne({ txid: TXID_A, outputIndex: 1, topic: 'tm_mandala_registry' })

      const tokens = db.collection('mandalaTokens')
      await tokens.insertOne({ txid: TXID_A, outputIndex: 1 })
      await expect(tokens.insertOne({ txid: TXID_A, outputIndex: 1 })).rejects.toMatchObject({
        code: 11000
      })

      const authorities = db.collection('mandalaAuthorities')
      await authorities.insertOne({ txid: TXID_A, outputIndex: 0, topic: TOPIC })
      await expect(
        authorities.insertOne({ txid: TXID_A, outputIndex: 0, topic: 'other' })
      ).rejects.toMatchObject({ code: 11000 })
    })

    it('retains linkage records (no TTL index on linkageRecords)', async () => {
      await store.getAssetState(TOKEN)
      const indexes = await db.collection('mandalaLinkageRecords').indexes()
      expect(indexes.some(i => 'expireAfterSeconds' in i)).toBe(false)
    })
  })

  describe('owner journal', () => {
    it('records rows and reads them back by (txid, outputIndex, topic)', async () => {
      await store.recordOwners([ownerRow(), ownerRow({ outputIndex: 2, role: 'authority' })])
      expect(await store.getOwnerJournal(TXID_A, 1, TOPIC)).toEqual(ownerRow())
      expect(await store.getOwnerJournal(TXID_A, 2, TOPIC)).toEqual(
        ownerRow({ outputIndex: 2, role: 'authority' })
      )
      expect(await store.getOwnerJournal(TXID_A, 3, TOPIC)).toBeNull()
      expect(await store.getOwnerJournal(TXID_A, 1, 'tm_mandala_registry')).toBeNull()
    })

    it('is idempotent: recording the same rows twice leaves one row each', async () => {
      await store.recordOwners([ownerRow()])
      await store.recordOwners([ownerRow()])
      await store.recordOwners([ownerRow(), ownerRow()])
      expect(await db.collection('mandalaOwners').countDocuments()).toBe(1)
    })

    it('is append-only: a replay never overwrites the first row', async () => {
      await store.recordOwners([ownerRow()])
      await store.recordOwners([ownerRow({ amount: 9, identityKey: BOB, role: 'authority' })])
      expect(await store.getOwnerJournal(TXID_A, 1, TOPIC)).toEqual(ownerRow())
    })

    it('inserts the new rows of a batch that also holds a duplicate', async () => {
      await store.recordOwners([ownerRow()])
      await store.recordOwners([ownerRow(), ownerRow({ outputIndex: 2 })])
      expect(await store.getOwnerJournal(TXID_A, 2, TOPIC)).toEqual(ownerRow({ outputIndex: 2 }))
      expect(await db.collection('mandalaOwners').countDocuments()).toBe(2)
    })

    it('keeps one row per topic for the same outpoint', async () => {
      await store.recordOwners([ownerRow(), ownerRow({ topic: 'tm_mandala_registry' })])
      expect(await db.collection('mandalaOwners').countDocuments()).toBe(2)
    })

    it('treats an empty batch as a no-op', async () => {
      await store.recordOwners([])
      expect(await db.collection('mandalaOwners').countDocuments()).toBe(0)
    })

    it('does not mutate the rows it is given', async () => {
      const rows = [ownerRow()]
      await store.recordOwners(rows)
      expect(rows).toEqual([ownerRow()])
      expect(Object.keys(rows[0])).not.toContain('_id')
    })

    it('stores amounts as numbers, including the safe-integer cap', async () => {
      await store.recordOwners([ownerRow({ amount: MAX_SAFE })])
      const row = await store.getOwnerJournal(TXID_A, 1, TOPIC)
      expect(typeof row?.amount).toBe('number')
      expect(row?.amount).toBe(MAX_SAFE)
    })

    it('rethrows a failure that is not a duplicate key', async () => {
      const closed = new MongoClient(mongo.getUri())
      await closed.connect()
      const orphan = new MandalaStorageManager(closed.db('mandala_storage_closed'))
      await closed.close()
      const errors = jest.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(orphan.recordOwners([ownerRow()])).rejects.toThrow()
      } finally {
        errors.mockRestore()
      }
    })
  })

  describe('value index', () => {
    it('stores a token row once and reports whether it inserted', async () => {
      await expect(store.storeTokenIfAbsent(tokenRow())).resolves.toBe(true)
      await expect(store.storeTokenIfAbsent(tokenRow({ createdAt: new Date() }))).resolves.toBe(
        false
      )
      expect(await db.collection('mandalaTokens').countDocuments()).toBe(1)
      expect(await store.getTokenRow(TXID_A, 1)).toEqual(tokenRow())
    })

    it('never replaces an existing row on replay', async () => {
      await store.storeTokenIfAbsent(tokenRow())
      await expect(
        store.storeTokenIfAbsent(tokenRow({ amount: 6, identityKey: BOB }))
      ).resolves.toBe(false)
      expect(await store.getTokenRow(TXID_A, 1)).toEqual(tokenRow())
    })

    it('returns null for an unknown outpoint', async () => {
      expect(await store.getTokenRow(TXID_A, 1)).toBeNull()
    })

    it('stores amounts as numbers, including the safe-integer cap', async () => {
      await store.storeTokenIfAbsent(tokenRow({ amount: MAX_SAFE }))
      const row = await store.getTokenRow(TXID_A, 1)
      expect(typeof row?.amount).toBe('number')
      expect(row?.amount).toBe(MAX_SAFE)
    })

    it('takeToken removes and returns the row exactly once', async () => {
      await store.storeTokenIfAbsent(tokenRow())
      expect(await store.takeToken(TXID_A, 1)).toEqual(tokenRow())
      expect(await store.takeToken(TXID_A, 1)).toBeNull()
      expect(await store.getTokenRow(TXID_A, 1)).toBeNull()
    })

    it('lists the rows of one token with limit and skip', async () => {
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 1 }))
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 2 }))
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 3 }))
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 4, tokenId: OTHER_TOKEN }))
      const all = await store.findTokensByTokenId(TOKEN, 10, 0)
      expect(all.map(r => r.outputIndex).sort()).toEqual([1, 2, 3])
      expect(all.every(r => r.tokenId === TOKEN)).toBe(true)
      expect(await store.findTokensByTokenId(TOKEN, 2, 0)).toHaveLength(2)
      expect(await store.findTokensByTokenId(TOKEN, 2, 2)).toHaveLength(1)
      expect(await store.findTokensByTokenId(TOKEN, 10, 3)).toEqual([])
      expect(await store.findTokensByTokenId('x_0', 10, 0)).toEqual([])
    })

    it('leaves evicted outpoints out of the listing and pages past them', async () => {
      for (const outputIndex of [1, 2, 3]) {
        await store.storeTokenIfAbsent(tokenRow({ outputIndex }))
      }
      await store.putAssetState(assetState({ evictedOutpoints: [`${TXID_A}.2`] }))
      const page = await store.findTokensByTokenId(TOKEN, 2, 0)
      expect(page.map(r => r.outputIndex).sort()).toEqual([1, 3])
    })

    it('pages in outpoint order, whatever the insert order', async () => {
      for (const [txid, outputIndex] of [
        [TXID_C, 0],
        [TXID_A, 2],
        [TXID_B, 1],
        [TXID_A, 1]
      ] as const) {
        await store.storeTokenIfAbsent(tokenRow({ txid, outputIndex }))
      }
      const outpoints = async (skip: number): Promise<string[]> =>
        (await store.findTokensByTokenId(TOKEN, 2, skip)).map(r => `${r.txid}.${r.outputIndex}`)
      expect(await outpoints(0)).toEqual([`${TXID_A}.1`, `${TXID_A}.2`])
      expect(await outpoints(2)).toEqual([`${TXID_B}.1`, `${TXID_C}.0`])
    })
  })

  describe('circulatingSupply', () => {
    it('is zero for a token with no rows', async () => {
      expect(await store.circulatingSupply(TOKEN)).toBe(0n)
    })

    it('sums the unspent rows of the token and nothing else', async () => {
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 1, amount: 5 }))
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 2, amount: 7 }))
      await store.storeTokenIfAbsent(
        tokenRow({ outputIndex: 3, amount: 100, tokenId: OTHER_TOKEN })
      )
      expect(await store.circulatingSupply(TOKEN)).toBe(12n)
      expect(await store.circulatingSupply(OTHER_TOKEN)).toBe(100n)
    })

    it('sums what remains after a spend', async () => {
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 1, amount: 5 }))
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 2, amount: 7 }))
      await store.takeToken(TXID_A, 1)
      expect(await store.circulatingSupply(TOKEN)).toBe(7n)
    })

    it('excludes an outpoint listed in the token evictedOutpoints', async () => {
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 1, amount: 5 }))
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 2, amount: 7 }))
      await store.putAssetState(assetState({ evictedOutpoints: [`${TXID_A}.1`] }))
      expect(await store.circulatingSupply(TOKEN)).toBe(7n)
    })

    it('matches evicted outpoints case-insensitively and ignores malformed entries', async () => {
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 1, amount: 5 }))
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 2, amount: 7 }))
      await store.putAssetState(
        assetState({
          evictedOutpoints: [`${TXID_A.toUpperCase()}.1`, 'not-an-outpoint', `${TXID_A}.x`]
        })
      )
      expect(await store.circulatingSupply(TOKEN)).toBe(7n)
    })

    it('does not exclude the same output index of another transaction', async () => {
      await store.storeTokenIfAbsent(tokenRow({ txid: TXID_A, outputIndex: 1, amount: 5 }))
      await store.storeTokenIfAbsent(tokenRow({ txid: TXID_B, outputIndex: 1, amount: 7 }))
      await store.putAssetState(assetState({ evictedOutpoints: [`${TXID_A}.1`] }))
      expect(await store.circulatingSupply(TOKEN)).toBe(7n)
    })

    it('uses another token evictedOutpoints only for that token', async () => {
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 1, amount: 5 }))
      await store.putAssetState(
        assetState({ tokenId: OTHER_TOKEN, evictedOutpoints: [`${TXID_A}.1`] })
      )
      expect(await store.circulatingSupply(TOKEN)).toBe(5n)
    })

    it('stays exact past 2^53 (sums as bigint, not as a double)', async () => {
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 1, amount: MAX_SAFE }))
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 2, amount: MAX_SAFE }))
      await store.storeTokenIfAbsent(tokenRow({ outputIndex: 3, amount: 1 }))
      expect(await store.circulatingSupply(TOKEN)).toBe(2n * BigInt(MAX_SAFE) + 1n)
    })
  })

  describe('authority index', () => {
    it('stores an authority row once and reports whether it inserted', async () => {
      await expect(store.storeAuthorityIfAbsent(authorityRow())).resolves.toBe(true)
      await expect(
        store.storeAuthorityIfAbsent(authorityRow({ identityKey: BOB, createdAt: new Date() }))
      ).resolves.toBe(false)
      expect(await db.collection('mandalaAuthorities').countDocuments()).toBe(1)
      expect(await store.getAuthorityRow(TXID_A, 0)).toEqual(authorityRow())
      expect(await store.getAuthorityRow(TXID_A, 1)).toBeNull()
    })

    it('takeAuthority removes and returns the row exactly once', async () => {
      await store.storeAuthorityIfAbsent(authorityRow())
      expect(await store.takeAuthority(TXID_A, 0)).toEqual(authorityRow())
      expect(await store.takeAuthority(TXID_A, 0)).toBeNull()
      expect(await store.getAuthorityRow(TXID_A, 0)).toBeNull()
    })

    it('lists the authorities of one token on one topic', async () => {
      await store.storeAuthorityIfAbsent(authorityRow({ txid: TXID_B, outputIndex: 0 }))
      await store.storeAuthorityIfAbsent(authorityRow({ txid: TXID_A, outputIndex: 2 }))
      await store.storeAuthorityIfAbsent(authorityRow({ txid: TXID_A, outputIndex: 0 }))
      await store.storeAuthorityIfAbsent(authorityRow({ txid: TXID_C, tokenId: OTHER_TOKEN }))
      await store.storeAuthorityIfAbsent(authorityRow({ txid: TXID_C, outputIndex: 1, topic: 'x' }))
      const listed = await store.listAuthorities(TOPIC, TOKEN)
      expect(listed.map(r => `${r.txid.slice(0, 2)}.${r.outputIndex}`)).toEqual([
        'aa.0',
        'aa.2',
        'bb.0'
      ])
      expect(listed[0]).toEqual(authorityRow({ txid: TXID_A, outputIndex: 0 }))
      expect(await store.listAuthorities(TOPIC, 'none_0')).toEqual([])
    })
  })

  describe('repairOwnerRow (spec 4.2a)', () => {
    it('inserts the token row of a value journal and credits the balance exactly once', async () => {
      await expect(store.repairOwnerRow(ownerRow())).resolves.toEqual({ inserted: true })
      await expect(store.repairOwnerRow(ownerRow())).resolves.toEqual({ inserted: false })
      expect(await store.getTokenRow(TXID_A, 1)).toEqual(tokenRow())
      expect(await store.getBalance(ALICE)).toBe(5)
      expect(await db.collection('mandalaTokens').countDocuments()).toBe(1)
    })

    it('inserts an authority row for an authority journal and never credits', async () => {
      const journal = ownerRow({ outputIndex: 0, role: 'authority', amount: 0 })
      await expect(store.repairOwnerRow(journal)).resolves.toEqual({ inserted: true })
      await expect(store.repairOwnerRow(journal)).resolves.toEqual({ inserted: false })
      expect(await store.getAuthorityRow(TXID_A, 0)).toEqual(authorityRow())
      expect(await store.getTokenRow(TXID_A, 0)).toBeNull()
      expect(await store.getBalance(ALICE)).toBe(0)
      expect(await db.collection('mandalaBalances').countDocuments()).toBe(0)
    })

    it('treats a deploy journal as an authority output', async () => {
      const journal = ownerRow({ outputIndex: 0, role: 'deploy', amount: 0 })
      await expect(store.repairOwnerRow(journal)).resolves.toEqual({ inserted: true })
      expect(await store.getAuthorityRow(TXID_A, 0)).toEqual(authorityRow())
      expect(await store.getBalance(ALICE)).toBe(0)
    })

    it('corrects a row that disagrees with the journal without crediting again', async () => {
      await store.storeTokenIfAbsent(
        tokenRow({ amount: 3, tokenId: OTHER_TOKEN, identityKey: BOB })
      )
      const later = new Date('2026-10-03T00:00:00.000Z')
      await expect(store.repairOwnerRow(ownerRow({ createdAt: later }))).resolves.toEqual({
        inserted: false
      })
      // fields come from the journal; the row keeps its own createdAt
      expect(await store.getTokenRow(TXID_A, 1)).toEqual(tokenRow())
      expect(await store.getBalance(ALICE)).toBe(0)
    })

    it('corrects an authority row that disagrees with the journal', async () => {
      await store.storeAuthorityIfAbsent(authorityRow({ identityKey: BOB, tokenId: OTHER_TOKEN }))
      await expect(
        store.repairOwnerRow(ownerRow({ outputIndex: 0, role: 'authority', amount: 0 }))
      ).resolves.toEqual({ inserted: false })
      expect(await store.getAuthorityRow(TXID_A, 0)).toEqual(authorityRow())
    })

    it('credits once when the same repair runs concurrently', async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, async () => await store.repairOwnerRow(ownerRow()))
      )
      expect(results.filter(r => r.inserted)).toHaveLength(1)
      expect(await store.getBalance(ALICE)).toBe(5)
      expect(await db.collection('mandalaTokens').countDocuments()).toBe(1)
    })

    it('does not write the journal', async () => {
      await store.repairOwnerRow(ownerRow())
      expect(await db.collection('mandalaOwners').countDocuments()).toBe(0)
    })
  })

  describe('balances', () => {
    it('accumulates deltas and reads zero for an unknown identity', async () => {
      expect(await store.getBalance(ALICE)).toBe(0)
      await store.adjustBalance(ALICE, 5)
      await store.adjustBalance(ALICE, -2)
      expect(await store.getBalance(ALICE)).toBe(3)
      expect(await store.getBalance(BOB)).toBe(0)
      expect(await db.collection('mandalaBalances').countDocuments()).toBe(1)
    })
  })

  describe('linkage records', () => {
    const linkageRecord = (identityKey: string): MandalaLinkageRecord => ({
      txid: TXID_A,
      outputIndex: 1,
      identityKey,
      linkage: {
        prover: ALICE,
        verifier: BOB,
        counterparty: ALICE,
        protocolID: [2, 'mandala token'],
        keyID: 'k',
        encryptedLinkage: [1],
        encryptedLinkageProof: [0],
        proofType: 0
      },
      createdAt: CREATED
    })

    it('upserts one record per outpoint', async () => {
      await store.storeLinkage(linkageRecord(ALICE))
      await store.storeLinkage(linkageRecord(BOB))
      const rows = await db.collection('mandalaLinkageRecords').find({}).toArray()
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject(linkageRecord(BOB))
    })
  })

  describe('metadata', () => {
    const metadata = (over: Partial<MandalaMetadataRecord> = {}): MandalaMetadataRecord => ({
      tokenId: TOKEN,
      txid: TXID_A,
      outputIndex: 0,
      sym: 'USD',
      dec: 2,
      label: 'Dollar',
      feeRatePerKb: null,
      ...over
    })

    it('round-trips a record by tokenId and upserts on a second store', async () => {
      expect(await store.findMetadata(TOKEN)).toBeNull()
      await store.storeMetadata(metadata())
      expect(await store.findMetadata(TOKEN)).toEqual(metadata())
      await store.storeMetadata(metadata({ feeRatePerKb: 7, label: 'Dollar 2' }))
      expect(await store.findMetadata(TOKEN)).toEqual(
        metadata({ feeRatePerKb: 7, label: 'Dollar 2' })
      )
      expect(await db.collection('mandalaMetadata').countDocuments()).toBe(1)
      expect(await store.findMetadata(OTHER_TOKEN)).toBeNull()
    })

    it('keys the record on tokenId alone', async () => {
      await store.storeMetadata(metadata({ txid: TXID_A }))
      await store.storeMetadata(metadata({ txid: TXID_B, label: 'moved' }))
      expect(await db.collection('mandalaMetadata').countDocuments()).toBe(1)
      expect(await store.findMetadata(TOKEN)).toEqual(metadata({ txid: TXID_B, label: 'moved' }))
      await store.storeMetadata(metadata({ tokenId: OTHER_TOKEN, txid: TXID_B }))
      expect(await db.collection('mandalaMetadata').countDocuments()).toBe(2)
    })

    it('deletes the record of one token only', async () => {
      await store.storeMetadata(metadata())
      await store.storeMetadata(metadata({ tokenId: OTHER_TOKEN, txid: TXID_B }))
      await store.deleteMetadata(TOKEN)
      expect(await store.findMetadata(TOKEN)).toBeNull()
      expect(await store.findMetadata(OTHER_TOKEN)).toEqual(
        metadata({ tokenId: OTHER_TOKEN, txid: TXID_B })
      )
      await store.deleteMetadata(TOKEN)
      expect(await db.collection('mandalaMetadata').countDocuments()).toBe(1)
    })
  })

  describe('asset state', () => {
    it('falls back to the default state, which is not persisted', async () => {
      expect(await store.getAssetState(TOKEN)).toEqual(defaultAssetState(TOKEN))
      expect(await db.collection('mandalaAssetStates').countDocuments()).toBe(0)
    })

    it('round-trips putAssetState and replaces the document on a second put', async () => {
      const next = assetState({
        isPaused: true,
        blockedIdentities: [ALICE],
        frozenOutpoints: [{ outpoint: `${TXID_A}.1`, amount: 5, owner: ALICE }],
        evictedOutpoints: [`${TXID_B}.0`],
        feeRatePerKb: 12,
        lastProcessedHeight: 9,
        lastProcessedOffset: 3,
        lastAdmitSeq: 4
      })
      await store.putAssetState(next)
      expect(await store.getAssetState(TOKEN)).toEqual(next)
      await store.putAssetState({ ...next, isPaused: false, blockedIdentities: [] })
      expect(await store.getAssetState(TOKEN)).toEqual({
        ...next,
        isPaused: false,
        blockedIdentities: []
      })
      expect(await db.collection('mandalaAssetStates').countDocuments()).toBe(1)
    })

    it('putAssetStateIfAbsent stores the first state only', async () => {
      expect(await store.putAssetStateIfAbsent(assetState({ feeRatePerKb: 5 }))).toBe(true)
      expect(await store.putAssetStateIfAbsent(assetState({ isPaused: true }))).toBe(false)
      expect(await store.getAssetState(TOKEN)).toEqual(assetState({ feeRatePerKb: 5 }))
      expect(await db.collection('mandalaAssetStates').countDocuments()).toBe(1)
    })

    it('putAssetStateIfAbsent leaves an existing state alone', async () => {
      await store.putAssetState(assetState({ isPaused: true }))
      expect(await store.putAssetStateIfAbsent(assetState())).toBe(false)
      expect(await store.getAssetState(TOKEN)).toEqual(assetState({ isPaused: true }))
    })
  })

  describe('admin history', () => {
    it('returns rows ordered by (height, offset, admitSeq)', async () => {
      await store.appendAdminHistory(
        historyRow({ txid: 't3', height: 100, offset: 2, admitSeq: 5 })
      )
      await store.appendAdminHistory(
        historyRow({ txid: 't1', height: 100, offset: 1, admitSeq: 9 })
      )
      await store.appendAdminHistory(
        historyRow({ txid: 't4', height: Number.MAX_SAFE_INTEGER, offset: 0, admitSeq: 3 })
      )
      await store.appendAdminHistory(historyRow({ txid: 't2', height: 99, offset: 9, admitSeq: 1 }))
      await store.appendAdminHistory(
        historyRow({ txid: 't5', height: 100, offset: 1, admitSeq: 10 })
      )
      const got = await store.findAdminHistory(TOKEN)
      expect(got.map(e => e.txid)).toEqual(['t2', 't1', 't5', 't3', 't4'])
      expect(got[0]).toEqual(historyRow({ txid: 't2', height: 99, offset: 9, admitSeq: 1 }))
    })

    it('scopes to one token and pages with limit and skip', async () => {
      await store.appendAdminHistory(historyRow({ txid: 't1', admitSeq: 1 }))
      await store.appendAdminHistory(historyRow({ txid: 't2', admitSeq: 2 }))
      await store.appendAdminHistory(historyRow({ txid: 't3', admitSeq: 3 }))
      await store.appendAdminHistory(historyRow({ txid: 'o1', tokenId: OTHER_TOKEN }))
      expect((await store.findAdminHistory(TOKEN, 2)).map(e => e.txid)).toEqual(['t1', 't2'])
      expect((await store.findAdminHistory(TOKEN, 2, 1)).map(e => e.txid)).toEqual(['t2', 't3'])
      expect((await store.findAdminHistory(TOKEN, undefined, 2)).map(e => e.txid)).toEqual(['t3'])
      expect((await store.findAdminHistory(OTHER_TOKEN)).map(e => e.txid)).toEqual(['o1'])
      expect(await store.findAdminHistory('none_0')).toEqual([])
    })

    it('appends one row per (tokenId, txid, outputIndex): the first write wins', async () => {
      expect(await store.appendAdminHistory(historyRow({ admitSeq: 1 }))).toBe(true)
      expect(await store.appendAdminHistory(historyRow({ admitSeq: 2, kind: 'unpause' }))).toBe(
        false
      )
      expect(await store.findAdminHistory(TOKEN)).toEqual([historyRow({ admitSeq: 1 })])
      expect(await store.appendAdminHistory(historyRow({ outputIndex: 1 }))).toBe(true)
      expect(await store.appendAdminHistory(historyRow({ tokenId: OTHER_TOKEN }))).toBe(true)
      expect(await db.collection('mandalaAdminHistory').countDocuments()).toBe(3)
    })

    it('does not mutate the entry it is given', async () => {
      const entry = historyRow()
      await store.appendAdminHistory(entry)
      expect(Object.keys(entry)).not.toContain('_id')
    })

    it('names the distinct tokens a transaction touched', async () => {
      await store.appendAdminHistory(historyRow({ txid: TXID_A, outputIndex: 0 }))
      await store.appendAdminHistory(historyRow({ txid: TXID_A, outputIndex: 2 }))
      await store.appendAdminHistory(
        historyRow({ txid: TXID_A, outputIndex: 1, tokenId: OTHER_TOKEN })
      )
      await store.appendAdminHistory(historyRow({ txid: TXID_B, tokenId: 'third_0' }))
      expect((await store.tokensTouchedBy(TXID_A)).sort()).toEqual([TOKEN, OTHER_TOKEN].sort())
      expect(await store.tokensTouchedBy(TXID_B)).toEqual(['third_0'])
      expect(await store.tokensTouchedBy(TXID_C)).toEqual([])
    })

    it('deletes only the history rows of the given transaction', async () => {
      await store.appendAdminHistory(historyRow({ txid: TXID_A, admitSeq: 1 }))
      await store.appendAdminHistory(
        historyRow({ txid: TXID_A, outputIndex: 1, tokenId: OTHER_TOKEN })
      )
      await store.appendAdminHistory(historyRow({ txid: TXID_B, admitSeq: 2 }))
      await store.deleteAdminHistoryByTxid(TXID_A)
      expect((await store.findAdminHistory(TOKEN)).map(e => e.txid)).toEqual([TXID_B])
      expect(await store.findAdminHistory(OTHER_TOKEN)).toEqual([])
      expect(await store.tokensTouchedBy(TXID_A)).toEqual([])
      await store.deleteAdminHistoryByTxid(TXID_C)
      expect(await db.collection('mandalaAdminHistory').countDocuments()).toBe(1)
    })
  })

  describe('nextAdmitSeq', () => {
    it('starts at 1 and is monotonic', async () => {
      expect(await store.nextAdmitSeq()).toBe(1)
      expect(await store.nextAdmitSeq()).toBe(2)
      expect(await store.nextAdmitSeq()).toBe(3)
    })

    it('never hands the same number to concurrent callers', async () => {
      const seqs = await Promise.all(
        Array.from({ length: 10 }, async () => await store.nextAdmitSeq())
      )
      expect(new Set(seqs).size).toBe(10)
    })
  })
})
