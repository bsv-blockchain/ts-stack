import { jest } from '@jest/globals'
import type { Db } from 'mongodb'
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
    fields: { userName, profilePhoto: 'https://example.test/a.png' }
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
    find: jest.fn(() => cursor)
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
    expect(update.$setOnInsert.createdAt).toBeInstanceOf(Date)
  })
})
