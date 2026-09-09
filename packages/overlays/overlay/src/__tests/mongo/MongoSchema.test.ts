import {
  bootstrapMongoOverlay,
  decodeMongoUint64,
  encodeMongoOutputIndex,
  encodeMongoUint64,
  MongoCollectionDefinitions,
  MongoCollectionNames,
  MongoGridFsBucketName,
  mongoChainKey,
  mongoNodeKey,
  mongoRecordKey
} from '../../storage/mongo/MongoSchema.js'
import { createMongoReplicaFixture, type MongoReplicaFixture } from './MongoReplicaFixture.js'

describe('Mongo schema codecs', () => {
  test('root overlay exports do not include Mongo helpers', async () => {
    const overlay = await import('../../../mod.js')
    expect('bootstrapMongoOverlay' in overlay).toBe(false)
    expect('MongoPayloadStore' in overlay).toBe(false)
    expect('MongoTransactionRunner' in overlay).toBe(false)
    const mongo = await import('../../storage/mongo.js')
    expect(mongo.bootstrapMongoOverlay).toEqual(expect.any(Function))
    expect(mongo.MongoPayloadStore).toEqual(expect.any(Function))
    expect(mongo.MongoReadGuards).toEqual(expect.any(Function))
    expect(mongo.MongoTransactionRunner).toEqual(expect.any(Function))
  })

  test('uses framed values rather than separator-concatenated keys', () => {
    expect(mongoRecordKey('a.b', 'c:d')).toBe('v1|3:a.b|3:c:d')
    expect(mongoRecordKey('a', 'b.c')).not.toBe(mongoRecordKey('a.b', 'c'))
    expect(mongoChainKey({ network: 'test.net', genesisHash: 'a'.repeat(64) })).toContain(
      'test.net'
    )
    expect(
      mongoNodeKey({ network: 'test.net', genesisHash: 'a'.repeat(64), nodeId: 'node.1' })
    ).toContain('node.1')
  })

  test.each(['', 'a\u0000b', 'a'.repeat(1025)])('rejects invalid key component %p', value => {
    expect(() => mongoRecordKey(value)).toThrow('Invalid Mongo record key component')
  })

  test('encodes uint64 in lexically sortable exact form', () => {
    expect(encodeMongoUint64('0')).toBe('00000000000000000000')
    expect(encodeMongoUint64('18446744073709551615')).toBe('18446744073709551615')
    expect(encodeMongoUint64('9') < encodeMongoUint64('10')).toBe(true)
    expect(decodeMongoUint64('00000000000000000009')).toBe('9')
    expect(() => decodeMongoUint64('18446744073709551616')).toThrow('Invalid Mongo uint64')
    expect(() => decodeMongoUint64('9')).toThrow('Invalid Mongo uint64')
  })

  test('keeps output indexes in the wire uint32 domain', () => {
    expect(encodeMongoOutputIndex('9')).toBe('9')
    expect(encodeMongoOutputIndex('50')).toBe('50')
    expect(encodeMongoOutputIndex('4294967295')).toBe('4294967295')
    expect(() => encodeMongoOutputIndex('4294967296')).toThrow('Invalid storage output index')
  })

  test('compares uint32 collection bounds as integers, not lexicographic strings', () => {
    const names = [
      MongoCollectionNames.outputs,
      MongoCollectionNames.consumptionEdges,
      MongoCollectionNames.gaspNodes,
      MongoCollectionNames.shipRecords,
      MongoCollectionNames.slapRecords
    ]
    for (const name of names) {
      const definition = MongoCollectionDefinitions.find(item => item.name === name)
      if (definition === undefined) throw new Error(`Missing schema definition for ${name}`)
      const encoded = JSON.stringify(definition.validator)
      expect(encoded).toContain('$toLong')
      expect(encoded).not.toContain('"$outputIndex","4294967295"')
      expect(encoded).not.toContain('"$sourceOutputIndex","4294967295"')
      expect(encoded).not.toContain('"$consumerOutputIndex","4294967295"')
    }
  })

  test('defines every Overlay-owned collection with strict versioned validators', () => {
    expect(MongoCollectionDefinitions.map(definition => definition.name)).toEqual(
      Object.values(MongoCollectionNames)
    )
    for (const definition of MongoCollectionDefinitions) {
      expect(definition.validator.$and[0].$jsonSchema.additionalProperties).toBe(false)
      expect(definition.validator.$and[0].$jsonSchema.required).toContain('schemaVersion')
      expect(definition.indexes.length).toBeGreaterThan(0)
    }
  })
})

describe('Mongo schema bootstrap', () => {
  let fixture: MongoReplicaFixture

  beforeAll(async () => {
    fixture = await createMongoReplicaFixture()
  }, 90000)

  afterAll(async () => {
    await fixture.close()
  })

  test('creates and revalidates the complete versioned schema on a replica set', async () => {
    await expect(bootstrapMongoOverlay(fixture.db, fixture.scope)).resolves.toMatchObject({
      topology: 'replica-set',
      schemaVersion: 1,
      scope: fixture.scope,
      collections: Object.values(MongoCollectionNames)
    })
    await expect(bootstrapMongoOverlay(fixture.db, fixture.scope)).resolves.toMatchObject({
      topology: 'replica-set',
      schemaVersion: 1
    })
    expect(
      await fixture.db.listCollections({ name: `${MongoGridFsBucketName}.files` }).hasNext()
    ).toBe(true)
    expect(
      await fixture.db.listCollections({ name: `${MongoGridFsBucketName}.chunks` }).hasNext()
    ).toBe(true)
  }, 30000)

  test('refuses an existing collection whose validator is not the Overlay schema', async () => {
    const database = fixture.client.db(`overlay_s02_drift_${Date.now()}`)
    await database.createCollection(MongoCollectionNames.outputs)
    await expect(bootstrapMongoOverlay(database, fixture.scope)).rejects.toThrow(
      `Incompatible Mongo Overlay validator for ${MongoCollectionNames.outputs}`
    )
  })

  test('enforces the uint64 domain in direct payload, operation, output, and history writes', async () => {
    const now = new Date()
    const base = { schemaVersion: 1, ...fixture.scope, createdAt: now, updatedAt: now }
    const chainBase = {
      schemaVersion: 1,
      network: fixture.scope.network,
      genesisHash: fixture.scope.genesisHash,
      createdAt: now,
      updatedAt: now
    }
    const payload = (id: string, byteLength: string, digest: string) => ({
      _id: id,
      ...chainBase,
      kind: 'raw-transaction',
      digest,
      byteLength,
      state: 'uploading',
      guard: 'guard',
      ownerNodeId: fixture.scope.nodeId,
      ownerId: 'owner',
      fencingToken: encodeMongoUint64('0'),
      leaseUntil: now
    })
    await expect(
      fixture.db
        .collection(MongoCollectionNames.payloads)
        .insertOne(payload('payload-invalid', '99999999999999999999', 'aa'.repeat(32)))
    ).rejects.toThrow()
    await fixture.db
      .collection(MongoCollectionNames.payloads)
      .insertMany([
        payload('payload-unsafe-integer', encodeMongoUint64('9007199254740993'), 'ab'.repeat(32)),
        payload('payload-uint64-max', encodeMongoUint64('18446744073709551615'), 'ac'.repeat(32))
      ])
    await expect(
      fixture.db.collection(MongoCollectionNames.submissionOperations).insertOne({
        _id: 'operation-invalid',
        ...base,
        operationId: 'operation-invalid',
        semanticDigest: 'bb'.repeat(32),
        txid: 'cc'.repeat(32),
        state: 'aborted',
        attemptId: '00000000-0000-4000-8000-000000000001',
        leaseOwner: '00000000-0000-4000-8000-000000000002',
        leaseToken: '99999999999999999999',
        leaseUntil: now,
        guard: '00000000-0000-4000-8000-000000000003'
      })
    ).rejects.toThrow()
    await expect(
      fixture.db.collection(MongoCollectionNames.outputs).insertOne({
        _id: 'output-invalid',
        ...base,
        topic: 'topic',
        txid: 'dd'.repeat(32),
        outputIndex: '0',
        satoshis: '99999999999999999999',
        score: encodeMongoUint64('0'),
        scriptPayloadId: 'payload',
        scriptOffset: encodeMongoUint64('0'),
        scriptByteLength: encodeMongoUint64('0'),
        state: 'unspent',
        version: 'version'
      })
    ).rejects.toThrow()
    await expect(
      fixture.db.collection(MongoCollectionNames.topicGenerations).insertOne({
        _id: 'history-invalid',
        ...base,
        topic: 'topic',
        chainEpoch: '99999999999999999999',
        topicHistoryGeneration: encodeMongoUint64('0'),
        policyId: 'policy'
      })
    ).rejects.toThrow()
  })

  test('accepts canonical uint32 output indexes 9 and 4294967295 and rejects 4294967296', async () => {
    const now = new Date()
    const base = { schemaVersion: 1, ...fixture.scope, createdAt: now, updatedAt: now }
    const txid = 'd1'.repeat(32)
    const output = (id: string, outputIndex: string) => ({
      _id: id,
      ...base,
      topic: 'tm_uint32',
      txid,
      outputIndex,
      satoshis: encodeMongoUint64('1'),
      score: encodeMongoUint64('0'),
      scriptPayloadId: 'script',
      scriptOffset: encodeMongoUint64('0'),
      scriptByteLength: encodeMongoUint64('0'),
      state: 'unspent',
      version: 'v1'
    })
    const edge = (
      id: string,
      sourceOutputIndex: string,
      consumerOutputIndex: string,
      consumerTxid: string
    ) => ({
      _id: id,
      ...base,
      topic: 'tm_uint32',
      sourceTxid: txid,
      sourceOutputIndex,
      consumerTxid,
      consumerOutputIndex
    })
    await fixture.db
      .collection(MongoCollectionNames.outputs)
      .insertMany([output('output-index-9', '9'), output('output-index-max', '4294967295')])
    await expect(
      fixture.db
        .collection(MongoCollectionNames.outputs)
        .insertOne(output('output-index-overflow', '4294967296'))
    ).rejects.toThrow()
    await fixture.db.collection(MongoCollectionNames.consumptionEdges).insertMany([
      edge('edge-index-9', '9', '50', 'd2'.repeat(32)),
      edge('edge-index-max', '4294967295', '9', 'd3'.repeat(32))
    ])
    await expect(
      fixture.db
        .collection(MongoCollectionNames.consumptionEdges)
        .insertOne(edge('edge-index-overflow', '4294967296', '0', 'd4'.repeat(32)))
    ).rejects.toThrow()
    await fixture.db.collection(MongoCollectionNames.gaspNodes).insertOne({
      _id: 'gasp-index-9',
      ...base,
      graphId: 'graph-uint32',
      txid,
      outputIndex: '9',
      state: 'receiving'
    })
    await expect(
      fixture.db.collection(MongoCollectionNames.gaspNodes).insertOne({
        _id: 'gasp-index-overflow',
        ...base,
        graphId: 'graph-uint32-overflow',
        txid,
        outputIndex: '4294967296',
        state: 'receiving'
      })
    ).rejects.toThrow()
    for (const name of [MongoCollectionNames.shipRecords, MongoCollectionNames.slapRecords]) {
      await fixture.db.collection(name).insertOne({
        _id: `${name}-index-9`,
        ...base,
        txid,
        outputIndex: '9',
        domain: 'example.com',
        state: 'active'
      })
      await expect(
        fixture.db.collection(name).insertOne({
          _id: `${name}-index-overflow`,
          ...base,
          txid: 'd5'.repeat(32),
          outputIndex: '4294967296',
          domain: 'example.com',
          state: 'active'
        })
      ).rejects.toThrow()
    }
    const ledger = await fixture.db
      .collection(MongoCollectionNames.schema)
      .findOne({ _id: mongoNodeKey(fixture.scope) })
    expect(ledger?.schemaFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(MongoCollectionDefinitions.map(item => item.validator))).toContain(
      '$toLong'
    )
  })

  test('rejects direct documents without required audit dates', async () => {
    await expect(
      fixture.db.collection(MongoCollectionNames.payloads).insertOne({
        _id: 'payload-without-audit-dates',
        schemaVersion: 1,
        network: fixture.scope.network,
        genesisHash: fixture.scope.genesisHash,
        kind: 'raw-transaction',
        digest: 'ef'.repeat(32),
        byteLength: encodeMongoUint64('0'),
        state: 'uploading',
        guard: 'guard',
        ownerNodeId: fixture.scope.nodeId,
        ownerId: 'owner',
        fencingToken: encodeMongoUint64('0'),
        leaseUntil: new Date()
      })
    ).rejects.toThrow()
  })

  test('refuses a ledger whose schema fingerprint is not this Overlay schema', async () => {
    const database = fixture.client.db(`overlay_s02_ledger_${Date.now()}`)
    await bootstrapMongoOverlay(database, fixture.scope)
    await database
      .collection(MongoCollectionNames.schema)
      .updateOne(
        { _id: mongoNodeKey(fixture.scope) },
        { $set: { schemaFingerprint: 'aa'.repeat(32) } }
      )
    await expect(bootstrapMongoOverlay(database, fixture.scope)).rejects.toThrow(
      'Incompatible Mongo Overlay schema ledger'
    )
  })

  test('refuses an existing collection whose collation is not Overlay simple', async () => {
    const definition = MongoCollectionDefinitions.find(
      item => item.name === MongoCollectionNames.outputs
    )
    if (definition === undefined) throw new Error('Missing outputs schema definition')
    const database = fixture.client.db(`overlay_s02_collation_${Date.now()}`)
    await database.createCollection(MongoCollectionNames.outputs, {
      validator: definition.validator,
      validationLevel: 'strict',
      validationAction: 'error',
      collation: { locale: 'en' }
    })
    await expect(bootstrapMongoOverlay(database, fixture.scope)).rejects.toThrow(
      `Incompatible Mongo Overlay validator for ${MongoCollectionNames.outputs}`
    )
  })

  test('rejects a pre-existing partial index whose predicate has drifted', async () => {
    const definition = MongoCollectionDefinitions.find(
      item => item.name === MongoCollectionNames.payloadReferences
    )
    if (definition === undefined) throw new Error('Missing payload reference schema definition')
    const database = fixture.client.db(`overlay_s02_index_drift_${Date.now()}`)
    await database.createCollection(MongoCollectionNames.payloadReferences, {
      validator: definition.validator,
      validationLevel: 'strict',
      validationAction: 'error',
      collation: { locale: 'simple' }
    })
    await database
      .collection(MongoCollectionNames.payloadReferences)
      .createIndex(
        { expiresAt: 1 },
        { name: 'pin_expiry', partialFilterExpression: { ownerKind: 'transaction' } }
      )
    await expect(bootstrapMongoOverlay(database, fixture.scope)).rejects.toThrow(
      `Incompatible Mongo Overlay index for ${MongoCollectionNames.payloadReferences}:pin_expiry`
    )
  })
})
