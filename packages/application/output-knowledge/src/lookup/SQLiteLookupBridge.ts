import type { DatabaseSync } from 'node:sqlite'
import type { LookupIndexHead } from './LookupIndexStorage.js'

/** Internal connection capability shared only by the concrete SQLite companions. */
export const sqliteLookupBridge = Symbol('SQLite lookup transaction bridge')
export interface SQLiteLookupBridge {
  database: DatabaseSync
  namespace: string
  transaction<T>(work: () => T): T
  /** Optional on legacy bridges that do not own staged caches. */
  savepoint?<T>(work: () => T): T
  /** Both operations run inside the caller's existing transaction. */
  head(): LookupIndexHead
  retainSnapshot(key: string, watermark: string, replayUntil: string): void
}
