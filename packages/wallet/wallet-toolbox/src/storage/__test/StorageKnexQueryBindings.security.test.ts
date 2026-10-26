import { knex as makeKnex, type Knex } from 'knex'
import { StorageKnex } from '../StorageKnex'
import { StorageMySQLDojoReader } from '../sync/StorageMySQLDojoReader'

const hostileUserId = '0) OR 1 = 1 --' as unknown as number

function expectBoundUserId(query: Knex.QueryBuilder): void {
  const compiled = query.toSQL()
  expect(compiled.sql).not.toContain(hostileUserId as unknown as string)
  expect(compiled.bindings).toContain(hostileUserId)
}

describe('user-scoped synchronization query bindings', () => {
  let knex: Knex

  beforeEach(() => {
    knex = makeKnex({ client: 'better-sqlite3', useNullAsDefault: true })
  })

  afterEach(async () => {
    await knex.destroy()
  })

  test.each([
    'getProvenTxsForUserQuery',
    'getProvenTxReqsForUserQuery',
    'getTxLabelMapsForUserQuery',
    'getOutputTagMapsForUserQuery'
  ] as const)('StorageKnex.%s binds runtime user IDs as values', method => {
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain: 'test',
      knex
    })

    expectBoundUserId(storage[method]({ userId: hostileUserId }))
  })

  test.each([
    'getProvenTxsForUserQuery',
    'getProvenTxReqsForUserQuery',
    'getTxLabelMapsForUserQuery',
    'getOutputTagMapsForUserQuery'
  ] as const)('StorageMySQLDojoReader.%s binds runtime user IDs as values', method => {
    const storage = new StorageMySQLDojoReader({ chain: 'test', knex })

    expectBoundUserId(storage[method]({ userId: hostileUserId }))
  })

  test('findOutputsQuery rejects a runtime transaction-status injection', () => {
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain: 'test',
      knex
    })
    const hostileStatus = "completed') OR 1 = 1 --" as 'completed'

    expect(() => storage.findOutputsQuery({ partial: {}, txStatus: [hostileStatus] })).toThrow('args.txStatus')
  })

  test('findOutputsQuery binds validated transaction statuses', () => {
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain: 'test',
      knex
    })
    const compiled = storage.findOutputsQuery({ partial: {}, txStatus: ['completed', 'sending'] }).toSQL()

    expect(compiled.sql).not.toContain('completed')
    expect(compiled.sql).not.toContain('sending')
    expect(compiled.bindings).toEqual(expect.arrayContaining(['completed', 'sending']))
  })
})
