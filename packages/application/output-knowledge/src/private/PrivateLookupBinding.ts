import {
  ownOutputJSON,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputString
} from '@bsv/sdk'
import { parseOutputSTEAK } from '@bsv/sdk/overlay-tools/OutputObservation'
import type { PrivateServiceIdentity } from './PrivateServiceIdentity.js'
import {
  parsePrivatePublicationBlob,
  privatePublicationBlobAddress,
  type PrivatePublicationBlob
} from './PrivatePublicationRecords.js'
import {
  parsePrivatePublicationProgress,
  type PrivatePublicationProgress
} from './PrivatePublicationProgress.js'
import { protectedDigest } from './ProtectedLedgerCodec.js'

type Admission = {
  txid: string
  assessmentContextId: string
  steak: ReturnType<typeof parseOutputSTEAK>
}
export type PrivateLookupBinding = {
  format: 'private-lookup-binding/1'
  blobKey: string
  binding: PrivatePublicationBlob['binding']
  lookup: { service: string; rulesDigest: string }
} & ({ phase: 'reserved' } | { phase: 'active'; admission: Admission })

/** Local plans only; callers must physically reserve and commit before readiness. */
export function createPrivateLookupBinding(
  input: PrivatePublicationBlob,
  selected: { service: string; rulesDigest: string },
  identity: PrivateServiceIdentity
): PrivateLookupBinding {
  const blob = parsePrivatePublicationBlob(input)
  const choice = ownOutputJSON(selected, { bytes: 4096 }).value
  closedOutputObject(choice, ['service', 'rulesDigest'])
  return {
    format: 'private-lookup-binding/1',
    blobKey: privatePublicationBlobAddress(identity, blob.binding).key,
    binding: blob.binding,
    lookup: {
      service: outputString(choice.service),
      rulesDigest: outputHex32(choice.rulesDigest)
    },
    phase: 'reserved'
  }
}

export function privateLookupBindingAddress(
  identity: PrivateServiceIdentity,
  value: Pick<PrivateLookupBinding, 'blobKey' | 'lookup'>
) {
  const lookup = ownOutputJSON(value.lookup, { bytes: 4096 }).value
  closedOutputObject(lookup, ['service', 'rulesDigest'])
  return identity.address('publication', {
    purpose: 'private-lookup-binding',
    blobKey: outputHex32(value.blobKey),
    service: outputString(lookup.service),
    rulesDigest: outputHex32(lookup.rulesDigest)
  })
}

/** Protected local metadata is checked against the actual exact shared blob. */
export function parsePrivateLookupBinding(
  input: unknown,
  blob: PrivatePublicationBlob,
  identity: PrivateServiceIdentity
): PrivateLookupBinding {
  const value = ownOutputJSON(input, { bytes: 65536 }).value
  closedOutputObject(value, ['format', 'blobKey', 'binding', 'lookup', 'phase'], ['admission'])
  outputAssert(
    value.format === 'private-lookup-binding/1',
    'Unsupported private lookup binding',
    'unsupported'
  )
  const expected = createPrivateLookupBinding(
    blob,
    value.lookup as unknown as PrivateLookupBinding['lookup'],
    identity
  )
  outputAssert(
    value.blobKey === expected.blobKey &&
      canonicalOutputJSON(value.binding) === canonicalOutputJSON(expected.binding),
    'Private lookup blob binding differs',
    'unavailable'
  )
  if (value.phase === 'reserved') {
    outputAssert(value.admission === undefined, 'Reserved private lookup has admission evidence')
    return expected
  }
  outputAssert(value.phase === 'active', 'Unknown private lookup binding phase')
  closedOutputObject(value.admission, ['txid', 'assessmentContextId', 'steak'])
  const admission = {
    txid: outputHex32(value.admission.txid),
    assessmentContextId: outputString(value.admission.assessmentContextId),
    steak: parseOutputSTEAK(value.admission.steak)
  }
  outputAssert(
    admission.txid === expected.binding.txid &&
      Object.keys(admission.steak).length === 1 &&
      Object.hasOwn(admission.steak, expected.binding.topic) &&
      admission.steak[expected.binding.topic].outputsToAdmit.includes(expected.binding.outputIndex),
    'Private lookup admission does not bind the selected output',
    'unavailable'
  )
  return { ...expected, phase: 'active', admission }
}

export function activatePrivateLookupBinding(
  input: PrivateLookupBinding,
  progress: PrivatePublicationProgress,
  blob: PrivatePublicationBlob,
  identity: PrivateServiceIdentity
): PrivateLookupBinding {
  const state = parsePrivatePublicationProgress(progress)
  const binding = parsePrivateLookupBinding(input, blob, identity)
  requirePublicationBinding(binding, state)
  outputAssert(
    state.progress.phase === 'binding',
    'Publication is not awaiting lookup binding',
    'conflict'
  )
  const original = state.progress.admission
  const admission = {
    txid: original.txid,
    assessmentContextId: original.assessmentContextId,
    steak: original.steak
  }
  if (binding.phase === 'active') {
    outputAssert(
      canonicalOutputJSON(binding.admission) === canonicalOutputJSON(admission),
      'Private lookup original admission differs',
      'conflict'
    )
    return binding
  }
  return parsePrivateLookupBinding({ ...binding, phase: 'active', admission }, blob, identity)
}

export function privateLookupBindingReceipt(
  input: PrivateLookupBinding,
  progress: PrivatePublicationProgress,
  blob: PrivatePublicationBlob,
  identity: PrivateServiceIdentity
) {
  const state = parsePrivatePublicationProgress(progress),
    binding = parsePrivateLookupBinding(input, blob, identity)
  requirePublicationBinding(binding, state)
  outputAssert(binding.phase === 'active', 'Private lookup binding is not active', 'unavailable')
  outputAssert(
    'admission' in state.progress,
    'Publication has no retained lookup admission',
    'conflict'
  )
  const original = state.progress.admission
  outputAssert(
    canonicalOutputJSON(binding.admission) ===
      canonicalOutputJSON({
        txid: original.txid,
        assessmentContextId: original.assessmentContextId,
        steak: original.steak
      }),
    'Private lookup receipt admission differs',
    'conflict'
  )
  const receipt = {
    publicationId: state.publicationId,
    requestDigest: state.requestDigest,
    blobKey: state.blobKey,
    ...state.lookup
  }
  return {
    ...receipt,
    receiptDigest: protectedDigest(
      canonicalOutputJSON({
        format: 'private-lookup-binding-receipt/1',
        binding,
        publication: receipt
      })
    )
  }
}

function requirePublicationBinding(
  binding: PrivateLookupBinding,
  state: PrivatePublicationProgress
): void {
  outputAssert(
    binding.blobKey === state.blobKey &&
      binding.lookup.service === state.lookup.service &&
      binding.lookup.rulesDigest === state.lookup.rulesDigest &&
      canonicalOutputJSON(binding.binding.chain) === canonicalOutputJSON(state.chain) &&
      binding.binding.topic === state.topic &&
      binding.binding.txid === state.txid &&
      binding.binding.outputIndex === state.outputIndex,
    'Private lookup binding differs from publication',
    'conflict'
  )
}
