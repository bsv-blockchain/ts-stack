import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals'
import { DialClock, DialSettler, ReplyQueue } from '../src/client/dial.js'
import type { SignalPlaintext } from '../src/signaling/types.js'
import { WebRTPayError } from '../src/util/errors.js'

function signal(kind: SignalPlaintext['kind']): SignalPlaintext {
  return { v: 1, kind, sid: 's', from: 'a', to: 'b', ts: 0, purpose: 'payment' }
}

describe('DialClock', () => {
  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  function clock(totalMs = 30000): { c: DialClock; expired: WebRTPayError[] } {
    const expired: WebRTPayError[] = []
    const c = new DialClock({ presenceMs: 2000, dialMs: 6000, totalMs }, e => expired.push(e))
    return { c, expired }
  }

  it('reports peer_unreachable when presence, counted from the post, runs out', () => {
    const { c, expired } = clock()
    c.start()
    jest.advanceTimersByTime(5000)
    expect(expired).toEqual([])
    c.posted()
    c.posted()
    jest.advanceTimersByTime(1999)
    expect(expired).toEqual([])
    jest.advanceTimersByTime(1)
    expect(expired[0]).toMatchObject({
      code: 'peer_unreachable',
      message: 'No answer from the recipient in 2000 ms'
    })
    c.stop()
  })

  it('times the dial from the first reply, once', () => {
    const { c, expired } = clock()
    c.start()
    c.posted()
    jest.advanceTimersByTime(1500)
    c.heard()
    jest.advanceTimersByTime(1000)
    c.heard()
    jest.advanceTimersByTime(4999)
    expect(expired).toEqual([])
    jest.advanceTimersByTime(1)
    expect(expired.map(e => e.code)).toEqual(['timeout'])
    c.stop()
  })

  it('caps the whole dial: unreachable before a reply, timeout after one', () => {
    const before = clock(1000)
    before.c.start()
    before.c.posted()
    jest.advanceTimersByTime(1000)
    expect(before.expired[0]).toMatchObject({
      code: 'peer_unreachable',
      message: 'No answer from the recipient in 1000 ms'
    })
    before.c.stop()

    const after = clock(3000)
    after.c.start()
    after.c.heard()
    jest.advanceTimersByTime(3000)
    expect(after.expired[0]).toMatchObject({
      code: 'timeout',
      message: 'Connection not established within 3000 ms'
    })
    after.c.stop()
  })

  it('starts no presence clock after a reply that beat the post', () => {
    const { c, expired } = clock()
    c.start()
    c.heard()
    c.posted()
    jest.advanceTimersByTime(5999)
    expect(expired).toEqual([])
    c.stop()
  })

  it('starts nothing once stopped', () => {
    const { c, expired } = clock()
    c.start()
    c.stop()
    c.posted()
    c.heard()
    jest.advanceTimersByTime(60000)
    expect(expired).toEqual([])
    expect(jest.getTimerCount()).toBe(0)
  })

  it('stops every timer', () => {
    const { c, expired } = clock()
    c.start()
    c.posted()
    c.heard()
    c.stop()
    jest.advanceTimersByTime(60000)
    expect(expired).toEqual([])
  })
})

describe('ReplyQueue', () => {
  it('hands out replies in order, waiting when none has arrived', async () => {
    const q = new ReplyQueue()
    q.push(signal('ring'))
    expect((await q.next()).kind).toBe('ring')
    const waiting = q.next()
    q.push(signal('answer'))
    expect((await waiting).kind).toBe('answer')
  })

  it('rejects a waiting and every later next once failed, and drops later replies', async () => {
    const q = new ReplyQueue()
    const e = new WebRTPayError('closed', 'Dial cancelled')
    const waiting = q.next()
    q.fail(e)
    q.fail(new WebRTPayError('timeout'))
    q.push(signal('ring'))
    await expect(waiting).rejects.toBe(e)
    await expect(q.next()).rejects.toBe(e)
  })

  it('fails with nobody waiting', async () => {
    const q = new ReplyQueue()
    const e = new WebRTPayError('timeout')
    q.fail(e)
    await expect(q.next()).rejects.toBe(e)
  })
})

describe('DialSettler', () => {
  it('settles once and cleans up once', () => {
    const calls: string[] = []
    const s = new DialSettler<number>(
      v => calls.push(`resolve ${v}`),
      e => calls.push(`reject ${String(e)}`),
      () => calls.push('cleanup')
    )
    expect(s.resolve(1)).toBe(true)
    expect(s.reject('late')).toBe(false)
    expect(s.resolve(2)).toBe(false)
    expect(calls).toEqual(['cleanup', 'resolve 1'])
  })
})
