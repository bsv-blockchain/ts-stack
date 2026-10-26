import { BHServiceClient } from '../BHServiceClient'
import { genesisHeader } from '../chaintracks/util/blockHeaderUtilities'

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function bhsHeader() {
  const header = genesisHeader('main')
  return {
    hash: header.hash,
    version: header.version,
    prevBlockHash: header.previousHash,
    merkleRoot: header.merkleRoot,
    creationTimestamp: header.time,
    difficultyTarget: header.bits,
    nonce: header.nonce,
    work: '00'.repeat(32)
  }
}

function bhsState() {
  return {
    header: bhsHeader(),
    state: 'LONGEST_CHAIN',
    chainWork: '00'.repeat(32),
    height: 0
  }
}

describe('BHServiceClient security boundary', () => {
  test('rejects ambiguous endpoints, credentials, and unsafe resource limits', () => {
    for (const url of [
      'ftp://headers.example',
      'https://user:pass@headers.example',
      'https://headers.example?chain=main',
      'https://headers.example#tip'
    ]) {
      expect(() => new BHServiceClient('main', url, 'key')).toThrow('serviceUrl')
    }
    expect(() => new BHServiceClient('main', 'https://headers.example', 'bad\nkey')).toThrow('apiKey')
    expect(() => new BHServiceClient('main', 'https://headers.example', 'key', { maxResponseBytes: 0 })).toThrow(
      'maxResponseBytes'
    )
    expect(() => new BHServiceClient('mainnet' as never, 'https://headers.example', 'key')).toThrow('supported Chain')
    expect(() => new BHServiceClient('main', '/relative', 'key')).toThrow('absolute HTTP')
    expect(() => new BHServiceClient('main', 'https://headers.example', 1 as never)).toThrow('apiKey')
    expect(() => new BHServiceClient('main', 'https://headers.example', 'x'.repeat(8193))).toThrow('apiKey')
    expect(
      () => new BHServiceClient('main', 'https://headers.example', 'key', { requestTimeoutMsecs: 3_600_001 })
    ).toThrow('requestTimeoutMsecs')
  })

  test('binds tip and height responses and returns undefined only for an explicit 404', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce(response(bhsState()))
      .mockResolvedValueOnce(response(bhsState()))
      .mockResolvedValueOnce(response(bhsState()))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
    const client = new BHServiceClient('main', 'https://headers.example///', '', {
      fetch: fetchMock as unknown as typeof fetch
    })

    await expect(client.currentHeight()).resolves.toBe(0)
    await expect(client.getPresentHeight()).resolves.toBe(0)
    await expect(client.findChainTipHeader()).resolves.toEqual(genesisHeader('main'))
    await expect(client.findHeaderForHeight(1)).resolves.toBeUndefined()
    expect(fetchMock.mock.calls.every(([url]) => !(url as string).includes('////api'))).toBe(true)
  })

  test('validates query boundaries before transport and rejects incomplete header ranges', async () => {
    const fetchMock = jest.fn(async () => response([]))
    const client = new BHServiceClient('main', 'https://headers.example', '', {
      fetch: fetchMock as unknown as typeof fetch
    })
    await expect(client.findHeaderForHeight(-1)).rejects.toThrow('height')
    await expect(client.findHeaderForBlockHash('bad')).rejects.toThrow('hash')
    await expect(client.getHeaders(0, 0)).rejects.toThrow('count')
    await expect(client.getHeaders(0x7fffffff, 2)).rejects.toThrow('supported height')
    expect(fetchMock).not.toHaveBeenCalled()

    await expect(client.getHeaders(0, 1)).rejects.toThrow('enough headers')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('rejects malformed state, array, accessor, JSON, and HTTP evidence', async () => {
    const values: unknown[] = [
      null,
      [],
      { ...bhsState(), height: -1 },
      { ...bhsState(), state: 'x'.repeat(129) },
      { ...bhsState(), chainWork: 'bad' },
      { ...bhsState(), header: null }
    ]
    for (const value of values) {
      const client = new BHServiceClient('main', 'https://headers.example', '', {
        fetch: jest.fn(async () => response(value)) as unknown as typeof fetch
      })
      await expect(client.currentHeight()).rejects.toThrow()
    }

    const getter = jest.fn(() => 0)
    const accessor = bhsState() as Record<string, unknown>
    Object.defineProperty(accessor, 'height', { enumerable: true, get: getter })
    const accessorClient = new BHServiceClient('main', 'https://headers.example', '') as any
    expect(() => accessorClient.validateHeaderState(accessor, 'chain tip')).toThrow('invalid')
    expect(getter).not.toHaveBeenCalled()

    const malformedJson = new BHServiceClient('main', 'https://headers.example', '', {
      fetch: jest.fn(async () => new Response('{broken', { status: 200 })) as unknown as typeof fetch
    })
    await expect(malformedJson.currentHeight()).rejects.toThrow('invalid JSON')
    const failed = new BHServiceClient('main', 'https://headers.example', '', {
      fetch: jest.fn(async () => response({}, 503)) as unknown as typeof fetch
    })
    await expect(failed.currentHeight()).rejects.toThrow('HTTP 503')
  })

  test('rejects sparse or overlong arrays and unlinked validated sequences', () => {
    const client = new BHServiceClient('main', 'https://headers.example', '') as any
    expect(() => client.validateHeaderArray({}, 0, 1)).toThrow('invalid header array')
    expect(() => client.validateHeaderArray([bhsHeader(), bhsHeader()], 0, 1)).toThrow('invalid header array')
    const sparse = Array(1)
    expect(() => client.validateHeaderArray(sparse, 0, 1)).toThrow('sparse header array')

    jest.spyOn(client, 'validateRemoteHeader').mockImplementation((value: { hash: string }, height: number) => ({
      ...genesisHeader('main'),
      height,
      hash: value.hash,
      previousHash: 'ff'.repeat(32)
    }))
    expect(() => client.validateHeaderArray([{ hash: '11'.repeat(32) }, { hash: '22'.repeat(32) }], 0, 2)).toThrow(
      'unlinked header array'
    )
  })

  test('retries only connection resets and preserves the unsupported interface contract', async () => {
    const reset = new Error('reset')
    reset.name = 'ECONNRESET'
    const fetchMock = jest.fn().mockRejectedValueOnce(reset).mockResolvedValueOnce(response(bhsState()))
    const client = new BHServiceClient('test', 'https://headers.example', '', {
      fetch: fetchMock as unknown as typeof fetch
    })
    await expect(client.currentHeight()).resolves.toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await expect(client.getChain()).resolves.toBe('test')

    await expect(client.findChainWorkForBlockHash('00'.repeat(32))).rejects.toThrow('Not implemented')
    await expect(client.postJsonVoid('/', {})).rejects.toThrow('Not implemented')
    await expect(client.addHeader(genesisHeader('main'))).rejects.toThrow('Not implemented')
    await expect(client.findHeaderForMerkleRoot('00'.repeat(32))).rejects.toThrow('Not implemented')
    await expect(client.startListening()).rejects.toThrow('Not implemented')
    await expect(client.listening()).rejects.toThrow('Not implemented')
    await expect(client.isSynchronized()).rejects.toThrow('Not implemented')
    await expect(client.isListening()).rejects.toThrow('Not implemented')
    await expect(client.subscribeHeaders(jest.fn())).rejects.toThrow('not implemented')
    await expect(client.subscribeReorgs(jest.fn())).rejects.toThrow('not implemented')
    await expect(client.unsubscribe('id')).rejects.toThrow('not implemented')
    await expect(client.getInfo()).rejects.toThrow('not implemented')
  })

  test('validates declared lengths and safely handles an empty body', async () => {
    const client = new BHServiceClient('main', 'https://headers.example', '') as any
    const signal = new AbortController().signal
    await expect(
      client.readBoundedBody(new Response(null, { headers: { 'Content-Length': '01' } }), signal)
    ).rejects.toThrow('Content-Length')
    await expect(
      client.readBoundedBody(
        new Response(null, { headers: { 'Content-Length': String(Number.MAX_SAFE_INTEGER) } }),
        signal
      )
    ).rejects.toThrow('byte limit')
    await expect(client.readBoundedBody(new Response(null), signal)).resolves.toEqual(new Uint8Array())
    await expect(client.requestJson('//hostile.example')).rejects.toThrow('absolute local path')
  })

  test('never treats its mutable cache as root authority', async () => {
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret')
      return response([bhsHeader()])
    })
    const client = new BHServiceClient('main', 'https://headers.example/', 'secret', {
      fetch: fetchMock as unknown as typeof fetch
    })
    const invalidRoot = '11'.repeat(32)
    client.cache[0] = invalidRoot

    await expect(client.isValidRootForHeight(invalidRoot, 0)).resolves.toBe(false)
    await expect(client.isValidRootForHeight(invalidRoot, 0)).resolves.toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(client.cache[0]).toBe(genesisHeader('main').merkleRoot)
  })

  test('validates canonical header identity, proof of work, range, and linkage before returning data', async () => {
    const client = new BHServiceClient('main', 'https://headers.example', '', {
      fetch: jest.fn(async () => response([bhsHeader()])) as unknown as typeof fetch
    })
    await expect(client.findHeaderForHeight(0)).resolves.toEqual(genesisHeader('main'))
    await expect(client.getHeaders(0, 1)).resolves.toHaveLength(160)

    const forged = { ...bhsHeader(), hash: '11'.repeat(32) }
    const forgedClient = new BHServiceClient('main', 'https://headers.example', '', {
      fetch: jest.fn(async () => response([forged])) as unknown as typeof fetch
    })
    await expect(forgedClient.findHeaderForHeight(0)).rejects.toThrow('Header hash is invalid')

    const wrongHash = new BHServiceClient('main', 'https://headers.example', '', {
      fetch: jest.fn(async () => response(bhsState())) as unknown as typeof fetch
    })
    await expect(wrongHash.findHeaderForBlockHash('ff'.repeat(32))).rejects.toThrow('wrong hash')

    const cappedFetch = jest.fn(async () => response([]))
    const capped = new BHServiceClient('main', 'https://headers.example', '', {
      maxResponseBytes: 160,
      fetch: cappedFetch as unknown as typeof fetch
    })
    await expect(capped.getHeaders(0, 2)).rejects.toThrow('count exceeds')
    expect(cappedFetch).not.toHaveBeenCalled()
  })

  test('retains its deadline through body consumption and caps response bytes', async () => {
    const stalled = new BHServiceClient('main', 'https://headers.example', '', {
      requestTimeoutMsecs: 10,
      fetch: jest.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start() {}
            })
          )
      ) as unknown as typeof fetch
    })
    await expect(stalled.currentHeight()).rejects.toThrow('deadline')

    const oversized = new BHServiceClient('main', 'https://headers.example', '', {
      maxResponseBytes: 16,
      fetch: jest.fn(async () => response({ padding: 'x'.repeat(64) })) as unknown as typeof fetch
    })
    await expect(oversized.currentHeight()).rejects.toThrow('byte limit')
  })
})
