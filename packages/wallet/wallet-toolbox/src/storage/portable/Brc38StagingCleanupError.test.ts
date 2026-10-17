import { Brc38CleanupScope, Brc38StagingCleanupError } from './Brc38StagingCleanupError'

function latch() {
  let release!: () => void
  const pending = new Promise<void>(resolve => {
    release = resolve
  })
  return { pending, release }
}

test('initial teardown callers share the actual pending drain and the same rejection without retrying it', async () => {
  const gate = latch(),
    cause = new Error('initial physical teardown failed'),
    cleanup = jest.fn(async () => {
      await gate.pending
      throw cause
    }),
    scope = new Brc38CleanupScope(cleanup),
    first = scope.close(),
    second = scope.close()
  expect(second).toBe(first)
  const observed = Promise.allSettled([first, second])
  gate.release()
  expect(await observed).toEqual([
    { status: 'rejected', reason: cause },
    { status: 'rejected', reason: cause }
  ])
  await expect(scope.close()).rejects.toBe(cause)
  expect(cleanup).toHaveBeenCalledTimes(1)
})

test('cleanup revokes actor admission synchronously before awaiting its physical drain', async () => {
  const gate = latch()
  let live = true
  const scope = new Brc38CleanupScope(async () => {
    live = false
    await gate.pending
  })
  const closing = scope.close()
  try {
    expect(live).toBe(false)
    expect(scope.close()).toBe(closing)
  } finally {
    gate.release()
    await closing
  }
})

test('physical retry preserves original non-Error causes and completes only after owned teardown settles', async () => {
  const original = { operation: 'synthetic import failure' },
    teardown = new Error('synthetic close refusal'),
    gate = latch()
  let held = true
  const close = jest.fn(async () => {
      await gate.pending
      held = false
    }),
    failure = new Brc38StagingCleanupError([original, teardown], 'Private import cleanup pending', close)
  expect(failure).toBeInstanceOf(AggregateError)
  expect(failure.errors).toEqual([original, teardown])
  const pending = failure.retryCleanup()
  expect(held).toBe(true)
  gate.release()
  await pending
  expect(held).toBe(false)
  await failure.retryCleanup()
  expect(close).toHaveBeenCalledTimes(1)
  expect(failure.errors[0]).toBe(original)
  expect(failure.errors[1]).toBe(teardown)
})

test('concurrent retry cannot start a second native teardown and does not complete the first owner', async () => {
  const gate = latch(),
    close = jest.fn(async () => await gate.pending),
    failure = new Brc38StagingCleanupError([], 'Physical cleanup pending', close),
    pending = failure.retryCleanup()
  try {
    await expect(failure.retryCleanup()).rejects.toThrow()
    expect(close).toHaveBeenCalledTimes(1)
  } finally {
    gate.release()
    await pending
  }
  await failure.retryCleanup()
  expect(close).toHaveBeenCalledTimes(1)
})

test('a rejected native teardown remains retryable and its rejection identity is preserved', async () => {
  const original = new Error('synthetic operation failure'),
    next = { close: 'synthetic retry refusal' },
    close = jest.fn<Promise<void>, []>().mockRejectedValueOnce(next).mockResolvedValue(undefined),
    failure = new Brc38StagingCleanupError([original], 'Physical cleanup pending', close)
  await expect(failure.retryCleanup()).rejects.toBe(next)
  await failure.retryCleanup()
  await failure.retryCleanup()
  expect(close).toHaveBeenCalledTimes(2)
  expect(failure.errors).toEqual([original])
})
