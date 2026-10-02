import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputString,
  outputPrivatePublicationRequestDigest,
  parseOutputJSON,
  parseOutputPrivatePublish,
  Transaction,
  Utils,
  type OutputRetainedCapability,
  type OutputPrivatePublish
} from '@bsv/sdk'
import type { VerificationContext } from '../ports.js'
import { parseVerificationContext } from '../validation.js'
import type { PrivatePublicationContracts } from './PrivatePublicationContracts.js'
import {
  parsePrivatePublicationProgress,
  type PrivatePublicationProgress
} from './PrivatePublicationProgress.js'

export interface PrivatePublicationContractRecord {
  format: 'private-publication-contract/1'
  publicationId: string
  requestDigest: string
  rawTransaction: string
  capability: OutputRetainedCapability
  verificationContext: VerificationContext
  /** Identifies immutable installed publisher/schema validation, not remote executable code. */
  validationPolicy: { id: string; digest: string }
}

/** Protected original metadata only; this does not prove private material is available. */
function parseOriginal(
  input: unknown,
  state: PrivatePublicationProgress,
  reference: Omit<OutputPrivatePublish, 'privateValues'>,
  contracts: PrivatePublicationContracts,
  policy: { id: string; digest: string },
  supportedExtensions: readonly string[] = []
) {
  state = parsePrivatePublicationProgress(state)
  const request = parseOutputPrivatePublish(
    { ...reference, privateValues: '' },
    supportedExtensions
  )
  const expectedPolicy = parseOutputJSON(canonicalOutputJSON(policy, { bytes: 4096 }))
  closedOutputObject(expectedPolicy, ['id', 'digest'])
  policy = {
    id: outputString(expectedPolicy.id),
    digest: outputHex32(expectedPolicy.digest)
  }
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 1048576 }))
  closedOutputObject(value, [
    'format',
    'publicationId',
    'requestDigest',
    'rawTransaction',
    'capability',
    'verificationContext',
    'validationPolicy'
  ])
  outputAssert(
    value.format === 'private-publication-contract/1',
    'Unsupported private publication contract',
    'unsupported'
  )
  closedOutputObject(value.validationPolicy, ['id', 'digest'])
  const validationPolicy = {
    id: outputString(value.validationPolicy.id),
    digest: outputHex32(value.validationPolicy.digest)
  }
  outputAssert(
    validationPolicy.id === policy.id && validationPolicy.digest === policy.digest,
    'Private publication validation policy changed',
    'context-changed'
  )
  const selection = contracts.restore(value.capability),
    installation = contracts.configuration()
  const verificationContext = parseVerificationContext(value.verificationContext)
  const raw = decodeOutputBytes(value.rawTransaction),
    tx = Transaction.fromBinary(raw)
  outputAssert(
    Utils.toBase64(tx.toBinary()) === value.rawTransaction,
    'Private publication raw transaction encoding differs',
    'unavailable'
  )
  const parameters = selection.profile.parameters as {
    maxPrivateBytes: number
    schemas: string[]
  }
  outputAssert(
    value.publicationId === state.publicationId &&
      value.requestDigest === state.requestDigest &&
      state.topic === installation.topic &&
      request.topic === installation.topic &&
      canonicalOutputJSON(state.chain) === canonicalOutputJSON(installation.chain) &&
      canonicalOutputJSON(verificationContext.view.chain) ===
        canonicalOutputJSON(installation.chain) &&
      tx.id('hex') === state.txid &&
      request.evidence.txid === state.txid &&
      request.evidence.outputIndex === state.outputIndex &&
      state.outputIndex < tx.outputs.length,
    'Private publication original contract binding differs',
    'unavailable'
  )
  outputAssert(
    parameters.schemas.includes(request.schema),
    'Private publication schema is absent from original contract',
    'unsupported'
  )
  const record: PrivatePublicationContractRecord = {
    format: value.format,
    publicationId: outputHex32(value.publicationId),
    requestDigest: outputHex32(value.requestDigest),
    rawTransaction: Utils.toBase64(tx.toBinary()),
    capability: value.capability as unknown as OutputRetainedCapability,
    verificationContext,
    validationPolicy
  }
  return { record, selection }
}

/** Protected original metadata only; no renewed private-byte availability assertion. */
export function parsePrivatePublicationContractMetadata(
  input: unknown,
  state: PrivatePublicationProgress,
  reference: Omit<OutputPrivatePublish, 'privateValues'>,
  contracts: PrivatePublicationContracts,
  policy: { id: string; digest: string },
  supportedExtensions: readonly string[] = []
): PrivatePublicationContractRecord {
  return parseOriginal(input, state, reference, contracts, policy, supportedExtensions).record
}

/** Full protected relation; checked separately from metadata-only status recovery. */
export function parsePrivatePublicationContractRecord(
  input: unknown,
  state: PrivatePublicationProgress,
  request: OutputPrivatePublish,
  contracts: PrivatePublicationContracts,
  policy: { id: string; digest: string },
  supportedExtensions: readonly string[] = []
): PrivatePublicationContractRecord {
  request = parseOutputPrivatePublish(request, supportedExtensions)
  const { privateValues, ...reference } = request
  const { record, selection } = parseOriginal(
    input,
    state,
    reference,
    contracts,
    policy,
    supportedExtensions
  )
  outputAssert(
    record.requestDigest === outputPrivatePublicationRequestDigest(request, supportedExtensions),
    'Private publication original contract binding differs',
    'unavailable'
  )
  const parameters = selection.profile.parameters as { maxPrivateBytes: number }
  outputAssert(
    decodeOutputBytes(privateValues).length <= parameters.maxPrivateBytes,
    'Private publication exceeds original private capacity',
    'limited'
  )
  canonicalOutputJSON(request, { bytes: selection.profile.maxRequestBytes })
  return record
}
