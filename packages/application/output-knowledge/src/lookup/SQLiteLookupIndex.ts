import { closeSync, openSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { OutputProtocolError, type OutputJSONObject } from '@bsv/sdk'
import { SQLiteTransactionDomain } from '../storage/SQLiteTransactionDomain.js'
import {
  lookupIndexDefinition,
  SQLiteLookupIndexStore,
  sqliteLookupComposition,
  type SQLiteLookupIndexOptions
} from './SQLiteLookupIndexStore.js'
export type { SQLiteLookupIndexOptions } from './SQLiteLookupIndexStore.js'

/** Node-only WAL/FULL versioned lookup index. Provider sessions and disclosure are separate companions. */
export class SQLiteLookupIndex extends SQLiteLookupIndexStore {
  private constructor(
    path: string,
    namespace: string,
    binding: OutputJSONObject,
    options: SQLiteLookupIndexOptions,
    initialize: boolean
  ) {
    const definition = lookupIndexDefinition(namespace, binding, options)
    if (path === ':memory:' || path.startsWith('file:'))
      throw new OutputProtocolError(
        'invalid',
        'Durable lookup index requires an ordinary file path'
      )
    if (initialize) {
      try {
        closeSync(openSync(path, 'ax', 0o600))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
    } else closeSync(openSync(path, 'r+'))
    const database = new DatabaseSync(path, {
      allowExtension: false,
      enableForeignKeyConstraints: true
    })
    const domain = new SQLiteTransactionDomain(database)
    super(domain, definition)
    try {
      database.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;')
      domain.transaction(() => this[sqliteLookupComposition].initialize(initialize), {
        write: initialize
      })
    } catch (error) {
      domain.close()
      throw error
    }
  }

  /** Initialize only a new index identity; a provider must allocate a fresh serving epoch. */
  static create(
    path: string,
    namespace: string,
    binding: OutputJSONObject,
    options: SQLiteLookupIndexOptions = {}
  ): SQLiteLookupIndex {
    return new SQLiteLookupIndex(path, namespace, binding, options, true)
  }
  /** Missing storage is never recreated as an empty, successfully recovered index. */
  static open(
    path: string,
    namespace: string,
    binding: OutputJSONObject,
    options: SQLiteLookupIndexOptions = {}
  ): SQLiteLookupIndex {
    return new SQLiteLookupIndex(path, namespace, binding, options, false)
  }
}
