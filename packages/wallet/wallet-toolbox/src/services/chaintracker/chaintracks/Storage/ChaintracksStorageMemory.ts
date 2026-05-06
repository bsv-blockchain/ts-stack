import { ChaintracksStorageKnexOptions } from './ChaintracksStorageKnex'

export interface ChaintracksStorageMemoryOptions extends ChaintracksStorageKnexOptions {
  sqliteClient: 'sqlite3' | 'better-sqlite3' | undefined
}
