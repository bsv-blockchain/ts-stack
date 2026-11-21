import { Brc38OwnedPreparation } from './Brc38OwnedPreparation'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { Brc38WorkingAllocation } from './Brc38WorkingAllocation'

// Authored UNRUN. Ownership/drain regression cases, not platform evidence.
afterEach(() => jest.useRealTimers())
test('serial preparation closes without another admitted operation or renewed deadline', async () => {
  const owner = new Brc38OwnedPreparation(Date.now() + 10000)
  expect(await owner.run(async () => 1)).toBe(1)
  expect(await owner.run(async () => 2)).toBe(2)
  await owner.close()
  const work = jest.fn(async () => 3)
  await expect(owner.run(work)).rejects.toThrow('closed or expired')
  expect(work).not.toHaveBeenCalled()
})
test('timeout retains actual non-cancellable job until retry drainage', async () => {
  jest.useFakeTimers()
  const owner = new Brc38OwnedPreparation(Date.now() + 1000, 10, 5),
    working = new Brc38WorkingAllocation(8192),
    allowance = working.claim(4096)
  let resolve!: (value: number) => void
  const job = new Promise<number>(done => {
      resolve = done
    }),
    attempt = owner
      .run(async () => await job)
      .then(
        () => undefined,
        cause => cause as unknown
      )
  await Promise.resolve()
  await expect(owner.run(async () => 9)).rejects.toThrow('serial awaited')
  await jest.advanceTimersByTimeAsync(15)
  const cause = await attempt
  expect(cause).toBeInstanceOf(Brc38StagingCleanupError)
  expect(working.used).toBe(4096)
  await expect(owner.run(async () => 8)).rejects.toThrow('closed or expired')
  resolve(42)
  await (cause as Brc38StagingCleanupError).retryCleanup()
  allowance.close()
  await owner.close()
  expect(working.used).toBe(0)
})
test('abort revokes results while retaining physical drainage', async () => {
  jest.useFakeTimers()
  const stopped = new AbortController(),
    owner = new Brc38OwnedPreparation(Date.now() + 1000, 20, 5, stopped.signal)
  let resolve!: () => void
  const job = new Promise<void>(done => {
      resolve = done
    }),
    attempt = owner.run(async () => await job).catch(cause => cause as unknown)
  await Promise.resolve()
  stopped.abort(new Error('Original source stopped'))
  await jest.advanceTimersByTimeAsync(5)
  const cause = await attempt
  expect(cause).toBeInstanceOf(Brc38StagingCleanupError)
  resolve()
  await (cause as Brc38StagingCleanupError).retryCleanup()
  await owner.close()
})
test('an expired original monotonic ceiling refuses before host work', async () => {
  const owner = new Brc38OwnedPreparation(Date.now() + 10000, 10, 5, undefined, performance.now() - 1),
    work = jest.fn(async () => 1)
  await expect(owner.run(work)).rejects.toThrow('closed or expired')
  expect(work).not.toHaveBeenCalled()
  await owner.close()
})
