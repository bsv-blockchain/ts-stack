import { StorageDownloader } from '@bsv/sdk/storage/StorageDownloader'
import { StorageUploader } from '@bsv/sdk/storage/StorageUploader'
import { LCH_LIMITS } from './constants.js'
import { LCHError, lchAssert } from './errors.js'
import { fetchLCH, type EndpointPolicy } from './endpoints.js'
import type { ContentSink, ContentSource, LicenseStore, StoredLicense } from './types.js'
import {
  ownDataValue,
  requiredOwnDataValue,
  snapshotBytes,
  snapshotStringArray
} from './boundary.js'

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
  private readonly chirp?: CHIRPDownloadAdapter
  private readonly uhrp?: StorageDownloader
  private readonly endpointPolicy?: EndpointPolicy
  private readonly maximumBytes: number

  constructor(options: UniversalContentSourceOptions = {}) {
    const chirp = ownDataValue(options, 'chirp', 'Content source options')
    const uhrp = ownDataValue(options, 'uhrp', 'Content source options')
    const endpointPolicy = ownDataValue(options, 'endpointPolicy', 'Content source options')
    const maximumBytes = ownDataValue(options, 'maximumBytes', 'Content source options')
    lchAssert(
      chirp === undefined ||
        (chirp !== null &&
          typeof chirp === 'object' &&
          typeof (chirp as CHIRPDownloadAdapter).download === 'function'),
      'ERR_LCH_CONTENT_UNAVAILABLE',
      'CHIRP downloader is invalid'
    )
    lchAssert(
      uhrp === undefined || (uhrp !== null && typeof uhrp === 'object'),
      'ERR_LCH_CONTENT_UNAVAILABLE',
      'UHRP downloader is invalid'
    )
    lchAssert(
      endpointPolicy === undefined ||
        (endpointPolicy !== null && typeof endpointPolicy === 'object'),
      'ERR_LCH_ENDPOINT',
      'Content endpoint policy is invalid'
    )
    this.chirp = chirp as CHIRPDownloadAdapter | undefined
    this.uhrp = uhrp as StorageDownloader | undefined
    this.endpointPolicy = endpointPolicy as EndpointPolicy | undefined
    this.maximumBytes = (maximumBytes as number | undefined) ?? 512 * 1024 * 1024
  }

  async read(locator: string, start?: bigint, end?: bigint): Promise<Uint8Array> {
    const maximum = this.maximumBytes
    lchAssert(
      Number.isSafeInteger(maximum) && maximum >= 0,
      'ERR_LCH_CONTENT_UNAVAILABLE',
      'Download limit is invalid'
    )
    lchAssert(
      typeof locator === 'string' && locator.length > 0 && locator.length <= 8192,
      'ERR_LCH_CONTENT_UNAVAILABLE',
      'Content locator is invalid'
    )
    const hasStart = start !== undefined
    const hasEnd = end !== undefined
    lchAssert(
      hasStart === hasEnd &&
        (!hasStart ||
          (typeof start === 'bigint' &&
            typeof end === 'bigint' &&
            start >= 0n &&
            start < end &&
            end - start <= BigInt(maximum))),
      'ERR_LCH_CONTENT_UNAVAILABLE',
      'Content range is invalid or exceeds the download limit'
    )
    if (locator.startsWith('chirp://')) {
      lchAssert(
        this.chirp !== undefined,
        'ERR_LCH_PROFILE_UNSUPPORTED',
        'No CHIRP downloader is configured'
      )
      const result = await this.chirp.download(
        locator,
        start === undefined || end === undefined
          ? undefined
          : { range: { start, endExclusive: end } }
      )
      const data = requiredOwnDataValue(result, 'data', 'CHIRP download result')
      lchAssert(
        data instanceof Uint8Array &&
          data.length <= maximum &&
          (start === undefined || end === undefined || data.length === Number(end - start)),
        'ERR_LCH_CONTENT_UNAVAILABLE',
        'CHIRP content is malformed, oversized, or does not match the requested range'
      )
      return snapshotBytes(data, 'CHIRP content')
    }
    if (locator.startsWith('uhrp://')) {
      const downloader = this.uhrp ?? new StorageDownloader({ networkPreset: 'mainnet' })
      const locations = snapshotStringArray(
        await downloader.resolve(locator),
        'UHRP resolver result'
      )
      lchAssert(
        Array.isArray(locations) &&
          locations.length > 0 &&
          locations.length <= LCH_LIMITS.cborEntries &&
          locations.every(
            location =>
              typeof location === 'string' && location.length > 0 && location.length <= 8192
          ),
        'ERR_LCH_CONTENT_UNAVAILABLE',
        'UHRP resolver returned no usable or bounded hosts'
      )
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
    const response = await fetchLCH(locator, { headers }, 'content', this.endpointPolicy)
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      throw new LCHError('ERR_LCH_CONTENT_UNAVAILABLE', `Content host returned ${response.status}`)
    }
    const expectedRangeLength =
      start === undefined || end === undefined ? undefined : Number(end - start)
    if (expectedRangeLength === undefined) {
      lchAssert(
        response.status === 200,
        'ERR_LCH_CONTENT_UNAVAILABLE',
        'Content host returned an unsolicited partial response'
      )
    } else if (start !== undefined && end !== undefined) {
      validateContentRange(response, start, end)
    }
    const declared = response.headers.get('content-length')
    if (declared !== null)
      lchAssert(
        /^\d+$/u.test(declared) &&
          Number(declared) <= maximum &&
          (expectedRangeLength === undefined || Number(declared) === expectedRangeLength),
        'ERR_LCH_CONTENT_UNAVAILABLE',
        'Content length is invalid or does not match the requested range'
      )
    const data = await readBoundedBody(response, expectedRangeLength ?? maximum)
    lchAssert(
      expectedRangeLength === undefined || data.length === expectedRangeLength,
      'ERR_LCH_CONTENT_UNAVAILABLE',
      'Content body does not match the requested range'
    )
    return data
  }
}

function validateContentRange(response: Response, start: bigint, end: bigint): void {
  const value = response.headers.get('content-range')
  const match = value === null ? null : /^bytes (\d+)-(\d+)\/(\d+|\*)$/u.exec(value)
  let valid = response.status === 206 && match !== null
  if (match !== null) {
    const first = BigInt(match[1])
    const last = BigInt(match[2])
    const total = match[3] === '*' ? undefined : BigInt(match[3])
    valid = valid && first === start && last + 1n === end && (total === undefined || total >= end)
  }
  lchAssert(
    valid,
    'ERR_LCH_CONTENT_UNAVAILABLE',
    'Content host did not return the exact requested byte range'
  )
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
      source: snapshotBytes(ciphertext, 'CHIRP content'),
      retentionSeconds: this.retentionSeconds,
      logicalLength: ciphertext.length,
      mediaType: this.mediaType
    })
    const chirpURL = requiredOwnDataValue(result, 'chirpURL', 'CHIRP upload result')
    lchAssert(typeof chirpURL === 'string', 'ERR_LCH_CONTENT_UNAVAILABLE', 'CHIRP URL is invalid')
    return [chirpURL]
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
      file: { data: snapshotBytes(ciphertext, 'UHRP content'), type: this.mediaType },
      retentionPeriod: this.retentionPeriod
    })
    const uhrpURL = requiredOwnDataValue(result, 'uhrpURL', 'UHRP upload result')
    lchAssert(typeof uhrpURL === 'string', 'ERR_LCH_CONTENT_UNAVAILABLE', 'UHRP URL is invalid')
    return [uhrpURL]
  }
}

export class MemoryContentSink implements ContentSink, ContentSource {
  private readonly content = new Map<string, Uint8Array>()
  private next = 0

  async put(ciphertext: Uint8Array): Promise<string[]> {
    const locator = `memory://lch/${this.next}`
    this.next += 1
    this.content.set(locator, snapshotBytes(ciphertext, 'Memory content'))
    return [locator]
  }

  async read(locator: string, start = 0n, end?: bigint): Promise<Uint8Array> {
    const bytes = this.content.get(locator)
    lchAssert(bytes !== undefined, 'ERR_LCH_CONTENT_UNAVAILABLE', 'Memory content is unavailable')
    lchAssert(
      typeof start === 'bigint' &&
        start >= 0n &&
        start <= BigInt(Number.MAX_SAFE_INTEGER) &&
        (end === undefined ||
          (typeof end === 'bigint' && end >= start && end <= BigInt(Number.MAX_SAFE_INTEGER))),
      'ERR_LCH_CONTENT_UNAVAILABLE',
      'Memory content range is invalid'
    )
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
