/**
 * Integration tests for KVStoreTopicManager and KVStoreLookupService.
 *
 * KVStoreTopicManager expects a PushDrop locking script with 5 or 6 fields:
 *   field[0]: protocolID  — JSON WalletProtocol, e.g. '[1,"my-protocol"]'
 *   field[1]: key         — UTF-8 string (non-empty)
 *   field[2]: value       — any bytes (non-empty)
 *   field[3]: controller  — compressed pubkey bytes (33 bytes)
 *   field[4]: tags        — (optional) JSON string[], e.g. '["tag1","tag2"]'
 *   field[5]: signature   — ProtoWallet('anyone') verifySignature result
 *                           signed by the controller wallet with counterparty='anyone'
 *
 * The signature is produced by:
 *   controllerWallet.createSignature({
 *     data: [...field0, ...field1, ...field2, ...field3, ...field4?],
 *     protocolID: parsedProtocolID,
 *     keyID: key (UTF-8 of field[1]),
 *     counterparty: 'anyone'
 *   })
 *
 * kvProtocol indices: { protocolID:0, key:1, value:2, controller:3, tags:4, signature:5 }
 */

import { jest } from '@jest/globals'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import { LockingScript, PrivateKey, PublicKey, Transaction, Utils, ProtoWallet, WalletProtocol } from '@bsv/sdk'
import KVStoreTopicManager from '../kvstore/KVStoreTopicManager.js'
import KVStoreLookupServiceFactory from '../kvstore/KVStoreLookupService.js'
import { KVStoreStorageManager } from '../kvstore/KVStoreStorageManager.js'
import { OutputAdmittedByTopic, LookupQuestion } from '@bsv/overlay'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPushDropScript(pubKey: PublicKey, fields: number[][]): LockingScript {
  const chunks: Array<{ op: number; data?: number[] }> = []

  const pubKeyBytes = Utils.toArray(pubKey.toString(), 'hex')
  chunks.push({ op: pubKeyBytes.length, data: pubKeyBytes })
  chunks.push({ op: 0xac }) // OP_CHECKSIG

  for (const field of fields) {
    if (field.length === 0) {
      chunks.push({ op: 0 })
    } else if (field.length <= 75) {
      chunks.push({ op: field.length, data: field })
    } else if (field.length <= 255) {
      chunks.push({ op: 0x4c, data: field })
    } else {
      chunks.push({ op: 0x4d, data: field })
    }
  }

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

function buildTxWithInput(outputScripts: LockingScript[]): Transaction {
  const sourceTx = new Transaction()
  sourceTx.addOutput({ lockingScript: new LockingScript([]), satoshis: 10000 })

  const tx = new Transaction()
  tx.addInput({
    sourceTransaction: sourceTx,
    sourceOutputIndex: 0,
    unlockingScript: new LockingScript([])
  })

  for (const ls of outputScripts) {
    tx.addOutput({ lockingScript: ls, satoshis: 1000 })
  }

  return tx
}

/**
 * Build a valid KVStore locking script.
 *
 * The controller wallet signs fields[0..3] (and optionally [4]) with counterparty='anyone'.
 * The anyoneWallet.verifySignature uses counterparty=controllerPubKeyHex.
 */
async function buildValidKVStoreScript(
  controllerPrivKey: PrivateKey,
  protocolID: WalletProtocol,
  key: string,
  value: string,
  tags?: string[]
): Promise<{ lockingScript: LockingScript; controllerPubKeyHex: string }> {
  const controllerWallet = new ProtoWallet(controllerPrivKey)
  const controllerPubKeyHex = controllerPrivKey.toPublicKey().toString()
  const controllerPubKeyBytes = Utils.toArray(controllerPubKeyHex, 'hex')

  const protocolIDBytes = Utils.toArray(JSON.stringify(protocolID), 'utf8')
  const keyBytes = Utils.toArray(key, 'utf8')
  const valueBytes = Utils.toArray(value, 'utf8')

  // Build the data fields array (without signature)
  const dataFields: number[][] = [protocolIDBytes, keyBytes, valueBytes, controllerPubKeyBytes]
  if (tags !== undefined) {
    dataFields.push(Utils.toArray(JSON.stringify(tags), 'utf8'))
  }

  // data = concatenation of all data fields
  const data = dataFields.reduce((a, e) => [...a, ...e], [] as number[])

  const { signature } = await controllerWallet.createSignature({
    data,
    protocolID,
    keyID: key,
    counterparty: 'anyone'
  })

  const allFields = [...dataFields, Array.from(signature)]

  // The locking pubkey is derived by anyoneWallet using counterparty=controller
  const anyoneWallet = new ProtoWallet('anyone')
  const { publicKey: lockingPubKeyHex } = await anyoneWallet.getPublicKey({
    protocolID,
    keyID: key,
    counterparty: controllerPubKeyHex
  })
  const lockingPubKey = PublicKey.fromString(lockingPubKeyHex)

  return {
    lockingScript: buildPushDropScript(lockingPubKey, allFields),
    controllerPubKeyHex
  }
}

// ---------------------------------------------------------------------------
// KVStoreTopicManager tests
// ---------------------------------------------------------------------------

describe('KVStoreTopicManager', () => {
  let manager: KVStoreTopicManager

  beforeEach(() => {
    manager = new KVStoreTopicManager()
  })

  it('admits a valid 5-field KVStore PushDrop (no tags)', async () => {
    const controllerPrivKey = PrivateKey.fromRandom()
    const { lockingScript } = await buildValidKVStoreScript(
      controllerPrivKey,
      [1, 'kvstore demo'],
      'mykey',
      'myvalue'
    )
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('admits a valid 6-field KVStore PushDrop (with tags)', async () => {
    const controllerPrivKey = PrivateKey.fromRandom()
    const { lockingScript } = await buildValidKVStoreScript(
      controllerPrivKey,
      [1, 'kvstore tags'],
      'taggedkey',
      'taggedvalue',
      ['alpha', 'beta']
    )
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).toContain(0)
  })

  it('rejects a 3-field PushDrop (missing controller and signature)', async () => {
    const key = PrivateKey.fromRandom()
    const protocolIDBytes = Utils.toArray(JSON.stringify([1, 'myproto']), 'utf8')
    const keyBytes = Utils.toArray('k', 'utf8')
    const valueBytes = Utils.toArray('v', 'utf8')
    // Only 3 fields — neither 4 nor 5 (the expected field counts)
    const lockingScript = buildPushDropScript(key.toPublicKey(), [protocolIDBytes, keyBytes, valueBytes])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a 4-field PushDrop with empty key', async () => {
    const key = PrivateKey.fromRandom()
    const protocolIDBytes = Utils.toArray(JSON.stringify([1, 'myproto']), 'utf8')
    const emptyKey: number[] = [] // empty key — should fail
    const valueBytes = Utils.toArray('v', 'utf8')
    const controllerBytes = Utils.toArray(key.toPublicKey().toString(), 'hex')
    const lockingScript = buildPushDropScript(key.toPublicKey(), [protocolIDBytes, emptyKey, valueBytes, controllerBytes])
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('rejects a P2PKH script (not a PushDrop)', async () => {
    const badScript = new LockingScript([
      { op: 0x76 }, // OP_DUP
      { op: 0xa9 }, // OP_HASH160
      { op: 0x88 }, // OP_EQUALVERIFY
      { op: 0xac }  // OP_CHECKSIG
    ])
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [])
    expect(result.outputsToAdmit).not.toContain(0)
  })

  it('returns previousCoins in coinsToRetain', async () => {
    // Even with no valid outputs, previousCoins should be retained
    const badScript = new LockingScript([{ op: 0x51 }]) // OP_1
    const tx = buildTxWithInput([badScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [42, 7])
    expect(result.coinsToRetain).toEqual([42, 7])
  })

  it('retains previousCoins alongside admitted outputs', async () => {
    const controllerPrivKey = PrivateKey.fromRandom()
    const { lockingScript } = await buildValidKVStoreScript(
      controllerPrivKey,
      [1, 'myproto'],
      'k',
      'v'
    )
    const tx = buildTxWithInput([lockingScript])

    const result = await manager.identifyAdmissibleOutputs(tx.toBEEF(), [99])
    expect(result.outputsToAdmit).toContain(0)
    expect(result.coinsToRetain).toContain(99)
  })

  it('getDocumentation returns a non-empty string', async () => {
    const doc = await manager.getDocumentation()
    expect(typeof doc).toBe('string')
    expect(doc.length).toBeGreaterThan(0)
  })

  it('getMetaData returns expected name', async () => {
    const meta = await manager.getMetaData()
    expect(meta.name).toBe('KVStore Topic Manager')
  })
})

// ---------------------------------------------------------------------------
// KVStoreLookupService tests (with real in-memory MongoDB)
// ---------------------------------------------------------------------------

describe('KVStoreLookupService (MongoDB)', () => {
  let mongod: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let service: ReturnType<typeof KVStoreLookupServiceFactory>

  beforeAll(async () => {
    jest.setTimeout(30000)
    mongod = await MongoMemoryServer.create()
    client = new MongoClient(mongod.getUri())
    await client.connect()
    db = client.db('test_kvstore')
    service = KVStoreLookupServiceFactory(db)
  })

  afterAll(async () => {
    await client.close()
    await mongod.stop()
  })

  afterEach(async () => {
    await db.collection('kvstoreRecords').deleteMany({})
  })

  /**
   * Build a valid KVStore locking script and return it along with the metadata
   * needed to call outputAdmittedByTopic.
   */
  async function storeKVRecord(params: {
    txid: string
    outputIndex: number
    protocolID: WalletProtocol
    key: string
    value: string
    tags?: string[]
  }) {
    const controllerPrivKey = PrivateKey.fromRandom()
    const { lockingScript } = await buildValidKVStoreScript(
      controllerPrivKey,
      params.protocolID,
      params.key,
      params.value,
      params.tags
    )

    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: params.txid,
      outputIndex: params.outputIndex,
      topic: 'tm_kvstore',
      satoshis: 1000,
      lockingScript
    } as OutputAdmittedByTopic)

    return { lockingScript }
  }

  it('stores a record via outputAdmittedByTopic and retrieves it by key', async () => {
    await storeKVRecord({
      txid: 'kv0001',
      outputIndex: 0,
      protocolID: [1, 'kvstore test'],
      key: 'mykey',
      value: 'myvalue'
    })

    const result = await service.lookup({
      service: 'ls_kvstore',
      query: { key: 'mykey' }
    } as LookupQuestion) as any[]

    expect(result.length).toBe(1)
    expect(result[0].txid).toBe('kv0001')
  })

  it('retrieves a record by protocolID filter', async () => {
    await storeKVRecord({
      txid: 'kv0002',
      outputIndex: 0,
      protocolID: [1, 'kvstore filter'],
      key: 'filteredkey',
      value: 'filteredvalue'
    })

    const result = await service.lookup({
      service: 'ls_kvstore',
      query: { protocolID: [1, 'kvstore filter'] }
    } as LookupQuestion) as any[]

    expect(result.length).toBeGreaterThan(0)
    expect(result.some((r: any) => r.txid === 'kv0002')).toBe(true)
  })

  it('retrieves records by tags', async () => {
    await storeKVRecord({
      txid: 'kv0003',
      outputIndex: 0,
      protocolID: [1, 'kvstore tagged'],
      key: 'taggedkey',
      value: 'taggedvalue',
      tags: ['env prod', 'type config']
    })

    const result = await service.lookup({
      service: 'ls_kvstore',
      query: { tags: ['env prod'] }
    } as LookupQuestion) as any[]

    expect(result.length).toBeGreaterThan(0)
    expect(result.some((r: any) => r.txid === 'kv0003')).toBe(true)
  })

  it('ignores outputAdmittedByTopic for a different topic', async () => {
    const controllerPrivKey = PrivateKey.fromRandom()
    const { lockingScript } = await buildValidKVStoreScript(
      controllerPrivKey,
      [1, 'myproto'],
      'key',
      'val'
    )

    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      txid: 'othertopic',
      outputIndex: 0,
      topic: 'tm_other',
      satoshis: 1000,
      lockingScript
    } as OutputAdmittedByTopic)

    const result = await service.lookup({
      service: 'ls_kvstore',
      query: { key: 'key' }
    } as LookupQuestion) as any[]

    expect(result).toHaveLength(0)
  })

  it('removes a record via outputEvicted', async () => {
    await storeKVRecord({
      txid: 'kv0004',
      outputIndex: 0,
      protocolID: [1, 'kvstore evict'],
      key: 'evictedkey',
      value: 'evictedvalue'
    })

    const before = await service.lookup({
      service: 'ls_kvstore',
      query: { key: 'evictedkey' }
    } as LookupQuestion) as any[]
    expect(before.length).toBe(1)

    await service.outputEvicted('kv0004', 0)

    const after = await service.lookup({
      service: 'ls_kvstore',
      query: { key: 'evictedkey' }
    } as LookupQuestion) as any[]
    expect(after).toHaveLength(0)
  })

  it('throws when query has no selector', async () => {
    await expect(service.lookup({
      service: 'ls_kvstore',
      query: {}
    } as LookupQuestion)).rejects.toThrow('Must specify at least one selector')
  })

  it('throws when query is null', async () => {
    await expect(service.lookup({
      service: 'ls_kvstore',
      query: null
    } as any)).rejects.toThrow('A valid query must be provided')
  })

  it('throws for unsupported service', async () => {
    await expect(service.lookup({
      service: 'ls_unknown',
      query: { key: 'k' }
    } as LookupQuestion)).rejects.toThrow('Lookup service not supported')
  })
})
