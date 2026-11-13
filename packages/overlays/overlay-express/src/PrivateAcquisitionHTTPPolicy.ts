import type { Request, Response } from 'express'
import { canonicalOutputJSON, outputServiceErrorHTTPStatus } from '@bsv/sdk'
import { lookupHTTPError, lookupPrivateHeaders } from './OutputLookupHTTPPolicy.js'
export {
  rootHTTPOrigins as privateAcquisitionHTTPOrigins,
  rootHTTPControlHeaders as privateAcquisitionHTTPControlHeaders
} from './RootEvictionHTTPPolicy.js'

/** Fixed public diagnostics; never serialize a domain validator's error text. */
export function privateAcquisitionHTTPError(error: unknown) {
  const value = lookupHTTPError(error)
  const packet = {
    version: 1,
    error: {
      code: value.error.code,
      message: `Private acquisition request ${value.error.code}`,
      retryable: value.error.retryable
    }
  }
  return {
    packet,
    statusCode: outputServiceErrorHTTPStatus(packet.error.code),
    body: new TextEncoder().encode(canonicalOutputJSON(packet, { bytes: 4096 }))
  }
}
export function sendPrivateAcquisitionHTTPError(res: Response, error: unknown): void {
  if (res.destroyed || res.writableEnded || res.headersSent) return
  const control = privateAcquisitionHTTPError(error)
  res
    .status(control.statusCode)
    .set('content-type', 'application/json')
    .end(Buffer.from(control.body))
}

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
const profileHeaders = ['x-bsv-overlay-capability', 'x-bsv-overlay-profile']
const requestHeaders = [
  'authorization',
  'content-type',
  'cache-control',
  'x-bsv-payment',
  ...authenticationHeaders,
  ...profileHeaders
]
const responseHeaders = [
  ...authenticationHeaders,
  ...profileHeaders,
  'x-bsv-payment-version',
  'x-bsv-payment-satoshis-required',
  'x-bsv-payment-derivation-prefix'
]
/** Explicit paid-header support without changing any legacy route's public CORS. */
export function privateAcquisitionHTTPCORS(
  req: Request,
  res: Response,
  origins?: ReadonlySet<string>
): boolean {
  lookupPrivateHeaders(res)
  const origin = req.headers.origin
  if (
    origins !== undefined &&
    origin !== undefined &&
    (typeof origin !== 'string' || !origins.has(origin))
  ) {
    res.status(403).end()
    return false
  }
  if (origins === undefined || origin !== undefined)
    res.set({
      'access-control-allow-origin': origins === undefined ? '*' : (origin as string),
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': requestHeaders.join(', '),
      'access-control-expose-headers': responseHeaders.join(', ')
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
