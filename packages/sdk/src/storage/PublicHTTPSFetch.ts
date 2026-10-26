import { utf8ByteLength } from '../primitives/UTF8.js'

type ResolvedAddress = { address: string; family: number }
type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>

type LookupCallback = (
  error: Error | null,
  address?: string | ResolvedAddress[],
  family?: number
) => void

type IncomingMessage = NodeJS.ReadableStream & {
  statusCode?: number
  statusMessage?: string
  rawHeaders: string[]
  resume: () => void
}

type ClientRequest = NodeJS.WritableStream & {
  destroy: (error?: Error) => void
  end: (body?: string | Uint8Array) => void
  setTimeout: (milliseconds: number, callback: () => void) => ClientRequest
}

type RequestModule = {
  request: (
    url: URL,
    options: {
      method?: string
      headers?: Record<string, string>
      lookup: (
        hostname: string,
        options: number | { family?: number; all?: boolean },
        callback: LookupCallback
      ) => void
    },
    callback: (response: IncomingMessage) => void
  ) => ClientRequest
}

type StreamModule = {
  Readable: {
    toWeb: (stream: NodeJS.ReadableStream) => ReadableStream<Uint8Array>
  }
}

const REQUEST_TIMEOUT_MS = 30_000
const MAX_DNS_ADDRESSES = 64
const FORBIDDEN_REQUEST_HEADERS = new Set([
  'connection',
  'host',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
])

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

export function isPublicNetworkAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^\[|\]$/g, '')
  const mappedV4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(normalized)?.[1]
  const v4 = ipv4Parts(mappedV4 ?? normalized)
  if (v4 != null) {
    const [a, b] = v4
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0) ||
      a >= 224
    )
  }

  const v6 = ipv6Parts(normalized)
  if (v6 == null) return false
  const embeddedV4 = ipv4FromIpv6(v6)
  if (embeddedV4 != null && !isPublicNetworkAddress(embeddedV4.join('.'))) return false
  const allZero = v6.every(part => part === 0)
  const loopback = v6.slice(0, 7).every(part => part === 0) && v6[7] === 1
  const globalUnicast = (v6[0] & 0xe000) === 0x2000
  const ianaSpecial2001 = v6[0] === 0x2001 && v6[1] < 0x0200
  const documentation = (v6[0] === 0x2001 && v6[1] === 0x0db8) || (v6[0] & 0xfff0) === 0x3ff0
  return !(
    allZero ||
    loopback ||
    !globalUnicast ||
    ianaSpecial2001 ||
    documentation ||
    (v6[0] & 0xfe00) === 0xfc00 ||
    (v6[0] & 0xffc0) === 0xfe80 ||
    (v6[0] & 0xffc0) === 0xfec0 ||
    (v6[0] & 0xff00) === 0xff00
  )
}

async function defaultAddressResolver(hostname: string): Promise<ResolvedAddress[]> {
  const dns = process.getBuiltinModule('node:dns/promises') as {
    lookup: (hostname: string, options: { all: true; verbatim: true }) => Promise<ResolvedAddress[]>
  }
  return await dns.lookup(hostname, { all: true, verbatim: true })
}

async function resolveWithDeadline(
  resolver: AddressResolver,
  hostname: string
): Promise<ResolvedAddress[]> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      resolver(hostname),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Restricted HTTPS DNS resolution timed out')),
          REQUEST_TIMEOUT_MS
        )
      })
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
  }
}

function checkedTarget(
  input: RequestInfo | URL,
  expectedOrigin: string | undefined,
  allowHTTP: boolean
): URL {
  if (typeof input !== 'string' && !(input instanceof URL)) {
    throw new TypeError('Restricted HTTPS fetch does not accept Request objects')
  }
  const target = new URL(input.toString())
  if (expectedOrigin !== undefined && target.origin !== expectedOrigin) {
    throw new Error('Restricted HTTPS request escaped its validated origin')
  }
  if (
    (target.protocol !== 'https:' && !(allowHTTP && target.protocol === 'http:')) ||
    target.username !== '' ||
    target.password !== '' ||
    target.hash !== ''
  ) {
    throw new Error('Restricted requests require a credential-free HTTPS URL')
  }
  const literal = /^[\d.]+$/.test(target.hostname) || target.hostname.includes(':')
  if (literal && !isPublicNetworkAddress(target.hostname)) {
    throw new Error('Restricted HTTPS request targets a non-public address')
  }
  return target
}

function bodyByteLength(body: string | Uint8Array | undefined): number | undefined {
  if (body === undefined) return undefined
  return typeof body === 'string' ? utf8ByteLength(body) : body.byteLength
}

function requestBody(body: BodyInit | null | undefined): string | Uint8Array | undefined {
  if (body == null) return undefined
  if (typeof body === 'string') return body
  if (body instanceof Uint8Array) return body
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  }
  throw new TypeError('Restricted HTTPS request body type is unsupported')
}

function responseHeaders(rawHeaders: string[]): Headers {
  const headers = new Headers()
  for (let i = 0; i + 1 < rawHeaders.length; i += 2) {
    headers.append(rawHeaders[i], rawHeaders[i + 1])
  }
  return headers
}

/**
 * Build a fetch implementation that resolves and approves every address, then
 * pins the approved DNS answer into the TLS connection. This closes both
 * direct private-address SSRF and resolve/check/connect DNS-rebinding races.
 */
export function createPublicNetworkFetch(
  options: { expectedOrigin?: string; allowHTTP?: boolean } = {},
  resolver: AddressResolver = defaultAddressResolver
): typeof fetch {
  const allowHTTP = options.allowHTTP === true
  const origin = options.expectedOrigin === undefined ? undefined : new URL(options.expectedOrigin)
  if (
    origin !== undefined &&
    ((origin.protocol !== 'https:' && !(allowHTTP && origin.protocol === 'http:')) ||
      origin.username !== '' ||
      origin.password !== '')
  ) {
    throw new Error('Restricted fetch origin must use an allowed HTTP protocol')
  }

  const issuerFetch = async (
    input: RequestInfo | URL,
    init: RequestInit = {}
  ): Promise<Response> => {
    const target = checkedTarget(input, origin?.origin, allowHTTP)
    const nodeRuntime =
      typeof process !== 'undefined' && typeof process.getBuiltinModule === 'function'
    if (!nodeRuntime) {
      return await fetch(target, { ...init, redirect: 'error' })
    }
    const addresses = await resolveWithDeadline(resolver, target.hostname)
    if (
      addresses.length === 0 ||
      addresses.length > MAX_DNS_ADDRESSES ||
      addresses.some(
        ({ address, family }) => (family !== 4 && family !== 6) || !isPublicNetworkAddress(address)
      )
    ) {
      throw new Error('Restricted HTTPS request resolved to a non-public address')
    }

    const lookup = (
      _hostname: string,
      options: number | { family?: number; all?: boolean },
      callback: LookupCallback
    ): void => {
      const family = typeof options === 'number' ? options : options.family
      const candidates = addresses.filter(
        candidate => family == null || family === 0 || candidate.family === family
      )
      if (candidates.length === 0) {
        callback(new Error('Restricted HTTPS request has no approved address for this family'))
      } else if (typeof options !== 'number' && options.all === true) {
        callback(null, candidates)
      } else {
        callback(null, candidates[0].address, candidates[0].family)
      }
    }

    const requestModule = process.getBuiltinModule(
      target.protocol === 'https:' ? 'node:https' : 'node:http'
    ) as RequestModule
    const stream = process.getBuiltinModule('node:stream') as StreamModule
    const requestHeaders = new Headers(init.headers)
    for (const name of requestHeaders.keys()) {
      if (FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase())) {
        throw new Error(`Restricted HTTPS request forbids the ${name} header`)
      }
    }
    const body = requestBody(init.body)
    const length = bodyByteLength(body)
    const declaredLength = requestHeaders.get('content-length')
    if (
      declaredLength !== null &&
      (length === undefined ||
        !/^(0|[1-9]\d*)$/.test(declaredLength) ||
        Number(declaredLength) !== length)
    ) {
      throw new Error('Restricted request Content-Length does not match its body')
    }
    if (length !== undefined && declaredLength === null) {
      requestHeaders.set('content-length', String(length))
    }
    const headers = Object.fromEntries(requestHeaders.entries())

    return await new Promise<Response>((resolve, reject) => {
      let settled = false
      let request: ClientRequest
      const cleanup = (): void => init.signal?.removeEventListener('abort', abort)
      const rejectOnce = (error: unknown): void => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      const resolveOnce = (response: Response): void => {
        if (settled) return
        settled = true
        cleanup()
        resolve(response)
      }
      const abort = (): void => request.destroy(new DOMException('aborted', 'AbortError'))
      request = requestModule.request(
        target,
        { method: init.method ?? 'GET', headers, lookup },
        response => {
          const status = response.statusCode ?? 0
          if (status < 200 || status > 599) {
            response.resume()
            rejectOnce(new Error('Restricted HTTPS request returned an invalid HTTP status'))
            return
          }
          const hasNoBody = status === 204 || status === 205 || status === 304
          const responseBody = hasNoBody ? null : stream.Readable.toWeb(response)
          if (hasNoBody) response.resume()
          resolveOnce(
            new Response(responseBody, {
              status,
              statusText: response.statusMessage,
              headers: responseHeaders(response.rawHeaders)
            })
          )
        }
      )
      if (init.signal?.aborted === true) {
        abort()
      } else {
        init.signal?.addEventListener('abort', abort, { once: true })
      }
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.destroy(new Error('Restricted HTTPS request timed out'))
      })
      request.on('error', rejectOnce)
      request.end(body)
    })
  }

  return issuerFetch as typeof fetch
}

export function createPublicHTTPSFetch(
  expectedOrigin?: string,
  resolver: AddressResolver = defaultAddressResolver
): typeof fetch {
  return createPublicNetworkFetch({ expectedOrigin }, resolver)
}
