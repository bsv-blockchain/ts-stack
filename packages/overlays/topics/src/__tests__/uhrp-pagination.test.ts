import { jest } from '@jest/globals'
import type { Db } from 'mongodb'
import { StorageUtils } from '@bsv/sdk'
import { UHRPLookupService } from '../uhrp/UHRPLookupService.js'

function setup() {
  const rows = Array.from({ length: 200 }, (_, outputIndex) => ({ txid: '11'.repeat(32), outputIndex }))
  const cursor = { project: jest.fn(), sort: jest.fn(), skip: jest.fn(), limit: jest.fn(), toArray: jest.fn<() => Promise<typeof rows>>() }
  for (const method of ['project', 'sort', 'skip', 'limit'] as const) cursor[method].mockReturnValue(cursor)
  cursor.toArray.mockResolvedValue(rows)
  const find = jest.fn().mockReturnValue(cursor)
  const db = { collection: () => ({ find }) } as unknown as Db
  return { service: new UHRPLookupService(db), cursor, find, rows }
}
const uhrpUrl = StorageUtils.getURLForHash(Array(32).fill(1))
it('accepts the SDK 200-row page and keeps pagination out of the selector', async () => {
  const { service, cursor, find, rows } = setup()
  await expect(service.lookup({ service: 'ls_uhrp', query: { uhrpUrl, limit: 200, offset: 0 } })).resolves.toEqual(rows)
  expect(find).toHaveBeenCalledWith({ uhrpUrl })
  expect(cursor.limit).toHaveBeenCalledWith(200)
  expect(cursor.sort).toHaveBeenCalledWith({ txid: 1, outputIndex: 1 })
})
it.each([0, 201, -1, 1.5, '200'])('rejects invalid limit %p before querying storage', async limit => {
  const { service, find } = setup()
  await expect(service.lookup({ service: 'ls_uhrp', query: { uhrpUrl, limit } })).rejects.toThrow()
  expect(find).not.toHaveBeenCalled()
})
it('preserves selector validation for unknown and operator fields', async () => {
  const { service, find } = setup()
  await expect(service.lookup({ service: 'ls_uhrp', query: { uhrpUrl, limit: 200, $where: 'bad' } })).rejects.toThrow()
  expect(find).not.toHaveBeenCalled()
})
