import type { Knex } from 'knex'

/** Producer membership only. Genuine root/transaction identity AND current
 * private/published owner are evaluated each call, before any SQL. Source,
 * physical backend, profile, schema, primary, receipt and lifetime remain the
 * enclosing operation's independent current checks; no verdict is cached. */
export function isOwnedNativeSqlite(k: Knex): boolean {
  if (typeof k.client.config.client !== 'function') return false
  const privateRuntime = require('../portable/KnexBrc38StagingStore') as {
    isBrc38OwnedPrivateNativeSqlite: (database: Knex) => boolean
  }
  if (privateRuntime.isBrc38OwnedPrivateNativeSqlite(k)) return true
  const publishedRuntime = require('../portable/Brc38PublishedProfileNode') as {
    isBrc38OwnedPublishedNativeSqlite: (database: Knex) => boolean
  }
  if (publishedRuntime.isBrc38OwnedPublishedNativeSqlite(k)) return true
  // Retired recovery enrolls only its currently retained readonly slot3
  // transaction. It creates no provider/root/writer membership. SQL dialect
  // and schema readers may inspect it; the native kernel denies every write.
  const retiredRuntime = require('../portable/Brc38RetiredNativeReadNode') as {
    Brc38RetiredNativeReadNode: { isReadTransaction(transaction: Knex.Transaction): boolean }
  }
  return k.isTransaction === true && retiredRuntime.Brc38RetiredNativeReadNode.isReadTransaction(k as Knex.Transaction)
}
