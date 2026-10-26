import { createPublicNetworkFetch } from '@bsv/sdk'

export const OUTBOUND_REQUEST_TIMEOUT_MS = 30_000
export const MAX_PROVIDER_JSON_BYTES = 32 * 1024 * 1024
export const MAX_PROVIDER_ERROR_BYTES = 1024

const HASH_HEX = /^[0-9a-fA-F]{64}$/
const EVEN_HEX = /^(?:[0-9a-fA-F]{2})+$/

export type JsonRecord = Record<string, unknown>

export function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(character => {
    const codePoint = character.codePointAt(0) ?? 0
    return codePoint <= 0x1f || codePoint === 0x7f
  })
}

export function snapshotOwnDataRecord<T extends object>(
  value: T,
  label: string,
  maxProperties = 64
): Readonly<T> {
  if (
    value === null ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`)
  }
  const keys = Reflect.ownKeys(value)
  if (keys.length > maxProperties || keys.some(key => typeof key !== 'string')) {
    throw new TypeError(`${label} contains invalid or excessive properties`)
  }
  const snapshot = Object.create(null) as Record<string, unknown>
  for (const key of keys as string[]) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !('value' in descriptor)) {
      throw new TypeError(`${label}.${key} must be an own data property`)
    }
    snapshot[key] = descriptor.value
  }
  return Object.freeze(snapshot) as Readonly<T>
}

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !HASH_HEX.test(value)) {
    throw new TypeError(`${label} must be 32 bytes of hexadecimal data`)
  }
}

export function assertNonnegativeSafeInteger(
  value: unknown,
  label: string
): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`)
  }
}

export function assertBoundedString(
  value: unknown,
  label: string,
  maxBytes: number,
  allowEmpty = true
): asserts value is string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    new TextEncoder().encode(value).byteLength > maxBytes
  ) {
    throw new TypeError(`${label} must be a bounded string`)
  }
}

export function assertBoundedHex(
  value: unknown,
  label: string,
  maxBytes: number
): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxBytes * 2 ||
    !EVEN_HEX.test(value)
  ) {
    throw new TypeError(`${label} must be bounded, even-length hexadecimal data`)
  }
}

export function secureServiceFetch(
  endpoint: string,
  suppliedFetch?: typeof fetch,
  allowPrivateHosts = false
): { baseUrl: string; fetchImpl: typeof fetch } {
  if (
    typeof endpoint !== 'string' ||
    endpoint.length === 0 ||
    endpoint.length > 2048 ||
    hasControlCharacters(endpoint)
  ) {
    throw new TypeError('Provider endpoint must be a bounded URL string')
  }
  if (suppliedFetch !== undefined && typeof suppliedFetch !== 'function') {
    throw new TypeError('Provider fetch override must be a function')
  }
  if (typeof allowPrivateHosts !== 'boolean') {
    throw new TypeError('Provider allowPrivateHosts must be a boolean')
  }
  const parsed = new URL(endpoint)
  if (
    (parsed.protocol !== 'https:' && !(allowPrivateHosts && parsed.protocol === 'http:')) ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    throw new TypeError(
      'Provider endpoints must be credential-free HTTPS URLs without query or fragment data'
    )
  }
  const baseUrl = parsed.toString().replace(/\/$/, '')
  return {
    baseUrl,
    fetchImpl:
      suppliedFetch ??
      (allowPrivateHosts ? fetch : createPublicNetworkFetch({ expectedOrigin: parsed.origin }))
  }
}

export async function fetchWithDeadline(
  fetchImpl: typeof fetch,
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = OUTBOUND_REQUEST_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const suppliedSignal = init.signal
  const abort = (): void => controller.abort()
  if (suppliedSignal?.aborted === true) controller.abort()
  else suppliedSignal?.addEventListener('abort', abort, { once: true })
  try {
    try {
      return await fetchImpl(input, { ...init, signal: controller.signal, redirect: 'error' })
    } catch (error) {
      if (controller.signal.aborted && suppliedSignal?.aborted !== true) {
        throw new Error(`Outbound request timed out after ${timeoutMs}ms`)
      }
      throw error
    }
  } finally {
    clearTimeout(timeout)
    suppliedSignal?.removeEventListener('abort', abort)
  }
}

export async function readBoundedText(
  response: Response,
  maxBytes: number,
  label: string,
  timeoutMs = OUTBOUND_REQUEST_TIMEOUT_MS
): Promise<string> {
  const declared = response.headers?.get?.('content-length')
  if (
    declared !== null &&
    declared !== undefined &&
    (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > maxBytes)
  ) {
    await response.body?.cancel()
    throw new RangeError(`${label} exceeds ${maxBytes} bytes`)
  }

  if (response.body == null) {
    const text = await response.text()
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new RangeError(`${label} exceeds ${maxBytes} bytes`)
    }
    return text
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const bytes = await Promise.race([
      (async (): Promise<Uint8Array> => {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) throw new RangeError(`${label} exceeds ${maxBytes} bytes`)
          chunks.push(value)
        }
        const combined = new Uint8Array(total)
        let offset = 0
        for (const chunk of chunks) {
          combined.set(chunk, offset)
          offset += chunk.byteLength
        }
        return combined
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs)
      })
    ])
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export async function readBoundedJson(
  response: Response,
  maxBytes: number,
  label: string,
  timeoutMs = OUTBOUND_REQUEST_TIMEOUT_MS
): Promise<unknown> {
  const contentType = response.headers?.get?.('content-type')
  if (
    contentType !== null &&
    contentType !== undefined &&
    !/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(contentType)
  ) {
    await response.body?.cancel()
    throw new TypeError(`${label} is not JSON`)
  }
  const text = await readBoundedText(response, maxBytes, label, timeoutMs)
  if (text.length === 0) throw new TypeError(`${label} is empty`)
  try {
    return JSON.parse(text)
  } catch {
    throw new TypeError(`${label} is malformed JSON`)
  }
}
