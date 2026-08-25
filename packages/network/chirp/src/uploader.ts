import { AuthFetch, type WalletInterface } from '@bsv/sdk'
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
  fetch?: (input: string, init?: CHIRPFetchInit) => Promise<Response>
  allowInsecureHTTP?: boolean
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

export class CHIRPUploader {
  private readonly hosts: string[]
  private readonly resilienceLevel: number
  private readonly authFetch: AuthFetch
  private readonly fetcher: (input: string, init?: CHIRPFetchInit) => Promise<Response>
  private readonly requestTimeoutMs: number
  private readonly retriesPerRequest: number
  private readonly allowInsecureHTTP: boolean

  constructor(config: CHIRPUploaderConfig) {
    const hosts = config.storageURLs ?? (config.storageURL == null ? [] : [config.storageURL])
    if (hosts.length === 0) {
      throw new CHIRPError('ERR_CHIRP_HOSTS', 'CHIRPUploader requires at least one storage host.')
    }
    this.allowInsecureHTTP = config.allowInsecureHTTP ?? false
    this.hosts = [...new Set(hosts.map(host => normalizeHost(host, this.allowInsecureHTTP)))]
    this.resilienceLevel =
      config.storageURL != null && config.storageURLs == null
        ? 1
        : positiveInteger(config.resilienceLevel ?? 1, 'resilienceLevel')
    if (this.resilienceLevel > this.hosts.length) {
      throw new CHIRPError('ERR_CHIRP_RESILIENCE', 'resilienceLevel exceeds configured hosts.')
    }
    this.authFetch = new AuthFetch(config.wallet)
    this.fetcher =
      config.fetch ??
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
      config.requestTimeoutMs ?? 60_000,
      1,
      10 * 60_000,
      'requestTimeoutMs'
    )
    this.retriesPerRequest = integer(config.retriesPerRequest ?? 2, 0, 8, 'retriesPerRequest')
  }

  async publish(options: CHIRPPublishOptions): Promise<CHIRPPublishResult> {
    const retentionSeconds = decimalUint64(options.retentionSeconds, false)
    const logicalLength =
      options.logicalLength == null ? null : decimalUint64(options.logicalLength, true)
    let sessions =
      options.resume == null
        ? await this.createSessions(retentionSeconds, logicalLength, options.signal)
        : this.restoreSessions(options.resume, retentionSeconds, logicalLength)
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
    await options.onCheckpoint?.(checkpoint())

    const sink: CHIRPObjectSink = {
      putObject: async (objectIdentifier, bytes) => {
        throwIfAborted(options.signal)
        const outcomes = await Promise.all(
          sessions.map(async session => {
            if (session.failed != null) return false
            try {
              await this.putObject(session, objectIdentifier, bytes, options.signal)
              return true
            } catch (error) {
              throwIfAborted(options.signal)
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
        await options.onCheckpoint?.(checkpoint())
      }
    }

    const build = await new CHIRPBuilder().build(options.source, {
      mediaType: options.mediaType,
      sink
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
          return await this.commit(session, build.rootIdentifier, options.signal)
        } catch {
          throwIfAborted(options.signal)
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
          if (response.status !== 201) return null
          const data = (await response.json()) as {
            uploadId?: unknown
            stagingExpiresAt?: unknown
          }
          if (typeof data.uploadId !== 'string' || typeof data.stagingExpiresAt !== 'string') {
            return null
          }
          const stagingExpiresAt = decimalUint64(data.stagingExpiresAt, false)
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
      checkpoint.logicalLength !== logicalLength
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
        typeof session.uploadId !== 'string' ||
        session.uploadId === '' ||
        typeof session.stagingExpiresAt !== 'string' ||
        !/^[1-9]\d*$/.test(session.stagingExpiresAt) ||
        BigInt(session.stagingExpiresAt) <= BigInt(now)
      ) {
        continue
      }
      let host: string
      try {
        host = normalizeHost(session.host, this.allowInsecureHTTP)
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
    if (existing.status === 200 || existing.status === 204) return
    if (existing.status !== 404) {
      throw new CHIRPError(
        'ERR_CHIRP_UPLOAD_HEAD',
        `CHIRP host returned HTTP ${existing.status} to HEAD.`
      )
    }
    const response = await this.request(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'identity',
        'Content-Length': String(bytes.byteLength)
      },
      body: bytes as BodyInit,
      signal
    })
    if (response.status !== 201 && response.status !== 204) {
      throw new CHIRPError(
        'ERR_CHIRP_UPLOAD_OBJECT',
        `CHIRP object upload returned HTTP ${response.status}.`
      )
    }
  }

  private async commit(
    session: ActiveSession,
    rootIdentifier: string,
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
      throw new CHIRPError('ERR_CHIRP_COMMIT', `CHIRP commit returned HTTP ${response.status}.`)
    }
    const data = (await response.json()) as Omit<CHIRPCommitResult, 'host'>
    if (
      typeof data.chirpURL !== 'string' ||
      typeof data.uhrpURL !== 'string' ||
      typeof data.hostedFileLocation !== 'string' ||
      !Number.isSafeInteger(data.expiryTime)
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
    } catch (cause) {
      throw new CHIRPError('ERR_CHIRP_COMMIT', 'CHIRP commit returned invalid root locations.', {
        cause: cause instanceof Error ? cause : undefined
      })
    }
    if (returnedRoot !== rootIdentifier || data.uhrpURL !== `uhrp://${rootIdentifier}`) {
      throw new CHIRPError('ERR_CHIRP_COMMIT', 'CHIRP commit returned mismatched root locations.')
    }
    return { host: session.host, ...data }
  }

  private async request(input: string, init: CHIRPFetchInit): Promise<Response> {
    let lastError: unknown
    for (let attempt = 0; attempt <= this.retriesPerRequest; attempt += 1) {
      throwIfAborted(init.signal)
      const timed = timedSignal(init.signal, this.requestTimeoutMs)
      try {
        const response = await this.fetcher(input, { ...init, signal: timed.signal })
        if (response.status < 500 || attempt === this.retriesPerRequest) return response
        await response.body?.cancel().catch(() => {})
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

function normalizeHost(value: string, allowInsecureHTTP: boolean): string {
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
  return parsed.toString().replace(/\/$/, '')
}

function decimalUint64(value: bigint | number | string, allowZero: boolean): string {
  let parsed: bigint
  try {
    parsed = typeof value === 'bigint' ? value : BigInt(value)
  } catch {
    throw new CHIRPError('ERR_CHIRP_INTEGER', 'Expected an unsigned decimal integer.')
  }
  if (
    parsed < (allowZero ? 0n : 1n) ||
    parsed > 0xffffffffffffffffn ||
    (typeof value === 'string' && !/^(0|[1-9]\d*)$/.test(value))
  ) {
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
