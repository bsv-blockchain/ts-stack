import type { Knex } from 'knex'
import { isOwnedPrivateNativeSqlite } from './privateNativeSqliteRuntimeNode'
import { requireBrc38ImportSqliteTransaction } from '../portable/Brc38ImportJournalSchema'

/** Counterfeit class/config/dialect must never enroll a physical producer.
 * These refusal cases use no native process, addon, DB, or fabricated lease. */
describe('private native SQLite runtime membership', () => {
  test('an unenrolled class with a copied SQLite config is refused before SQL', () => {
    const sql = jest.fn(() => {
      throw new Error('SQL must not run')
    })
    const database = Object.assign(sql, {
      client: { dialect: 'sqlite3', config: { client: class OwnedNativeSqliteClient {} } },
      isTransaction: true
    }) as unknown as Knex.Transaction
    expect(isOwnedPrivateNativeSqlite(database)).toBe(false)
    expect(() => requireBrc38ImportSqliteTransaction(database)).toThrow('actual SQLite transaction')
    expect(sql).not.toHaveBeenCalled()
  })
  test('plain stock aliases do not acquire private native membership', () => {
    for (const client of ['better-sqlite3', 'sqlite3', 'mysql2']) {
      const database = { client: { config: { client } } } as unknown as Knex
      expect(isOwnedPrivateNativeSqlite(database)).toBe(false)
    }
  })
})
