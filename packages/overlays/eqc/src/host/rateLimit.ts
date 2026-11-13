import { ipKeyGenerator, rateLimit, type RateLimitRequestHandler } from 'express-rate-limit'

/** Requests one client may make to the three economic routes together, per window. */
export interface HostRateLimit {
  windowMs: number
  limit: number
}

/**
 * A query costs one attestation and up to `collectAttempts` collects per host, and params are
 * cached by the client, so 240 a minute leaves room for dozens of queries a minute per client.
 */
export const DEFAULT_HOST_RATE_LIMIT: HostRateLimit = { windowMs: 60_000, limit: 240 }

const MAX_WINDOW_MS = 24 * 60 * 60 * 1000
const MAX_LIMIT = 1_000_000

function bounded(value: number, name: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`rateLimit.${name} must be an integer from 1 to ${max}`)
  }
  return value
}

/**
 * Counts an authenticated client by its BRC-103 identity key, so clients behind one address do
 * not share a budget, and anything else, such as an unauthenticated params read, by address.
 */
export function rateLimitKey(req: {
  auth?: { identityKey?: unknown }
  ip?: string
  socket?: { remoteAddress?: string }
}): string {
  const identityKey = req.auth?.identityKey
  if (typeof identityKey === 'string' && identityKey !== '' && identityKey !== 'unknown') {
    return `identity:${identityKey}`
  }
  return `ip:${ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? 'unknown')}`
}

export function createHostRateLimiter(
  limits: Partial<HostRateLimit> = {}
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: bounded(
      limits.windowMs ?? DEFAULT_HOST_RATE_LIMIT.windowMs,
      'windowMs',
      MAX_WINDOW_MS
    ),
    limit: bounded(limits.limit ?? DEFAULT_HOST_RATE_LIMIT.limit, 'limit', MAX_LIMIT),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    handler: (_req, res) => {
      res.status(429).json({
        status: 'error',
        code: 'ERR_RATE_LIMITED',
        description: 'Too many requests. Please retry later.'
      })
    }
  })
}
