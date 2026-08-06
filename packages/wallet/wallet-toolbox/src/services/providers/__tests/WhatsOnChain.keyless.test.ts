import { HttpClient, HttpClientRequestOptions, HttpClientResponse } from '@bsv/sdk'
import { WhatsOnChainNoServices, WocChainInfo } from '../WhatsOnChain'

describe('WhatsOnChain optional authentication', () => {
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
})
