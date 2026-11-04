import type { Request, Response } from 'express'
import { canonicalOutputJSON, outputServiceErrorHTTPStatus } from '@bsv/sdk'
import {
  lookupCORS,
  lookupHTTPError,
  lookupOrigins,
  lookupPrivateHeaders
} from './OutputLookupHTTPPolicy.js'

const authHeaders = [
  'x-bsv-auth-identity-key',
  'x-bsv-auth-message-type',
  'x-bsv-auth-nonce',
  'x-bsv-auth-request-id',
  'x-bsv-auth-requested-certificates',
  'x-bsv-auth-signature',
  'x-bsv-auth-version',
  'x-bsv-auth-your-nonce'
]
const profileHeaders = ['x-bsv-overlay-capability', 'x-bsv-overlay-profile']
const requestHeaders = [
  'authorization',
  'content-type',
  'cache-control',
  ...authHeaders,
  ...profileHeaders
]

/** Default public, credential-free access; an explicit array opts into exact origins. */
export function rootHTTPOrigins(input?: readonly string[]): ReadonlySet<string> | undefined {
  return input === undefined ? undefined : lookupOrigins(input)
}

export function rootHTTPCORS(req: Request, res: Response, origins?: ReadonlySet<string>): boolean {
  lookupPrivateHeaders(res)
  if (origins !== undefined) return lookupCORS(req, res, origins)
  res.set({
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': requestHeaders.join(', '),
    'access-control-expose-headers': [...authHeaders, ...profileHeaders].join(', ')
  })
  if (req.method !== 'OPTIONS') return true
  const requested = req.headers['access-control-request-headers']
  const valid =
    requested === undefined ||
    (typeof requested === 'string' &&
      requested.split(',').every(name => requestHeaders.includes(name.trim().toLowerCase())))
  res.status(valid ? 204 : 403).end()
  return false
}

/** Allow only locally constructed CORS/profile fields onto a replacement response. */
export function rootHTTPControlHeaders(res: Response): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of [
    'access-control-allow-origin',
    'access-control-allow-methods',
    'access-control-allow-headers',
    'access-control-expose-headers',
    'vary',
    ...profileHeaders
  ]) {
    const value = res.getHeader(name)
    if (typeof value === 'string') result[name] = value
  }
  return result
}

export function sendRootHTTPError(res: Response, error: unknown): void {
  if (res.destroyed || res.writableEnded || res.headersSent) return
  const packet = lookupHTTPError(error)
  packet.error.message = `Root request ${packet.error.code}`
  res
    .status(outputServiceErrorHTTPStatus(packet.error.code))
    .set('content-type', 'application/json')
    .end(canonicalOutputJSON(packet, { bytes: 4096 }))
}
