import { StorageDownloader, StorageUploader } from '@bsv/sdk'
import { LCHError, lchAssert } from './errors.js'
import { fetchLCH, type EndpointPolicy } from './endpoints.js'
import type { ContentSink, ContentSource, LicenseStore, StoredLicense } from './types.js'

export type CHIRPInteger = number | bigint | string

export interface CHIRPDownloadAdapter {
  download(
    locator: string,
    options?: { range?: { start: bigint; endExclusive: bigint } }
  ): Promise<{ data: Uint8Array }>
}

export interface CHIRPUploadAdapter {
  publish(options: {
    source: Uint8Array
    retentionSeconds: CHIRPInteger
    logicalLength: CHIRPInteger
    mediaType?: string
  }): Promise<{ chirpURL: string }>
}

export interface UniversalContentSourceOptions {
  chirp?: CHIRPDownloadAdapter
  uhrp?: StorageDownloader
  endpointPolicy?: EndpointPolicy
  maximumBytes?: number
}

export class UniversalContentSource implements ContentSource {
  constructor(private readonly options: UniversalContentSourceOptions = {}) {}

  async read(locator: string, start?: bigint, end?: bigint): Promise<Uint8Array> {
    const maximum = this.options.maximumBytes ?? 512 * 1024 * 1024
    if (locator.startsWith('chirp://')) {
      lchAssert(
        this.options.chirp !== undefined,
        'ERR_LCH_PROFILE_UNSUPPORTED',
        'No CHIRP downloader is configured'
      )
      const data = (
        await this.options.chirp.download(
          locator,
          start === undefined || end === undefined
            ? undefined
            : { range: { start, endExclusive: end } }
        )
      ).data
      lchAssert(
        data.length <= maximum,
        'ERR_LCH_CONTENT_UNAVAILABLE',
        'Content exceeds download limit'
      )
      return data
    }
    if (locator.startsWith('uhrp://')) {
      const downloader = this.options.uhrp ?? new StorageDownloader({ networkPreset: 'mainnet' })
      const locations = await downloader.resolve(locator)
      lchAssert(locations.length > 0, 'ERR_LCH_CONTENT_UNAVAILABLE', 'No UHRP host resolved')
      let lastFailure: unknown
      for (const location of new Set(locations)) {
        try {
          lchAssert(
            !location.startsWith('uhrp://'),
            'ERR_LCH_CONTENT_UNAVAILABLE',
            'UHRP resolver returned a recursive locator'
          )
          return await this.read(location, start, end)
        } catch (error) {
          lastFailure = error
        }
      }
      throw new LCHError('ERR_LCH_CONTENT_UNAVAILABLE', 'Every resolved UHRP host failed', {
        cause: lastFailure
      })
    }
    const headers = new Headers()
    if (start !== undefined && end !== undefined) headers.set('range', `bytes=${start}-${end - 1n}`)
    const response = await fetchLCH(locator, { headers }, 'content', this.options.endpointPolicy)
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new LCHError('ERR_LCH_CONTENT_UNAVAILABLE', `Content host returned ${response.status}`)
    }
    const declared = response.headers.get('content-length')
    if (declared !== null)
      lchAssert(
        Number(declared) <= maximum,
        'ERR_LCH_CONTENT_UNAVAILABLE',
        'Content exceeds download limit'
      )
    return readBoundedBody(response, maximum)
  }
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  lchAssert(
    Number.isSafeInteger(maximum) && maximum >= 0,
    'ERR_LCH_CONTENT_UNAVAILABLE',
    'Download limit is invalid'
  )
  if (response.body === null) return new Uint8Array()
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      lchAssert(total <= maximum, 'ERR_LCH_CONTENT_UNAVAILABLE', 'Content exceeds download limit')
      parts.push(value)
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined)
    throw error
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

export class CHIRPContentSink implements ContentSink {
  constructor(
    private readonly uploader: CHIRPUploadAdapter,
    private readonly retentionSeconds: CHIRPInteger,
    private readonly mediaType = 'application/octet-stream'
  ) {}

  async put(ciphertext: Uint8Array): Promise<string[]> {
    const result = await this.uploader.publish({
      source: ciphertext,
      retentionSeconds: this.retentionSeconds,
      logicalLength: ciphertext.length,
      mediaType: this.mediaType
    })
    return [result.chirpURL]
  }
}

export class UHRPContentSink implements ContentSink {
  constructor(
    private readonly uploader: StorageUploader,
    private readonly retentionPeriod: number,
    private readonly mediaType = 'application/octet-stream'
  ) {}

  async put(ciphertext: Uint8Array): Promise<string[]> {
    const result = await this.uploader.publishFile({
      file: { data: ciphertext, type: this.mediaType },
      retentionPeriod: this.retentionPeriod
    })
    return [result.uhrpURL]
  }
}

export class MemoryContentSink implements ContentSink, ContentSource {
  private readonly content = new Map<string, Uint8Array>()
  private next = 0

  async put(ciphertext: Uint8Array): Promise<string[]> {
    const locator = `memory://lch/${this.next}`
    this.next += 1
    this.content.set(locator, ciphertext.slice())
    return [locator]
  }

  async read(locator: string, start = 0n, end?: bigint): Promise<Uint8Array> {
    const bytes = this.content.get(locator)
    lchAssert(bytes !== undefined, 'ERR_LCH_CONTENT_UNAVAILABLE', 'Memory content is unavailable')
    return bytes.slice(Number(start), end === undefined ? undefined : Number(end))
  }
}

export class MemoryLicenseStore implements LicenseStore {
  private readonly records = new Map<string, StoredLicense>()

  async get(assetId: string, offerId?: string): Promise<StoredLicense | undefined> {
    if (offerId !== undefined) return this.records.get(`${assetId}:${offerId}`)
    return Array.from(this.records.values()).find(record => record.assetId === assetId)
  }

  async put(record: StoredLicense): Promise<void> {
    this.records.set(`${record.assetId}:${record.offerId}`, record)
  }

  async delete(assetId: string, offerId: string): Promise<void> {
    this.records.delete(`${assetId}:${offerId}`)
  }
}

export class IndexedDBLicenseStore implements LicenseStore {
  constructor(
    private readonly databaseName = 'bsv-lch',
    private readonly storeName = 'licenses'
  ) {}

  async get(assetId: string, offerId?: string): Promise<StoredLicense | undefined> {
    const all = await this.all()
    return all.find(
      record => record.assetId === assetId && (offerId === undefined || record.offerId === offerId)
    )
  }

  async put(record: StoredLicense): Promise<void> {
    const database = await this.open()
    try {
      await transactionPromise(database, this.storeName, 'readwrite', store =>
        store.put(record, `${record.assetId}:${record.offerId}`)
      )
    } finally {
      database.close()
    }
  }

  async delete(assetId: string, offerId: string): Promise<void> {
    const database = await this.open()
    try {
      await transactionPromise(database, this.storeName, 'readwrite', store =>
        store.delete(`${assetId}:${offerId}`)
      )
    } finally {
      database.close()
    }
  }

  private async all(): Promise<StoredLicense[]> {
    const database = await this.open()
    try {
      return await transactionPromise(database, this.storeName, 'readonly', store => store.getAll())
    } finally {
      database.close()
    }
  }

  private async open(): Promise<IDBDatabase> {
    lchAssert(typeof indexedDB !== 'undefined', 'ERR_LCH_LICENSE', 'IndexedDB is unavailable')
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.databaseName, 1)
      request.onupgradeneeded = () => request.result.createObjectStore(this.storeName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'))
    })
  }
}

async function transactionPromise<T>(
  database: IDBDatabase,
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = action(transaction.objectStore(storeName))
    let result: T
    let requestSucceeded = false
    request.onsuccess = () => {
      result = request.result
      requestSucceeded = true
    }
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
    transaction.oncomplete = () => {
      if (requestSucceeded) resolve(result)
      else reject(new Error('IndexedDB transaction completed before its request'))
    }
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed'))
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  })
}
