import { Services } from '../../../../Services'
import { Chaintracks } from '../Chaintracks'
import { ChaintracksService } from '../ChaintracksService'

describe('ChaintracksService resource-admission boundary', () => {
  test('rejects unsafe routing and resource-limit configuration', () => {
    const base = ChaintracksService.createChaintracksServiceOptions('main')

    for (const routingPrefix of ['relative', '/trailing/', '//double', '/path?query', '/path#fragment']) {
      expect(() => new ChaintracksService({ ...base, routingPrefix })).toThrow('routingPrefix')
    }
    expect(() => new ChaintracksService({ ...base, maxHeadersPerRequest: 100001 })).toThrow('maxHeadersPerRequest')
    expect(() => new ChaintracksService({ ...base, maxWaitMsecs: 30001 })).toThrow('maxWaitMsecs')
  })

  test('rate-limits header submissions independently of the general request budget', async () => {
    const fakeChaintracks = {
      chain: 'main',
      makeAvailable: jest.fn(async () => {}),
      destroy: jest.fn(async () => {}),
      addHeader: jest.fn(async () => {})
    } as unknown as Chaintracks
    const fakeServices = {
      chain: 'main',
      updateFiatExchangeRateServices: { remove: jest.fn() }
    } as unknown as Services
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {})
    const service = new ChaintracksService({
      chain: 'main',
      routingPrefix: '',
      port: 0,
      chaintracks: fakeChaintracks,
      services: fakeServices,
      maxRequestsPerMinute: 10,
      maxHeaderSubmissionsPerMinute: 1
    })

    try {
      await service.startJsonRpcServer()
      expect(service.port).toEqual(expect.any(Number))
      expect(service.port).toBeGreaterThan(0)
      const url = `http://127.0.0.1:${service.port}/addHeaderHex`
      const request = (): Promise<Response> =>
        fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            version: 1,
            previousHash: '00'.repeat(32),
            merkleRoot: '11'.repeat(32),
            time: 1,
            bits: 1,
            nonce: 1
          })
        })

      await expect(request()).resolves.toMatchObject({ status: 200 })
      const rejected = await request()
      expect(rejected.status).toBe(429)
      expect(rejected.headers.get('retry-after')).toMatch(/^\d+$/)
      await expect(rejected.json()).resolves.toEqual({
        status: 'error',
        code: 'ERR_HEADER_SUBMISSION_RATE_LIMIT',
        description: 'The request rate limit has been exceeded.'
      })
      expect(fakeChaintracks.addHeader).toHaveBeenCalledTimes(1)
    } finally {
      await service.stopJsonRpcServer()
      logSpy.mockRestore()
    }
  })

  test('isolates general request limits by trusted client address', async () => {
    const fakeChaintracks = {
      chain: 'main',
      makeAvailable: jest.fn(async () => {}),
      destroy: jest.fn(async () => {}),
      getChain: jest.fn(async () => 'main')
    } as unknown as Chaintracks
    const fakeServices = {
      chain: 'main',
      updateFiatExchangeRateServices: { remove: jest.fn() }
    } as unknown as Services
    const service = new ChaintracksService({
      chain: 'main',
      routingPrefix: '',
      port: 0,
      chaintracks: fakeChaintracks,
      services: fakeServices,
      maxRequestsPerMinute: 1,
      trustProxy: 'loopback'
    })

    try {
      await service.startJsonRpcServer()
      const url = `http://127.0.0.1:${service.port}/getChain`
      const request = async (client: string): Promise<Response> =>
        await fetch(url, { headers: { 'x-forwarded-for': client } })

      await expect(request('198.51.100.1')).resolves.toMatchObject({ status: 200 })
      await expect(request('198.51.100.1')).resolves.toMatchObject({ status: 429 })
      await expect(request('198.51.100.2')).resolves.toMatchObject({ status: 200 })
    } finally {
      await service.stopJsonRpcServer()
    }
  })
})
