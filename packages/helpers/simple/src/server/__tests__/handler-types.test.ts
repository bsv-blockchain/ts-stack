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
})
