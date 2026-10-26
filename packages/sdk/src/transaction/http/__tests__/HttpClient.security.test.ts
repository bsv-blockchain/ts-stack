import { BinaryFetchClient } from '../BinaryFetchClient.js'
import { FetchHttpClient } from '../FetchHttpClient.js'
import { executeNodejsRequest } from '../NodejsHttpRequestUtils.js'

describe('transaction HTTP client security boundaries', () => {
  it('prohibits redirects and propagates a live abort signal', async () => {
    const fetcher = jest.fn(
      async (_url: string, options: { redirect?: string; signal?: AbortSignal }) => {
        expect(options.redirect).toBe('error')
        expect(options.signal).toBeInstanceOf(AbortSignal)
        return Response.json({ ok: true })
      }
    )
    const client = new FetchHttpClient(fetcher)
    await expect(client.request('https://api.example', { method: 'GET' })).resolves.toMatchObject({
      data: { ok: true }
    })
  })

  it('bounds text and binary fetch responses and requires strict UTF-8', async () => {
    const oversized = new Response('x', {
      headers: { 'Content-Length': String(8 * 1024 * 1024 + 1) }
    })
    const textClient = new FetchHttpClient(async () => oversized)
    await expect(textClient.request('https://api.example', {})).rejects.toThrow('size limit')

    const binaryClient = new BinaryFetchClient(async () => new Response(Uint8Array.of(0xff)), {
      maxResponseBytes: 1
    })
    await expect(binaryClient.request('https://api.example', {})).rejects.toThrow('UTF-8')
  })

  it('enforces a total fetch deadline through response acquisition', async () => {
    const client = new FetchHttpClient(
      async (_url, options) =>
        await new Promise<Response>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true
          })
        }),
      { timeoutMs: 5 }
    )
    await expect(client.request('https://api.example', {})).rejects.toMatchObject({
      name: 'TimeoutError'
    })
  })

  it('rejects malformed JSON from the legacy Node adapter without throwing globally', async () => {
    const https = nodeTransport('{not-json', {
      'content-type': 'application/json',
      'content-length': '9'
    })
    await expect(
      executeNodejsRequest(https, 'https://api.example', {}, JSON.stringify)
    ).rejects.toBeInstanceOf(SyntaxError)
  })

  it('rejects oversized legacy Node responses before buffering them', async () => {
    const https = nodeTransport('', {
      'content-type': 'text/plain',
      'content-length': String(8 * 1024 * 1024 + 1)
    })
    await expect(
      executeNodejsRequest(https, 'https://api.example', {}, JSON.stringify)
    ).rejects.toThrow('size limit')
  })
})

function nodeTransport(
  body: string,
  headers: Record<string, string>
): {
  request: (
    url: string,
    options: unknown,
    callback: (response: unknown) => void
  ) => {
    write(): void
    end(): void
    on(): void
    destroy(): void
    setTimeout(): void
  }
} {
  return {
    request(_url, _options, callback) {
      const response = {
        statusCode: 200,
        statusMessage: 'OK',
        headers,
        destroy: jest.fn(),
        on(event: string, listener: (value?: string) => void) {
          if (event === 'data' && body !== '') queueMicrotask(() => listener(body))
          if (event === 'end') queueMicrotask(() => listener())
        }
      }
      callback(response)
      return {
        write() {},
        end() {},
        on() {},
        destroy() {},
        setTimeout() {}
      }
    }
  }
}
