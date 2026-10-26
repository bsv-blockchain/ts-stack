import { utf8ByteLength } from '../../primitives/UTF8.js'

export const DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const DEFAULT_HTTP_CLIENT_TIMEOUT_MS = 30_000

export interface HttpClientLimits {
  maxResponseBytes?: number
  timeoutMs?: number
}

export function normalizeHttpClientLimits(
  limits: HttpClientLimits = {}
): Required<HttpClientLimits> {
  const maxResponseBytes = limits.maxResponseBytes ?? DEFAULT_HTTP_CLIENT_MAX_RESPONSE_BYTES
  const timeoutMs = limits.timeoutMs ?? DEFAULT_HTTP_CLIENT_TIMEOUT_MS
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new RangeError('maxResponseBytes must be a positive safe integer')
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10 * 60_000) {
    throw new RangeError('timeoutMs must be an integer from 1 through 600000')
  }
  return { maxResponseBytes, timeoutMs }
}

export function timedRequestSignal(
  parent: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = (): void => controller.abort(parent?.reason)
  if (parent?.aborted === true) abort()
  else parent?.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () => controller.abort(new DOMException('HTTP request timed out', 'TimeoutError')),
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

export async function readFetchResponseText(
  response: Response,
  maximumBytes: number
): Promise<string> {
  const responseLike = response as unknown as {
    body?: ReadableStream<Uint8Array> | null
    text?: () => Promise<string>
  }
  const declared = response.headers?.get?.('content-length') ?? null
  if (declared !== null) {
    if (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > maximumBytes) {
      await response.body?.cancel().catch(() => {})
      throw new Error('HTTP response exceeds the configured size limit')
    }
  }
  if (!('body' in responseLike)) {
    const text = (await responseLike.text?.()) ?? ''
    if (utf8ByteLength(text) > maximumBytes) {
      throw new Error('HTTP response exceeds the configured size limit')
    }
    return text
  }
  if (response.body == null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (!Number.isSafeInteger(length) || length > maximumBytes) {
        await reader.cancel()
        throw new Error('HTTP response exceeds the configured size limit')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (cause) {
    throw new Error('HTTP response is not valid UTF-8', { cause })
  }
}
