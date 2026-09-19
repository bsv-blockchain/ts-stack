import { describe, expect, it, vi } from 'vitest'

import { PayerWallet } from '../../test/support/wallets.js'
import {
  AuthFetchTransport,
  TransportStatusError,
  TransportTimeoutError,
  nonPayingWallet
} from './transport.js'

const params = {
  version: 1,
  host: `02${'ab'.repeat(32)}`,
  threshold: 3,
  topK: 5,
  floorFeeSats: 1000,
  minPayoutSats: 1,
  maxQueryTtlMs: 60_000,
  classes: ['overlay-lookup']
}

describe('nonPayingWallet', () => {
  it('refuses to create or sign actions and forwards everything else', async () => {
    const wallet = new PayerWallet()
    const facade = nonPayingWallet(wallet)
    await expect(facade.createAction({ description: 'HTTP 402 payment' })).rejects.toThrow(
      'never pays'
    )
    await expect(facade.signAction({ reference: 'cmVm', spends: {} })).rejects.toThrow('never pays')
    expect(wallet.actions).toEqual([])
    expect((await facade.getPublicKey({ identityKey: true })).publicKey).toBe(wallet.identityKey)
  })
})

describe('AuthFetchTransport.getParams', () => {
  it('reads /economic/params with a plain fetch', async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request) => new Response(JSON.stringify(params))
    )
    const transport = new AuthFetchTransport(new PayerWallet(), { fetch: fetchMock })
    expect(await transport.getParams('https://host.example', 1000)).toEqual(params)
    expect(fetchMock.mock.calls[0][0]).toBe('https://host.example/economic/params')
  })

  it('rejects hosts without the market, malformed bodies, and oversized bodies', async () => {
    const respond = (response: Response): AuthFetchTransport =>
      new AuthFetchTransport(new PayerWallet(), { fetch: vi.fn(async () => response) })
    await expect(
      respond(new Response('not found', { status: 404 })).getParams('https://h.example', 1000)
    ).rejects.toThrow('status 404')
    await expect(
      respond(new Response('{"version":2}')).getParams('https://h.example', 1000)
    ).rejects.toThrow(TypeError)
    await expect(
      respond(new Response('x'.repeat(70_000))).getParams('https://h.example', 1000)
    ).rejects.toThrow('too large')
  })

  it('reports a non-200 answer as a TransportStatusError carrying the status', async () => {
    const transport = new AuthFetchTransport(new PayerWallet(), {
      fetch: vi.fn(async () => new Response('gone', { status: 410 }))
    })
    await expect(transport.getParams('https://h.example', 1000)).rejects.toBeInstanceOf(
      TransportStatusError
    )
    await expect(transport.getParams('https://h.example', 1000)).rejects.toMatchObject({
      status: 410,
      message: 'https://h.example answered params with status 410'
    })
  })

  it('rejects a streamed params body once the byte cap is crossed, without draining the rest', async () => {
    let pulls = 0
    let cancelled = false
    const chunk = new Uint8Array(20_000).fill(97)
    const totalChunksAvailable = 10
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > totalChunksAvailable) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
      cancel() {
        cancelled = true
      }
    })
    const fetchMock = vi.fn(async () => new Response(stream))
    const transport = new AuthFetchTransport(new PayerWallet(), { fetch: fetchMock })
    await expect(transport.getParams('https://h.example', 1000)).rejects.toThrow('too large')
    expect(cancelled).toBe(true)
    expect(pulls).toBeLessThan(totalChunksAvailable)
  })

  it('rejects an oversized content-length header without reading the body', async () => {
    // A `ReadableStream` fills its own internal queue up to its high-water mark as soon as it is
    // constructed, independent of any consumer, so `pull` firing once proves nothing here. Whether
    // the transport itself ever consumed the body is `body.locked` (set only by `getReader()`) and
    // `bodyUsed` (set only once that reader is actually read from).
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(10))
        controller.close()
      }
    })
    const response = new Response(stream, { headers: { 'content-length': '100000' } })
    const fetchMock = vi.fn(async () => response)
    const transport = new AuthFetchTransport(new PayerWallet(), { fetch: fetchMock })
    await expect(transport.getParams('https://h.example', 1000)).rejects.toThrow('too large')
    expect(response.body?.locked).toBe(false)
    expect(response.bodyUsed).toBe(false)
  })

  it('rejects a body whose UTF-8 byte length exceeds the cap while its character count does not', async () => {
    const body = '€'.repeat(30_000)
    expect(body.length).toBeLessThan(65_536)
    const fetchMock = vi.fn(async () => new Response(body))
    const transport = new AuthFetchTransport(new PayerWallet(), { fetch: fetchMock })
    await expect(transport.getParams('https://h.example', 1000)).rejects.toThrow('too large')
  })

  it('times out', async () => {
    vi.useFakeTimers()
    try {
      const hanging = vi.fn(
        async (_url: string | URL | Request, init?: RequestInit) =>
          await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
          })
      )
      const transport = new AuthFetchTransport(new PayerWallet(), { fetch: hanging })
      const pending = transport.getParams('https://h.example', 1000)
      const assertion = expect(pending).rejects.toBeInstanceOf(TransportTimeoutError)
      await vi.advanceTimersByTimeAsync(1000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
