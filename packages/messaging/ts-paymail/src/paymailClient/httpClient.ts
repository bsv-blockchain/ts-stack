import { PaymailServerResponseError } from '../errors/index.js'
import fetch from 'cross-fetch'

type FetchOptions = RequestInit & { timeout?: number }
export type RequestOptions = Omit<FetchOptions, 'body' | 'method'> & {
  method?: 'GET' | 'POST'
  body?: unknown
}

export interface ResolvedAddress {
  address: string
  family: number
}

export interface HttpClientOptions {
  /** Maximum response bytes materialized by one request. Defaults to 1 MiB. */
  maxResponseBytes?: number
  /** Explicit opt-in for private-network HTTP services. Defaults to false. */
  allowPrivateNetwork?: boolean
  /** Injectable DNS resolver used for deterministic testing and custom runtimes. */
  addressResolver?: (hostname: string) => Promise<ResolvedAddress[]>
}

const defaultRequestOptions: RequestOptions = { method: 'GET' }
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024

function positiveSafeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer`)
  }
  return value
}

function ipv4Parts(address: string): number[] | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const parsed = parts.map(part => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  return parsed.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parsed
    : undefined
}

function ipv6Parts(address: string): number[] | undefined {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized.includes('%') || normalized.split('::').length > 2) return undefined
  const [head = '', tail = ''] = normalized.split('::')
  const parseSection = (section: string): number[] | undefined => {
    if (section === '') return []
    const pieces = section.split(':')
    const values: number[] = []
    for (const [index, piece] of pieces.entries()) {
      const embeddedV4 = ipv4Parts(piece)
      if (embeddedV4 != null) {
        if (index !== pieces.length - 1) return undefined
        values.push(embeddedV4[0] * 0x100 + embeddedV4[1])
        values.push(embeddedV4[2] * 0x100 + embeddedV4[3])
      } else {
        if (!/^[0-9a-f]{1,4}$/.test(piece)) return undefined
        values.push(Number.parseInt(piece, 16))
      }
    }
    return values
  }
  const headParts = parseSection(head)
  const tailParts = parseSection(tail)
  if (headParts == null || tailParts == null) return undefined
  const explicit = headParts.length + tailParts.length
  if (normalized.includes('::')) {
    if (explicit >= 8) return undefined
    return [...headParts, ...Array.from({ length: 8 - explicit }, () => 0), ...tailParts]
  }
  return explicit === 8 ? headParts : undefined
}

function ipv4FromIpv6(parts: number[]): number[] | undefined {
  const firstFiveZero = parts.slice(0, 5).every(part => part === 0)
  const compatibleOrMapped = firstFiveZero && (parts[5] === 0 || parts[5] === 0xffff)
  const nat64 =
    parts[0] === 0x0064 && parts[1] === 0xff9b && parts.slice(2, 6).every(part => part === 0)
  const sixToFour = parts[0] === 0x2002
  if (!compatibleOrMapped && !nat64 && !sixToFour) return undefined
  const start = sixToFour ? 1 : 6
  return [parts[start] >> 8, parts[start] & 0xff, parts[start + 1] >> 8, parts[start + 1] & 0xff]
}

function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1]
  const v4 = ipv4Parts(mappedV4 ?? normalized)
  if (v4 != null) {
    const [a, b, c, d] = v4
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    )
  }

  const v6 = ipv6Parts(normalized)
  if (v6 == null) return false
  const embeddedV4 = ipv4FromIpv6(v6)
  if (embeddedV4 != null) return isPublicAddress(embeddedV4.join('.'))
  const allZero = v6.every(part => part === 0)
  const loopback = v6.slice(0, 7).every(part => part === 0) && v6[7] === 1
  const globalUnicast = (v6[0] & 0xe000) === 0x2000
  const teredo = v6[0] === 0x2001 && v6[1] === 0
  const benchmark = v6[0] === 0x2001 && v6[1] === 2 && v6[2] === 0
  const orchid =
    v6[0] === 0x2001 &&
    ((v6[1] >= 0x0010 && v6[1] <= 0x001f) || (v6[1] >= 0x0020 && v6[1] <= 0x002f))
  const retiredSixBone = v6[0] === 0x3ffe
  return !(
    allZero ||
    loopback ||
    !globalUnicast ||
    teredo ||
    benchmark ||
    orchid ||
    retiredSixBone ||
    (v6[0] & 0xfe00) === 0xfc00 ||
    (v6[0] & 0xffc0) === 0xfe80 ||
    (v6[0] & 0xffc0) === 0xfec0 ||
    (v6[0] & 0xff00) === 0xff00 ||
    (v6[0] === 0x2001 && v6[1] === 0x0db8)
  )
}

function isNodeRuntime(): boolean {
  return (
    typeof process !== 'undefined' &&
    process.release?.name === 'node' &&
    typeof process.versions?.node === 'string'
  )
}

async function defaultAddressResolver(hostname: string): Promise<ResolvedAddress[]> {
  const dns = process.getBuiltinModule?.('node:dns/promises') as
    | {
        lookup: (
          hostname: string,
          options: { all: true; verbatim: true }
        ) => Promise<ResolvedAddress[]>
      }
    | undefined
  if (dns == null) {
    throw new PaymailServerResponseError('Paymail DNS resolution is unavailable')
  }
  const { lookup } = dns
  const addresses = await lookup(hostname, { all: true, verbatim: true })
  return addresses.map(({ address, family }) => ({ address, family }))
}

async function withAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  return await new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(new DOMException('aborted', 'AbortError'))
    signal.addEventListener('abort', abort, { once: true })
    operation.then(
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

type LookupCallback = (
  error: Error | null,
  address?: string | ResolvedAddress[],
  family?: number
) => void

type LookupFunction = (
  hostname: string,
  options: { family?: number; all?: boolean } | number,
  callback: LookupCallback
) => void

async function nodeAgentFor(
  target: URL,
  addresses: ResolvedAddress[],
  allowPrivateNetwork: boolean
): Promise<unknown> {
  if (!allowPrivateNetwork && target.hostname !== 'localhost') {
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new PaymailServerResponseError('Paymail request resolved to a non-public address')
    }
  }
  if (addresses.length === 0) {
    throw new PaymailServerResponseError('Paymail request hostname did not resolve')
  }

  const lookup = (
    _hostname: string,
    options: { family?: number; all?: boolean } | number,
    callback: LookupCallback
  ): void => {
    const requestedFamily = typeof options === 'number' ? options : options.family
    const candidates = addresses.filter(
      candidate =>
        requestedFamily == null || requestedFamily === 0 || candidate.family === requestedFamily
    )
    const selected = candidates[0]
    if (selected == null) {
      callback(new Error('Paymail request hostname has no address for the requested family'))
      return
    }
    if (typeof options !== 'number' && options.all === true) {
      callback(null, candidates)
      return
    }
    callback(null, selected.address, selected.family)
  }
  const transport = process.getBuiltinModule?.(
    target.protocol === 'https:' ? 'node:https' : 'node:http'
  ) as
    | {
        Agent: new (options: { lookup: LookupFunction }) => unknown
      }
    | undefined
  if (transport == null) {
    throw new PaymailServerResponseError('Paymail HTTP transport is unavailable')
  }
  return new transport.Agent({ lookup })
}

function validateTarget(url: string, allowPrivateNetwork: boolean): URL {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    throw new PaymailServerResponseError('Invalid Paymail request URL')
  }
  if (target.username !== '' || target.password !== '') {
    throw new PaymailServerResponseError('Paymail request URLs must not contain credentials')
  }
  const localDevelopment = target.hostname === 'localhost'
  if (
    target.protocol !== 'https:' &&
    !(target.protocol === 'http:' && (localDevelopment || allowPrivateNetwork))
  ) {
    throw new PaymailServerResponseError('Paymail requests require HTTPS')
  }
  return target
}

function declaredLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length')
  if (raw == null) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new PaymailServerResponseError('Paymail response has an invalid Content-Length')
  }
  const value = Number(raw)
  if (!Number.isSafeInteger(value)) {
    throw new PaymailServerResponseError('Paymail response has an invalid Content-Length')
  }
  return value
}

async function readBoundedBody(response: Response, maximum: number): Promise<Uint8Array> {
  const length = declaredLength(response)
  if (length != null && length > maximum) {
    throw new PaymailServerResponseError(`Paymail response exceeds ${maximum} bytes`)
  }

  const body = response.body as unknown as {
    getReader?: () => {
      read: () => Promise<{ done: boolean; value?: Uint8Array }>
      cancel: () => Promise<void>
    }
    destroy?: () => void
    [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array | Buffer | string>
  } | null
  const chunks: Uint8Array[] = []
  let total = 0
  const append = (value: Uint8Array): void => {
    total += value.byteLength
    if (total > maximum) {
      throw new PaymailServerResponseError(`Paymail response exceeds ${maximum} bytes`)
    }
    chunks.push(value)
  }

  if (body?.getReader != null) {
    const reader = body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value != null) append(value)
      }
    } catch (error) {
      await reader.cancel().catch(() => {})
      throw error
    }
  } else if (body?.[Symbol.asyncIterator] != null) {
    try {
      for await (const chunk of body as AsyncIterable<Uint8Array | Buffer | string>) {
        append(typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk))
      }
    } catch (error) {
      body.destroy?.()
      throw error
    }
  } else {
    append(new Uint8Array(await response.arrayBuffer()))
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export default class HttpClient {
  private readonly defaultTimeout: number
  private readonly maxResponseBytes: number
  private readonly allowPrivateNetwork: boolean
  private readonly addressResolver: (hostname: string) => Promise<ResolvedAddress[]>

  constructor(defaultTimeout = 30000, options: HttpClientOptions = {}) {
    const allowPrivateNetwork = options.allowPrivateNetwork
    const addressResolver = options.addressResolver
    const maxResponseBytes = options.maxResponseBytes
    if (allowPrivateNetwork !== undefined && typeof allowPrivateNetwork !== 'boolean') {
      throw new TypeError('allowPrivateNetwork must be a boolean')
    }
    if (addressResolver !== undefined && typeof addressResolver !== 'function') {
      throw new TypeError('addressResolver must be a function')
    }
    this.defaultTimeout = positiveSafeInteger(defaultTimeout, 'defaultTimeout')
    this.maxResponseBytes = positiveSafeInteger(
      maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes'
    )
    this.allowPrivateNetwork = allowPrivateNetwork ?? false
    this.addressResolver = addressResolver ?? defaultAddressResolver
  }

  async request(url: string, options: RequestOptions = defaultRequestOptions): Promise<Response> {
    const target = validateTarget(url, this.allowPrivateNetwork)
    const controller = new AbortController()
    const { body, timeout: requestedTimeout, ...fetchOptions } = options
    const timeout = positiveSafeInteger(requestedTimeout ?? this.defaultTimeout, 'timeout')
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    const requestOptions: RequestInit & { agent?: unknown } = {
      ...fetchOptions,
      redirect: 'error',
      signal: controller.signal
    }

    try {
      if (isNodeRuntime()) {
        const addresses = await withAbort(this.addressResolver(target.hostname), controller.signal)
        requestOptions.agent = await nodeAgentFor(target, addresses, this.allowPrivateNetwork)
      }

      if (options.method === 'POST' && body !== undefined) {
        requestOptions.body = JSON.stringify(body)
        const headers = new Headers(options.headers)
        if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
        requestOptions.headers = headers
      }

      const response = await fetch(url, requestOptions as RequestInit)
      const bytes = await readBoundedBody(response, this.maxResponseBytes)
      const boundedBody =
        bytes.byteLength === 0
          ? null
          : (bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength
            ) as ArrayBuffer)
      const responseHeaders = new Headers(response.headers)
      responseHeaders.delete('content-encoding')
      responseHeaders.delete('content-length')
      responseHeaders.delete('transfer-encoding')
      const bounded = new Response(boundedBody, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders
      })
      if (!bounded.ok) {
        throw new PaymailServerResponseError(await bounded.text())
      }
      return bounded
    } finally {
      clearTimeout(timeoutId)
    }
  }
}
