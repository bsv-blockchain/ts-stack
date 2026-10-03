import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputString,
  outputU64,
  parseOutputJSON,
  type OutputCapabilitySelection,
  type OutputPurchasePrepare,
  type OutputPurchaseSubmit,
  type OutputReleaseEvidence,
  type STEAK
} from '@bsv/sdk'
import { parseOutputSTEAK } from '@bsv/sdk/overlay-tools/OutputObservation'
import type { PrivateAcquisitionCaller } from './PrivateAcquisitionPorts.js'
import type {
  PrivatePurchasePreparationTerms,
  PrivatePurchaseOriginal
} from './PrivatePurchaseContracts.js'
import type { PrivatePurchaseProgress } from './PrivatePurchaseProgress.js'
import type { PrivatePurchaseCustody } from './SQLitePrivatePurchaseStore.js'
import type { ProtectedLedgerGuard } from './ProtectedLedgerCodec.js'
import type { PrivateReleaseAssessment } from './SDKPrivateReleaseEvidence.js'

export type PrivatePurchaseCaller = PrivateAcquisitionCaller
export interface PrivatePurchasePreparation {
  terms: PrivatePurchasePreparationTerms
  schema: string
  maximumSecretBytes: number
  material: string
}
/** A local installed verifier supplies this synchronous same-context guard.
 * It is never a verdict accepted from an HTTP request or a catalogue report.
 */
export interface PrivatePurchaseValidation {
  checkCurrent(): void
}
export interface PrivatePurchaseDomain {
  /** Independently validate listing authority, complete Bitcoin/domain evidence
   * and private readiness before promising the original bounded material.
   */
  prepare(
    request: OutputPurchasePrepare,
    selection: OutputCapabilitySelection,
    signal: AbortSignal
  ): Promise<{ preparation: PrivatePurchasePreparation; validation: PrivatePurchaseValidation }>
  /** Verify complete candidate Script/lineage/domain and exact original
   * acquisition/request/recipient binding before any external-effect reservation.
   */
  verify(
    candidate: OutputPurchaseSubmit,
    custody: PrivatePurchaseCustody,
    signal: AbortSignal
  ): Promise<PrivatePurchaseValidation>
  /** Catalogue withdrawal must not discard an already retained obligation. */
  isCurrent(original: PrivatePurchaseOriginal): boolean
  /** Pure/idempotent issuance from the retained accepted right; no new payment. */
  issue(
    custody: PrivatePurchaseCustody,
    progress: PrivatePurchaseProgress,
    releaseEvidence: OutputReleaseEvidence,
    signal: AbortSignal
  ): Promise<string>
}
export interface PrivatePurchaseAccessPort {
  /** Recipient ownership and current policy share the native writer/disclosure gate. */
  guard(
    acquisitionId: string,
    buyer: string,
    current: () => boolean,
    initial?: OutputPurchasePrepare
  ): ProtectedLedgerGuard
}
export interface PrivatePurchaseAdmissionJob {
  operationId: string
  original: PrivatePurchaseOriginal
  candidate: OutputPurchaseSubmit
}
export type PrivatePurchaseAdmissionOutcome =
  | { status: 'unresolved'; operationId: string; txid: string }
  | {
      status: 'admitted'
      operationId: string
      txid: string
      steak: STEAK
      acceptedAt: string
      assessmentContextId: string
    }
  | {
      status: 'rejected'
      operationId: string
      txid: string
      reason: string
      evidence: string
    }
export interface PrivatePurchaseAdmission {
  /** Consult actual retained topic history before any replay of this exact job.
   * An unknown call outcome is unresolved, not a definitive local rejection.
   */
  recover(
    job: PrivatePurchaseAdmissionJob,
    signal: AbortSignal,
    context: { checkCurrent(): void }
  ): Promise<PrivatePurchaseAdmissionOutcome>
}
export interface PrivatePurchaseRelease {
  /** Undefined leaves the durable admitted obligation pending without issuing a secret. */
  assess(
    custody: PrivatePurchaseCustody,
    progress: PrivatePurchaseProgress,
    candidate: OutputPurchaseSubmit,
    signal: AbortSignal
  ): Promise<PrivateReleaseAssessment | undefined>
}

export function ownPrivatePurchasePreparation(input: unknown): PrivatePurchasePreparation {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 4194304 }), { bytes: 4194304 })
  closedOutputObject(value, ['terms', 'schema', 'maximumSecretBytes', 'material'])
  closedOutputObject(value.terms, [
    'domainEvidence',
    'purchaseUntil',
    'creationCutoff',
    'minimumRecoverySeconds'
  ])
  closedOutputObject(value.terms.domainEvidence, ['schema', 'bytes'])
  outputAssert(typeof value.material === 'string', 'Purchase material must be encoded bytes')
  decodeOutputBytes(value.material, 4194304)
  outputAssert(
    typeof value.maximumSecretBytes === 'number' &&
      Number.isSafeInteger(value.maximumSecretBytes) &&
      value.maximumSecretBytes > 0 &&
      value.maximumSecretBytes <= 4194304,
    'Invalid purchase secret allowance'
  )
  const schema = outputString(value.schema)
  outputAssert(
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(schema),
    'Purchase secret schema requires an absolute IRI'
  )
  // The contract owns and validates every term before it is signed.
  return {
    terms: value.terms as unknown as PrivatePurchasePreparationTerms,
    schema,
    maximumSecretBytes: value.maximumSecretBytes,
    material: value.material
  }
}

export function ownPrivatePurchaseAdmissionOutcome(
  input: unknown
): PrivatePurchaseAdmissionOutcome {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 131072 }), { bytes: 131072 })
  const common = ['status', 'operationId', 'txid']
  closedOutputObject(value, common, [
    'steak',
    'acceptedAt',
    'assessmentContextId',
    'reason',
    'evidence'
  ])
  const operationId = outputHex32(value.operationId),
    txid = outputHex32(value.txid)
  if (value.status === 'unresolved') {
    closedOutputObject(value, common)
    return { status: 'unresolved', operationId, txid }
  }
  if (value.status === 'admitted') {
    closedOutputObject(value, [...common, 'steak', 'acceptedAt', 'assessmentContextId'])
    return {
      status: 'admitted',
      operationId,
      txid,
      steak: parseOutputSTEAK(value.steak),
      acceptedAt: outputU64(value.acceptedAt).toString(),
      assessmentContextId: outputString(value.assessmentContextId)
    }
  }
  outputAssert(value.status === 'rejected', 'Unsupported purchase admission outcome', 'unsupported')
  closedOutputObject(value, [...common, 'reason', 'evidence'])
  outputAssert(
    typeof value.evidence === 'string',
    'Purchase rejection evidence must be encoded bytes'
  )
  decodeOutputBytes(value.evidence, 65536)
  return {
    status: 'rejected',
    operationId,
    txid,
    reason: outputString(value.reason),
    evidence: value.evidence
  }
}
