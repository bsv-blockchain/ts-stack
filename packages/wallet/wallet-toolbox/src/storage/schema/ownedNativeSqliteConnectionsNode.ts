import type { Knex } from 'knex'
import { isOwnedNativeSqlite } from './ownedNativeSqliteRuntimeNode'

interface Identity {
  readonly token: object
  readonly slot: number
}
interface Transport {
  nativeDatabaseIdentity(database: Knex): Identity | undefined
  nativeTransactionIdentity(transaction: Knex.Transaction): Identity | undefined
  nativeConnectionIdentity(connection: object): Identity | undefined
  nativeConnectionClosed(connection: object): boolean
  nativeRootCloseState(database: Knex): Readonly<{ closing: boolean; closed: boolean; slot: number }> | undefined
  createOwnedNativeReadDatabase(parent: Knex): Knex
}
function driver(): Transport {
  return require('../portable/NativeProfileSqlite.cjs') as Transport
}
/** Real root/lease identity DATA only. The caller independently rereads the
 * physical backend, current schema/profile/primary and original lifetime. */
export function ownedNativeRootIdentity(database: Knex): Identity | undefined {
  if (!isOwnedNativeSqlite(database)) return undefined
  return database.isTransaction
    ? driver().nativeTransactionIdentity(database as Knex.Transaction)
    : driver().nativeDatabaseIdentity(database)
}
export function createOwnedNativeReadDatabase(database: Knex): Knex {
  if (database.isTransaction || ownedNativeRootIdentity(database)?.slot !== 0)
    throw new Error('An actual currently owned native wallet root is required')
  const reader = driver().createOwnedNativeReadDatabase(database)
  if (ownedNativeRootIdentity(reader)?.slot !== 3) throw new Error('Native reader factory membership differs')
  return reader
}
export function assertOwnedNativeConnection(database: Knex, connection: unknown): void {
  const root = ownedNativeRootIdentity(database),
    lease =
      connection !== null && typeof connection === 'object' ? driver().nativeConnectionIdentity(connection) : undefined
  if (root === undefined || lease === undefined || root.token !== lease.token || root.slot !== lease.slot)
    throw new Error('Native SQL requires the current physical lease of this database')
}
export function isClosedOwnedNativeConnection(connection: unknown): boolean {
  return connection !== null && typeof connection === 'object' && driver().nativeConnectionClosed(connection)
}

/** Cleanup-origin DATA only. Expiry/failed cleanup never re-enrolls a producer;
 * the concrete original pool can still retry its actual awaited drainage. */
export function nativeOwnedRootCloseState(
  database: Knex
): Readonly<{ closing: boolean; closed: boolean; slot: number }> | undefined {
  return driver().nativeRootCloseState(database)
}
