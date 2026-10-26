/**
 * Origin allowlist — flexible matcher used by both `WebSocketRelay`
 * (browser WS upgrade validation) and `WalletRelayService` (per-session
 * origin claim validation in `createSession`).
 *
 * Accepted shapes:
 *   - `string`   — exact match
 *   - `string[]` — match any in the list
 *   - `RegExp`   — match by pattern (e.g. `/\.commonsource\.nl$/`)
 *   - function   — custom predicate
 */
export type AllowedOrigins = string | string[] | RegExp | ((origin: string) => boolean)

/**
 * Compile an `AllowedOrigins` declaration into a single predicate.
 * Returns `null` when no allowlist is configured (caller treats this as "allow all").
 */
export function compileOriginMatcher(
  allowed: AllowedOrigins | undefined | null
): ((origin: string) => boolean) | null {
  if (allowed == null) return null
  if (typeof allowed === 'string') return o => o === allowed
  if (Array.isArray(allowed)) {
    if (allowed.some(origin => typeof origin !== 'string')) {
      throw new TypeError('allowedOrigins arrays may contain only strings')
    }
    const exactOrigins = [...allowed]
    return o => exactOrigins.includes(o)
  }
  if (allowed instanceof RegExp)
    return o => {
      // Global and sticky regexes retain lastIndex between calls. Reset it on
      // both sides so an allowlist cannot alternate allow/deny decisions.
      allowed.lastIndex = 0
      const matches = allowed.test(o)
      allowed.lastIndex = 0
      return matches
    }
  if (typeof allowed === 'function')
    return o => {
      try {
        return allowed(o) === true
      } catch {
        return false
      }
    }
  throw new TypeError('allowedOrigins must be a string, string array, RegExp, or predicate')
}
