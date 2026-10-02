import {
  Hash,
  Utils,
  bindOutputPaidLookupAcquired,
  bindOutputPaidLookupChallenge,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputPacketDigest,
  outputString,
  outputU64,
  OutputPaidLookupTransport,
  OutputPaidLookupServiceError,
  parseOutputJSON,
  parseOutputPaidLookupAcquire,
  parseOutputPaidLookupPayment,
  restoreOutputCapability,
  selectOutputCapability,
  type OutputCapabilityRecoveryRequest,
  type OutputCapabilitySelection,
  type OutputJSONObject,
  type OutputPaidLookupAcquired,
  type OutputPaidLookupChallenge,
  type OutputPaidLookupPayment,
  type OutputRetainedCapability,
  type WalletInterface
} from '@bsv/sdk'
import type {
  OperationStateSnapshot,
  OperationStateStore
} from '../operations/OperationStateStore.js'
import type { ProtectedOperationObjectStore } from '../operations/ProtectedOperationObjectStore.js'
import { BoundedOutputWork, checkOutputWork } from '../internal/BoundedOutputWork.js'
import type {
  PrivateLookupBuyerPayment,
  PrivateLookupBuyerValidation
} from './PrivateLookupBuyerPorts.js'

const FORMAT = 'private-lookup-buyer/1'
export const PRIVATE_LOOKUP_BUYER_INITIAL: Readonly<OutputJSONObject> = Object.freeze({
  format: FORMAT,
  empty: true
})
type Role = 'request' | 'contract' | 'plan' | 'payment' | 'result'
type Phase = 'ready' | 'quoted' | 'funding' | 'paid' | 'received' | 'validated' | 'usable'
interface Progress {
  format: typeof FORMAT
  binding: string
  phase: Phase
  quoteAttempted: boolean
  payAttempted: boolean
  challenge: OutputPaidLookupChallenge | null
  observedAt: string
}
export interface PrivateLookupBuyerOptions {
  /** Original local inputs must survive independently of discovery and HTTP. */
  original: { contract: unknown; request: unknown; derivationSuffix: string }
  trust: OutputCapabilityRecoveryRequest
  state: OperationStateStore
  objects: ProtectedOperationObjectStore
  payment: PrivateLookupBuyerPayment
  validation: PrivateLookupBuyerValidation
  wallet: WalletInterface
  clock(): string
  /** Current local access. New payment also requires the original quote deadline. */
  current(): boolean
  fetch?: typeof fetch
  timeoutMs?: number
}
function buyerDigest(domain: string, input: unknown): string {
  return Utils.toHex(
    Hash.sha256(Utils.toArray(FORMAT + '\0' + domain + '\0' + canonicalOutputJSON(input), 'utf8'))
  )
}
function object(input: unknown, maximum = 4194304): OutputJSONObject {
  const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: maximum }), { bytes: maximum })
  outputAssert(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'Buyer record must be an object'
  )
  return value
}
/** Stable public installation binding; contains no request or delivered plaintext. */
export function privateLookupBuyerBinding(
  options: Pick<PrivateLookupBuyerOptions, 'original' | 'trust' | 'payment' | 'validation'>
): OutputJSONObject {
  const selection = restoreOutputCapability(options.original.contract, options.trust),
    request = parseOutputPaidLookupAcquire(
      options.original.request,
      options.trust.supportedExtensions
    )
  outputAssert(
    request.service === selection.service.name &&
      canonicalOutputJSON(request.listing.chain) ===
        canonicalOutputJSON(selection.manifest.body.chain),
    'Buyer request differs from original selection',
    'context-changed'
  )
  const suffix = options.original.derivationSuffix
  // The wire codec checks the exact same suffix before any financial work.
  parseOutputPaidLookupPayment({
    derivationPrefix: 'original',
    derivationSuffix: suffix,
    transaction: ''
  })
  return {
    format: FORMAT,
    acquisitionId: outputPacketDigest('acquisition', {
      chain: request.listing.chain,
      seller: selection.manifest.body.identity,
      buyer: request.recipient,
      service: request.service,
      requestId: request.requestId
    }),
    capability: selection.digest,
    request: outputPacketDigest('acquire-request', request),
    contract: buyerDigest('buyer-contract', object(options.original.contract, 524288)),
    suffix: buyerDigest('buyer-suffix', { value: suffix }),
    payment: object(options.payment.configuration, 16384),
    validation: outputString(options.validation.id)
  }
}
/**
 * One durable buyer. Every financial action and response stays attached to its
 * original seller and request. initialize reserves all slots; open only reads.
 * recover never prepares, signs or dispatches payment. advance is explicit new
 * work, while validate independently promotes received material to usable.
 * The installed payment owner supplies cross-process action idempotence.
 */
export class PrivateLookupBuyer {
  private readonly binding: OutputJSONObject
  private readonly digest: string
  private readonly selection: OutputCapabilitySelection
  private readonly request: ReturnType<typeof parseOutputPaidLookupAcquire>
  private readonly contract: OutputRetainedCapability
  private readonly suffix: string
  private readonly trust: OutputCapabilityRecoveryRequest
  private readonly sizes: Record<Role, number>
  private readonly configurations: string[]
  private readonly pins: (() => boolean)[]
  private readonly stopping = new AbortController()
  private readonly work: BoundedOutputWork
  private readonly physical = new Set<Promise<void>>()
  private constructor(private readonly ports: PrivateLookupBuyerOptions) {
    this.trust = {
      ...ports.trust,
      chain: structuredClone(ports.trust.chain),
      rules: new Map(ports.trust.rules),
      supportedExtensions: [...(ports.trust.supportedExtensions ?? [])]
    }
    this.binding = privateLookupBuyerBinding({ ...ports, trust: this.trust })
    this.digest = buyerDigest('buyer-installation', this.binding)
    this.selection = restoreOutputCapability(ports.original.contract, this.trust)
    this.request = parseOutputPaidLookupAcquire(
      ports.original.request,
      this.trust.supportedExtensions
    )
    this.contract = object(ports.original.contract, 524288) as unknown as OutputRetainedCapability
    this.suffix = ports.original.derivationSuffix
    this.sizes = {
      request: Math.min(4194304, this.selection.profile.maxRequestBytes),
      contract: 524288,
      plan: 65536,
      payment: 98304,
      result: Math.min(4194304, this.selection.profile.maxResponseBytes)
    }
    outputAssert(
      ports.state.durability === 'durable' && ports.objects.durability === 'durable',
      'Buyer requires durable protected owners',
      'unsupported'
    )
    outputAssert(
      canonicalOutputJSON(ports.state.configuration.binding) ===
        canonicalOutputJSON(this.binding) &&
        canonicalOutputJSON(ports.objects.configuration.binding) ===
          canonicalOutputJSON(this.binding) &&
        ports.objects.configuration.recipient === this.request.recipient,
      'Buyer storage binding differs',
      'context-changed'
    )
    outputAssert(
      ports.state.configuration.limits.stateBytes >= 16384 &&
        ports.objects.configuration.maximumObjects >= 5 &&
        ports.objects.configuration.maximumObjectBytes >= Math.max(...Object.values(this.sizes)),
      'Buyer lacks complete logical reservation',
      'limited'
    )
    outputAssert(
      typeof ports.current === 'function' && ports.current.constructor.name !== 'AsyncFunction',
      'Buyer access must be synchronous'
    )
    this.configurations = [
      canonicalOutputJSON(ports.state.configuration),
      canonicalOutputJSON(ports.objects.configuration),
      canonicalOutputJSON(ports.payment.configuration),
      ports.validation.id
    ]
    this.pins = [
      pin(ports.state, 'read'),
      pin(ports.state, 'compareAndSwap'),
      pin(ports.objects, 'read'),
      pin(ports.objects, 'reserve'),
      pin(ports.objects, 'put'),
      pin(ports.payment, 'plan'),
      pin(ports.payment, 'recover'),
      pin(ports.payment, 'finish'),
      pin(ports.validation, 'verify'),
      pin(ports.validation, 'usable')
    ]
    this.work = new BoundedOutputWork(
      {
        invalid: 'Invalid buyer work limits',
        capacity: 'Original buyer work is still active',
        cancelled: 'Buyer work cancelled',
        deadline: 'Buyer work deadline'
      },
      1,
      1,
      ports.timeoutMs ?? 30000
    )
  }
  static async initialize(options: PrivateLookupBuyerOptions): Promise<PrivateLookupBuyer> {
    const buyer = new PrivateLookupBuyer(options)
    for (const role of Object.keys(buyer.sizes) as Role[])
      await options.objects.reserve(buyer.id(role), buyer.role(role), buyer.sizes[role])
    await buyer.put('request', buyer.request)
    await buyer.put('contract', buyer.contract)
    const saved = await options.state.read()
    if (canonicalOutputJSON(saved.value) === canonicalOutputJSON(PRIVATE_LOOKUP_BUYER_INITIAL)) {
      const now = outputU64(options.clock()).toString()
      await buyer.save(saved, {
        format: FORMAT,
        binding: buyer.digest,
        phase: 'ready',
        quoteAttempted: false,
        payAttempted: false,
        challenge: null,
        observedAt: now
      })
    }
    await buyer.initialized()
    return buyer
  }
  static async open(options: PrivateLookupBuyerOptions): Promise<PrivateLookupBuyer> {
    const buyer = new PrivateLookupBuyer(options)
    await buyer.initialized()
    return buyer
  }
  private async initialized(): Promise<void> {
    await this.load()
    for (const role of Object.keys(this.sizes) as Role[]) {
      const saved = await this.ports.objects.read(this.id(role), this.role(role))
      outputAssert(
        saved.state !== 'absent' &&
          (saved.state === 'stored'
            ? saved.receipt.maximumBytes
            : saved.reservation.maximumBytes) === this.sizes[role],
        'Buyer original reservation is missing',
        'unavailable'
      )
    }
    outputAssert(
      canonicalOutputJSON(await this.get('request')) === canonicalOutputJSON(this.request) &&
        canonicalOutputJSON(await this.get('contract')) === canonicalOutputJSON(this.contract),
      'Buyer original custody differs',
      'context-changed'
    )
    this.installed()
  }
  private id(role: Role): string {
    return buyerDigest('buyer-object', { binding: this.digest, role })
  }
  private role(role: Role): OutputJSONObject {
    return { format: FORMAT, binding: this.digest, role }
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
    outputAssert(saved.state !== 'absent', 'Buyer original object slot disappeared', 'unavailable')
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
  private installed(): void {
    const current = [
      canonicalOutputJSON(this.ports.state.configuration),
      canonicalOutputJSON(this.ports.objects.configuration),
      canonicalOutputJSON(this.ports.payment.configuration),
      this.ports.validation.id
    ]
    outputAssert(
      this.pins.every(check => check()) &&
        current.every((value, index) => value === this.configurations[index]),
      'Buyer installed capability changed',
      'context-changed'
    )
  }
  private access(signal: AbortSignal): void {
    this.installed()
    checkOutputWork(signal, 'Buyer work cancelled')
    const allowed: unknown = this.ports.current()
    if (allowed instanceof Promise) void allowed.catch(() => undefined)
    outputAssert(allowed === true, 'Buyer access changed', 'unauthorized')
  }
  private async load(): Promise<{ snapshot: OperationStateSnapshot; progress: Progress }> {
    const snapshot = await this.ports.state.read()
    this.installed()
    const value = snapshot.value
    closedOutputObject(value, [
      'format',
      'binding',
      'phase',
      'quoteAttempted',
      'payAttempted',
      'challenge',
      'observedAt'
    ])
    outputAssert(
      value.format === FORMAT &&
        value.binding === this.digest &&
        ['ready', 'quoted', 'funding', 'paid', 'received', 'validated', 'usable'].includes(
          value.phase as string
        ) &&
        typeof value.quoteAttempted === 'boolean' &&
        typeof value.payAttempted === 'boolean',
      'Buyer control state differs',
      'unavailable'
    )
    const progress = {
      ...value,
      observedAt: outputU64(value.observedAt).toString(),
      challenge: value.challenge === null ? null : this.challenge(value.challenge)
    } as unknown as Progress
    outputAssert(
      (progress.phase === 'ready') === (progress.challenge === null) &&
        (!progress.payAttempted ||
          ['paid', 'received', 'validated', 'usable'].includes(progress.phase)),
      'Buyer progress is inconsistent',
      'unavailable'
    )
    return { snapshot, progress }
  }
  private async save(snapshot: OperationStateSnapshot, progress: Progress): Promise<void> {
    this.installed()
    const result = await this.ports.state.compareAndSwap(snapshot.revision, object(progress, 16384))
    this.installed()
    outputAssert(result.status !== 'conflict', 'Buyer advanced in another owner', 'conflict')
  }
  private challenge(input: unknown): OutputPaidLookupChallenge {
    const challenge = bindOutputPaidLookupChallenge(
      input,
      this.request,
      {
        seller: this.selection.manifest.body.identity,
        rulesDigest: this.selection.service.rulesDigest
      },
      this.trust.supportedExtensions
    )
    outputAssert(
      canonicalOutputJSON(challenge.acceptancePolicy) ===
        canonicalOutputJSON(this.selection.profile.parameters.acceptancePolicy) &&
        outputU64(challenge.recoveryUntil) - outputU64(challenge.payableUntil) >=
          outputU64(this.selection.profile.parameters.recoverySeconds),
      'Buyer quote changed selected release terms',
      'context-changed'
    )
    return challenge
  }
  private newWork(progress: Progress, signal: AbortSignal): void {
    this.access(signal)
    const now = outputU64(this.ports.clock())
    outputAssert(
      now >= outputU64(progress.observedAt),
      'Buyer clock moved backwards',
      'context-changed'
    )
    if (progress.challenge)
      outputAssert(
        now < outputU64(progress.challenge.payableUntil),
        'Original payment deadline elapsed',
        'expired'
      )
    else
      selectOutputCapability(this.contract.manifest, {
        ...this.trust,
        ...this.contract.freshness,
        now: now.toString()
      })
  }
  private transport(
    operation: 'quote' | 'pay' | 'recover',
    challenge: OutputPaidLookupChallenge | null,
    payment?: OutputPaidLookupPayment
  ) {
    const common = {
      contract: this.contract,
      trust: this.trust,
      request: this.request,
      wallet: this.ports.wallet,
      fetch: this.ports.fetch,
      requestTimeoutMs: this.ports.timeoutMs
    }
    if (operation === 'quote') return new OutputPaidLookupTransport({ ...common, operation })
    if (operation === 'pay')
      return new OutputPaidLookupTransport({ ...common, operation, challenge, payment })
    return new OutputPaidLookupTransport({
      ...common,
      operation,
      ...(challenge ? { challenge } : {})
    })
  }
  private async retain(response: OutputPaidLookupAcquired): Promise<void> {
    const { snapshot, progress } = await this.load(),
      challenge = progress.challenge ?? this.challenge(response.challenge),
      owned = bindOutputPaidLookupAcquired(
        response,
        challenge,
        this.request,
        {
          seller: this.selection.manifest.body.identity,
          rulesDigest: this.selection.service.rulesDigest
        },
        this.trust.supportedExtensions
      )
    if (owned.status === 'delivered') {
      await this.put('result', owned)
      if (!['received', 'validated', 'usable'].includes(progress.phase)) progress.phase = 'received'
    } else if (progress.phase === 'ready') progress.phase = 'quoted'
    progress.challenge = challenge
    progress.observedAt = (
      outputU64(this.ports.clock()) > outputU64(progress.observedAt)
        ? outputU64(this.ports.clock())
        : outputU64(progress.observedAt)
    ).toString()
    await this.save(snapshot, progress)
  }
  private async reconcile(signal: AbortSignal): Promise<OutputPaidLookupAcquired | undefined> {
    this.access(signal)
    const savedResult = await this.get('result')
    if (savedResult !== undefined) {
      const progress = (await this.load()).progress,
        response = bindOutputPaidLookupAcquired(
          savedResult,
          progress.challenge ?? this.challenge(savedResult.challenge),
          this.request,
          {
            seller: this.selection.manifest.body.identity,
            rulesDigest: this.selection.service.rulesDigest
          },
          this.trust.supportedExtensions
        )
      await this.retain(response)
      return response
    }
    let { snapshot, progress } = await this.load()
    const plan = await this.get('plan')
    if (plan !== undefined) {
      const outcome = await this.ports.payment.recover(plan, signal)
      if (outcome.state === 'finalized') {
        await this.put('payment', parseOutputPaidLookupPayment(outcome.payment))
        if (progress.phase === 'funding' || progress.phase === 'quoted') {
          progress.phase = 'paid'
          await this.save(snapshot, progress)
          ;({ snapshot, progress } = await this.load())
        }
      }
    }
    if (!progress.quoteAttempted) return undefined
    try {
      const response = await this.transport('recover', progress.challenge).send(signal)
      outputAssert('status' in response, 'Buyer recovery returned a challenge')
      await this.retain(response)
      return response
    } catch (error) {
      if (
        error instanceof OutputPaidLookupServiceError &&
        error.code === 'not-found' &&
        progress.phase === 'ready'
      )
        return undefined
      throw error
    }
  }
  /** Original status and wallet recovery only. Never dispatches a payment header. */
  recover(signal?: AbortSignal): Promise<OutputPaidLookupAcquired | undefined> {
    return this.run(signal, async active => {
      const result = await this.reconcile(active)
      this.access(active)
      return result
    })
  }
  /** Explicit consent to finish the original payment and send its exact retained bytes. */
  advance(signal?: AbortSignal): Promise<OutputPaidLookupAcquired | undefined> {
    return this.run(signal, async active => {
      const recovered = await this.reconcile(active)
      if (recovered && recovered.status !== 'quoted') {
        this.access(active)
        return recovered
      }
      let { snapshot, progress } = await this.load()
      if (!progress.challenge) {
        this.newWork(progress, active)
        progress.quoteAttempted = true
        await this.save(snapshot, progress)
        this.newWork(progress, active)
        const quote = await this.transport('quote', null).send(active)
        outputAssert('kind' in quote, 'Buyer quote returned wrong operation')
        if (quote.kind === 'status') {
          await this.retain(quote.response)
          return quote.response
        }
        const latest = await this.load()
        await this.save(latest.snapshot, {
          ...latest.progress,
          phase: 'quoted',
          challenge: this.challenge(quote.challenge)
        })
        ;({ snapshot, progress } = await this.load())
      }
      let plan = await this.get('plan')
      if (plan === undefined) {
        this.newWork(progress, active)
        plan = object(
          await this.ports.payment.plan(
            buyerDigest('buyer-action', this.binding),
            progress.challenge!,
            this.suffix,
            active
          ),
          65536
        )
        await this.put('plan', plan)
      }
      let payment = await this.get('payment')
      if (payment === undefined) {
        this.newWork(progress, active)
        await this.save(snapshot, { ...progress, phase: 'funding' })
        const finalized = await this.ports.payment.finish(
          plan,
          () => this.newWork(progress, active),
          active
        )
        payment = object(parseOutputPaidLookupPayment(finalized), 98304)
        await this.put('payment', payment)
        const latest = await this.load()
        await this.save(latest.snapshot, { ...latest.progress, phase: 'paid' })
      }
      const latest = await this.load()
      this.newWork(latest.progress, active)
      await this.save(latest.snapshot, { ...latest.progress, payAttempted: true })
      this.newWork(latest.progress, active)
      const response = await this.transport(
        'pay',
        latest.progress.challenge,
        parseOutputPaidLookupPayment(payment)
      ).send(active)
      outputAssert('status' in response, 'Buyer payment returned wrong operation')
      await this.retain(response)
      this.access(active)
      return response
    })
  }
  /** A seller report is retained before the installed independent verifier runs. */
  validate(signal?: AbortSignal): Promise<'validated' | 'usable'> {
    return this.run(signal, async active => {
      this.access(active)
      const { snapshot, progress } = await this.load(),
        raw = await this.get('result'),
        payment = await this.get('payment')
      outputAssert(
        raw !== undefined && payment !== undefined && progress.challenge !== null,
        'Buyer has no complete delivered obligation',
        'unavailable'
      )
      const delivered = bindOutputPaidLookupAcquired(
        raw,
        progress.challenge,
        this.request,
        {
          seller: this.selection.manifest.body.identity,
          rulesDigest: this.selection.service.rulesDigest
        },
        this.trust.supportedExtensions
      )
      await this.ports.validation.verify(
        structuredClone(this.request),
        structuredClone(progress.challenge),
        parseOutputPaidLookupPayment(payment),
        delivered,
        active
      )
      this.access(active)
      await this.save(snapshot, { ...progress, phase: 'validated' })
      if (await this.ports.validation.usable(structuredClone(delivered), active)) {
        this.access(active)
        const latest = await this.load()
        await this.save(latest.snapshot, { ...latest.progress, phase: 'usable' })
        return 'usable'
      }
      this.access(active)
      return 'validated'
    })
  }
  async status(): Promise<Phase> {
    this.access(this.stopping.signal)
    const saved = await this.load()
    this.access(this.stopping.signal)
    return saved.progress.phase
  }
  /** Return the immutable first result only after current independent validation. */
  usableResult(signal?: AbortSignal): Promise<OutputPaidLookupAcquired> {
    return this.run(signal, async active => {
      this.access(active)
      const saved = await this.load(),
        raw = await this.get('result')
      outputAssert(
        saved.progress.phase === 'usable' && raw !== undefined && saved.progress.challenge !== null,
        'Buyer result is not usable',
        'unavailable'
      )
      const delivered = bindOutputPaidLookupAcquired(
        raw,
        saved.progress.challenge,
        this.request,
        {
          seller: this.selection.manifest.body.identity,
          rulesDigest: this.selection.service.rulesDigest
        },
        this.trust.supportedExtensions
      )
      outputAssert(
        await this.ports.validation.usable(structuredClone(delivered), active),
        'Buyer material is no longer usable',
        'unavailable'
      )
      const current = await this.load()
      outputAssert(
        current.snapshot.revision === saved.snapshot.revision &&
          current.progress.phase === 'usable',
        'Buyer validation changed during read',
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
    let started = false,
      finish = () => {}
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
  /** Drain physical calls before closing either independently owned store. */
  async stop(): Promise<void> {
    this.stopping.abort()
    await Promise.all(this.physical)
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const method = owner[key]
  outputAssert(typeof method === 'function', 'Buyer capability is required')
  return () => owner[key] === method
}
