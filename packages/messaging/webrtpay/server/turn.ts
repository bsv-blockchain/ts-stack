import { createHmac } from 'node:crypto'
import { Hash, Utils } from '@bsv/sdk'
import type { RelayIceServer } from '../src/signaling/RelaySignaler.js'
import { cloudflareTurnIssuer } from './cloudflare.js'

/** Ephemeral TURN credentials in coturn's REST API (`use-auth-secret`) format. */
export interface TurnCredentials {
  /** `"<unix expiry seconds>:<pseudonym>"`; see {@link turnCredentials}. */
  username: string
  /** Standard base64 of HMAC-SHA1(secret, username), as coturn's REST API requires. */
  credential: string
  /** When the credentials stop working, in Unix milliseconds. */
  expiresAt: number
}

/**
 * Credentials minted by the relay itself for a coturn configured with `use-auth-secret`
 * and `static-auth-secret=<secret>` (see {@link turnCredentials}), for `urls`.
 */
export interface CoturnRestTurnProvider {
  kind: 'coturn-rest'
  secret: string
  /** TURN urls the credentials are for, e.g. `turn:turn.example.com:3478`. */
  urls: string[]
  /** Lifetime of each set, in seconds; default 600. */
  ttlSeconds?: number
}

/**
 * Credentials from Cloudflare Realtime TURN, which the relay asks for with a TURN key
 * (`keyId`, and `apiToken`, the key's API token) each time a client asks it for TURN.
 * Cloudflare chooses the urls (`turn.cloudflare.com`).
 */
export interface CloudflareTurnProvider {
  kind: 'cloudflare'
  keyId: string
  /** Never logged, and never sent anywhere but to Cloudflare. */
  apiToken: string
  /** Lifetime of each set, in seconds; default 600, at most 172800 (48 hours, Cloudflare's limit). */
  ttlSeconds?: number
  /** `fetch` to call Cloudflare with; defaults to the global one. */
  fetch?: typeof fetch
}

/** Where the relay gets the TURN credentials it issues. */
export type TurnProvider = CoturnRestTurnProvider | CloudflareTurnProvider

/** One set of TURN credentials, as the relay hands it out. */
export interface TurnIssue {
  /** The provider's ICE servers: TURN, after any STUN it lists. */
  iceServers: RelayIceServer[]
  /** When the TURN credentials stop working, in Unix milliseconds. */
  expiresAt: number
}

/** Issues TURN credentials from a {@link TurnProvider}. */
export interface TurnIssuer {
  readonly kind: TurnProvider['kind']
  /** Lifetime of the credentials `issue` returns, in seconds. */
  readonly ttlSeconds: number
  /**
   * Fresh credentials for `identityKey`. Rejects with an `Error` whose message says what
   * went wrong and holds no secret, credential or url, so it may be logged.
   */
  issue(identityKey: string): Promise<TurnIssue>
}

/** Default lifetime of credentials minted by `turnCredentials`, in seconds. */
const TURN_CREDENTIALS_DEFAULT_TTL_SECONDS = 3600
/**
 * Lifetime of the TURN credentials the relay issues, in seconds, unless `turn.ttlSeconds`
 * says otherwise.
 */
export const DEFAULT_TURN_TTL_SECONDS = 600
/** Domain separation for the username pseudonym. */
const PSEUDONYM_PREFIX = 'webrtpay-turn-user|'
/** Characters of the pseudonym kept: 132 bits of base64url. */
const PSEUDONYM_CHARS = 22

/**
 * Mint TURN credentials for `identityKey` that coturn accepts when configured with
 * `use-auth-secret` and `static-auth-secret=<secret>`.
 *
 * The username never contains the identity key: TURN sends it in the clear and
 * coturn may log it. It is `<expiry>:<pseudonym>`, where the pseudonym is the
 * first 22 characters of base64url(HMAC-SHA256(secret, "webrtpay-turn-user|" +
 * identityKey)). Only the holder of the secret can link it to the key, and it is
 * the same for every expiry, so coturn's `--user-quota` (which counts the part
 * after the timestamp) still applies per identity. Credentials cannot be revoked
 * once minted; rotating the secret is the only way to cut them off early.
 *
 * @param o.ttlSeconds - Lifetime; a positive whole number, default 3600.
 * @param o.now - Current time in Unix milliseconds; defaults to `Date.now()`.
 */
export function turnCredentials(o: {
  secret: string
  identityKey: string
  ttlSeconds?: number
  now?: number
}): TurnCredentials {
  if (typeof o.secret !== 'string' || o.secret.length === 0) {
    throw new TypeError('TURN secret must be a non-empty string')
  }
  const ttl = o.ttlSeconds ?? TURN_CREDENTIALS_DEFAULT_TTL_SECONDS
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new RangeError('ttlSeconds must be a positive whole number of seconds')
  }
  const expiry = Math.floor((o.now ?? Date.now()) / 1000) + ttl
  const pseudonym = createHmac('sha256', o.secret)
    .update(PSEUDONYM_PREFIX + o.identityKey)
    .digest('base64url')
    .slice(0, PSEUDONYM_CHARS)
  const username = `${expiry}:${pseudonym}`
  return {
    username,
    credential: coturnRestCredential(o.secret, username),
    expiresAt: expiry * 1000
  }
}

/**
 * coturn's REST API (`use-auth-secret`) checks the password as base64(HMAC-SHA1(secret,
 * username)), so the algorithm is fixed by coturn. HMAC-SHA1 does not depend on SHA-1's
 * collision resistance, and the username is sent in the clear anyway. Computed with
 * `@bsv/sdk`'s `Hash.SHA1HMAC` over the UTF-8 bytes of both (its constructor reads a
 * string key as hex, so the key is passed as bytes); the result is byte-identical to
 * node:crypto's `createHmac('sha1', secret).update(username).digest('base64')`.
 */
function coturnRestCredential(secret: string, username: string): string {
  const mac = new Hash.SHA1HMAC(Utils.toArray(secret, 'utf8'))
  return Utils.toBase64(mac.update(Utils.toArray(username, 'utf8')).digest())
}

/**
 * An issuer for `provider`. Throws `TypeError` or `RangeError` for a provider it could not
 * issue for (no secret, no urls, a malformed key id or token, a bad ttl), without naming
 * any secret; it calls nothing until the first `issue`.
 */
export function turnIssuer(provider: TurnProvider): TurnIssuer {
  const ttl = provider.ttlSeconds ?? DEFAULT_TURN_TTL_SECONDS
  if (!Number.isSafeInteger(ttl) || ttl <= 0) {
    throw new RangeError('turn.ttlSeconds must be a positive whole number of seconds')
  }
  switch (provider.kind) {
    case 'coturn-rest':
      return coturnRestIssuer(provider, ttl)
    case 'cloudflare':
      return cloudflareTurnIssuer(provider, ttl)
    default:
      throw new TypeError("turn.kind must be 'coturn-rest' or 'cloudflare'")
  }
}

function coturnRestIssuer(p: CoturnRestTurnProvider, ttlSeconds: number): TurnIssuer {
  if (!Array.isArray(p.urls) || p.urls.length === 0) {
    throw new TypeError('turn.urls must list at least one TURN url')
  }
  // Validates the secret now rather than on the first request.
  turnCredentials({ secret: p.secret, identityKey: '', ttlSeconds })
  const { secret } = p
  const urls = [...p.urls]
  return {
    kind: 'coturn-rest',
    ttlSeconds,
    issue(identityKey) {
      // The relay chains `.then` on this, so a failure must reject, never throw.
      try {
        const { username, credential, expiresAt } = turnCredentials({
          secret,
          identityKey,
          ttlSeconds
        })
        return Promise.resolve({
          iceServers: [{ urls: [...urls], username, credential }],
          expiresAt
        })
      } catch (error) {
        return Promise.reject(error)
      }
    }
  }
}
