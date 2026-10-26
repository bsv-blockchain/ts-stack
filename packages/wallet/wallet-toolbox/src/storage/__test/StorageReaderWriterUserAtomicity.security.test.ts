import { StorageReaderWriter } from '../StorageReaderWriter'

function fakeStorage(overrides: Record<string, unknown> = {}): StorageReaderWriter {
  const storage = Object.create(StorageReaderWriter.prototype) as StorageReaderWriter & Record<string, unknown>
  const trx = { token: 'transaction' }
  Object.assign(storage, {
    transaction: jest.fn(async (scope: (trx: unknown) => Promise<unknown>) => await scope(trx)),
    findUsers: jest.fn().mockResolvedValue([]),
    insertUser: jest.fn().mockResolvedValue(17),
    insertOutputBasket: jest.fn().mockResolvedValue(23),
    getSettings: jest.fn().mockReturnValue({ storageIdentityKey: '2'.repeat(66) }),
    ...overrides
  })
  return storage
}

describe('wallet-user creation atomicity', () => {
  test('creates the user and mandatory default basket in the same transaction', async () => {
    const storage = fakeStorage()

    const result = await storage.findOrInsertUser('3'.repeat(66))

    expect(result).toMatchObject({ isNew: true, user: { userId: 17, identityKey: '3'.repeat(66) } })
    expect(storage.transaction).toHaveBeenCalledTimes(1)
    const trx = (storage.insertUser as jest.Mock).mock.calls[0][1]
    expect(trx).toBeDefined()
    expect(storage.insertOutputBasket).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 17, name: 'default' }),
      trx
    )
  })

  test('does not hide a default-basket failure or retry inside a caller transaction', async () => {
    const failure = new Error('basket unavailable')
    const storage = fakeStorage({ insertOutputBasket: jest.fn().mockRejectedValue(failure) })
    const trx = { token: 'caller' }

    await expect(storage.findOrInsertUser('3'.repeat(66), trx as any)).rejects.toBe(failure)
    expect(storage.transaction).not.toHaveBeenCalled()
    expect(storage.insertUser).toHaveBeenCalledWith(expect.any(Object), trx)
    expect(storage.insertOutputBasket).toHaveBeenCalledWith(expect.any(Object), trx)
  })

  test('retries the complete transaction once after a creation race', async () => {
    const race = new Error('unique identity race')
    const existing = {
      userId: 19,
      identityKey: '3'.repeat(66),
      activeStorage: '2'.repeat(66),
      created_at: new Date(),
      updated_at: new Date()
    }
    const transaction = jest.fn()
      .mockRejectedValueOnce(race)
      .mockImplementationOnce(async (scope: (trx: unknown) => Promise<unknown>) => await scope({ token: 'retry' }))
    const storage = fakeStorage({
      transaction,
      findUsers: jest.fn().mockResolvedValue([existing])
    })

    await expect(storage.findOrInsertUser(existing.identityKey)).resolves.toEqual({ user: existing, isNew: false })
    expect(transaction).toHaveBeenCalledTimes(2)
    expect(storage.insertUser).not.toHaveBeenCalled()
  })
})
