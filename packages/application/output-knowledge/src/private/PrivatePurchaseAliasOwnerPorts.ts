import type {
  OutputPurchaseEnvelope,
  OutputPurchaseSubmit,
  OutputSignedPurchaseTerms
} from '@bsv/sdk'
import type { PrivatePurchaseContracts } from './PrivatePurchaseContracts.js'
import type { PrivatePurchaseProgress } from './PrivatePurchaseProgress.js'
import type {
  PrivatePurchaseCustody,
  PrivatePurchaseStoreLimits
} from './SQLitePrivatePurchaseStore.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type { ProtectedLedgerGuard, ProtectedLedgerRecord } from './ProtectedLedgerCodec.js'
import type { PrivatePurchaseAliasPlacement } from './PrivatePurchaseAliasState.js'
import type {
  PrivatePurchaseAliasSnapshot,
  PrivatePurchaseAliasWrite
} from './SQLitePrivatePurchaseAliases.js'

/** Explicit owner installation. Historical native owners and formats remain
 * unchanged. This interface does not itself qualify a purchase domain, a chain
 * view, topical admission or an HTTP disclosure implementation. */
export interface PrivatePurchaseAliasOwnerInstallation {
  domain: PrivateServiceDomain
  contracts: PrivatePurchaseContracts
  limits: PrivatePurchaseStoreLimits
  policy: PrivatePurchaseCustody['validationPolicy']
  /** Every pending selection consumes prepaid capacity while leaving the first
   * signed-result completion available. Exhaustion cannot discard an obligation. */
  maximumSelections: number
}

export interface PrivatePurchaseAliasedState {
  format: 'private-purchase-state/3'
  clockProfile: 'native-observation-v1'
  candidateProfile: 'full-purchase-commitment-v1'
  recipient: string
  /** Immutable native first financial reservation time, not a block time. */
  firstReservedAt: string | null
  /** Pending selection is separate from the immutable first raw candidate. */
  selectedTxid: string | null
  /** Prepared state until issuance; completed historical progress thereafter.
   * Pending public progress is derived from actual per-txid admission custody. */
  progress: PrivatePurchaseProgress
  original: import('./PrivateAcquisitionPayloads.js').PrivateAcquisitionPayload
  result: import('./PrivateAcquisitionPayloads.js').PrivateAcquisitionPayload
}

export interface PrivatePurchaseAliasedLoaded {
  revision: string
  observedAt: string
  row: ProtectedLedgerRecord
  custody: PrivatePurchaseCustody
  state: PrivatePurchaseAliasedState
  aliases: PrivatePurchaseAliasSnapshot
  /** Fresh SAME-ledger selected progress or immutable completed history. */
  progress: PrivatePurchaseProgress
  candidate: OutputPurchaseSubmit | null
}

/** The coordinator obtains every verification and selected-chain guard from
 * installed independent verifiers. The native owner commits exact evidence and
 * effects under those guards; it never accepts a remotely supplied verdict. */
export interface PrivatePurchaseAliasOwner {
  installedOn(domain: PrivateServiceDomain, contracts: PrivatePurchaseContracts): void
  load(
    id: string,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded | undefined
  /** Prepay alias roles, material and complete result capacity before returning
   * signed terms. A partial local reservation grants no financial authority. */
  prepare(
    custody: PrivatePurchaseCustody,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded
  /** Commit the first economic identity/native time and alias contribution in
   * ONE writer. Later selections preserve original bytes and pending jobs. The
   * caller must independently verify the planner's cumulative candidate too. */
  retain(
    loaded: PrivatePurchaseAliasedLoaded,
    write: Extract<PrivatePurchaseAliasWrite, { status: 'ready' }>,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    combined: import('./PrivatePurchasePorts.js').PrivatePurchaseValidation
  ): PrivatePurchaseAliasedLoaded
  /** The historical copy and first complete signed result share ONE writer.
   * Compare the complete loaded native head before that write. The guard
   * authenticates the caller/domain both before the effect and on fresh
   * readback; an old alias snapshot fence is deliberately invalid after this
   * owner's successful write. A mined first release additionally needs actual
   * selected-chain placement. */
  complete(
    loaded: PrivatePurchaseAliasedLoaded,
    envelope: OutputPurchaseEnvelope,
    placement: PrivatePurchaseAliasPlacement | undefined,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded
  /** Retain a terminal local decision and its exact raw candidate atomically.
   * No POTATOES or historical-release slot; transient failures never call this. */
  fail(
    loaded: PrivatePurchaseAliasedLoaded,
    decision: { reason: string; evidence: string },
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded
  disclose(
    loaded: PrivatePurchaseAliasedLoaded,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    send: (envelope: OutputPurchaseEnvelope) => void
  ): void
  discloseTerms(
    loaded: PrivatePurchaseAliasedLoaded,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    send: (terms: OutputSignedPurchaseTerms) => void
  ): void
}
