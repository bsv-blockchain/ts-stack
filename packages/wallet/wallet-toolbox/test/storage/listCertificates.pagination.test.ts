import 'fake-indexeddb/auto'
import { randomUUID } from 'node:crypto'
import makeKnex from 'knex'
import { StorageIdb } from '../../src/storage/StorageIdb'
import { StorageKnex } from '../../src/storage/StorageKnex'
import { StorageProvider } from '../../src/storage/StorageProvider'
import { listCertificates } from '../../src/storage/methods/listCertificates'
import type { TableCertificate } from '../../src/storage/schema/tables/TableCertificate'

const certifier = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const otherCertifier = '0379be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const type = Buffer.alloc(32, 1).toString('base64')
const otherType = Buffer.alloc(32, 2).toString('base64')
const date = new Date('2026-11-13T00:00:00Z')
const storageIdentityKey = '1'.repeat(64)

describe.each(['IndexedDB', 'SQLite'] as const)('listCertificates pagination with %s', backend => {
  let storage: StorageProvider
  let userId: number
  let serial = 0
  const matchingSerials: string[] = []

  async function insertCertificate(overrides: Partial<TableCertificate> = {}): Promise<TableCertificate> {
    const row: TableCertificate = {
      certificateId: 0,
      userId,
      type,
      serialNumber: Buffer.alloc(32, ++serial).toString('base64'),
      certifier,
      subject: certifier,
      revocationOutpoint: '0'.repeat(64) + '.0',
      signature: '01',
      isDeleted: false,
      created_at: date,
      updated_at: date,
      ...overrides
    }
    await storage.insertCertificate(row)
    return row
  }

  beforeAll(async () => {
    const options = StorageProvider.createStorageBaseOptions('test')
    if (backend === 'IndexedDB') {
      const idb = new StorageIdb(options)
      idb.dbName = `wallet-toolbox-certificate-pagination-${randomUUID()}`
      storage = idb
    } else {
      const database = makeKnex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }
      })
      storage = new StorageKnex({ ...options, knex: database })
      await database.raw('PRAGMA foreign_keys = ON')
    }
    await storage.migrate('synthetic certificate pagination', storageIdentityKey)
    await storage.makeAvailable()
    userId = await storage.insertUser({
      userId: 0,
      identityKey: certifier,
      activeStorage: storageIdentityKey,
      created_at: date,
      updated_at: date
    })
    const otherUserId = await storage.insertUser({
      userId: 0,
      identityKey: otherCertifier,
      activeStorage: storageIdentityKey,
      created_at: date,
      updated_at: date
    })
    for (let i = 0; i < 5; i++) {
      const row = await insertCertificate()
      matchingSerials.push(row.serialNumber)
      await storage.insertCertificateField({
        certificateId: row.certificateId,
        userId,
        fieldName: 'name',
        fieldValue: `matching-${i}`,
        masterKey: `synthetic-key-${i}`,
        created_at: date,
        updated_at: date
      })
    }
    await insertCertificate({ isDeleted: true })
    await insertCertificate({ userId: otherUserId })
    await insertCertificate({ type: otherType })
    await insertCertificate({ certifier: otherCertifier })
  })

  afterAll(async () => {
    if (storage != null) {
      await storage.destroy()
      // Deleting an IndexedDB database requires its connection to be closed.
      if (storage instanceof StorageIdb) await storage.dropAllData()
    }
  })

  test.each([
    { page: 'first short', offset: 0, limit: 10, length: 5 },
    { page: 'last short', offset: 3, limit: 10, length: 2 },
    { page: 'middle full', offset: 1, limit: 2, length: 2 },
    { page: 'first full', offset: 0, limit: 2, length: 2 },
    { page: 'exact end', offset: 5, limit: 10, length: 0 },
    { page: 'past end', offset: 10, limit: 10, length: 0 }
  ])('$page preserves the filtered total and field attribution', async ({ offset, limit, length }) => {
    const result = await listCertificates(
      storage,
      { identityKey: certifier, userId },
      {
        certifiers: [certifier],
        types: [type],
        limit,
        offset,
        privileged: false
      }
    )
    expect(result.totalCertificates).toBe(5)
    expect(result.certificates).toHaveLength(length)
    expect(result.certificates.map(c => c.serialNumber)).toEqual(matchingSerials.slice(offset, offset + limit))
    result.certificates.forEach((certificate, index) => {
      expect(certificate.fields).toEqual({ name: `matching-${offset + index}` })
    })
  })

  test.each([0, 4])('an empty matching set at offset %i stays zero', async offset => {
    const result = await listCertificates(
      storage,
      { identityKey: certifier, userId },
      {
        certifiers: [certifier],
        types: [Buffer.alloc(32, 3).toString('base64')],
        limit: 2,
        offset,
        privileged: false
      }
    )
    expect(result).toEqual({ totalCertificates: 0, certificates: [] })
  })

  test('the unpaged count retains the partial filter', async () => {
    const result = await listCertificates(
      storage,
      { identityKey: certifier, userId },
      {
        certifiers: [certifier],
        types: [type],
        limit: 1,
        offset: 0,
        privileged: false,
        partial: { serialNumber: matchingSerials[2] }
      }
    )
    expect(result.totalCertificates).toBe(1)
    expect(result.certificates.map(c => c.serialNumber)).toEqual([matchingSerials[2]])
  })
})
