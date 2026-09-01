import { knex as makeKnex, type Knex } from 'knex'
import {
  defaultPreparedBeefPolicy,
  validatePreparedBeefPolicy
} from '../preparedBeef'
import {
  KnexMigrations,
  PREPARED_BEEF_MIGRATION
} from '../../schema/KnexMigrations'

describe('prepared BEEF policy', () => {
  test('is fully disabled by default', () => {
    expect(defaultPreparedBeefPolicy()).toMatchObject({
      readEnabled: false,
      writeEnabled: false,
      backfillEnabled: false
    })
  })

  test('normalizes rollout controls and rejects unsafe values', () => {
    expect(validatePreparedBeefPolicy({
      readEnabled: true,
      writeEnabled: true,
      backfillEnabled: true,
      maxQueueSize: 7,
      maxArtifactBytes: 1234,
      backfillBatchSize: 3,
      backfillIntervalMs: 25
    })).toMatchObject({
      readEnabled: true,
      writeEnabled: true,
      backfillEnabled: true,
      maxQueueSize: 7,
      maxArtifactBytes: 1234,
      backfillBatchSize: 3,
      backfillIntervalMs: 25
    })
    expect(() => validatePreparedBeefPolicy({ backfillEnabled: true })).toThrow('writeEnabled')
    expect(() => validatePreparedBeefPolicy({ maxQueueSize: 0 })).toThrow('maxQueueSize')
    expect(() => validatePreparedBeefPolicy({ maxArtifactBytes: 1.5 })).toThrow('maxArtifactBytes')
    expect(() => validatePreparedBeefPolicy({ backfillIntervalMs: -1 })).toThrow('backfillIntervalMs')
  })
})

describe('prepared BEEF migration', () => {
  let database: Knex

  beforeEach(async () => {
    database = makeKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await database.schema.createTable('users', table => {
      table.increments('userId').notNullable()
    })
  })

  afterEach(async () => {
    await database.destroy()
  })

  test('creates a user-scoped, versioned artifact store and rolls it back', async () => {
    const migrations = new KnexMigrations('test', 'prepared BEEF tests', '1'.repeat(64), 1024)
    const migration = await migrations.getMigration(PREPARED_BEEF_MIGRATION)
    await migration.up(database)

    await expect(database.schema.hasTable('prepared_beefs')).resolves.toBe(true)
    await expect(database.schema.hasTable('prepared_beef_metadata')).resolves.toBe(true)
    await expect(database('prepared_beef_metadata').first()).resolves.toMatchObject({
      preparedBeefMetadataId: 1,
      proofEpoch: 0
    })
    const [userId] = await database('users').insert({})
    const artifact = {
      userId,
      rootTxid: 'a'.repeat(64),
      beef: Buffer.from([1, 2, 3]),
      checksum: 'b'.repeat(64),
      formatVersion: 1,
      state: 'ready',
      txCount: 1,
      bumpCount: 0,
      byteLength: 3
    }
    await database('prepared_beefs').insert(artifact)
    await expect(database('prepared_beefs').insert(artifact)).rejects.toMatchObject({
      code: 'SQLITE_CONSTRAINT_UNIQUE'
    })

    await migration.down?.(database)
    await expect(database.schema.hasTable('prepared_beefs')).resolves.toBe(false)
    await expect(database.schema.hasTable('prepared_beef_metadata')).resolves.toBe(false)
  })
})
