import { GroupMessagingError } from '../../errors.js'
import type { StorageBackend, StorageTable } from '../backend.js'

export type SqlBindValue = string | number | null | boolean | Uint8Array

export interface SqlRunResult {
  changes: number
  lastInsertRowId: number
}

/**
 * The database surface this backend needs.
 *
 * Deliberately a structural subset of the `SqlDriver` in Nexus's
 * `@nexus/wallet-storage`, so that package's expo-sqlite and node:sqlite
 * drivers satisfy it as-is. Opening is not on the interface for the same
 * reason it is not on theirs: a database name means different things to
 * different hosts, so the host opens and the library borrows.
 */
export interface SqlDriver {
  execAsync(sql: string): Promise<void>
  runAsync(sql: string, params?: SqlBindValue[]): Promise<SqlRunResult>
  getAllAsync<T = unknown>(sql: string, params?: SqlBindValue[]): Promise<T[]>
  getFirstAsync<T = unknown>(sql: string, params?: SqlBindValue[]): Promise<T | null>
}

export interface SqlStorageOptions {
  /** Table name. Override only to run two clients against one database. */
  tableName?: string
}

export const DEFAULT_TABLE_NAME = 'group_messaging_store'

/**
 * A backend over a SQL database the host already owns.
 *
 * One table holds all three namespaces, keyed by `(namespace, key)`. A single
 * table rather than three keeps `init` to one statement and means a host
 * granting the library access grants it exactly one object.
 *
 * The table name is interpolated rather than bound because SQL does not permit
 * binding identifiers; it is validated on construction instead.
 */
export class SqlStorageBackend implements StorageBackend {
  private readonly tableName: string

  constructor(
    private readonly driver: SqlDriver,
    options: SqlStorageOptions = {}
  ) {
    this.tableName = options.tableName ?? DEFAULT_TABLE_NAME
    if (!/^[A-Za-z_]\w*$/.test(this.tableName)) {
      throw new GroupMessagingError(`Unsafe table name: ${this.tableName}`)
    }
  }

  async init(): Promise<void> {
    await this.driver.execAsync(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value BLOB NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
      CREATE INDEX IF NOT EXISTS idx_${this.tableName}_namespace
        ON ${this.tableName}(namespace);
    `)
  }

  async get(table: StorageTable, key: string): Promise<Uint8Array | undefined> {
    const row = await this.driver.getFirstAsync<{ value: unknown }>(
      `SELECT value FROM ${this.tableName} WHERE namespace = ? AND key = ?`,
      [table, key]
    )
    return row == null ? undefined : toBytes(row.value)
  }

  async set(table: StorageTable, key: string, value: Uint8Array): Promise<void> {
    await this.driver.runAsync(
      `INSERT INTO ${this.tableName} (namespace, key, value, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [table, key, value.slice(), new Date().toISOString()]
    )
  }

  async delete(table: StorageTable, key: string): Promise<void> {
    await this.driver.runAsync(`DELETE FROM ${this.tableName} WHERE namespace = ? AND key = ?`, [
      table,
      key
    ])
  }

  async keys(table: StorageTable): Promise<string[]> {
    const rows = await this.driver.getAllAsync<{ key: string }>(
      `SELECT key FROM ${this.tableName} WHERE namespace = ? ORDER BY key`,
      [table]
    )
    return rows.map(row => row.key)
  }
}

/**
 * SQLite drivers disagree about what a BLOB comes back as: expo-sqlite and
 * node:sqlite both yield `Uint8Array`, but a driver over a wire protocol may
 * hand back an `ArrayBuffer` or a plain array of octets.
 */
const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  throw new GroupMessagingError(`Stored value is not binary: ${typeof value}`)
}
