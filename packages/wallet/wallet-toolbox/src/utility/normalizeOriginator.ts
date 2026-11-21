/**
 * Normalizes an originator to its lowercase hostname.
 *
 * This is the same helper WalletPermissionsManager uses for permission
 * authority. BRC-100 grants are hostname-scoped, so scheme, port and letter
 * case are not distinct originators. A value that does not yield a hostname
 * falls back to a trimmed lowercase string; callers that require a canonical
 * DNS name still reject that fallback.
 */
export function normalizeOriginator(originator?: string): string {
  if (!originator) return ''
  const trimmed = originator.trim()
  if (!trimmed) return ''

  try {
    const hasScheme = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    const candidate = hasScheme ? trimmed : `https://${trimmed}`
    const url = new URL(candidate)
    if (!url.hostname) return trimmed.toLowerCase()
    const hostname = url.hostname.toLowerCase()
    return hostname.includes(':') ? `[${hostname}]` : hostname
  } catch {
    return trimmed.toLowerCase()
  }
}

/**
 * Hostname used for admin comparison, or undefined when the caller passed none.
 * An empty result is not an originator: admin checks must fail closed on it.
 */
export function canonicalOriginator(originator?: string): string | undefined {
  if (originator == null || originator === '') return undefined
  const normalized = normalizeOriginator(originator)
  return normalized === '' ? undefined : normalized
}
