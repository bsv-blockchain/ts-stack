/**
 * Integration tests for HelloWorldTopicManager and HelloWorldLookupService.
 *
 * HelloWorldTopicManager expects a PushDrop locking script with:
 *   - Exactly 1 data field (the message, UTF-8, ≥ 2 bytes)
 *   - A DER-encoded signature appended as the last field
 *   - The signature is verified against the locking public key over all data fields
 *
 * The script format (decoded by PushDrop.decode) is:
 *   <pubkey> OP_CHECKSIG <field1> <signature> OP_2DROP OP_DROP …
 *
 * Because PushDrop.lock() requires a wallet instance, we construct the locking
 * script manually, following exactly the same format used in the btms-backend test
 * helpers (and verified by reading the PushDrop.decode implementation).
 */

import { jest } from '@jest/globals'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import {
  LockingScript,
  PrivateKey,
  PublicKey,
  Signature,
  Transaction,
  Utils,
  P2PKH
} from '@bsv/sdk'
import HelloWorldTopicManager from '../hello/HelloWorldTopicManager.js'
import { HelloWorldLookupService } from '../hello/HelloWorldLookupService.js'
import { HelloWorldStorage } from '../hello/HelloWorldStorage.js'
import { OutputAdmittedByTopic, LookupQuestion } from '@bsv/overlay'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a PushDrop locking script with the 'before' lock position:
 *   <pubkey> OP_CHECKSIG <field1> … <fieldN> OP_2DROP* OP_DROP?
 *
 * This matches the format expected by PushDrop.decode() with lockPosition='before'.
 * The last argument in `fields` is treated as the final chunk before the DROP ops.
 */
function buildPushDropScript(pubKey: PublicKey, fields: number[][]): LockingScript {
  const chunks: Array<{ op: number; data?: number[] }> = []

  // Lock: <pubkey bytes> OP_CHECKSIG
  const pubKeyBytes = Utils.toArray(pubKey.toString(), 'hex')
  chunks.push({ op: pubKeyBytes.length, data: pubKeyBytes })
  chunks.push({ op: 0xac }) // OP_CHECKSIG

  // Push each field as a minimally-encoded data push
  for (const field of fields) {
    if (field.length === 0) {
      chunks.push({ op: 0 }) // OP_0
    } else if (field.length <= 75) {
      chunks.push({ op: field.length, data: field })
    } else if (field.length <= 255) {
      chunks.push({ op: 0x4c, data: field }) // OP_PUSHDATA1
    } else {
      chunks.push({ op: 0x4d, data: field }) // OP_PUSHDATA2
    }
  }

  // Drop fields: OP_2DROP for every pair, OP_DROP for a leftover single
  let remaining = fields.length
  while (remaining > 1) {
    chunks.push({ op: 0x6d }) // OP_2DROP
    remaining -= 2
  }
  if (remaining === 1) {
    chunks.push({ op: 0x75 }) // OP_DROP
  }

  return new LockingScript(chunks)
}

/**
 * Create a HelloWorld-valid locking script:
 *   fields = [messageBytes, signatureBytes]
 * where signatureBytes is a DER signature over messageBytes by `privKey`.
 */
function buildValidHelloScript(privKey: PrivateKey, message: string): LockingScript {
  const messageBytes = Utils.toArray(message, 'utf8')
  // The topic manager concatenates all fields (after pop-ing the signature)
  // to form `data`, then verifies. With 1 field: data = messageBytes.
  const sig: Signature = privKey.sign(messageBytes)
  const sigBytes = sig.toDER() as number[]
  return buildPushDropScript(privKey.toPublicKey(), [messageBytes, sigBytes])
}

// ---------------------------------------------------------------------------
// HelloWorldTopicManager tests
// ---------------------------------------------------------------------------

describe('HelloWorldTopicManager', () => {
  let manager: HelloWorldTopicManager

  beforeEach(() => {
    manager = new HelloWorldTopicManager()
  })

  it('admits a valid output with a proper message and signature', async () => {
    const privKey = PrivateKey.fromRandom()
    const lockingScript = buildValidHelloScript(privKey, 'hello world')

    const tx = new Transaction()
    tx.addOutput({ lockingScript, satoshis: 1000 })

    const beef = tx.toBEEF()
    const result = await manager.identifyAdmissibleOutputs(beef, [])

    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toEqual([])
  })

  it('rejects a message that is too short (< 2 chars)', async () => {
    const privKey = PrivateKey.fromRandom()
    // Single byte message — "A"
    const messageBytes = Utils.toArray('A', 'utf8')
    const sig: Signature = privKey.sign(messageBytes)
    const sigBytes = sig.toDER() as number[]
    const lockingScript = buildPushDropScript(privKey.toPublicKey(), [messageBytes, sigBytes])

    const tx = new Transaction()
    tx.addOutput({ lockingScript, satoshis: 1000 })

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects an output where the signature is invalid', async () => {
    const privKey = PrivateKey.fromRandom()
    const messageBytes = Utils.toArray('hello', 'utf8')
    // Sign different data so signature will fail verification
    const wrongData = Utils.toArray('wrong data', 'utf8')
    const sig: Signature = privKey.sign(wrongData)
    const sigBytes = sig.toDER() as number[]
    const lockingScript = buildPushDropScript(privKey.toPublicKey(), [messageBytes, sigBytes])

    const tx = new Transaction()
    tx.addOutput({ lockingScript, satoshis: 1000 })

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('admits only the valid output when mixed with an invalid one', async () => {
    const privKey = PrivateKey.fromRandom()

    const validScript = buildValidHelloScript(privKey, 'valid message')
    const invalidScript = new P2PKH().lock(privKey.toPublicKey().toHash()) // not a PushDrop

    const tx = new Transaction()
    tx.addOutput({ lockingScript: validScript, satoshis: 1000 })
    tx.addOutput({ lockingScript: invalidScript, satoshis: 500 })

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.outputsToAdmit).not.toContain(1)
  })

  it('getDocumentation returns a string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected fields', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('HelloWorld Topic Manager')
    expect(typeof meta.shortDescription).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// HelloWorldLookupService tests (with real in-memory MongoDB)
// ---------------------------------------------------------------------------

describe('HelloWorldLookupService (MongoDB)', () => {
  let mongod: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let service: HelloWorldLookupService

  beforeAll(async () => {
    jest.setTimeout(30000)
    mongod = await MongoMemoryServer.create()
    client = new MongoClient(mongod.getUri())
    await client.connect()
    db = client.db('test_hello')
    service = new HelloWorldLookupService(new HelloWorldStorage(db))
  })

  afterAll(async () => {
    await client.close()
    await mongod.stop()
  })

  afterEach(async () => {
    await db.collection('helloWorldRecords').deleteMany({})
  })

  it('stores a record and retrieves it via lookup (findAll)', async () => {
    const privKey = PrivateKey.fromRandom()
    const lockingScript = buildValidHelloScript(privKey, 'hello world')

    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: 'hwtx0001',
      outputIndex: 0,
      topic: 'tm_helloworld',
      satoshis: 1000,
      lockingScript
    } as OutputAdmittedByTopic)

    const result = await service.lookup({
      service: 'ls_helloworld',
      query: {}
    } as LookupQuestion) as any[]

    expect(result.length).toBe(1)
    expect(result[0].txid).toBe('hwtx0001')
  })

  it('finds a record by message text', async () => {
    const privKey = PrivateKey.fromRandom()
    const lockingScript = buildValidHelloScript(privKey, 'hello world')

    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: 'hwtx0002',
      outputIndex: 0,
      topic: 'tm_helloworld',
      satoshis: 1000,
      lockingScript
    } as OutputAdmittedByTopic)

    const result = await service.lookup({
      service: 'ls_helloworld',
      query: { message: 'hello' }
    } as LookupQuestion) as any[]

    expect(result.length).toBeGreaterThan(0)
    expect(result[0].txid).toBe('hwtx0002')
  })

  it('removes a record via outputEvicted', async () => {
    const privKey = PrivateKey.fromRandom()
    const lockingScript = buildValidHelloScript(privKey, 'to be evicted')

    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: 'hwtx0003',
      outputIndex: 0,
      topic: 'tm_helloworld',
      satoshis: 1000,
      lockingScript
    } as OutputAdmittedByTopic)

    // Confirm stored
    const before = await service.lookup({
      service: 'ls_helloworld',
      query: {}
    } as LookupQuestion) as any[]
    expect(before.length).toBe(1)

    await service.outputEvicted('hwtx0003', 0)

    const after = await service.lookup({
      service: 'ls_helloworld',
      query: {}
    } as LookupQuestion) as any[]
    expect(after).toHaveLength(0)
  })

  it('ignores outputAdmittedByTopic for a different topic', async () => {
    const privKey = PrivateKey.fromRandom()
    const lockingScript = buildValidHelloScript(privKey, 'hello')

    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: 'hwtx0004',
      outputIndex: 0,
      topic: 'tm_other',
      satoshis: 1000,
      lockingScript
    } as OutputAdmittedByTopic)

    const result = await service.lookup({
      service: 'ls_helloworld',
      query: {}
    } as LookupQuestion) as any[]
    expect(result).toHaveLength(0)
  })

  it('throws on unsupported service', async () => {
    await expect(service.lookup({
      service: 'ls_unknown',
      query: {}
    } as LookupQuestion)).rejects.toThrow('Lookup service not supported!')
  })
})
