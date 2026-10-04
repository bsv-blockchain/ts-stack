import { createHash } from 'node:crypto'
import {
  ownOutputJSON,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32
} from '@bsv/sdk'
import type { PrivateServiceIdentity } from './PrivateServiceIdentity.js'
import type { PrivateAcquisitionOriginal } from './PrivateAcquisitionRecords.js'
import {
  createPrivateAcquisitionProgress,
  parsePrivateAcquisitionProgress,
  type PrivateAcquisitionProgress
} from './PrivateAcquisitionProgress.js'
import {
  parsePrivateAcquisitionPayload,
  type PrivateAcquisitionPayload
} from './PrivateAcquisitionPayloads.js'

export interface PrivateAcquisitionState {
  format: 'private-acquisition-state/1'
  originalDigest: string
  progress: PrivateAcquisitionProgress
  material: PrivateAcquisitionPayload
  result: PrivateAcquisitionPayload
}
export function privateAcquisitionAddress(
  identity: PrivateServiceIdentity,
  kind: 'acquisition' | 'quote',
  id: string
) {
  return identity.address(kind, { purpose: 'private-acquisition', acquisitionId: outputHex32(id) })
}
export function privateAcquisitionPrefix(
  identity: PrivateServiceIdentity,
  original: PrivateAcquisitionOriginal
) {
  const { acquisitionId, requestDigest, derivationPrefix } = original.challenge
  return {
    address: identity.address('prefix-fence', {
      purpose: 'private-acquisition-prefix',
      derivationPrefix
    }),
    value: {
      format: 'private-acquisition-prefix/1',
      acquisitionId,
      requestDigest,
      derivationPrefix
    }
  }
}
function originalDigest(original: PrivateAcquisitionOriginal): string {
  return createHash('sha256')
    .update('private-acquisition-original/1\0')
    .update(canonicalOutputJSON(original))
    .digest('hex')
}
export function parsePrivateAcquisitionState(
  input: unknown,
  original: PrivateAcquisitionOriginal
): PrivateAcquisitionState {
  const value = ownOutputJSON(input, { bytes: 1048576 }).value
  closedOutputObject(value, ['format', 'originalDigest', 'progress', 'material', 'result'])
  outputAssert(
    value.format === 'private-acquisition-state/1',
    'Unsupported acquisition state',
    'unsupported'
  )
  const progress = parsePrivateAcquisitionProgress(value.progress)
  outputAssert(
    value.originalDigest === originalDigest(original) &&
      canonicalOutputJSON(progress.challenge) === canonicalOutputJSON(original.challenge) &&
      canonicalOutputJSON(progress.chain) === canonicalOutputJSON(original.request.listing.chain),
    'Acquisition state differs from retained original',
    'unavailable'
  )
  const material = parsePrivateAcquisitionPayload(value.material),
    result = parsePrivateAcquisitionPayload(value.result)
  for (const payload of [material, result])
    outputAssert(
      payload.acquisitionId === original.challenge.acquisitionId &&
        payload.requestDigest === original.challenge.requestDigest,
      'Acquisition payload belongs to another request',
      'unavailable'
    )
  outputAssert(
    material.purpose === 'material' &&
      material.digest !== null &&
      result.purpose === 'result' &&
      result.maximumBytes === original.maximumContextBytes,
    'Acquisition payload purpose or reservation differs',
    'unavailable'
  )
  outputAssert(
    (result.digest !== null) === (progress.phase === 'delivered'),
    'Acquisition result completion differs from delivery',
    'unavailable'
  )
  return {
    format: value.format,
    originalDigest: outputHex32(value.originalDigest),
    progress,
    material,
    result
  }
}
export function createPrivateAcquisitionState(
  original: PrivateAcquisitionOriginal,
  material: PrivateAcquisitionPayload,
  result: PrivateAcquisitionPayload,
  now: string,
  supportedExtensions: readonly string[] = []
): PrivateAcquisitionState {
  return parsePrivateAcquisitionState(
    {
      format: 'private-acquisition-state/1',
      originalDigest: originalDigest(original),
      progress: createPrivateAcquisitionProgress(
        original.request,
        original.challenge,
        { seller: original.challenge.seller, rulesDigest: original.challenge.rulesDigest },
        now,
        supportedExtensions
      ),
      material,
      result
    },
    original
  )
}
