import fc from 'fast-check'
import createKnex, { type Knex } from 'knex'
import {
  installBrc38ImportJournalSchema,
  requireBrc38ImportSqliteTransaction,
  verifyBrc38ImportJournalSchema
} from './Brc38ImportJournalSchema'

const MIN_PROPERTY_RUNS = 300
fc.configureGlobal({
  numRuns: Math.max(MIN_PROPERTY_RUNS, Number(process.env.FAST_CHECK_NUM_RUNS ?? MIN_PROPERTY_RUNS)),
  seed: Number(process.env.FAST_CHECK_SEED ?? 3242026)
})

describe('private journal installation retains SQLite transaction ownership', () => {
  test('nontransaction owners refuse before any query; a real transaction remains idempotent', async () => {
    const db = createKnex({
      client: 'better-sqlite3',
      connection: { filename: ':memory:' },
      useNullAsDefault: true,
      pool: { min: 1, max: 1 }
    })
    try {
      await db.transaction(async trx => {
        await installBrc38ImportJournalSchema(trx)
        const original = await trx('sqlite_schema').select('type', 'name', 'sql').orderBy('name')
        await fc.assert(
          fc.asyncProperty(
            fc.constantFrom('not-function', 'not-transaction', 'other-client'),
            fc.integer({ min: -16, max: 16 }),
            async (kind, nonce) => {
              let queries = 0
              const callable = Object.assign(
                () => {
                  queries++
                  throw new Error('Unexpected query')
                },
                {
                  isTransaction: kind !== 'not-transaction',
                  client: {
                    config: {
                      client: kind === 'other-client' ? `other-${nonce}` : 'better-sqlite3'
                    }
                  },
                  raw: () => {
                    queries++
                    throw new Error('Unexpected raw query')
                  }
                }
              )
              const rejected = (kind === 'not-function' ? { ...callable } : callable) as unknown as Knex.Transaction
              expect(() => requireBrc38ImportSqliteTransaction(rejected)).toThrow('actual SQLite transaction')
              await expect(installBrc38ImportJournalSchema(rejected)).rejects.toThrow('actual SQLite transaction')
              await expect(verifyBrc38ImportJournalSchema(rejected)).rejects.toThrow('actual SQLite transaction')
              expect(queries).toBe(0)
              expect(() => requireBrc38ImportSqliteTransaction(trx)).not.toThrow()
              await installBrc38ImportJournalSchema(trx)
              await verifyBrc38ImportJournalSchema(trx)
              expect(await trx('sqlite_schema').select('type', 'name', 'sql').orderBy('name')).toEqual(original)
            }
          ),
          {
            interruptAfterTimeLimit: 150000,
            markInterruptAsFailure: true,
            path: process.env.FAST_CHECK_PATH ?? process.env.FC_PATH ?? ''
          }
        )
      })
    } finally {
      await db.destroy()
    }
  }, 30000)
})
