import { describe, it, expect } from '@jest/globals'
import { pendingWork } from '../src/internal/pendingWork.js'

describe('pull-driven sequential work', () => {
  it('remains closed after completion, failure or explicit return', async () => {
    let starts = 0
    const jobs = pendingWork(
      () => false,
      () => Promise.resolve(++starts)
    )
    expect(await jobs.next()).toEqual({ done: true, value: undefined })
    expect(await jobs.next()).toEqual({ done: true, value: undefined })
    const closed = pendingWork(
      () => true,
      () => Promise.resolve(++starts)
    )
    await closed.return!()
    expect(await closed.next()).toEqual({ done: true, value: undefined })
    const failed = pendingWork(
      () => true,
      () => Promise.reject(new Error('failed'))
    )
    await expect(failed.next()).rejects.toThrow('failed')
    expect(await failed.next()).toEqual({ done: true, value: undefined })
    expect(starts).toBe(0)
  })

  it('starts nothing before a pull, and rechecks state after the consumer body', async () => {
    const order: string[] = []
    let remaining = 2
    let release: ((value: number) => void) | undefined
    const jobs = pendingWork(
      () => remaining > 0,
      () => {
        if (remaining <= 0) return Promise.reject(new Error('Unexpected extra operation'))
        order.push(`start:${remaining}`)
        return new Promise<number>(resolve => {
          release = resolve
        })
      }
    )
    expect(order).toEqual([])
    const consume = (async () => {
      for await (const value of jobs) {
        order.push(`commit:${value}`)
        remaining--
      }
    })().then(
      () => ({ completed: true }),
      error => ({ error })
    )
    try {
      expect(order).toEqual(['start:2'])
      release!(2)
      // A completed consumer body precedes the next dependent operation.
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(order).toEqual(['start:2', 'commit:2', 'start:1'])
      release!(1)
      await expect(consume).resolves.toEqual({ completed: true })
      expect(order).toEqual(['start:2', 'commit:2', 'start:1', 'commit:1'])
    } finally {
      remaining = 0
      release?.(0)
      await consume
    }
  })

  it('does not prefetch after early termination', async () => {
    let starts = 0
    for await (const result of pendingWork(
      () => true,
      () => Promise.resolve(++starts)
    )) {
      expect(result).toBe(1)
      break
    }
    expect(starts).toBe(1)
  })

  it.each(['condition', 'operation', 'rejection'] as const)(
    'preserves a %s failure and starts no further work',
    async phase => {
      const error = new Error('original failure')
      let starts = 0
      const consume = async (): Promise<void> => {
        for await (const _ of pendingWork(
          () => {
            if (phase === 'condition') throw error
            return true
          },
          () => {
            starts++
            if (phase === 'operation') throw error
            return Promise.reject(error)
          }
        )) {
          throw new Error('Unexpected completed operation')
        }
      }
      await expect(consume()).rejects.toBe(error)
      expect(starts).toBe(phase === 'condition' ? 0 : 1)
    }
  )
})
