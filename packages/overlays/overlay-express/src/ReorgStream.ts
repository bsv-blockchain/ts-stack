/**
 * Consumes the go-chaintracks (Arcade) reorg SSE stream (`GET /v2/reorg/stream`)
 * and normalizes each `ReorgEvent` into the overlay engine's `handleReorg` input.
 *
 * The stream emits `data: <JSON>\n\n` frames (no `event:`/`id:` lines) with
 * `: keepalive` comment frames in between. Because there are no event ids, a
 * reconnect cannot replay events missed while disconnected — so every (re)connect
 * triggers an `onConnect` catch-up (the engine's revalidation sweep).
 */
import {
  fetchWithDeadline,
  hasControlCharacters,
  secureServiceFetch,
  snapshotOwnDataRecord
} from './OutboundSecurity.js'

const MAX_REORG_ORPHAN_HASHES = 10_000
const MAX_SSE_FRAME_BYTES = 1024 * 1024
const MAX_SSE_CHUNK_BYTES = 4 * 1024 * 1024
const MAX_SSE_EVENTS_PER_READ = 1000
const MAX_LOG_ERROR_BYTES = 1024

function safeErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  const singleLine = Array.from(text, character =>
    hasControlCharacters(character) ? ' ' : character
  ).join('')
  return new TextDecoder().decode(
    new TextEncoder().encode(singleLine).subarray(0, MAX_LOG_ERROR_BYTES)
  )
}

/** Input shape accepted by `Engine.handleReorg`. */
export interface ReorgHandlerInput {
  orphanedBlockHashes: string[]
  rebuildFromHeight: number
  newTipHeight: number
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}

/**
 * Parses a single SSE data frame (a go-chaintracks `ReorgEvent` JSON document)
 * into `handleReorg` input. Returns `null` for malformed frames.
 *
 * `ReorgEvent` = { orphanedHashes: string[], commonAncestor: BlockHeader|null,
 * newTip: BlockHeader, depth: number }. Block hashes are go-sdk `chainhash.Hash`
 * values marshaled as reversed (display) hex; they are lower-cased here to match
 * the overlay's stored block hashes.
 */
export function parseReorgEvent(frame: string): ReorgHandlerInput | null {
  let event: any
  try {
    event = JSON.parse(frame)
  } catch {
    return null
  }

  const newTipHeight = event?.newTip?.height
  if (!isNonNegativeSafeInteger(newTipHeight)) {
    return null
  }

  if (
    !Array.isArray(event.orphanedHashes) ||
    event.orphanedHashes.length > MAX_REORG_ORPHAN_HASHES
  ) {
    return null
  }
  const orphanedBlockHashes: string[] = []
  const seenHashes = new Set<string>()
  for (const hash of event.orphanedHashes) {
    if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) return null
    const canonical = hash.toLowerCase()
    if (seenHashes.has(canonical)) return null
    seenHashes.add(canonical)
    orphanedBlockHashes.push(canonical)
  }

  // Reaching this point proves `event` is object-like: it exposed a valid
  // `newTip.height`, so only the nullable common ancestor needs optional access.
  const ancestorHeight: unknown = event.commonAncestor?.height
  const depth: unknown = event.depth
  let rebuildFromHeight: number
  if (isNonNegativeSafeInteger(ancestorHeight)) {
    if (ancestorHeight > newTipHeight) {
      return null
    }
    rebuildFromHeight = ancestorHeight + 1
  } else if (isNonNegativeSafeInteger(depth)) {
    // No common ancestor (e.g. reorg deeper than retained history): fall back to
    // the reported depth from the new tip.
    rebuildFromHeight = Math.max(0, newTipHeight - depth + 1)
  } else {
    return null
  }

  return { orphanedBlockHashes, rebuildFromHeight, newTipHeight }
}

/**
 * Splits an SSE byte buffer into complete event payloads. Frames are delimited by
 * a blank line (`\n\n`); within a frame, `data:` lines are concatenated and
 * comment lines (starting with `:`) are ignored. Any trailing partial frame is
 * returned in `rest` for the next read.
 */
export function extractSseFrames(buffer: string): { events: string[]; rest: string } {
  const events: string[] = []
  let working = buffer
  let boundary = /\r?\n\r?\n/.exec(working)
  while (boundary !== null) {
    const block = working.slice(0, boundary.index)
    if (new TextEncoder().encode(block).byteLength > MAX_SSE_FRAME_BYTES) {
      throw new RangeError('Reorg SSE frame exceeds the configured limit')
    }
    working = working.slice(boundary.index + boundary[0].length)
    const dataLines: string[] = []
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith(':')) {
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join('\n'))
      if (events.length > MAX_SSE_EVENTS_PER_READ) {
        throw new RangeError('Reorg SSE read contains too many events')
      }
    }
    boundary = /\r?\n\r?\n/.exec(working)
  }
  if (new TextEncoder().encode(working).byteLength > MAX_SSE_FRAME_BYTES) {
    throw new RangeError('Reorg SSE partial frame exceeds the configured limit')
  }
  return { events, rest: working }
}

export interface ReorgSseAdapterOptions {
  /** Reorg SSE URL, e.g. `https://arcade.example/v2/reorg/stream`. */
  url: string
  /** Invoked for each parsed reorg event. */
  onReorg: (input: ReorgHandlerInput) => Promise<void>
  /** Invoked on every (re)connect for catch-up, since the stream has no replay. */
  onConnect?: () => Promise<void>
  logger?: Pick<typeof console, 'log' | 'warn' | 'error'>
  /** Delay before reconnecting after the stream ends or errors. */
  reconnectDelayMs?: number
  /** Injectable fetch (defaults to global fetch); aids testing. */
  fetchImpl?: typeof fetch
  /** Permit HTTP/private endpoints only for isolated local development. */
  allowPrivateHosts?: boolean
  /** Deadline for establishing each SSE response. */
  connectTimeoutMs?: number
  /** Maximum interval between SSE bytes before reconnecting. */
  idleTimeoutMs?: number
}

/**
 * Long-lived SSE client that keeps the overlay's BASM anchors reconciled with
 * chain reorgs. Auto-reconnects with a fixed delay and runs a catch-up on connect.
 */
export class ReorgSseAdapter {
  private readonly url: string
  private readonly onReorg: (input: ReorgHandlerInput) => Promise<void>
  private readonly onConnect?: () => Promise<void>
  private readonly logger: Pick<typeof console, 'log' | 'warn' | 'error'>
  private readonly reconnectDelayMs: number
  private readonly fetchImpl: typeof fetch
  private readonly connectTimeoutMs: number
  private readonly idleTimeoutMs: number
  private controller?: AbortController
  private reader?: ReadableStreamDefaultReader<Uint8Array>
  private stopped = false
  private running = false
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectResolve?: () => void

  constructor(options: ReorgSseAdapterOptions) {
    const owned = snapshotOwnDataRecord(options, 'Reorg stream options')
    if (typeof owned.onReorg !== 'function') {
      throw new TypeError('Reorg stream onReorg must be a function')
    }
    if (owned.onConnect !== undefined && typeof owned.onConnect !== 'function') {
      throw new TypeError('Reorg stream onConnect must be a function')
    }
    if (owned.fetchImpl !== undefined && typeof owned.fetchImpl !== 'function') {
      throw new TypeError('Reorg stream fetchImpl must be a function')
    }
    if (owned.allowPrivateHosts !== undefined && typeof owned.allowPrivateHosts !== 'boolean') {
      throw new TypeError('Reorg stream allowPrivateHosts must be a boolean')
    }
    if (
      owned.logger !== undefined &&
      (typeof owned.logger.log !== 'function' ||
        typeof owned.logger.warn !== 'function' ||
        typeof owned.logger.error !== 'function')
    ) {
      throw new TypeError('Reorg stream logger must implement log, warn, and error')
    }
    const transport = secureServiceFetch(owned.url, owned.fetchImpl, owned.allowPrivateHosts)
    this.url = transport.baseUrl
    this.onReorg = owned.onReorg
    this.onConnect = owned.onConnect
    this.logger = owned.logger ?? console
    this.reconnectDelayMs = owned.reconnectDelayMs ?? 5000
    this.fetchImpl = transport.fetchImpl
    this.connectTimeoutMs = owned.connectTimeoutMs ?? 30_000
    this.idleTimeoutMs = owned.idleTimeoutMs ?? 90_000
    if (
      !Number.isSafeInteger(this.reconnectDelayMs) ||
      this.reconnectDelayMs < 0 ||
      this.reconnectDelayMs > 3_600_000
    ) {
      throw new TypeError('reconnectDelayMs must be an integer between 0 and 3600000')
    }
    if (
      !Number.isSafeInteger(this.connectTimeoutMs) ||
      this.connectTimeoutMs < 1 ||
      this.connectTimeoutMs > 300_000
    ) {
      throw new TypeError('connectTimeoutMs must be an integer between 1 and 300000')
    }
    if (
      !Number.isSafeInteger(this.idleTimeoutMs) ||
      this.idleTimeoutMs < 1 ||
      this.idleTimeoutMs > 3_600_000
    ) {
      throw new TypeError('idleTimeoutMs must be an integer between 1 and 3600000')
    }
  }

  /** Begins consuming the stream in the background. */
  start(): void {
    if (this.stopped || this.running) {
      return
    }
    this.running = true
    void this.runLoop()
  }

  /** Stops consuming and aborts any in-flight connection. */
  stop(): void {
    this.stopped = true
    this.controller?.abort()
    void this.reader?.cancel().catch(() => {})
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectResolve?.()
  }

  private async runLoop(): Promise<void> {
    try {
      while (!this.stopped) {
        try {
          await this.connectOnce()
        } catch (error) {
          if (!this.stopped) {
            this.logger.warn(
              `[BASM] reorg stream error: ${JSON.stringify(safeErrorMessage(error))}`
            )
          }
        }
        if (this.stopped) {
          break
        }
        await this.delay(this.reconnectDelayMs)
      }
    } finally {
      this.running = false
    }
  }

  private async connectOnce(): Promise<void> {
    const controller = new AbortController()
    this.controller = controller
    try {
      const response = await fetchWithDeadline(
        this.fetchImpl,
        this.url,
        {
          headers: { Accept: 'text/event-stream' },
          signal: controller.signal
        },
        this.connectTimeoutMs
      )
      if (!response.ok || response.body == null) {
        await response.body?.cancel()
        throw new Error(`reorg stream responded ${response.status}`)
      }
      const contentType = response.headers.get('content-type')
      if (contentType !== null && !/^text\/event-stream(?:\s*;|$)/i.test(contentType)) {
        await response.body.cancel()
        throw new TypeError('reorg stream response is not text/event-stream')
      }

      // No event-id replay on this stream: catch up on (re)connect.
      await this.runCatchUp()
      await this.pumpEvents(response.body.getReader())
    } finally {
      controller.abort()
      if (this.controller === controller) this.controller = undefined
    }
  }

  private async runCatchUp(): Promise<void> {
    if (this.onConnect === undefined) {
      return
    }
    await this.onConnect()
  }

  private async pumpEvents(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    this.reader = reader
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      while (!this.stopped) {
        const { value, done } = await this.readWithIdleDeadline(reader)
        if (done) {
          break
        }
        if (value.byteLength > MAX_SSE_CHUNK_BYTES) {
          throw new RangeError('Reorg SSE chunk exceeds the configured limit')
        }
        buffer += decoder.decode(value, { stream: true })
        const { events, rest } = extractSseFrames(buffer)
        buffer = rest
        for (const frame of events) {
          await this.processReorgFrame(frame)
        }
      }
    } finally {
      if (this.reader === reader) this.reader = undefined
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  private async readWithIdleDeadline(
    reader: ReadableStreamDefaultReader<Uint8Array>
  ): Promise<ReadableStreamReadResult<Uint8Array>> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            void reader.cancel().catch(() => {})
            reject(new Error(`reorg stream idle timeout after ${this.idleTimeoutMs}ms`))
          }, this.idleTimeoutMs)
          timer.unref?.()
        })
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async processReorgFrame(frame: string): Promise<void> {
    const input = parseReorgEvent(frame)
    if (input === null) {
      throw new TypeError('received a malformed reorg frame')
    }
    await this.onReorg(input)
  }

  private async delay(ms: number): Promise<void> {
    await new Promise<void>(resolve => {
      const done = (): void => {
        this.reconnectResolve = undefined
        this.reconnectTimer = undefined
        resolve()
      }
      this.reconnectResolve = done
      this.reconnectTimer = setTimeout(done, ms)
      this.reconnectTimer.unref?.()
    })
  }
}
