import type { Response } from 'express'
import { canonicalOutputJSON, outputServiceErrorHTTPStatus } from '@bsv/sdk'
import { lookupHTTPError } from './OutputLookupHTTPPolicy.js'
export {
  rootHTTPOrigins as proposalHTTPOrigins,
  rootHTTPCORS as proposalHTTPCORS,
  rootHTTPControlHeaders as proposalHTTPControlHeaders
} from './RootEvictionHTTPPolicy.js'

export interface ProposalHTTPControl {
  statusCode: number
  body: Uint8Array
}
/** Only fixed public diagnostics leave the transport; no private reason, row or path. */
export function proposalHTTPError(error: unknown): ProposalHTTPControl {
  const value = lookupHTTPError(error)
  const packet = {
    version: 1,
    error: {
      code: value.error.code,
      message: `Proposal request ${value.error.code}`,
      retryable: value.error.retryable
    }
  }
  return {
    statusCode: outputServiceErrorHTTPStatus(packet.error.code),
    body: new TextEncoder().encode(canonicalOutputJSON(packet, { bytes: 4096 }))
  }
}
/** Pre-authentication/selection errors are transport failures, not trusted proposal observations. */
export function sendProposalHTTPError(res: Response, error: unknown): void {
  if (res.destroyed || res.writableEnded || res.headersSent) return
  const control = proposalHTTPError(error)
  res
    .status(control.statusCode)
    .set('content-type', 'application/json')
    .end(Buffer.from(control.body))
}
