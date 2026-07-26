import knexFactory, { type Knex } from 'knex'
import {
  down as removeListQueryIndexes,
  up as addListQueryIndexes
} from '../2026-07-26-002-list-query-indexes.js'

async function indexNames(database: Knex, table: string): Promise<string[]> {
  const result = await database.raw(`PRAGMA index_list("${table}")`)
  return result.map((index: { name: string }) => index.name)
}

describe('list query indexes migration', () => {
  let database: Knex

  beforeEach(async () => {
    database = knexFactory({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true
    })
    await database.schema.createTable('messages', table => {
      table.string('messageId').primary()
      table.string('recipient').notNullable()
      table.integer('messageBoxId').notNullable()
      table.timestamp('created_at').notNullable()
    })
    await database.schema.createTable('device_registrations', table => {
      table.increments('id').primary()
      table.string('identity_key').notNullable()
      table.timestamp('updated_at').notNullable()
    })
  })

  afterEach(async () => {
    await database.destroy()
  })

  it('adds and reverses the indexes used by bounded list endpoints', async () => {
    await addListQueryIndexes(database)

    await expect(indexNames(database, 'messages')).resolves.toContain(
      'messages_recipient_box_page_index'
    )
    await expect(indexNames(database, 'device_registrations')).resolves.toContain(
      'device_registrations_identity_updated_index'
    )

    await removeListQueryIndexes(database)

    await expect(indexNames(database, 'messages')).resolves.not.toContain(
      'messages_recipient_box_page_index'
    )
    await expect(indexNames(database, 'device_registrations')).resolves.not.toContain(
      'device_registrations_identity_updated_index'
    )
  })
})
