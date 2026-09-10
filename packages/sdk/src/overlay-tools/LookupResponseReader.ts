import { LookupResourceLimitError } from './LookupResources.js'

/** Options controlling a bounded lookup response read. */
export interface LookupResponseReaderOptions {
  /** Cancels a pending stream read when the lookup request is aborted. */
  signal?: AbortSignal
  /** Maximum number of response bytes to retain. */
  maxResponseBytes: number
  /** Charges accepted bytes to the caller's aggregate response budget. */
  consumeBytes?: (bytes: number) => void
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

function assertValidMaximum(maxResponseBytes: number): void {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0) {
    throw new RangeError('maxResponseBytes must be a non-negative safe integer')
  }
}

function assertDeclaredLengthIsWithinLimit(response: Response, maxResponseBytes: number): void {
  const contentLength = response.headers.get('content-length')
  if (contentLength === null) return

  const normalized = contentLength.trim()
  // Content-Length is decimal bytes. Treat malformed fields as unknown rather
  // than accidentally accepting a notation such as "1e6".
  if (!/^\d+$/.test(normalized)) return

  const declaredLength = Number(normalized)
  if (!Number.isSafeInteger(declaredLength) || declaredLength > maxResponseBytes) {
    throw new LookupResourceLimitError('maxResponseBytes')
  }
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal === undefined) return await reader.read()
  if (signal.aborted) throw abortReason(signal)

  return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      callback()
    }
    const onAbort = (): void => finish(() => reject(abortReason(signal)))

    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(() => reader.read())
      .then(
        result => finish(() => resolve(result)),
        error => finish(() => reject(error))
      )

    // Do not miss an abort that happened while registering the listener.
    if (signal.aborted) onAbort()
  })
}

function cleanUpFailedRead(reader: ReadableStreamDefaultReader<Uint8Array>, reason: unknown): void {
  Promise.resolve()
    .then(() => reader.cancel(reason))
    .catch(() => undefined)

  try {
    reader.releaseLock()
  } catch {
    // The lock may already have been released by a nonstandard stream.
  }
}

function expandedBuffer(
  buffer: Uint8Array<ArrayBufferLike>,
  requiredLength: number,
  maxResponseBytes: number
): Uint8Array<ArrayBufferLike> {
  if (requiredLength <= buffer.byteLength) return buffer

  const initialCapacity = Math.min(maxResponseBytes, 1024)
  const doubledCapacity = Math.min(maxResponseBytes, buffer.byteLength * 2)
  const capacity = Math.max(
    requiredLength,
    buffer.byteLength === 0 ? initialCapacity : doubledCapacity
  )
  const expanded = new Uint8Array(capacity)
  expanded.set(buffer)
  return expanded
}

function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

async function yieldAfterReadIfNeeded(
  readOperations: number,
  signal: AbortSignal | undefined
): Promise<void> {
  if (readOperations % 64 !== 0) return
  await yieldToEventLoop()
  if (signal?.aborted) throw abortReason(signal)
}

async function accumulateLookupResponseChunk(
  bytes: Uint8Array<ArrayBufferLike>,
  totalLength: number,
  value: Uint8Array,
  readOperations: number,
  options: LookupResponseReaderOptions
): Promise<{ bytes: Uint8Array<ArrayBufferLike>, totalLength: number }> {
  const { signal, maxResponseBytes, consumeBytes } = options
  if (value.byteLength === 0) {
    // An eagerly fulfilled read() still schedules only microtasks. Yielding
    // periodically lets timers deliver cancellation for endless empty input.
    await yieldAfterReadIfNeeded(readOperations, signal)
    return { bytes, totalLength }
  }

  if (value.byteLength > maxResponseBytes - totalLength) {
    throw new LookupResourceLimitError('maxResponseBytes')
  }

  consumeBytes?.(value.byteLength)
  const nextLength = totalLength + value.byteLength
  const expanded = expandedBuffer(bytes, nextLength, maxResponseBytes)
  // Streams are allowed to reuse a producer-owned Uint8Array. Copy each
  // accepted chunk now instead of retaining a mutable producer reference.
  expanded.set(value, totalLength)
  // Copy before yielding: a producer may reuse or mutate its buffer while
  // the task queue runs.
  await yieldAfterReadIfNeeded(readOperations, signal)
  return { bytes: expanded, totalLength: nextLength }
}

function releaseLookupResponseReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    reader.releaseLock()
  } catch {
    // A nonstandard stream may have released its lock itself.
  }
}

async function readLookupResponseStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  response: Response,
  options: LookupResponseReaderOptions
): Promise<Uint8Array> {
  const { signal } = options
  let succeeded = false
  let failure: unknown
  try {
    assertDeclaredLengthIsWithinLimit(response, options.maxResponseBytes)
    if (signal?.aborted === true) throw abortReason(signal)

    let bytes: Uint8Array<ArrayBufferLike> = new Uint8Array(0)
    let totalLength = 0
    let readOperations = 0
    while (true) {
      const { done, value } = await readWithAbort(reader, signal)
      readOperations++
      if (done) break
      const next = await accumulateLookupResponseChunk(
        bytes,
        totalLength,
        value ?? new Uint8Array(0),
        readOperations,
        options
      )
      bytes = next.bytes
      totalLength = next.totalLength
    }

    succeeded = true
    return bytes.subarray(0, totalLength)
  } catch (error) {
    failure = error
    throw error
  } finally {
    if (succeeded) releaseLookupResponseReader(reader)
    else cleanUpFailedRead(reader, failure)
  }
}

/**
 * Reads a lookup response incrementally while enforcing a per-response bound.
 *
 * This deliberately does not use Response.text(), json(), or arrayBuffer(),
 * because those APIs buffer the complete body before a limit can be enforced.
 */
export async function readLookupResponseBytes(
  response: Response,
  options: LookupResponseReaderOptions
): Promise<Uint8Array> {
  const { signal, maxResponseBytes } = options
  assertValidMaximum(maxResponseBytes)

  const body = response.body
  if (body === null) {
    assertDeclaredLengthIsWithinLimit(response, maxResponseBytes)
    if (signal?.aborted === true) throw abortReason(signal)
    return new Uint8Array(0)
  }

  return await readLookupResponseStream(body.getReader(), response, options)
}
