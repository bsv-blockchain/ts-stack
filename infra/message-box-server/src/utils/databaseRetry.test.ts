import {
  isRetryableDatabaseConflict,
  readDatabaseRetryConfig,
  withDatabaseConflictRetry
} from './databaseRetry.js'

const DATABASE_ENV = [
  'MESSAGE_BOX_DB_DEADLOCK_RETRIES',
  'MESSAGE_BOX_DB_DEADLOCK_RETRY_BASE_MS',
  'MESSAGE_BOX_DB_DEADLOCK_RETRY_MAX_MS'
] as const

describe('database conflict retry', () => {
  afterEach(() => {
    for (const name of DATABASE_ENV) delete process.env[name]
  })

  it('recognizes MySQL deadlock and lock-timeout forms', () => {
    expect(isRetryableDatabaseConflict({ code: 'ER_LOCK_DEADLOCK' })).toBe(true)
    expect(isRetryableDatabaseConflict({ errno: 1205 })).toBe(true)
    expect(isRetryableDatabaseConflict({ sqlState: '40001' })).toBe(true)
    expect(isRetryableDatabaseConflict({ code: 'ER_DUP_ENTRY' })).toBe(false)
  })

  it('retries a bounded number of times with capped exponential backoff', async () => {
    const operation = jest
      .fn<Promise<string>, []>()
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' }))
      .mockRejectedValueOnce(Object.assign(new Error('deadlock'), { errno: 1213 }))
      .mockResolvedValue('stored')
    const sleep = jest.fn(async (_delayMs: number) => {})
    const onRetry = jest.fn()

    await expect(
      withDatabaseConflictRetry(
        operation,
        { maxRetries: 5, baseDelayMs: 10, maxDelayMs: 15 },
        onRetry,
        sleep
      )
    ).resolves.toBe('stored')
    expect(operation).toHaveBeenCalledTimes(3)
    expect(sleep.mock.calls).toEqual([[10], [15]])
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it('does not retry permanent failures or exceed the configured retry count', async () => {
    const permanent = jest.fn(async () => {
      throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
    })
    await expect(
      withDatabaseConflictRetry(
        permanent,
        { maxRetries: 5, baseDelayMs: 1, maxDelayMs: 1 },
        undefined,
        async () => {}
      )
    ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' })
    expect(permanent).toHaveBeenCalledTimes(1)

    const deadlock = jest.fn(async () => {
      throw Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' })
    })
    await expect(
      withDatabaseConflictRetry(
        deadlock,
        { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
        undefined,
        async () => {}
      )
    ).rejects.toMatchObject({ code: 'ER_LOCK_DEADLOCK' })
    expect(deadlock).toHaveBeenCalledTimes(3)
  })

  it('loads safe defaults and rejects invalid operator settings', () => {
    expect(readDatabaseRetryConfig()).toEqual({
      maxRetries: 5,
      baseDelayMs: 10,
      maxDelayMs: 250
    })
    process.env.MESSAGE_BOX_DB_DEADLOCK_RETRIES = '21'
    expect(() => readDatabaseRetryConfig()).toThrow('between 0 and 20')
  })
})
