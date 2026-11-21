import { isOwnedNativeSqlite } from './ownedNativeSqliteRuntimeNode'
import type { Knex } from 'knex'

test('copied root/client/config/dialect cannot select private or published native SQL adapters', () => {
  const root = Object.assign(() => {}, {
    client: { config: { client: class OwnedNativeSqliteClient {} }, dialect: 'sqlite3' },
    isTransaction: false
  }) as unknown as Knex
  expect(isOwnedNativeSqlite(root)).toBe(false)
  const transaction = Object.assign(() => {}, { client: root.client, isTransaction: true }) as unknown as Knex
  expect(isOwnedNativeSqlite(transaction)).toBe(false)
})
test.each(['sqlite3', 'better-sqlite3', 'mysql2', 'pg'])(
  'ordinary alias %s does not grant owned native membership',
  client => {
    expect(isOwnedNativeSqlite({ client: { config: { client } } } as unknown as Knex)).toBe(false)
  }
)
