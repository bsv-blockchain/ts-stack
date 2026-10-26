import { AuthFetch } from '@bsv/sdk/auth/clients/AuthFetch'
import { createPublicNetworkFetch, isPublicNetworkAddress } from '@bsv/sdk/storage/PublicHTTPSFetch'
import type { WalletInterface } from '@bsv/sdk/wallet/Wallet.interfaces'
import { CHIRPBuilder } from './builder.js'
import { CHIRPError, CHIRPResilienceError } from './errors.js'
import { deriveCHIRPObjectURL, parseCHIRPURL } from './uri.js'
import type { CHIRPBuildResult, CHIRPByteSource, CHIRPObjectSink } from './types.js'

interface CHIRPFetchInit {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit | null
  signal?: AbortSignal
}

export interface CHIRPUploaderConfig {
  wallet: WalletInterface
  storageURL?: string
  storageURLs?: string[]
  resilienceLevel?: number
  /**
   * Complete request override for tests or custom authenticated clients. This
   * callback replaces AuthFetch; use fetchClient to customize its transport.
   */
  fetch?: (input: string, init?: CHIRPFetchInit) => Promise<Response>
  /** Network transport used beneath AuthFetch, preserving mutual auth/payment handling. */
  fetchClient?: typeof fetch
  allowInsecureHTTP?: boolean
  /** Explicit local/development opt-in for private storage hosts. */
  allowPrivateHosts?: boolean
  requestTimeoutMs?: number
  retriesPerRequest?: number
}

export interface CHIRPUploadSessionState {
  host: string
  uploadId: string
  stagingExpiresAt: string
}

export interface CHIRPUploadCheckpoint {
  version: 1
  retentionSeconds: string
  logicalLength: string | null
  sessions: CHIRPUploadSessionState[]
}

export interface CHIRPPublishOptions {
  source: CHIRPByteSource
  retentionSeconds: bigint | number | string
  logicalLength?: bigint | number | string | null
  mediaType?: string
  resume?: CHIRPUploadCheckpoint
  signal?: AbortSignal
  onCheckpoint?: (checkpoint: CHIRPUploadCheckpoint) => void | Promise<void>
}

export interface CHIRPCommitResult {
  host: string
  chirpURL: string
  uhrpURL: string
  hostedFileLocation: string
  expiryTime: number
}

export interface CHIRPPublishResult extends CHIRPBuildResult {
  hostedBy: string[]
  commits: CHIRPCommitResult[]
  checkpoint: CHIRPUploadCheckpoint
}

interface ActiveSession extends CHIRPUploadSessionState {
  failed?: Error
}

const MAX_CONTROL_RESPONSE_BYTES = 256 * 1024
const MAX_UPLOAD_ID_BYTES = 512
const MAX_STORAGE_HOSTS = 64
const strictUTF8 = new TextDecoder('utf-8', { fatal: true })

function snapshotPublishOptions(options: CHIRPPublishOptions): CHIRPPublishOptions {
  const values = ownDataValues(
    options,
    new Set([
      'source',
      'retentionSeconds',
      'logicalLength',
      'mediaType',
      'resume',
      'signal',
      'onCheckpoint'
    ]),
    'CHIRP publish options'
  )
  if (!Object.hasOwn(values, 'source') || !Object.hasOwn(values, 'retentionSeconds')) {
    throw new TypeError('CHIRP publish options require source and retentionSeconds.')
  }
  let source = values.source as CHIRPByteSource
  if (source instanceof Uint8Array) source = source.slice()
  else if (Array.isArray(source)) {
    const copy: number[] = []
    for (let index = 0; index < source.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(source, String(index))
      if (descriptor === undefined || !('value' in descriptor)) {
        throw new CHIRPError('ERR_CHIRP_SOURCE', 'CHIRP number arrays must contain own data bytes.')
      }
      copy.push(descriptor.value as number)
    }
    source = copy
  }
  if (values.mediaType !== undefined && typeof values.mediaType !== 'string') {
    throw new TypeError('mediaType must be a string.')
  }
  if (values.onCheckpoint !== undefined && typeof values.onCheckpoint !== 'function') {
    throw new TypeError('onCheckpoint must be a function.')
  }
  if (values.signal !== undefined && !isAbortSignal(values.signal)) {
    throw new TypeError('signal must be an AbortSignal.')
  }
  return {
    source,
    retentionSeconds: values.retentionSeconds as bigint | number | string,
    logicalLength: values.logicalLength as bigint | number | string | null | undefined,
    mediaType: values.mediaType as string | undefined,
    resume:
      values.resume === undefined
        ? undefined
        : snapshotCheckpoint(values.resume as CHIRPUploadCheckpoint),
    signal: values.signal as AbortSignal | undefined,
    onCheckpoint: values.onCheckpoint as CHIRPPublishOptions['onCheckpoint']
  }
}

function snapshotCheckpoint(value: CHIRPUploadCheckpoint): CHIRPUploadCheckpoint {
  const values = ownDataValues(
    value,
    new Set(['version', 'retentionSeconds', 'logicalLength', 'sessions']),
    'CHIRP checkpoint'
  )
  if (!Array.isArray(values.sessions) || values.sessions.length > MAX_STORAGE_HOSTS) {
    throw new CHIRPError('ERR_CHIRP_RESUME', 'CHIRP checkpoint contains invalid sessions.')
  }
  const sessions: CHIRPUploadSessionState[] = []
  for (let index = 0; index < values.sessions.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(values.sessions, String(index))
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new CHIRPError('ERR_CHIRP_RESUME', 'CHIRP checkpoint sessions must be dense data.')
    }
    const session = ownDataValues(
      descriptor.value,
      new Set(['host', 'uploadId', 'stagingExpiresAt']),
      'CHIRP checkpoint session'
    )
    sessions.push({
      host: session.host as string,
      uploadId: session.uploadId as string,
      stagingExpiresAt: session.stagingExpiresAt as string
    })
  }
  return {
    version: values.version as 1,
    retentionSeconds: values.retentionSeconds as string,
    logicalLength: values.logicalLength as string | null,
    sessions
  }
}

function ownDataValues(
  value: unknown,
  allowed: ReadonlySet<string>,
  label: string
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError(`${label} must be a plain object.`)
  }
  const values = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      throw new TypeError(`${label} contains an unsupported property.`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!
    if (!('value' in descriptor)) throw new TypeError(`${label} cannot use accessors.`)
    values[key] = descriptor.value
  }
  return values
}

function snapshotStringArray(value: unknown, label: string, maximum: number): string[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be a bounded string array.`)
  }
  const result: string[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    ) {
      throw new TypeError(`${label} must contain own string data properties.`)
    }
    result.push(descriptor.value)
  }
  return result
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  )
}

function isValidUploadId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_UPLOAD_ID_BYTES &&
    ![...value].some(character => {
      const codePoint = character.codePointAt(0) ?? 0
      return codePoint <= 0x1f || codePoint === 0x7f
    })
  )
}

export class CHIRPUploader {
  private readonly hosts: string[]
  private readonly resilienceLevel: number
  private readonly authFetch: AuthFetch
  private readonly fetcher: (input: string, init?: CHIRPFetchInit) => Promise<Response>
  private readonly requestTimeoutMs: number
  private readonly retriesPerRequest: number
  private readonly allowInsecureHTTP: boolean
  private readonly allowPrivateHosts: boolean

  constructor(config: CHIRPUploaderConfig) {
    const values = ownDataValues(
      config,
      new Set([
        'wallet',
        'storageURL',
        'storageURLs',
        'resilienceLevel',
        'fetch',
        'fetchClient',
        'allowInsecureHTTP',
        'allowPrivateHosts',
        'requestTimeoutMs',
        'retriesPerRequest'
      ]),
      'CHIRP uploader config'
    )
    if (values.wallet === null || typeof values.wallet !== 'object') {
      throw new TypeError('wallet must implement WalletInterface.')
    }
    if (values.storageURL !== undefined && typeof values.storageURL !== 'string') {
      throw new TypeError('storageURL must be a string.')
    }
    const configuredHosts =
      values.storageURLs === undefined
        ? values.storageURL === undefined
          ? []
          : [values.storageURL]
        : snapshotStringArray(values.storageURLs, 'storageURLs', MAX_STORAGE_HOSTS)
    if (configuredHosts.length === 0 || configuredHosts.length > MAX_STORAGE_HOSTS) {
      throw new CHIRPError('ERR_CHIRP_HOSTS', 'CHIRPUploader requires at least one storage host.')
    }
    for (const option of ['allowInsecureHTTP', 'allowPrivateHosts'] as const) {
      if (values[option] !== undefined && typeof values[option] !== 'boolean') {
        throw new TypeError(`${option} must be a boolean.`)
      }
    }
    this.allowInsecureHTTP = values.allowInsecureHTTP === true
    this.allowPrivateHosts = values.allowPrivateHosts === true
    this.hosts = [
      ...new Set(
        configuredHosts.map(host =>
          normalizeHost(host, this.allowInsecureHTTP, this.allowPrivateHosts)
        )
      )
    ]
    this.resilienceLevel =
      values.storageURL !== undefined && values.storageURLs === undefined
        ? 1
        : positiveInteger((values.resilienceLevel ?? 1) as number, 'resilienceLevel')
    if (this.resilienceLevel > this.hosts.length) {
      throw new CHIRPError('ERR_CHIRP_RESILIENCE', 'resilienceLevel exceeds configured hosts.')
    }
    if (values.fetch !== undefined && typeof values.fetch !== 'function') {
      throw new TypeError('fetch must be a function.')
    }
    if (values.fetchClient !== undefined && typeof values.fetchClient !== 'function') {
      throw new TypeError('fetchClient must be a function.')
    }
    if (values.fetch !== undefined && values.fetchClient !== undefined) {
      throw new CHIRPError(
        'ERR_CHIRP_CONFIG',
        'fetch and fetchClient cannot be configured together.'
      )
    }
    const configuredFetch = values.fetch as CHIRPUploaderConfig['fetch']
    const callConfiguredFetch =
      configuredFetch === undefined
        ? undefined
        : async (input: string, init?: CHIRPFetchInit): Promise<Response> =>
            await Reflect.apply(configuredFetch, undefined, [input, init])
    const configuredFetchClient = values.fetchClient as typeof fetch | undefined
    const callFetchClient =
      configuredFetchClient === undefined
        ? undefined
        : async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
            await Reflect.apply(configuredFetchClient, undefined, [input, init])
    const networkFetch =
      callFetchClient ??
      (this.allowPrivateHosts
        ? fetch
        : createPublicNetworkFetch({ allowHTTP: this.allowInsecureHTTP }))
    this.authFetch = new AuthFetch(
      values.wallet as WalletInterface,
      undefined,
      undefined,
      undefined,
      {},
      networkFetch
    )
    this.fetcher =
      callConfiguredFetch ??
      (async (input, init) => {
        throwIfAborted(init?.signal)
        return await raceWithSignal(
          this.authFetch.fetch(input, {
            method: init?.method,
            headers: init?.headers,
            body: init?.body
          }),
          init?.signal
        )
      })
    this.requestTimeoutMs = integer(
      (values.requestTimeoutMs ?? 60_000) as number,
      1,
      10 * 60_000,
      'requestTimeoutMs'
    )
    this.retriesPerRequest = integer(
      (values.retriesPerRequest ?? 2) as number,
      0,
      8,
      'retriesPerRequest'
    )
  }

  async publish(options: CHIRPPublishOptions): Promise<CHIRPPublishResult> {
    const snapshot = snapshotPublishOptions(options)
    const { source, mediaType, resume, signal, onCheckpoint } = snapshot
    const retentionSeconds = decimalUint64(snapshot.retentionSeconds, false)
    const logicalLength =
      snapshot.logicalLength == null ? null : decimalUint64(snapshot.logicalLength, true)
    let sessions =
      resume == null
        ? await this.createSessions(retentionSeconds, logicalLength, signal)
        : this.restoreSessions(resume, retentionSeconds, logicalLength)
    if (sessions.length < this.resilienceLevel) {
      throw new CHIRPResilienceError(this.resilienceLevel, sessions.length)
    }

    const checkpoint = (): CHIRPUploadCheckpoint => ({
      version: 1,
      retentionSeconds,
      logicalLength,
      sessions: sessions
        .filter(session => session.failed == null)
        .map(({ host, uploadId, stagingExpiresAt }) => ({ host, uploadId, stagingExpiresAt }))
    })
    await onCheckpoint?.(checkpoint())

    const sink: CHIRPObjectSink = {
      putObject: async (objectIdentifier, bytes) => {
        throwIfAborted(signal)
        const outcomes = await Promise.all(
          sessions.map(async session => {
            if (session.failed != null) return false
            try {
              await this.putObject(session, objectIdentifier, bytes.slice(), signal)
              return true
            } catch (error) {
              throwIfAborted(signal)
              session.failed = asError(error)
              return false
            }
          })
        )
        const successful = outcomes.filter(Boolean).length
        if (successful < this.resilienceLevel) {
          throw new CHIRPResilienceError(this.resilienceLevel, successful)
        }
        sessions = sessions.filter(session => session.failed == null)
        await onCheckpoint?.(checkpoint())
      }
    }

    const build = await new CHIRPBuilder().build(source, {
      mediaType,
      sink,
      signal
    })
    if (logicalLength != null && build.logicalLength.toString() !== logicalLength) {
      throw new CHIRPError(
        'ERR_CHIRP_LENGTH',
        'Built CHIRP content does not match the declared logical length.'
      )
    }
    const commits = await Promise.all(
      sessions.map(async session => {
        try {
          return await this.commit(session, build.rootIdentifier, retentionSeconds, signal)
        } catch {
          throwIfAborted(signal)
          return null
        }
      })
    )
    const successfulCommits = commits.filter(
      (commit): commit is CHIRPCommitResult => commit != null
    )
    if (successfulCommits.length < this.resilienceLevel) {
      throw new CHIRPResilienceError(this.resilienceLevel, successfulCommits.length)
    }
    const committedHosts = new Set(successfulCommits.map(commit => commit.host))
    sessions = sessions.filter(session => committedHosts.has(session.host))
    return {
      ...build,
      hostedBy: successfulCommits.map(commit => commit.host),
      commits: successfulCommits,
      checkpoint: checkpoint()
    }
  }

  private async createSessions(
    retentionSeconds: string,
    logicalLength: string | null,
    signal?: AbortSignal
  ): Promise<ActiveSession[]> {
    const sessions = await Promise.all(
      this.hosts.map(async host => {
        try {
          const response = await this.request(`${host}/chirp/v1/uploads`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ retentionSeconds, logicalLength }),
            signal
          })
          if (response.status !== 201) {
            await discardResponse(response)
            return null
          }
          const data = await readControlJSON(response, signal, this.requestTimeoutMs)
          if (
            !hasExactKeys(data, ['uploadId', 'stagingExpiresAt']) ||
            !isValidUploadId(data.uploadId) ||
            typeof data.stagingExpiresAt !== 'string'
          ) {
            return null
          }
          const stagingExpiresAt = decimalUint64(data.stagingExpiresAt, false)
          if (BigInt(stagingExpiresAt) <= BigInt(Math.floor(Date.now() / 1000))) return null
          return {
            host,
            uploadId: data.uploadId,
            stagingExpiresAt
          }
        } catch {
          throwIfAborted(signal)
          return null
        }
      })
    )
    return sessions.filter((session): session is ActiveSession => session != null)
  }

  private restoreSessions(
    checkpoint: CHIRPUploadCheckpoint,
    retentionSeconds: string,
    logicalLength: string | null
  ): ActiveSession[] {
    if (
      checkpoint.version !== 1 ||
      checkpoint.retentionSeconds !== retentionSeconds ||
      checkpoint.logicalLength !== logicalLength ||
      !Array.isArray(checkpoint.sessions) ||
      checkpoint.sessions.length > MAX_STORAGE_HOSTS
    ) {
      throw new CHIRPError(
        'ERR_CHIRP_RESUME',
        'CHIRP checkpoint does not match publication options.'
      )
    }
    const configured = new Set(this.hosts)
    const now = Math.floor(Date.now() / 1000)
    const sessions: ActiveSession[] = []
    const seen = new Set<string>()
    for (const session of checkpoint.sessions) {
      if (
        typeof session?.host !== 'string' ||
        !isValidUploadId(session.uploadId) ||
        typeof session.stagingExpiresAt !== 'string' ||
        !/^[1-9]\d{0,19}$/.test(session.stagingExpiresAt) ||
        BigInt(session.stagingExpiresAt) > 0xffffffffffffffffn ||
        BigInt(session.stagingExpiresAt) <= BigInt(now)
      ) {
        continue
      }
      let host: string
      try {
        host = normalizeHost(session.host, this.allowInsecureHTTP, this.allowPrivateHosts)
      } catch {
        continue
      }
      if (!configured.has(host) || seen.has(host)) continue
      seen.add(host)
      sessions.push({
        host,
        uploadId: session.uploadId,
        stagingExpiresAt: session.stagingExpiresAt
      })
    }
    return sessions
  }

  private async putObject(
    session: ActiveSession,
    objectIdentifier: string,
    bytes: Uint8Array,
    signal?: AbortSignal
  ): Promise<void> {
    const url = `${session.host}/chirp/v1/uploads/${encodeURIComponent(session.uploadId)}/objects/${objectIdentifier}`
    const existing = await this.request(url, { method: 'HEAD', signal })
    if (existing.status === 200 || existing.status === 204) {
      await discardResponse(existing)
      return
    }
    if (existing.status !== 404) {
      await discardResponse(existing)
      throw new CHIRPError(
        'ERR_CHIRP_UPLOAD_HEAD',
        `CHIRP host returned HTTP ${existing.status} to HEAD.`
      )
    }
    await discardResponse(existing)
    const response = await this.request(url, {
      method: 'PUT',
      headers: {
        // AuthFetch signs application headers. The HTTP transport derives
        // Content-Length from these owned bytes; absent encoding is identity.
        'Content-Type': 'application/octet-stream'
      },
      body: bytes as BodyInit,
      signal
    })
    if (response.status !== 201 && response.status !== 204) {
      await discardResponse(response)
      throw new CHIRPError(
        'ERR_CHIRP_UPLOAD_OBJECT',
        `CHIRP object upload returned HTTP ${response.status}.`
      )
    }
    await discardResponse(response)
  }

  private async commit(
    session: ActiveSession,
    rootIdentifier: string,
    retentionSeconds: string,
    signal?: AbortSignal
  ): Promise<CHIRPCommitResult> {
    const response = await this.request(
      `${session.host}/chirp/v1/uploads/${encodeURIComponent(session.uploadId)}/commit`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootIdentifier }),
        signal
      }
    )
    if (response.status !== 201) {
      await discardResponse(response)
      throw new CHIRPError('ERR_CHIRP_COMMIT', `CHIRP commit returned HTTP ${response.status}.`)
    }
    const data = await readControlJSON(response, signal, this.requestTimeoutMs)
    if (
      !hasExactKeys(data, ['chirpURL', 'uhrpURL', 'hostedFileLocation', 'expiryTime']) ||
      typeof data.chirpURL !== 'string' ||
      typeof data.uhrpURL !== 'string' ||
      typeof data.hostedFileLocation !== 'string' ||
      typeof data.expiryTime !== 'number' ||
      !Number.isSafeInteger(data.expiryTime) ||
      data.expiryTime <= Math.floor(Date.now() / 1000) ||
      BigInt(data.expiryTime) + 5n <
        BigInt(Math.floor(Date.now() / 1000)) + BigInt(retentionSeconds)
    ) {
      throw new CHIRPError('ERR_CHIRP_COMMIT', 'CHIRP commit returned an invalid response.')
    }
    let returnedRoot: string
    try {
      returnedRoot = parseCHIRPURL(data.chirpURL).rootIdentifier
      deriveCHIRPObjectURL(
        data.hostedFileLocation,
        rootIdentifier,
        rootIdentifier,
        session.host.startsWith('http:')
      )
      const expectedLocation = `${session.host}/chirp/v1/${rootIdentifier}/objects/${rootIdentifier}`
      if (new URL(data.hostedFileLocation).toString() !== new URL(expectedLocation).toString()) {
        throw new Error('CHIRP commit location escaped its authenticated host.')
      }
    } catch (cause) {
      throw new CHIRPError('ERR_CHIRP_COMMIT', 'CHIRP commit returned invalid root locations.', {
        cause: cause instanceof Error ? cause : undefined
      })
    }
    if (returnedRoot !== rootIdentifier || data.uhrpURL !== `uhrp://${rootIdentifier}`) {
      throw new CHIRPError('ERR_CHIRP_COMMIT', 'CHIRP commit returned mismatched root locations.')
    }
    return {
      host: session.host,
      chirpURL: data.chirpURL,
      uhrpURL: data.uhrpURL,
      hostedFileLocation: data.hostedFileLocation,
      expiryTime: data.expiryTime
    }
  }

  private async request(input: string, init: CHIRPFetchInit): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retriesPerRequest; attempt += 1) {
      throwIfAborted(init.signal)
      const timed = timedSignal(init.signal, this.requestTimeoutMs)
      try {
        const responsePromise = Promise.resolve(
          this.fetcher(input, {
            ...init,
            headers: init.headers == null ? undefined : { ...init.headers },
            signal: timed.signal
          })
        )
        void responsePromise.then(
          response => {
            if (timed.signal.aborted) cancelResponseBody(response, timed.signal.reason)
          },
          () => {}
        )
        const response = await raceWithSignal(responsePromise, timed.signal)
        if (response.status < 500 || attempt === this.retriesPerRequest) return response
        cancelResponseBody(response)
        lastError = new CHIRPError('ERR_CHIRP_HTTP', `CHIRP host returned HTTP ${response.status}.`)
      } catch (error) {
        lastError = error
        throwIfAborted(init.signal)
        if (attempt === this.retriesPerRequest) throw error
      } finally {
        timed.dispose()
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new CHIRPError('ERR_CHIRP_HTTP', 'CHIRP request failed.')
  }
}

async function readControlJSON(
  response: Response,
  parentSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<Record<string, unknown>> {
  const declared = response.headers.get('content-length')
  let declaredBytes: number | undefined
  if (declared != null) {
    if (!/^(0|[1-9]\d*)$/.test(declared)) {
      cancelResponseBody(response)
      throw new CHIRPError('ERR_CHIRP_HTTP', 'CHIRP host returned an invalid Content-Length.')
    }
    declaredBytes = Number(declared)
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_CONTROL_RESPONSE_BYTES) {
      cancelResponseBody(response)
      throw new CHIRPError('ERR_CHIRP_HTTP', 'CHIRP host control response is too large.')
    }
  }
  if (response.body == null) {
    throw new CHIRPError('ERR_CHIRP_HTTP', 'CHIRP host returned an empty control response.')
  }

  const timed = timedSignal(parentSignal, timeoutMs)
  const reader = response.body.getReader()
  const abort = (): void => {
    void reader.cancel(timed.signal.reason).catch(() => {})
  }
  timed.signal.addEventListener('abort', abort, { once: true })
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await raceWithSignal(reader.read(), timed.signal)
      throwIfAborted(timed.signal)
      if (done) break
      if (!(value instanceof Uint8Array)) {
        cancelReader(reader, new TypeError('CHIRP control response yielded non-byte data.'))
        throw new CHIRPError('ERR_CHIRP_HTTP', 'CHIRP host returned non-byte response data.')
      }
      length += value.byteLength
      if (
        !Number.isSafeInteger(length) ||
        length > MAX_CONTROL_RESPONSE_BYTES ||
        (declaredBytes !== undefined && length > declaredBytes)
      ) {
        cancelReader(reader, new RangeError('CHIRP host control response is too large.'))
        throw new CHIRPError('ERR_CHIRP_HTTP', 'CHIRP host control response is too large.')
      }
      chunks.push(value.slice())
    }
  } finally {
    timed.signal.removeEventListener('abort', abort)
    timed.dispose()
    if (timed.signal.aborted) cancelReader(reader, timed.signal.reason)
    try {
      reader.releaseLock()
    } catch {
      // A custom non-cooperative stream may retain a pending read. The timeout
      // race and cancellation promise are both contained.
    }
  }
  if (declaredBytes !== undefined && declaredBytes !== length) {
    throw new CHIRPError(
      'ERR_CHIRP_HTTP',
      'CHIRP host control response differs from Content-Length.'
    )
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(strictUTF8.decode(bytes))
  } catch (cause) {
    throw new CHIRPError('ERR_CHIRP_HTTP', 'CHIRP host returned malformed JSON.', {
      cause: cause instanceof Error ? cause : undefined
    })
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CHIRPError('ERR_CHIRP_HTTP', 'CHIRP host returned a malformed JSON object.')
  }
  return parsed as Record<string, unknown>
}

function discardResponse(response: Response): void {
  cancelResponseBody(response)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key))
}

function cancelResponseBody(response: Response, reason?: unknown): void {
  void response.body?.cancel(reason).catch(() => {})
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  void reader.cancel(reason).catch(() => {})
}

function normalizeHost(
  value: string,
  allowInsecureHTTP: boolean,
  allowPrivateHosts: boolean
): string {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new CHIRPError('ERR_CHIRP_HOSTS', 'Invalid CHIRP storage host URL.')
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch (cause) {
    throw new CHIRPError('ERR_CHIRP_HOSTS', 'Invalid CHIRP storage host URL.', {
      cause: cause instanceof Error ? cause : undefined
    })
  }
  if (parsed.protocol !== 'https:' && !(allowInsecureHTTP && parsed.protocol === 'http:')) {
    throw new CHIRPError('ERR_CHIRP_HOSTS', 'CHIRP storage hosts must use HTTPS.')
  }
  if (
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new CHIRPError('ERR_CHIRP_HOSTS', 'CHIRP storage host contains forbidden URL components.')
  }
  const literal = /^[\d.]+$/.test(parsed.hostname) || parsed.hostname.includes(':')
  if (!allowPrivateHosts && literal && !isPublicNetworkAddress(parsed.hostname)) {
    throw new CHIRPError('ERR_CHIRP_HOSTS', 'CHIRP storage host is not a public address.')
  }
  return parsed.toString().replace(/\/$/, '')
}

function decimalUint64(value: bigint | number | string, allowZero: boolean): string {
  if (
    (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') ||
    (typeof value === 'number' && !Number.isSafeInteger(value)) ||
    (typeof value === 'string' && !/^(0|[1-9]\d{0,19})$/.test(value))
  ) {
    throw new CHIRPError('ERR_CHIRP_INTEGER', 'Expected an unsigned decimal integer.')
  }
  let parsed: bigint
  try {
    parsed = typeof value === 'bigint' ? value : BigInt(value)
  } catch {
    throw new CHIRPError('ERR_CHIRP_INTEGER', 'Expected an unsigned decimal integer.')
  }
  if (parsed < (allowZero ? 0n : 1n) || parsed > 0xffffffffffffffffn) {
    throw new CHIRPError('ERR_CHIRP_INTEGER', 'Value is outside canonical uint64 decimal form.')
  }
  return parsed.toString()
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new CHIRPError('ERR_CHIRP_INTEGER', `${name} must be a positive integer.`)
  }
  return value
}

function integer(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CHIRPError('ERR_CHIRP_INTEGER', `${name} must be from ${minimum} through ${maximum}.`)
  }
  return value
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The CHIRP operation was aborted.', 'AbortError')
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function timedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number
): {
  signal: AbortSignal
  dispose(): void
} {
  const controller = new AbortController()
  const abort = (): void => controller.abort(parent?.reason)
  if (parent?.aborted === true) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () =>
      controller.abort(
        new CHIRPError('ERR_CHIRP_TIMEOUT', `CHIRP upload request exceeded ${timeoutMs}ms.`)
      ),
    timeoutMs
  )
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent?.removeEventListener('abort', abort)
    }
  }
}

async function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal)
  if (signal == null) return await promise
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The CHIRP request was aborted.', 'AbortError')
      )
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      value => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
