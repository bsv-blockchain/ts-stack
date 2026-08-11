import { Certificate } from '@bsv/sdk'
import { MongoClient, type Db } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'

import { IdentityStorageManager } from '../identity/IdentityStorageManager.js'

const mongoMemoryServerOptions = { instance: { launchTimeout: 60_000 } }
const subject = '022222222222222222222222222222222222222222222222222222222222222222'
const certifier = '033333333333333333333333333333333333333333333333333333333333333333'

function certificateWithFields(serialNumber: string, fields: Record<string, string>): Certificate {
  return new Certificate(
    'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
    serialNumber,
    subject,
    certifier,
    `${'0'.repeat(64)}.0`,
    fields
  )
}

describe('IdentityStorageManager fuzzy attribute lookup', () => {
  let mongod: MongoMemoryServer | undefined
  let client: MongoClient | undefined
  let db: Db | undefined
  let storage: IdentityStorageManager

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create(mongoMemoryServerOptions)
    client = new MongoClient(mongod.getUri())
    await client.connect()
    db = client.db('test_identity_fuzzy')
    storage = new IdentityStorageManager(db)

    await storage.storeRecord(
      'ty-record',
      0,
      certificateWithFields('ty-serial', { email: 'ty@projectbabbage.com', name: 'Ty Everett' })
    )
    await storage.storeRecord(
      'brayden-record',
      0,
      certificateWithFields('brayden-serial', { userName: 'braydenjlangley' })
    )
    await storage.storeRecord(
      'project-babbage-decoy',
      0,
      certificateWithFields('decoy-serial', { email: 'jackie@projectbabbage.com' })
    )
    await storage.storeRecord(
      'dot-com-decoy',
      0,
      certificateWithFields('dot-com-serial', { email: 'someone@example.com' })
    )
  }, 60_000)

  afterAll(async () => {
    await client?.close()
    await mongod?.stop()
  }, 60_000)

  it('matches a full email literally without returning records that only share text tokens', async () => {
    await expect(storage.findByAttribute({ any: 'ty@projectbabbage.com' })).resolves.toEqual([
      { txid: 'ty-record', outputIndex: 0 }
    ])
  })

  it('matches a case-insensitive prefix inside a longer public attribute', async () => {
    await expect(storage.findByAttribute({ any: 'BRAYDEN' })).resolves.toEqual([
      { txid: 'brayden-record', outputIndex: 0 }
    ])
  })
})
