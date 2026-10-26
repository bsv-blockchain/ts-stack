import { jsonResponse, toNextHandlers } from '../handler-types'

describe('Next.js handler BRC-100 byte compatibility', () => {
  it('preserves arbitrary request objects and emits portable response bytes', async () => {
    const post = jest.fn(async (req: { json: () => Promise<unknown> }) => {
      await expect(req.json()).resolves.toEqual({ transaction: { 0: 1, 1: 2, 2: 255 } })
      return jsonResponse({ transaction: new Uint8Array([3, 4, 254]) }, 201)
    })
    const handlers = toNextHandlers({ POST: post })

    const response = await handlers.POST?.({
      url: 'https://example.test/payment',
      json: async () => ({ transaction: { 0: 1, 1: 2, 2: 255 } })
    })

    expect(post).toHaveBeenCalledTimes(1)
    expect(response?.status).toBe(201)
    await expect(response?.json()).resolves.toEqual({ transaction: [3, 4, 254] })
  })

  it('rejects declared and streamed JSON bodies above the configured limit', async () => {
    const post = jest.fn(async (req: { json: () => Promise<unknown> }) => {
      await req.json()
      return jsonResponse({ success: true })
    })
    const handlers = toNextHandlers({ POST: post }, { maxRequestBytes: 8 })

    await expect(
      handlers.POST?.(
        new Request('https://example.test/payment', {
          method: 'POST',
          headers: { 'Content-Length': '9' },
          body: '{}'
        })
      )
    ).rejects.toThrow('Request body exceeds the configured limit')

    await expect(
      handlers.POST?.(
        new Request('https://example.test/payment', {
          method: 'POST',
          body: JSON.stringify({ a: 'long' })
        })
      )
    ).rejects.toThrow('Request body exceeds the configured limit')
  })

  it('validates configured request limits', () => {
    expect(() => toNextHandlers({}, { maxRequestBytes: Number.POSITIVE_INFINITY })).toThrow(
      'maxRequestBytes must be a safe integer'
    )
  })

  it('ignores inherited route handlers and request limits', async () => {
    const ambientPost = jest.fn()
    Object.defineProperties(Object.prototype, {
      POST: { value: ambientPost, configurable: true },
      maxRequestBytes: { value: 1, configurable: true }
    })
    try {
      const empty = toNextHandlers({})
      expect(empty.POST).toBeUndefined()

      const post = jest.fn(async (req: { json: () => Promise<unknown> }) => {
        await expect(req.json()).resolves.toEqual({})
        return jsonResponse({ success: true })
      })
      const handlers = toNextHandlers({ POST: post }, {})
      const response = await handlers.POST?.(
        new Request('https://example.test/payment', { method: 'POST', body: '{}' })
      )
      expect(response?.status).toBe(200)
      expect(ambientPost).not.toHaveBeenCalled()
    } finally {
      Reflect.deleteProperty(Object.prototype, 'POST')
      Reflect.deleteProperty(Object.prototype, 'maxRequestBytes')
    }
  })
})
