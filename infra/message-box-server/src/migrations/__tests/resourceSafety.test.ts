import knexFactory, { type Knex } from 'knex'
import { down, up } from '../2026-08-04-001-resource-safety.js'
import { KnexPaymentReplayStore } from '../../security/KnexPaymentReplayStore.js'

describe('Message Box resource safety migration', () => {
  let database: Knex

  beforeEach(async () => {
    database = knexFactory({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await database.schema.createTable('messages', table => {
      table.string('messageId').primary()
      table.string('body').notNullable()
    })
  })

  afterEach(async () => {
    await database.destroy()
  })

  it('creates durable shared-state tables and reverses cleanly', async () => {
    await up(database)
    await expect(database.schema.hasColumn('messages', 'expires_at')).resolves.toBe(true)
    await expect(database.schema.hasTable('message_resource_locks')).resolves.toBe(true)
    await expect(database.schema.hasTable('auth_sessions')).resolves.toBe(true)
    await expect(database.schema.hasTable('payment_replays')).resolves.toBe(true)

    const replayStore = new KnexPaymentReplayStore(database, 1)
    await expect(replayStore.claim('txid')).resolves.toBe(true)
    await expect(replayStore.claim('txid')).resolves.toBe(false)

    await down(database)
    await expect(database.schema.hasColumn('messages', 'expires_at')).resolves.toBe(false)
    await expect(database.schema.hasTable('auth_sessions')).resolves.toBe(false)
  })
})
