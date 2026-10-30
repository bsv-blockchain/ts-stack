import Knex from 'knex'
import { _tu } from '../utils/TestUtilsWalletStorage'
import { randomBytesHex } from '../../src/index.client'
import { StorageKnex } from '../../src/storage/StorageKnex'

/**
 * PRAGMA foreign_keys is per connection and ignored inside a transaction.
 * Writes re-enable it outside a transaction and skip it inside one.
 */
describe('SQLite foreign key pragma', () => {
  jest.setTimeout(99999999)

  let storage: StorageKnex
  let knex: ReturnType<typeof Knex>

  beforeAll(async () => {
    const file = await _tu.newTmpFile('sqliteForeignKeyPragma.sqlite', true, false, false)
    // No afterCreate hook: only the storage itself enables foreign keys.
    knex = Knex({ client: 'better-sqlite3', connection: { filename: file }, useNullAsDefault: true, pool: { min: 1, max: 1 } })
    storage = new StorageKnex({
      chain: 'test',
      knex,
      commissionSatoshis: 0,
      commissionPubKeyHex: undefined,
      feeModel: { model: 'sat/kb', value: 1 }
    })
    await storage.migrate('sqliteForeignKeyPragma', randomBytesHex(33))
    await storage.makeAvailable()
  })

  afterAll(async () => {
    await storage.destroy()
  })

  const foreignKeysEnabled = async (): Promise<number> =>
    Number(((await knex.raw('PRAGMA foreign_keys')) as Array<{ foreign_keys: number }>)[0].foreign_keys)

  test('0 a write outside a transaction enables foreign keys', async () => {
    await knex.raw('PRAGMA foreign_keys = OFF')
    expect(await foreignKeysEnabled()).toBe(0)
    await _tu.insertTestUser(storage)
    expect(await foreignKeysEnabled()).toBe(1)
  })

  test('1 a write inside a transaction issues no pragma', async () => {
    const pragmas: string[] = []
    const onQuery = (q: { sql: string }): void => {
      if (/^\s*pragma/i.test(q.sql)) pragmas.push(q.sql)
    }
    knex.on('query', onQuery)
    try {
      await storage.transaction(async trx => {
        const now = new Date()
        const userId = await storage.insertUser(
          {
            created_at: now,
            updated_at: now,
            userId: 0,
            identityKey: randomBytesHex(33),
            activeStorage: storage.getSettings().storageIdentityKey
          },
          trx
        )
        await storage.updateUser(userId, { activeStorage: storage.getSettings().storageIdentityKey }, trx)
      })
    } finally {
      knex.off('query', onQuery)
    }
    expect(pragmas).toEqual([])
  })
})
