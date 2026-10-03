import {
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputString,
  outputU32,
  outputPacketDigest,
  outputPrivatePublicationRequestDigest,
  parseOutputChain,
  parseOutputJSON,
  parseOutputPrivatePublish,
  decodeOutputBytes,
  type OutputChain,
  type OutputJSONObject,
  type OutputPrivatePublish
} from '@bsv/sdk'
import { PrivateServiceIdentity } from './PrivateServiceIdentity.js'
import {
  createPrivatePublicationProgress,
  parsePrivatePublicationProgress,
  type PrivatePublicationProgress
} from './PrivatePublicationProgress.js'

type Reference = Omit<OutputPrivatePublish, 'privateValues'>
export interface PrivatePublicationBlob {
  format: 'private-publication-blob/1'
  binding: {
    chain: OutputChain
    topic: string
    txid: string
    outputIndex: number
    assetId: string
    schema: string
  }
  privateValues: string
}
export type PrivatePublicationFence = {
  reference: Reference
  state: PrivatePublicationProgress
} & (
  | { format: 'private-publication-fence/1'; original?: never }
  | { format: 'private-publication-fence/2'; original: OutputJSONObject }
)
function blobBinding(request: Reference, chain: OutputChain): PrivatePublicationBlob['binding'] {
  return {
    chain,
    topic: request.topic,
    txid: request.evidence.txid,
    outputIndex: request.evidence.outputIndex,
    assetId: request.assetId,
    schema: request.schema
  }
}
export function privatePublicationBlobAddress(
  identity: PrivateServiceIdentity,
  binding: PrivatePublicationBlob['binding']
) {
  return identity.address('publication', {
    purpose: 'private-publication-blob',
    ...binding,
    chain: { ...binding.chain }
  })
}
export function privatePublicationFenceAddress(
  identity: PrivateServiceIdentity,
  publicationId: string
) {
  return identity.address('request-fence', {
    purpose: 'private-publication',
    publicationId: outputHex32(publicationId)
  })
}

/** Internal owned records, still requiring publisher/schema/Bitcoin verification before reservation. */
export function createPrivatePublicationRecords(
  input: unknown,
  identity: PrivateServiceIdentity,
  selected: {
    publisher: string
    chain: OutputChain
    lookup: { service: string; rulesDigest: string }
  },
  now: string,
  stagedUntil: string,
  supportedExtensions: readonly string[] = []
): { blob: PrivatePublicationBlob; fence: PrivatePublicationFence } {
  const request = parseOutputPrivatePublish(input, supportedExtensions)
  const choice = parseOutputJSON(canonicalOutputJSON(selected, { bytes: 16384 }))
  closedOutputObject(choice, ['publisher', 'chain', 'lookup'])
  closedOutputObject(choice.lookup, ['service', 'rulesDigest'])
  const owned = {
    publisher: outputString(choice.publisher),
    chain: parseOutputChain(choice.chain),
    lookup: {
      service: outputString(choice.lookup.service),
      rulesDigest: outputHex32(choice.lookup.rulesDigest)
    }
  }
  const { privateValues, ...reference } = request
  const binding = blobBinding(request, owned.chain)
  const blob: PrivatePublicationBlob = {
    format: 'private-publication-blob/1',
    binding,
    privateValues
  }
  const state = createPrivatePublicationProgress(
    request,
    {
      ...owned,
      chain: binding.chain,
      blobKey: privatePublicationBlobAddress(identity, binding).key
    },
    now,
    stagedUntil,
    supportedExtensions
  )
  return {
    blob,
    fence: { format: 'private-publication-fence/1', reference, state }
  }
}

export function parsePrivatePublicationBlob(input: unknown): PrivatePublicationBlob {
  const blob = parseOutputJSON(canonicalOutputJSON(input, { bytes: 2 * 1024 * 1024 }))
  closedOutputObject(blob, ['format', 'binding', 'privateValues'])
  outputAssert(
    blob.format === 'private-publication-blob/1',
    'Unsupported private publication blob',
    'unsupported'
  )
  closedOutputObject(blob.binding, ['chain', 'topic', 'txid', 'outputIndex', 'assetId', 'schema'])
  const bytes = decodeOutputBytes(blob.privateValues)
  outputAssert(bytes.length <= 1048576, 'Private publication payload exceeds 1 MiB', 'limited')
  return {
    format: blob.format,
    binding: {
      chain: parseOutputChain(blob.binding.chain),
      topic: outputString(blob.binding.topic),
      txid: outputHex32(blob.binding.txid),
      outputIndex: outputU32(blob.binding.outputIndex),
      assetId: outputHex32(blob.binding.assetId),
      schema: outputString(blob.binding.schema)
    },
    privateValues: blob.privateValues as string
  }
}

/** Protected metadata only; this does not prove private bytes or current readiness. */
export function parsePrivatePublicationFenceMetadata(
  fenceInput: unknown,
  identity: PrivateServiceIdentity,
  supportedExtensions: readonly string[] = []
): PrivatePublicationFence {
  const value = parseOutputJSON(canonicalOutputJSON(fenceInput, { bytes: 2 * 1024 * 1024 }))
  closedOutputObject(value, ['format', 'reference', 'state'], ['original'])
  outputAssert(
    value.format === 'private-publication-fence/1' ||
      value.format === 'private-publication-fence/2',
    'Unsupported private publication fence',
    'unsupported'
  )
  if (value.format === 'private-publication-fence/1') {
    outputAssert(
      value.original === undefined,
      'Legacy private publication cannot contain original service context'
    )
  } else {
    outputAssert(
      value.original !== null &&
        typeof value.original === 'object' &&
        !Array.isArray(value.original),
      'Private publication original service context is missing',
      'unavailable'
    )
    canonicalOutputJSON(value.original, { bytes: 1048576 })
  }
  closedOutputObject(
    value.reference,
    ['version', 'requestId', 'topic', 'evidence', 'assetId', 'schema'],
    ['extensions', 'critical']
  )
  const { privateValues: _unused, ...reference } = parseOutputPrivatePublish(
    { ...value.reference, privateValues: '' },
    supportedExtensions
  )
  const state = parsePrivatePublicationProgress(value.state)
  outputAssert(
    state.publicationId ===
      outputPacketDigest('private-publication', {
        chain: state.chain,
        publisher: state.publisher,
        topic: reference.topic,
        requestId: reference.requestId
      }) &&
      state.blobKey ===
        privatePublicationBlobAddress(identity, blobBinding(reference, state.chain)).key &&
      state.topic === reference.topic &&
      state.txid === reference.evidence.txid &&
      state.outputIndex === reference.evidence.outputIndex,
    'Private publication retained binding differs',
    'unavailable'
  )
  return value.format === 'private-publication-fence/1'
    ? { format: value.format, reference, state }
    : { format: value.format, reference, state, original: value.original as OutputJSONObject }
}

/** Validate the complete retained relation, not a status flag in isolation. */
export function parsePrivatePublicationRecords(
  fenceInput: unknown,
  blobInput: unknown,
  identity: PrivateServiceIdentity,
  supportedExtensions: readonly string[] = []
): { blob: PrivatePublicationBlob; fence: PrivatePublicationFence; request: OutputPrivatePublish } {
  const fence = parsePrivatePublicationFenceMetadata(fenceInput, identity, supportedExtensions)
  const blob = parsePrivatePublicationBlob(blobInput)
  const request = parseOutputPrivatePublish(
    { ...fence.reference, privateValues: blob.privateValues },
    supportedExtensions
  )
  outputAssert(
    canonicalOutputJSON(blob.binding) ===
      canonicalOutputJSON(blobBinding(request, fence.state.chain)) &&
      fence.state.requestDigest ===
        outputPrivatePublicationRequestDigest(request, supportedExtensions),
    'Private publication retained binding differs',
    'unavailable'
  )
  return { blob, fence, request }
}
