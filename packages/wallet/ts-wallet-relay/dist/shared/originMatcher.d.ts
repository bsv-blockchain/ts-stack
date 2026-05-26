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
export type AllowedOrigins = string | string[] | RegExp | ((origin: string) => boolean);
/**
 * Compile an `AllowedOrigins` declaration into a single predicate.
 * Returns `null` when no allowlist is configured (caller treats this as "allow all").
 */
export declare function compileOriginMatcher(allowed: AllowedOrigins | undefined | null): ((origin: string) => boolean) | null;
//# sourceMappingURL=originMatcher.d.ts.map