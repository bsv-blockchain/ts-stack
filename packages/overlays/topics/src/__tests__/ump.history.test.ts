import { jest } from '@jest/globals'
import type { Db } from 'mongodb'
import type { LookupFormula } from '@bsv/overlay'
import createUMPLookupService from '../ump/UMPLookupService.js'
import { InMemoryUMPIdentityStore } from '../ump/UMPIdentityStore.js'

describe('UMP lookup history selection', () => {
  it.each([
    { presentationHash: '11'.repeat(32) },
    { recoveryHash: '22'.repeat(32) },
    { outpoint: `${'aa'.repeat(32)}.0` }
  ])('requests every retained predecessor for %j', async query => {
    const cursor = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      toArray: jest.fn(async () => [{ txid: 'aa'.repeat(32), outputIndex: 0 }])
    }
    const collection = { find: jest.fn(() => cursor) }
    const db = { collection: jest.fn(() => collection) } as unknown as Db
    const service = createUMPLookupService(db, new InMemoryUMPIdentityStore())
    const result: LookupFormula = await service.lookup({ service: 'ls_users', query })
    expect(result).toEqual([
      { txid: 'aa'.repeat(32), outputIndex: 0, history: expect.any(Function) }
    ])
    const history = result[0].history
    if (typeof history !== 'function') throw new Error('Missing UMP history decider')
    await expect(history([], 0, 0)).resolves.toBe(true)
    await expect(history([], 0, 1)).resolves.toBe(true)
    await expect(history([], 0, 2048)).resolves.toBe(true)
    expect(cursor.sort).toHaveBeenCalledWith({ _id: -1 })
    expect(cursor.limit).toHaveBeenCalledWith(100)
  })
})
