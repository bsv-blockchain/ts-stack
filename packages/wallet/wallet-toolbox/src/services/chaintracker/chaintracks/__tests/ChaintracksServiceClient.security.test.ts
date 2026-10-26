import { asString } from '../../../../utility/utilityHelpers.noBuffer'
import type { BlockHeader } from '../Api/BlockHeaderApi'
import { ChaintracksServiceClient } from '../ChaintracksServiceClient'
import { blockHash, deserializeBaseBlockHeaders, genesisBuffer } from '../util/blockHeaderUtilities'

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

function success(value?: unknown): Response {
  return response(value === undefined ? { status: 'success' } : { status: 'success', value })
}

function validMainHeader(height: number): BlockHeader {
  const base = deserializeBaseBlockHeaders(genesisBuffer('main'))[0]!
  return { ...base, height, hash: blockHash(base) }
}

describe('ChaintracksServiceClient security boundary', () => {
  test('rejects ambiguous endpoint and limit configuration', () => {
    for (const url of [
      'ftp://chaintracks.example',
      'https://user:pass@chaintracks.example',
      'https://chaintracks.example?network=main',
      'https://chaintracks.example#tip'
    ]) {
      expect(() => new ChaintracksServiceClient('main', url)).toThrow('serviceUrl')
    }
    expect(
      () =>
        new ChaintracksServiceClient('main', 'https://chaintracks.example', {
          maxResponseBytes: 0
        })
    ).toThrow('maxResponseBytes')
  })

  test('retains the deadline through body consumption and caps response bytes', async () => {
    const stalled = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
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
    await expect(stalled.getPresentHeight()).rejects.toThrow('deadline')

    const oversized = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      maxResponseBytes: 16,
      fetch: jest.fn(async () => success({ padding: 'x'.repeat(64) })) as unknown as typeof fetch
    })
    await expect(oversized.getPresentHeight()).rejects.toThrow('byte limit')
  })

  test('binds network, header height, hash, and proof before returning values', async () => {
    const mismatch = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: jest.fn(async () => success('test')) as unknown as typeof fetch
    })
    await expect(mismatch.getChain()).rejects.toThrow("does not match configured chain 'main'")

    const wrongHeight = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: jest.fn(async () => success(validMainHeader(6))) as unknown as typeof fetch
    })
    await expect(wrongHeight.findHeaderForHeight(5)).rejects.toThrow('wrong height')

    const wrongHash = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: jest.fn(async () => success(validMainHeader(5))) as unknown as typeof fetch
    })
    await expect(wrongHash.findHeaderForBlockHash('ff'.repeat(32))).rejects.toThrow('wrong hash')

    const forged = { ...validMainHeader(5), hash: '11'.repeat(32) }
    const forgedClient = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: jest.fn(async () => success(forged)) as unknown as typeof fetch
    })
    await expect(forgedClient.findChainTipHeader()).rejects.toThrow('Header hash is invalid')

    const partialLive = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: jest.fn(async () =>
        success({ ...validMainHeader(5), chainWork: '00'.repeat(32) })
      ) as unknown as typeof fetch
    })
    await expect(partialLive.findChainTipHeader()).rejects.toThrow('invalid chain tip')

    const invalidLiveId = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: jest.fn(async () =>
        success({
          ...validMainHeader(5),
          chainWork: '00'.repeat(32),
          isChainTip: true,
          isActive: true,
          headerId: 0,
          previousHeaderId: null
        })
      ) as unknown as typeof fetch
    })
    await expect(invalidLiveId.findChainTipHeader()).rejects.toThrow('invalid chain tip')
  })

  test('bounds and sanitizes remote error diagnostics', async () => {
    const client = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: jest.fn(async () =>
        response({ status: 'error', code: 'BAD\nCODE', description: `failed\r\ninjected${'x'.repeat(1000)}` })
      ) as unknown as typeof fetch
    })
    const error = (await client.getPresentHeight().catch(error => error as Error)) as Error
    expect(error.message).toMatch(/^ERR_CHAINTRACKS: failed injectedx+$/)
    expect(error.message).not.toMatch(/[\r\n]/)
    expect(error.message.length).toBeLessThanOrEqual(512 + 'ERR_CHAINTRACKS: '.length)
  })

  test('requires exact linked header-batch framing and bounds requested count', async () => {
    const valid = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: jest.fn(async () => success(asString(genesisBuffer('main')))) as unknown as typeof fetch
    })
    await expect(valid.getHeaders(0, 1)).resolves.toBe(asString(genesisBuffer('main')))

    const malformed = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: jest.fn(async () => success('00')) as unknown as typeof fetch
    })
    await expect(malformed.getHeaders(0, 1)).rejects.toThrow('non-canonical')

    const fetchMock = jest.fn(async () => success(''))
    const capped = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      maxResponseBytes: 160,
      fetch: fetchMock as unknown as typeof fetch
    })
    await expect(capped.getHeaders(0, 2)).rejects.toThrow('count exceeds')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('validates and copies submitted headers before serializing the request', async () => {
    const fetchMock = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe('error')
      const body = JSON.parse(String(init?.body))
      expect(body).toEqual(deserializeBaseBlockHeaders(genesisBuffer('main'))[0])
      return success()
    })
    const client = new ChaintracksServiceClient('main', 'https://chaintracks.example', {
      fetch: fetchMock as unknown as typeof fetch
    })
    await client.addHeader(deserializeBaseBlockHeaders(genesisBuffer('main'))[0]!)
    await expect(
      client.addHeader({
        ...deserializeBaseBlockHeaders(genesisBuffer('main'))[0]!,
        constructor: 'unexpected'
      } as never)
    ).rejects.toThrow('required data properties')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
