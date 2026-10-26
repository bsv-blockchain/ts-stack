import { AuthFetch } from '../auth/clients/AuthFetch.js'
import { WalletInterface } from '../wallet/Wallet.interfaces.js'
import { getURLForFile } from './StorageUtils.js'
import { toArray, toUTF8Strict } from '../primitives/utils.js'
import { createPublicHTTPSFetch, isPublicNetworkAddress } from './PublicHTTPSFetch.js'

const MAX_PROVIDER_RESPONSE_BYTES = 1024 * 1024
const MAX_SATOSHIS = 21e14
const UNSAFE_HEADER_NAMES = new Set([
  'connection',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

/** Default UHRP storage providers used when the caller passes no host list. */
export const DEFAULT_UHRP_SERVERS: string[] = [
  'https://nanostore.babbage.systems',
  'https://bsv-storage-cloudflare.dev-a3e.workers.dev'
]

export interface UploaderConfig {
  /** Legacy single-host URL. Mutually exclusive with `storageURLs`. */
  storageURL?: string
  /** Explicit provider list. Takes precedence over `storageURL`. */
  storageURLs?: string[]
  /** Minimum replicas to store the file on. Defaults to 1. */
  resilienceLevel?: number
  wallet: WalletInterface
  /** Explicit transport injection for controlled/test environments. */
  fetchClient?: typeof fetch
}

export interface UploadableFile {
  data: Uint8Array | number[]
  type: string
}

export interface UploadFileResult {
  published: boolean
  uhrpURL: string
  /** Providers that successfully hosted the file. */
  hostedBy: string[]
}

export interface FindFileData {
  name: string
  size: string
  mimeType: string
  expiryTime: number
  /** Providers that reported this UHRP URL. Omitted in single-host mode. */
  hostedBy?: string[]
}

export interface RenewPerHostResult {
  host: string
  status: 'success' | 'error'
  prevExpiryTime?: number
  newExpiryTime?: number
  amount?: number
  error?: string
}

export interface RenewFileResult {
  status: string
  prevExpiryTime?: number
  newExpiryTime?: number
  /** Total satoshis paid across every host that renewed. */
  amount?: number
  /** Per-host outcomes. Omitted in single-host mode. */
  results?: RenewPerHostResult[]
}

export interface HostScopeOptions {
  /** Restrict the operation to this subset of configured providers. */
  hostedBy?: string[]
}

export interface EstimateCostResult {
  /** Cheapest-first quotes from configured providers. */
  quotes: Array<{ host: string; amount: number }>
  resilienceLevel: number
  /** Sum of the cheapest `resilienceLevel` amounts (or all collected, if below threshold). */
  totalForResilience: number
  /** False when `publishFile` would throw without uploading. */
  meetsResilienceThreshold: boolean
}

/**
 * Thrown by `renewFile` when successful renewals fall below the resilience
 * threshold. Per-host outcomes are attached so callers can reconcile which
 * providers were billed.
 */
export class RenewResiliencyError extends Error {
  readonly results: RenewPerHostResult[]
  readonly requiredSuccesses: number
  readonly successCount: number

  constructor(
    message: string,
    results: RenewPerHostResult[],
    requiredSuccesses: number,
    successCount: number
  ) {
    super(message)
    this.name = 'RenewResiliencyError'
    this.results = results
    this.requiredSuccesses = requiredSuccesses
    this.successCount = successCount
  }
}

interface ProviderQuote {
  host: string
  amount: number
}

interface ListUploadsSuccess {
  ok: true
  host: string
  data: any
}

interface ListUploadsFailure {
  ok: false
  host: string
  error: Error
}

type ListUploadsOutcome = ListUploadsSuccess | ListUploadsFailure

function normalizeStorageHost(value: string): string {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new Error('Storage provider must be an exact HTTPS origin.')
  }
  let host: URL
  try {
    host = new URL(value)
  } catch {
    throw new Error('Storage provider must be an absolute HTTPS origin.')
  }
  if (
    host.protocol !== 'https:' ||
    host.username !== '' ||
    host.password !== '' ||
    host.search !== '' ||
    host.hash !== '' ||
    (host.pathname !== '' && host.pathname !== '/')
  ) {
    throw new Error('Storage provider must be a credential-free HTTPS origin.')
  }
  const literal = /^[\d.]+$/.test(host.hostname) || host.hostname.includes(':')
  if (literal && !isPublicNetworkAddress(host.hostname)) {
    throw new Error('Storage provider must not target a private or special address.')
  }
  return host.origin
}

function providerRecord(value: unknown): Record<string, any> {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Storage provider returned a malformed JSON object.')
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== null && prototype !== Object.prototype) {
    throw new Error('Storage provider returned an unsafe JSON object.')
  }
  return value as Record<string, any>
}

async function readProviderJSON(response: Response): Promise<Record<string, any>> {
  const declared = response.headers.get('Content-Length')
  let declaredBytes: number | undefined
  if (declared !== null) {
    if (!/^\d+$/.test(declared) || Number(declared) > MAX_PROVIDER_RESPONSE_BYTES) {
      throw new Error('Storage provider response exceeds the configured size limit.')
    }
    declaredBytes = Number(declared)
  }
  if (response.body == null) throw new Error('Storage provider returned an empty response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.length
    if (
      !Number.isSafeInteger(total) ||
      total > MAX_PROVIDER_RESPONSE_BYTES ||
      (declaredBytes !== undefined && total > declaredBytes)
    ) {
      await reader.cancel('Storage provider response exceeds the configured size limit')
      throw new Error('Storage provider response exceeds the configured size limit.')
    }
    chunks.push(value)
  }
  if (declaredBytes !== undefined && total !== declaredBytes) {
    throw new Error('Storage provider response differs from its declared length.')
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  try {
    return providerRecord(JSON.parse(toUTF8Strict(bytes)))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Storage provider returned')) {
      throw error
    }
    throw new Error('Storage provider returned malformed JSON.', { cause: error })
  }
}

function validateUploadHeaders(
  value: unknown,
  expectedContentLength: number
): Record<string, string> {
  const record = providerRecord(value)
  const headers: Record<string, string> = Object.create(null)
  let encodedBytes = 0
  for (const key of Reflect.ownKeys(record)) {
    if (
      typeof key !== 'string' ||
      key === '__proto__' ||
      key === 'constructor' ||
      key === 'prototype'
    ) {
      throw new Error('Upload route returned an unsafe required header name.')
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, key)
    if (descriptor == null || !('value' in descriptor)) {
      throw new Error('Upload route returned an invalid required header.')
    }
    const name = key.toLowerCase()
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || UNSAFE_HEADER_NAMES.has(name)) {
      throw new Error('Upload route returned an unsafe required header name.')
    }
    const headerValue = descriptor.value
    if (name === 'content-length') {
      const canonical =
        typeof headerValue === 'number' && Number.isSafeInteger(headerValue)
          ? String(headerValue)
          : headerValue
      if (
        typeof canonical !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(canonical) ||
        Number(canonical) !== expectedContentLength
      ) {
        throw new Error('Upload route returned a mismatched Content-Length header.')
      }
      encodedBytes += name.length + canonical.length
      headers[name] = canonical
      continue
    }
    if (typeof headerValue !== 'string') {
      throw new Error('Upload route returned an invalid required header.')
    }
    if (/[\r\n]/.test(headerValue)) {
      throw new Error('Upload route returned an unsafe required header value.')
    }
    encodedBytes += toArray(name, 'utf8').length + toArray(headerValue, 'utf8').length
    if (encodedBytes > 64 * 1024) {
      throw new Error('Upload route returned too many required header bytes.')
    }
    headers[name] = headerValue
  }
  return headers
}

/**
 * Client for publishing, finding, listing, and renewing UHRP-hosted files
 * across one or more storage providers.
 */
export class StorageUploader {
  private readonly authFetch: AuthFetch
  private readonly fetchClient: typeof fetch
  private readonly hosts: string[]
  private readonly resilienceLevel: number

  constructor(config: UploaderConfig) {
    const legacySingleHost =
      config.storageURLs === undefined && typeof config.storageURL === 'string'

    let hosts: string[]
    if (config.storageURLs !== undefined) {
      if (config.storageURLs.length === 0) {
        throw new Error('StorageUploader requires at least one storage provider.')
      }
      hosts = [...config.storageURLs]
    } else if (typeof config.storageURL === 'string') {
      hosts = [config.storageURL]
    } else {
      hosts = [...DEFAULT_UHRP_SERVERS]
    }

    const requestedLevel = config.resilienceLevel ?? 1
    if (!Number.isInteger(requestedLevel) || requestedLevel < 1) {
      throw new Error('resilienceLevel must be a positive integer.')
    }

    hosts = Array.from(new Set(hosts.map(normalizeStorageHost)))

    // Legacy `storageURL` callers must not start demanding extra replicas.
    this.resilienceLevel = legacySingleHost ? 1 : requestedLevel
    if (this.resilienceLevel > hosts.length) {
      throw new Error('resilienceLevel cannot exceed the number of unique storage providers.')
    }
    this.hosts = hosts
    this.fetchClient = config.fetchClient ?? createPublicHTTPSFetch()
    this.authFetch = new AuthFetch(
      config.wallet,
      undefined,
      undefined,
      undefined,
      {},
      this.fetchClient
    )
  }

  /** Returns `null` when the provider is unreachable or errors out. */
  async #getQuote(
    host: string,
    fileSize: number,
    retentionPeriod: number
  ): Promise<ProviderQuote | null> {
    try {
      const response = await this.fetchClient(`${host}/quote`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileSize, retentionPeriod }),
        redirect: 'error'
      })
      if (!response.ok) return null
      const data = await readProviderJSON(response)
      if (
        data.status === 'error' ||
        !Number.isSafeInteger(data.quote) ||
        data.quote < 0 ||
        data.quote > MAX_SATOSHIS
      ) {
        return null
      }
      return { host, amount: data.quote }
    } catch {
      return null
    }
  }

  /** Drives the authenticated `/upload` route; `AuthFetch` handles the 402 payment flow. */
  async #getUploadURL(
    host: string,
    fileSize: number,
    retentionPeriod: number
  ): Promise<{
    uploadURL: string
    requiredHeaders: Record<string, string>
    amount?: number
  }> {
    const response = await this.authFetch.fetch(`${host}/upload`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileSize, retentionPeriod })
    })
    if (!response.ok) {
      throw new Error(`Upload info request failed: HTTP ${response.status}`)
    }
    const data = await readProviderJSON(response)
    if (data.status !== 'success') {
      throw new Error('Upload route returned an error.')
    }
    if (typeof data.uploadURL !== 'string') throw new Error('Upload route omitted uploadURL.')
    const requiredHeaders = validateUploadHeaders(data.requiredHeaders, fileSize)
    if (
      data.amount !== undefined &&
      (!Number.isSafeInteger(data.amount) || data.amount < 0 || data.amount > MAX_SATOSHIS)
    ) {
      throw new Error('Upload route returned an invalid amount.')
    }
    return {
      uploadURL: data.uploadURL,
      requiredHeaders,
      amount: data.amount
    }
  }

  async #putFile(
    uploadURL: string,
    data: Uint8Array,
    contentType: string,
    requiredHeaders: Record<string, string>
  ): Promise<void> {
    const response = await this.fetchClient(uploadURL, {
      method: 'PUT',
      body: data as BodyInit,
      headers: {
        'Content-Type': contentType,
        ...requiredHeaders
      },
      redirect: 'error'
    })
    if (!response.ok) {
      throw new Error(`File upload failed: HTTP ${response.status}`)
    }
  }

  /**
   * Collects quotes in parallel batches, shrinking each batch to only the
   * remaining quotes still needed so we never over-query once the quote
   * budget is satisfied.
   */
  async #collectQuotes(
    fileSize: number,
    retentionPeriod: number,
    maxNeeded: number
  ): Promise<ProviderQuote[]> {
    const quotes: ProviderQuote[] = []
    let index = 0
    while (index < this.hosts.length && quotes.length < maxNeeded) {
      const remaining = maxNeeded - quotes.length
      const batch = this.hosts.slice(index, index + remaining)
      index += batch.length
      const results = await Promise.all(
        batch.map(async host => await this.#getQuote(host, fileSize, retentionPeriod))
      )
      for (const quote of results) {
        if (quote !== null && quotes.length < maxNeeded) {
          quotes.push(quote)
        }
      }
    }
    return quotes
  }

  /**
   * Queries the unauthenticated `/quote` endpoint on up to `2 * resilienceLevel`
   * providers and returns the cheapest-first quote list plus the aggregate
   * cost `publishFile` would pay. No provider is billed.
   */
  public async estimateCost(params: {
    fileSize: number
    retentionPeriod: number
  }): Promise<EstimateCostResult> {
    const { fileSize, retentionPeriod } = params
    if (!Number.isSafeInteger(fileSize) || fileSize < 0) {
      throw new RangeError('fileSize must be a non-negative safe integer.')
    }
    if (!Number.isSafeInteger(retentionPeriod) || retentionPeriod < 1) {
      throw new RangeError('retentionPeriod must be a positive safe integer.')
    }
    const quotes = await this.#collectQuotes(fileSize, retentionPeriod, this.resilienceLevel * 2)
    quotes.sort((a, b) => a.amount - b.amount)

    const meetsResilienceThreshold = quotes.length >= this.resilienceLevel
    const budget = meetsResilienceThreshold ? quotes.slice(0, this.resilienceLevel) : quotes
    const totalForResilience = budget.reduce((sum, q) => sum + q.amount, 0)

    return {
      quotes: quotes.map(q => ({ host: q.host, amount: q.amount })),
      resilienceLevel: this.resilienceLevel,
      totalForResilience,
      meetsResilienceThreshold
    }
  }

  /**
   * Publishes a file across the cheapest configured providers, falling
   * through to the next-cheapest quote if a paid upload fails. Throws when
   * the resilience threshold cannot be met.
   */
  public async publishFile(params: {
    file: UploadableFile
    retentionPeriod: number
  }): Promise<UploadFileResult> {
    const { file, retentionPeriod } = params
    if (file == null || typeof file !== 'object') throw new TypeError('file must be an object.')
    if (
      typeof file.type !== 'string' ||
      file.type.length < 1 ||
      file.type.length > 255 ||
      /[\r\n]/.test(file.type)
    ) {
      throw new TypeError('file.type must be a valid MIME type string.')
    }
    if (!(file.data instanceof Uint8Array) && !Array.isArray(file.data)) {
      throw new TypeError('file.data must be a byte array.')
    }
    if (Array.isArray(file.data)) {
      for (let i = 0; i < file.data.length; i++) {
        if (
          !Object.prototype.hasOwnProperty.call(file.data, i) ||
          !Number.isInteger(file.data[i]) ||
          file.data[i] < 0 ||
          file.data[i] > 255
        ) {
          throw new TypeError('file.data must contain only bytes.')
        }
      }
    }
    const data = file.data instanceof Uint8Array ? file.data : Uint8Array.from(file.data)
    const fileSize = data.byteLength

    const estimate = await this.estimateCost({ fileSize, retentionPeriod })

    if (!estimate.meetsResilienceThreshold) {
      throw new Error(
        `Resiliency threshold of ${this.resilienceLevel} could not be met: ` +
          `only ${estimate.quotes.length} of ${this.hosts.length} provider(s) responded with quotes.`
      )
    }

    const uhrpURL = getURLForFile(data)
    const hostedBy: string[] = []
    const failures: Array<{ host: string; error: string }> = []

    for (const quote of estimate.quotes) {
      if (hostedBy.length >= this.resilienceLevel) break
      try {
        const { uploadURL, requiredHeaders } = await this.#getUploadURL(
          quote.host,
          fileSize,
          retentionPeriod
        )
        await this.#putFile(uploadURL, data, file.type, requiredHeaders)
        hostedBy.push(quote.host)
      } catch (e) {
        failures.push({ host: quote.host, error: (e as Error).message })
      }
    }

    if (hostedBy.length < this.resilienceLevel) {
      const detail = failures.map(f => `${f.host}: ${f.error}`).join('; ')
      throw new Error(
        `Resiliency threshold of ${this.resilienceLevel} could not be met: ` +
          `only ${hostedBy.length} upload(s) succeeded. Failures — ${detail}`
      )
    }

    return {
      published: true,
      uhrpURL,
      hostedBy
    }
  }

  async #findFileAtHost(host: string, uhrpUrl: string): Promise<FindFileData> {
    const url = new URL(`${host}/find`)
    url.searchParams.set('uhrpUrl', uhrpUrl)

    const response = await this.authFetch.fetch(url.toString(), {
      method: 'GET'
    })
    if (!response.ok) {
      throw new Error(`findFile request failed: HTTP ${response.status}`)
    }

    const data = await readProviderJSON(response)

    if (data.status === 'error') {
      const errCode = data.code ?? 'unknown-code'
      const errDesc = data.description ?? 'no-description'
      throw new Error(`findFile returned an error: ${errCode} - ${errDesc}`)
    }
    if (data.status !== 'success') throw new Error('findFile returned an invalid status.')
    const file = providerRecord(data.data)
    if (
      typeof file.name !== 'string' ||
      typeof file.size !== 'string' ||
      typeof file.mimeType !== 'string' ||
      !Number.isSafeInteger(file.expiryTime) ||
      file.expiryTime < 0
    ) {
      throw new Error('findFile returned malformed file metadata.')
    }
    return file as FindFileData
  }

  async #renewFileAtHost(
    host: string,
    uhrpUrl: string,
    additionalMinutes: number
  ): Promise<{ status: string; prevExpiryTime?: number; newExpiryTime?: number; amount?: number }> {
    const response = await this.authFetch.fetch(`${host}/renew`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uhrpUrl, additionalMinutes })
    })
    if (!response.ok) {
      throw new Error(`renewFile request failed: HTTP ${response.status}`)
    }

    const data = await readProviderJSON(response)

    if (data.status === 'error') {
      const errCode = data.code ?? 'unknown-code'
      const errDesc = data.description ?? 'no-description'
      throw new Error(`renewFile returned an error: ${errCode} - ${errDesc}`)
    }

    if (data.status !== 'success') throw new Error('renewFile returned an invalid status.')
    for (const field of ['prevExpiryTime', 'newExpiryTime', 'amount']) {
      if (
        data[field] !== undefined &&
        (!Number.isSafeInteger(data[field]) || data[field] < 0 || data[field] > MAX_SATOSHIS)
      ) {
        throw new Error(`renewFile returned an invalid ${field}.`)
      }
    }
    return {
      status: data.status,
      prevExpiryTime: data.prevExpiryTime,
      newExpiryTime: data.newExpiryTime,
      amount: data.amount
    }
  }

  /** Intersects `hostedBy` with the configured host set; throws when empty. */
  #resolveTargets(hostedBy?: string[]): string[] {
    if (hostedBy === undefined) return this.hosts
    const configured = new Set(this.hosts)
    const intersection = Array.from(new Set(hostedBy.filter(h => configured.has(h))))
    if (intersection.length === 0) {
      throw new Error(
        'hostedBy did not intersect any configured provider. ' +
          'Provide hosts that were also passed to the StorageUploader constructor.'
      )
    }
    return intersection
  }

  /**
   * Fans `/find` out across configured hosts (UHRP storage is host-local,
   * so any one host may not know the file) and returns the record with the
   * longest remaining expiry. Single-host configurations preserve the
   * legacy error-message contract verbatim.
   */
  public async findFile(uhrpUrl: string, options: HostScopeOptions = {}): Promise<FindFileData> {
    const targets = this.#resolveTargets(options.hostedBy)

    const outcomes = await Promise.all(
      targets.map(async host => {
        try {
          return { ok: true, host, data: await this.#findFileAtHost(host, uhrpUrl) } as const
        } catch (e) {
          return { ok: false, host, error: e as Error } as const
        }
      })
    )

    const successes = outcomes.flatMap(o => (o.ok ? [o] : []))
    if (successes.length === 0) {
      const failures = outcomes.flatMap(o => (o.ok ? [] : [o]))
      if (targets.length === 1) throw failures[0].error
      const detail = failures.map(f => `${f.host}: ${f.error.message}`).join('; ')
      throw new Error(`findFile: no configured host reported this UHRP URL — ${detail}`)
    }

    successes.sort((a, b) => b.data.expiryTime - a.data.expiryTime)
    const best = successes[0]

    if (targets.length === 1) {
      return best.data
    }
    return {
      ...best.data,
      hostedBy: successes.map(s => s.host)
    }
  }

  async #listUploadsAtTargets(targets: string[]): Promise<ListUploadsOutcome[]> {
    return await Promise.all(
      targets.map(async host => {
        try {
          return { ok: true, host, data: await this.#listUploadsAtHost(host) } as const
        } catch (error) {
          return { ok: false, host, error: error as Error } as const
        }
      })
    )
  }

  #requireListUploadSuccesses(
    outcomes: ListUploadsOutcome[],
    targetCount: number
  ): ListUploadsSuccess[] {
    const successes = outcomes.filter((outcome): outcome is ListUploadsSuccess => outcome.ok)
    if (successes.length > 0) return successes

    const failures = outcomes.filter((outcome): outcome is ListUploadsFailure => !outcome.ok)
    if (targetCount === 1) throw failures[0].error
    const detail = failures.map(failure => `${failure.host}: ${failure.error.message}`).join('; ')
    throw new Error(`listUploads: no configured host returned a listing — ${detail}`)
  }

  #mergeUploadListings(
    successes: ListUploadsSuccess[]
  ): Array<{ uhrpUrl: string; expiryTime: number; hostedBy: string[] }> {
    const merged = new Map<string, { uhrpUrl: string; expiryTime: number; hostedBy: string[] }>()
    for (const { host, data } of successes) {
      if (!Array.isArray(data)) continue
      for (const entry of data) this.#mergeUploadEntry(merged, host, entry)
    }
    return Array.from(merged.values())
  }

  #mergeUploadEntry(
    merged: Map<string, { uhrpUrl: string; expiryTime: number; hostedBy: string[] }>,
    host: string,
    entry: any
  ): void {
    const key = entry?.uhrpUrl
    if (
      typeof key !== 'string' ||
      !Number.isSafeInteger(entry.expiryTime) ||
      entry.expiryTime < 0
    ) {
      return
    }
    const expiry = entry.expiryTime
    const existing = merged.get(key)
    if (existing === undefined) {
      merged.set(key, { uhrpUrl: key, expiryTime: expiry, hostedBy: [host] })
      return
    }
    existing.expiryTime = Math.max(existing.expiryTime, expiry)
    if (!existing.hostedBy.includes(host)) existing.hostedBy.push(host)
  }

  /**
   * Unions `/list` output across configured hosts, merging duplicate UHRP
   * URLs by the longest expiry observed. One failing host does not hide
   * the rest. Single-host configurations preserve the legacy error contract.
   */
  public async listUploads(options: HostScopeOptions = {}): Promise<any> {
    const targets = this.#resolveTargets(options.hostedBy)
    const outcomes = await this.#listUploadsAtTargets(targets)
    const successes = this.#requireListUploadSuccesses(outcomes, targets.length)
    return targets.length === 1 ? successes[0].data : this.#mergeUploadListings(successes)
  }

  async #listUploadsAtHost(host: string): Promise<any> {
    const response = await this.authFetch.fetch(`${host}/list`, { method: 'GET' })
    if (!response.ok) {
      throw new Error(`listUploads request failed: HTTP ${response.status}`)
    }

    const data = await readProviderJSON(response)
    if (data.status === 'error') {
      const errCode = (data.code as string) ?? 'unknown-code'
      const errDesc = (data.description as string) ?? 'no-description'
      throw new Error(`listUploads returned an error: ${errCode} - ${errDesc}`)
    }
    if (data.status !== 'success' || !Array.isArray(data.uploads)) {
      throw new Error('listUploads returned malformed upload data.')
    }
    return data.uploads
  }

  /**
   * Fans `/renew` out across every configured host (each provider owns its
   * own advertisement, so a single-host renewal would degrade resilience
   * over time). Hosts that do not carry the file are not billed. Throws
   * {@link RenewResiliencyError} when successful renewals fall below the
   * resilience threshold.
   */
  public async renewFile(
    uhrpUrl: string,
    additionalMinutes: number,
    options: HostScopeOptions = {}
  ): Promise<RenewFileResult> {
    if (!Number.isSafeInteger(additionalMinutes) || additionalMinutes < 1) {
      throw new RangeError('additionalMinutes must be a positive safe integer.')
    }
    const targets = this.#resolveTargets(options.hostedBy)

    // Single-host: pass the server's error through unchanged for legacy callers.
    if (targets.length === 1) {
      const data = await this.#renewFileAtHost(targets[0], uhrpUrl, additionalMinutes)
      return {
        status: data.status,
        prevExpiryTime: data.prevExpiryTime,
        newExpiryTime: data.newExpiryTime,
        amount: data.amount
      }
    }

    const perHost: Array<{ result: RenewPerHostResult; raw?: Error }> = await Promise.all(
      targets.map(async host => {
        try {
          const data = await this.#renewFileAtHost(host, uhrpUrl, additionalMinutes)
          return {
            result: {
              host,
              status: 'success' as const,
              prevExpiryTime: data.prevExpiryTime,
              newExpiryTime: data.newExpiryTime,
              amount: data.amount
            }
          }
        } catch (e) {
          const err = e as Error
          return {
            result: { host, status: 'error' as const, error: err.message },
            raw: err
          }
        }
      })
    )

    const outcomes = perHost.map(p => p.result)
    const successes = outcomes.filter(o => o.status === 'success')

    // Clamp to targets.length so an explicit `hostedBy` smaller than the
    // configured resilience level doesn't trigger an impossible threshold.
    const requiredSuccesses = Math.min(targets.length, this.resilienceLevel)
    if (successes.length < requiredSuccesses) {
      const detail = outcomes
        .map(o => `${o.host}: ${o.status === 'success' ? 'renewed' : (o.error ?? 'unknown')}`)
        .join('; ')
      throw new RenewResiliencyError(
        `renewFile: only ${successes.length} of ${requiredSuccesses} required hosts renewed — ${detail}`,
        outcomes,
        requiredSuccesses,
        successes.length
      )
    }

    successes.sort((a, b) => (b.newExpiryTime ?? 0) - (a.newExpiryTime ?? 0))
    const primary = successes[0]
    const totalAmount = successes.reduce((sum, s) => sum + (s.amount ?? 0), 0)

    return {
      status: 'success',
      prevExpiryTime: primary.prevExpiryTime,
      newExpiryTime: primary.newExpiryTime,
      amount: totalAmount,
      results: outcomes
    }
  }
}
