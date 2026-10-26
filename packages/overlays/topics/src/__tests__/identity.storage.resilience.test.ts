import { jest } from '@jest/globals'
import { MongoClient, type Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import type { Certificate } from '@bsv/sdk'

import { IdentityStorageManager } from '../identity/IdentityStorageManager.js'

/**
 * Regression coverage for the ls_identity outage seen on overlay-us-1 / overlay-ap-1:
 * legacy `identityRecords` collections contain duplicate (txid, outputIndex) rows, so the
 * unique index build fails with E11000. That must not take reads down with it.
 */

const duplicateKeyError = (): Error =>
  Object.assign(
    new Error(
      'Index build failed: E11000 duplicate key error collection: overlay_lookup_services.identityRecords index: txid_1_outputIndex_1 dup key: { txid: "0e56", outputIndex: 0 }'
    ),
    { name: 'MongoServerError', code: 11000 }
  )

const certificate = (userName: string): Certificate =>
  ({
    type: 'xCert',
    serialNumber: 'serial',
    subject: '02subject',
    certifier: '03certifier',
    revocationOutpoint: 'outpoint.0',
    signature: 'sig',
    fields: { userName, profilePhoto: 'https://example.test/a.png' },
    keyring: { userName: 'revelation-key' }
  }) as unknown as Certificate

interface Harness {
  db: Db
  createIndex: jest.Mock
  updateOne: jest.Mock
  insertOne: jest.Mock
  toArray: jest.Mock
}

const harness = (createIndex: jest.Mock): Harness => {
  const toArray = jest.fn(async () => [{ txid: 'abc', outputIndex: 0 }])
  const cursor = { project: () => cursor, limit: () => cursor, skip: () => cursor, toArray }
  const updateOne = jest.fn(async () => ({ acknowledged: true, upsertedCount: 1 }))
  const insertOne = jest.fn(async () => ({ acknowledged: true }))
  const collection = {
    createIndex,
    updateOne,
    insertOne,
    deleteOne: jest.fn(async () => ({ acknowledged: true, deletedCount: 1 })),
    deleteMany: jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })),
    updateMany: jest.fn(async () => ({ acknowledged: true, modifiedCount: 0 })),
    findOne: jest.fn(async () => null),
    find: jest.fn(() => cursor),
    aggregate: jest.fn(() => cursor)
  }
  const db = { collection: jest.fn(() => collection) } as unknown as Db
  return { db, createIndex, updateOne, insertOne, toArray }
}

describe('IdentityStorageManager index resilience', () => {
  test('serves lookups when the unique index cannot be built', async () => {
    const createIndex = jest.fn(async (spec: any) => {
      if (spec?.txid === 1) throw duplicateKeyError()
      return 'index'
    }) as unknown as jest.Mock
    const { db } = harness(createIndex)
    const storage = new IdentityStorageManager(db)

    await expect(storage.findByAttribute({ userName: 'deggen' })).resolves.toEqual([
      { txid: 'abc', outputIndex: 0 }
    ])
    await expect(storage.findByIdentityKey('02subject')).resolves.toEqual([
      { txid: 'abc', outputIndex: 0 }
    ])
  })

  test('retries index creation after a failed build instead of caching the rejection', async () => {
    let attempt = 0
    const createIndex = jest.fn(async () => {
      attempt++
      if (attempt === 1) throw duplicateKeyError()
      return 'index'
    }) as unknown as jest.Mock
    const { db } = harness(createIndex)
    const storage = new IdentityStorageManager(db)

    await storage.findByAttribute({ userName: 'deggen' })
    const callsAfterFailure = (createIndex as jest.Mock).mock.calls.length

    await storage.findByAttribute({ userName: 'deggen' })
    expect((createIndex as jest.Mock).mock.calls.length).toBeGreaterThan(callsAfterFailure)
  })

  test('does not rebuild indexes once a build has succeeded', async () => {
    const createIndex = jest.fn(async () => 'index') as unknown as jest.Mock
    const { db } = harness(createIndex)
    const storage = new IdentityStorageManager(db)

    await storage.findByAttribute({ userName: 'deggen' })
    const calls = (createIndex as jest.Mock).mock.calls.length
    expect(calls).toBeGreaterThan(0)

    await storage.findByAttribute({ userName: 'deggen' })
    expect((createIndex as jest.Mock).mock.calls).toHaveLength(calls)
  })
})

describe('IdentityStorageManager.storeRecord', () => {
  test('upserts on (txid, outputIndex) so re-admission cannot duplicate a record', async () => {
    const createIndex = jest.fn(async () => 'index') as unknown as jest.Mock
    const { db, updateOne, insertOne } = harness(createIndex)
    const storage = new IdentityStorageManager(db)

    await storage.storeRecord('abc', 0, certificate('deggen'))
    await storage.storeRecord('abc', 0, certificate('deggen'))

    expect(insertOne).not.toHaveBeenCalled()
    expect(updateOne).toHaveBeenCalledTimes(2)

    const [filter, update, options] = (updateOne as jest.Mock).mock.calls[0] as any[]
    expect(filter).toEqual({ txid: 'abc', outputIndex: 0 })
    expect(options).toEqual({ upsert: true })
    expect(update.$set.searchableAttributes).toBe('deggen')
    expect(update.$set.revelationId).toMatch(/^[0-9a-f]{64}$/)
    expect(update.$setOnInsert.createdAt).toBeInstanceOf(Date)
  })
})

interface BoundaryHarness {
  db: Db
  records: Record<string, jest.Mock>
  revocations: Record<string, jest.Mock>
  aggregate: jest.Mock
}

function boundaryHarness(): BoundaryHarness {
  const cursor = { toArray: jest.fn(async () => [{ txid: 'abc', outputIndex: 0 }]) }
  const aggregate = jest.fn(() => cursor)
  const records: Record<string, jest.Mock> = {
    createIndex: jest.fn(async () => 'index'),
    updateOne: jest.fn(),
    deleteOne: jest.fn(),
    deleteMany: jest.fn(),
    updateMany: jest.fn(),
    findOne: jest.fn(async () => null),
    aggregate
  }
  const revocations: Record<string, jest.Mock> = {
    createIndex: jest.fn(async () => 'index'),
    updateOne: jest.fn(),
    findOne: jest.fn(async () => null)
  }
  const db = {
    collection: jest.fn((name: string) => (name === 'identityRecords' ? records : revocations))
  } as unknown as Db
  return { db, records, revocations, aggregate }
}

describe('IdentityStorageManager trust boundaries', () => {
  it.each([
    ['a missing keyring', undefined, 'plain keyring'],
    ['a null keyring', null, 'plain keyring'],
    ['an array keyring', [], 'plain keyring'],
    ['an inherited keyring', Object.create({ userName: 'key' }), 'plain keyring'],
    ['a non-string key', { userName: 1 }, 'values must be strings'],
    ['an empty keyring', {}, 'must not be empty']
  ])(
    'rejects a revelation certificate with %s before persistence',
    async (_label, keyring, message) => {
      const { db, records } = boundaryHarness()
      const storage = new IdentityStorageManager(db)
      const malformed = { ...(certificate('alice') as unknown as object), keyring } as Certificate

      await expect(storage.storeRecord('abc', 0, malformed)).rejects.toThrow(message as string)
      expect(records.updateOne).not.toHaveBeenCalled()
    }
  )

  it('removes a record when revocation races the admission upsert', async () => {
    const { db, records, revocations } = boundaryHarness()
    revocations.findOne.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'revoked' })
    const storage = new IdentityStorageManager(db)

    await storage.storeRecord('abc', 0, certificate('alice'))

    expect(records.updateOne).toHaveBeenCalledTimes(1)
    const revelationId = records.updateOne.mock.calls[0]?.[1].$set.revelationId as string
    expect(records.deleteMany).toHaveBeenCalledWith({ revelationId })
  })

  it('does not write a revelation that was already revoked', async () => {
    const { db, records, revocations } = boundaryHarness()
    revocations.findOne.mockResolvedValue({ _id: 'revoked' })
    const storage = new IdentityStorageManager(db)

    await storage.storeRecord('abc', 0, certificate('alice'))

    expect(records.updateOne).not.toHaveBeenCalled()
    expect(records.deleteMany).not.toHaveBeenCalled()
  })

  it('keeps unauthenticated legacy cleanup idempotent without publishing a tombstone', async () => {
    const { db, records, revocations } = boundaryHarness()
    const storage = new IdentityStorageManager(db)

    await storage.revokeRecord('missing', 2)

    expect(records.deleteOne).toHaveBeenCalledWith({ txid: 'missing', outputIndex: 2 })
    expect(revocations.updateOne).not.toHaveBeenCalled()
  })

  it('derives a tombstone from the authenticated stored certificate when one exists', async () => {
    const { db, records, revocations } = boundaryHarness()
    const storedCertificate = certificate('alice')
    records.findOne.mockResolvedValue({ certificate: storedCertificate })
    const storage = new IdentityStorageManager(db)

    await storage.revokeRecord('abc', 0)

    expect(records.updateMany).toHaveBeenCalledTimes(1)
    expect(revocations.updateOne).toHaveBeenCalledWith(
      { revelationId: expect.stringMatching(/^[0-9a-f]{64}$/) },
      expect.objectContaining({
        $setOnInsert: expect.objectContaining({ txid: 'abc', outputIndex: 0 })
      }),
      { upsert: true }
    )
    expect(records.deleteMany).toHaveBeenCalledTimes(1)
  })

  it('escapes fuzzy attributes and applies explicit zero offset and positive limit', async () => {
    const { db, aggregate } = boundaryHarness()
    const storage = new IdentityStorageManager(db)

    await storage.findByAttribute({ displayName: ' Alice.* ' }, undefined, 5, 0)

    const pipeline = aggregate.mock.calls[0]?.[0] as Array<Record<string, unknown>>
    expect(pipeline[0]).toEqual({
      $match: {
        $and: [{ 'certificate.fields.displayName': /Alice\.\*/i }]
      }
    })
    expect(pipeline).toContainEqual({ $skip: 0 })
    expect(pipeline).toContainEqual({ $limit: 5 })
  })

  it.each([
    ['missing certificate types', undefined, 'subject'],
    ['empty certificate types', [], 'subject'],
    ['missing subject', ['type'], undefined]
  ])('short-circuits certificate-type lookup with %s', async (_label, types, subject) => {
    const { db, aggregate } = boundaryHarness()
    const storage = new IdentityStorageManager(db)

    await expect(storage.findByCertificateType(types as never, subject as never)).resolves.toEqual(
      []
    )
    expect(aggregate).not.toHaveBeenCalled()
  })
})

describe('IdentityStorageManager revelation revocation', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let storage: IdentityStorageManager

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({ instance: { launchTimeout: 60_000 } })
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('identity-revelation-replay')
    storage = new IdentityStorageManager(db)
  }, 60_000)

  afterAll(async () => {
    await client.close()
    await mongo.stop()
  }, 60_000)

  afterEach(async () => {
    await Promise.all([
      db.collection('identityRecords').deleteMany({}),
      db.collection('identityRevelationRevocations').deleteMany({})
    ])
  })

  test('a copied revelation cannot reappear after the authenticated output is spent', async () => {
    const revealed = certificate('deggen')
    await storage.storeRecord('original', 0, revealed)
    await storage.storeRecord('copy-before-spend', 1, revealed)

    await expect(storage.findByCertificateSerialNumber('serial')).resolves.toHaveLength(2)

    await storage.revokeRecord('original', 0, revealed)

    await expect(storage.findByCertificateSerialNumber('serial')).resolves.toEqual([])
    await storage.storeRecord('copy-after-spend', 2, revealed)
    await expect(storage.findByCertificateSerialNumber('serial')).resolves.toEqual([])
    await expect(db.collection('identityRevelationRevocations').countDocuments({})).resolves.toBe(1)
  })

  test('revocation removes legacy copies that predate revelation identifiers', async () => {
    const revealed = certificate('deggen')
    await db.collection('identityRecords').insertMany([
      { txid: 'legacy-original', outputIndex: 0, certificate: revealed, createdAt: new Date() },
      { txid: 'legacy-copy', outputIndex: 1, certificate: revealed, createdAt: new Date() }
    ])

    await storage.revokeRecord('legacy-original', 0, revealed)

    await expect(db.collection('identityRecords').countDocuments({})).resolves.toBe(0)
  })

  test('lookup hides a tombstoned row even if post-tombstone deletion was interrupted', async () => {
    const revealed = certificate('deggen')
    await storage.storeRecord('interrupted', 0, revealed)
    const stored = await db.collection('identityRecords').findOne({ txid: 'interrupted' })
    expect(stored?.revelationId).toMatch(/^[0-9a-f]{64}$/)
    await db.collection('identityRevelationRevocations').insertOne({
      revelationId: stored?.revelationId,
      txid: 'interrupted',
      outputIndex: 0,
      revokedAt: new Date()
    })

    await expect(storage.findByCertificateSerialNumber('serial')).resolves.toEqual([])
    await expect(db.collection('identityRecords').countDocuments({})).resolves.toBe(1)
  })

  test('different selective disclosures from the same certificate remain independent', async () => {
    const first = certificate('deggen')
    const second = {
      ...(certificate('deggen') as unknown as Record<string, unknown>),
      keyring: { profilePhoto: 'different-revelation-key' }
    } as unknown as Certificate

    await storage.storeRecord('first', 0, first)
    await storage.storeRecord('second', 0, second)
    await storage.revokeRecord('first', 0, first)

    await expect(storage.findByCertificateSerialNumber('serial')).resolves.toEqual([
      { txid: 'second', outputIndex: 0 }
    ])
  })
})
