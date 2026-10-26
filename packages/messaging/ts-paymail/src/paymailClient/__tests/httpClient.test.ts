import fetch from 'cross-fetch'

import { PaymailServerResponseError } from '../../errors/index.js'
import HttpClient from '../httpClient.js'

jest.mock('cross-fetch')

const mockedFetch = jest.mocked(fetch)
const publicAddressResolver = async () => [{ address: '93.184.216.34', family: 4 }]

function createClient(defaultTimeout = 30000, maxResponseBytes = 1024 * 1024): HttpClient {
  return new HttpClient(defaultTimeout, {
    maxResponseBytes,
    addressResolver: publicAddressResolver
  })
}

describe('HttpClient', () => {
  afterEach(() => {
    jest.clearAllMocks()
    jest.useRealTimers()
  })

  it('returns successful responses and forwards GET options', async () => {
    const response = new Response('{}', { status: 200 })
    mockedFetch.mockResolvedValue(response)
    const client = createClient()

    const bounded = await client.request('https://example.test', {
      method: 'GET',
      headers: { Accept: 'application/json' }
    })
    await expect(bounded.text()).resolves.toBe('{}')
    expect(mockedFetch).toHaveBeenCalledWith(
      'https://example.test',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: expect.any(AbortSignal)
      })
    )
  })

  it('applies the SSRF policy to every verbatim result from the default Node DNS resolver', async () => {
    const lookup = jest.fn(async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '10.0.0.1', family: 4 as const }
    ])
    const getBuiltinModule = jest
      .spyOn(process, 'getBuiltinModule')
      .mockReturnValueOnce({ lookup } as never)

    try {
      await expect(new HttpClient().request('https://example.test')).rejects.toThrow(
        'non-public address'
      )
      expect(lookup).toHaveBeenCalledWith('example.test', { all: true, verbatim: true })
      expect(mockedFetch).not.toHaveBeenCalled()
    } finally {
      getBuiltinModule.mockRestore()
    }
  })

  it.each([
    [0, {}],
    [-1, {}],
    [1.5, {}],
    [Number.MAX_SAFE_INTEGER + 1, {}],
    [1000, { maxResponseBytes: 0 }],
    [1000, { maxResponseBytes: 1.5 }]
  ])('rejects unsafe numeric limits before creating a request', (timeout, options) => {
    expect(() => new HttpClient(timeout, options)).toThrow('positive safe integer')
  })

  it('requires exact runtime types for private-network and resolver options', () => {
    expect(
      () => new HttpClient(1000, { allowPrivateNetwork: 'false' as unknown as boolean })
    ).toThrow('allowPrivateNetwork must be a boolean')
    expect(
      () =>
        new HttpClient(1000, {
          addressResolver: 'resolver' as unknown as () => Promise<never[]>
        })
    ).toThrow('addressResolver must be a function')
  })

  it.each(['not a url', 'ftp://example.test/file', 'https://user:secret@example.test'])(
    'rejects an unsafe target URL before DNS or transport: %s',
    async url => {
      const resolver = jest.fn(publicAddressResolver)
      const client = new HttpClient(1000, { addressResolver: resolver })

      await expect(client.request(url)).rejects.toThrow(/Invalid Paymail|require HTTPS|credentials/)
      expect(resolver).not.toHaveBeenCalled()
      expect(mockedFetch).not.toHaveBeenCalled()
    }
  )

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects an unsafe per-request timeout before DNS: %s',
    async timeout => {
      const resolver = jest.fn(publicAddressResolver)
      const client = new HttpClient(1000, { addressResolver: resolver })

      await expect(client.request('https://example.test', { timeout })).rejects.toThrow(
        'positive safe integer'
      )
      expect(resolver).not.toHaveBeenCalled()
    }
  )

  it('serializes POST bodies and preserves caller headers', async () => {
    mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    const client = createClient()

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

  it('preserves a caller-provided content type', async () => {
    mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    const client = createClient()

    await client.request('https://example.test', {
      method: 'POST',
      body: { value: 1 },
      headers: { 'Content-Type': 'application/paymail+json' }
    })

    const requestOptions = mockedFetch.mock.calls[0]?.[1]
    expect(new Headers(requestOptions?.headers).get('Content-Type')).toBe(
      'application/paymail+json'
    )
  })

  it('does not synthesize a body when a POST body is omitted', async () => {
    mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    const client = createClient()

    await client.request('https://example.test', { method: 'POST' })

    expect(mockedFetch.mock.calls[0]?.[1]).not.toHaveProperty('body')
  })

  it('turns non-success responses into Paymail server errors', async () => {
    mockedFetch.mockResolvedValue(new Response('upstream failed', { status: 503 }))

    await expect(createClient().request('https://example.test')).rejects.toEqual(
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
    const request = createClient(50).request('https://example.test')
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
    const request = createClient(10_000).request('https://example.test', {
      method: 'GET',
      timeout: 25
    })
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })

    await jest.advanceTimersByTimeAsync(25)
    await rejection
  })

  it('rejects private DNS results before issuing a request', async () => {
    const client = new HttpClient(1000, {
      addressResolver: async () => [{ address: '127.0.0.1', family: 4 }]
    })

    await expect(client.request('https://attacker.example')).rejects.toThrow('non-public address')
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('uses the exact IPv4 special-use ranges instead of blocking adjacent public space', async () => {
    mockedFetch.mockResolvedValue(new Response('{}', { status: 200 }))
    const publicClient = new HttpClient(1000, {
      addressResolver: async () => [{ address: '198.51.1.1', family: 4 }]
    })
    await expect(publicClient.request('https://public.example')).resolves.toBeInstanceOf(Response)

    const documentationClient = new HttpClient(1000, {
      addressResolver: async () => [{ address: '198.51.100.1', family: 4 }]
    })
    await expect(documentationClient.request('https://docs.example')).rejects.toThrow(
      'non-public address'
    )
  })

  it('rejects empty, mixed-trust, malformed, and failed DNS results', async () => {
    for (const addressResolver of [
      async () => [],
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.1', family: 4 }
      ],
      async () => [{ address: '999.999.999.999', family: 4 }],
      async (): Promise<Array<{ address: string; family: number }>> => {
        throw new Error('resolver failed')
      }
    ]) {
      const client = new HttpClient(1000, { addressResolver })
      await expect(client.request('https://attacker.example')).rejects.toThrow()
    }
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('fails closed on an empty DNS result even when private-network access is enabled', async () => {
    const client = new HttpClient(1000, {
      allowPrivateNetwork: true,
      addressResolver: async () => []
    })

    await expect(client.request('https://internal.example')).rejects.toThrow(
      'hostname did not resolve'
    )
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it('applies the deadline while DNS resolution is pending', async () => {
    jest.useFakeTimers()
    const client = new HttpClient(25, {
      addressResolver: async () => await new Promise(() => {})
    })
    const request = client.request('https://slow-dns.example')
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })

    await jest.advanceTimersByTimeAsync(25)
    await rejection
    expect(mockedFetch).not.toHaveBeenCalled()
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each([
    '0:0:0:0:0:0:0:1',
    '::ffff:7f00:1',
    '::ffff:127.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b::127.0.0.1',
    '64:ff9b:1::7f00:1',
    '2002:7f00:0001::',
    '100::1',
    '2001::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '3ffe::1',
    '4000::1',
    'fc00::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
    '2001:db8::1',
    '::',
    '2001:db8::1::2',
    'fe80::1%lo0',
    '2001:db8:0:0:192.0.2.1:1',
    '2001:db8:0:0:0:0:0'
  ])('rejects non-public IPv6 representation %s', async address => {
    const client = new HttpClient(1000, {
      addressResolver: async () => [{ address, family: 6 }]
    })

    await expect(client.request('https://attacker.example')).rejects.toThrow('non-public address')
    expect(mockedFetch).not.toHaveBeenCalled()
  })

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.0.1',
    '198.18.0.1',
    '198.51.100.1',
    '203.0.113.1',
    '224.0.0.1',
    '999.1.1.1',
    '1.2.3'
  ])('rejects a non-public or malformed IPv4 address %s', async address => {
    const client = new HttpClient(1000, {
      addressResolver: async () => [{ address, family: 4 }]
    })

    await expect(client.request('https://attacker.example')).rejects.toThrow('non-public address')
  })

  it('accepts a public IPv6 result and permits private HTTP only with explicit opt-in', async () => {
    mockedFetch.mockImplementation(async () => new Response('{}'))
    const ipv6Client = new HttpClient(1000, {
      addressResolver: async () => [{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 }]
    })
    await expect(ipv6Client.request('https://example.test')).resolves.toBeInstanceOf(Response)

    const privateClient = new HttpClient(1000, {
      allowPrivateNetwork: true,
      addressResolver: async () => [{ address: '10.0.0.1', family: 4 }]
    })
    await expect(privateClient.request('http://internal.example')).resolves.toBeInstanceOf(Response)
  })

  it('rejects oversized declared and streamed response bodies', async () => {
    mockedFetch.mockResolvedValueOnce(
      new Response('small', { headers: { 'Content-Length': '11' } })
    )
    await expect(createClient(1000, 10).request('https://example.test')).rejects.toThrow(
      'exceeds 10 bytes'
    )

    mockedFetch.mockResolvedValueOnce(new Response('x'.repeat(11)))
    await expect(createClient(1000, 10).request('https://example.test')).rejects.toThrow(
      'exceeds 10 bytes'
    )
  })

  it.each(['not-a-number', '1e3', '9007199254740992'])(
    'rejects an invalid Content-Length before reading: %s',
    async contentLength => {
      mockedFetch.mockResolvedValue(
        new Response('small', { headers: { 'Content-Length': contentLength } })
      )
      await expect(createClient().request('https://example.test')).rejects.toThrow(
        'invalid Content-Length'
      )
    }
  )

  it('bounds async-iterable response bodies and destroys a failed stream', async () => {
    const destroy = jest.fn()
    const body = {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        yield 'first'
        throw new Error('stream failed')
      },
      destroy
    }
    mockedFetch.mockResolvedValue({
      body,
      headers: new Headers(),
      status: 200,
      statusText: 'OK'
    } as unknown as Response)

    await expect(createClient().request('https://example.test')).rejects.toThrow('stream failed')
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('supports bodyless response implementations without a stream', async () => {
    mockedFetch.mockResolvedValue({
      body: null,
      headers: new Headers({ 'Content-Type': 'text/plain' }),
      status: 200,
      statusText: 'OK',
      arrayBuffer: async () => new TextEncoder().encode('fallback').buffer
    } as unknown as Response)

    const response = await createClient().request('https://example.test')
    await expect(response.text()).resolves.toBe('fallback')
  })

  it('refuses redirects and insecure non-local HTTP destinations', async () => {
    mockedFetch.mockResolvedValue(new Response('{}'))
    await createClient().request('https://example.test', { redirect: 'follow' })
    expect(mockedFetch.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: 'error' }))

    await expect(createClient().request('http://example.test')).rejects.toThrow('require HTTPS')
  })
})
