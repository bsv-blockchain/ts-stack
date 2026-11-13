import type { DatabaseSync } from 'node:sqlite'
import type { LookupSessionOpening } from './LookupSessionCodec.js'
import type { LookupIndexHead } from './LookupIndexStorage.js'

/** Internal connection capability shared only by the concrete SQLite companions. */
export const sqliteLookupBridge = Symbol('SQLite lookup transaction bridge')
export interface SQLiteLookupBridge {
  database: DatabaseSync
  namespace: string
  transaction<T>(work: () => T): T
  /** Optional on legacy bridges that do not own staged caches. */
  savepoint?<T>(work: () => T): T
  /** Optional companion clock, persisted after a failed/successful work savepoint settles. */
  recordClock?(now: string): void
  /** Optional sealed companion profile requirement, checked before retaining a new Open. */
  validateOpening?(opening: LookupSessionOpening): void
  /** Both operations run inside the caller's existing transaction. */
  head(): LookupIndexHead
  retainSnapshot(key: string, watermark: string, replayUntil: string): void
}
