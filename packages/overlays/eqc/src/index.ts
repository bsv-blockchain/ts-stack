export { canonicalJson } from './protocol/canonicalJson.js'
export {
  DEFAULTS,
  ECONOMIC_PATHS,
  MAX_RANKED_HOSTS,
  computeQueryId,
  validateQuery,
  type EconomicQuery
} from './protocol/query.js'
export { computePayouts, fibonacciWeights, sumOfWeights } from './protocol/fibonacci.js'
export {
  canonicalizeLookupAnswer,
  compareCodePoints,
  contentHash,
  decodeMessageList,
  decodeOutpointList,
  encodeMessageList,
  encodeOutpointList,
  rebuildLookupAnswer,
  type CanonicalMessage,
  type LookupOutpoint
} from './protocol/payloads.js'
export {
  attestationPreimage,
  deliveryPreimage,
  parseAttestation,
  parseDelivery,
  verifyAttestation,
  verifyDelivery,
  type Attestation,
  type Delivery,
  type SignedFields,
  type TopicAnchor,
  type Verdict
} from './protocol/attestation.js'
export { signBRC77, verifyBRC77 } from './protocol/brc77.js'
export { isCanonicalBase64 } from './protocol/encoding.js'
export { EQCError, type EQCErrorCode } from './protocol/errors.js'
export {
  BRC29_PROTOCOL_ID,
  derivationPrefix,
  derivationSuffix,
  parsePaymentEnvelope,
  paymentEnvelope,
  payoutLockingScript,
  type PaymentEnvelope
} from './protocol/payment.js'
export { parseHostParams, type HostParams } from './protocol/params.js'
export {
  assessConsistency,
  classifyMinority,
  type ConsistencyStatus,
  type TopicConsistency
} from './client/consistency.js'
export {
  decideRace,
  runRace,
  type Arrival,
  type HashGroup,
  type RaceOutcome,
  type RaceResult,
  type RaceTask,
  type Rejection,
  type RejectionReason
} from './client/race.js'
