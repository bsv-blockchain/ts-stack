import type { TelemetryEvent, WalletInterface } from '@bsv/sdk'
import { StorageClient } from '../StorageClient'
import { StorageClient as StorageMobile } from '../StorageMobile'

const SERVER_IDENTITY_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const AUTHENTICATED_HEADERS = { 'x-bsv-auth-identity-key': SERVER_IDENTITY_KEY }

describe('StorageClient telemetry', () => {
  it.each([
    ['browser and Node', StorageClient, false],
    ['browser and Node with binary requests', StorageClient, true],
    ['mobile', StorageMobile, false],
    ['mobile with binary requests', StorageMobile, true]
  ])(
    'keeps %s trace correlation local without changing authenticated request headers',
    async (_name, Client, binaryRequests) => {
      const events: TelemetryEvent[] = []
      let nextSpanId = 1
      let requestInit: RequestInit | undefined
      const client = new Client({} as WalletInterface, 'https://storage.example.test/rpc', {
        binaryRequests,
        telemetry: {
          sink: {
            capture: event => events.push(event)
          },
          traceIdFactory: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          spanIdFactory: () => (nextSpanId++).toString(16).padStart(16, '0')
        }
      })
      Reflect.set(client, 'serverSupportsBinary', binaryRequests)
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
              headers: { 'Content-Type': 'application/json', ...AUTHENTICATED_HEADERS }
            }
          )
        })
      })

      const result = await Reflect.get(client, 'rpcCall').call(client, 'isAvailable', [{ userId: 1 }])

      expect(result).toEqual({ available: true })
      const requestHeaders = requestInit?.headers
      expect(requestHeaders).toBeDefined()
      expect((requestHeaders as Record<string, string>).traceparent).toBeUndefined()
      const byName = new Map(events.map(event => [event.name, event]))
      expect(
        [
          'wallet.storage.request.serialize',
          'wallet.storage.http',
          'wallet.storage.response.read',
          'wallet.storage.response.parse',
          'wallet.storage.rpc'
        ].every(name => byName.has(name))
      ).toBe(true)
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
    }
  )

  describe.each([
    ['browser and Node', StorageClient],
    ['mobile', StorageMobile]
  ])('%s callback failures', (_name, Client) => {
    it.each([false, true])('preserves response-read rejection with telemetry enabled=%s', async enabled => {
      const events: TelemetryEvent[] = []
      const client = new Client(
        {} as WalletInterface,
        'https://storage.example.test/rpc',
        enabled ? { telemetry: { sink: { capture: (event: TelemetryEvent) => events.push(event) } } } : {}
      )
      const error = new Error('response read failed')
      const text = jest.fn(() => {
        throw error
      })
      Reflect.set(client, 'authClient', {
        fetch: jest.fn(async () => ({
          ok: true,
          status: 200,
          headers: new Headers(AUTHENTICATED_HEADERS),
          text
        }))
      })

      const result = Reflect.get(client, 'rpcCall').call(client, 'isAvailable', [{ userId: 1 }])
      expect(result).toBeInstanceOf(Promise)
      await expect(result).rejects.toBe(error)
      expect(text).toHaveBeenCalledTimes(1)
      if (enabled) {
        expect(events.filter(event => event.spanStatus === 'error').map(event => event.name)).toEqual([
          'wallet.storage.response.read',
          'wallet.storage.rpc'
        ])
      } else {
        expect(events).toEqual([])
      }
    })
  })

  it('preserves caller logging while reporting remote and protocol failures', async () => {
    const events: TelemetryEvent[] = []
    const client = new StorageClient({} as WalletInterface, 'https://storage.example.test/rpc', {
      telemetry: {
        sink: { capture: event => events.push(event) }
      }
    })
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

    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { log: { logs: [] }, available: true }
        }),
        { headers: AUTHENTICATED_HEADERS }
      )
    )
    await expect(Reflect.get(client, 'rpcCall').call(client, 'isAvailable', params)).resolves.toMatchObject({
      available: true
    })
    expect(logger.group).toHaveBeenCalled()
    expect(logger.merge).toHaveBeenCalledWith({ logs: [] })
    expect(logger.groupEnd).toHaveBeenCalled()
    expect((params[1] as { logger: unknown }).logger).toBe(logger)

    ;(logger as { indent?: number }).indent = undefined
    fetch.mockRejectedValueOnce(new Error('fetch unavailable'))
    await expect(Reflect.get(client, 'rpcCall').call(client, 'isAvailable', params)).rejects.toThrow(
      'fetch unavailable'
    )
    expect((params[1] as { logger: unknown }).logger).toBe(logger)

    fetch.mockResolvedValueOnce(
      new Response('unavailable', {
        status: 503,
        statusText: 'Service Unavailable',
        headers: AUTHENTICATED_HEADERS
      })
    )
    await expect(Reflect.get(client, 'rpcCall').call(client, 'isAvailable', params)).rejects.toThrow(
      'network error 503'
    )

    fetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          error: {
            code: 1,
            message: 'remote failure',
            name: 'Error'
          }
        }),
        { headers: AUTHENTICATED_HEADERS }
      )
    )
    await expect(Reflect.get(client, 'rpcCall').call(client, 'isAvailable', params)).rejects.toThrow('remote failure')

    expect(events.filter(event => event.name === 'wallet.storage.rpc')).toHaveLength(4)
    expect(events.filter(event => event.name === 'wallet.storage.rpc').slice(1)).toEqual(
      expect.arrayContaining([expect.objectContaining({ spanStatus: 'error' })])
    )
  })
})
