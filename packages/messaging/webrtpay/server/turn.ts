import { createHmac } from 'node:crypto'

/** Ephemeral TURN credentials in coturn's REST API (`use-auth-secret`) format. */
export interface TurnCredentials {
  /** `"<unix expiry seconds>:<pseudonym>"`; see {@link turnCredentials}. */
  username: string
  /** Standard base64 of HMAC-SHA1(secret, username). */
  credential: string
  /** When the credentials stop working, in Unix milliseconds. */
  expiresAt: number
}

/** Default lifetime of TURN credentials, in seconds. */
const TURN_TTL_SECONDS = 3600
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
  const ttl = o.ttlSeconds ?? TURN_TTL_SECONDS
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
    credential: createHmac('sha1', o.secret).update(username).digest('base64'),
    expiresAt: expiry * 1000
  }
}
