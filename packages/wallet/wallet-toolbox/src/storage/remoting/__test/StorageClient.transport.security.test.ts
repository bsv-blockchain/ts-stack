import type { WalletInterface } from '@bsv/sdk'
import { StorageClient } from '../StorageClient'
import { StorageClient as StorageMobile } from '../StorageMobile'

const SERVER_IDENTITY_KEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const OTHER_IDENTITY_KEY = '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'

const clients = [
  ['full', StorageClient],
  ['mobile', StorageMobile]
] as const

function response(
  body: unknown,
  identityKey: string | undefined = SERVER_IDENTITY_KEY,
  init: ResponseInit = {}
): Response {
  const headers = new Headers(init.headers)
  if (identityKey !== undefined) headers.set('x-bsv-auth-identity-key', identityKey)
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { ...init, headers })
}

function requestId(init?: RequestInit): number {
  return JSON.parse(String(init?.body)).id
}

describe.each(clients)('StorageClient authenticated transport (%s)', (_name, Client) => {
  test('rejects an ordinary unauthenticated HTTP response', async () => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test')
    Reflect.set(client, 'authClient', {
      fetch: jest.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(JSON.stringify({ jsonrpc: '2.0', id: requestId(init), result: {} }))
      )
    })

    await expect(Reflect.get(client, 'rpcCall').call(client, 'isAvailable', [])).rejects.toThrow(
      'not mutually authenticated'
    )
  })

  test('pins the first authenticated peer and rejects identity changes', async () => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test')
    const fetch = jest
      .fn()
      .mockImplementationOnce(async (_url: string, init?: RequestInit) =>
        response({ jsonrpc: '2.0', id: requestId(init), result: 1 })
      )
      .mockImplementationOnce(async (_url: string, init?: RequestInit) =>
        response({ jsonrpc: '2.0', id: requestId(init), result: 2 }, OTHER_IDENTITY_KEY)
      )
    Reflect.set(client, 'authClient', { fetch })
    const rpcCall = Reflect.get(client, 'rpcCall').bind(client)

    await expect(rpcCall('first', [])).resolves.toBe(1)
    await expect(rpcCall('second', [])).rejects.toThrow('identity changed')
  })

  test('honors an independently pinned server identity', async () => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test', {
      serverIdentityKey: SERVER_IDENTITY_KEY
    })
    Reflect.set(client, 'authClient', {
      fetch: jest.fn(async (_url: string, init?: RequestInit) =>
        response({ jsonrpc: '2.0', id: requestId(init), result: {} }, OTHER_IDENTITY_KEY)
      )
    })

    await expect(Reflect.get(client, 'rpcCall').call(client, 'isAvailable', [])).rejects.toThrow('identity changed')
  })

  test.each([
    ['wrong version', (id: number) => ({ jsonrpc: '1.0', id, result: true })],
    ['wrong request id', (id: number) => ({ jsonrpc: '2.0', id: id + 1, result: true })],
    ['result and error', (id: number) => ({ jsonrpc: '2.0', id, result: true, error: {} })],
    ['neither result nor error', (id: number) => ({ jsonrpc: '2.0', id })],
    ['an extra field', (id: number) => ({ jsonrpc: '2.0', id, result: true, extra: true })],
    ['a non-object error', (id: number) => ({ jsonrpc: '2.0', id, error: null })]
  ])('rejects a response with %s', async (_case, envelope) => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test')
    Reflect.set(client, 'authClient', {
      fetch: jest.fn(async (_url: string, init?: RequestInit) => response(envelope(requestId(init))))
    })

    await expect(Reflect.get(client, 'rpcCall').call(client, 'isAvailable', [])).rejects.toThrow(
      'invalid JSON-RPC response'
    )
  })

  test('rejects an advertised storage identity that differs from its independent pin', async () => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test', {
      storageIdentityKey: SERVER_IDENTITY_KEY
    })
    Reflect.set(client, 'authClient', {
      fetch: jest.fn(async (_url: string, init?: RequestInit) =>
        response({
          jsonrpc: '2.0',
          id: requestId(init),
          result: { storageIdentityKey: OTHER_IDENTITY_KEY }
        })
      )
    })

    await expect(client.makeAvailable()).rejects.toThrow('does not match the configured storage identity')
    expect(client.isAvailable()).toBe(false)
  })

  test('accepts and caches a distinct storage identity from the authenticated peer', async () => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test')
    const fetch = jest.fn(async (_url: string, init?: RequestInit) =>
      response({
        jsonrpc: '2.0',
        id: requestId(init),
        result: { storageIdentityKey: OTHER_IDENTITY_KEY }
      })
    )
    Reflect.set(client, 'authClient', { fetch })

    await expect(client.makeAvailable()).resolves.toMatchObject({ storageIdentityKey: OTHER_IDENTITY_KEY })
    await expect(client.makeAvailable()).resolves.toMatchObject({ storageIdentityKey: OTHER_IDENTITY_KEY })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  test.each([
    [{ storageIdentityKey: SERVER_IDENTITY_KEY, storageName: 'unsafe\nname' }],
    [{ storageIdentityKey: SERVER_IDENTITY_KEY, maxOutputScript: Number.MAX_SAFE_INTEGER }],
    [{ storageIdentityKey: SERVER_IDENTITY_KEY, chain: 'mainnet' }],
    [{ storageIdentityKey: SERVER_IDENTITY_KEY, syncCheckpointVersion: 2 }]
  ])('rejects malformed authenticated storage settings %p', async result => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test')
    Reflect.set(client, 'authClient', {
      fetch: jest.fn(async (_url: string, init?: RequestInit) =>
        response({ jsonrpc: '2.0', id: requestId(init), result })
      )
    })

    await expect(client.makeAvailable()).rejects.toThrow('invalid settings')
    expect(client.isAvailable()).toBe(false)
  })

  test('does not reflect a remote status phrase or response body in network errors', async () => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test')
    Reflect.set(client, 'authClient', {
      fetch: jest.fn(async () =>
        response('remote-secret-body', SERVER_IDENTITY_KEY, {
          status: 503,
          statusText: 'remote-secret-phrase'
        })
      )
    })

    const call = Reflect.get(client, 'rpcCall').call(client, 'isAvailable', []) as Promise<unknown>
    await expect(call).rejects.toThrow('network error 503')
    await expect(call).rejects.not.toThrow(/remote-secret/)
  })

  test('fails before sending after the request identifier space is exhausted', async () => {
    const client = new Client({} as WalletInterface, 'https://storage.example.test')
    const fetch = jest.fn()
    Reflect.set(client, 'authClient', { fetch })
    Reflect.set(client, 'nextId', Number.MAX_SAFE_INTEGER + 1)

    await expect(Reflect.get(client, 'rpcCall').call(client, 'isAvailable', [])).rejects.toThrow(
      'identifier space exhausted'
    )
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('StorageClient remote diagnostic validation', () => {
  test('bounds and validates authenticated remote log data before merging it', async () => {
    const client = new StorageClient({} as WalletInterface, 'https://storage.example.test')
    const logger = {
      indent: 0,
      group: jest.fn(),
      groupEnd: jest.fn(),
      log: jest.fn(),
      error: jest.fn(),
      merge: jest.fn()
    }
    Reflect.set(client, 'authClient', {
      fetch: jest.fn(async (_url: string, init?: RequestInit) =>
        response({
          jsonrpc: '2.0',
          id: requestId(init),
          result: {
            value: true,
            log: {
              logs: [
                {
                  when: 1,
                  indent: 0,
                  log: 'x'.repeat(4097)
                }
              ]
            }
          }
        })
      )
    })

    await expect(Reflect.get(client, 'rpcCall').call(client, 'isAvailable', [{}, { logger }])).rejects.toThrow(
      'invalid remote log data'
    )
    expect(logger.merge).not.toHaveBeenCalled()
  })
})

describe('StorageClient endpoint and pin validation', () => {
  test.each([
    [' http://localhost:8042'],
    ['https://storage.example.test\u0000'],
    [`https://storage.example.test/${'a'.repeat(8192)}`]
  ])('rejects a non-exact or excessive endpoint %p', endpoint => {
    expect(() => new StorageClient({} as WalletInterface, endpoint)).toThrow('exact bounded URL')
  })

  test('rejects a malformed independent identity pin', () => {
    expect(
      () =>
        new StorageClient({} as WalletInterface, 'https://storage.example.test', {
          serverIdentityKey: `${SERVER_IDENTITY_KEY.slice(0, -1)}A`
        })
    ).toThrow('identity key must be canonical')
  })

  test('rejects a malformed independent storage identity pin', () => {
    expect(
      () =>
        new StorageClient({} as WalletInterface, 'https://storage.example.test', {
          storageIdentityKey: 'x'.repeat(131)
        })
    ).toThrow('storage identity must be an exact bounded identifier')
  })
})
