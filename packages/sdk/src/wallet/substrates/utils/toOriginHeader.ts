export function toOriginHeader(originator: string, fallbackScheme = 'http'): string | undefined {
  // If the caller already gave us a scheme, assume it’s fine
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(originator)) {
    try {
      return new URL(originator).origin       // trims any path/query
    } catch { /* fall through to fix-up */ }
  }

  // Otherwise, prepend the fallback scheme and validate
  try {
    return new URL(`${fallbackScheme}://${originator}`).origin
  } catch {
    throw new Error(`Invalid originator value: ${originator}`)
  }
}

/**
 * Normalize the fixed HTTP endpoint used for privileged wallet RPC calls.
 *
 * Wallet endpoints are origins, not general URLs: credentials, paths, query
 * parameters, and fragments would otherwise be retained when method names are
 * appended. Cleartext is limited to loopback development endpoints so wallet
 * arguments and caller identity are never sent over an arbitrary network.
 */
export function normalizeWalletHttpBaseUrl(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 2048 ||
    value !== value.trim()
  ) {
    throw new TypeError('Wallet HTTP baseUrl must be an exact HTTP(S) origin.')
  }

  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new TypeError('Wallet HTTP baseUrl must be an exact HTTP(S) origin.')
  }
  if (
    (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    parsed.origin === 'null'
  ) {
    throw new TypeError(
      'Wallet HTTP baseUrl must be an HTTP(S) origin without credentials, path, query, or fragment.'
    )
  }
  if (parsed.protocol === 'http:' && !isLoopbackHostname(parsed.hostname)) {
    throw new TypeError('Wallet HTTP baseUrl may use cleartext HTTP only for a loopback host.')
  }
  return parsed.origin
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]'
  )
}
