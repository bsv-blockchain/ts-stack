import type { Response } from 'express'
import { canonicalOutputJSON, outputServiceErrorHTTPStatus } from '@bsv/sdk'
import { lookupHTTPError } from './OutputLookupHTTPPolicy.js'
export {
  rootHTTPOrigins as privatePublicationHTTPOrigins,
  rootHTTPCORS as privatePublicationHTTPCORS,
  rootHTTPControlHeaders as privatePublicationHTTPControlHeaders
} from './RootEvictionHTTPPolicy.js'

/** Fixed public diagnostics; never serialize a domain validator's error text. */
export function privatePublicationHTTPError(error: unknown) {
  const value = lookupHTTPError(error)
  const packet = {
    version: 1,
    error: {
      code: value.error.code,
      message: `Private publication request ${value.error.code}`,
      retryable: value.error.retryable
    }
  }
  return {
    packet,
    statusCode: outputServiceErrorHTTPStatus(packet.error.code),
    body: new TextEncoder().encode(canonicalOutputJSON(packet, { bytes: 4096 }))
  }
}
export function sendPrivatePublicationHTTPError(res: Response, error: unknown): void {
  if (res.destroyed || res.writableEnded || res.headersSent) return
  const control = privatePublicationHTTPError(error)
  res
    .status(control.statusCode)
    .set('content-type', 'application/json')
    .end(Buffer.from(control.body))
}
