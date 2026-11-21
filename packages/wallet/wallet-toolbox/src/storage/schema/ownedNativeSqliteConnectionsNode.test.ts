import type { Knex } from 'knex'
import {
  ownedNativeRootIdentity,
  createOwnedNativeReadDatabase,
  assertOwnedNativeConnection,
  isClosedOwnedNativeConnection,
  nativeOwnedRootCloseState
} from './ownedNativeSqliteConnectionsNode'

test('copied class/config/root/closed flags establish neither a root, connection nor close result', () => {
  const root = Object.assign(() => {}, {
      client: {
        config: { client: class OwnedNativeSqliteClient {}, connection: { filename: '/unowned/wallet.sqlite' } },
        dialect: 'sqlite3'
      },
      isTransaction: false
    }) as unknown as Knex,
    connection = { slot: 0, closed: true, open: false, token: {} }
  expect(ownedNativeRootIdentity(root)).toBeUndefined()
  expect(nativeOwnedRootCloseState(root)).toBeUndefined()
  expect(() => createOwnedNativeReadDatabase(root)).toThrow('actual currently owned')
  expect(() => assertOwnedNativeConnection(root, connection)).toThrow(
    'Native SQL requires the current physical lease of this database'
  )
  expect(isClosedOwnedNativeConnection(connection)).toBe(false)
  expect(isClosedOwnedNativeConnection(undefined)).toBe(false)
})
