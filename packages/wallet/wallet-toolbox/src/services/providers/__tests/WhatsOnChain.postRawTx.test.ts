import { HttpClient, HttpClientResponse } from '@bsv/sdk'
import { WhatsOnChain } from '../WhatsOnChain'

/**
 * How WhatsOnChain post answers are scored. A refusal of the transaction itself is a verdict; an
 * answer that says nothing about the transaction (a refused key, rate limiting, a server failure)
 * is a service error, so the wallet fails over or retries instead of failing the transaction.
 */
describe('WhatsOnChain postRawTx answer classification', () => {
  const RAW_TX = '0100000000000000000000'

  afterEach(() => {
    jest.useRealTimers()
  })

  function wocAnswering(...responses: Array<Partial<HttpClientResponse<unknown>>>): {
    woc: WhatsOnChain
    calls: () => number
  } {
    let calls = 0
    const httpClient: HttpClient = {
      async request<T>(): Promise<HttpClientResponse<T>> {
        const response = responses[Math.min(calls, responses.length - 1)]
        calls++
        return response as HttpClientResponse<T>
      }
    }
    return {
      woc: new WhatsOnChain('main', { httpClient, requestGate: async () => {} }, {} as never),
      calls: () => calls
    }
  }

  test.each([
    [401, 'Unauthorized', ''],
    [403, 'Forbidden', ''],
    [408, 'Request Timeout', ''],
    [500, 'Internal Server Error', '<html>error</html>'],
    [502, 'Bad Gateway', ''],
    [503, 'Service Unavailable', ''],
    [504, 'Gateway Timeout', '']
  ])('HTTP %i with no relayed node refusal is a service error', async (status, statusText, data) => {
    const { woc } = wocAnswering({ ok: false, status, statusText, data })
    const r = await woc.postRawTx(RAW_TX)
    expect(r.status).toBe('error')
    expect(r.serviceError).toBe(true)
    expect(r.doubleSpend).toBeFalsy()
    expect(r.notes).toEqual(expect.arrayContaining([expect.objectContaining({ what: 'postRawTxError', status })]))
  })

  test('an exhausted 429 retry is a service error', async () => {
    jest.useFakeTimers()
    const { woc, calls } = wocAnswering({ ok: false, status: 429, statusText: 'Too Many Requests', data: '' })

    const pending = woc.postRawTx(RAW_TX)
    await jest.advanceTimersByTimeAsync(10_000)
    const r = await pending

    expect(calls()).toBe(3)
    expect(r.notes!.filter(n => n.what === 'postRawTxRateLimit')).toHaveLength(2)
    expect(r.status).toBe('error')
    expect(r.serviceError).toBe(true)
  })

  test.each([
    [400, 'Bad Request'],
    [500, 'Internal Server Error'],
    [503, 'Service Unavailable']
  ])('a relayed node refusal under HTTP %i stays a verdict', async (status, statusText) => {
    const { woc } = wocAnswering({
      ok: false,
      status,
      statusText,
      data: 'unexpected response code 500: 16: mandatory-script-verify-flag-failed'
    })
    const r = await woc.postRawTx(RAW_TX)
    expect(r.status).toBe('error')
    expect(r.serviceError).toBeFalsy()
  })

  test.each([
    [400, 'unexpected response code 503: Service Unavailable'],
    [500, 'unexpected response code 502: Bad Gateway'],
    [500, 'unexpected response code 429: Too Many Requests']
  ])('under HTTP %i, a relayed node-side service failure (%s) is a service error', async (status, data) => {
    const { woc } = wocAnswering({ ok: false, status, statusText: 'Error', data })
    const r = await woc.postRawTx(RAW_TX)
    expect(r.status).toBe('error')
    expect(r.serviceError).toBe(true)
  })

  test('a relayed missing-inputs refusal keeps its double-spend classification', async () => {
    const { woc } = wocAnswering({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      data: 'unexpected response code 500: Missing inputs'
    })
    const r = await woc.postRawTx(RAW_TX)
    expect(r.doubleSpend).toBe(true)
    expect(r.serviceError).toBeFalsy()
  })

  test('a 400 for malformed input stays a verdict', async () => {
    const { woc } = wocAnswering({ ok: false, status: 400, statusText: 'Bad Request', data: 'invalid transaction hex' })
    const r = await woc.postRawTx(RAW_TX)
    expect(r.serviceError).toBeFalsy()
  })
})
