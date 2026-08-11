// Synchronized by scripts/sync-service-rate-limit-policy.mjs. Edit
// infra/wab/src/security/rateLimitPolicy.ts, then run the sync command.
import type { Application, Request, Response } from 'express'
import { ipKeyGenerator, type Options } from 'express-rate-limit'

const MAX_TRUST_PROXY_HOPS = 10
const MAX_RATE_LIMIT = 1_000_000
const MAX_RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000

export interface RateLimitDefaults {
  windowMs: number
  limit: number
}

export function readBoundedInteger (
  name: string,
  fallback: number,
  maximum: number
): number {
  const value = process.env[name]
  if (value == null || value.trim() === '') return fallback
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${name} must be a positive integer`)
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed > maximum) {
    throw new Error(`${name} must not exceed ${maximum}`)
  }
  return parsed
}

function readRateLimit (name: string, fallback: number): number {
  const value = process.env[name]
  if (value == null || value.trim() === '') return fallback
  const normalized = value.trim().toLowerCase()
  // express-rate-limit has no disabled sentinel. A safe-integer ceiling is
  // effectively unlimited while preserving a numeric value for its internals.
  if (normalized === '-1' || normalized === 'unlimited') return Number.MAX_SAFE_INTEGER
  return readBoundedInteger(name, fallback, MAX_RATE_LIMIT)
}

export function rateLimitOptions (
  prefix: string,
  defaults: RateLimitDefaults,
  overrides: Partial<Options> = {}
): Partial<Options> {
  return {
    windowMs: readBoundedInteger(`${prefix}_WINDOW_MS`, defaults.windowMs, MAX_RATE_LIMIT_WINDOW_MS),
    limit: readRateLimit(`${prefix}_MAX`, defaults.limit),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req: Request, res: Response) => {
      res.status(429).json({
        status: 'error',
        code: 'ERR_RATE_LIMITED',
        description: 'Too many requests. Please retry later.'
      })
    },
    ...overrides
  }
}

export function authenticatedIdentityKey (req: Request): string {
  const identityKey = (req as Request & {
    auth?: { identityKey?: unknown }
  }).auth?.identityKey
  if (typeof identityKey === 'string' && identityKey.trim() !== '' && identityKey !== 'unknown') {
    return `identity:${identityKey}`
  }
  return `ip:${ipKeyGenerator(req.ip ?? req.socket.remoteAddress ?? 'unknown')}`
}

/**
 * Express ignores forwarding headers by default. Operators may explicitly
 * declare a small, known proxy chain; permissive `trust proxy = true` is never
 * enabled because a directly reachable client could spoof its source address.
 */
export function configureTrustProxy (
  app: Application,
  rawValue: string | undefined = process.env.TRUST_PROXY_HOPS
): void {
  if (rawValue == null || rawValue.trim() === '') return
  if (!/^\d+$/.test(rawValue)) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 10')
  }
  const hops = Number(rawValue)
  if (!Number.isSafeInteger(hops) || hops > MAX_TRUST_PROXY_HOPS) {
    throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 10')
  }
  app.set('trust proxy', hops)
}
