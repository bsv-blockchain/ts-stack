/**
 * Consumes the go-chaintracks (Arcade) reorg SSE stream (`GET /v2/reorg/stream`)
 * and normalizes each `ReorgEvent` into the overlay engine's `handleReorg` input.
 *
 * The stream emits `data: <JSON>\n\n` frames (no `event:`/`id:` lines) with
 * `: keepalive` comment frames in between. Because there are no event ids, a
 * reconnect cannot replay events missed while disconnected — so every (re)connect
 * triggers an `onConnect` catch-up (the engine's revalidation sweep).
 */

/** Input shape accepted by `Engine.handleReorg`. */
export interface ReorgHandlerInput {
  orphanedBlockHashes: string[]
  rebuildFromHeight: number
  newTipHeight: number
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
export function parseReorgEvent (frame: string): ReorgHandlerInput | null {
  let event: any
  try {
    event = JSON.parse(frame)
  } catch {
    return null
  }

  const newTipHeight = event?.newTip?.height
  if (typeof newTipHeight !== 'number') {
    return null
  }

  const orphanedBlockHashes: string[] = Array.isArray(event.orphanedHashes)
    ? event.orphanedHashes
      .filter((hash: unknown): hash is string => typeof hash === 'string')
      .map((hash: string) => hash.toLowerCase())
    : []

  const ancestorHeight: unknown = event?.commonAncestor?.height
  const depth: unknown = event?.depth
  let rebuildFromHeight: number
  if (typeof ancestorHeight === 'number') {
    rebuildFromHeight = ancestorHeight + 1
  } else if (typeof depth === 'number') {
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
export function extractSseFrames (buffer: string): { events: string[], rest: string } {
  const events: string[] = []
  let working = buffer
  let boundary = working.indexOf('\n\n')
  while (boundary !== -1) {
    const block = working.slice(0, boundary)
    working = working.slice(boundary + 2)
    const dataLines: string[] = []
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) {
        continue
      }
      if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).replace(/^ /, ''))
      }
    }
    if (dataLines.length > 0) {
      events.push(dataLines.join(''))
    }
    boundary = working.indexOf('\n\n')
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
  private controller?: AbortController
  private stopped = false

  constructor (options: ReorgSseAdapterOptions) {
    this.url = options.url
    this.onReorg = options.onReorg
    this.onConnect = options.onConnect
    this.logger = options.logger ?? console
    this.reconnectDelayMs = options.reconnectDelayMs ?? 5000
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** Begins consuming the stream in the background. */
  start (): void {
    if (this.stopped) {
      return
    }
    void this.runLoop()
  }

  /** Stops consuming and aborts any in-flight connection. */
  stop (): void {
    this.stopped = true
    this.controller?.abort()
  }

  private async runLoop (): Promise<void> {
    while (!this.stopped) {
      try {
        await this.connectOnce()
      } catch (error) {
        if (!this.stopped) {
          this.logger.warn(`[BASM] reorg stream error: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (this.stopped) {
        break
      }
      await this.delay(this.reconnectDelayMs)
    }
  }

  private async connectOnce (): Promise<void> {
    this.controller = new AbortController()
    const response = await this.fetchImpl(this.url, {
      headers: { Accept: 'text/event-stream' },
      signal: this.controller.signal
    })
    if (!response.ok || response.body == null) {
      throw new Error(`reorg stream responded ${response.status}`)
    }

    // No event-id replay on this stream: catch up on (re)connect.
    if (this.onConnect !== undefined) {
      try {
        await this.onConnect()
      } catch (error) {
        this.logger.warn(`[BASM] reorg catch-up failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (!this.stopped) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const { events, rest } = extractSseFrames(buffer)
      buffer = rest
      for (const frame of events) {
        const input = parseReorgEvent(frame)
        if (input === null) {
          this.logger.warn('[BASM] skipping malformed reorg frame')
          continue
        }
        try {
          await this.onReorg(input)
        } catch (error) {
          this.logger.error(`[BASM] handleReorg failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
  }

  private async delay (ms: number): Promise<void> {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  }
}
