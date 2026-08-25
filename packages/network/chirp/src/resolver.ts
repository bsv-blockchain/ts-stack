import { StorageDownloader, type LookupNetworkPreset } from '@bsv/sdk'
import {
  CHIRP_CHUNK_SIZE,
  CHIRP_MAX_DEPTH,
  CHIRP_MAX_NODE_BYTES,
  CHIRP_PROFILE_FIXED_4_MIB
} from './constants.js'
import { decodeCHIRPNode, mediaTypeFromRoot } from './codec.js'
import { CHIRPError } from './errors.js'
import { createSHA256, equalBytes, objectIdentifierForHash, verifyObjectBytes } from './hash.js'
import { MemoryCHIRPCache } from './cache.js'
import { validateProfileOneConstruction } from './validation.js'
import { deriveCHIRPObjectURL, parseCHIRPURL } from './uri.js'
import type {
  CHIRPChildReference,
  CHIRPDownloadResult,
  CHIRPObjectCache,
  CHIRPRange,
  CHIRPRootNode,
  CHIRPVerifiedChunk
} from './types.js'

export interface CHIRPDownloaderConfig {
  networkPreset?: LookupNetworkPreset
  resolve?: (uhrpURL: string) => Promise<string[]>
  fetch?: typeof fetch
  cache?: CHIRPObjectCache
  concurrency?: number
  retriesPerObject?: number
  maxLogicalLength?: bigint
  maxObjects?: number
  maxDownloadBytes?: number
  maxObjectBytes?: number
  allowInsecureHTTP?: boolean
  requestTimeoutMs?: number
  resolutionTimeoutMs?: number
  urlPolicy?: (url: URL) => void | Promise<void>
}

export interface CHIRPDownloadOptions {
  range?: CHIRPRange
  signal?: AbortSignal
  concurrency?: number
}

interface LeafLocation {
  reference: CHIRPChildReference
  offset: bigint
}

interface RootContext {
  root: CHIRPRootNode
  rootIdentifier: string
  advertisedLocations: string[]
  profileCanonical: boolean
}

export class CHIRPDownloader {
  private readonly resolveLocations: (uhrpURL: string) => Promise<string[]>
  private readonly fetcher: typeof fetch
  private readonly cache: CHIRPObjectCache
  private readonly defaultConcurrency: number
  private readonly retriesPerObject: number
  private readonly maxLogicalLength: bigint
  private readonly maxObjects: number
  private readonly maxDownloadBytes: number
  private readonly maxObjectBytes: number
  private readonly allowInsecureHTTP: boolean
  private readonly requestTimeoutMs: number
  private readonly resolutionTimeoutMs: number
  private readonly urlPolicy: (url: URL) => void | Promise<void>
  private nextHost = 0

  constructor(config: CHIRPDownloaderConfig = {}) {
    if (config.resolve != null) {
      this.resolveLocations = config.resolve
    } else {
      const downloader = new StorageDownloader({ networkPreset: config.networkPreset ?? 'mainnet' })
      this.resolveLocations = async uhrpURL => await downloader.resolve(uhrpURL)
    }
    this.fetcher = config.fetch ?? fetch
    this.cache = config.cache ?? new MemoryCHIRPCache()
    this.defaultConcurrency = boundedInteger(config.concurrency ?? 4, 1, 64, 'concurrency')
    this.retriesPerObject = boundedInteger(config.retriesPerObject ?? 3, 1, 16, 'retriesPerObject')
    this.maxLogicalLength = config.maxLogicalLength ?? 64n * 1024n * 1024n * 1024n
    this.maxObjects = boundedInteger(config.maxObjects ?? 100_000, 1, 10_000_000, 'maxObjects')
    this.maxDownloadBytes = boundedInteger(
      config.maxDownloadBytes ?? 512 * 1024 * 1024,
      1,
      Number.MAX_SAFE_INTEGER,
      'maxDownloadBytes'
    )
    this.maxObjectBytes = boundedInteger(
      config.maxObjectBytes ?? 64 * 1024 * 1024,
      1,
      Number.MAX_SAFE_INTEGER,
      'maxObjectBytes'
    )
    this.allowInsecureHTTP = config.allowInsecureHTTP ?? false
    this.requestTimeoutMs = boundedInteger(
      config.requestTimeoutMs ?? 30_000,
      1,
      10 * 60_000,
      'requestTimeoutMs'
    )
    this.resolutionTimeoutMs = boundedInteger(
      config.resolutionTimeoutMs ?? 30_000,
      1,
      10 * 60_000,
      'resolutionTimeoutMs'
    )
    this.urlPolicy = config.urlPolicy ?? defaultURLPolicy
  }

  async inspect(chirpURL: string, signal?: AbortSignal): Promise<RootContext> {
    const parsed = parseCHIRPURL(chirpURL)
    const advertisedLocations = (
      await withTimeout(
        this.resolveLocations(parsed.uhrpURL),
        this.resolutionTimeoutMs,
        'UHRP root resolution timed out.',
        signal
      )
    ).filter(location => {
      try {
        deriveCHIRPObjectURL(
          location,
          parsed.rootIdentifier,
          parsed.rootIdentifier,
          this.allowInsecureHTTP
        )
        return true
      } catch {
        return false
      }
    })
    if (advertisedLocations.length === 0) {
      throw new CHIRPError('ERR_CHIRP_NO_HOSTS', 'No valid complete CHIRP hosts were advertised.')
    }
    const rootBytes = await this.fetchVerifiedObject(
      parsed.rootIdentifier,
      parsed.rootIdentifier,
      advertisedLocations,
      CHIRP_MAX_NODE_BYTES,
      signal
    )
    const node = decodeCHIRPNode(rootBytes)
    if (node.nodeKind !== 0) {
      throw new CHIRPError('ERR_CHIRP_ROOT_KIND', 'CHIRP root resolved to a branch node.')
    }
    if (node.logicalLength > this.maxLogicalLength) {
      throw new CHIRPError(
        'ERR_CHIRP_LOGICAL_LIMIT',
        'CHIRP logical length exceeds the configured limit.'
      )
    }
    return {
      root: node,
      rootIdentifier: parsed.rootIdentifier,
      advertisedLocations,
      profileCanonical: false
    }
  }

  async *stream(
    chirpURL: string,
    options: CHIRPDownloadOptions = {}
  ): AsyncGenerator<CHIRPVerifiedChunk> {
    throwIfAborted(options.signal)
    const context = await this.inspect(chirpURL, options.signal)
    yield* this.streamContext(context, options)
  }

  private async *streamContext(
    context: RootContext,
    options: CHIRPDownloadOptions,
    profileState?: { canonical: boolean }
  ): AsyncGenerator<CHIRPVerifiedChunk> {
    const range = normalizeRange(options.range, context.root.logicalLength)
    const { leaves, leafDepths } = await this.collectLeaves(context, range, options.signal)
    const fullTraversal = range.start === 0n && range.endExclusive === context.root.logicalLength
    if (fullTraversal && context.root.chunkingProfile === CHIRP_PROFILE_FIXED_4_MIB) {
      await validateProfileOneConstruction(
        context.root,
        leaves.map(leaf => leaf.reference),
        leafDepths
      )
      if (profileState != null) profileState.canonical = true
    }

    const concurrency = boundedInteger(
      options.concurrency ?? this.defaultConcurrency,
      1,
      64,
      'concurrency'
    )
    const contentHasher = createSHA256()
    let streamedLength = 0n

    const work = linkedAbortController(options.signal)
    try {
      for await (const loaded of mapConcurrentOrdered(
        leaves,
        concurrency,
        async leaf => await this.loadLeaf(context, leaf, work.controller.signal),
        () =>
          work.controller.abort(new DOMException('CHIRP stream scheduling stopped.', 'AbortError'))
      )) {
        throwIfAborted(options.signal)
        if (fullTraversal) {
          contentHasher.update(loaded.data)
          streamedLength += BigInt(loaded.data.byteLength)
        }
        const start = loaded.leaf.offset < range.start ? range.start - loaded.leaf.offset : 0n
        const absoluteEnd = loaded.leaf.offset + loaded.leaf.reference.logicalLength
        const end =
          absoluteEnd > range.endExclusive
            ? range.endExclusive - loaded.leaf.offset
            : loaded.leaf.reference.logicalLength
        const data = loaded.data.slice(Number(start), Number(end))
        if (data.byteLength > 0) {
          yield {
            data,
            logicalOffset: loaded.leaf.offset + start,
            objectIdentifier: loaded.objectIdentifier
          }
        }
      }

      if (
        fullTraversal &&
        (streamedLength !== context.root.logicalLength ||
          !equalBytes(contentHasher.digest(), context.root.contentHash))
      ) {
        throw new CHIRPError(
          'ERR_CHIRP_CONTENT_HASH',
          'Complete CHIRP stream failed contentHash validation.'
        )
      }
    } finally {
      work.dispose()
    }
  }

  private async collectLeaves(
    context: RootContext,
    range: CHIRPRange,
    signal?: AbortSignal
  ): Promise<{ leaves: LeafLocation[]; leafDepths: Set<number> }> {
    const leaves: LeafLocation[] = []
    const leafDepths = new Set<number>()
    const ancestry = new Set<string>()
    const uniqueObjects = new Set<string>([context.rootIdentifier])
    let referenceCount = 0

    const visit = async (
      reference: CHIRPChildReference,
      offset: bigint,
      depth: number
    ): Promise<void> => {
      if (!overlaps(offset, offset + reference.logicalLength, range)) return
      referenceCount += 1
      if (referenceCount > this.maxObjects) {
        throw new CHIRPError(
          'ERR_CHIRP_REFERENCE_LIMIT',
          'CHIRP traversal exceeds the reference limit.'
        )
      }
      if (depth > CHIRP_MAX_DEPTH) {
        throw new CHIRPError('ERR_CHIRP_DEPTH', 'CHIRP traversal exceeds the v1 depth limit.')
      }
      const objectIdentifier = objectIdentifierForHash(reference.objectHash)
      uniqueObjects.add(objectIdentifier)
      if (uniqueObjects.size > this.maxObjects) {
        throw new CHIRPError('ERR_CHIRP_OBJECT_LIMIT', 'CHIRP traversal exceeds the object limit.')
      }
      if (reference.childKind === 0) {
        leaves.push({ reference, offset })
        leafDepths.add(depth)
        return
      }
      if (ancestry.has(objectIdentifier)) {
        throw new CHIRPError('ERR_CHIRP_CYCLE', 'CHIRP graph contains a cycle.')
      }
      const bytes = await this.fetchVerifiedObject(
        context.rootIdentifier,
        objectIdentifier,
        context.advertisedLocations,
        CHIRP_MAX_NODE_BYTES,
        signal
      )
      const node = decodeCHIRPNode(bytes)
      if (node.nodeKind !== 1 || node.logicalLength !== reference.logicalLength) {
        throw new CHIRPError('ERR_CHIRP_BRANCH', 'CHIRP branch does not match its reference.')
      }
      ancestry.add(objectIdentifier)
      try {
        let childOffset = offset
        for (const child of node.children) {
          await visit(child, childOffset, depth + 1)
          childOffset += child.logicalLength
        }
      } finally {
        ancestry.delete(objectIdentifier)
      }
    }

    let rootOffset = 0n
    for (const child of context.root.children) {
      await visit(child, rootOffset, 1)
      rootOffset += child.logicalLength
    }
    return { leaves, leafDepths }
  }

  private async loadLeaf(
    context: RootContext,
    leaf: LeafLocation,
    signal: AbortSignal
  ): Promise<{ leaf: LeafLocation; data: Uint8Array; objectIdentifier: string }> {
    const objectIdentifier = objectIdentifierForHash(leaf.reference.objectHash)
    const maximumBytes =
      context.root.chunkingProfile === CHIRP_PROFILE_FIXED_4_MIB
        ? CHIRP_CHUNK_SIZE
        : this.maxObjectBytes
    if (leaf.reference.logicalLength > BigInt(maximumBytes)) {
      throw new CHIRPError(
        'ERR_CHIRP_OBJECT_SIZE',
        'CHIRP blob reference exceeds its permitted per-object size.'
      )
    }
    const data = await this.fetchVerifiedObject(
      context.rootIdentifier,
      objectIdentifier,
      context.advertisedLocations,
      maximumBytes,
      signal,
      Number(leaf.reference.logicalLength)
    )
    if (BigInt(data.byteLength) !== leaf.reference.logicalLength) {
      throw new CHIRPError('ERR_CHIRP_LENGTH', 'Blob length does not match its reference.')
    }
    return { leaf, data, objectIdentifier }
  }

  async download(
    chirpURL: string,
    options: CHIRPDownloadOptions = {}
  ): Promise<CHIRPDownloadResult> {
    const context = await this.inspect(chirpURL, options.signal)
    const range = normalizeRange(options.range, context.root.logicalLength)
    const expectedLength = range.endExclusive - range.start
    if (expectedLength > BigInt(this.maxDownloadBytes)) {
      throw new CHIRPError(
        'ERR_CHIRP_DOWNLOAD_LIMIT',
        'Requested CHIRP range exceeds the atomic download limit.'
      )
    }
    const chunks: Uint8Array[] = []
    let length = 0
    const profileState = { canonical: false }
    for await (const chunk of this.streamContext(context, options, profileState)) {
      chunks.push(chunk.data)
      length += chunk.data.byteLength
    }
    const data = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) {
      data.set(chunk, offset)
      offset += chunk.byteLength
    }
    return {
      data,
      mediaType: mediaTypeFromRoot(context.root),
      logicalLength: context.root.logicalLength,
      contentHash: context.root.contentHash,
      rootIdentifier: context.rootIdentifier,
      profileCanonical: profileState.canonical
    }
  }

  private async fetchVerifiedObject(
    rootIdentifier: string,
    objectIdentifier: string,
    locations: string[],
    maximumBytes: number,
    signal?: AbortSignal,
    expectedBytes?: number
  ): Promise<Uint8Array> {
    const cached = await this.cache.get(objectIdentifier)
    if (cached != null) {
      return verifiedCachedObject(objectIdentifier, cached, maximumBytes, expectedBytes)
    }
    const attempts = Math.min(locations.length, this.retriesPerObject)
    const startingHost = this.nextHost++ % locations.length
    let lastError: unknown
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(signal)
      const location = locations[(startingHost + attempt) % locations.length]
      try {
        const url = deriveCHIRPObjectURL(
          location,
          rootIdentifier,
          objectIdentifier,
          this.allowInsecureHTTP
        )
        await this.urlPolicy(new URL(url))
        const timed = timedSignal(signal, this.requestTimeoutMs)
        try {
          const response = await this.fetcher(url, {
            method: 'GET',
            headers: { Accept: 'application/octet-stream, application/vnd.bsv.chirp-node' },
            redirect: 'error',
            signal: timed.signal
          })
          const bytes = await readVerifiedResponse(
            response,
            objectIdentifier,
            maximumBytes,
            expectedBytes
          )
          await this.cache.set(objectIdentifier, bytes)
          return bytes
        } finally {
          timed.dispose()
        }
      } catch (error) {
        lastError = error
      }
    }
    throw new CHIRPError(
      'ERR_CHIRP_FETCH',
      `Unable to retrieve verified object ${objectIdentifier} from any complete host.`,
      { cause: lastError instanceof Error ? lastError : undefined }
    )
  }
}

async function readVerifiedResponse(
  response: Response,
  objectIdentifier: string,
  maximumBytes: number,
  expectedBytes?: number
): Promise<Uint8Array> {
  if (response.status !== 200 || response.body == null) {
    throw new CHIRPError('ERR_CHIRP_HTTP', `CHIRP host returned HTTP ${response.status}.`)
  }
  const encoding = response.headers.get('content-encoding')
  if (encoding != null && encoding.toLowerCase() !== 'identity') {
    throw new CHIRPError('ERR_CHIRP_ENCODING', 'CHIRP objects must not use content encoding.')
  }
  const declaredLength = response.headers.get('content-length')
  if (declaredLength != null && !/^(0|[1-9]\d*)$/.test(declaredLength)) {
    throw new CHIRPError('ERR_CHIRP_LENGTH', 'CHIRP object response has invalid Content-Length.')
  }
  const headerLength = declaredLength == null ? null : Number(declaredLength)
  if (
    headerLength != null &&
    (!Number.isSafeInteger(headerLength) || headerLength > maximumBytes)
  ) {
    throw new CHIRPError(
      'ERR_CHIRP_OBJECT_SIZE',
      'CHIRP object response exceeds its permitted size.'
    )
  }
  if (headerLength != null && expectedBytes != null && headerLength !== expectedBytes) {
    throw new CHIRPError(
      'ERR_CHIRP_LENGTH',
      'CHIRP object Content-Length differs from its verified reference.'
    )
  }
  const bytes = await readBodyBounded(response.body, headerLength, maximumBytes, expectedBytes)
  verifyObjectBytes(objectIdentifier, bytes)
  return bytes
}

function verifiedCachedObject(
  objectIdentifier: string,
  cached: Uint8Array,
  maximumBytes: number,
  expectedBytes?: number
): Uint8Array {
  verifyObjectBytes(objectIdentifier, cached)
  if (cached.byteLength > maximumBytes) {
    throw new CHIRPError('ERR_CHIRP_OBJECT_SIZE', 'Cached CHIRP object exceeds its permitted size.')
  }
  if (expectedBytes != null && cached.byteLength !== expectedBytes) {
    throw new CHIRPError(
      'ERR_CHIRP_LENGTH',
      'Cached CHIRP object differs from its reference length.'
    )
  }
  return cached
}

async function readBodyBounded(
  body: ReadableStream<Uint8Array>,
  declaredLength: number | null,
  maximumBytes: number,
  expectedBytes?: number
): Promise<Uint8Array> {
  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      length += result.value.byteLength
      if (length > maximumBytes || (declaredLength != null && length > declaredLength)) {
        await reader.cancel()
        throw new CHIRPError('ERR_CHIRP_OBJECT_SIZE', 'CHIRP response exceeded its declared bound.')
      }
      chunks.push(result.value)
    }
  } finally {
    reader.releaseLock()
  }
  if (declaredLength != null && length !== declaredLength) {
    throw new CHIRPError('ERR_CHIRP_LENGTH', 'CHIRP response length differs from Content-Length.')
  }
  if (expectedBytes != null && length !== expectedBytes) {
    throw new CHIRPError('ERR_CHIRP_LENGTH', 'CHIRP response length differs from its reference.')
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

async function* mapConcurrentOrdered<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
  onClose: () => void = () => {}
): AsyncGenerator<R> {
  const pending = new Map<number, Promise<R>>()
  let scheduled = 0
  try {
    for (let output = 0; output < values.length; output += 1) {
      while (scheduled < values.length && pending.size < concurrency) {
        const index = scheduled
        pending.set(index, mapper(values[index], index))
        scheduled += 1
      }
      const promise = pending.get(output)
      if (promise == null) throw new Error('CHIRP scheduler invariant failed.')
      const result = await promise
      pending.delete(output)
      yield result
    }
  } finally {
    onClose()
    await Promise.allSettled(pending.values())
  }
}

function normalizeRange(range: CHIRPRange | undefined, logicalLength: bigint): CHIRPRange {
  const normalized = range ?? { start: 0n, endExclusive: logicalLength }
  if (
    normalized.start < 0n ||
    normalized.endExclusive < normalized.start ||
    normalized.endExclusive > logicalLength
  ) {
    throw new CHIRPError('ERR_CHIRP_RANGE', 'Invalid CHIRP logical byte range.')
  }
  return normalized
}

function overlaps(start: bigint, end: bigint, range: CHIRPRange): boolean {
  return start < range.endExclusive && end > range.start
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new DOMException('The CHIRP operation was aborted.', 'AbortError')
  }
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} through ${maximum}.`)
  }
  return value
}

function defaultURLPolicy(url: URL): void {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    isPrivateIPv4(host) ||
    isPrivateIPv6(host)
  ) {
    throw new CHIRPError(
      'ERR_CHIRP_HOST_URL',
      'CHIRP host resolves to a local or private literal address.'
    )
  }
}

function isPrivateIPv4(host: string): boolean {
  const parts = host.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
    return false
  const [a, b] = parts
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  )
}

function isPrivateIPv6(host: string): boolean {
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host)
  if (mapped != null) {
    const high = Number.parseInt(mapped[1], 16)
    const low = Number.parseInt(mapped[2], 16)
    return isPrivateIPv4(`${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`)
  }
  return (
    host === '::' ||
    host === '::1' ||
    host.startsWith('fc') ||
    host.startsWith('fd') ||
    /^fe[89ab]/.test(host)
  )
}

function timedSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number,
  message?: string
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
        new CHIRPError(
          'ERR_CHIRP_TIMEOUT',
          message ?? `CHIRP object request exceeded ${timeoutMs}ms.`
        )
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

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  throwIfAborted(signal)
  const timed = timedSignal(signal, timeoutMs, message)
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timed.signal.addEventListener(
          'abort',
          () =>
            reject(
              timed.signal.reason instanceof Error
                ? timed.signal.reason
                : new CHIRPError('ERR_CHIRP_TIMEOUT', message)
            ),
          { once: true }
        )
      })
    ])
  } finally {
    timed.dispose()
  }
}

function linkedAbortController(parent: AbortSignal | undefined): {
  controller: AbortController
  dispose(): void
} {
  const controller = new AbortController()
  const abort = (): void => controller.abort(parent?.reason)
  if (parent?.aborted === true) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  return {
    controller,
    dispose() {
      parent?.removeEventListener('abort', abort)
      controller.abort(new DOMException('CHIRP stream closed.', 'AbortError'))
    }
  }
}
