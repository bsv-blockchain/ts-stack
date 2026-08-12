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
    const fetchMock = jest.fn(
      async () =>
        new Response(JSON.stringify({ error: 'limited' }), {
          status: 429,
          statusText: 'Too Many Requests',
          headers: { 'retry-after': '0' }
        })
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

  test('aborts a stalled response within the configured whole-request deadline', async () => {
    const fetchMock = jest.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const fetch = new ChaintracksFetch({ timeoutMsecs: 5, maxRetries: 0 })
    await expect(fetch.download('https://example.test/stalled.headers')).rejects.toMatchObject({
      name: 'ChaintracksFetchError',
      status: 0,
      statusText: 'Request Timeout',
      retryable: true
    } satisfies Partial<ChaintracksFetchError>)
  })

  test('rejects a response before materializing a declared oversized body', async () => {
    const fetchMock = jest.fn(
      async () =>
        new Response(new Uint8Array(9), {
          status: 200,
          headers: { 'content-length': '9' }
        })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const fetch = new ChaintracksFetch({ maxResponseBytes: 8, maxRetries: 0 })
    await expect(fetch.download('https://example.test/large.headers')).rejects.toMatchObject({
      name: 'ChaintracksFetchError',
      status: 200,
      statusText: 'Response Too Large',
      retryable: false
    } satisfies Partial<ChaintracksFetchError>)
  })

  test('enforces a stricter per-download response limit', async () => {
    globalThis.fetch = jest.fn(async () => new Response(new Uint8Array(9), { status: 200 })) as unknown as typeof fetch

    const fetch = new ChaintracksFetch({ maxResponseBytes: 1024, maxRetries: 0 })
    await expect(fetch.download('https://example.test/exact.headers', 8)).rejects.toMatchObject({
      name: 'ChaintracksFetchError',
      status: 200,
      statusText: 'Response Too Large',
      retryable: false
    } satisfies Partial<ChaintracksFetchError>)
  })

  test('reserves every physical retry before issuing it', async () => {
    const responses = [
      new Response(null, { status: 503 }),
      new Response(null, { status: 503 }),
      new Response(new Uint8Array([1, 2, 3]), { status: 200 })
    ]
    globalThis.fetch = jest.fn(async () => responses.shift()!) as unknown as typeof fetch
    const beforeRetry = jest.fn(async () => undefined)
    const fetch = new ChaintracksFetch({ maxRetries: 2, retryMsecs: 1, random: () => 0 })

    await expect(fetch.download('https://example.test/retrying.headers', 3, { beforeRetry })).resolves.toEqual(
      new Uint8Array([1, 2, 3])
    )
    expect(beforeRetry).toHaveBeenNthCalledWith(1, 2)
    expect(beforeRetry).toHaveBeenNthCalledWith(2, 3)
  })
})
