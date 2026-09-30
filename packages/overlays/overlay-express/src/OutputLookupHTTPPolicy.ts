import type { Request, Response } from 'express'
import {
  canonicalOutputJSON,
  outputServiceErrorHTTPStatus,
  parseOutputServiceError,
  type OutputServiceError
} from '@bsv/sdk'

const authenticationHeaders = [
  'x-bsv-auth-identity-key',
  'x-bsv-auth-message-type',
  'x-bsv-auth-nonce',
  'x-bsv-auth-request-id',
  'x-bsv-auth-requested-certificates',
  'x-bsv-auth-signature',
  'x-bsv-auth-version',
  'x-bsv-auth-your-nonce'
]
const selectionHeaders = ['x-bsv-overlay-capability', 'x-bsv-overlay-profile']
const allowedHeaders = [
  'authorization',
  'content-type',
  'cache-control',
  ...authenticationHeaders,
  ...selectionHeaders
]
const codes: OutputServiceError['error']['code'][] = [
  'invalid',
  'unauthorized',
  'not-found',
  'conflict',
  'equivocation',
  'reset-required',
  'context-changed',
  'expired',
  'limited',
  'unsupported',
  'unavailable'
]

/** Do not expose exception messages, queries, private rows, cursor material or storage paths. */
export function lookupHTTPError(error: unknown): OutputServiceError {
  let code: OutputServiceError['error']['code'] = 'unavailable',
    retryable = true
  let limit: unknown
  if (error instanceof Error) {
    const properties = Object.getOwnPropertyDescriptors(error)
    const candidate: unknown = properties.code?.value
    if (typeof candidate === 'string' && codes.some(value => value === candidate)) {
      code = candidate as OutputServiceError['error']['code']
      retryable = properties.retryable?.value === true
      if (code === 'limited') limit = properties.limit?.value
    }
  }
  const base = { version: 1, error: { code, message: `Lookup request ${code}`, retryable } }
  if (limit !== undefined) {
    try {
      return parseOutputServiceError({ ...base, error: { ...base.error, limit } })
    } catch {
      /* Only validated bounded diagnostics are public. */
    }
  }
  return parseOutputServiceError(base)
}

export function sendLookupHTTPError(res: Response, error: unknown): void {
  if (res.destroyed || res.writableEnded || res.headersSent) return
  const packet = lookupHTTPError(error)
  res
    .status(outputServiceErrorHTTPStatus(packet.error.code))
    .set('content-type', 'application/json')
    .end(canonicalOutputJSON(packet, { bytes: 4096 }))
}

export function lookupPrivateHeaders(res: Response): void {
  res.set({
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'x-accel-buffering': 'no'
  })
  res.vary(
    'Authorization, x-bsv-auth-identity-key, x-bsv-overlay-capability, x-bsv-overlay-profile, Origin'
  )
}

/** Exact configured origins only; no cookie credentials or environment-driven wildcard. */
export function lookupOrigins(input: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(input) || input.length > 256)
    throw new TypeError('Lookup origins must be a bounded array')
  const result = new Set<string>()
  for (const origin of input) {
    if (typeof origin !== 'string' || origin.length > 2048)
      throw new TypeError('Invalid lookup origin')
    const parsed = new URL(origin)
    if (
      !['https:', 'http:'].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      result.has(origin)
    )
      throw new TypeError('Lookup origins must be unique canonical HTTP(S) origins')
    result.add(origin)
  }
  return result
}

export function lookupCORS(req: Request, res: Response, origins: ReadonlySet<string>): boolean {
  const origin = req.headers.origin
  if (origin !== undefined) {
    if (typeof origin !== 'string' || !origins.has(origin)) {
      res.status(403).end()
      return false
    }
    res.set({
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': allowedHeaders.join(', '),
      'access-control-expose-headers': [...authenticationHeaders, ...selectionHeaders].join(', ')
    })
  }
  if (req.method === 'OPTIONS') {
    const wanted = req.headers['access-control-request-headers']
    const valid =
      wanted === undefined ||
      (typeof wanted === 'string' &&
        wanted.split(',').every(name => allowedHeaders.includes(name.trim().toLowerCase())))
    res.status(valid ? 204 : 403).end()
    return false
  }
  return true
}
