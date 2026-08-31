import { afterEach, describe, expect, it, jest } from '@jest/globals'
import type { StorageDownloader, StorageUploader } from '@bsv/sdk'
import {
  CHIRPContentSink,
  IndexedDBLicenseStore,
  MemoryLicenseStore,
  UHRPContentSink,
  UniversalContentSource,
  fetchLCH,
  type SignedObject
} from '../src/index.js'

const publicResolver = async (): Promise<string[]> => ['93.184.216.34']

describe('bounded content and endpoint adapters', () => {
  it('revalidates redirects and strips credentials across content origins', async () => {
    const connect = jest
      .fn<(url: URL, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(
        async () =>
          new Response(null, {
            status: 302,
            headers: { location: 'https://cdn.example/object' }
          })
      )
      .mockImplementationOnce(async () => new Response(Uint8Array.of(1, 2, 3)))
    const response = await fetchLCH(
      'https://origin.example/object',
      { headers: { authorization: 'secret', 'x-bsv-payment': 'proof' } },
      'content',
      { resolve: publicResolver, connect }
    )
    expect(response.ok).toBe(true)
    const redirectedHeaders = new Headers(connect.mock.calls[1][1].headers)
    expect(redirectedHeaders.has('authorization')).toBe(false)
    expect(redirectedHeaders.has('x-bsv-payment')).toBe(false)
  })

  it('allows only method-preserving same-origin identity redirects', async () => {
    const sameOrigin = jest
      .fn<(url: URL, init: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(
        async () => new Response(null, { status: 307, headers: { location: '/next' } })
      )
      .mockImplementationOnce(async () => new Response('ok'))
    await expect(
      fetchLCH('https://seller.example/start', { method: 'POST' }, 'identity', {
        resolve: publicResolver,
        connect: sameOrigin
      })
    ).resolves.toBeInstanceOf(Response)

    await expect(
      fetchLCH('https://seller.example/start', {}, 'identity', {
        resolve: publicResolver,
        connect: async () =>
          new Response(null, {
            status: 308,
            headers: { location: 'https://other.example/next' }
          })
      })
    ).rejects.toMatchObject({ code: 'ERR_LCH_ENDPOINT' })
  })

  it('uses CHIRP, UHRP, and bounded HTTPS sources', async () => {
    const chirpDownload = jest.fn(async () => ({ data: Uint8Array.of(1, 2, 3) }))
    const chirp = new UniversalContentSource({
      chirp: { download: chirpDownload },
      maximumBytes: 3
    })
    await expect(chirp.read('chirp://sha256.example', 1n, 2n)).resolves.toEqual(
      Uint8Array.of(1, 2, 3)
    )
    expect(chirpDownload).toHaveBeenCalledWith('chirp://sha256.example', {
      range: { start: 1n, endExclusive: 2n }
    })

    const endpointPolicy = {
      resolve: publicResolver,
      connect: async (): Promise<Response> => new Response(Uint8Array.of(4, 5))
    }
    const uhrp = {
      resolve: jest.fn(async () => ['https://storage.example/object'])
    } as unknown as StorageDownloader
    const source = new UniversalContentSource({ uhrp, endpointPolicy, maximumBytes: 2 })
    await expect(source.read('uhrp://example')).resolves.toEqual(Uint8Array.of(4, 5))
    await expect(source.read('https://storage.example/object')).resolves.toEqual(
      Uint8Array.of(4, 5)
    )

    const oversized = new UniversalContentSource({
      endpointPolicy: {
        resolve: publicResolver,
        connect: async () => new Response(Uint8Array.of(1, 2, 3))
      },
      maximumBytes: 2
    })
    await expect(oversized.read('https://storage.example/large')).rejects.toMatchObject({
      code: 'ERR_LCH_CONTENT_UNAVAILABLE'
    })
  })

  it('tries every resolved UHRP host until one succeeds', async () => {
    const uhrp = {
      resolve: jest.fn(async () => [
        'https://unavailable.example/object',
        'https://storage.example/object'
      ])
    } as unknown as StorageDownloader
    const connect = jest.fn(async (url: URL) =>
      url.hostname === 'unavailable.example'
        ? new Response('unavailable', { status: 503 })
        : new Response(Uint8Array.of(7, 8))
    )
    const source = new UniversalContentSource({
      uhrp,
      endpointPolicy: { resolve: publicResolver, connect },
      maximumBytes: 2
    })
    await expect(source.read('uhrp://example')).resolves.toEqual(Uint8Array.of(7, 8))
    expect(connect.mock.calls.map(call => call[0].hostname)).toEqual([
      'unavailable.example',
      'storage.example'
    ])
  })

  it('returns one stable error after exhausting resolved UHRP hosts', async () => {
    const uhrp = {
      resolve: jest.fn(async () => ['uhrp://recursive', 'https://unavailable.example/object'])
    } as unknown as StorageDownloader
    const source = new UniversalContentSource({
      uhrp,
      endpointPolicy: {
        resolve: publicResolver,
        connect: async () => new Response('unavailable', { status: 503 })
      }
    })
    await expect(source.read('uhrp://example')).rejects.toMatchObject({
      code: 'ERR_LCH_CONTENT_UNAVAILABLE',
      message: 'Every resolved UHRP host failed'
    })
  })

  it('publishes through CHIRP and legacy UHRP sinks', async () => {
    const publish = jest.fn(async () => ({ chirpURL: 'chirp://root' }))
    const chirp = new CHIRPContentSink({ publish }, 86_400, 'audio/wav')
    await expect(chirp.put(Uint8Array.of(1, 2))).resolves.toEqual(['chirp://root'])
    expect(publish).toHaveBeenCalledWith({
      source: Uint8Array.of(1, 2),
      retentionSeconds: 86_400,
      logicalLength: 2,
      mediaType: 'audio/wav'
    })

    const publishFile = jest.fn(async () => ({ uhrpURL: 'uhrp://hash' }))
    const uhrp = new UHRPContentSink(
      { publishFile } as unknown as StorageUploader,
      86_400,
      'audio/wav'
    )
    await expect(uhrp.put(Uint8Array.of(3))).resolves.toEqual(['uhrp://hash'])
  })
})

describe('license stores', () => {
  const originalIndexedDB = globalThis.indexedDB

  afterEach(() => {
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: originalIndexedDB
    })
  })

  it('stores and deletes in memory', async () => {
    const store = new MemoryLicenseStore()
    const license: SignedObject = { body: {}, signatures: [] }
    const record = { assetId: 'asset', offerId: 'offer', license, storedAt: 1n }
    await store.put(record)
    await expect(store.get('asset')).resolves.toEqual(record)
    await store.delete('asset', 'offer')
    await expect(store.get('asset', 'offer')).resolves.toBeUndefined()
  })

  it('stores, lists, and deletes through IndexedDB', async () => {
    const records = new Map<string, unknown>()
    const transactions: IDBTransaction[] = []
    const close = jest.fn()
    const request = (result: unknown): IDBRequest => {
      const value = {} as IDBRequest
      queueMicrotask(() => {
        Object.defineProperty(value, 'result', { configurable: true, value: result })
        value.onsuccess?.(new Event('success'))
      })
      return value
    }
    const objectStore = {
      put: (value: unknown, key: IDBValidKey) => {
        records.set(String(key), value)
        return request(key)
      },
      delete: (key: IDBValidKey) => {
        records.delete(String(key))
        return request(undefined)
      },
      getAll: () => request([...records.values()])
    } as unknown as IDBObjectStore
    const database = {
      createObjectStore: () => objectStore,
      close,
      transaction: () => {
        const transaction = {
          objectStore: () => objectStore
        } as IDBTransaction
        transactions.push(transaction)
        return transaction
      }
    } as unknown as IDBDatabase
    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      value: {
        open: () => {
          const open = {} as IDBOpenDBRequest
          queueMicrotask(() => {
            Object.defineProperty(open, 'result', { configurable: true, value: database })
            open.onupgradeneeded?.(new Event('upgradeneeded') as IDBVersionChangeEvent)
            open.onsuccess?.(new Event('success'))
          })
          return open
        }
      }
    })

    const store = new IndexedDBLicenseStore('test-lch')
    const record = {
      assetId: 'asset',
      offerId: 'offer',
      license: { body: {}, signatures: [] },
      storedAt: 1n
    }
    const complete = async <T>(operation: Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 10 && transactions.length === 0; attempt += 1)
        await Promise.resolve()
      const transaction = transactions.shift()
      if (transaction === undefined) throw new Error('IndexedDB transaction did not start')
      await Promise.resolve()
      transaction.oncomplete?.(new Event('complete'))
      return operation
    }

    let putSettled = false
    const put = store.put(record)
    void put.then(() => {
      putSettled = true
    })
    for (let attempt = 0; attempt < 10 && transactions.length === 0; attempt += 1)
      await Promise.resolve()
    await Promise.resolve()
    expect(putSettled).toBe(false)
    expect(close).not.toHaveBeenCalled()
    const putTransaction = transactions.shift()
    if (putTransaction === undefined) throw new Error('IndexedDB transaction did not start')
    putTransaction.oncomplete?.(new Event('complete'))
    await put
    expect(close).toHaveBeenCalledTimes(1)

    await expect(complete(store.get('asset'))).resolves.toEqual(record)
    await complete(store.delete('asset', 'offer'))
    await expect(complete(store.get('asset'))).resolves.toBeUndefined()
    expect(close).toHaveBeenCalledTimes(4)
  })
})
