import { ChaintracksFetch, ChaintracksFetchError } from '../ChaintracksFetch'

describe('ChaintracksFetch tests', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    jest.restoreAllMocks()
  })

  test('retries numeric HTTP 429 even when statusText differs', async () => {
    const responses = [
      new Response(JSON.stringify({}), { status: 429, statusText: 'rate limited', headers: { 'retry-after': '0' } }),
      new Response(JSON.stringify({ ok: true }), { status: 200, statusText: 'OK' })
    ]
    const fetchMock = jest.fn(async () => {
      const response = responses.shift()
      if (response == null) throw new Error('No scripted fetch response')
      return response
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const fetch = new ChaintracksFetch()
    const json = await fetch.fetchJson<{ ok: boolean }>('https://example.test/headers')

    expect(json.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('throws ChaintracksFetchError with status and Retry-After after retries are exhausted', async () => {
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ error: 'limited' }), { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const fetch = new ChaintracksFetch()
    await expect(fetch.fetchJson('https://example.test/headers')).rejects.toMatchObject({
      name: 'ChaintracksFetchError',
      status: 429,
      statusText: 'Too Many Requests',
      retryAfterMsecs: 0,
      retryable: true
    } satisfies Partial<ChaintracksFetchError>)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })
})
