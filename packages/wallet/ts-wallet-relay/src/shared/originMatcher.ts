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
export type AllowedOrigins =
  | string
  | string[]
  | RegExp
  | ((origin: string) => boolean)

/**
 * Compile an `AllowedOrigins` declaration into a single predicate.
 * Returns `null` when no allowlist is configured (caller treats this as "allow all").
 */
export function compileOriginMatcher(
  allowed: AllowedOrigins | undefined | null
): ((origin: string) => boolean) | null {
  if (allowed == null) return null
  if (typeof allowed === 'string')   return o => o === allowed
  if (Array.isArray(allowed))        return o => allowed.includes(o)
  if (allowed instanceof RegExp)     return o => allowed.test(o)
  if (typeof allowed === 'function') return allowed
  return null
}
