import knexFactory, { type Knex } from 'knex'
import { up as createPermissionTables } from '../2025-01-31-001-notification-permissions.js'
import {
  down as removeNormalizedScope,
  up as addNormalizedScope
} from '../2026-07-26-001-message-permission-scope.js'

describe('message permission scope migration', () => {
  let database: Knex

  beforeEach(async () => {
    database = knexFactory({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await createPermissionTables(database)
  })

  afterEach(async () => {
    await database.destroy()
  })

  it('deduplicates NULL senders and enforces one normalized box-wide scope', async () => {
    await database('message_permissions').insert([
      {
        recipient: 'recipient',
        sender: null,
        message_box: 'inbox',
        recipient_fee: 0,
        updated_at: new Date('2026-01-01')
      },
      {
        recipient: 'recipient',
        sender: null,
        message_box: 'inbox',
        recipient_fee: 10,
        updated_at: new Date('2026-02-01')
      }
    ])

    await addNormalizedScope(database)

    await expect(
      database('message_permissions').insert({
        recipient: 'recipient',
        sender: null,
        sender_scope: '',
        message_box: 'inbox',
        recipient_fee: 0
      })
    ).rejects.toThrow()

    const rows = await database('message_permissions').select('recipient_fee', 'sender_scope')
    expect(rows).toEqual([{ recipient_fee: 10, sender_scope: '' }])
  })

  it('is reversible', async () => {
    await addNormalizedScope(database)
    await removeNormalizedScope(database)

    expect(await database.schema.hasColumn('message_permissions', 'sender_scope')).toBe(false)
  })
})
