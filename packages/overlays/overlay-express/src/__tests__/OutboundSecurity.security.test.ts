import { describe, expect, it, jest } from '@jest/globals'
import {
  fetchWithDeadline,
  readBoundedJson,
  readBoundedText,
  secureServiceFetch,
  snapshotOwnDataRecord
} from '../OutboundSecurity.js'

describe('outbound security boundaries', () => {
  it('snapshots only bounded own data properties without invoking accessors', () => {
    const getter = jest.fn(() => 'secret')
    const accessor = Object.defineProperty({}, 'token', { enumerable: true, get: getter })

    for (const value of [null, [], Object.create({ inherited: true })]) {
      expect(() => snapshotOwnDataRecord(value as any, 'config')).toThrow('plain object')
    }
    expect(() =>
      snapshotOwnDataRecord(
        Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`key${index}`, index])),
        'config'
      )
    ).toThrow('invalid or excessive properties')
    expect(() => snapshotOwnDataRecord({ [Symbol('secret')]: true }, 'config')).toThrow(
      'invalid or excessive properties'
    )
    expect(() => snapshotOwnDataRecord(accessor, 'config')).toThrow(
      'config.token must be an own data property'
    )
    expect(getter).not.toHaveBeenCalled()

    const input = Object.assign(Object.create(null), { endpoint: 'https://provider.example' })
    const result = snapshotOwnDataRecord(input, 'config')
    input.endpoint = 'https://attacker.example'
    expect(result).toEqual({ endpoint: 'https://provider.example' })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it.each([
    ['', 'bounded URL string'],
    [`https://${'a'.repeat(2049)}.example`, 'bounded URL string'],
    ['https://provider.example\n', 'bounded URL string'],
    ['http://provider.example', 'credential-free HTTPS'],
    ['https://user:pass@provider.example', 'credential-free HTTPS'],
    ['https://provider.example?token=secret', 'credential-free HTTPS'],
    ['https://provider.example/#fragment', 'credential-free HTTPS']
  ])('rejects an unsafe provider endpoint before transport: %s', (endpoint, message) => {
    expect(() => secureServiceFetch(endpoint)).toThrow(message)
  })

  it('validates transport overrides and confines the private-host opt-out', () => {
    expect(() => secureServiceFetch('https://provider.example', 'bad' as any)).toThrow(
      'fetch override must be a function'
    )
    expect(() => secureServiceFetch('https://provider.example', undefined, 'yes' as any)).toThrow(
      'allowPrivateHosts must be a boolean'
    )

    const supplied = jest.fn<typeof fetch>()
    expect(secureServiceFetch('https://provider.example/', supplied)).toEqual({
      baseUrl: 'https://provider.example',
      fetchImpl: supplied
    })
    expect(secureServiceFetch('http://127.0.0.1:8080/', undefined, true)).toEqual({
      baseUrl: 'http://127.0.0.1:8080',
      fetchImpl: fetch
    })
  })

  it('links caller cancellation and always forces redirect rejection', async () => {
    const supplied = new AbortController()
    supplied.abort()
    const abortedFetch = jest.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(true)
      expect(init?.redirect).toBe('error')
      throw new Error('caller aborted')
    })

    await expect(
      fetchWithDeadline(abortedFetch, 'https://provider.example', { signal: supplied.signal }, 20)
    ).rejects.toThrow('caller aborted')

    const successfulFetch = jest.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(false)
      expect(init?.redirect).toBe('error')
      return new Response('ok')
    })
    const response = await fetchWithDeadline(successfulFetch, 'https://provider.example')
    expect(response).toBeInstanceOf(Response)
  })

  it('reports an internal deadline without disguising caller aborts', async () => {
    const stalledFetch = jest.fn<typeof fetch>(
      async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    )

    await expect(
      fetchWithDeadline(stalledFetch, 'https://provider.example', {}, 5)
    ).rejects.toThrow('timed out after 5ms')
  })

  it.each(['-1', '01', '1.5', 'not-a-number', '65'])(
    'rejects an invalid or oversized declared response length: %s',
    async declared => {
      const cancel = jest.fn(async () => {})
      const response = {
        headers: new Headers({ 'content-length': declared }),
        body: { cancel },
        text: jest.fn(async () => 'not read')
      } as any

      await expect(readBoundedText(response, 64, 'Provider response')).rejects.toThrow(
        'exceeds 64 bytes'
      )
      expect(cancel).toHaveBeenCalledTimes(1)
      expect(response.text).not.toHaveBeenCalled()
    }
  )

  it('bounds the bodyless fallback by encoded bytes', async () => {
    const bodyless = (text: string): Response =>
      ({ headers: new Headers(), body: null, text: async () => text }) as any

    await expect(readBoundedText(bodyless('ok'), 2, 'Provider response')).resolves.toBe('ok')
    await expect(readBoundedText(bodyless('££'), 3, 'Provider response')).rejects.toThrow(
      'exceeds 3 bytes'
    )
  })

  it('bounds streamed bytes, decoding validity, and read duration', async () => {
    const oversized = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]))
          controller.enqueue(new Uint8Array([3]))
          controller.close()
        }
      })
    )
    await expect(readBoundedText(oversized, 2, 'Provider response')).rejects.toThrow(
      'exceeds 2 bytes'
    )

    const invalidUtf8 = new Response(new Uint8Array([0xc3, 0x28]))
    await expect(readBoundedText(invalidUtf8, 2, 'Provider response')).rejects.toThrow()

    const stalled = new Response(new ReadableStream<Uint8Array>({ start() {} }))
    await expect(readBoundedText(stalled, 64, 'Provider response', 5)).rejects.toThrow(
      'Provider response timed out'
    )
  })

  it('requires bounded non-empty JSON media responses', async () => {
    const cancelled = jest.fn(async () => {})
    const nonJson = {
      headers: new Headers({ 'content-type': 'text/html' }),
      body: { cancel: cancelled }
    } as any
    await expect(readBoundedJson(nonJson, 64, 'Provider response')).rejects.toThrow('is not JSON')
    expect(cancelled).toHaveBeenCalledTimes(1)

    await expect(
      readBoundedJson(
        new Response('', { headers: { 'content-type': 'application/json' } }),
        64,
        'Provider response'
      )
    ).rejects.toThrow('is empty')
    await expect(
      readBoundedJson(
        new Response('{', { headers: { 'content-type': 'application/json' } }),
        64,
        'Provider response'
      )
    ).rejects.toThrow('malformed JSON')
    await expect(
      readBoundedJson(
        new Response('{"ok":true}', {
          headers: { 'content-type': 'application/problem+json; charset=utf-8' }
        }),
        64,
        'Provider response'
      )
    ).resolves.toEqual({ ok: true })
  })
})
