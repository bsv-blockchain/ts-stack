import { Db, MongoClient } from 'mongodb'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { LockingScript, PrivateKey, PublicKey, Utils } from '@bsv/sdk'
import { jest } from '@jest/globals'
import {
  InMemoryUMPIdentityStore,
  MongoUMPIdentityStore,
  UMPIdentityConflictError,
  UMPIdentityReservationStore
} from '../ump/UMPIdentityStore.js'
import createUMPLookupService from '../ump/UMPLookupService.js'

const mongoMemoryServerOptions = { instance: { launchTimeout: 60_000 } }

function claim(outpoint: string, presentation = '11'.repeat(32), recovery = '22'.repeat(32)) {
  return { outpoint, presentationHash: presentation, recoveryHash: recovery }
}

function buildPushDropScript(pubKey: PublicKey, fields: number[][]): LockingScript {
  const pubKeyBytes = Utils.toArray(pubKey.toString(), 'hex')
  const chunks: Array<{ op: number; data?: number[] }> = [
    { op: pubKeyBytes.length, data: pubKeyBytes },
    { op: 0xac }
  ]
  for (const field of fields) chunks.push({ op: field.length, data: field })
  let remaining = fields.length
  while (remaining > 1) {
    chunks.push({ op: 0x6d })
    remaining -= 2
  }
  if (remaining === 1) chunks.push({ op: 0x75 })
  return new LockingScript(chunks)
}

function umpScript(presentation = 0x11, recovery = 0x22): LockingScript {
  const fields = Array.from({ length: 11 }, (_, index) => [index + 1])
  fields[6] = Array(32).fill(presentation)
  fields[7] = Array(32).fill(recovery)
  return buildPushDropScript(PrivateKey.fromRandom().toPublicKey(), fields)
}

describe('InMemoryUMPIdentityStore', () => {
  it('validates its TTL and cleans every provisional state transition', async () => {
    expect(() => new InMemoryUMPIdentityStore(0)).toThrow(TypeError)
    expect(() => new InMemoryUMPIdentityStore(1.5)).toThrow(TypeError)

    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000)
    const store = new InMemoryUMPIdentityStore(100)

    await store.reserve(claim('aborted.0'), [])
    await store.abort('aborted.0')
    await store.reserve(claim('owner.0'), [])
    await store.confirm('owner.0')
    await store.reserve(claim('successor.0'), ['owner.0'])
    await store.release('successor.0')
    await store.reserve(claim('successor.0'), ['owner.0'])
    await store.release('owner.0')
    await store.confirm('successor.0')
    await store.release('successor.0')

    await store.reserve(claim('expiring.0'), [])
    now.mockReturnValue(1_101)
    await expect(store.reserve(claim('after-expiry.0'), [])).resolves.toBeUndefined()

    const transferStore = new InMemoryUMPIdentityStore(100)
    await transferStore.reserve(claim('confirmed.0'), [])
    await transferStore.confirm('confirmed.0')
    await transferStore.reserve(claim('expired-successor.0'), ['confirmed.0'])
    now.mockReturnValue(1_202)
    await expect(transferStore.reserve(claim('blocked.0'), [])).rejects.toMatchObject({
      kind: 'presentation'
    })
    now.mockRestore()
  })

  it('reserves first writers, rolls back partial conflicts, transfers consumed owners, and releases', async () => {
    const store = new InMemoryUMPIdentityStore()
    const first = claim('a.0')
    await store.reserve(first, [])
    await store.reserve(first, [])
    await store.confirm('a.0')

    await expect(store.reserve(claim('b.0', '33'.repeat(32)), [])).rejects.toMatchObject({
      kind: 'recovery'
    })
    await expect(store.reserve(claim('c.0'), [])).rejects.toBeInstanceOf(UMPIdentityConflictError)

    // The failed b.0 reservation must not retain its independently acquired
    // presentation hash.
    await expect(
      store.reserve(claim('d.0', '33'.repeat(32), '44'.repeat(32)), [])
    ).resolves.toBeUndefined()

    // If a consumed first hash is transferred before the second hash
    // conflicts, rollback restores the previous owner rather than deleting it.
    await store.reserve(claim('owner-r.0', '55'.repeat(32), '66'.repeat(32)), [])
    await store.confirm('owner-r.0')
    await expect(
      store.reserve(claim('failed-transfer.0', '11'.repeat(32), '66'.repeat(32)), ['a.0'])
    ).rejects.toMatchObject({ kind: 'recovery' })
    await expect(store.reserve(claim('still-conflicts.0'), [])).rejects.toMatchObject({
      kind: 'presentation'
    })

    await expect(store.reserve(claim('e.0'), ['a.0'])).resolves.toBeUndefined()
    await store.abort('e.0')
    await expect(store.reserve(claim('retry.0'), ['a.0'])).resolves.toBeUndefined()
    await store.abort('retry.0')
    await store.reserve(claim('e.0'), ['a.0'])
    await store.confirm('e.0')
    await store.reserve(claim('e.0'), [])
    await store.release('e.0')
    await expect(store.reserve(claim('f.0'), [])).resolves.toBeUndefined()
  })
})

describe('MongoUMPIdentityStore and UMP lookup lifecycle', () => {
  let mongo: MongoMemoryServer
  let client: MongoClient
  let db: Db

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create(mongoMemoryServerOptions)
    client = new MongoClient(mongo.getUri())
    await client.connect()
    db = client.db('ump_identity_test')
  }, 60_000)

  afterAll(async () => {
    await client.close()
    await mongo.stop()
  }, 60_000)

  beforeEach(async () => {
    await db.dropDatabase()
  })

  it('validates the pending TTL', () => {
    expect(() => new MongoUMPIdentityStore(db, 0)).toThrow(TypeError)
    expect(() => new MongoUMPIdentityStore(db, 1.5)).toThrow(TypeError)
    expect(() => new MongoUMPIdentityStore(db, Number.MAX_SAFE_INTEGER + 1)).toThrow(TypeError)
  })

  it('bootstraps first legacy owners and creates operational indexes', async () => {
    await db.collection<any>('ump').insertMany([
      {
        _id: 1,
        txid: 'legacy-a',
        outputIndex: 0,
        presentationHash: '11'.repeat(32),
        recoveryHash: '22'.repeat(32)
      },
      {
        _id: 2,
        txid: 'legacy-b',
        outputIndex: 0,
        presentationHash: '11'.repeat(32),
        recoveryHash: '33'.repeat(32)
      }
    ])
    const store = new MongoUMPIdentityStore(db)

    await expect(store.reserve(claim('new.0'), [])).rejects.toMatchObject({ kind: 'presentation' })
    const presentation = await db.collection<any>('ump_identity_reservations').findOne({
      _id: `presentation:${'11'.repeat(32)}`
    })
    expect(presentation?.ownerOutpoint).toBe('legacy-a.0')
    const indexes = await db.collection('ump_identity_reservations').indexes()
    expect(indexes.map(index => index.name)).toEqual(
      expect.arrayContaining([
        'ump_pending_reservation_expiry',
        'ump_reservation_owner',
        'ump_pending_reservation_owner'
      ])
    )
    await expect(
      db.collection('ump_identity_reservation_migrations').findOne({
        _id: 'legacy-ump-reservations-v1'
      })
    ).resolves.not.toBeNull()
  })

  it('atomically transfers, confirms, expires, rolls back, releases, and reclaims reservations', async () => {
    const store = new MongoUMPIdentityStore(db, 1000)
    const first = claim('a.0')
    await store.reserve(first, [])
    await store.confirm('a.0')
    await store.reserve(first, [])
    expect(
      await db.collection<any>('ump_identity_reservations').countDocuments({
        ownerOutpoint: 'a.0',
        pendingUntil: { $exists: false }
      })
    ).toBe(2)

    await expect(store.reserve(claim('b.0'), [])).rejects.toMatchObject({ kind: 'presentation' })
    await store.reserve(claim('c.0'), ['a.0'])
    expect(
      await db
        .collection<any>('ump_identity_reservations')
        .countDocuments({ ownerOutpoint: 'a.0', pendingOwnerOutpoint: 'c.0' })
    ).toBe(2)

    // A failed PHASE 2 broadcast releases only the provisional successor and
    // leaves the confirmed owner protected for a rebuilt retry.
    await store.abort('c.0')
    expect(
      await db.collection<any>('ump_identity_reservations').countDocuments({
        ownerOutpoint: 'a.0',
        pendingOwnerOutpoint: { $exists: false }
      })
    ).toBe(2)
    await store.reserve(claim('c.0'), ['a.0'])

    // A partial acquisition is removed if the second hash conflicts.
    await expect(store.reserve(claim('d.0', '33'.repeat(32)), [])).rejects.toMatchObject({
      kind: 'recovery'
    })
    expect(
      await db
        .collection<any>('ump_identity_reservations')
        .findOne({ _id: `presentation:${'33'.repeat(32)}` })
    ).toBeNull()

    // A transferred first hash is restored if acquiring the second hash fails.
    await store.reserve(claim('owner-r.0', '44'.repeat(32), '55'.repeat(32)), [])
    await store.confirm('c.0')
    await expect(
      store.reserve(claim('failed-transfer.0', '11'.repeat(32), '55'.repeat(32)), ['c.0'])
    ).rejects.toMatchObject({ kind: 'recovery' })
    expect(
      await db
        .collection<any>('ump_identity_reservations')
        .findOne({ _id: `presentation:${'11'.repeat(32)}` })
    ).toMatchObject({ ownerOutpoint: 'c.0' })

    await db
      .collection<any>('ump_identity_reservations')
      .updateOne(
        { _id: `presentation:${'44'.repeat(32)}` },
        { $set: { pendingUntil: new Date(0) } }
      )
    await expect(
      store.reserve(claim('expired-winner.0', '44'.repeat(32), '66'.repeat(32)), [])
    ).resolves.toBeUndefined()

    await store.release('c.0')
    await expect(store.reserve(claim('replacement.0'), [])).resolves.toBeUndefined()
  })

  it('keeps a confirmed owner protected when an unconfirmed transfer expires', async () => {
    const store = new MongoUMPIdentityStore(db, 1000)
    await store.reserve(claim('owner.0'), [])
    await store.confirm('owner.0')
    await store.reserve(claim('successor.0'), ['owner.0'])
    await db
      .collection('ump_identity_reservations')
      .updateMany(
        { pendingOwnerOutpoint: 'successor.0' },
        { $set: { pendingOwnerUntil: new Date(0) } }
      )

    await expect(store.reserve(claim('attacker.0'), [])).rejects.toMatchObject({
      kind: 'presentation'
    })
    await expect(
      db.collection('ump_identity_reservations').countDocuments({
        ownerOutpoint: 'owner.0'
      })
    ).resolves.toBe(2)
    await expect(
      db.collection('ump_identity_reservations').findOne({
        _id: `presentation:${'11'.repeat(32)}`
      })
    ).resolves.toMatchObject({ ownerOutpoint: 'owner.0' })
  })

  it('retries compare-and-set races while renewing, staging, and replacing claims', async () => {
    const store = new MongoUMPIdentityStore(db, 1000)
    const reservations = (store as any).reservations
    const originalFindOneAndUpdate = reservations.findOneAndUpdate.bind(reservations)
    const loseOneRace = () =>
      jest
        .spyOn(reservations, 'findOneAndUpdate')
        .mockResolvedValueOnce(null)
        .mockImplementation((...args: any[]) => originalFindOneAndUpdate(...args))

    await store.reserve(claim('owner.0'), [])
    let race = loseOneRace()
    await store.reserve(claim('owner.0'), [])
    race.mockRestore()
    await store.confirm('owner.0')

    race = loseOneRace()
    await store.reserve(claim('successor.0'), ['owner.0'])
    race.mockRestore()
    race = loseOneRace()
    await store.reserve(claim('successor.0'), ['owner.0'])
    race.mockRestore()
    await store.release('owner.0')
    await store.confirm('successor.0')

    await store.reserve(claim('expired.0', '33'.repeat(32), '44'.repeat(32)), [])
    await db.collection('ump_identity_reservations').updateMany(
      { ownerOutpoint: 'expired.0' },
      { $set: { pendingUntil: new Date(0) } }
    )
    race = loseOneRace()
    await store.reserve(claim('replacement.0', '33'.repeat(32), '44'.repeat(32)), [])
    race.mockRestore()
  })

  it('retries initialization after a transient failure and skips completed legacy bootstrap work', async () => {
    const store = new MongoUMPIdentityStore(db)
    const originalInitialize = (store as any).initialize.bind(store)
    const initialize = jest
      .spyOn(store as any, 'initialize')
      .mockRejectedValueOnce(new Error('temporary Mongo failure'))
      .mockImplementation(async () => await originalInitialize())

    await expect(store.reserve(claim('first.0'), [])).rejects.toThrow('temporary Mongo failure')
    await expect(store.reserve(claim('first.0'), [])).resolves.toBeUndefined()
    initialize.mockRestore()

    await db.collection('ump').insertOne({
      txid: 'late-legacy',
      outputIndex: 0,
      presentationHash: '77'.repeat(32),
      recoveryHash: '88'.repeat(32)
    })
    const restarted = new MongoUMPIdentityStore(db)
    await restarted.reserve(claim('after-restart.0', '77'.repeat(32), '99'.repeat(32)), [])
    await expect(
      db.collection('ump_identity_reservations').findOne({
        _id: `presentation:${'77'.repeat(32)}`
      })
    ).resolves.toMatchObject({ ownerOutpoint: 'after-restart.0' })
  })

  it('persists, confirms, looks up, spends, and evicts UMP records', async () => {
    const identityStore: UMPIdentityReservationStore = {
      reserve: jest.fn(async () => undefined),
      confirm: jest.fn(async () => undefined),
      abort: jest.fn(async () => undefined),
      release: jest.fn(async () => undefined)
    }
    const service = createUMPLookupService(db, identityStore)
    const lockingScript = umpScript()
    const payload = {
      mode: 'locking-script',
      topic: 'tm_users',
      txid: 'aa',
      outputIndex: 2,
      lockingScript
    } as any

    await expect(service.outputAdmittedByTopic({ ...payload, mode: 'beef' })).rejects.toThrow(
      'Invalid payload'
    )
    await service.outputAdmittedByTopic({ ...payload, topic: 'other' })
    await service.outputAdmittedByTopic(payload)
    expect(identityStore.confirm).toHaveBeenCalledWith('aa.2')
    await expect(
      service.lookup({ query: { presentationHash: '11'.repeat(32) } } as any)
    ).resolves.toEqual([{ txid: 'aa', outputIndex: 2 }])
    await expect(
      service.lookup({ query: { recoveryHash: '22'.repeat(32) } } as any)
    ).resolves.toHaveLength(1)
    await expect(service.lookup({ query: { outpoint: 'aa.2' } } as any)).resolves.toHaveLength(1)
    await expect(service.lookup({} as any)).rejects.toThrow('valid query')
    await expect(service.lookup({ query: {} } as any)).rejects.toThrow('presentationHash')

    await expect(service.outputSpent({ mode: 'locking-script' } as any)).rejects.toThrow(
      'Invalid payload'
    )
    await service.outputSpent({ mode: 'none', topic: 'other' } as any)
    await service.outputSpent({
      mode: 'none',
      topic: 'tm_users',
      txid: 'aa',
      outputIndex: 2
    } as any)
    expect(identityStore.release).toHaveBeenCalledWith('aa.2')

    await service.outputAdmittedByTopic(payload)
    await service.outputEvicted('aa', 2)
    expect(identityStore.release).toHaveBeenLastCalledWith('aa.2')
    await expect(service.getDocumentation()).resolves.toContain('UMP Lookup Service')
    await expect(service.getMetaData()).resolves.toMatchObject({ name: 'UMP Lookup Service' })
  })

  it('stores valid v3 KDF metadata and tolerates malformed metadata JSON', async () => {
    const service = createUMPLookupService(db, {
      reserve: async () => undefined,
      confirm: async () => undefined,
      abort: async () => undefined,
      release: async () => undefined
    })
    const fields = Array.from({ length: 11 }, (_, index) => [index + 1])
    fields[6] = Array(32).fill(0x77)
    fields[7] = Array(32).fill(0x88)
    fields.push([3], Utils.toArray('argon2id', 'utf8'), Utils.toArray('{"iterations":3}', 'utf8'))
    const valid = buildPushDropScript(PrivateKey.fromRandom().toPublicKey(), fields)
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_users',
      txid: 'v3',
      outputIndex: 0,
      lockingScript: valid
    } as any)
    expect(await db.collection('ump').findOne({ txid: 'v3' })).toMatchObject({
      umpVersion: 3,
      kdfAlgorithm: 'argon2id',
      kdfIterations: 3
    })

    fields[13] = Utils.toArray('{bad', 'utf8')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await service.outputAdmittedByTopic({
      mode: 'locking-script',
      topic: 'tm_users',
      txid: 'bad-v3',
      outputIndex: 0,
      lockingScript: buildPushDropScript(PrivateKey.fromRandom().toPublicKey(), fields)
    } as any)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns the newest 100 legacy candidates so a current token is not truncated', async () => {
    const identityStore: UMPIdentityReservationStore = {
      reserve: async () => undefined,
      confirm: async () => undefined,
      abort: async () => undefined,
      release: async () => undefined
    }
    await db.collection('ump').insertMany(
      Array.from({ length: 105 }, (_, index) => ({
        _id: index,
        txid: `tx-${index}`,
        outputIndex: 0,
        presentationHash: 'aa'.repeat(32),
        recoveryHash: `${index}`.padStart(64, '0')
      }))
    )
    const service = createUMPLookupService(db, identityStore)

    const results = await service.lookup({
      query: { presentationHash: 'aa'.repeat(32) }
    } as any)
    expect(results).toHaveLength(100)
    expect(results[0]).toEqual({ txid: 'tx-104', outputIndex: 0 })
    expect(results).not.toContainEqual({ txid: 'tx-0', outputIndex: 0 })
  })
})
