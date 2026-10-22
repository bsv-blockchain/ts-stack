import type { Knex } from 'knex'

/** Node-only extra SQLite producer: actual physical lease, original private
 * owner and active authenticated receiver callback are checked on EVERY call.
 * No class name, dialect, config copy, or earlier schema/backend match grants
 * it. This changes no ordinary client classification and caches no verdict.
 * Lazy code loading avoids a module-initialization cycle with the store's SQL
 * schema readers; the actual guard is evaluated afresh, never memoized. */
export function isOwnedPrivateNativeSqlite(k: Knex): boolean {
  if (typeof k.client.config.client !== 'function') return false
  const actual: {
    isBrc38OwnedPrivateNativeSqlite: (database: Knex) => boolean
  } = require('../portable/KnexBrc38StagingStore')
  return actual.isBrc38OwnedPrivateNativeSqlite(k)
}
