import type { WalletInterface } from '../../wallet/Wallet.interfaces'
import { AuthFetch } from '../../auth/clients/AuthFetch'
import { DEFAULT_UHRP_SERVERS, RenewResiliencyError, StorageUploader } from '../StorageUploader'

const wallet = {} as WalletInterface

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    ...init
  })
}

function uploader(
  fetchClient: typeof fetch,
  storageURLs = ['https://one.example', 'https://two.example'],
  resilienceLevel = 1
): StorageUploader {
  return new StorageUploader({ wallet, storageURLs, resilienceLevel, fetchClient })
}

describe('StorageUploader boundary validation', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([
    [' https://storage.example', 'exact HTTPS origin'],
    ['not a url', 'absolute HTTPS origin'],
    ['http://storage.example', 'credential-free HTTPS origin'],
    ['https://user:pass@storage.example', 'credential-free HTTPS origin'],
    ['https://storage.example/path', 'credential-free HTTPS origin'],
    ['https://storage.example?query=1', 'credential-free HTTPS origin'],
    ['https://127.0.0.1', 'private or special address'],
    ['https://[::1]', 'private or special address']
  ])('rejects unsafe provider %p', (storageURL, message) => {
    expect(() => new StorageUploader({ wallet, storageURL })).toThrow(message)
  })

  it('requires a feasible positive resilience level and at least one provider', () => {
    expect(() => new StorageUploader({ wallet, storageURLs: [] })).toThrow('at least one')
    expect(
      () =>
        new StorageUploader({ wallet, storageURLs: ['https://one.example'], resilienceLevel: 0 })
    ).toThrow('positive integer')
    expect(
      () =>
        new StorageUploader({
          wallet,
          storageURLs: ['https://one.example', 'https://one.example/'],
          resilienceLevel: 2
        })
    ).toThrow('unique storage providers')
  })

  it('retains the default provider list and legacy single-host resilience contract', async () => {
    expect(DEFAULT_UHRP_SERVERS).toHaveLength(2)
    const fetchClient = jest.fn<typeof fetch>(async () =>
      jsonResponse({ status: 'success', quote: 1 })
    )
    const legacy = new StorageUploader({
      wallet,
      storageURL: 'https://one.example',
      resilienceLevel: 99,
      fetchClient
    })
    await expect(legacy.estimateCost({ fileSize: 1, retentionPeriod: 1 })).resolves.toMatchObject({
      resilienceLevel: 1,
      meetsResilienceThreshold: true
    })
  })

  it.each([
    [{ fileSize: -1, retentionPeriod: 1 }, 'fileSize'],
    [{ fileSize: Number.MAX_SAFE_INTEGER + 1, retentionPeriod: 1 }, 'fileSize'],
    [{ fileSize: 1, retentionPeriod: 0 }, 'retentionPeriod'],
    [{ fileSize: 1, retentionPeriod: 1.5 }, 'retentionPeriod']
  ])('rejects invalid quote request %#', async (params, message) => {
    await expect(uploader(jest.fn<typeof fetch>()).estimateCost(params)).rejects.toThrow(message)
  })

  it('sorts bounded quotes and computes the cheapest resilience budget', async () => {
    const fetchClient = jest.fn<typeof fetch>(async input => {
      const url = String(input)
      return jsonResponse({ status: 'success', quote: url.includes('one') ? 9 : 4 })
    })
    await expect(
      uploader(fetchClient, undefined, 2).estimateCost({
        fileSize: 10,
        retentionPeriod: 60
      })
    ).resolves.toEqual({
      quotes: [
        { host: 'https://two.example', amount: 4 },
        { host: 'https://one.example', amount: 9 }
      ],
      resilienceLevel: 2,
      totalForResilience: 13,
      meetsResilienceThreshold: true
    })
    expect(fetchClient).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchClient.mock.calls[0][1]?.body))).toEqual({
      fileSize: 10,
      retentionPeriod: 60
    })
  })

  it.each([
    ['non-success HTTP', async () => new Response('', { status: 503 })],
    ['provider error', async () => jsonResponse({ status: 'error', quote: 1 })],
    ['fractional quote', async () => jsonResponse({ status: 'success', quote: 1.5 })],
    ['negative quote', async () => jsonResponse({ status: 'success', quote: -1 })],
    ['oversized quote', async () => jsonResponse({ status: 'success', quote: 21e14 + 1 })],
    ['transport failure', async () => await Promise.reject(new Error('offline'))],
    ['malformed JSON', async () => new Response('{', { status: 200 })],
    ['non-object JSON', async () => new Response('null', { status: 200 })],
    ['oversized body', async () => new Response('x'.repeat(1024 * 1024 + 1), { status: 200 })],
    [
      'invalid declared length',
      async () => new Response('{}', { status: 200, headers: { 'Content-Length': 'not-a-number' } })
    ],
    [
      'mismatched declared length',
      async () => new Response('{}', { status: 200, headers: { 'Content-Length': '3' } })
    ],
    ['empty body', async () => new Response(null, { status: 200 })]
  ])('treats a %s as an unavailable quote', async (_name, implementation) => {
    const fetchClient = jest.fn<typeof fetch>(implementation as typeof fetch)
    await expect(
      uploader(fetchClient, ['https://one.example']).estimateCost({
        fileSize: 1,
        retentionPeriod: 1
      })
    ).resolves.toMatchObject({
      quotes: [],
      totalForResilience: 0,
      meetsResilienceThreshold: false
    })
  })

  it.each([
    [null, 'file must be an object'],
    [{ data: [], type: '' }, 'valid MIME type'],
    [{ data: [], type: 'text/plain\r\nX-Test: injected' }, 'valid MIME type'],
    [{ data: 'bytes', type: 'text/plain' }, 'byte array'],
    [{ data: [-1], type: 'text/plain' }, 'only bytes'],
    [{ data: [256], type: 'text/plain' }, 'only bytes'],
    [{ data: [1.5], type: 'text/plain' }, 'only bytes']
  ])('rejects malformed publish file %#', async (file, message) => {
    await expect(
      uploader(jest.fn<typeof fetch>()).publishFile({ file: file as never, retentionPeriod: 1 })
    ).rejects.toThrow(message)
  })

  it('rejects sparse byte arrays and reports an unmet quote threshold', async () => {
    const sparse = Array<number>(1)
    await expect(
      uploader(jest.fn<typeof fetch>()).publishFile({
        file: { data: sparse, type: 'application/octet-stream' },
        retentionPeriod: 1
      })
    ).rejects.toThrow('only bytes')

    const fetchClient = jest.fn<typeof fetch>(async () => new Response('', { status: 503 }))
    await expect(
      uploader(fetchClient).publishFile({
        file: { data: new Uint8Array([1, 2, 3]), type: 'application/octet-stream' },
        retentionPeriod: 1
      })
    ).rejects.toThrow('Resiliency threshold of 1 could not be met')
  })

  it.each([0, -1, 1.5])('rejects invalid renewal duration %p', async additionalMinutes => {
    await expect(
      uploader(jest.fn<typeof fetch>()).renewFile('uhrp://example', additionalMinutes)
    ).rejects.toThrow('positive safe integer')
  })

  it('rejects host scopes that do not intersect configured providers', async () => {
    const instance = uploader(jest.fn<typeof fetch>())
    await expect(
      instance.findFile('uhrp://example', { hostedBy: ['https://other.example'] })
    ).rejects.toThrow('did not intersect')
    await expect(instance.listUploads({ hostedBy: ['https://other.example'] })).rejects.toThrow(
      'did not intersect'
    )
    await expect(
      instance.renewFile('uhrp://example', 1, { hostedBy: ['https://other.example'] })
    ).rejects.toThrow('did not intersect')
  })

  it('uses the documented default provider set when no host is configured', async () => {
    const fetchClient = jest.fn<typeof fetch>(async () =>
      jsonResponse({ status: 'success', quote: 1 })
    )
    const instance = new StorageUploader({ wallet, fetchClient })
    await expect(instance.estimateCost({ fileSize: 1, retentionPeriod: 1 })).resolves.toMatchObject(
      {
        meetsResilienceThreshold: true,
        resilienceLevel: 1
      }
    )
    expect(fetchClient).toHaveBeenCalled()
  })

  it('publishes through a bounded authenticated upload route', async () => {
    const authenticatedFetch = jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(
      jsonResponse({
        status: 'success',
        uploadURL: 'https://uploads.example/file',
        requiredHeaders: { 'content-length': 3, 'x-upload-token': 'token' },
        amount: 2
      })
    )
    const fetchClient = jest.fn<typeof fetch>(async (input, init) => {
      if (String(input).endsWith('/quote')) {
        return jsonResponse({ status: 'success', quote: 2 })
      }
      expect(String(input)).toBe('https://uploads.example/file')
      expect(init).toMatchObject({
        method: 'PUT',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/octet-stream',
          'content-length': '3',
          'x-upload-token': 'token'
        }
      })
      return new Response('', { status: 200 })
    })
    const result = await uploader(fetchClient, ['https://one.example']).publishFile({
      file: { data: [1, 2, 3], type: 'application/octet-stream' },
      retentionPeriod: 60
    })
    expect(result).toMatchObject({ published: true, hostedBy: ['https://one.example'] })
    expect(result.uhrpURL).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/)
    expect(authenticatedFetch).toHaveBeenCalledWith(
      'https://one.example/upload',
      expect.objectContaining({ method: 'POST' })
    )
  })

  it.each([
    [new Response('', { status: 500 }), 'Upload info request failed'],
    [jsonResponse({ status: 'error' }), 'Upload route returned an error'],
    [jsonResponse({ status: 'success', requiredHeaders: {} }), 'omitted uploadURL'],
    [
      jsonResponse({
        status: 'success',
        uploadURL: 'https://upload.example',
        requiredHeaders: null
      }),
      'malformed JSON object'
    ],
    [
      jsonResponse({
        status: 'success',
        uploadURL: 'https://upload.example',
        requiredHeaders: { host: 'internal.example' }
      }),
      'unsafe required header name'
    ],
    [
      jsonResponse({
        status: 'success',
        uploadURL: 'https://upload.example',
        requiredHeaders: { 'content-length': '4' }
      }),
      'mismatched Content-Length'
    ],
    [
      jsonResponse({
        status: 'success',
        uploadURL: 'https://upload.example',
        requiredHeaders: { 'x-value': 3 }
      }),
      'invalid required header'
    ],
    [
      jsonResponse({
        status: 'success',
        uploadURL: 'https://upload.example',
        requiredHeaders: { 'x-value': 'safe\r\ninjected' }
      }),
      'unsafe required header value'
    ],
    [
      jsonResponse({
        status: 'success',
        uploadURL: 'https://upload.example',
        requiredHeaders: { 'x-value': 'x'.repeat(65536) }
      }),
      'too many required header bytes'
    ],
    [
      jsonResponse({
        status: 'success',
        uploadURL: 'https://upload.example',
        requiredHeaders: {},
        amount: -1
      }),
      'invalid amount'
    ]
  ])('rejects unsafe upload metadata %#', async (response, message) => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(response)
    const fetchClient = jest.fn<typeof fetch>(async () =>
      jsonResponse({ status: 'success', quote: 1 })
    )
    await expect(
      uploader(fetchClient, ['https://one.example']).publishFile({
        file: { data: [1, 2, 3], type: 'application/octet-stream' },
        retentionPeriod: 1
      })
    ).rejects.toThrow(message)
  })

  it('reports a failed object upload without claiming resilience', async () => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(
      jsonResponse({
        status: 'success',
        uploadURL: 'https://uploads.example/file',
        requiredHeaders: {}
      })
    )
    const fetchClient = jest.fn<typeof fetch>(async input =>
      String(input).endsWith('/quote')
        ? jsonResponse({ status: 'success', quote: 1 })
        : new Response('', { status: 503 })
    )
    await expect(
      uploader(fetchClient, ['https://one.example']).publishFile({
        file: { data: new Uint8Array([1]), type: 'application/octet-stream' },
        retentionPeriod: 1
      })
    ).rejects.toThrow('File upload failed: HTTP 503')
  })

  it('selects the longest-lived discovery result and records every reporting host', async () => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async input => {
      const first = String(input).startsWith('https://one.example/')
      return jsonResponse({
        status: 'success',
        data: {
          name: first ? 'older' : 'newer',
          size: '3',
          mimeType: 'text/plain',
          expiryTime: first ? 10 : 20
        }
      })
    })
    await expect(uploader(jest.fn<typeof fetch>()).findFile('uhrp://example')).resolves.toEqual({
      name: 'newer',
      size: '3',
      mimeType: 'text/plain',
      expiryTime: 20,
      hostedBy: ['https://two.example', 'https://one.example']
    })
  })

  it.each([
    [new Response('', { status: 404 }), 'findFile request failed'],
    [jsonResponse({ status: 'error', code: 'missing', description: 'gone' }), 'missing - gone'],
    [jsonResponse({ status: 'unknown' }), 'invalid status'],
    [jsonResponse({ status: 'success', data: { name: 'bad' } }), 'malformed file metadata']
  ])('preserves single-host discovery errors %#', async (response, message) => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(response)
    await expect(
      uploader(jest.fn<typeof fetch>(), ['https://one.example']).findFile('uhrp://example')
    ).rejects.toThrow(message)
  })

  it('reports every provider when no configured host can find a file', async () => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(new Response('', { status: 404 }))
    await expect(uploader(jest.fn<typeof fetch>()).findFile('uhrp://missing')).rejects.toThrow(
      'no configured host reported this UHRP URL'
    )
  })

  it('merges valid listings while ignoring malformed legacy entries and one failed host', async () => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async input => {
      if (String(input).startsWith('https://one.example/')) {
        return jsonResponse({
          status: 'success',
          uploads: [
            { uhrpUrl: 'uhrp://shared', expiryTime: 10 },
            { uhrpUrl: 'uhrp://one', expiryTime: 4 },
            { uhrpUrl: 4, expiryTime: 2 }
          ]
        })
      }
      return jsonResponse({
        status: 'success',
        uploads: [
          { uhrpUrl: 'uhrp://shared', expiryTime: 30 },
          { uhrpUrl: 'uhrp://bad', expiryTime: -1 }
        ]
      })
    })
    await expect(uploader(jest.fn<typeof fetch>()).listUploads()).resolves.toEqual([
      {
        uhrpUrl: 'uhrp://shared',
        expiryTime: 30,
        hostedBy: ['https://one.example', 'https://two.example']
      },
      { uhrpUrl: 'uhrp://one', expiryTime: 4, hostedBy: ['https://one.example'] }
    ])
  })

  it.each([
    [new Response('', { status: 500 }), 'listUploads request failed'],
    [
      jsonResponse({ status: 'error', code: 'denied', description: 'no access' }),
      'denied - no access'
    ],
    [jsonResponse({ status: 'success', uploads: {} }), 'malformed upload data']
  ])('preserves single-host listing errors %#', async (response, message) => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(response)
    await expect(
      uploader(jest.fn<typeof fetch>(), ['https://one.example']).listUploads()
    ).rejects.toThrow(message)
  })

  it('reports every provider when no configured host can return a listing', async () => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(new Response('', { status: 500 }))
    await expect(uploader(jest.fn<typeof fetch>()).listUploads()).rejects.toThrow(
      'no configured host returned a listing'
    )
  })

  it('aggregates successful renewals and reports each provider outcome', async () => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async input => {
      const first = String(input).startsWith('https://one.example/')
      return jsonResponse({
        status: 'success',
        prevExpiryTime: 5,
        newExpiryTime: first ? 10 : 20,
        amount: first ? 2 : 3
      })
    })
    await expect(
      uploader(jest.fn<typeof fetch>(), undefined, 2).renewFile('uhrp://example', 60)
    ).resolves.toMatchObject({
      status: 'success',
      prevExpiryTime: 5,
      newExpiryTime: 20,
      amount: 5,
      results: [
        { host: 'https://one.example', status: 'success' },
        { host: 'https://two.example', status: 'success' }
      ]
    })
  })

  it('exposes reconciliable outcomes when renewals miss the threshold', async () => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockImplementation(async input => {
      if (String(input).startsWith('https://one.example/')) {
        return jsonResponse({ status: 'success', newExpiryTime: 10, amount: 1 })
      }
      return new Response('', { status: 503 })
    })
    const promise = uploader(jest.fn<typeof fetch>(), undefined, 2).renewFile('uhrp://example', 1)
    await expect(promise).rejects.toBeInstanceOf(RenewResiliencyError)
    await expect(promise).rejects.toMatchObject({ requiredSuccesses: 2, successCount: 1 })
  })

  it.each([
    [new Response('', { status: 500 }), 'renewFile request failed'],
    [jsonResponse({ status: 'error', code: 'missing', description: 'gone' }), 'missing - gone'],
    [jsonResponse({ status: 'unknown' }), 'invalid status'],
    [jsonResponse({ status: 'success', amount: -1 }), 'invalid amount']
  ])('preserves single-host renewal errors %#', async (response, message) => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(response)
    await expect(
      uploader(jest.fn<typeof fetch>(), ['https://one.example']).renewFile('uhrp://example', 1)
    ).rejects.toThrow(message)
  })

  it('preserves a successful single-host renewal shape', async () => {
    jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue(
      jsonResponse({
        status: 'success',
        prevExpiryTime: 10,
        newExpiryTime: 20,
        amount: 3
      })
    )
    await expect(
      uploader(jest.fn<typeof fetch>(), ['https://one.example']).renewFile('uhrp://example', 1)
    ).resolves.toEqual({
      status: 'success',
      prevExpiryTime: 10,
      newExpiryTime: 20,
      amount: 3
    })
  })
})
