import { Hash } from '@bsv/sdk'
import { BulkHeaderFilesInfo } from '../BulkHeaderFile'
import { ChaintracksFetch, ChaintracksFetchError } from '../ChaintracksFetch'
import { asArray, asString } from '../../../../../utility/utilityHelpers.noBuffer'
import { validBulkHeaderFilesByFileHash } from '../validBulkHeaderFilesByFileHash'

describe('ChaintracksFetch tests', () => {
  jest.setTimeout(99999999)
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    jest.restoreAllMocks()
  })

  test('retries numeric HTTP 429 even when statusText differs', async () => {
    const responses = [
      new Response(JSON.stringify({}), { status: 429, statusText: 'rate limited', headers: { 'retry-after': '0' } }),
      new Response(JSON.stringify({ ok: true }), { status: 200, statusText: 'OK' })
    ]
    const fetchMock = jest.fn(async () => {
      const response = responses.shift()
      if (response == null) throw new Error('No scripted fetch response')
      return response
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const fetch = new ChaintracksFetch()
    const json = await fetch.fetchJson<{ ok: boolean }>('https://example.test/headers')

    expect(json.ok).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('throws ChaintracksFetchError with status and Retry-After after retries are exhausted', async () => {
    const fetchMock = jest.fn(async () =>
      new Response(JSON.stringify({ error: 'limited' }), { status: 429, statusText: 'Too Many Requests', headers: { 'retry-after': '0' } })
    )
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const fetch = new ChaintracksFetch()
    await expect(fetch.fetchJson('https://example.test/headers')).rejects.toMatchObject({
      name: 'ChaintracksFetchError',
      status: 429,
      statusText: 'Too Many Requests',
      retryAfterMsecs: 0,
      retryable: true
    } satisfies Partial<ChaintracksFetchError>)
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  test('0 fetchJson', async () => {
    const fetch = new ChaintracksFetch()
    const cdnUrl = 'https://cdn.projectbabbage.com/blockheaders/'
    // const jsonResource = `${cdnUrl}/testNetV2.json`
    const jsonResource = `${cdnUrl}/testNetBlockHeaders.json`
    const info: BulkHeaderFilesInfo = await fetch.fetchJson(jsonResource)
    expect(info).toBeDefined()
    expect(info.files.length).toBeGreaterThan(4)
  })

  test('1 download', async () => {
    const fetch = new ChaintracksFetch()
    const cdnUrl = 'https://cdn.projectbabbage.com/blockheaders/'
    const url = `${cdnUrl}/testNet_0.headers`
    const data = await fetch.download(url)
    expect(data.length).toBe(8000000)
    const fileHash = asString(Hash.sha256(asArray(data)), 'base64')
    expect(validBulkHeaderFilesByFileHash()[fileHash]).toBeDefined()
  })

  test.skip('2 download faster crypto.subtle sha256', async () => {
    const fetch = new ChaintracksFetch()
    const cdnUrl = 'https://cdn.projectbabbage.com/blockheaders/'
    const url = `${cdnUrl}/testNet_0.headers`
    const data = await fetch.download(url)
    expect(data.length).toBe(8000000)
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(data)))
    const fileHash = asString(hash, 'base64')
    expect(validBulkHeaderFilesByFileHash()[fileHash]).toBeDefined()
  })

  test('3 download', async () => {
    const fetch = new ChaintracksFetch()
    const cdnUrl = 'https://cdn.projectbabbage.com/blockheaders/'
    const url = `${cdnUrl}/testNet_4.headers`
    const data = await fetch.download(url)
    expect(data.length).toBe(80 * 100000)
    const fileHash = asString(Hash.sha256(asArray(data)), 'base64')
    expect(validBulkHeaderFilesByFileHash()[fileHash]).toBeDefined()
  })

  test('4 download', async () => {
    const fetch = new ChaintracksFetch()
    const cdnUrl = 'https://cdn.projectbabbage.com/blockheaders/'
    const url = `${cdnUrl}/mainNet_2.headers`
    const data = await fetch.download(url)
    expect(data.length).toBe(80 * 100000)
    const fileHash = asString(Hash.sha256(asArray(data)), 'base64')
    expect(validBulkHeaderFilesByFileHash()[fileHash]).toBeDefined()
  })
})
