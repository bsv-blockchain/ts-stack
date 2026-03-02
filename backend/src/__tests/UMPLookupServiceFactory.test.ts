import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { MongoClient, Db } from 'mongodb'
import UMPLookupServiceFactory from '../lookup-services/UMPLookupServiceFactory.js'
import { Utils, PrivateKey, LockingScript } from '@bsv/sdk'
import type { UMPRecord } from '../types.js'

// Builds a PushDrop-formatted locking script without needing a real wallet
function buildPushDropScript(fields: number[][]): LockingScript {
  const pubKeyBytes = PrivateKey.fromRandom().toPublicKey().toDER() as number[]

  const encodeChunk = (data: number[]): { op: number; data?: number[] } => {
    if (data.length === 0) return { op: 0 }
    if (data.length === 1 && data[0] === 0) return { op: 0 }
    if (data.length === 1 && data[0] > 0 && data[0] <= 16) return { op: 0x50 + data[0] }
    if (data.length === 1 && data[0] === 0x81) return { op: 0x4f }
    if (data.length <= 75) return { op: data.length, data }
    if (data.length <= 255) return { op: 0x4c, data }
    return { op: 0x4d, data }
  }

  const chunks: { op: number; data?: number[] }[] = [
    { op: pubKeyBytes.length, data: pubKeyBytes },
    { op: 0xac } // OP_CHECKSIG
  ]

  for (const field of fields) chunks.push(encodeChunk(field))

  let notYetDropped = fields.length
  while (notYetDropped > 1) { chunks.push({ op: 0x6d }); notYetDropped -= 2 } // OP_2DROP
  if (notYetDropped !== 0) chunks.push({ op: 0x75 }) // OP_DROP

  return new LockingScript(chunks)
}

describe('UMPLookupService', () => {
  let mongod: MongoMemoryServer
  let client: MongoClient
  let db: Db
  let service: ReturnType<typeof UMPLookupServiceFactory>

  beforeEach(async () => {
    mongod = await MongoMemoryServer.create()
    const uri = mongod.getUri()
    client = new MongoClient(uri)
    await client.connect()
    db = client.db('test')
    service = UMPLookupServiceFactory(db)
  })

  afterEach(async () => {
    await client.close()
    await mongod.stop()
  })

  // Helper to create core UMP fields
  const createCoreFields = (): number[][] => {
    return [
      Utils.toArray('salt123', 'utf8'),                    // 0
      Utils.toArray('pp1', 'utf8'),                        // 1
      Utils.toArray('pr1', 'utf8'),                        // 2
      Utils.toArray('rp1', 'utf8'),                        // 3
      Utils.toArray('pp2', 'utf8'),                        // 4
      Utils.toArray('rp2', 'utf8'),                        // 5
      Utils.toArray('presentationHash123', 'utf8'),        // 6
      Utils.toArray('recoveryHash456', 'utf8'),            // 7
      Utils.toArray('pke', 'utf8'),                        // 8
      Utils.toArray('pwke', 'utf8'),                       // 9
      Utils.toArray('rke', 'utf8')                         // 10
    ]
  }

  describe('Legacy Token Storage', () => {
    it('should store legacy token record', async () => {
      const fields = createCoreFields()
      const lockingScript = buildPushDropScript(fields)

      await service.outputAdmittedByTopic({
        mode: 'locking-script',
        txid: 'abc123',
        outputIndex: 0,
        topic: 'tm_users',
        satoshis: 1,
        lockingScript
      })

      const collection = db.collection<UMPRecord>('ump')
      const record = await collection.findOne({ txid: 'abc123' })

      expect(record).toBeTruthy()
      expect(record!.txid).toBe('abc123')
      expect(record!.outputIndex).toBe(0)
      expect(record!.presentationHash).toBe(Utils.toHex(fields[6]))
      expect(record!.recoveryHash).toBe(Utils.toHex(fields[7]))
      expect(record!.umpVersion).toBeUndefined()
      expect(record!.kdfAlgorithm).toBeUndefined()
    })

    it('should store legacy token with profiles', async () => {
      const fields = createCoreFields()
      fields.push(Utils.toArray('encrypted profiles data', 'utf8')) // field 11

      const lockingScript = buildPushDropScript(fields)

      await service.outputAdmittedByTopic({
        mode: 'locking-script',
        txid: 'def456',
        outputIndex: 1,
        topic: 'tm_users',
        satoshis: 1,
        lockingScript
      })

      const collection = db.collection<UMPRecord>('ump')
      const record = await collection.findOne({ txid: 'def456' })

      expect(record).toBeTruthy()
      expect(record!.umpVersion).toBeUndefined() // Still legacy (no v3 fields)
    })
  })

  describe('Version 3 Token Storage', () => {
    it('should store v3 token with Argon2id metadata', async () => {
      const fields = createCoreFields()
      fields.push(Utils.toArray('profiles', 'utf8')) // field 11
      fields.push([3]) // field 12: umpVersion
      fields.push(Utils.toArray('argon2id', 'utf8')) // field 13: kdfAlgorithm
      const kdfParams = JSON.stringify({
        iterations: 7,
        memoryKiB: 131072,
        parallelism: 1,
        hashLength: 32
      })
      fields.push(Utils.toArray(kdfParams, 'utf8')) // field 14: kdfParams

      const lockingScript = buildPushDropScript(fields)

      await service.outputAdmittedByTopic({
        mode: 'locking-script',
        txid: 'v3token123',
        outputIndex: 0,
        topic: 'tm_users',
        satoshis: 1,
        lockingScript
      })

      const collection = db.collection<UMPRecord>('ump')
      const record = await collection.findOne({ txid: 'v3token123' })

      expect(record).toBeTruthy()
      expect(record!.umpVersion).toBe(3)
      expect(record!.kdfAlgorithm).toBe('argon2id')
      expect(record!.kdfIterations).toBe(7)
    })

    it('should store v3 token with PBKDF2 metadata', async () => {
      const fields = createCoreFields()
      fields.push([3]) // No profiles
      fields.push(Utils.toArray('pbkdf2-sha512', 'utf8'))
      fields.push(Utils.toArray(JSON.stringify({ iterations: 7777 }), 'utf8'))

      const lockingScript = buildPushDropScript(fields)

      await service.outputAdmittedByTopic({
        mode: 'locking-script',
        txid: 'v3pbkdf2',
        outputIndex: 0,
        topic: 'tm_users',
        satoshis: 1,
        lockingScript
      })

      const collection = db.collection<UMPRecord>('ump')
      const record = await collection.findOne({ txid: 'v3pbkdf2' })

      expect(record).toBeTruthy()
      expect(record!.umpVersion).toBe(3)
      expect(record!.kdfAlgorithm).toBe('pbkdf2-sha512')
      expect(record!.kdfIterations).toBe(7777)
    })

    it('should handle malformed kdfParams gracefully', async () => {
      const fields = createCoreFields()
      fields.push([3])
      fields.push(Utils.toArray('argon2id', 'utf8'))
      fields.push(Utils.toArray('invalid json', 'utf8'))

      const lockingScript = buildPushDropScript(fields)

      await service.outputAdmittedByTopic({
        mode: 'locking-script',
        txid: 'malformed',
        outputIndex: 0,
        topic: 'tm_users',
        satoshis: 1,
        lockingScript
      })

      const collection = db.collection<UMPRecord>('ump')
      const record = await collection.findOne({ txid: 'malformed' })

      expect(record).toBeTruthy()
      expect(record!.umpVersion).toBe(3)
      expect(record!.kdfAlgorithm).toBe('argon2id')
      expect(record!.kdfIterations).toBeUndefined() // Failed to parse
    })
  })

  describe('Lookup Queries', () => {
    beforeEach(async () => {
      // Insert test records
      const collection = db.collection<UMPRecord>('ump')
      await collection.insertMany([
        {
          txid: 'legacy1',
          outputIndex: 0,
          presentationHash: 'aabbcc',
          recoveryHash: 'ddeeff'
        },
        {
          txid: 'v3token1',
          outputIndex: 0,
          presentationHash: '112233',
          recoveryHash: '445566',
          umpVersion: 3,
          kdfAlgorithm: 'argon2id',
          kdfIterations: 7
        }
      ])
    })

    it('should query by presentationHash', async () => {
      const result = await service.lookup({
        query: { presentationHash: 'aabbcc' }
      })

      expect(result).toHaveLength(1)
      expect(result[0].txid).toBe('legacy1')
      expect(result[0].outputIndex).toBe(0)
    })

    it('should query by recoveryHash', async () => {
      const result = await service.lookup({
        query: { recoveryHash: '445566' }
      })

      expect(result).toHaveLength(1)
      expect(result[0].txid).toBe('v3token1')
    })

    it('should query by outpoint', async () => {
      const result = await service.lookup({
        query: { outpoint: 'legacy1.0' }
      })

      expect(result).toHaveLength(1)
      expect(result[0].txid).toBe('legacy1')
    })

    it('should return empty array for non-existent query', async () => {
      const result = await service.lookup({
        query: { presentationHash: 'nonexistent' }
      })

      expect(result).toEqual([])
    })

    it('should throw error for missing query', async () => {
      await expect(service.lookup({})).rejects.toThrow('Lookup must include a valid query')
    })

    it('should throw error for invalid query parameters', async () => {
      await expect(
        service.lookup({ query: { invalidParam: 'test' } })
      ).rejects.toThrow('Query parameters must include')
    })

    it('should return newest record when multiple exist', async () => {
      const collection = db.collection<UMPRecord>('ump')
      await collection.insertMany([
        {
          txid: 'old',
          outputIndex: 0,
          presentationHash: 'same',
          recoveryHash: 'hash1'
        },
        {
          txid: 'new',
          outputIndex: 0,
          presentationHash: 'same',
          recoveryHash: 'hash2'
        }
      ])

      const result = await service.lookup({
        query: { presentationHash: 'same' }
      })

      expect(result).toHaveLength(1)
      expect(result[0].txid).toBe('new') // Newest by _id
    })
  })

  describe('Output Management', () => {
    it('should delete record on outputSpent', async () => {
      const collection = db.collection<UMPRecord>('ump')
      await collection.insertOne({
        txid: 'toSpend',
        outputIndex: 0,
        presentationHash: 'hash',
        recoveryHash: 'hash2'
      })

      await service.outputSpent({
        mode: 'none',
        topic: 'tm_users',
        txid: 'toSpend',
        outputIndex: 0
      })

      const record = await collection.findOne({ txid: 'toSpend' })
      expect(record).toBeNull()
    })

    it('should delete record on outputEvicted', async () => {
      const collection = db.collection<UMPRecord>('ump')
      await collection.insertOne({
        txid: 'toEvict',
        outputIndex: 0,
        presentationHash: 'hash',
        recoveryHash: 'hash2'
      })

      await service.outputEvicted('toEvict', 0)

      const record = await collection.findOne({ txid: 'toEvict' })
      expect(record).toBeNull()
    })
  })

  describe('Metadata', () => {
    it('should return correct metadata', async () => {
      const metadata = await service.getMetaData()

      expect(metadata.name).toBe('UMP Lookup Service')
      expect(metadata.shortDescription).toBe('Lookup Service for User Management Protocol tokens')
    })

    it('should return documentation', async () => {
      const docs = await service.getDocumentation()

      expect(docs).toContain('User Management Protocol')
      expect(docs).toContain('presentationHash')
      expect(docs).toContain('recoveryHash')
    })
  })
})
