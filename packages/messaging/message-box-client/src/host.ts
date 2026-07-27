const MAX_HOST_LENGTH = 2048

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split('.').map(Number)
  if (
    octets.length !== 4 ||
    octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return false
  }

  const [first, second] = octets
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && (octets[2] === 0 || octets[2] === 2)) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19 || (second === 51 && octets[2] === 100))) ||
    (first === 203 && second === 0 && octets[2] === 113) ||
    first >= 224
  )
}

function isPrivateIpv6(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  if (!normalized.includes(':')) return false
  return (
    normalized === '::' ||
    normalized === '::1' ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    /^fe[89ab]/.test(normalized) ||
    normalized.startsWith('ff') ||
    normalized.startsWith('2001:db8:') ||
    normalized.startsWith('::ffff:')
  )
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.lan') ||
    normalized.endsWith('.home') ||
    normalized.endsWith('.internal') ||
    normalized.endsWith('.test') ||
    normalized.endsWith('.invalid') ||
    normalized === 'example.com' ||
    normalized.endsWith('.example.com') ||
    isPrivateIpv4(normalized) ||
    isPrivateIpv6(normalized)
  )
}

/**
 * Validates and canonicalizes an explicitly configured Message Box base URL.
 *
 * HTTP remains supported for operator-controlled local development. Overlay
 * advertisements use the stricter `normalizeOverlayMessageBoxHost` boundary.
 */
export function normalizeMessageBoxHost(host: string): string {
  if (typeof host !== 'string') throw new TypeError('Message Box host must be a string')

  const candidate = host.trim()
  if (candidate === '' || candidate.length > MAX_HOST_LENGTH) {
    throw new TypeError('Message Box host must be a non-empty URL of at most 2048 characters')
  }

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new TypeError('Message Box host must be an absolute HTTP(S) URL')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('Message Box host must use HTTP or HTTPS')
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('Message Box host must not contain credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new TypeError('Message Box host must not contain a query or fragment')
  }

  let pathname = url.pathname
  while (pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  return pathname === '' ? url.origin : `${url.origin}${pathname}`
}

/**
 * Validates an untrusted overlay advertisement before it can become a network
 * destination. Advertisements must use HTTPS and must not target local,
 * reserved, or documentation-only hostnames.
 */
export function normalizeOverlayMessageBoxHost(host: string): string | undefined {
  try {
    const normalized = normalizeMessageBoxHost(host)
    const url = new URL(normalized)
    if (url.protocol !== 'https:' || isLocalHostname(url.hostname)) return undefined
    return normalized
  } catch {
    return undefined
  }
}

export function messageBoxEndpoint(host: string, path: string): string {
  const normalizedHost = normalizeMessageBoxHost(host)
  const normalizedPath = path.replace(/^\/+/, '')
  if (normalizedPath === '') throw new TypeError('Message Box endpoint path must not be empty')
  return `${normalizedHost}/${normalizedPath}`
}
