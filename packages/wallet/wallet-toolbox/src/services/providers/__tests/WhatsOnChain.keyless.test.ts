import { HttpClient, HttpClientRequestOptions, HttpClientResponse } from '@bsv/sdk'
import { WhatsOnChain, WhatsOnChainNoServices, WocChainInfo } from '../WhatsOnChain'

describe('WhatsOnChain optional authentication', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  test('retries anonymously when a configured key is rejected', async () => {
    const requests: HttpClientRequestOptions[] = []
    const value: WocChainInfo = {
      chain: 'main',
      blocks: 100,
      headers: 100,
      bestblockhash: '00'.repeat(32),
      difficulty: 1,
      mediantime: 1,
      verificationprogress: 1,
      pruned: false,
      chainwork: '00'.repeat(32)
    }
    let call = 0
    const httpClient: HttpClient = {
      async request<T>(_url: string, options: HttpClientRequestOptions): Promise<HttpClientResponse<T>> {
        requests.push(options)
        call++
        if (call === 1) {
          return { ok: false, status: 401, statusText: 'Unauthorized', data: {} as T }
        }
        return { ok: true, status: 200, statusText: 'OK', data: value as T }
      }
    }
    const requestGate = jest.fn(async () => {})
    const woc = new WhatsOnChainNoServices('main', {
      apiKey: 'rejected-key',
      httpClient,
      requestGate
    })

    await expect(woc.getChainInfo()).resolves.toEqual(value)
    expect(requests).toHaveLength(2)
    expect(requests[0].headers).toMatchObject({ Authorization: 'rejected-key' })
    expect(requests[1].headers).not.toHaveProperty('Authorization')
    expect(requestGate).toHaveBeenCalledTimes(2)
  })

  test('uses keyless requests directly and returns undefined for an unknown block', async () => {
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return { ok: false, status: 404, statusText: 'Not Found', data: undefined as T }
      }
    }
    const requestGate = jest.fn(async () => {})
    const woc = new WhatsOnChainNoServices('main', { httpClient, requestGate })

    await expect(woc.getBlockHeaderByHash('00'.repeat(32))).resolves.toBeUndefined()
    expect(requestGate).toHaveBeenCalledTimes(1)
  })

  test('serializes anonymous auth fallback and rate-limit retries without a request gate', async () => {
    jest.useFakeTimers()
    const value: WocChainInfo = {
      chain: 'main',
      blocks: 100,
      headers: 100,
      bestblockhash: '00'.repeat(32),
      difficulty: 1,
      mediantime: 1,
      verificationprogress: 1,
      pruned: false,
      chainwork: '00'.repeat(32)
    }
    const responses: Array<HttpClientResponse<WocChainInfo>> = [
      { ok: false, status: 403, statusText: 'Forbidden', data: {} as WocChainInfo },
      { ok: false, status: 429, statusText: 'Too Many Requests', data: {} as WocChainInfo },
      { ok: true, status: 200, statusText: 'OK', data: value }
    ]
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        return responses.shift() as HttpClientResponse<T>
      }
    }
    const woc = new WhatsOnChainNoServices('main', { apiKey: 'stale-key', httpClient })
    const result = woc.getChainInfo()

    await jest.advanceTimersByTimeAsync(350)
    await jest.advanceTimersByTimeAsync(2000)
    await expect(result).resolves.toEqual(value)
  })

  test('rejects mock construction and supports an injected Services instance', () => {
    expect(() => new WhatsOnChainNoServices('mock')).toThrow("does not support 'mock' chain")
    const services = {} as any
    expect(new WhatsOnChain('main', {}, services).services).toBe(services)
  })
})
