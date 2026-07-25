import type { Application, Request, Response } from 'express'
import { ipKeyGenerator, type Options } from 'express-rate-limit'

export type TrustProxySetting =
  | number
  | string
  | string[]
  | ((ip: string, hop: number) => boolean)

export function rateLimitOptions (
  defaults: { windowMs: number, limit: number },
  overrides: Partial<Options> = {}
): Partial<Options> {
  return {
    ...defaults,
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

export function configureTrustProxy (
  app: Application,
  setting: TrustProxySetting | undefined
): void {
  if (setting === undefined) return
  if (typeof setting === 'number' && (!Number.isSafeInteger(setting) || setting < 0)) {
    throw new Error('trustProxy hop count must be a non-negative integer')
  }
  app.set('trust proxy', setting)
}
