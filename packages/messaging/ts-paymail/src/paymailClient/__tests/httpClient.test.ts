import fetch from 'cross-fetch'

import { PaymailServerResponseError } from '../../errors/index.js'
import HttpClient from '../httpClient.js'

jest.mock('cross-fetch')

const mockedFetch = jest.mocked(fetch)

describe('HttpClient', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('returns successful responses and forwards GET options', async () => {
    const response = new Response('{}', { status: 200 })
    mockedFetch.mockResolvedValue(response)
    const client = new HttpClient()

    await expect(
      client.request('https://example.test', {
        method: 'GET',
        headers: { Accept: 'application/json' }
      })
    ).resolves.toBe(response)
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://example.test',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('serializes POST bodies and preserves caller headers', async () => {
    mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    const client = new HttpClient()

    await client.request('https://example.test', {
      method: 'POST',
      body: { value: 1 },
      headers: { Authorization: 'Bearer token' }
    })

    const requestOptions = mockedFetch.mock.calls[0]?.[1]
    const headers = new Headers(requestOptions?.headers)
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://example.test',
      expect.objectContaining({
        method: 'POST',
        body: '{"value":1}'
      })
    )
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Authorization')).toBe('Bearer token')
  })

  it('does not synthesize a body when a POST body is omitted', async () => {
    mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    const client = new HttpClient()

    await client.request('https://example.test', { method: 'POST' })

    expect(mockedFetch.mock.calls[0]?.[1]).not.toHaveProperty('body')
  })

  it('turns non-success responses into Paymail server errors', async () => {
    mockedFetch.mockResolvedValue(new Response('upstream failed', { status: 503 }))

    await expect(new HttpClient().request('https://example.test')).rejects.toEqual(
      new PaymailServerResponseError('upstream failed')
    )
  })

  it('aborts requests at the configured timeout and clears the timer', async () => {
    jest.useFakeTimers()
    mockedFetch.mockImplementation(
      async (_url, options): Promise<Response> =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
    )
    const request = new HttpClient(50).request('https://example.test')
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })

    await jest.advanceTimersByTimeAsync(50)
    await rejection
    expect(jest.getTimerCount()).toBe(0)
  })

  it('lets a per-request timeout override the default', async () => {
    jest.useFakeTimers()
    mockedFetch.mockImplementation(
      async (_url, options): Promise<Response> =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'))
          })
        })
    )
    const request = new HttpClient(10_000).request('https://example.test', {
      method: 'GET',
      timeout: 25
    })
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })

    await jest.advanceTimersByTimeAsync(25)
    await rejection
  })
})
