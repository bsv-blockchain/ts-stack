import {
  ownOutputJSON,
  Hash,
  Utils,
  OUTPUT_PROFILES,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputPacketDigest,
  outputString,
  outputU64,
  parseOutputPurchasePrepare,
  parseOutputPurchaseSubmit,
  restoreOutputCapability,
  selectOutputCapability,
  OutputPurchaseTermsVerifier,
  verifyOutputPurchaseEnvelopeWithInlineStrings as verifyOutputPurchaseEnvelope,
  verifyOutputPurchaseCommitmentEnvelopeWithInlineStrings as verifyOutputPurchaseCommitmentEnvelope,
  parseOutputPurchaseCommitmentBinding,
  OutputPurchaseTransport,
  OutputProtocolError,
  type OutputCapabilityRecoveryRequest,
  type OutputCapabilitySelection,
  type OutputJSONObject,
  type OutputPurchasePrepare,
  type OutputSignedPurchaseTerms,
  type OutputPurchaseSubmit,
  type OutputPurchaseEnvelope,
  type OutputPurchaseCommitmentBinding,
  type OutputRetainedCapability,
  type WalletInterface
} from '@bsv/sdk'
import type {
  OperationStateStore,
  OperationStateSnapshot
} from '../operations/OperationStateStore.js'
import type {
  ProtectedOperationObjectStore,
  ProtectedOperationObjectStatus
} from '../operations/ProtectedOperationObjectStore.js'
import { BoundedOutputWork, checkOutputWork } from '../internal/BoundedOutputWork.js'
import type {
  PrivatePurchaseBuyerPayment,
  PrivatePurchaseBuyerValidation
} from './PrivatePurchaseBuyerPorts.js'
import type { PrivatePurchaseBuyerAliasCurrentness } from './PrivatePurchaseBuyerAliasCurrentness.js'
import type { PrivatePurchaseAliasCurrentnessAssessment } from './SDKPrivatePurchaseAliasCurrentness.js'
const FORMAT = 'private-purchase-buyer/1'
export const PRIVATE_PURCHASE_BUYER_INITIAL: Readonly<OutputJSONObject> = Object.freeze({
  format: FORMAT,
  empty: true
})
type Role = 'request' | 'contract' | 'terms' | 'plan' | 'candidate' | 'result' | 'commitment'
type Phase = 'ready' | 'prepared' | 'funding' | 'funded' | 'received' | 'validated' | 'usable'
interface Progress {
  format: typeof FORMAT
  binding: string
  phase: Phase
  prepareAttempted: boolean
  submitAttempted: boolean
  observedAt: string
}
export interface PrivatePurchaseBuyerOptions {
  original: { contract: unknown; request: unknown }
  trust: OutputCapabilityRecoveryRequest
  state: OperationStateStore
  objects: ProtectedOperationObjectStore
  payment: PrivatePurchaseBuyerPayment
  validation: PrivatePurchaseBuyerValidation
  /** Explicit local owner selection. Binds a distinct installation and reserves
   * a seventh immutable object before preparation or financial work. */
  candidateProfile?: 'full-purchase-commitment-v1'
  /** Explicit local read optimization; no wire, binding or persisted-format change. */
  objectReadProfile?: 'joint-custody-v1'
  wallet: WalletInterface
  clock(): string
  current(): boolean
  fetch?: typeof fetch
  timeoutMs?: number
}
function digest(domain: string, value: unknown): string {
  return Utils.toHex(
    Hash.sha256(Utils.toArray(FORMAT + '\0' + domain + '\0' + canonicalOutputJSON(value), 'utf8'))
  )
}
function object(value: unknown, maximum: number): OutputJSONObject {
  const parsed = ownOutputJSON(value, { bytes: maximum }).value
  outputAssert(
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'Purchase buyer record must be an object'
  )
  return parsed
}
export function privatePurchaseBuyerBinding(
  options: Pick<
    PrivatePurchaseBuyerOptions,
    'original' | 'trust' | 'payment' | 'validation' | 'candidateProfile'
  >
): OutputJSONObject {
  outputAssert(
    options.candidateProfile === undefined ||
      options.candidateProfile === 'full-purchase-commitment-v1',
    'Unsupported purchase buyer candidate profile',
    'unsupported'
  )
  outputAssert(
    options.trust.kind === 'topic' && options.trust.profile === OUTPUT_PROFILES.purchase,
    'Purchase buyer requires the selected topic purchase profile',
    'unsupported'
  )
  const selection = restoreOutputCapability(options.original.contract, options.trust),
    request = parseOutputPurchasePrepare(options.original.request)
  outputAssert(
    request.topic === selection.service.name &&
      canonicalOutputJSON(request.listing.chain) ===
        canonicalOutputJSON(selection.manifest.body.chain),
    'Purchase buyer request differs from original selection',
    'context-changed'
  )
  return {
    format: FORMAT,
    acquisitionId: outputPacketDigest('purchase', {
      chain: request.listing.chain,
      seller: selection.manifest.body.identity,
      recipient: request.recipient,
      topic: request.topic,
      requestId: request.requestId
    }),
    capability: selection.digest,
    request: outputPacketDigest('purchase-request', request),
    contract: digest('contract', object(options.original.contract, 524288)),
    payment: object(options.payment.configuration, 16384),
    candidateBytes: options.payment.maximumCandidateBytes,
    validation: outputString(options.validation.id),
    ...(options.candidateProfile ? { candidateProfile: options.candidateProfile } : {})
  }
}
/** Durable ownership of one original purchase. Six protected object slots (seven
 * with explicit commitment custody) precede preparation or financial work. Large lineage/BEEF/License
 * bytes never enter the small control journal. Recovery reads the original
 * wallet action and seller obligation; it never prepares, signs or submits.
 * advance explicitly authorizes new work under the original cutoff and may
 * send a previously retained signed transaction during its recovery period.
 */
export class PrivatePurchaseBuyer {
  private readonly binding: OutputJSONObject
  private readonly installation: string
  private readonly selection: OutputCapabilitySelection
  private readonly request: OutputPurchasePrepare
  private readonly contract: OutputRetainedCapability
  private readonly trust: OutputCapabilityRecoveryRequest
  private readonly sizes: Record<Role, number>
  private readonly roles: Role[]
  private readonly candidateProfile?: 'full-purchase-commitment-v1'
  private readonly objectReadProfile?: 'joint-custody-v1'
  private readonly configurations: string[]
  private readonly pins: (() => boolean)[]
  private readonly stopping = new AbortController()
  private readonly physical = new Set<Promise<void>>()
  private readonly work: BoundedOutputWork
  private observedAt = 0n
  private readonly termsVerifier: OutputPurchaseTermsVerifier
  private constructor(private readonly ports: PrivatePurchaseBuyerOptions) {
    this.candidateProfile = ports.candidateProfile
    outputAssert(
      ports.objectReadProfile === undefined || ports.objectReadProfile === 'joint-custody-v1',
      'Unsupported purchase buyer custody read profile',
      'unsupported'
    )
    this.objectReadProfile = ports.objectReadProfile
    if (this.objectReadProfile)
      outputAssert(
        typeof ports.objects.readMany === 'function',
        'Joint purchase custody requires the explicit object-store companion',
        'unsupported'
      )
    this.trust = {
      ...ports.trust,
      chain: structuredClone(ports.trust.chain),
      rules: new Map(ports.trust.rules),
      supportedExtensions: [...(ports.trust.supportedExtensions ?? [])]
    }
    this.binding = privatePurchaseBuyerBinding({ ...ports, trust: this.trust })
    this.installation = digest('installation', this.binding)
    this.selection = restoreOutputCapability(ports.original.contract, this.trust)
    this.contract = object(ports.original.contract, 524288) as unknown as OutputRetainedCapability
    this.request = parseOutputPurchasePrepare(ports.original.request)
    this.termsVerifier = new OutputPurchaseTermsVerifier(
      this.request,
      this.selection.manifest.body.identity
    )
    const requestBytes = Math.min(4194304, this.selection.profile.maxRequestBytes),
      responseBytes = Math.min(4194304, this.selection.profile.maxResponseBytes)
    this.sizes = {
      request: requestBytes,
      contract: 524288,
      terms: responseBytes,
      plan: 4194304,
      candidate: requestBytes,
      result: responseBytes,
      commitment: 8192
    }
    this.roles = (Object.keys(this.sizes) as Role[]).filter(
      role => role !== 'commitment' || this.candidateProfile !== undefined
    )
    if (this.candidateProfile)
      outputAssert(
        typeof ports.validation.candidateBinding === 'function',
        'Purchase commitment buyer requires a complete candidate verifier',
        'unsupported'
      )
    outputAssert(
      Number.isSafeInteger(ports.payment.maximumCandidateBytes) &&
        ports.payment.maximumCandidateBytes > 0 &&
        ports.payment.maximumCandidateBytes <= requestBytes,
      'Purchase buyer wallet cannot guarantee selected submission capacity',
      'limited'
    )
    outputAssert(
      ports.state.durability === 'durable' && ports.objects.durability === 'durable',
      'Purchase buyer requires durable protected owners',
      'unsupported'
    )
    outputAssert(
      canonicalOutputJSON(ports.state.configuration.binding) ===
        canonicalOutputJSON(this.binding) &&
        canonicalOutputJSON(ports.objects.configuration.binding) ===
          canonicalOutputJSON(this.binding) &&
        ports.objects.configuration.recipient === this.request.recipient,
      'Purchase buyer storage binding differs',
      'context-changed'
    )
    outputAssert(
      ports.state.configuration.limits.stateBytes >= 16384 &&
        ports.objects.configuration.maximumObjects >= this.roles.length &&
        ports.objects.configuration.maximumObjectBytes >= Math.max(...Object.values(this.sizes)),
      'Purchase buyer lacks complete future capacity',
      'limited'
    )
    outputAssert(
      typeof ports.current === 'function' && ports.current.constructor.name !== 'AsyncFunction',
      'Purchase buyer access must be synchronous'
    )
    this.configurations = this.configuration()
    this.pins = [
      pin(ports.state, 'read'),
      pin(ports.state, 'compareAndSwap'),
      pin(ports.objects, 'reserve'),
      pin(ports.objects, 'read'),
      ...(this.objectReadProfile ? [pin(ports.objects, 'readMany')] : []),
      pin(ports.objects, 'put'),
      pin(ports.payment, 'plan'),
      pin(ports.payment, 'recover'),
      pin(ports.payment, 'finish'),
      pin(this.termsVerifier, 'verify'),
      pin(ports.validation, 'preflight'),
      pin(ports.validation, 'fundingPreflight', true),
      pin(ports.validation, 'candidateBinding', true),
      pin(ports.validation, 'verify'),
      pin(ports.validation, 'usable'),
      pin(ports.wallet, 'getPublicKey'),
      pin(ports, 'clock'),
      pin(ports, 'current')
    ]
    this.work = new BoundedOutputWork(
      {
        invalid: 'Invalid purchase buyer limits',
        capacity: 'Original purchase buyer work is still active',
        cancelled: 'Purchase buyer cancelled',
        deadline: 'Purchase buyer deadline'
      },
      1,
      1,
      ports.timeoutMs ?? 30000
    )
  }
  static async initialize(ports: PrivatePurchaseBuyerOptions): Promise<PrivatePurchaseBuyer> {
    const buyer = new PrivatePurchaseBuyer(ports)
    await buyer.roles.reduce(
      (sequence, role) =>
        sequence.then(async () => {
          await ports.objects.reserve(buyer.id(role), buyer.role(role), buyer.sizes[role])
          buyer.installed()
        }),
      Promise.resolve()
    )
    await buyer.put('request', buyer.request)
    await buyer.put('contract', buyer.contract)
    const saved = await ports.state.read()
    if (canonicalOutputJSON(saved.value) === canonicalOutputJSON(PRIVATE_PURCHASE_BUYER_INITIAL))
      await buyer.save(saved, {
        format: FORMAT,
        binding: buyer.installation,
        phase: 'ready',
        prepareAttempted: false,
        submitAttempted: false,
        observedAt: outputU64(ports.clock()).toString()
      })
    await buyer.initialized()
    return buyer
  }
  static async open(ports: PrivatePurchaseBuyerOptions): Promise<PrivatePurchaseBuyer> {
    const buyer = new PrivatePurchaseBuyer(ports)
    await buyer.initialized()
    return buyer
  }
  private async initialized(): Promise<void> {
    await this.load()
    if (this.objectReadProfile === undefined || this.ports.objects.readMany === undefined) {
      await this.roles.reduce(
        (sequence, role) =>
          sequence.then(async () => {
            const saved = await this.ports.objects.read(this.id(role), this.role(role))
            outputAssert(
              saved.state !== 'absent' &&
                (saved.state === 'stored'
                  ? saved.receipt.maximumBytes
                  : saved.reservation.maximumBytes) === this.sizes[role],
              'Purchase buyer original reservation is missing',
              'unavailable'
            )
          }),
        Promise.resolve()
      )
      outputAssert(
        canonicalOutputJSON(await this.get('request')) === canonicalOutputJSON(this.request) &&
          canonicalOutputJSON(await this.get('contract')) === canonicalOutputJSON(this.contract),
        'Purchase buyer original custody differs',
        'context-changed'
      )
    } else {
      const statuses = await this.readStatuses(this.roles)
      try {
        this.installed()
        const owned = this.ownStatuses(statuses, this.roles.length)
        this.roles.forEach((role, index) =>
          outputAssert(
            owned[index].state !== 'absent' &&
              (owned[index].state === 'stored'
                ? owned[index].receipt.maximumBytes
                : owned[index].reservation.maximumBytes) === this.sizes[role],
            'Purchase buyer original reservation is missing',
            'unavailable'
          )
        )
        const request = this.decodeStatus('request', owned[this.roles.indexOf('request')]),
          contract = this.decodeStatus('contract', owned[this.roles.indexOf('contract')])
        outputAssert(
          canonicalOutputJSON(request) === canonicalOutputJSON(this.request) &&
            canonicalOutputJSON(contract) === canonicalOutputJSON(this.contract),
          'Purchase buyer original custody differs',
          'context-changed'
        )
      } finally {
        this.clearStatuses(statuses, this.roles.length)
      }
    }
    this.installed()
  }
  private configuration(): string[] {
    return [
      canonicalOutputJSON(this.ports.state.configuration),
      canonicalOutputJSON(this.ports.objects.configuration),
      canonicalOutputJSON(this.ports.payment.configuration),
      this.ports.validation.id,
      String(this.ports.payment.maximumCandidateBytes)
    ]
  }
  private installed(): void {
    outputAssert(
      this.pins.every(check => check()) &&
        this.ports.candidateProfile === this.candidateProfile &&
        this.ports.objectReadProfile === this.objectReadProfile &&
        this.configuration().every((value, index) => value === this.configurations[index]),
      'Purchase buyer installed capability changed',
      'context-changed'
    )
  }
  private access(signal: AbortSignal): void {
    this.installed()
    checkOutputWork(signal, 'Purchase buyer cancelled')
    const allowed: unknown = this.ports.current()
    if (allowed instanceof Promise) void allowed.catch(() => undefined)
    outputAssert(allowed === true, 'Purchase buyer access changed', 'unauthorized')
  }
  private id(role: Role): string {
    return digest('object', { installation: this.installation, role })
  }
  private role(role: Role): OutputJSONObject {
    return { format: FORMAT, installation: this.installation, role }
  }
  private async put(role: Role, value: unknown): Promise<void> {
    const bytes = new TextEncoder().encode(canonicalOutputJSON(value, { bytes: this.sizes[role] }))
    try {
      await this.ports.objects.put(this.id(role), this.role(role), bytes)
    } finally {
      bytes.fill(0)
    }
    this.installed()
  }
  private async get(role: Role): Promise<OutputJSONObject | undefined> {
    const saved = await this.ports.objects.read(this.id(role), this.role(role))
    this.installed()
    return this.decodeStatus(role, saved)
  }
  private decodeStatus(
    role: Role,
    saved: ProtectedOperationObjectStatus
  ): OutputJSONObject | undefined {
    outputAssert(
      saved.state !== 'absent',
      'Purchase buyer original slot disappeared',
      'unavailable'
    )
    if (saved.state === 'reserved') return undefined
    try {
      return object(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(saved.bytes)),
        this.sizes[role]
      )
    } finally {
      saved.bytes.fill(0)
    }
  }
  private ownStatuses(statuses: unknown, count: number): ProtectedOperationObjectStatus[] {
    // Both reply ownership and disposal are bounded by the installed request,
    // never by a length or accessor supplied by the companion.
    try {
      outputAssert(
        Array.isArray(statuses) &&
          Object.getOwnPropertyDescriptor(statuses, 'length')?.value === count,
        'Purchase buyer joint custody result differs',
        'unavailable'
      )
      const owned: ProtectedOperationObjectStatus[] = []
      for (let index = 0; index < count; index++) {
        const slot = Object.getOwnPropertyDescriptor(statuses, String(index))
        outputAssert(
          slot !== undefined && 'value' in slot,
          'Purchase buyer joint custody result differs',
          'unavailable'
        )
        owned.push(slot.value as ProtectedOperationObjectStatus)
      }
      return owned
    } catch {
      outputAssert(false, 'Purchase buyer joint custody result differs', 'unavailable')
    }
  }
  private clearStatuses(statuses: unknown, count: number): void {
    // A malformed or detached reply must not replace the primary refusal.
    // Omitted and unsolicited slots remain the companion's disposal obligation.
    try {
      if (!Array.isArray(statuses)) return
    } catch {
      return
    }
    for (let index = 0; index < count; index++) {
      try {
        const saved = Object.getOwnPropertyDescriptor(statuses, String(index))?.value
        if (saved === null || typeof saved !== 'object') continue
        const bytes = Object.getOwnPropertyDescriptor(saved, 'bytes')?.value
        if (bytes instanceof Uint8Array) Uint8Array.prototype.fill.call(bytes, 0)
      } catch {
        // Cleanup cannot suppress a validation, access or ownership refusal.
      }
    }
  }
  private async readStatuses(roles: readonly Role[]): Promise<unknown> {
    try {
      // Promise assimilation may refuse a detached provider reply before the
      // ownership validator receives it. The companion still owns its buffers.
      return await this.ports.objects.readMany!(
        roles.map(role => ({ id: this.id(role), originalBinding: this.role(role) }))
      )
    } catch (error) {
      let classified = false
      try {
        classified = error instanceof OutputProtocolError
      } catch {
        // An opaque thrown value cannot establish a protocol refusal.
      }
      outputAssert(classified, 'Purchase buyer joint custody read failed', 'unavailable')
      throw error
    }
  }
  private async getMany(roles: readonly Role[]): Promise<(OutputJSONObject | undefined)[]> {
    if (this.objectReadProfile === undefined || this.ports.objects.readMany === undefined) {
      const values: (OutputJSONObject | undefined)[] = []
      const readNext = async (index: number): Promise<(OutputJSONObject | undefined)[]> => {
        if (index === roles.length) return values
        values.push(await this.get(roles[index]))
        return readNext(index + 1)
      }
      return readNext(0)
    }
    const statuses = await this.readStatuses(roles)
    try {
      this.installed()
      const owned = this.ownStatuses(statuses, roles.length)
      return roles.map((role, index) => this.decodeStatus(role, owned[index]))
    } finally {
      this.clearStatuses(statuses, roles.length)
    }
  }

  private async load(): Promise<{ snapshot: OperationStateSnapshot; progress: Progress }> {
    const snapshot = await this.ports.state.read()
    this.installed()
    const value = snapshot.value
    closedOutputObject(value, [
      'format',
      'binding',
      'phase',
      'prepareAttempted',
      'submitAttempted',
      'observedAt'
    ])
    outputAssert(
      value.format === FORMAT &&
        value.binding === this.installation &&
        ['ready', 'prepared', 'funding', 'funded', 'received', 'validated', 'usable'].includes(
          value.phase as string
        ) &&
        typeof value.prepareAttempted === 'boolean' &&
        typeof value.submitAttempted === 'boolean',
      'Purchase buyer control state differs',
      'unavailable'
    )
    outputAssert(
      !value.submitAttempted ||
        ['funded', 'received', 'validated', 'usable'].includes(value.phase as string),
      'Purchase buyer progress is inconsistent',
      'unavailable'
    )
    return {
      snapshot,
      progress: {
        ...value,
        observedAt: outputU64(value.observedAt).toString()
      } as unknown as Progress
    }
  }
  private async save(snapshot: OperationStateSnapshot, progress: Progress): Promise<void> {
    this.installed()
    const previous =
      canonicalOutputJSON(snapshot.value) === canonicalOutputJSON(PRIVATE_PURCHASE_BUYER_INITIAL)
        ? 0n
        : outputU64(snapshot.value.observedAt)
    const observedAt = maximum([previous, outputU64(progress.observedAt), this.observedAt])
    const result = await this.ports.state.compareAndSwap(
      snapshot.revision,
      object({ ...progress, observedAt: observedAt.toString() }, 16384)
    )
    this.installed()
    outputAssert(
      result.status !== 'conflict',
      'Purchase buyer advanced in another owner',
      'conflict'
    )
  }
  private terms(input: unknown): OutputSignedPurchaseTerms {
    const terms = this.termsVerifier.verify(input),
      p = this.selection.profile.parameters
    outputAssert(
      (p.domainProfiles as string[]).includes(terms.body.domainProfile) &&
        (p.releasePolicies as unknown[]).some(
          policy => canonicalOutputJSON(policy) === canonicalOutputJSON(terms.body.releasePolicy)
        ) &&
        outputU64(terms.body.recoveryUntil) - outputU64(terms.body.purchaseUntil) >=
          outputU64(p.recoverySeconds),
      'Purchase buyer original domain or recovery terms changed',
      'context-changed'
    )
    return terms
  }
  private candidate(input: unknown, terms: OutputSignedPurchaseTerms): OutputPurchaseSubmit {
    const candidate = parseOutputPurchaseSubmit(input)
    outputAssert(
      candidate.acquisitionId === terms.body.acquisitionId,
      'Purchase buyer candidate changed acquisition',
      'context-changed'
    )
    return candidate
  }
  private newWork(
    progress: Progress,
    terms: OutputSignedPurchaseTerms | null,
    signal: AbortSignal
  ): void {
    this.access(signal)
    const now = outputU64(this.ports.clock())
    outputAssert(
      now >= outputU64(progress.observedAt) && now >= this.observedAt,
      'Purchase buyer clock moved backwards',
      'context-changed'
    )
    this.observedAt = now
    if (terms)
      outputAssert(
        now < outputU64(terms.body.purchaseUntil),
        'Original purchase cutoff elapsed',
        'expired'
      )
    else
      selectOutputCapability(this.contract.manifest, {
        ...this.trust,
        ...this.contract.freshness,
        now: now.toString()
      })
  }
  private async preflight(
    progress: Progress,
    terms: OutputSignedPurchaseTerms | null,
    signal: AbortSignal
  ): Promise<(() => void) | undefined> {
    this.newWork(progress, terms, signal)
    if (terms !== null && this.ports.validation.fundingPreflight !== undefined) {
      const assessment = await this.ports.validation.fundingPreflight(
          structuredClone(this.request),
          structuredClone(terms),
          signal
        ),
        guard = this.fundingGuard(assessment)
      this.newWork(progress, terms, signal)
      guard()
      return guard
    }
    await this.ports.validation.preflight(
      structuredClone(this.request),
      structuredClone(terms),
      signal
    )
    this.newWork(progress, terms, signal)
    return undefined
  }
  private fundingGuard(assessment: { checkCurrent(): void }): () => void {
    outputAssert(
      assessment !== null && typeof assessment === 'object',
      'Purchase funding assessment must be an owned object'
    )
    const check: unknown = Object.getOwnPropertyDescriptor(assessment, 'checkCurrent')?.value
    outputAssert(
      typeof check === 'function' && check.constructor.name !== 'AsyncFunction',
      'Purchase funding guard must be owned and synchronous'
    )
    return () => {
      const result: unknown = check.call(assessment)
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(
        result === undefined &&
          Object.getOwnPropertyDescriptor(assessment, 'checkCurrent')?.value === check,
        'Purchase funding guard changed or did not finish',
        'context-changed'
      )
    }
  }
  /** Own the immutable identity beside the original funded bytes. A retained
   * identity authenticates history; it is never a current-chain/rights verdict. */
  private async candidateIdentity(
    terms: OutputSignedPurchaseTerms,
    candidate: OutputPurchaseSubmit,
    signal: AbortSignal,
    create = false
  ): Promise<{ binding: OutputPurchaseCommitmentBinding; checkCurrent(): void }> {
    this.access(signal)
    const saved = await this.get('commitment'),
      candidateDigest = digest('candidate', candidate)
    this.access(signal)
    if (saved !== undefined) {
      closedOutputObject(saved, ['format', 'candidateDigest', 'binding'])
      const binding = parseOutputPurchaseCommitmentBinding(saved.binding)
      outputAssert(
        saved.format === 'private-purchase-candidate-binding/1' &&
          saved.candidateDigest === candidateDigest &&
          binding.profile === this.candidateProfile &&
          binding.domainProfile === terms.body.domainProfile,
        'Purchase buyer retained identity differs from its original candidate',
        'unavailable'
      )
      return { binding, checkCurrent: () => this.access(signal) }
    }
    outputAssert(create, 'Purchase buyer original identity is unavailable', 'unavailable')
    outputAssert(
      (await this.get('result')) === undefined,
      'Delivered purchase cannot initialize a missing identity',
      'unavailable'
    )
    this.access(signal)
    const assessment = await this.ports.validation.candidateBinding!(
      structuredClone(this.request),
      structuredClone(terms),
      structuredClone(candidate),
      signal
    )
    outputAssert(
      assessment !== null && typeof assessment === 'object' && !Array.isArray(assessment),
      'Purchase buyer identity assessment must be an object'
    )
    const purchaseCommitment = outputHex32(
        Object.getOwnPropertyDescriptor(assessment, 'purchaseCommitment')?.value
      ),
      method: unknown = Object.getOwnPropertyDescriptor(assessment, 'checkCurrent')?.value
    outputAssert(
      typeof method === 'function' && method.constructor.name !== 'AsyncFunction',
      'Purchase buyer identity requires an owned synchronous guard',
      'context-changed'
    )
    const unchanged = () => {
        this.access(signal)
        outputAssert(
          Object.getOwnPropertyDescriptor(assessment, 'purchaseCommitment')?.value ===
            purchaseCommitment &&
            Object.getOwnPropertyDescriptor(assessment, 'checkCurrent')?.value === method,
          'Verified purchase buyer identity changed',
          'context-changed'
        )
      },
      checkCurrent = () => {
        unchanged()
        const result: unknown = method.call(assessment)
        if (result instanceof Promise) void result.catch(() => undefined)
        outputAssert(
          result === undefined,
          'Purchase identity guard did not finish',
          'context-changed'
        )
        unchanged()
      },
      binding = parseOutputPurchaseCommitmentBinding({
        profile: this.candidateProfile,
        domainProfile: terms.body.domainProfile,
        purchaseCommitment
      })
    checkCurrent()
    await this.put('commitment', {
      format: 'private-purchase-candidate-binding/1',
      candidateDigest,
      binding
    })
    checkCurrent()
    return { binding, checkCurrent }
  }
  private async authenticated(
    input: unknown,
    terms: OutputSignedPurchaseTerms,
    candidate: OutputPurchaseSubmit | undefined,
    signal: AbortSignal
  ): Promise<OutputPurchaseEnvelope> {
    if (!this.candidateProfile) return verifyOutputPurchaseEnvelope(input, terms, candidate?.txid)
    if (candidate === undefined) {
      const envelope = verifyOutputPurchaseEnvelope(input, terms)
      outputAssert(
        envelope.result.status === 'prepared' || envelope.result.status === 'expired',
        'Purchase identity response lacks its original funded candidate',
        'unavailable'
      )
      return envelope
    }
    const identity = await this.candidateIdentity(terms, candidate, signal)
    identity.checkCurrent()
    return verifyOutputPurchaseCommitmentEnvelope(input, terms, identity.binding)
  }
  private async sendPurchase(
    operation: 'submit' | 'recover',
    terms: OutputSignedPurchaseTerms,
    candidate: OutputPurchaseSubmit | undefined,
    signal: AbortSignal
  ): Promise<OutputPurchaseEnvelope> {
    const identity =
      this.candidateProfile && candidate !== undefined
        ? await this.candidateIdentity(terms, candidate, signal, true)
        : undefined
    identity?.checkCurrent()
    const transport =
        operation === 'submit'
          ? this.transport(operation, terms, candidate!, identity?.binding)
          : this.transport(operation, terms, candidate, identity?.binding),
      result = await transport.send(signal)
    identity?.checkCurrent()
    return result
  }
  private transport(
    operation: 'prepare',
    terms?: never,
    candidate?: never
  ): OutputPurchaseTransport<'prepare'>
  private transport(
    operation: 'submit',
    terms: OutputSignedPurchaseTerms,
    candidate: OutputPurchaseSubmit,
    commitmentBinding?: OutputPurchaseCommitmentBinding
  ): OutputPurchaseTransport<'submit'>
  private transport(
    operation: 'recover',
    terms: OutputSignedPurchaseTerms,
    candidate?: OutputPurchaseSubmit,
    commitmentBinding?: OutputPurchaseCommitmentBinding
  ): OutputPurchaseTransport<'recover'>
  private transport(
    operation: 'prepare' | 'submit' | 'recover',
    terms?: OutputSignedPurchaseTerms,
    candidate?: OutputPurchaseSubmit,
    commitmentBinding?: OutputPurchaseCommitmentBinding
  ) {
    const common = {
      contract: this.contract,
      trust: this.trust,
      request: this.request,
      wallet: this.ports.wallet,
      fetch: this.ports.fetch,
      requestTimeoutMs: this.ports.timeoutMs
    }
    if (operation === 'prepare') return new OutputPurchaseTransport({ ...common, operation })
    if (operation === 'submit')
      return new OutputPurchaseTransport({
        ...common,
        operation,
        terms,
        candidate,
        commitmentBinding
      })
    return new OutputPurchaseTransport({
      ...common,
      operation,
      terms,
      ...(commitmentBinding ? { commitmentBinding } : {}),
      ...(candidate ? { candidate } : {})
    })
  }
  private async retain(
    input: OutputPurchaseEnvelope,
    terms: OutputSignedPurchaseTerms,
    candidate?: OutputPurchaseSubmit,
    signal: AbortSignal = this.stopping.signal
  ): Promise<OutputPurchaseEnvelope> {
    const owned = await this.authenticated(input, terms, candidate, signal)
    if (owned.result.status === 'delivered') await this.put('result', owned)
    return this.received(owned)
  }
  private async received(owned: OutputPurchaseEnvelope): Promise<OutputPurchaseEnvelope> {
    if (owned.result.status === 'delivered') {
      const { snapshot, progress } = await this.load()
      if (!['received', 'validated', 'usable'].includes(progress.phase))
        await this.save(snapshot, { ...progress, phase: 'received' })
    }
    return owned
  }
  private async retained(
    input: OutputPurchaseEnvelope,
    terms: OutputSignedPurchaseTerms,
    candidate: OutputPurchaseSubmit | undefined,
    signal: AbortSignal
  ): Promise<OutputPurchaseEnvelope> {
    // This call just read the first immutable object through its original
    // protected binding. Authenticate it again, and reconcile a missing control
    // commit, without rewriting the same retained bytes or consulting the seller.
    return this.received(await this.authenticated(input, terms, candidate, signal))
  }
  private async recoveryObject(
    original: readonly (OutputJSONObject | undefined)[] | undefined,
    role: 'terms' | 'candidate' | 'result'
  ): Promise<OutputJSONObject | undefined> {
    if (original === undefined) return this.get(role)
    return original[{ terms: 0, candidate: 1, result: 2 }[role]]
  }
  private async reconcile(signal: AbortSignal): Promise<OutputPurchaseEnvelope | undefined> {
    this.access(signal)
    // A selected companion supplies one fresh atomic original-object view.
    // Omitted selection retains the individual reads and their original order.
    const original = this.objectReadProfile
      ? await this.getMany(['terms', 'candidate', 'result'])
      : undefined
    const rawTerms = await this.recoveryObject(original, 'terms')
    if (rawTerms === undefined) return undefined
    const terms = this.terms(rawTerms)
    let saved = await this.load()
    if (saved.progress.phase === 'ready') {
      await this.save(saved.snapshot, { ...saved.progress, phase: 'prepared' })
      saved = await this.load()
    }
    const retainedResult = await this.recoveryObject(original, 'result')
    if (retainedResult !== undefined) {
      const rawCandidate = await this.recoveryObject(original, 'candidate')
      outputAssert(
        rawCandidate !== undefined,
        'Purchase buyer delivered result lacks its original candidate',
        'unavailable'
      )
      return this.retained(
        retainedResult as unknown as OutputPurchaseEnvelope,
        terms,
        this.candidate(rawCandidate, terms),
        signal
      )
    }
    const rawPlan = await this.get('plan')
    if (rawPlan !== undefined) {
      const outcome = await this.ports.payment.recover(rawPlan, signal)
      this.access(signal)
      outputAssert(
        outcome !== null &&
          typeof outcome === 'object' &&
          ['absent', 'prepared', 'finalized'].includes(outcome.state),
        'Original wallet outcome is unresolved',
        'unavailable'
      )
      if (outcome.state === 'finalized') {
        await this.put('candidate', this.candidate(outcome.candidate, terms))
        saved = await this.load()
        if (['prepared', 'funding'].includes(saved.progress.phase))
          await this.save(saved.snapshot, { ...saved.progress, phase: 'funded' })
      }
    }
    const rawCandidate = await this.get('candidate'),
      candidate = rawCandidate === undefined ? undefined : this.candidate(rawCandidate, terms),
      result = await this.get('result')
    if (result !== undefined)
      return this.retained(result as unknown as OutputPurchaseEnvelope, terms, candidate, signal)
    const recovered = await this.sendPurchase('recover', terms, candidate, signal)
    this.access(signal)
    return this.retain(recovered, terms, candidate, signal)
  }
  /** Reads original wallet/server state; never prepares/signs/submits a transaction. */
  recover(signal?: AbortSignal): Promise<OutputPurchaseEnvelope | undefined> {
    return this.run(signal, async active => {
      const result = await this.reconcile(active)
      this.access(active)
      return result
    })
  }
  /** Explicit authorization to finish the original action and submit its retained bytes. */
  advance(signal?: AbortSignal): Promise<OutputPurchaseEnvelope> {
    return this.run(signal, async active => {
      const recovered = await this.reconcile(active)
      if (recovered && !['prepared', 'expired'].includes(recovered.result.status)) {
        this.access(active)
        return recovered
      }
      let saved = await this.load(),
        rawTerms = await this.get('terms')
      if (rawTerms === undefined) {
        await this.preflight(saved.progress, null, active)
        await this.save(saved.snapshot, { ...saved.progress, prepareAttempted: true })
        saved = await this.load()
        await this.preflight(saved.progress, null, active)
        rawTerms = object(
          this.terms(await this.transport('prepare').send(active)),
          this.sizes.terms
        )
        await this.put('terms', rawTerms)
        saved = await this.load()
        await this.save(saved.snapshot, { ...saved.progress, phase: 'prepared' })
        saved = await this.load()
      }
      const terms = this.terms(rawTerms)
      let plan = await this.get('plan'),
        rawCandidate = await this.get('candidate')
      if (plan === undefined) {
        const funding = await this.preflight(saved.progress, terms, active)
        funding?.()
        plan = object(
          await this.ports.payment.plan(
            digest('action', this.binding),
            structuredClone(this.request),
            structuredClone(terms),
            active
          ),
          this.sizes.plan
        )
        this.newWork(saved.progress, terms, active)
        funding?.()
        await this.put('plan', plan)
      }
      if (rawCandidate === undefined) {
        const funding = await this.preflight(saved.progress, terms, active)
        saved = await this.load()
        await this.save(saved.snapshot, { ...saved.progress, phase: 'funding' })
        funding?.()
        rawCandidate = object(
          this.candidate(
            await this.ports.payment.finish(
              structuredClone(plan),
              () => {
                this.newWork(saved.progress, terms, active)
                funding?.()
              },
              active
            ),
            terms
          ),
          this.sizes.candidate
        )
        this.access(active)
        await this.put('candidate', rawCandidate)
        saved = await this.load()
        await this.save(saved.snapshot, { ...saved.progress, phase: 'funded' })
      }
      const candidate = this.candidate(rawCandidate, terms)
      this.access(active)
      saved = await this.load()
      await this.save(saved.snapshot, { ...saved.progress, submitAttempted: true })
      this.access(active)
      const delivered = await this.sendPurchase('submit', terms, candidate, active)
      this.access(active)
      return this.retain(delivered, terms, candidate, active)
    })
  }
  validate(signal?: AbortSignal): Promise<'validated' | 'usable'> {
    return this.run(signal, async active => {
      this.access(active)
      const [rawTerms, rawCandidate, rawResult] = await this.getMany([
        'terms',
        'candidate',
        'result'
      ])
      outputAssert(
        rawTerms !== undefined && rawCandidate !== undefined && rawResult !== undefined,
        'Purchase buyer has no complete delivered obligation',
        'unavailable'
      )
      const terms = this.terms(rawTerms),
        candidate = this.candidate(rawCandidate, terms),
        delivered = await this.authenticated(rawResult, terms, candidate, active)
      await this.ports.validation.verify(
        structuredClone(this.request),
        structuredClone(terms),
        candidate,
        delivered,
        active
      )
      this.access(active)
      let saved = await this.load()
      await this.save(saved.snapshot, { ...saved.progress, phase: 'validated' })
      const usable = await this.ports.validation.usable(structuredClone(delivered), active)
      this.access(active)
      if (usable) {
        saved = await this.load()
        await this.save(saved.snapshot, { ...saved.progress, phase: 'usable' })
        return 'usable'
      }
      return 'validated'
    })
  }
  /** Explicit free fresh currentness recovery. This never rewrites the original
   * protected grant, accepts a new secret/License, funds or submits. Historical
   * usableResult/recover remain independent when the optional report is absent
   * or the independently selected buyer chain rejects it. */
  currentAlias(
    assessor: PrivatePurchaseBuyerAliasCurrentness,
    signal?: AbortSignal
  ): Promise<PrivatePurchaseAliasCurrentnessAssessment | undefined> {
    return this.run(signal, async active => {
      this.access(active)
      outputAssert(
        this.candidateProfile === 'full-purchase-commitment-v1',
        'Buyer alias currentness requires explicit full commitment ownership',
        'unsupported'
      )
      const saved = await this.load()
      const [rawTerms, rawCandidate, rawResult] = await this.getMany([
        'terms',
        'candidate',
        'result'
      ])
      outputAssert(
        rawTerms !== undefined && rawCandidate !== undefined && rawResult !== undefined,
        'Buyer alias currentness lacks its original paid obligation',
        'unavailable'
      )
      const terms = this.terms(rawTerms),
        candidate = this.candidate(rawCandidate, terms)
      const original = await this.authenticated(rawResult, terms, candidate, active)
      outputAssert(
        original.result.status === 'delivered',
        'Buyer alias currentness requires its retained historical delivery',
        'unavailable'
      )
      const identity = await this.candidateIdentity(terms, candidate, active)
      identity.checkCurrent()
      const received = await this.sendPurchase('recover', terms, candidate, active)
      this.access(active)
      identity.checkCurrent()
      const assess = assessor.assess
      outputAssert(typeof assess === 'function', 'Buyer alias assessor is required')
      const report = await assess.call(
        assessor,
        structuredClone(this.request),
        structuredClone(terms),
        structuredClone(identity.binding),
        received,
        active
      )
      this.access(active)
      outputAssert(
        assessor.assess === assess,
        'Buyer alias assessor changed during recovery',
        'context-changed'
      )
      identity.checkCurrent()
      const latest = await this.load()
      outputAssert(
        latest.snapshot.revision === saved.snapshot.revision &&
          latest.progress.phase === saved.progress.phase,
        'Buyer alias native state changed during currentness recovery',
        'context-changed'
      )
      this.access(active)
      if (!report) return undefined
      const check = Object.getOwnPropertyDescriptor(report.placement, 'checkCurrent')?.value
      outputAssert(
        typeof check === 'function' && check.constructor.name !== 'AsyncFunction',
        'Buyer alias report requires an owned synchronous guard'
      )
      const checkCurrent = () => {
        this.access(active)
        outputAssert(
          assessor.assess === assess &&
            Object.getOwnPropertyDescriptor(report.placement, 'checkCurrent')?.value === check,
          'Buyer alias report owner changed',
          'context-changed'
        )
        identity.checkCurrent()
        const result: unknown = check.call(report.placement)
        if (result instanceof Promise) void result.catch(() => undefined)
        outputAssert(
          result === undefined,
          'Buyer alias report guard must finish synchronously',
          'context-changed'
        )
        this.access(active)
      }
      checkCurrent()
      return Object.freeze({
        ...report,
        currentAlias: Object.freeze({ ...report.currentAlias }),
        placement: Object.freeze({ checkCurrent })
      })
    })
  }
  async status(): Promise<Phase> {
    this.access(this.stopping.signal)
    const saved = await this.load()
    this.access(this.stopping.signal)
    return saved.progress.phase
  }
  usableResult(signal?: AbortSignal): Promise<OutputPurchaseEnvelope> {
    return this.run(signal, async active => {
      this.access(active)
      const saved = await this.load()
      const [rawTerms, rawCandidate, rawResult] = await this.getMany([
        'terms',
        'candidate',
        'result'
      ])
      outputAssert(
        saved.progress.phase === 'usable' &&
          rawTerms !== undefined &&
          rawCandidate !== undefined &&
          rawResult !== undefined,
        'Purchase buyer result is not usable',
        'unavailable'
      )
      const terms = this.terms(rawTerms),
        candidate = this.candidate(rawCandidate, terms),
        delivered = await this.authenticated(rawResult, terms, candidate, active)
      outputAssert(
        await this.ports.validation.usable(structuredClone(delivered), active),
        'Purchase buyer material is no longer usable',
        'unavailable'
      )
      const latest = await this.load()
      outputAssert(
        latest.snapshot.revision === saved.snapshot.revision && latest.progress.phase === 'usable',
        'Purchase buyer validation changed during read',
        'context-changed'
      )
      this.access(active)
      return delivered
    })
  }
  private run<T>(
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    let started = false
    let finish!: () => void
    const settled = new Promise<void>(resolve => {
        finish = resolve
      }),
      release = () => {
        this.physical.delete(settled)
        finish()
      }
    this.physical.add(settled)
    return this.work
      .run(
        this.request.recipient,
        signal ? AbortSignal.any([signal, this.stopping.signal]) : this.stopping.signal,
        async active => {
          started = true
          try {
            return await operation(active)
          } finally {
            release()
          }
        }
      )
      .finally(() => {
        if (!started) release()
      })
  }
  async stop(): Promise<void> {
    this.stopping.abort()
    await Promise.all(this.physical)
  }
}
function pin<T, K extends keyof T>(owner: T, key: K, optional = false): () => boolean {
  const method = owner[key]
  outputAssert(
    typeof method === 'function' || (optional && method === undefined),
    'Purchase buyer capability is required'
  )
  return () => owner[key] === method
}
function maximum(values: readonly bigint[]): bigint {
  let result = 0n
  for (const value of values) if (value > result) result = value
  return result
}
