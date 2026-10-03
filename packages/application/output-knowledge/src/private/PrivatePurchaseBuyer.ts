import {
  Hash,
  Utils,
  OUTPUT_PROFILES,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputPacketDigest,
  outputString,
  outputU64,
  parseOutputJSON,
  parseOutputPurchasePrepare,
  parseOutputPurchaseSubmit,
  restoreOutputCapability,
  selectOutputCapability,
  verifyOutputPurchaseTerms,
  verifyOutputPurchaseEnvelope,
  OutputPurchaseTransport,
  type OutputCapabilityRecoveryRequest,
  type OutputCapabilitySelection,
  type OutputJSONObject,
  type OutputPurchasePrepare,
  type OutputSignedPurchaseTerms,
  type OutputPurchaseSubmit,
  type OutputPurchaseEnvelope,
  type OutputRetainedCapability,
  type WalletInterface
} from '@bsv/sdk'
import type {
  OperationStateStore,
  OperationStateSnapshot
} from '../operations/OperationStateStore.js'
import type { ProtectedOperationObjectStore } from '../operations/ProtectedOperationObjectStore.js'
import { BoundedOutputWork, checkOutputWork } from '../internal/BoundedOutputWork.js'
import type {
  PrivatePurchaseBuyerPayment,
  PrivatePurchaseBuyerValidation
} from './PrivatePurchaseBuyerPorts.js'
const FORMAT = 'private-purchase-buyer/1'
export const PRIVATE_PURCHASE_BUYER_INITIAL: Readonly<OutputJSONObject> = Object.freeze({
  format: FORMAT,
  empty: true
})
type Role = 'request' | 'contract' | 'terms' | 'plan' | 'candidate' | 'result'
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
  const parsed = parseOutputJSON(canonicalOutputJSON(value, { bytes: maximum }), { bytes: maximum })
  outputAssert(
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed),
    'Purchase buyer record must be an object'
  )
  return parsed
}
export function privatePurchaseBuyerBinding(
  options: Pick<PrivatePurchaseBuyerOptions, 'original' | 'trust' | 'payment' | 'validation'>
): OutputJSONObject {
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
    validation: outputString(options.validation.id)
  }
}
/** Durable ownership of one original purchase. Six protected object slots are
 * reserved before preparation or financial work. Large lineage/BEEF/License
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
  private readonly configurations: string[]
  private readonly pins: (() => boolean)[]
  private readonly stopping = new AbortController()
  private readonly physical = new Set<Promise<void>>()
  private readonly work: BoundedOutputWork
  private observedAt = 0n
  private constructor(private readonly ports: PrivatePurchaseBuyerOptions) {
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
    const requestBytes = Math.min(4194304, this.selection.profile.maxRequestBytes),
      responseBytes = Math.min(4194304, this.selection.profile.maxResponseBytes)
    this.sizes = {
      request: requestBytes,
      contract: 524288,
      terms: responseBytes,
      plan: 4194304,
      candidate: requestBytes,
      result: responseBytes
    }
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
        ports.objects.configuration.maximumObjects >= 6 &&
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
      pin(ports.objects, 'put'),
      pin(ports.payment, 'plan'),
      pin(ports.payment, 'recover'),
      pin(ports.payment, 'finish'),
      pin(ports.validation, 'preflight'),
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
    await (Object.keys(buyer.sizes) as Role[]).reduce(
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
    await (Object.keys(this.sizes) as Role[]).reduce(
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
    const terms = verifyOutputPurchaseTerms(
        input,
        this.request,
        this.selection.manifest.body.identity
      ),
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
  ): Promise<void> {
    this.newWork(progress, terms, signal)
    await this.ports.validation.preflight(
      structuredClone(this.request),
      structuredClone(terms),
      signal
    )
    this.newWork(progress, terms, signal)
  }
  private transport(
    operation: 'prepare',
    terms?: never,
    candidate?: never
  ): OutputPurchaseTransport<'prepare'>
  private transport(
    operation: 'submit',
    terms: OutputSignedPurchaseTerms,
    candidate: OutputPurchaseSubmit
  ): OutputPurchaseTransport<'submit'>
  private transport(
    operation: 'recover',
    terms: OutputSignedPurchaseTerms,
    candidate?: OutputPurchaseSubmit
  ): OutputPurchaseTransport<'recover'>
  private transport(
    operation: 'prepare' | 'submit' | 'recover',
    terms?: OutputSignedPurchaseTerms,
    candidate?: OutputPurchaseSubmit
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
      return new OutputPurchaseTransport({ ...common, operation, terms, candidate })
    return new OutputPurchaseTransport({
      ...common,
      operation,
      terms,
      ...(candidate ? { candidate } : {})
    })
  }
  private async retain(
    input: OutputPurchaseEnvelope,
    terms: OutputSignedPurchaseTerms,
    candidate?: OutputPurchaseSubmit
  ): Promise<OutputPurchaseEnvelope> {
    const owned = verifyOutputPurchaseEnvelope(input, terms, candidate?.txid)
    if (owned.result.status === 'delivered') {
      await this.put('result', owned)
      const { snapshot, progress } = await this.load()
      if (!['received', 'validated', 'usable'].includes(progress.phase))
        await this.save(snapshot, { ...progress, phase: 'received' })
    }
    return owned
  }
  private async reconcile(signal: AbortSignal): Promise<OutputPurchaseEnvelope | undefined> {
    this.access(signal)
    const rawTerms = await this.get('terms')
    if (rawTerms === undefined) return undefined
    const terms = this.terms(rawTerms)
    let saved = await this.load()
    if (saved.progress.phase === 'ready') {
      await this.save(saved.snapshot, { ...saved.progress, phase: 'prepared' })
      saved = await this.load()
    }
    const retainedResult = await this.get('result')
    if (retainedResult !== undefined) {
      const rawCandidate = await this.get('candidate')
      outputAssert(
        rawCandidate !== undefined,
        'Purchase buyer delivered result lacks its original candidate',
        'unavailable'
      )
      return this.retain(
        retainedResult as unknown as OutputPurchaseEnvelope,
        terms,
        this.candidate(rawCandidate, terms)
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
      return this.retain(result as unknown as OutputPurchaseEnvelope, terms, candidate)
    const recovered = await this.transport('recover', terms, candidate).send(signal)
    this.access(signal)
    return this.retain(recovered, terms, candidate)
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
        await this.preflight(saved.progress, terms, active)
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
        await this.put('plan', plan)
      }
      if (rawCandidate === undefined) {
        await this.preflight(saved.progress, terms, active)
        saved = await this.load()
        await this.save(saved.snapshot, { ...saved.progress, phase: 'funding' })
        rawCandidate = object(
          this.candidate(
            await this.ports.payment.finish(
              structuredClone(plan),
              () => this.newWork(saved.progress, terms, active),
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
      const delivered = await this.transport('submit', terms, candidate).send(active)
      this.access(active)
      return this.retain(delivered, terms, candidate)
    })
  }
  validate(signal?: AbortSignal): Promise<'validated' | 'usable'> {
    return this.run(signal, async active => {
      this.access(active)
      const rawTerms = await this.get('terms'),
        rawCandidate = await this.get('candidate'),
        rawResult = await this.get('result')
      outputAssert(
        rawTerms !== undefined && rawCandidate !== undefined && rawResult !== undefined,
        'Purchase buyer has no complete delivered obligation',
        'unavailable'
      )
      const terms = this.terms(rawTerms),
        candidate = this.candidate(rawCandidate, terms),
        delivered = verifyOutputPurchaseEnvelope(rawResult, terms, candidate.txid)
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
  async status(): Promise<Phase> {
    this.access(this.stopping.signal)
    const saved = await this.load()
    this.access(this.stopping.signal)
    return saved.progress.phase
  }
  usableResult(signal?: AbortSignal): Promise<OutputPurchaseEnvelope> {
    return this.run(signal, async active => {
      this.access(active)
      const saved = await this.load(),
        rawTerms = await this.get('terms'),
        rawCandidate = await this.get('candidate'),
        rawResult = await this.get('result')
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
        delivered = verifyOutputPurchaseEnvelope(rawResult, terms, candidate.txid)
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
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const method = owner[key]
  outputAssert(typeof method === 'function', 'Purchase buyer capability is required')
  return () => owner[key] === method
}
function maximum(values: readonly bigint[]): bigint {
  let result = 0n
  for (const value of values) if (value > result) result = value
  return result
}
