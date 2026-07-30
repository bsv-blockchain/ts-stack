import { type Request, type Response } from 'express'
import { TelemetryEvent, WalletLoggerInterface } from '@bsv/sdk'
import { WalletLogger } from '../../../WalletLogger'
import { SyncChunk } from '../../../sdk/WalletStorage.interfaces'
import { StorageServer, WalletStorageServerOptions } from '../StorageServer'
import { BINARY_ENCODING, BINARY_ENCODING_HEADER, BINARY_REQUEST_ENCODING_HEADER } from '../BinaryJson'

interface CapturedResponse {
  body?: any
  headers: Record<string, string>
  response: Response
  statusCode: number
}

function makeResponse(): CapturedResponse {
  const captured: CapturedResponse = {
    headers: {},
    response: undefined as unknown as Response,
    statusCode: 200
  }
  const response = {
    set: (name: string, value: string) => {
      captured.headers[name] = value
      return response
    },
    status: (statusCode: number) => {
      captured.statusCode = statusCode
      return response
    },
    json: (body: unknown) => {
      captured.body = body
      return response
    }
  } as unknown as Response
  captured.response = response
  return captured
}

function makeRequest(
  body: unknown,
  headers: Record<string, string | string[]> = {},
  identityKey: string = 'alice'
): Request {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
  )
  return {
    auth: { identityKey },
    body,
    header: (name: string) => normalizedHeaders[name.toLowerCase()],
    headers: normalizedHeaders,
    ip: '127.0.0.1',
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' }
  } as unknown as Request
}

function makeServer(
  storageOverrides: Record<string, unknown> = {},
  optionsOverrides: Partial<WalletStorageServerOptions> = {}
): StorageServer {
  const storage = {
    findOrInsertUser: jest.fn(async (identityKey: string) => ({
      user: {
        activeStorage: 'storage-key',
        identityKey,
        userId: 7
      }
    })),
    getCapabilities: jest.fn(async () => ({ capabilities: [] })),
    getSettings: jest.fn(() => ({ storageIdentityKey: 'storage-key' })),
    processSyncChunk: jest.fn(async () => ({
      done: true,
      inserts: 0,
      maxUpdated_at: undefined,
      updates: 0
    })),
    ...storageOverrides
  }
  return new StorageServer(storage as any, {
    port: 0,
    wallet: { chain: 'test' } as any,
    monetize: false,
    ...optionsOverrides
  })
}

async function invoke<T>(server: StorageServer, method: string, ...args: any[]): Promise<T> {
  return (await Reflect.get(server, method).call(server, ...args)) as T
}

const emptyChunk: SyncChunk = {
  fromStorageIdentityKey: 'from',
  toStorageIdentityKey: 'to',
  userIdentityKey: 'alice'
}

describe('StorageServer JSON-RPC boundary', () => {
  let consoleLog: jest.SpyInstance
  let consoleError: jest.SpyInstance

  beforeEach(() => {
    consoleLog = jest.spyOn(console, 'log').mockImplementation(() => {})
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleLog.mockRestore()
    consoleError.mockRestore()
  })

  test('negotiates binary JSON, records trace context, and dispatches a valid RPC', async () => {
    const server = makeServer()
    const captured = makeResponse()
    const request = makeRequest(
      {
        jsonrpc: '2.0',
        method: 'getSettings',
        params: [],
        id: 1
      },
      {
        [BINARY_ENCODING_HEADER]: BINARY_ENCODING,
        [BINARY_REQUEST_ENCODING_HEADER]: BINARY_ENCODING,
        'X-Cloud-Trace-Context': 'trace-id/123'
      }
    )

    await invoke(server, 'handleRpcRequest', request, captured.response)

    expect(captured.statusCode).toBe(200)
    expect(captured.headers[BINARY_ENCODING_HEADER]).toBe(BINARY_ENCODING)
    expect(captured.headers['X-Content-Type-Options']).toBe('nosniff')
    expect(captured.body).toEqual({
      jsonrpc: '2.0',
      result: { storageIdentityKey: 'storage-key' },
      id: 1
    })
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('trace-id'))
  })

  test('correlates the HTTP, authorization, handler, and RPC spans', async () => {
    const events: TelemetryEvent[] = []
    let nextSpanId = 1
    const server = makeServer(
      {},
      {
        logRpcRequests: true,
        telemetry: {
          sink: { capture: event => events.push(event) },
          spanIdFactory: () => (nextSpanId++).toString(16).padStart(16, '0')
        }
      }
    )
    const captured = makeResponse()
    const request = makeRequest(
      {
        jsonrpc: '2.0',
        method: 'getSettings',
        params: [],
        id: 8
      },
      {
        traceparent: '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01'
      }
    )
    Reflect.get(server, 'telemetry').bindContext(request, {
      traceId: '0123456789abcdef0123456789abcdef',
      spanId: 'fedcba9876543210',
      traceFlags: 1
    })

    await invoke(server, 'handleRpcRequest', request, captured.response)

    const byName = new Map(events.map(event => [event.name, event]))
    expect(byName.get('wallet.storage.rpc')).toMatchObject({
      traceId: '0123456789abcdef0123456789abcdef',
      parentSpanId: 'fedcba9876543210',
      spanStatus: 'ok',
      attributes: { 'rpc.method': 'getSettings' }
    })
    expect(byName.get('wallet.storage.authorize')?.parentSpanId).toBe(byName.get('wallet.storage.rpc')?.spanId)
    expect(byName.get('wallet.storage.handler')?.parentSpanId).toBe(byName.get('wallet.storage.rpc')?.spanId)
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('0123456789abcdef0123456789abcdef'))

    const invalid = makeResponse()
    await invoke(
      server,
      'handleRpcRequest',
      makeRequest({
        jsonrpc: '1.0',
        params: [],
        id: 9
      }),
      invalid.response
    )
    expect(events.find(event => event.attributes?.['rpc.method'] === 'invalid')).toBeDefined()
  })

  test.each([
    [204, true, 'finish', 'ok'],
    [503, true, 'finish', 'error'],
    [200, true, 'close', 'ok'],
    [200, false, 'close', 'cancelled']
  ])('records HTTP completion status %i on %s', (statusCode, writableEnded, completionEvent, expectedStatus) => {
    const events: TelemetryEvent[] = []
    const server = makeServer(
      {},
      {
        telemetry: { sink: { capture: event => events.push(event) } }
      }
    )
    const listeners = new Map<string, () => void>()
    const response = {
      statusCode,
      writableEnded,
      once: (name: string, callback: () => void) => {
        listeners.set(name, callback)
      }
    } as unknown as Response
    const request = makeRequest(
      {},
      {
        'content-length': '42',
        traceparent: '00-0123456789abcdef0123456789abcdef-fedcba9876543210-01'
      }
    )
    const next = jest.fn()

    void invoke(server, 'traceHttpRequest', request, response, next)
    listeners.get(completionEvent)?.()
    listeners.get(completionEvent)?.()

    expect(next).toHaveBeenCalledTimes(1)
    expect(events[0]).toMatchObject({
      name: 'wallet.storage.http.request',
      traceId: '0123456789abcdef0123456789abcdef',
      spanStatus: expectedStatus,
      attributes: {
        'http.request.method': 'POST',
        'http.request.body_size': 42,
        'http.response.status_code': statusCode
      }
    })
  })

  test('returns protocol and method errors without invoking storage', async () => {
    const server = makeServer()
    const invalid = makeResponse()
    await invoke(
      server,
      'handleRpcRequest',
      makeRequest({
        jsonrpc: '1.0',
        params: [],
        id: 2
      }),
      invalid.response
    )
    expect(invalid.statusCode).toBe(400)
    expect(invalid.body).toEqual({ error: { code: -32600, message: 'Invalid Request' } })

    const unknown = makeResponse()
    await invoke(
      server,
      'handleRpcRequest',
      makeRequest({
        jsonrpc: '2.0',
        method: 'notPublic',
        params: [],
        id: 3
      }),
      unknown.response
    )
    expect(unknown.statusCode).toBe(400)
    expect(unknown.body).toMatchObject({
      error: { code: -32601, message: 'Method not found: notPublic' }
    })

    const missingHandler = makeResponse()
    await invoke(
      makeServer({ adminStats: undefined }),
      'handleRpcRequest',
      makeRequest({
        jsonrpc: '2.0',
        method: 'adminStats',
        params: ['alice'],
        id: 4
      }),
      missingHandler.response
    )
    expect(missingHandler.statusCode).toBe(400)
    expect(missingHandler.body).toMatchObject({
      error: { code: -32601, message: 'Method not found: adminStats' }
    })
  })

  test('normalizes storage failures into JSON-RPC wallet errors', async () => {
    const server = makeServer(
      {
        getSettings: jest.fn(() => {
          throw new Error('storage failed')
        })
      },
      {
        makeLogger: () => new WalletLogger()
      }
    )
    const captured = makeResponse()

    await invoke(
      server,
      'handleRpcRequest',
      makeRequest({
        jsonrpc: '2.0',
        method: 'getSettings',
        params: [{ userId: 7 }, {}],
        id: 5
      }),
      captured.response
    )

    expect(captured.statusCode).toBe(200)
    expect(captured.body).toMatchObject({
      jsonrpc: '2.0',
      error: { isError: true, message: 'storage failed', name: 'Error' },
      id: 5
    })
  })

  test('rejects an RPC request without a valid authenticated identity', async () => {
    const server = makeServer()
    const body = {
      jsonrpc: '2.0',
      method: 'getSettings',
      params: [],
      id: 6
    }
    const requests = [makeRequest(body, {}, 'unknown'), makeRequest(body, {}, '   '), makeRequest(body)]
    Reflect.set(requests[2], 'auth', { identityKey: null })
    const missingAuth = makeRequest(body)
    Reflect.deleteProperty(missingAuth, 'auth')
    requests.push(missingAuth)

    for (const request of requests) {
      await expect(invoke(server, 'handleRpcRequest', request, makeResponse().response)).rejects.toThrow(
        'authenticated request identity is required'
      )
    }
  })

  test('normalizes a multi-value trace header in short-request logging', async () => {
    const server = makeServer()
    const app = Reflect.get(server, 'app')
    const use = jest.spyOn(app, 'use')
    await invoke(server, 'setupShortReqLogging')
    const middleware = use.mock.calls.at(-1)?.[0]
    expect(typeof middleware).toBe('function')

    const next = jest.fn()
    middleware(
      makeRequest(
        {
          jsonrpc: '2.0',
          method: 'getSettings',
          params: [],
          id: 7
        },
        {
          'content-length': '42',
          'content-type': 'application/json',
          'X-Cloud-Trace-Context': ['first-trace/123', 'second-trace/456']
        }
      ),
      makeResponse().response,
      next
    )

    expect(next).toHaveBeenCalledTimes(1)
    expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining('first-trace'))
    expect(consoleLog).not.toHaveBeenCalledWith(expect.stringContaining('second-trace'))
    use.mockRestore()
  })

  test('enforces method-specific authorization and validates sync chunks', async () => {
    const request = makeRequest({}, {}, 'alice')
    const server = makeServer({}, { adminIdentityKeys: ['alice'] })

    const destroyLog: Record<string, unknown> = {}
    await expect(invoke(server, 'authorizeRpcCall', 'destroy', [], request, destroyLog)).resolves.toBe(false)
    expect(destroyLog).toMatchObject({ comment: 'IGNORED' })
    await expect(invoke(server, 'authorizeRpcCall', 'getSettings', [], request)).resolves.toBe(true)
    await expect(invoke(server, 'authorizeRpcCall', 'findOrInsertUser', ['mallory'], request)).rejects.toThrow(
      'authenticated user'
    )
    await expect(invoke(server, 'authorizeRpcCall', 'adminStats', ['mallory'], request)).rejects.toThrow(
      'authenticated admin user'
    )
    await expect(invoke(makeServer(), 'authorizeRpcCall', 'adminStats', ['alice'], request)).rejects.toThrow(
      'admin user'
    )
    await expect(invoke(server, 'authorizeRpcCall', 'adminStats', ['alice'], request)).resolves.toBe(true)

    const syncParams: any[] = [{ identityKey: 'alice' }, { ...emptyChunk }]
    await expect(invoke(server, 'authorizeRpcCall', 'processSyncChunk', syncParams, request)).resolves.toBe(true)
    expect(syncParams[0].reqAuthUserId).toBe(7)

    const syncParamsWithoutClaim: any[] = [{}, { ...emptyChunk }]
    await expect(invoke(server, 'authorizeRpcCall', 'processSyncChunk', syncParamsWithoutClaim, request)).resolves.toBe(
      true
    )
    expect(syncParamsWithoutClaim[0].reqAuthUserId).toBe(7)

    await expect(
      invoke(server, 'authorizeRpcCall', 'processSyncChunk', [{ identityKey: 'mallory' }, { ...emptyChunk }], request)
    ).rejects.toThrow('identityKey does not match authentication')
  })

  test('propagates authenticated identity and nested logger output', async () => {
    const server = makeServer(
      {},
      {
        makeLogger: (): WalletLoggerInterface => {
          const logger = new WalletLogger()
          logger.isOrigin = false
          return logger
        }
      }
    )
    const request = makeRequest({}, {}, 'alice')
    const params: any[] = [{ identityKey: 'alice', userId: 99 }, { logger: undefined }]

    await invoke(server, 'authorizeStandardRpcCall', 'abortAction', params, request)
    expect(params[0]).toMatchObject({
      identityKey: 'alice',
      userId: 7,
      reqAuthUserId: 7,
      isActive: true
    })

    const logger = await invoke<WalletLoggerInterface>(server, 'createRpcLogger', 'abortAction', params)
    const result: Record<string, unknown> = {}
    await invoke(server, 'finishRpcLogging', logger, result)
    expect(logger.logs?.some(entry => entry.log.includes('userId: 7'))).toBe(true)
    expect(logger.logs?.some(entry => entry.log.includes('identityKey: alice'))).toBe(true)
    expect(result.log).toEqual({ logs: logger.logs })

    const paramsWithoutClaim: any[] = [{}, {}]
    await invoke(server, 'authorizeStandardRpcCall', 'abortAction', paramsWithoutClaim, request)
    expect(paramsWithoutClaim[0]).toMatchObject({
      identityKey: 'alice',
      userId: 7,
      reqAuthUserId: 7,
      isActive: true
    })

    await expect(
      invoke(server, 'authorizeStandardRpcCall', 'abortAction', [{ identityKey: 'mallory' }, {}], request)
    ).rejects.toThrow('identityKey does not match authentication')
  })
})
