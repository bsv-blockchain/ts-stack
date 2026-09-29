import { describe, it, expect } from '@jest/globals'
import { pendingWork } from '../src/internal/pendingWork.js'

describe('pull-driven sequential work', () => {
  it('starts nothing before a pull, and rechecks state after the consumer body', async () => {
    const order: string[] = []
    let remaining = 2
    let release!: (value: number) => void
    const jobs = pendingWork(
      () => remaining > 0,
      () => {
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
    })()
    expect(order).toEqual(['start:2'])
    release(2)
    // A completed consumer body precedes the next dependent operation.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(order).toEqual(['start:2', 'commit:2', 'start:1'])
    release(1)
    await consume
    expect(order).toEqual(['start:2', 'commit:2', 'start:1', 'commit:1'])
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
