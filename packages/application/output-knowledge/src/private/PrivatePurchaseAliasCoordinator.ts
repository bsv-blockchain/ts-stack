import {
  canonicalOutputJSONWithInlineRecords as canonicalOutputJSON,
  bindOutputReleaseEvidence,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigestWithInlineStrings as outputPacketDigest,
  outputString,
  OutputProtocolError,
  parseOutputPurchasePrepareWithInlineStrings as parseOutputPurchasePrepare,
  parseOutputPurchaseSubmitWithInlineStrings as parseOutputPurchaseSubmit,
  parseOutputPotatoes,
  type OutputCapabilitySelection,
  type OutputJSONObject,
  type OutputPurchasePrepare,
  type OutputPurchaseSubmit
} from '@bsv/sdk'
import { BoundedOutputWork, checkOutputWork } from '../internal/BoundedOutputWork.js'
import type {
  PrivatePurchaseContracts,
  PrivatePurchaseOriginal
} from './PrivatePurchaseContracts.js'
import {
  ownPrivatePurchasePreparation,
  ownPrivatePurchaseAdmissionOutcome,
  type PrivatePurchaseAccessPort,
  type PrivatePurchaseAdmission,
  type PrivatePurchaseCaller,
  type PrivatePurchaseDomain,
  type PrivatePurchaseRelease,
  type PrivatePurchaseValidation
} from './PrivatePurchasePorts.js'
import type { ProtectedLedgerGuard } from './ProtectedLedgerCodec.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type {
  PrivatePurchaseAliasOwner,
  PrivatePurchaseAliasedLoaded
} from './PrivatePurchaseAliasOwnerPorts.js'
import type {
  SQLitePrivatePurchaseAliases,
  PrivatePurchaseAliasWrite
} from './SQLitePrivatePurchaseAliases.js'
import type {
  PrivatePurchaseAliasCurrentness,
  PrivatePurchaseAliasCurrentnessAssessment
} from './SDKPrivatePurchaseAliasCurrentness.js'
import {
  privatePurchaseOperation,
  type PrivatePurchaseProgress
} from './PrivatePurchaseProgress.js'
import type { PrivatePurchaseCustody } from './SQLitePrivatePurchaseStore.js'
/** Ephemeral report scoped to the original native acquisition. The wire carries
 * only currentAlias; this guard rechecks domain, selected chain, authentication
 * and the native head immediately before physical disclosure. */
export interface PrivatePurchaseAliasRecoveryReport extends PrivatePurchaseAliasCurrentnessAssessment {
  readonly acquisitionId: string
  readonly purchaseCommitment: string
  readonly maximumResponseBytes: number
  readonly guard: ProtectedLedgerGuard
  checkCurrent(): void
}
export interface PrivatePurchaseAliasCoordinatorOptions {
  serviceDomain: PrivateServiceDomain
  store: PrivatePurchaseAliasOwner
  aliases: SQLitePrivatePurchaseAliases
  currentness: PrivatePurchaseAliasCurrentness
  /** Optional installed assessment of irrecoverable local material failure.
   * Ordinary issue/sign/transport errors remain pending and never call fail. */
  failure?: {
    assess(
      custody: PrivatePurchaseCustody,
      progress: PrivatePurchaseProgress,
      candidate: OutputPurchaseSubmit,
      signal: AbortSignal
    ): Promise<({ reason: string; evidence: string } & PrivatePurchaseValidation) | undefined>
  }
  contracts: PrivatePurchaseContracts
  access: PrivatePurchaseAccessPort
  domain: PrivatePurchaseDomain
  admission: PrivatePurchaseAdmission
  release: PrivatePurchaseRelease
  validationPolicy: { id: string; digest: string }
  sign(
    type: 'purchase-terms' | 'potatoes',
    body: OutputJSONObject,
    signal: AbortSignal
  ): Promise<unknown>
  manifest(): unknown
  clock(): string
  maximumWork?: number
  perBuyerWork?: number
  timeoutMs?: number
}

interface InstalledMethod {
  readonly owner: Record<PropertyKey, unknown>
  readonly key: PropertyKey
  readonly original: unknown
}

/** Explicit alias-custody companion. Legacy exact-txid coordinators remain
 * unchanged. Bitcoin/domain validation, native effect custody, admission,
 * currentness, issuance and physical HTTP disclosure retain separate authority. */
export class PrivatePurchaseAliasCoordinator {
  private readonly ports: Readonly<PrivatePurchaseAliasCoordinatorOptions>
  private readonly installed: ReturnType<PrivatePurchaseContracts['configuration']>
  private readonly policy: { id: string; digest: string }
  private readonly unchanged: readonly InstalledMethod[]
  private readonly candidateProfile = 'full-purchase-commitment-v1' as const
  private readonly work: BoundedOutputWork
  private readonly stopping = new AbortController()
  private readonly physical = new Set<Promise<void>>()
  constructor(options: PrivatePurchaseAliasCoordinatorOptions) {
    this.ports = Object.freeze({ ...options })
    options.store.installedOn(options.serviceDomain, options.contracts)
    options.aliases.installedOn(options.serviceDomain, options.contracts)
    this.installed = options.contracts.configuration()
    this.policy = {
      id: outputString(options.validationPolicy.id),
      digest: outputHex32(options.validationPolicy.digest)
    }
    outputAssert(
      typeof options.domain.isCurrent === 'function' &&
        options.domain.isCurrent.constructor.name !== 'AsyncFunction',
      'Purchase domain authority must be synchronous'
    )
    this.unchanged = [
      pin(options.store, 'load'),
      pin(options.store, 'installedOn'),
      pin(options.store, 'prepare'),
      pin(options.store, 'retain'),
      pin(options.store, 'fail'),
      pin(options.store, 'complete'),
      pin(options.contracts, 'configuration'),
      pin(options.contracts, 'retain'),
      pin(options.contracts, 'restore'),
      pin(options.contracts, 'prepare'),
      pin(options.contracts, 'authenticate'),
      pin(options.contracts, 'original'),
      pin(options.access, 'guard'),
      pin(options.domain, 'prepare'),
      pin(options.domain, 'verify'),
      pin(options.domain, 'isCurrent'),
      pin(options.domain, 'issue'),
      pin(options.admission, 'recover'),
      pin(options.release, 'assess'),
      pin(options.aliases, 'installedOn'),
      pin(options.aliases, 'configuration'),
      pin(options.aliases, 'propose'),
      pin(options.aliases, 'admission'),
      pin(options.currentness, 'assess')
    ]
    if (options.failure) this.unchanged = [...this.unchanged, pin(options.failure, 'assess')]
    for (const fn of [options.clock, options.manifest, options.sign])
      outputAssert(typeof fn === 'function', 'Purchase installation callback is required')
    this.work = new BoundedOutputWork(
      {
        invalid: 'Invalid purchase work limits',
        capacity: 'Purchase work capacity is occupied',
        cancelled: 'Purchase work cancelled',
        deadline: 'Purchase work deadline elapsed'
      },
      options.maximumWork ?? 16,
      options.perBuyerWork ?? Math.min(4, options.maximumWork ?? 16),
      options.timeoutMs ?? 30000
    )
  }
  prepare(input: unknown, supplied: PrivatePurchaseCaller): Promise<string> {
    const caller = this.caller(supplied),
      request = parseOutputPurchasePrepare(input)
    outputAssert(
      request.recipient === caller.buyer &&
        request.topic === this.installed.topic &&
        canonicalOutputJSON(request.listing.chain) === canonicalOutputJSON(this.installed.chain),
      'Purchase request differs from selected recipient/topic/chain',
      'unauthorized'
    )
    const id = outputPacketDigest('purchase', {
      chain: this.installed.chain,
      seller: this.installed.seller,
      recipient: caller.buyer,
      topic: request.topic,
      requestId: request.requestId
    })
    return this.run(caller, async signal => {
      const initial = this.ports.access.guard(
        id,
        caller.buyer,
        () => this.current(caller, signal),
        request
      )
      const prior = this.ports.store.load(id, caller.buyer, this.ports.clock, initial)
      if (prior) {
        this.selector(caller, this.ports.contracts.restore(prior.custody.original.capability))
        outputAssert(
          outputPacketDigest('purchase-request', request) === prior.progress.requestDigest,
          'Purchase request differs from its original preparation',
          'conflict'
        )
        return id
      }
      const selected = this.ports.contracts.retain(this.ports.manifest(), this.ports.clock())
      this.selector(caller, selected.selection)
      const prepared = await this.ports.domain.prepare(
        structuredClone(request),
        structuredClone(selected.selection),
        signal
      )
      this.requireCurrent(caller, signal)
      const owned = ownPrivatePurchasePreparation(prepared.preparation),
        validation = this.validation(prepared.validation)
      validation()
      const contract = this.ports.contracts.prepare(
        request,
        selected.record.manifest,
        owned.terms,
        this.ports.clock()
      )
      const signed = await this.ports.sign(
        'purchase-terms',
        structuredClone(contract.body) as unknown as OutputJSONObject,
        signal
      )
      this.requireCurrent(caller, signal)
      validation()
      const original = this.ports.contracts.authenticate(contract, signed)
      const guard = this.guard(id, caller, signal, original, request)
      const preparedGuard: ProtectedLedgerGuard = view => {
        guard(view)
        validation()
        this.ports.contracts.retain(selected.record.manifest, view.observedAt)
      }
      this.ports.store.prepare(
        {
          format: 'private-purchase-custody/1',
          original,
          validationPolicy: this.policy,
          schema: owned.schema,
          maximumSecretBytes: owned.maximumSecretBytes,
          material: owned.material
        },
        this.ports.clock,
        preparedGuard
      )
      return id
    })
  }
  submit(input: unknown, supplied: PrivatePurchaseCaller): Promise<string> {
    const caller = this.caller(supplied),
      candidate = parseOutputPurchaseSubmit(input)
    return this.run(caller, async signal => {
      const loaded = this.load(candidate.acquisitionId, caller, signal)
      const verification = await this.verifyCandidate(candidate, loaded, caller, signal)
      const assessment = await this.placement(loaded, candidate, caller, signal)
      const guard = this.guard(candidate.acquisitionId, caller, signal, loaded.custody.original)
      const proposal = this.ports.aliases.propose(
        loaded.custody.original,
        candidate,
        verification,
        assessment?.placement,
        this.ports.clock,
        guard
      )
      outputAssert(
        proposal.status === 'ready' && proposal.candidate !== undefined,
        'Alias custody is occupied by unresolved external operations',
        'limited'
      )
      // Merging BEEF can introduce evidence. Independently verify the complete
      // cumulative candidate before its first identity and raw bytes are committed.
      const combined = await this.verifyCandidate(proposal.candidate, loaded, caller, signal)
      outputAssert(
        combined.purchaseCommitment === verification.purchaseCommitment,
        'Combined alias changes the economic commitment',
        'conflict'
      )
      this.ports.store.retain(
        loaded,
        proposal,
        this.ports.clock,
        view => {
          guard(view)
          verification.checkCurrent()
          combined.checkCurrent()
          assessment?.placement.checkCurrent()
        },
        combined
      )
      await this.admitJob(candidate.acquisitionId, candidate.txid, caller, signal)
      await this.progress(candidate.acquisitionId, caller, signal, new Set([candidate.txid]))
      return candidate.acquisitionId
    })
  }
  recover(idInput: string, supplied: PrivatePurchaseCaller): Promise<string> {
    const id = outputHex32(idInput),
      caller = this.caller(supplied)
    return this.run(caller, async signal => {
      await this.progress(id, caller, signal)
      return id
    })
  }
  /** Separate optional report. Failure here never retracts, rewrites or re-gates
   * the immutable historical result returned by recover and physical disclosure. */
  currentAlias(
    idInput: string,
    supplied: PrivatePurchaseCaller
  ): Promise<PrivatePurchaseAliasRecoveryReport | undefined> {
    const id = outputHex32(idInput),
      caller = this.caller(supplied)
    return this.run(caller, async signal => {
      const loaded = this.load(id, caller, signal),
        selected = loaded.aliases.state.selected
      if (selected?.admission !== 'admitted') return undefined
      const candidate = loaded.aliases.candidates.get('selected')
      outputAssert(
        candidate?.txid === selected.txid,
        'Selected alias bytes are unavailable',
        'unavailable'
      )
      const validation = await this.verifyCandidate(candidate, loaded, caller, signal)
      const assessment = await this.placement(loaded, candidate, caller, signal)
      if (!assessment) return undefined
      const guard: ProtectedLedgerGuard = view => {
        this.requireCurrent(caller, signal)
        this.guard(id, caller, signal, loaded.custody.original)(view)
        loaded.aliases.checkCurrent(view)
        validation.checkCurrent()
        assessment.placement.checkCurrent()
        this.requireCurrent(caller, signal)
      }
      const checkCurrent = () => {
        const current = this.ports.store.load(id, caller.buyer, this.ports.clock, guard)
        outputAssert(current, 'Alias report original custody is unavailable', 'unavailable')
        this.requireCurrent(caller, signal)
      }
      checkCurrent()
      return Object.freeze({
        ...assessment,
        acquisitionId: id,
        purchaseCommitment: outputHex32(loaded.aliases.state.purchaseCommitment),
        maximumResponseBytes: this.ports.contracts.restore(loaded.custody.original.capability)
          .profile.maxResponseBytes,
        guard,
        checkCurrent
      })
    })
  }
  private async placement(
    loaded: PrivatePurchaseAliasedLoaded,
    candidate: OutputPurchaseSubmit,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal
  ): Promise<PrivatePurchaseAliasCurrentnessAssessment | undefined> {
    const assessment = await this.ports.currentness.assess(
      {
        acquisitionId: loaded.progress.acquisitionId,
        chain: structuredClone(loaded.custody.original.request.listing.chain)
      },
      structuredClone(candidate),
      signal
    )
    this.requireCurrent(caller, signal)
    if (assessment) {
      outputAssert(
        assessment.currentAlias.txid === candidate.txid &&
          assessment.currentAlias.beef === candidate.beef,
        'Alias currentness assessment changes exact evidence',
        'context-changed'
      )
      const guard = this.validation(assessment.placement)
      guard()
      return Object.freeze({
        ...assessment,
        currentAlias: Object.freeze({ txid: candidate.txid, beef: candidate.beef }),
        placement: Object.freeze({ checkCurrent: guard })
      })
    }
    return undefined
  }
  private ready(
    write: PrivatePurchaseAliasWrite
  ): Extract<PrivatePurchaseAliasWrite, { status: 'ready' }> {
    outputAssert(
      write.status === 'ready',
      'Pending alias operations require reconciliation',
      'limited'
    )
    return write
  }
  private async progress(
    id: string,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal,
    attempted: ReadonlySet<string> = new Set()
  ): Promise<void> {
    // Every retained unknown job is independent of current selection and history.
    // Bound one pass by prepaid capacity; an unresolved call cannot delete its job
    // or prevent the other retained jobs from being reconciled in the same pass.
    const initial = this.load(id, caller, signal)
    const aliases = initial.aliases.state
    const jobs = [
      ...new Set(
        [aliases.original, aliases.selected, ...aliases.unconfirmed, ...aliases.pending].flatMap(
          entry => (entry?.admission === 'pending' ? [entry.txid] : [])
        )
      )
    ]
    const capacity = this.ports.aliases.configuration()
    outputAssert(
      jobs.length <= capacity.maximumPending + capacity.maximumUnconfirmed + 2,
      'Pending alias jobs exceed installed capacity',
      'unavailable'
    )
    await this.reconcileJobs(id, jobs, caller, signal, attempted)
    for (let attempt = 0; attempt < 8; attempt++) {
      const loaded = this.load(id, caller, signal)
      if (loaded.progress.status === 'admission-pending') {
        const txid = loaded.progress.txid!
        if (jobs.includes(txid) || attempted.has(txid)) return
        await this.admitJob(id, txid, caller, signal)
        const current = this.load(id, caller, signal)
        if (current.progress.status === 'admission-pending') return
        continue
      }
      if (loaded.progress.status === 'admitted-delivery-pending') {
        if (!(await this.deliver(loaded, caller, signal))) continue
      }
      // Prepared expiry is a fresh non-consuming projection. Completed results
      // bypass chain assessment and issuance, even after catalogue withdrawal.
      return
    }
    throw new OutputProtocolError(
      'limited',
      'Concurrent alias progress requires a later retry',
      true
    )
  }
  /** The prepaid role capacity bounds this recursion. Each exact job starts
   * only after the previous job settles, preserving serial native ownership. */
  private async reconcileJobs(
    id: string,
    jobs: readonly string[],
    caller: PrivatePurchaseCaller,
    signal: AbortSignal,
    attempted: ReadonlySet<string>,
    index = 0
  ): Promise<void> {
    const txid = jobs[index]
    if (txid === undefined) return
    if (!attempted.has(txid)) await this.admitJob(id, txid, caller, signal)
    await this.reconcileJobs(id, jobs, caller, signal, attempted, index + 1)
  }
  private async admitJob(
    id: string,
    txid: string,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal
  ): Promise<void> {
    let loaded = this.load(id, caller, signal)
    const entries = [
      loaded.aliases.state.original,
      loaded.aliases.state.selected,
      loaded.aliases.state.historical,
      ...loaded.aliases.state.unconfirmed,
      ...loaded.aliases.state.pending
    ]
    if (
      entries.some(
        entry =>
          entry?.txid === txid && (entry.admission === 'admitted' || entry.admission === 'rejected')
      )
    )
      return
    const candidate = [...loaded.aliases.candidates.values()].find(value => value.txid === txid)
    outputAssert(candidate, 'Pending exact admission bytes are unavailable', 'unavailable')
    const validation = await this.verifyCandidate(candidate, loaded, caller, signal)
    const guard = this.guard(id, caller, signal, loaded.custody.original)
    const authorized: ProtectedLedgerGuard = view => {
      guard(view)
      validation.checkCurrent()
    }
    // The persistent exact job MUST precede the first external call. Its unknown
    // outcome remains durable across restart, selection changes and issued history.
    this.ready(
      this.ports.aliases.admission(
        loaded.custody.original,
        txid,
        undefined,
        this.ports.clock,
        authorized
      )
    ).retain(this.ports.clock, authorized)
    loaded = this.load(id, caller, signal)
    const operationId = privatePurchaseOperation(loaded.custody.original, txid)
    const outcome = ownPrivatePurchaseAdmissionOutcome(
      await this.ports.admission.recover(
        {
          operationId,
          original: structuredClone(loaded.custody.original),
          candidate: structuredClone(candidate)
        },
        signal,
        {
          checkCurrent: () => {
            const current = this.ports.store.load(id, caller.buyer, this.ports.clock, view => {
              authorized(view)
              loaded.aliases.checkCurrent(view)
            })
            outputAssert(
              current?.revision === loaded.revision,
              'Exact alias admission job changed before external effect',
              'conflict'
            )
          }
        }
      )
    )
    this.requireCurrent(caller, signal)
    outputAssert(
      outcome.txid === txid && outcome.operationId === operationId,
      'Alias admission returned another exact operation',
      'context-changed'
    )
    this.ready(
      this.ports.aliases.admission(
        loaded.custody.original,
        txid,
        outcome,
        this.ports.clock,
        authorized
      )
    ).retain(this.ports.clock, authorized)
  }
  private async deliver(
    loaded: PrivatePurchaseAliasedLoaded,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal
  ): Promise<boolean> {
    const progress = loaded.progress,
      id = progress.acquisitionId,
      candidate = loaded.candidate
    outputAssert(candidate, 'Admitted exact alias candidate is unavailable', 'unavailable')
    const validation = await this.verifyCandidate(candidate, loaded, caller, signal)
    const guard = this.guard(id, caller, signal, loaded.custody.original)
    const authorized: ProtectedLedgerGuard = view => {
      guard(view)
      loaded.aliases.checkCurrent(view)
      validation.checkCurrent()
    }
    // The owner compares the complete loaded native head before its atomic
    // transition. Its returned read uses the new head, so the caller's domain
    // authorization must outlive the deliberately invalidated old alias fence.
    const transitionGuard: ProtectedLedgerGuard = view => {
      guard(view)
      validation.checkCurrent()
    }
    if (this.ports.failure) {
      const failure = await this.ports.failure.assess(
        structuredClone(loaded.custody),
        structuredClone(progress),
        structuredClone(candidate),
        signal
      )
      this.requireCurrent(caller, signal)
      if (failure) {
        const check = this.validation(failure)
        const reason = outputString(Object.getOwnPropertyDescriptor(failure, 'reason')?.value),
          evidence: unknown = Object.getOwnPropertyDescriptor(failure, 'evidence')?.value
        outputAssert(typeof evidence === 'string', 'Failure assessment evidence is required')
        const current = () => {
          outputAssert(
            Object.getOwnPropertyDescriptor(failure, 'reason')?.value === reason &&
              Object.getOwnPropertyDescriptor(failure, 'evidence')?.value === evidence,
            'Failure assessment decision changed',
            'context-changed'
          )
          check()
        }
        current()
        this.ports.store.fail(loaded, { reason, evidence }, this.ports.clock, view => {
          transitionGuard(view)
          current()
        })
        return true
      }
    }
    // Before FIRST mined release, promote a freshly verified actually admitted
    // selected alias. A weak-policy history never passes through this branch again.
    const placement =
      loaded.custody.original.terms.body.releasePolicy.kind === 'mined'
        ? await this.placement(loaded, candidate, caller, signal)
        : undefined
    if (loaded.custody.original.terms.body.releasePolicy.kind === 'mined') {
      if (!placement) return true
      if (
        loaded.aliases.state.selected?.txid !== candidate.txid ||
        loaded.aliases.state.selected.admission !== 'admitted'
      ) {
        const proposal = this.ready(
          this.ports.aliases.propose(
            loaded.custody.original,
            candidate,
            validation,
            placement.placement,
            this.ports.clock,
            authorized
          )
        )
        outputAssert(
          proposal.candidate,
          'Selected cumulative alias bytes unavailable',
          'unavailable'
        )
        const combined = await this.verifyCandidate(proposal.candidate, loaded, caller, signal)
        this.ports.store.retain(loaded, proposal, this.ports.clock, transitionGuard, combined)
        // Re-read the exact newly selected admission and native head; no stale
        // observation, admission packet or guard can authorize the result writer.
        return false
      }
    }
    const assessment = await this.ports.release.assess(
      structuredClone(loaded.custody),
      structuredClone(progress),
      structuredClone(candidate),
      signal
    )
    this.requireCurrent(caller, signal)
    if (!assessment) return true
    const checkRelease = this.validation(assessment)
    const body = loaded.custody.original.terms.body,
      releaseEvidence = bindOutputReleaseEvidence(assessment.evidence, {
        chain: body.listing.chain,
        txid: progress.txid!,
        policy: body.releasePolicy
      })
    canonicalOutputJSON(releaseEvidence, { bytes: 131072 })
    checkRelease()
    validation.checkCurrent()
    this.ports.store.load(id, caller.buyer, this.ports.clock, authorized)
    const secret = await this.ports.domain.issue(
      structuredClone(loaded.custody),
      structuredClone(progress),
      structuredClone(releaseEvidence),
      signal,
      structuredClone(candidate)
    )
    this.requireCurrent(caller, signal)
    decodeOutputBytes(secret, loaded.custody.maximumSecretBytes)
    checkRelease()
    validation.checkCurrent()
    this.ports.store.load(id, caller.buyer, this.ports.clock, authorized)
    const potatoes = await this.ports.sign(
      'potatoes',
      {
        version: 1,
        acquisitionId: id,
        requestDigest: body.requestDigest,
        seller: body.seller,
        recipient: body.recipient,
        topic: body.topic,
        txid: progress.txid!,
        purchaseCommitment: progress.purchaseCommitment!,
        assetId: body.assetId,
        termsDigest: body.termsDigest,
        releasePolicy: body.releasePolicy,
        evidenceDigest: outputPacketDigest('release-evidence', releaseEvidence),
        schema: loaded.custody.schema,
        secret,
        issuedAt: this.ports.clock(),
        recoveryUntil: body.recoveryUntil
      } as unknown as OutputJSONObject,
      signal
    )
    this.requireCurrent(caller, signal)
    this.ports.store.complete(
      loaded,
      {
        result: {
          version: 1,
          acquisitionId: id,
          txid: progress.txid!,
          purchaseCommitment: progress.purchaseCommitment!,
          status: 'delivered',
          steak: progress.admission!.steak,
          potatoes: parseOutputPotatoes(potatoes),
          recoveryUntil: body.recoveryUntil
        },
        releaseEvidence
      },
      placement?.placement,
      this.ports.clock,
      view => {
        transitionGuard(view)
        checkRelease()
        placement?.placement.checkCurrent()
      }
    )
    return true
  }
  private async verifyCandidate(
    candidate: OutputPurchaseSubmit,
    loaded: PrivatePurchaseAliasedLoaded,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal
  ): Promise<PrivatePurchaseValidation> {
    const assessment = await this.ports.domain.verify(
      structuredClone(candidate),
      structuredClone(loaded.custody),
      signal
    )
    const check = this.validation(assessment)
    this.requireCurrent(caller, signal)
    if (!this.candidateProfile) {
      check()
      return { checkCurrent: check }
    }
    const commitment = outputHex32(
      Object.getOwnPropertyDescriptor(assessment, 'purchaseCommitment')?.value
    )
    const method: unknown = Object.getOwnPropertyDescriptor(assessment, 'checkCurrent')?.value
    outputAssert(
      typeof method === 'function',
      'Purchase commitment guard must be owned',
      'context-changed'
    )
    outputAssert(
      loaded.progress.purchaseCommitment === undefined ||
        loaded.progress.purchaseCommitment === commitment,
      'Purchase candidate changes the original commitment',
      'conflict'
    )
    const unchanged = () => {
      outputAssert(
        Object.getOwnPropertyDescriptor(assessment, 'purchaseCommitment')?.value === commitment &&
          Object.getOwnPropertyDescriptor(assessment, 'checkCurrent')?.value === method,
        'Verified purchase commitment changed',
        'context-changed'
      )
    }
    const guarded = () => {
      unchanged()
      check()
      unchanged()
    }
    guarded()
    return { purchaseCommitment: commitment, checkCurrent: guarded }
  }
  private load(
    id: string,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal
  ): PrivatePurchaseAliasedLoaded {
    this.requireCurrent(caller, signal)
    const guard = this.ports.access.guard(id, caller.buyer, () => this.current(caller, signal))
    const loaded = this.ports.store.load(id, caller.buyer, this.ports.clock, guard)
    outputAssert(loaded, 'Purchase not found', 'not-found')
    this.selector(caller, this.ports.contracts.restore(loaded.custody.original.capability))
    return loaded
  }
  private guard(
    id: string,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal,
    original: PrivatePurchaseOriginal,
    initial?: OutputPurchasePrepare
  ): ProtectedLedgerGuard {
    const access = this.ports.access.guard(
      id,
      caller.buyer,
      () => this.current(caller, signal),
      initial
    )
    return view => {
      access(view)
      outputAssert(
        permitted(this.ports.domain.isCurrent(structuredClone(original))),
        'Purchase domain authority changed',
        'context-changed'
      )
      this.requireCurrent(caller, signal)
    }
  }
  private validation(input: PrivatePurchaseValidation): () => void {
    outputAssert(
      input &&
        typeof input.checkCurrent === 'function' &&
        input.checkCurrent.constructor.name !== 'AsyncFunction',
      'Purchase validation guard must be synchronous'
    )
    const check = input.checkCurrent
    return () => {
      outputAssert(
        input.checkCurrent === check,
        'Purchase validation guard changed',
        'context-changed'
      )
      const result: unknown = check.call(input)
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(
        result === undefined,
        'Purchase validation guard must finish synchronously',
        'context-changed'
      )
    }
  }
  private selector(caller: PrivatePurchaseCaller, selection: OutputCapabilitySelection): void {
    outputAssert(
      caller.capability === selection.digest && caller.profile === selection.profile.id,
      'Original purchase selection differs',
      'context-changed'
    )
  }
  private caller(value: PrivatePurchaseCaller): PrivatePurchaseCaller {
    outputAssert(
      typeof value.current === 'function' && value.current.constructor.name !== 'AsyncFunction',
      'Current purchase authentication is required'
    )
    return {
      buyer: outputIdentity(value.buyer),
      capability: outputHex32(value.capability),
      profile: outputString(value.profile),
      current: value.current,
      signal: value.signal
    }
  }
  private current(caller: PrivatePurchaseCaller, signal: AbortSignal): boolean {
    if (signal.aborted || caller.signal?.aborted) return false
    for (const method of this.unchanged) {
      // Read each installed property afresh, retaining its original order.
      if (method.owner[method.key] !== method.original) return false
    }
    return permitted(caller.current()) && !signal.aborted
  }
  private requireCurrent(caller: PrivatePurchaseCaller, signal: AbortSignal): void {
    checkOutputWork(signal, 'Purchase work cancelled')
    outputAssert(
      this.current(caller, signal),
      'Purchase owner/authentication changed',
      'context-changed'
    )
  }
  private run<T>(
    caller: PrivatePurchaseCaller,
    operation: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    let started = false,
      finish: () => void = () => {}
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
        caller.buyer,
        caller.signal
          ? AbortSignal.any([caller.signal, this.stopping.signal])
          : this.stopping.signal,
        async signal => {
          started = true
          try {
            this.requireCurrent(caller, signal)
            return await operation(signal)
          } finally {
            release()
          }
        }
      )
      .finally(() => {
        if (!started) release()
      })
  }
  async drainReconciliation(): Promise<void> {
    await Promise.all(this.physical)
  }
  async stop(): Promise<void> {
    this.stopping.abort()
    await this.drainReconciliation()
  }
}
function pin<T extends object, K extends keyof T>(owner: T, key: K): InstalledMethod {
  const original = owner[key]
  outputAssert(typeof original === 'function', 'Purchase installed port is required')
  // Installation metadata contains expected identities, never a currentness verdict.
  return Object.freeze({ owner: owner as Record<PropertyKey, unknown>, key, original })
}
function permitted(value: unknown): boolean {
  if (value instanceof Promise) {
    void value.catch(() => undefined)
    return false
  }
  return value === true
}
