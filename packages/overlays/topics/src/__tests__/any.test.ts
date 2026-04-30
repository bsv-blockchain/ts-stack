/**
 * Integration tests for AnyTopicManager and AnyLookupService.
 *
 * AnyTopicManager admits every output from any valid transaction — there are no rules.
 * AnyLookupService stores admitted outputs in MongoDB and serves queries.
 */

import { jest } from '@jest/globals'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { LockingScript, P2PKH, PrivateKey, Transaction, Utils } from '@bsv/sdk'
import AnyTopicManager from '../any/AnyTopicManager.js'
import { AnyLookupService } from '../any/AnyLookupService.js'
import { AnyStorage } from '../any/AnyStorage.js'
import { OutputAdmittedByTopic, LookupQuestion } from '@bsv/overlay'

const mongoMemoryServerOptions = { instance: { launchTimeout: 60000 } }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTx(outputCount = 1): Transaction {
  const tx = new Transaction()
  const key = PrivateKey.fromRandom()
  for (let i = 0; i < outputCount; i++) {
    tx.addOutput({
      lockingScript: new P2PKH().lock(key.toPublicKey().toHash()),
      satoshis: 1000
    })
  }
  return tx
}

// ---------------------------------------------------------------------------
// AnyTopicManager tests
// ---------------------------------------------------------------------------

describe('AnyTopicManager', () => {
  let manager: AnyTopicManager

  beforeEach(() => {
    manager = new AnyTopicManager()
  })

  it('admits the single output of a one-output transaction', async () => {
    const tx = buildTx(1)
    const beef = tx.toBEEF()
    const result = await manager.identifyAdmissibleOutputs(beef, [])
    expect(result.outputsToAdmit).toEqual([0])
    expect(result.coinsToRetain).toEqual([])
  })

  it('admits all outputs of a multi-output transaction', async () => {
    const tx = buildTx(3)
    const beef = tx.toBEEF()
    const result = await manager.identifyAdmissibleOutputs(beef, [])
    expect(result.outputsToAdmit).toEqual([0, 1, 2])
  })

  it('returns empty outputsToAdmit for malformed BEEF', async () => {
    const result = await manager.identifyAdmissibleOutputs([0, 1, 2], [])
    expect(result.outputsToAdmit).toEqual([])
    expect(result.coinsToRetain).toEqual([])
  })

  it('getDocumentation returns a non-empty string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected name', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('Any Topic Manager')
    expect(typeof meta.shortDescription).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// AnyLookupService tests (with real in-memory MongoDB)
// ---------------------------------------------------------------------------

describe('AnyLookupService (MongoDB)', () => {
  let mongod: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let service: AnyLookupService

  beforeAll(async () => {
    jest.setTimeout(60000)
    mongod = await MongoMemoryServer.create(mongoMemoryServerOptions)
    client = new MongoClient(mongod.getUri())
    await client.connect()
    db = client.db('test_any')
    service = new AnyLookupService(new AnyStorage(db))
  })

  afterAll(async () => {
    await client.close()
    await mongod.stop()
  })

  afterEach(async () => {
    await db.collection('anyRecords').deleteMany({})
  })

  it('stores a record via outputAdmittedByTopic and retrieves it via lookup', async () => {
    const payload: OutputAdmittedByTopic = {
      mode: 'locking-script',
      txid: 'aabbcc0011',
      outputIndex: 0,
      topic: 'tm_anytx',
      satoshis: 1000,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash())
    }

    await service.outputAdmittedByTopic(payload)

    const result = await service.lookup({
      service: 'ls_anytx',
      query: { txid: 'aabbcc0011' }
    } as LookupQuestion)

    // findByTxid returns a single record (not an array) wrapped in array by lookup
    expect(Array.isArray(result)).toBe(true)
    const records = result as Array<any>
    expect(records.length).toBeGreaterThan(0)
    const record = records[0]
    expect(record).toBeDefined()
    expect(record).not.toBeNull()
    expect(record.txid).toBe('aabbcc0011')
  })

  it('ignores outputAdmittedByTopic for a different topic', async () => {
    const payload: OutputAdmittedByTopic = {
      mode: 'locking-script',
      txid: 'ffffffff01',
      outputIndex: 0,
      topic: 'tm_other',
      satoshis: 1000,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash())
    }

    await service.outputAdmittedByTopic(payload)

    const result = await service.lookup({
      service: 'ls_anytx',
      query: {}
    } as LookupQuestion) as any[]

    expect(result).toHaveLength(0)
  })

  it('removes a record via outputEvicted', async () => {
    // Store a record first
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: 'evict001',
      outputIndex: 0,
      topic: 'tm_anytx',
      satoshis: 1000,
      lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash())
    } as OutputAdmittedByTopic)

    // Verify it's there
    const before = await service.lookup({
      service: 'ls_anytx',
      query: {}
    } as LookupQuestion) as any[]
    expect(before.length).toBeGreaterThan(0)

    // Evict it
    await service.outputEvicted('evict001', 0)

    // Verify it's gone
    const after = await service.lookup({
      service: 'ls_anytx',
      query: {}
    } as LookupQuestion) as any[]
    expect(after).toHaveLength(0)
  })

  it('findAll returns multiple records', async () => {
    for (let i = 0; i < 3; i++) {
      await service.outputAdmittedByTopic({
        mode: 'locking-script',
        txid: `multitx${i}`,
        outputIndex: 0,
        topic: 'tm_anytx',
        satoshis: 1000,
        lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toPublicKey().toHash())
      } as OutputAdmittedByTopic)
    }

    const result = await service.lookup({
      service: 'ls_anytx',
      query: {}
    } as LookupQuestion) as any[]

    expect(result.length).toBe(3)
  })

  it('lookup throws for unsupported service', async () => {
    await expect(service.lookup({
      service: 'ls_unknown',
      query: {}
    } as LookupQuestion)).rejects.toThrow('Lookup service not supported!')
  })

  it('lookup throws for missing question', async () => {
    await expect(service.lookup(null as unknown as LookupQuestion)).rejects.toThrow()
  })
})
