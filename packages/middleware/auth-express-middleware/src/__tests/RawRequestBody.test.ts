import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import type { Request, Response } from 'express'
import { RawRequestBodyReader } from '../rawRequestBody.js'

function request(headers: Record<string, string> = {}) {
  return Object.assign(new PassThrough(), { headers, body: undefined }) as unknown as Request
}
function response() {
  return new EventEmitter() as unknown as Response
}

describe('bounded pre-auth raw request collection', () => {
  it('retains exact raw bytes without extracting or parsing payment data', async () => {
    const reader = new RawRequestBodyReader(100, 1000, 2)
    const req = request()
    const res = response()
    const done = reader.capture(req, res)
    ;(req as unknown as PassThrough).end(Buffer.from('{ "value": 1 }\n'))
    await done
    expect(req.body).toEqual(Buffer.from('{ "value": 1 }\n'))
    expect(reader.hasCaptured(req)).toBe(true)
    res.emit('finish')
  })

  it.each([
    [{ 'content-length': '101' }, 413],
    [{ 'content-length': '-1' }, 400],
    [{ 'content-length': '9007199254740992' }, 400],
    [{ 'content-encoding': 'gzip' }, 415]
  ])('refuses an invalid or excessive declared body %#', async (headers, status) => {
    const reader = new RawRequestBodyReader(100, 1000, 2)
    await expect(
      reader.capture(request(headers as Record<string, string>), response())
    ).rejects.toMatchObject({ status })
  })

  it('bounds streamed bytes independently of Content-Length and releases failed capacity', async () => {
    const reader = new RawRequestBodyReader(3, 1000, 1)
    const first = request()
    const failure = expect(reader.capture(first, response())).rejects.toMatchObject({ status: 413 })
    ;(first as unknown as PassThrough).end(Buffer.from('four'))
    await failure
    const second = request()
    const res = response()
    const done = reader.capture(second, res)
    ;(second as unknown as PassThrough).end(Buffer.from('ok'))
    await done
    res.emit('finish')
  })

  it('keeps completed-but-unanswered bodies inside both aggregate and request-count budgets', async () => {
    const reader = new RawRequestBodyReader(8, 1000, 2, 8)
    const first = request()
    const firstRes = response()
    const done = reader.capture(first, firstRes)
    ;(first as unknown as PassThrough).end(Buffer.from('12345678'))
    await done
    const second = request()
    const failure = expect(reader.capture(second, response())).rejects.toMatchObject({
      status: 503
    })
    ;(second as unknown as PassThrough).end(Buffer.from('a'))
    await failure
    firstRes.emit('finish')
    const third = request()
    const thirdRes = response()
    const thirdDone = reader.capture(third, thirdRes)
    ;(third as unknown as PassThrough).end(Buffer.from('12345678'))
    await thirdDone
    thirdRes.emit('close')
  })

  it('bounds slow uploads, disconnects, and pending requests without leaking listeners', async () => {
    jest.useFakeTimers()
    try {
      const reader = new RawRequestBodyReader(100, 25, 1)
      const slow = request()
      const failure = expect(reader.capture(slow, response())).rejects.toMatchObject({
        status: 408
      })
      await expect(reader.capture(request(), response())).rejects.toMatchObject({ status: 503 })
      await jest.advanceTimersByTimeAsync(25)
      await failure
      expect(slow.listenerCount('data')).toBe(0)
      const disconnected = request()
      const res = response()
      const aborted = expect(reader.capture(disconnected, res)).rejects.toMatchObject({
        status: 400
      })
      res.emit('close')
      await aborted
      expect(disconnected.listenerCount('data')).toBe(0)
      expect(jest.getTimerCount()).toBe(0)
    } finally {
      jest.useRealTimers()
    }
  })

  it('requires installation before a parser consumes the request', async () => {
    const reader = new RawRequestBodyReader(100, 1000, 1)
    const req = request()
    req.body = { already: 'parsed' }
    await expect(reader.capture(req, response())).rejects.toMatchObject({ status: 400 })
    expect(reader.hasCaptured(req)).toBe(false)
    expect(() => new RawRequestBodyReader(-1, 1000, 1)).toThrow('finite')
  })
})
