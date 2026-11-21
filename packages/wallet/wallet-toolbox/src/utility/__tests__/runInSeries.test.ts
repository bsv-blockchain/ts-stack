import { runInSeries } from '../runInSeries'

test('pulls lazily and starts only one operation at a time', async () => {
  let release!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const started: number[] = []
  const completed: number[] = []
  const pending = runInSeries([1, 2, 3], async value => {
    started.push(value)
    if (value === 1) await gate
    expect(completed).toEqual(started.slice(0, -1))
    completed.push(value)
    return value * 2
  })
  await Promise.resolve()
  expect(started).toEqual([1])
  expect(completed).toEqual([])
  release()
  await expect(pending).resolves.toBe(6)
  expect(completed).toEqual([1, 2, 3])
})

test.each(['throw', 'reject'] as const)('stops and closes its input on an operation %s', async mode => {
  let closed = false
  function* values() {
    try {
      yield* [1, 2, 3]
    } finally {
      closed = true
    }
  }
  const failure = new Error('operation failed')
  const work = jest.fn((value: number) => {
    if (value !== 2) return Promise.resolve(value)
    if (mode === 'throw') throw failure
    return Promise.reject(failure)
  })
  await expect(runInSeries(values(), work)).rejects.toBe(failure)
  expect(work.mock.calls).toEqual([[1], [2]])
  expect(closed).toBe(true)
})

test('does not call work for an empty source', async () => {
  const work = jest.fn(() => Promise.resolve(1))
  await expect(runInSeries([], work)).resolves.toBeUndefined()
  expect(work).not.toHaveBeenCalled()
})
