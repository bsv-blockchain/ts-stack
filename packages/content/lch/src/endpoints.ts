import { LCH_LIMITS } from './constants.js'
import { LCHError, lchAssert } from './errors.js'

export type EndpointClass = 'identity' | 'content'

export interface EndpointPolicy {
  allowLocalOrigins?: readonly string[]
  resolve?: (hostname: string) => Promise<readonly string[]>
  connect?: (
    url: URL,
    init: RequestInit,
    validatedAddresses: readonly string[]
  ) => Promise<Response>
  maximumRedirects?: number
}

function ipv4Value(address: string): number | undefined {
  const parts = address.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map(part => (/^\d{1,3}$/u.test(part) ? Number(part) : -1))
  if (octets.some(value => value < 0 || value > 255)) return undefined
  return (((octets[0] * 256 + octets[1]) * 256 + octets[2]) * 256 + octets[3]) >>> 0
}

function inV4Range(value: number, start: number, bits: number): boolean {
  const shift = 32 - bits
  return value >>> shift === start >>> shift
}

export function isPublicAddress(address: string): boolean {
  const v4 = ipv4Value(address)
  if (v4 !== undefined) {
    const blocked: Array<[number, number]> = [
      [0x00000000, 8],
      [0x0a000000, 8],
      [0x64400000, 10],
      [0x7f000000, 8],
      [0xa9fe0000, 16],
      [0xac100000, 12],
      [0xc0000000, 24],
      [0xc0000200, 24],
      [0xc0a80000, 16],
      [0xc6120000, 15],
      [0xc6336400, 24],
      [0xcb007100, 24],
      [0xe0000000, 4],
      [0xf0000000, 4]
    ]
    return !blocked.some(([start, bits]) => inV4Range(v4, start, bits))
  }
  const normalized = address.toLowerCase().replace(/^\[|\]$/gu, '')
  if (!normalized.includes(':')) return false
  if (normalized === '::' || normalized === '::1') return false
  if (/^f[cd][\da-f]{2}:/u.test(normalized) || /^fe[89ab][\da-f]:/u.test(normalized)) return false
  if (normalized.startsWith('ff') || normalized.startsWith('2001:db8:')) return false
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized)?.[1]
  return mapped === undefined ? true : isPublicAddress(mapped)
}

export async function validateEndpoint(value: string, policy: EndpointPolicy = {}): Promise<URL> {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new LCHError('ERR_LCH_ENDPOINT', 'Endpoint is not an absolute URL', { cause: error })
  }
  lchAssert(
    url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '',
    'ERR_LCH_ENDPOINT',
    'Endpoint must be HTTPS without userinfo or fragment'
  )
  if (policy.allowLocalOrigins?.includes(url.origin) === true) return url
  const directAddress = isPublicAddress(url.hostname)
  if (/^[\d.]+$/u.test(url.hostname) || url.hostname.includes(':')) {
    lchAssert(directAddress, 'ERR_LCH_ENDPOINT', 'Endpoint address is not public')
  }
  if (directAddress) return url
  lchAssert(
    policy.resolve !== undefined,
    'ERR_LCH_ENDPOINT',
    'No DNS validation resolver is configured'
  )
  const addresses = await policy.resolve(url.hostname)
  lchAssert(
    addresses.length > 0 && addresses.every(isPublicAddress),
    'ERR_LCH_ENDPOINT',
    'Endpoint DNS result is empty or non-public'
  )
  return url
}

async function validatedAddresses(url: URL, policy: EndpointPolicy): Promise<readonly string[]> {
  if (policy.allowLocalOrigins?.includes(url.origin) === true) return []
  if (isPublicAddress(url.hostname)) return [url.hostname]
  lchAssert(
    policy.resolve !== undefined,
    'ERR_LCH_ENDPOINT',
    'No DNS validation resolver is configured'
  )
  const addresses = await policy.resolve(url.hostname)
  lchAssert(
    addresses.length > 0 && addresses.every(isPublicAddress),
    'ERR_LCH_ENDPOINT',
    'Endpoint DNS result is empty or non-public'
  )
  return addresses
}

export async function fetchLCH(
  input: string,
  init: RequestInit = {},
  endpointClass: EndpointClass = 'content',
  policy: EndpointPolicy = {}
): Promise<Response> {
  let url = await validateEndpoint(input, policy)
  const origin = url.origin
  const maximum =
    endpointClass === 'identity' ? 1 : (policy.maximumRedirects ?? LCH_LIMITS.redirects)
  for (let redirect = 0; ; redirect += 1) {
    const addresses = await validatedAddresses(url, policy)
    const request = { ...init, redirect: 'manual' as const }
    const localOrigin = policy.allowLocalOrigins?.includes(url.origin) === true
    lchAssert(
      policy.connect !== undefined ||
        (addresses.length === 1 && addresses[0] === url.hostname) ||
        localOrigin,
      'ERR_LCH_ENDPOINT',
      'DNS endpoints require an address-pinning connector'
    )
    const response =
      policy.connect === undefined
        ? await fetch(url, request)
        : await policy.connect(url, request, addresses)
    if (![301, 302, 303, 307, 308].includes(response.status)) return response
    lchAssert(redirect < maximum, 'ERR_LCH_ENDPOINT', 'Endpoint redirect limit exceeded')
    const location = response.headers.get('location')
    lchAssert(location !== null, 'ERR_LCH_ENDPOINT', 'Redirect omitted Location')
    const next = await validateEndpoint(new URL(location, url).href, policy)
    if (endpointClass === 'identity') {
      lchAssert(
        (response.status === 307 || response.status === 308) && next.origin === origin,
        'ERR_LCH_ENDPOINT',
        'Identity endpoint redirect must preserve method and origin'
      )
    } else if (next.origin !== url.origin) {
      init = { ...init, headers: stripSensitiveHeaders(init.headers) }
    }
    url = next
  }
}

function stripSensitiveHeaders(input: HeadersInit | undefined): Headers {
  const headers = new Headers(input)
  for (const name of ['authorization', 'cookie', 'x-bsv-auth', 'x-bsv-payment'])
    headers.delete(name)
  return headers
}
