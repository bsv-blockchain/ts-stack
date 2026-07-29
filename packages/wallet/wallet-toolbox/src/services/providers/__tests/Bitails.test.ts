import { HttpClient, HttpClientRequestOptions, HttpClientResponse } from '@bsv/sdk'
import { Bitails } from '../Bitails'

const RAW_TX = '0100000000000000000000'

function mockHttpClient(response: Partial<HttpClientResponse<unknown>> | Error): HttpClient {
  return {
    async request<T>(_url: string, _options: HttpClientRequestOptions): Promise<HttpClientResponse<T>> {
      if (response instanceof Error) throw response
      return response as HttpClientResponse<T>
    }
  }
}

describe('Bitails postRaws response handling', () => {
  test('fills an omitted response txid and records success', async () => {
    const bitails = new Bitails('main', {
      httpClient: mockHttpClient({
        ok: true,
        status: 201,
        statusText: 'Created',
        data: [{}]
      })
    })

    const result = await bitails.postRaws([RAW_TX])

    expect(result.status).toBe('success')
    expect(result.txidResults).toHaveLength(1)
    expect(result.txidResults[0].status).toBe('success')
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ what: 'postRawsResultMissingTxids' })])
    )
  })

  test('rejects a response count that does not match the submitted raws', async () => {
    const bitails = new Bitails('main', {
      httpClient: mockHttpClient({
        ok: true,
        status: 201,
        statusText: 'Created',
        data: []
      })
    })

    const result = await bitails.postRaws([RAW_TX])

    expect(result.status).toBe('error')
    expect(result.notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ what: 'postRawsErrorResultsCount' })])
    )
  })

  test('treats already-in-mempool as a successful broadcast', async () => {
    const bitails = new Bitails('main', {
      httpClient: mockHttpClient({
        ok: true,
        status: 201,
        statusText: 'Created',
        data: [{ error: { code: -27, message: 'already-in-mempool' } }]
      })
    })

    const result = await bitails.postRaws([RAW_TX])

    expect(result.status).toBe('success')
    expect(result.txidResults[0].status).toBe('success')
    expect(result.txidResults[0].notes).toEqual(
      expect.arrayContaining([expect.objectContaining({ what: 'postRawsSuccessAlreadyInMempool' })])
    )
  })

  test('classifies missing inputs as a possible double spend', async () => {
    const bitails = new Bitails('main', {
      httpClient: mockHttpClient({
        ok: true,
        status: 201,
        statusText: 'Created',
        data: [{ error: { code: -25, message: 'missing-inputs' } }]
      })
    })

    const result = await bitails.postRaws([RAW_TX])

    expect(result.status).toBe('error')
    expect(result.txidResults[0]).toMatchObject({
      status: 'error',
      doubleSpend: true
    })
  })

  test('records HTTP and transport failures as aggregate errors', async () => {
    const httpFailure = new Bitails('main', {
      httpClient: mockHttpClient({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        data: {}
      })
    })
    const transportFailure = new Bitails('main', {
      httpClient: mockHttpClient(new Error('network unavailable'))
    })

    const [httpResult, transportResult] = await Promise.all([
      httpFailure.postRaws([RAW_TX]),
      transportFailure.postRaws([RAW_TX])
    ])

    expect(httpResult.status).toBe('error')
    expect(httpResult.notes).toEqual(expect.arrayContaining([expect.objectContaining({ what: 'postRawsError' })]))
    expect(transportResult.status).toBe('error')
    expect(transportResult.notes).toEqual(expect.arrayContaining([expect.objectContaining({ what: 'postRawsCatch' })]))
  })
})
