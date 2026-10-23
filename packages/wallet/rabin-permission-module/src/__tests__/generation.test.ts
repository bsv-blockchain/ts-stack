import { jest } from '@jest/globals'
import { GenerationRateLimiter, GenerationScheduler, TokenBucket } from '../generation.js'

describe('TokenBucket', () => {
  it('starts full, spends tokens and regains one per interval up to its capacity', () => {
    const bucket = new TokenBucket(2, 1000, 0)
    expect(bucket.full(0)).toBe(true)
    bucket.take()
    bucket.take()
    expect(bucket.available(0)).toBe(false)
    expect(bucket.available(999)).toBe(false)
    expect(bucket.available(1000)).toBe(true)
    expect(bucket.full(1000)).toBe(false)
    expect(bucket.full(5000)).toBe(true)
    // A clock that steps backwards neither adds nor removes tokens.
    expect(bucket.available(10)).toBe(true)
  })
})

describe('GenerationRateLimiter', () => {
  const limits = {
    originatorBurst: 1,
    originatorInterval: 1000,
    globalBurst: 5000,
    globalInterval: 1
  }

  it('needs a token from both the originator and the global bucket', () => {
    const limiter = new GenerationRateLimiter(
      { ...limits, globalBurst: 2, globalInterval: 1000 },
      0
    )
    expect(limiter.tryAcquire('a', 0)).toBe(true)
    expect(limiter.tryAcquire('a', 0)).toBe(false)
    expect(limiter.tryAcquire('b', 0)).toBe(true)
    // Global bucket empty: c has its own token but cannot spend it, and keeps it.
    expect(limiter.tryAcquire('c', 0)).toBe(false)
    expect(limiter.tryAcquire('c', 1000)).toBe(true)
  })

  it('keeps tracking bounded when many originators appear', () => {
    const limiter = new GenerationRateLimiter(limits, 0)
    for (let i = 0; i < 1024; i++) expect(limiter.tryAcquire(`o${i}`, 0)).toBe(true)
    // All 1024 are still throttled: the oldest is forgotten to admit a new originator.
    expect(limiter.tryAcquire('new', 0)).toBe(true)
    expect(limiter.tryAcquire('o0', 0)).toBe(true)
    expect(limiter.tryAcquire('o5', 0)).toBe(false)
    // Once buckets have refilled they are dropped before any throttled one.
    expect(limiter.tryAcquire('later', 10_000)).toBe(true)
    expect(limiter.tryAcquire('o5', 10_000)).toBe(true)
  })
})

describe('GenerationScheduler', () => {
  const busy = () => new Error('busy')

  it('rejects waiting jobs on clear, forgets their ids and keeps running the current one', async () => {
    let finish!: (value: string) => void
    const scheduler = new GenerationScheduler<string>(3, 60_000, busy)
    const running = scheduler.submit(
      'a',
      () =>
        new Promise<string>(resolve => {
          finish = resolve
        })
    )
    const run = jest.fn(async () => 'b')
    const waiting = scheduler.submit('b', run)
    expect(scheduler.joinable('b')).toBe(waiting)
    scheduler.clear(() => new Error('reset'))
    await expect(waiting).rejects.toThrow('reset')
    expect(scheduler.joinable('a')).toBeUndefined()
    expect(scheduler.joinable('b')).toBeUndefined()
    finish('a')
    await expect(running).resolves.toBe('a')
    expect(run).not.toHaveBeenCalled()
    expect(scheduler.hasCapacity()).toBe(true)
  })

  it('counts the running job and the waiting jobs against its capacity', async () => {
    let finish!: () => void
    const scheduler = new GenerationScheduler<void>(2, 60_000, busy)
    const first = scheduler.submit(
      undefined,
      () => new Promise<void>(resolve => (finish = resolve))
    )
    expect(scheduler.hasCapacity()).toBe(true)
    const second = scheduler.submit(undefined, async () => undefined)
    expect(scheduler.hasCapacity()).toBe(false)
    finish()
    await first
    await second
    expect(scheduler.hasCapacity()).toBe(true)
  })
})
