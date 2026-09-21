import { DatabaseSync } from 'node:sqlite'
import type { SqlBindValue, SqlDriver, SqlRunResult } from '../backends/sql.js'

/**
 * A `SqlDriver` over `node:sqlite`, for tests.
 *
 * Mirrors the shape of Nexus's own node driver, including the two
 * incompatibilities that matter: `node:sqlite` spells the insert id
 * `lastInsertRowid` where expo spells it `lastInsertRowId`, and it binds
 * anonymous parameters variadically rather than as an array.
 */
export const nodeSqliteDriver = (path = ':memory:'): SqlDriver => {
  const db = new DatabaseSync(path)
  return {
    async execAsync(sql: string): Promise<void> {
      db.exec(sql)
    },
    async runAsync(sql: string, params: SqlBindValue[] = []): Promise<SqlRunResult> {
      const result = db.prepare(sql).run(...bind(params))
      return {
        changes: Number(result.changes),
        lastInsertRowId: Number(result.lastInsertRowid)
      }
    },
    async getAllAsync<T>(sql: string, params: SqlBindValue[] = []): Promise<T[]> {
      return db.prepare(sql).all(...bind(params)) as T[]
    },
    async getFirstAsync<T>(sql: string, params: SqlBindValue[] = []): Promise<T | null> {
      return (db.prepare(sql).get(...bind(params)) as T | undefined) ?? null
    }
  }
}

const bind = (params: SqlBindValue[]): Array<string | number | null | Uint8Array> =>
  params.map(value => (typeof value === 'boolean' ? (value ? 1 : 0) : value))
