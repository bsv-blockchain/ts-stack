import {
  ownOutputJSON,
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  outputU64,
  parseOutputJSON,
  parseOutputPurchaseSubmit,
  type OutputPurchaseEnvelope,
  type OutputSignedPurchaseTerms,
  type OutputPurchaseSubmit
} from '@bsv/sdk'
import {
  PrivateAcquisitionPayloads,
  parsePrivateAcquisitionPayload,
  type PrivateAcquisitionPayload
} from './PrivateAcquisitionPayloads.js'
import {
  createPrivatePurchaseProgress,
  advancePrivatePurchaseProgress,
  parsePrivatePurchaseProgress,
  privatePurchaseEnvelope,
  PRIVATE_PURCHASE_PROGRESS_BYTES,
  type PrivatePurchaseCandidateProfile,
  type PrivatePurchaseProgress,
  type PrivatePurchaseEvent
} from './PrivatePurchaseProgress.js'
import type {
  PrivatePurchaseContracts,
  PrivatePurchaseOriginal
} from './PrivatePurchaseContracts.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import {
  protectedInteger,
  protectedValue,
  type ProtectedLedgerChange,
  type ProtectedLedgerGuard,
  type ProtectedLedgerRecord,
  type ProtectedLedgerView
} from './ProtectedLedgerCodec.js'

export interface PrivatePurchaseCustody {
  format: 'private-purchase-custody/1'
  original: PrivatePurchaseOriginal
  validationPolicy: { id: string; digest: string }
  schema: string
  maximumSecretBytes: number
  material: string
}
export interface PrivatePurchaseStoreLimits {
  maximumStateBytes: number
  maximumOriginalBytes: number
  maximumCandidateBytes: number
  maximumResultBytes: number
  maximumOutcomeBytes: number
  maximumBatchBytes: number
}
export interface PrivatePurchaseState {
  format: 'private-purchase-state/1'
  clockProfile?: 'native-observation-v1'
  recipient: string
  progress: PrivatePurchaseProgress
  original: PrivateAcquisitionPayload
  candidate: PrivateAcquisitionPayload
  result: PrivateAcquisitionPayload
}
export interface PrivatePurchaseCommitmentState extends Omit<PrivatePurchaseState, 'format'> {
  format: 'private-purchase-state/2'
  candidateProfile: PrivatePurchaseCandidateProfile
}
export interface PrivatePurchaseLoaded {
  revision: string
  observedAt: string
  row: ProtectedLedgerRecord
  custody: PrivatePurchaseCustody
  progress: PrivatePurchaseProgress
  candidate: OutputPurchaseSubmit | null
  /** Internal descriptors; no private plaintext or readiness verdict. */
  state: PrivatePurchaseState
}

export interface PrivatePurchaseCommitmentLoaded extends Omit<PrivatePurchaseLoaded, 'state'> {
  state: PrivatePurchaseCommitmentState
}
type CoreLoaded<S extends PrivatePurchaseState | PrivatePurchaseCommitmentState> = Omit<
  PrivatePurchaseLoaded,
  'state'
> & {
  state: S
}
/** Either explicitly selected native owner; it does not initialize or migrate custody. */
export type PrivatePurchaseStoreOwner = PrivatePurchaseStoreCore<
  PrivatePurchaseState | PrivatePurchaseCommitmentState
>

function remaining(status: PrivatePurchaseProgress['status']): number {
  switch (status) {
    case 'prepared':
      return 3
    case 'admission-pending':
      return 2
    case 'admitted-delivery-pending':
      return 1
    default:
      return 0
  }
}
function encoded(input: unknown, maximum: number): string {
  return Buffer.from(canonicalOutputJSON(input, { bytes: maximum }), 'utf8').toString('base64')
}
function decoded(input: string, maximum: number): unknown {
  return parseOutputJSON(Uint8Array.from(decodeOutputBytes(input, maximum)), { bytes: maximum })
}
function authorize(guard: ProtectedLedgerGuard, view: ProtectedLedgerView): void {
  outputAssert(
    typeof guard === 'function' && guard.constructor.name !== 'AsyncFunction',
    'Purchase native guard must be synchronous'
  )
  const result: unknown = guard(view)
  if (result instanceof Promise) void result.catch(() => undefined)
  outputAssert(result === undefined, 'Purchase native guard must finish synchronously')
}

/**
 * Native atomic purchase custody. The coordinator independently verifies a
 * candidate before pinning and establishes actual admission/release premises.
 * These methods never treat a wire representation as a verdict. Original,
 * candidate and result completion slots are reserved before preparation leaves
 * the owner. A missing database/fence/payload is never repaired with new terms.
 */
class PrivatePurchaseStoreCore<S extends PrivatePurchaseState | PrivatePurchaseCommitmentState> {
  private readonly limits: PrivatePurchaseStoreLimits
  private readonly payloads: PrivateAcquisitionPayloads
  private readonly policy: PrivatePurchaseCustody['validationPolicy']
  private readonly clockProfile?: 'native-observation-v1'
  private readonly economicProfile?: PrivatePurchaseCandidateProfile
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly contracts: PrivatePurchaseContracts,
    limits: PrivatePurchaseStoreLimits,
    policy: PrivatePurchaseCustody['validationPolicy'],
    clockProfile?: 'native-observation-v1',
    candidateProfile?: PrivatePurchaseCandidateProfile
  ) {
    this.economicProfile = candidateProfile
    outputAssert(
      clockProfile === undefined || clockProfile === 'native-observation-v1',
      'Unsupported purchase clock profile'
    )
    this.clockProfile = clockProfile
    const value = ownOutputJSON(limits, { bytes: 4096 }).value
    closedOutputObject(value, [
      'maximumStateBytes',
      'maximumOriginalBytes',
      'maximumCandidateBytes',
      'maximumResultBytes',
      'maximumOutcomeBytes',
      'maximumBatchBytes'
    ])
    this.limits = {
      maximumStateBytes: protectedInteger(value.maximumStateBytes, 1048576),
      maximumOriginalBytes: protectedInteger(value.maximumOriginalBytes, 4194304),
      maximumCandidateBytes: protectedInteger(value.maximumCandidateBytes, 4194304),
      maximumResultBytes: protectedInteger(value.maximumResultBytes, 4194304),
      maximumOutcomeBytes: protectedInteger(value.maximumOutcomeBytes, 131072),
      maximumBatchBytes: protectedInteger(value.maximumBatchBytes, 64 * 1048576 + 65536)
    }
    outputAssert(
      this.limits.maximumStateBytes >= PRIVATE_PURCHASE_PROGRESS_BYTES + 8192,
      'Purchase progress cannot fit its future reservation',
      'limited'
    )
    closedOutputObject(policy, ['id', 'digest'])
    this.policy = { id: outputString(policy.id), digest: outputHex32(policy.digest) }
    this.payloads = new PrivateAcquisitionPayloads(domain.identity)
    const installed = contracts.configuration()
    outputAssert(
      installed.seller === domain.scope.seller &&
        canonicalOutputJSON(installed.chain) === canonicalOutputJSON(domain.scope.chain),
      'Purchase native domain differs from installation',
      'context-changed'
    )
  }
  /** The explicit sealed local candidate contract, not a domain verdict. */
  candidateProfile(): PrivatePurchaseCandidateProfile | undefined {
    return this.economicProfile
  }
  private nativeState(input: Omit<PrivatePurchaseState, 'format'>): S {
    // Only the two explicit exported constructors select S and the matching mode.
    return (
      this.economicProfile
        ? { ...input, format: 'private-purchase-state/2', candidateProfile: this.economicProfile }
        : { ...input, format: 'private-purchase-state/1' }
    ) as S
  }
  private address(id: string) {
    return this.domain.identity.address('acquisition', {
      purpose: 'private-purchase-state',
      acquisitionId: id
    })
  }
  private fence(id: string) {
    return this.domain.identity.address('request-fence', {
      purpose: 'private-purchase-request',
      acquisitionId: id
    })
  }
  private custody(input: unknown): PrivatePurchaseCustody {
    const value = ownOutputJSON(input, { bytes: this.limits.maximumOriginalBytes }).value
    closedOutputObject(value, [
      'format',
      'original',
      'validationPolicy',
      'schema',
      'maximumSecretBytes',
      'material'
    ])
    closedOutputObject(value.validationPolicy, ['id', 'digest'])
    outputAssert(
      value.format === 'private-purchase-custody/1',
      'Unsupported purchase custody',
      'unsupported'
    )
    outputAssert(
      value.validationPolicy.id === this.policy.id &&
        value.validationPolicy.digest === this.policy.digest,
      'Purchase validation policy changed',
      'context-changed'
    )
    const original = this.contracts.original(value.original),
      schema = outputString(value.schema),
      maximumSecretBytes = protectedInteger(value.maximumSecretBytes, 4194304)
    outputAssert(
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(schema),
      'Purchase secret schema requires an absolute IRI'
    )
    outputAssert(typeof value.material === 'string', 'Purchase material must be encoded bytes')
    decodeOutputBytes(value.material, this.limits.maximumOriginalBytes)
    return {
      format: value.format,
      original,
      validationPolicy: { ...this.policy },
      schema,
      maximumSecretBytes,
      material: value.material
    }
  }
  private feasible(custody: PrivatePurchaseCustody): void {
    const selection = this.contracts.restore(custody.original.capability),
      body = custody.original.terms.body,
      // Bound the complete future envelope, including the largest allowed
      // retained STEAK and release evidence, before a purchase is funded.
      frame = canonicalOutputJSON({
        result: {
          version: 1,
          status: 'delivered',
          acquisitionId: body.acquisitionId,
          txid: '0'.repeat(64),
          ...(this.economicProfile ? { purchaseCommitment: '0'.repeat(64) } : {}),
          recoveryUntil: body.recoveryUntil,
          steak: {},
          potatoes: {
            body: {
              version: 1,
              acquisitionId: body.acquisitionId,
              requestDigest: body.requestDigest,
              seller: body.seller,
              recipient: body.recipient,
              topic: body.topic,
              txid: '0'.repeat(64),
              ...(this.economicProfile ? { purchaseCommitment: '0'.repeat(64) } : {}),
              assetId: body.assetId,
              termsDigest: body.termsDigest,
              releasePolicy: body.releasePolicy,
              evidenceDigest: '0'.repeat(64),
              schema: custody.schema,
              secret: '',
              issuedAt: '18446744073709551615',
              recoveryUntil: body.recoveryUntil
            },
            signature: 'A'.repeat(232)
          }
        },
        releaseEvidence: {}
      }),
      maximum =
        Buffer.byteLength(frame) +
        4 * Math.ceil(custody.maximumSecretBytes / 3) +
        this.limits.maximumOutcomeBytes +
        131072
    outputAssert(
      maximum <= this.limits.maximumResultBytes && maximum <= selection.profile.maxResponseBytes,
      'Purchase result cannot fit its promised envelope',
      'limited'
    )
  }
  private payloadRows(payload: PrivateAcquisitionPayload, view: ProtectedLedgerView) {
    return this.payloads.addresses(payload).map(address => view.get(address))
  }
  private restorePayloads(value: Record<string, unknown>, view: ProtectedLedgerView) {
    const originalPayload = parsePrivateAcquisitionPayload(value.original),
      candidatePayload = parsePrivateAcquisitionPayload(value.candidate),
      resultPayload = parsePrivateAcquisitionPayload(value.result),
      custody = this.custody(
        decoded(
          this.payloads.read(originalPayload, this.payloadRows(originalPayload, view)),
          this.limits.maximumOriginalBytes
        )
      ),
      progress = parsePrivatePurchaseProgress(
        value.progress,
        custody.original,
        this.economicProfile
      )
    return { originalPayload, candidatePayload, resultPayload, custody, progress }
  }
  private requirePayloadReservations(
    progress: PrivatePurchaseProgress,
    originalPayload: PrivateAcquisitionPayload,
    candidatePayload: PrivateAcquisitionPayload,
    resultPayload: PrivateAcquisitionPayload
  ): void {
    const id = progress.acquisitionId,
      expectedOriginal = this.payloads.reserve(
        id,
        progress.requestDigest,
        'material',
        this.limits.maximumOriginalBytes
      ).descriptor,
      expectedCandidate = this.payloads.reserve(
        outputPacketDigest('purchase', {
          purpose: 'protected-purchase-candidate',
          acquisitionId: id
        }),
        progress.requestDigest,
        'material',
        this.limits.maximumCandidateBytes
      ).descriptor,
      expectedResult = this.payloads.reserve(
        id,
        progress.requestDigest,
        'result',
        this.limits.maximumResultBytes
      ).descriptor
    for (const [actual, expected] of [
      [originalPayload, expectedOriginal],
      [candidatePayload, expectedCandidate],
      [resultPayload, expectedResult]
    ]) {
      outputAssert(
        actual.acquisitionId === expected.acquisitionId &&
          actual.requestDigest === expected.requestDigest &&
          actual.purpose === expected.purpose &&
          actual.maximumBytes === expected.maximumBytes &&
          actual.chunks === expected.chunks,
        'Purchase payload reservation differs',
        'unavailable'
      )
    }
  }
  private requireNativeRecord(
    row: ProtectedLedgerRecord,
    progress: PrivatePurchaseProgress,
    buyer: string,
    view: ProtectedLedgerView
  ): void {
    const id = progress.acquisitionId
    const address = this.address(id),
      fence = view.get(this.fence(id)),
      expectedFence = {
        format: 'private-purchase-fence/1',
        acquisitionId: id,
        requestDigest: progress.requestDigest,
        recipient: buyer
      }
    outputAssert(
      progress.recipient === buyer &&
        row.key === address.key &&
        row.kind === address.kind &&
        row.reservedBytes === this.limits.maximumStateBytes &&
        row.reservedUpdates >= remaining(progress.status) &&
        row.reservedUpdates <= 3 &&
        fence?.reservedBytes === 1024 &&
        fence.reservedUpdates === 0 &&
        canonicalOutputJSON(fence.value) === canonicalOutputJSON(expectedFence),
      'Purchase native record/fence binding differs',
      'unavailable'
    )
  }
  private restore(
    row: ProtectedLedgerRecord,
    buyer: string,
    view: ProtectedLedgerView
  ): CoreLoaded<S> | undefined {
    const value = row.value
    closedOutputObject(
      value,
      ['format', 'recipient', 'progress', 'original', 'candidate', 'result'],
      ['clockProfile', 'candidateProfile']
    )
    outputAssert(
      value.clockProfile === this.clockProfile,
      'Purchase clock profile differs from original custody',
      'context-changed'
    )
    outputAssert(
      value.format ===
        (this.economicProfile ? 'private-purchase-state/2' : 'private-purchase-state/1') &&
        value.candidateProfile === this.economicProfile,
      'Unsupported purchase state',
      'unavailable'
    )
    if (outputIdentity(value.recipient) !== buyer) return undefined
    const { originalPayload, candidatePayload, resultPayload, custody, progress } =
      this.restorePayloads(value, view)
    const id = progress.acquisitionId
    this.requirePayloadReservations(progress, originalPayload, candidatePayload, resultPayload)
    this.requireNativeRecord(row, progress, buyer, view)
    outputAssert(
      (candidatePayload.digest !== null) === (progress.txid !== null) &&
        (resultPayload.digest !== null) === (progress.status === 'delivered'),
      'Purchase completion descriptors differ from progress',
      'unavailable'
    )
    const candidate =
      candidatePayload.digest === null
        ? null
        : parseOutputPurchaseSubmit(
            decoded(
              this.payloads.read(candidatePayload, this.payloadRows(candidatePayload, view)),
              this.limits.maximumCandidateBytes
            )
          )
    outputAssert(
      candidate === null || (candidate.acquisitionId === id && candidate.txid === progress.txid),
      'Purchase candidate differs from its reserved transaction',
      'unavailable'
    )
    const state = this.nativeState({
      ...(this.clockProfile ? { clockProfile: this.clockProfile } : {}),
      recipient: buyer,
      progress,
      original: originalPayload,
      candidate: candidatePayload,
      result: resultPayload
    })
    return {
      revision: view.revision,
      observedAt: view.observedAt,
      row,
      custody,
      progress,
      candidate,
      state
    }
  }
  load(
    idInput: string,
    buyerInput: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): CoreLoaded<S> | undefined {
    const id = outputHex32(idInput),
      buyer = outputIdentity(buyerInput),
      address = this.address(id)
    let loaded: CoreLoaded<S> | undefined
    this.domain.ledger.read([address], clock, view => {
      authorize(guard, view)
      const row = view.get(address)
      if (row) loaded = this.restore(row, buyer, view)
    })
    return loaded
  }
  /** Atomic reservation of original terms/material, immutable request fence and every completion slot. */
  prepare(
    input: PrivatePurchaseCustody,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): CoreLoaded<S> {
    const custody = this.custody(input),
      id = custody.original.terms.body.acquisitionId,
      buyer = custody.original.request.recipient,
      prior = this.load(id, buyer, clock, guard)
    if (prior) {
      outputAssert(
        prior.progress.requestDigest === custody.original.terms.body.requestDigest,
        'Purchase request conflicts with its original preparation',
        'conflict'
      )
      return prior
    }
    this.feasible(custody)
    const address = this.address(id),
      fenceAddress = this.fence(id),
      read = this.domain.ledger.read([address, fenceAddress], clock, view => authorize(guard, view))
    outputAssert(
      !read.records[0] && !read.records[1],
      'Purchase reservation/fence already exists',
      'unavailable'
    )
    let plan: ReturnType<PrivatePurchaseStoreCore<S>['preparationPlan']> | undefined
    const check = (view: ProtectedLedgerView) => {
      authorize(guard, view)
      outputAssert(
        (!plan || view.observedAt === plan.progress.createdAt) &&
          outputU64(view.observedAt) < outputU64(custody.original.terms.body.purchaseUntil),
        'Purchase preparation cutoff changed before reservation',
        'expired'
      )
    }
    if (this.clockProfile) {
      this.domain.ledger.commitPrepared(
        read.revision,
        view => {
          plan = this.preparationPlan(custody, view.observedAt)
          return plan.changes
        },
        clock,
        check,
        { maximumBatchBytes: this.limits.maximumBatchBytes }
      )
    } else {
      plan = this.preparationPlan(custody, read.observedAt)
      this.domain.ledger.commit(read.revision, plan.changes, clock, check, {
        maximumBatchBytes: this.limits.maximumBatchBytes
      })
    }
    const loaded = this.load(id, buyer, clock, guard)
    outputAssert(loaded, 'Original purchase reservation is unavailable', 'unavailable')
    return loaded
  }
  private preparationPlan(input: PrivatePurchaseCustody, observedAt: string) {
    const custody = this.custody(input),
      id = custody.original.terms.body.acquisitionId,
      buyer = custody.original.request.recipient,
      address = this.address(id),
      fenceAddress = this.fence(id)
    // The private metadata records the actual native reservation observation.
    // PurchaseTerms bytes and their original public deadlines remain unchanged.
    outputAssert(
      outputU64(observedAt) >= outputU64(custody.original.createdAt),
      'Purchase reservation clock moved backwards',
      'context-changed'
    )
    custody.original = this.contracts.original({ ...custody.original, createdAt: observedAt })
    const progress = createPrivatePurchaseProgress(custody.original, this.economicProfile),
      original = this.payloads.reserve(
        id,
        progress.requestDigest,
        'material',
        this.limits.maximumOriginalBytes,
        encoded(custody, this.limits.maximumOriginalBytes)
      ),
      candidate = this.payloads.reserve(
        outputPacketDigest('purchase', {
          purpose: 'protected-purchase-candidate',
          acquisitionId: id
        }),
        progress.requestDigest,
        'material',
        this.limits.maximumCandidateBytes
      ),
      result = this.payloads.reserve(
        id,
        progress.requestDigest,
        'result',
        this.limits.maximumResultBytes
      ),
      state = this.nativeState({
        ...(this.clockProfile ? { clockProfile: this.clockProfile } : {}),
        recipient: buyer,
        progress,
        original: original.descriptor,
        candidate: candidate.descriptor,
        result: result.descriptor
      }),
      changes: ProtectedLedgerChange[] = [
        {
          ...address,
          expectedRevision: null,
          reservedBytes: this.limits.maximumStateBytes,
          reservedUpdates: 3,
          value: protectedValue(state, this.limits.maximumStateBytes).value
        },
        {
          ...fenceAddress,
          expectedRevision: null,
          reservedBytes: 1024,
          reservedUpdates: 0,
          value: {
            format: 'private-purchase-fence/1',
            acquisitionId: id,
            requestDigest: progress.requestDigest,
            recipient: buyer
          }
        },
        ...original.changes,
        ...candidate.changes,
        ...result.changes
      ]
    return { progress, changes }
  }
  private require(
    id: string,
    buyer: string,
    expected: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): CoreLoaded<S> {
    const loaded = this.load(id, buyer, clock, guard)
    outputAssert(loaded, 'Purchase not found', 'not-found')
    outputAssert(
      loaded.row.revision === outputU64(expected).toString(),
      'Purchase record changed',
      'conflict'
    )
    return loaded
  }
  /** Caller must independently verify complete candidate/domain before reserving this effect. */
  pin(
    id: string,
    buyer: string,
    expected: string,
    input: unknown,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    purchaseCommitment?: string
  ): CoreLoaded<S> {
    outputAssert(
      this.economicProfile !== undefined || purchaseCommitment === undefined,
      'Purchase commitment requires its explicit candidate profile',
      'unsupported'
    )
    const identity = this.economicProfile
        ? { purchaseCommitment: outputHex32(purchaseCommitment) }
        : {},
      candidate = parseOutputPurchaseSubmit(input),
      loaded = this.require(id, buyer, expected, clock, guard)
    outputAssert(
      candidate.acquisitionId === loaded.progress.acquisitionId,
      'Purchase candidate names another preparation',
      'conflict'
    )
    if (loaded.candidate !== null) {
      outputAssert(
        loaded.candidate.txid === candidate.txid &&
          loaded.progress.purchaseCommitment === identity.purchaseCommitment,
        'Purchase is reserved for another transaction',
        'conflict'
      )
      return loaded
    }
    const progress = advancePrivatePurchaseProgress(
      loaded.progress,
      loaded.custody.original,
      { type: 'pin', txid: candidate.txid, ...identity },
      loaded.observedAt,
      this.economicProfile
    )
    this.commitPayload(
      loaded,
      progress,
      'candidate',
      encoded(candidate, this.limits.maximumCandidateBytes),
      clock,
      guard,
      { type: 'pin', txid: candidate.txid, ...identity }
    )
    return this.require(id, buyer, String(BigInt(expected) + 1n), clock, guard)
  }
  advance(
    id: string,
    buyer: string,
    expected: string,
    event: Exclude<PrivatePurchaseEvent, { type: 'pin' | 'delivered' }>,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): CoreLoaded<S> {
    const loaded = this.require(id, buyer, expected, clock, guard),
      progress = advancePrivatePurchaseProgress(
        loaded.progress,
        loaded.custody.original,
        event,
        loaded.observedAt,
        this.economicProfile
      )
    if (canonicalOutputJSON(progress) === canonicalOutputJSON(loaded.progress)) return loaded
    // Capacity promised before payment includes the entire retained admission
    // or local-decision record, not just the top-level state object.
    if (progress.admission !== null)
      canonicalOutputJSON(progress.admission, { bytes: this.limits.maximumOutcomeBytes })
    if (progress.decision !== null)
      canonicalOutputJSON(progress.decision, { bytes: this.limits.maximumOutcomeBytes })
    this.commit(loaded, { ...loaded.state, progress }, [], clock, guard, event)
    return this.require(id, buyer, String(BigInt(expected) + 1n), clock, guard)
  }
  /** Retain the exact first complete signed result and progress in one native commit. */
  complete(
    id: string,
    buyer: string,
    expected: string,
    envelopeInput: unknown,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): CoreLoaded<S> {
    const loaded = this.require(id, buyer, expected, clock, guard),
      envelope = envelopeInput as OutputPurchaseEnvelope
    if (loaded.progress.status === 'delivered') {
      this.disclose(loaded, buyer, clock, guard, prior => {
        outputAssert(
          canonicalOutputJSON(prior) === canonicalOutputJSON(envelopeInput),
          'Purchase result is already immutable',
          'conflict'
        )
      })
      return loaded
    }
    const progress = advancePrivatePurchaseProgress(
      loaded.progress,
      loaded.custody.original,
      { type: 'delivered', envelope },
      loaded.observedAt,
      this.economicProfile
    )
    outputAssert(
      progress.delivery!.schema === loaded.custody.schema,
      'Purchase delivery secret schema differs',
      'conflict'
    )
    const result = privatePurchaseEnvelope(
      progress,
      loaded.custody.original,
      envelope,
      this.economicProfile
    )
    outputAssert(result.result.status === 'delivered', 'Purchase delivery is incomplete')
    decodeOutputBytes(result.result.potatoes.body.secret, loaded.custody.maximumSecretBytes)
    this.commitPayload(
      loaded,
      progress,
      'result',
      encoded(result, this.limits.maximumResultBytes),
      clock,
      guard,
      { type: 'delivered', envelope: result }
    )
    return this.require(id, buyer, String(BigInt(expected) + 1n), clock, guard)
  }
  private commitPayload(
    loaded: CoreLoaded<S>,
    progress: PrivatePurchaseProgress,
    purpose: 'candidate' | 'result',
    payload: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    event: PrivatePurchaseEvent
  ): void {
    let sealed: ReturnType<PrivateAcquisitionPayloads['seal']> | undefined
    this.domain.ledger.read([this.address(loaded.progress.acquisitionId)], clock, view => {
      authorize(guard, view)
      outputAssert(view.revision === loaded.revision, 'Purchase native head changed', 'conflict')
      const descriptor = loaded.state[purpose]
      sealed = this.payloads.seal(descriptor, this.payloadRows(descriptor, view), payload)
    })
    outputAssert(sealed, 'Purchase completion reservation is unavailable', 'unavailable')
    this.commit(
      loaded,
      { ...loaded.state, progress, [purpose]: sealed.descriptor },
      sealed.changes,
      clock,
      guard,
      event
    )
  }
  private commit(
    loaded: CoreLoaded<S>,
    state: S,
    additional: ProtectedLedgerChange[],
    clock: () => string,
    guard: ProtectedLedgerGuard,
    event: PrivatePurchaseEvent
  ): void {
    const changes = (progress: PrivatePurchaseProgress): ProtectedLedgerChange[] => [
      {
        ...this.address(state.progress.acquisitionId),
        expectedRevision: loaded.row.revision,
        reservedBytes: this.limits.maximumStateBytes,
        // A terminal transition can use fewer steps than the promised happy
        // path. Preserve unused revision capacity rather than silently release
        // reservations made before the buyer funded its purchase.
        reservedUpdates: Math.max(remaining(progress.status), loaded.row.reservedUpdates - 1),
        value: protectedValue({ ...state, progress }, this.limits.maximumStateBytes).value
      },
      ...additional
    ]
    if (this.clockProfile) {
      const retainedEvent = structuredClone(event)
      let progress: PrivatePurchaseProgress | undefined
      this.domain.ledger.commitPrepared(
        loaded.revision,
        view => {
          progress = advancePrivatePurchaseProgress(
            loaded.progress,
            loaded.custody.original,
            retainedEvent,
            view.observedAt,
            this.economicProfile
          )
          return changes(progress)
        },
        clock,
        view => {
          authorize(guard, view)
          if (progress)
            outputAssert(
              view.observedAt === progress.updatedAt,
              'Purchase progress clock changed before commit',
              'conflict'
            )
        },
        { maximumBatchBytes: this.limits.maximumBatchBytes }
      )
      return
    }
    this.domain.ledger.commit(
      loaded.revision,
      changes(state.progress),
      clock,
      view => {
        authorize(guard, view)
        outputAssert(
          view.observedAt === state.progress.updatedAt,
          'Purchase progress clock changed before commit',
          'conflict'
        )
      },
      { maximumBatchBytes: this.limits.maximumBatchBytes }
    )
  }
  /** Synchronous current authorization and exact retained bytes at the physical disclosure boundary. */
  disclose(
    loaded: CoreLoaded<S>,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    send: (envelope: OutputPurchaseEnvelope) => void
  ): void {
    this.enqueue(
      loaded,
      buyer,
      clock,
      guard,
      (current, view) => {
        const result =
          current.progress.status === 'delivered'
            ? decoded(
                this.payloads.read(
                  current.state.result,
                  this.payloadRows(current.state.result, view)
                ),
                this.limits.maximumResultBytes
              )
            : undefined
        const envelope = privatePurchaseEnvelope(
          current.progress,
          current.custody.original,
          result,
          this.economicProfile
        )
        const selection = this.contracts.restore(current.custody.original.capability)
        canonicalOutputJSON(envelope, { bytes: selection.profile.maxResponseBytes })
        return envelope
      },
      send
    )
  }
  /** Original signed terms may leave only while their unconstructed reservation
   * remains payable, under the same native physical enqueue gate as recovery.
   */
  discloseTerms(
    loaded: CoreLoaded<S>,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    send: (terms: OutputSignedPurchaseTerms) => void
  ): void {
    this.enqueue(
      loaded,
      buyer,
      clock,
      guard,
      (current, view) => {
        outputAssert(
          current.progress.status === 'prepared' &&
            outputU64(view.observedAt) <
              outputU64(current.custody.original.terms.body.purchaseUntil),
          'Purchase preparation is no longer payable',
          'expired'
        )
        const selection = this.contracts.restore(current.custody.original.capability)
        const terms = this.contracts.original(current.custody.original).terms
        canonicalOutputJSON(terms, { bytes: selection.profile.maxResponseBytes })
        return terms
      },
      send
    )
  }
  private enqueue<T>(
    loaded: CoreLoaded<S>,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    select: (current: CoreLoaded<S>, view: ProtectedLedgerView) => T,
    send: (value: T) => void
  ): void {
    outputAssert(
      typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
      'Purchase result enqueue must be synchronous'
    )
    let prepared: { value: T; revision: string } | undefined
    this.domain.ledger.disclose(
      loaded.revision,
      [this.address(loaded.progress.acquisitionId)],
      clock,
      view => {
        authorize(guard, view)
        const row = view.get(this.address(loaded.progress.acquisitionId)),
          current = row && this.restore(row, outputIdentity(buyer), view)
        outputAssert(
          current?.row.revision === loaded.row.revision &&
            current.row.key === loaded.row.key &&
            current.row.kind === loaded.row.kind &&
            current.progress.requestDigest === loaded.progress.requestDigest,
          'Purchase disclosure changed or is unavailable',
          'not-found'
        )
        prepared = { value: select(current, view), revision: current.row.revision }
      },
      records => {
        outputAssert(
          prepared && records[0]?.revision === prepared.revision,
          'Purchase disclosure changed before enqueue',
          'conflict'
        )
        const attempted: unknown = send(prepared.value)
        if (attempted instanceof Promise) void attempted.catch(() => undefined)
        outputAssert(attempted === undefined, 'Purchase result enqueue must finish synchronously')
      }
    )
  }
}

/** Historical exact-txid owner. Existing constructor, records and returned state
 * declarations remain unchanged; it cannot reinterpret commitment custody. */
export class SQLitePrivatePurchaseStore extends PrivatePurchaseStoreCore<PrivatePurchaseState> {
  constructor(
    domain: PrivateServiceDomain,
    contracts: PrivatePurchaseContracts,
    limits: PrivatePurchaseStoreLimits,
    policy: PrivatePurchaseCustody['validationPolicy'],
    clockProfile?: 'native-observation-v1'
  ) {
    super(domain, contracts, limits, policy, clockProfile)
  }
  override pin(
    id: string,
    buyer: string,
    expected: string,
    input: unknown,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseLoaded {
    return super.pin(id, buyer, expected, input, clock, guard)
  }
}

/** Explicit immutable economic-identity companion. Complete independent domain
 * verification precedes pinning; aliases and Bitcoin facts remain separate. */
export class SQLitePrivatePurchaseCommitmentStore extends PrivatePurchaseStoreCore<PrivatePurchaseCommitmentState> {
  constructor(
    domain: PrivateServiceDomain,
    contracts: PrivatePurchaseContracts,
    limits: PrivatePurchaseStoreLimits,
    policy: PrivatePurchaseCustody['validationPolicy'],
    clockProfile?: 'native-observation-v1'
  ) {
    super(domain, contracts, limits, policy, clockProfile, 'full-purchase-commitment-v1')
  }
}
