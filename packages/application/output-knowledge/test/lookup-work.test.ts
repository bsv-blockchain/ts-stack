import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { getEventListeners } from 'node:events'
import { LookupSourceWork } from '../src/sources/LookupSourceWork.js'

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('live source physical work ownership', () => {
  it('rejects pre-cancelled work and removes timers and parent listeners on success or failure', async () => {
    jest.useFakeTimers()
    const work = new LookupSourceWork()
    const parent = new AbortController()
    const cancelled = new AbortController()
    cancelled.abort()
    const operation = jest.fn<() => Promise<number>>().mockResolvedValue(7)
    expect(() => work.check(cancelled.signal)).toThrow('cancelled')
    await expect(work.run(cancelled.signal, 100, operation)).rejects.toMatchObject({
      code: 'cancelled',
      retryable: false
    })
    expect(operation).not.toHaveBeenCalled()
    await expect(work.run(parent.signal, 100, operation)).resolves.toBe(7)
    expect(jest.getTimerCount()).toBe(0)
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
    const failure = new Error('read failed')
    await expect(
      work.run(parent.signal, 100, async () => {
        throw failure
      })
    ).rejects.toBe(failure)
    expect(jest.getTimerCount()).toBe(0)
    expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
  })

  it('observes a late physical rejection after the caller has cancelled', async () => {
    jest.useFakeTimers()
    const work = new LookupSourceWork()
    const parent = new AbortController()
    const failure = new Error('late storage failure')
    let fail!: (reason: Error) => void
    const operation = new Promise<never>((_resolve, reject) => {
      fail = reject
    })
    const pending = work
      .run(parent.signal, 100, () => operation)
      .then(
        value => ({ value }),
        (error: unknown) => ({ error })
      )
    try {
      await jest.advanceTimersByTimeAsync(0)
      parent.abort()
      expect(await pending).toMatchObject({ error: { code: 'cancelled' } })
    } finally {
      fail(failure)
      await pending
      await jest.advanceTimersByTimeAsync(0)
    }
    await expect(work.run(new AbortController().signal, 100, async () => 3)).resolves.toBe(3)
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each(['deadline', 'cancel'] as const)(
    'retains physical ownership after %s until noncancellable work settles',
    async mode => {
      jest.useFakeTimers()
      const work = new LookupSourceWork()
      const parent = new AbortController()
      let release!: () => void
      const held = new Promise<void>(resolve => {
        release = resolve
      })
      const pending = work
        .run(parent.signal, 100, async () => {
          await held
          return 'late'
        })
        .then(
          value => ({ value }),
          (error: unknown) => ({ error })
        )
      try {
        await jest.advanceTimersByTimeAsync(99)
        expect(getEventListeners(parent.signal, 'abort')).toHaveLength(1)
        if (mode === 'cancel') parent.abort()
        else await jest.advanceTimersByTimeAsync(1)
        expect(await pending).toMatchObject({
          error: {
            code: mode === 'deadline' ? 'limited' : 'cancelled',
            retryable: mode === 'deadline'
          }
        })
        expect(jest.getTimerCount()).toBe(0)
        expect(getEventListeners(parent.signal, 'abort')).toHaveLength(0)
        await expect(
          work.run(new AbortController().signal, 100, async () => 2)
        ).rejects.toMatchObject({ code: 'limited', retryable: true })
      } finally {
        release()
        await pending
        await jest.advanceTimersByTimeAsync(0)
      }
      await expect(work.run(new AbortController().signal, 100, async () => 2)).resolves.toBe(2)
    }
  )
})
