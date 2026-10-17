import { bindOutputPaidLookupAcquired, outputAssert, type OutputPaidLookupAcquired } from '@bsv/sdk'
import {
  parsePrivateAcquisitionProgress,
  type PrivateAcquisitionProgress
} from './PrivateAcquisitionProgress.js'

/**
 * Recipient projection only. The owner must authenticate the original buyer,
 * restore the original contract and guard actual delivery immediately before send.
 * Candidate bytes, native receipts and indexing information are never projected.
 */
export function privateAcquisitionResult(
  input: PrivateAcquisitionProgress,
  originalRequest: unknown,
  result?: OutputPaidLookupAcquired['result'],
  supportedExtensions: readonly string[] = []
): OutputPaidLookupAcquired {
  const state = parsePrivateAcquisitionProgress(input)
  outputAssert(
    (result !== undefined) === (state.phase === 'delivered'),
    'Acquisition result is unavailable or not deliverable',
    'unavailable'
  )
  return bindOutputPaidLookupAcquired(
    {
      version: 1,
      acquisitionId: state.challenge.acquisitionId,
      status: state.phase,
      recoveryUntil: state.recoveryUntil,
      challenge: state.challenge,
      ...(state.funding !== null ? { funding: state.funding.operation.funding } : {}),
      ...(state.funding !== null && state.phase !== 'funding-pending'
        ? { acceptance: state.funding.acceptance }
        : {}),
      ...(state.reason !== null ? { reason: state.reason } : {}),
      ...(result !== undefined ? { result } : {})
    },
    state.challenge,
    originalRequest,
    { seller: state.challenge.seller, rulesDigest: state.challenge.rulesDigest },
    supportedExtensions
  )
}
