import type { TelemetryEvent, WalletInterface } from '@bsv/sdk'
import { StorageClient } from '../StorageClient'

describe('StorageClient telemetry', () => {
  it('propagates traceparent and records serialization, HTTP, read, and parse phases', async () => {
    const events: TelemetryEvent[] = []
    let nextSpanId = 1
    let requestInit: RequestInit | undefined
    const client = new StorageClient(
      {} as WalletInterface,
      'https://storage.example.test/rpc',
      {
        telemetry: {
          sink: {
            capture: event => events.push(event)
          },
          traceIdFactory: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          spanIdFactory: () => (nextSpanId++).toString(16).padStart(16, '0')
        }
      }
    )
    Reflect.set(client, 'authClient', {
      fetch: jest.fn(async (_url: string, init: RequestInit) => {
        requestInit = init
        return new Response(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            result: { available: true }
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      })
    })

    const result = await Reflect.get(client, 'rpcCall').call(
      client,
      'isAvailable',
      [{ userId: 1 }]
    )

    expect(result).toEqual({ available: true })
    expect((requestInit?.headers as Record<string, string>).traceparent).toMatch(
      /^00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-[0-9a-f]{16}-01$/
    )
    const byName = new Map(events.map(event => [event.name, event]))
    expect([
      'wallet.storage.request.serialize',
      'wallet.storage.http',
      'wallet.storage.response.read',
      'wallet.storage.response.parse',
      'wallet.storage.rpc'
    ].every(name => byName.has(name))).toBe(true)
    const rpc = byName.get('wallet.storage.rpc')!
    expect(rpc).toMatchObject({
      type: 'span',
      traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      spanStatus: 'ok',
      attributes: {
        'rpc.method': 'isAvailable',
        'http.response.status_code': 200
      }
    })
    expect(byName.get('wallet.storage.http')?.parentSpanId).toBe(rpc.spanId)
    expect(JSON.stringify(events)).not.toContain('userId')
    expect(JSON.stringify(events)).not.toContain('available')
  })

  it('preserves caller logging while reporting remote and protocol failures', async () => {
    const events: TelemetryEvent[] = []
    const client = new StorageClient(
      {} as WalletInterface,
      'https://storage.example.test/rpc',
      {
        telemetry: {
          sink: { capture: event => events.push(event) }
        }
      }
    )
    const logger = {
      indent: 2,
      group: jest.fn(),
      merge: jest.fn(),
      groupEnd: jest.fn(),
      error: jest.fn()
    }
    const params: unknown[] = [{ userId: 1 }, { logger }]
    const fetch = jest.fn()
    Reflect.set(client, 'authClient', { fetch })

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { log: { logs: [] }, available: true }
    })))
    await expect(
      Reflect.get(client, 'rpcCall').call(client, 'isAvailable', params)
    ).resolves.toMatchObject({ available: true })
    expect(logger.group).toHaveBeenCalled()
    expect(logger.merge).toHaveBeenCalledWith({ logs: [] })
    expect(logger.groupEnd).toHaveBeenCalled()
    expect((params[1] as { logger: unknown }).logger).toBe(logger)

    fetch.mockRejectedValueOnce(new Error('fetch unavailable'))
    await expect(
      Reflect.get(client, 'rpcCall').call(client, 'isAvailable', params)
    ).rejects.toThrow('fetch unavailable')
    expect((params[1] as { logger: unknown }).logger).toBe(logger)

    fetch.mockResolvedValueOnce(new Response('unavailable', {
      status: 503,
      statusText: 'Service Unavailable'
    }))
    await expect(
      Reflect.get(client, 'rpcCall').call(client, 'isAvailable', params)
    ).rejects.toThrow('network error 503')

    fetch.mockResolvedValueOnce(new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 4,
      error: {
        code: 1,
        message: 'remote failure',
        name: 'Error'
      }
    })))
    await expect(
      Reflect.get(client, 'rpcCall').call(client, 'isAvailable', params)
    ).rejects.toThrow('remote failure')

    expect(events.filter(event => event.name === 'wallet.storage.rpc')).toHaveLength(4)
    expect(events.filter(event => event.name === 'wallet.storage.rpc').slice(1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ spanStatus: 'error' })
      ])
    )
  })
})
