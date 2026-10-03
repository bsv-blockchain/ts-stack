import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputString,
  outputU64,
  parseOutputEvidence,
  parseOutputJSON,
  type OutputCapabilitySelection,
  type OutputEvidence,
  type OutputPaidLookupAcquire
} from '@bsv/sdk'
import { parseVerificationContext } from '../validation.js'
import type { VerificationContext } from '../ports.js'
import type { PrivateAcquisitionQuoteTerms } from './PrivateAcquisitionContracts.js'
import type { PrivateAcquisitionOriginal } from './PrivateAcquisitionRecords.js'
import type { PrivateAcquisitionProgress } from './PrivateAcquisitionProgress.js'
import type { VerifiedPrivateAcquisitionFunding } from './SDKPrivateAcquisitionFunding.js'
import type { PrivateReleaseAssessment } from './SDKPrivateReleaseEvidence.js'

export interface PrivateAcquisitionCaller {
  buyer: string
  capability: string
  profile: string
  current(): boolean
  signal?: AbortSignal
}
export interface PrivateAcquisitionPreparation {
  terms: PrivateAcquisitionQuoteTerms
  evidence: OutputEvidence
  verificationContext: VerificationContext
  schema: string
  maximumContextBytes: number
  maximumAcceptanceBytes: number
  material: string
}
/** Installed domain implementation, not a verdict accepted from a remote caller. */
export interface PrivateAcquisitionDomain {
  prepare(
    request: OutputPaidLookupAcquire,
    selection: OutputCapabilitySelection,
    signal: AbortSignal
  ): Promise<PrivateAcquisitionPreparation>
  /** Check the domain's asset/terms/key binding after actual listing Script/SPV verification. */
  validate(
    request: OutputPaidLookupAcquire,
    preparation: PrivateAcquisitionPreparation,
    signal: AbortSignal
  ): Promise<void>
  /** Retained obligations remain valid after catalogue withdrawal; do not re-price here. */
  isCurrent(original: PrivateAcquisitionOriginal): boolean
  /** Pure/idempotent issuance from retained material and the accepted right. No new charge. */
  issue(
    original: PrivateAcquisitionOriginal,
    progress: PrivateAcquisitionProgress,
    material: string,
    signal: AbortSignal
  ): Promise<string>
}
export interface PrivateAcquisitionRelease {
  /** Undefined means the selected policy is unresolved; it never reserves a wallet effect. */
  assess(
    original: PrivateAcquisitionOriginal,
    progress: PrivateAcquisitionProgress,
    funding: VerifiedPrivateAcquisitionFunding,
    signal: AbortSignal
  ): Promise<PrivateReleaseAssessment | undefined>
}

/** Own a local preparation without widening the SDK network JSON ceiling. */
export function ownPrivateAcquisitionPreparation(
  input: PrivateAcquisitionPreparation
): PrivateAcquisitionPreparation {
  outputAssert(
    input !== null &&
      typeof input === 'object' &&
      Object.getPrototypeOf(input) === Object.prototype,
    'Acquisition preparation must be a plain record'
  )
  const names = [
    'terms',
    'evidence',
    'verificationContext',
    'schema',
    'maximumContextBytes',
    'maximumAcceptanceBytes',
    'material'
  ]
  const keys = Reflect.ownKeys(input)
  outputAssert(
    keys.length === names.length &&
      keys.every(key => typeof key === 'string' && names.includes(key)),
    'Acquisition preparation fields differ'
  )
  const metadata: Record<string, unknown> = {}
  let material: unknown
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)
    outputAssert(
      descriptor && Object.hasOwn(descriptor, 'value') && descriptor.enumerable,
      'Acquisition preparation must contain owned data'
    )
    if (key === 'material') material = descriptor.value
    else metadata[key] = descriptor.value
  }
  outputAssert(typeof material === 'string', 'Acquisition material must be encoded bytes')
  decodeOutputBytes(material, 4194304)
  const owned = parseOutputJSON(canonicalOutputJSON(metadata))
  closedOutputObject(
    owned,
    names.filter(name => name !== 'material')
  )
  closedOutputObject(owned.terms, [
    'satoshis',
    'derivationPrefix',
    'payableUntil',
    'creationCutoff',
    'minimumRecoverySeconds'
  ])
  const terms = owned.terms
  outputAssert(
    typeof terms.derivationPrefix === 'string',
    'Acquisition prefix must be encoded bytes'
  )
  decodeOutputBytes(terms.derivationPrefix, 256)
  const contextBytes = owned.maximumContextBytes,
    acceptanceBytes = owned.maximumAcceptanceBytes
  outputAssert(
    typeof contextBytes === 'number' &&
      Number.isSafeInteger(contextBytes) &&
      contextBytes > 0 &&
      contextBytes <= 4194304,
    'Invalid acquisition context allowance'
  )
  outputAssert(
    typeof acceptanceBytes === 'number' &&
      Number.isSafeInteger(acceptanceBytes) &&
      acceptanceBytes > 0 &&
      acceptanceBytes <= 131072,
    'Invalid acquisition acceptance allowance'
  )
  return {
    terms: {
      satoshis: outputU64(terms.satoshis).toString(),
      derivationPrefix: terms.derivationPrefix,
      payableUntil: outputU64(terms.payableUntil).toString(),
      creationCutoff: outputU64(terms.creationCutoff).toString(),
      minimumRecoverySeconds: outputU64(terms.minimumRecoverySeconds).toString()
    },
    evidence: parseOutputEvidence(owned.evidence),
    verificationContext: parseVerificationContext(owned.verificationContext),
    schema: outputString(owned.schema),
    maximumContextBytes: contextBytes,
    maximumAcceptanceBytes: acceptanceBytes,
    material
  }
}
