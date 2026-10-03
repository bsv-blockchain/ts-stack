import {
  canonicalOutputJSON,
  bindOutputReleaseEvidence,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputPurchasePrepare,
  parseOutputPurchaseSubmit,
  type OutputCapabilitySelection,
  type OutputJSONObject,
  type OutputPurchasePrepare
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
import type {
  PrivatePurchaseLoaded,
  SQLitePrivatePurchaseStore
} from './SQLitePrivatePurchaseStore.js'

export interface PrivatePurchaseCoordinatorOptions {
  store: SQLitePrivatePurchaseStore
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

/** Staged durable BRC-196 orchestration. Return identifiers, never authority to
 * send plaintext retained in an earlier read. The separate physical disclosure
 * boundary authenticates/signs HTTP bytes and rechecks the native owner.
 * No wallet credit, HTTP fee, broadcast retry or GASP-triggered issuance occurs here.
 */
export class PrivatePurchaseCoordinator {
  private readonly ports: Readonly<PrivatePurchaseCoordinatorOptions>
  private readonly installed: ReturnType<PrivatePurchaseContracts['configuration']>
  private readonly policy: { id: string; digest: string }
  private readonly unchanged: readonly (() => boolean)[]
  private readonly work: BoundedOutputWork
  private readonly stopping = new AbortController()
  private readonly physical = new Set<Promise<void>>()
  constructor(options: PrivatePurchaseCoordinatorOptions) {
    this.ports = Object.freeze({ ...options })
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
      pin(options.store, 'prepare'),
      pin(options.store, 'pin'),
      pin(options.store, 'advance'),
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
      pin(options.release, 'assess')
    ]
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
        view => {
          guard(view)
          validation()
          this.ports.contracts.retain(selected.record.manifest, view.observedAt)
        }
      )
      return id
    })
  }
  submit(input: unknown, supplied: PrivatePurchaseCaller): Promise<string> {
    const caller = this.caller(supplied),
      candidate = parseOutputPurchaseSubmit(input)
    return this.run(caller, async signal => {
      const loaded = this.load(candidate.acquisitionId, caller, signal)
      outputAssert(
        loaded.progress.txid === null || loaded.progress.txid === candidate.txid,
        'Purchase is reserved for another transaction',
        'conflict'
      )
      // Even a same-txid alternate proof must be independently checked; no new
      // bytes replace the first retained candidate or create a second effect.
      const validation = this.validation(
        await this.ports.domain.verify(
          structuredClone(candidate),
          structuredClone(loaded.custody),
          signal
        )
      )
      this.requireCurrent(caller, signal)
      const guard = this.guard(candidate.acquisitionId, caller, signal, loaded.custody.original)
      this.ports.store.pin(
        candidate.acquisitionId,
        caller.buyer,
        loaded.row.revision,
        candidate,
        this.ports.clock,
        view => {
          guard(view)
          validation()
        }
      )
      await this.progress(candidate.acquisitionId, caller, signal)
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
  private async progress(
    id: string,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal
  ): Promise<void> {
    // At most prepare -> pin -> admit -> deliver. Bounded retries only absorb
    // observed native CAS progress by another authorized owner.
    await Array.from({ length: 8 }).reduce<Promise<boolean>>(
      previous =>
        previous.then(async stopped => {
          if (stopped) return true
          const loaded = this.load(id, caller, signal)
          try {
            return await this.advanceOne(loaded, caller, signal)
          } catch (error) {
            this.requireCurrent(caller, signal)
            if (
              error instanceof OutputProtocolError &&
              error.code === 'conflict' &&
              this.load(id, caller, signal).row.revision !== loaded.row.revision
            )
              return false
            throw error
          }
        }),
      Promise.resolve(false)
    )
  }
  private async advanceOne(
    loaded: PrivatePurchaseLoaded,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal
  ): Promise<boolean> {
    const progress = loaded.progress,
      id = progress.acquisitionId,
      guard = this.guard(id, caller, signal, loaded.custody.original)
    if (progress.status === 'prepared') {
      if (outputU64(loaded.observedAt) >= outputU64(progress.recoveryUntil))
        this.ports.store.advance(
          id,
          caller.buyer,
          loaded.row.revision,
          { type: 'expire' },
          this.ports.clock,
          guard
        )
      return true
    }
    if (progress.status === 'admission-pending') {
      outputAssert(loaded.candidate, 'Original purchase candidate is unavailable', 'unavailable')
      const validation = this.validation(
        await this.ports.domain.verify(
          structuredClone(loaded.candidate),
          structuredClone(loaded.custody),
          signal
        )
      )
      this.requireCurrent(caller, signal)
      validation()
      const outcome = ownPrivatePurchaseAdmissionOutcome(
        await this.ports.admission.recover(
          {
            operationId: progress.operationId!,
            original: structuredClone(loaded.custody.original),
            candidate: structuredClone(loaded.candidate)
          },
          signal,
          {
            checkCurrent: () => {
              this.requireCurrent(caller, signal)
              const current = this.ports.store.load(id, caller.buyer, this.ports.clock, view => {
                guard(view)
                validation()
              })
              outputAssert(
                current?.row.revision === loaded.row.revision,
                'Purchase intent changed before external admission',
                'conflict'
              )
              this.requireCurrent(caller, signal)
            }
          }
        )
      )
      this.requireCurrent(caller, signal)
      outputAssert(
        outcome.operationId === progress.operationId && outcome.txid === progress.txid,
        'Retained purchase admission names another operation/transaction',
        'context-changed'
      )
      if (outcome.status === 'unresolved') return true
      this.ports.store.advance(
        id,
        caller.buyer,
        loaded.row.revision,
        outcome.status === 'admitted'
          ? {
              type: 'admitted',
              steak: outcome.steak,
              acceptedAt: outcome.acceptedAt,
              assessmentContextId: outcome.assessmentContextId
            }
          : { type: 'admission-rejected', reason: outcome.reason, evidence: outcome.evidence },
        this.ports.clock,
        view => {
          guard(view)
          validation()
        }
      )
      return false
    }
    if (progress.status !== 'admitted-delivery-pending') return true
    outputAssert(loaded.candidate, 'Original purchase candidate is unavailable', 'unavailable')
    const assessment = await this.ports.release.assess(
      structuredClone(loaded.custody),
      structuredClone(progress),
      structuredClone(loaded.candidate),
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
    const secret = await this.ports.domain.issue(
      structuredClone(loaded.custody),
      structuredClone(progress),
      structuredClone(releaseEvidence),
      signal,
      structuredClone(loaded.candidate)
    )
    this.requireCurrent(caller, signal)
    decodeOutputBytes(secret, loaded.custody.maximumSecretBytes)
    checkRelease()
    const potatoesBody = {
      version: 1,
      acquisitionId: id,
      requestDigest: body.requestDigest,
      seller: body.seller,
      recipient: body.recipient,
      topic: body.topic,
      txid: progress.txid!,
      assetId: body.assetId,
      termsDigest: body.termsDigest,
      releasePolicy: body.releasePolicy,
      evidenceDigest: outputPacketDigest('release-evidence', releaseEvidence),
      schema: loaded.custody.schema,
      secret,
      issuedAt: this.ports.clock(),
      recoveryUntil: body.recoveryUntil
    }
    const potatoes = await this.ports.sign(
      'potatoes',
      structuredClone(potatoesBody) as unknown as OutputJSONObject,
      signal
    )
    this.requireCurrent(caller, signal)
    this.ports.store.complete(
      id,
      caller.buyer,
      loaded.row.revision,
      {
        result: {
          version: 1,
          acquisitionId: id,
          txid: progress.txid,
          status: 'delivered',
          steak: progress.admission!.steak,
          potatoes,
          recoveryUntil: body.recoveryUntil
        },
        releaseEvidence
      },
      this.ports.clock,
      view => {
        guard(view)
        checkRelease()
      }
    )
    return false
  }
  private load(
    id: string,
    caller: PrivatePurchaseCaller,
    signal: AbortSignal
  ): PrivatePurchaseLoaded {
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
    return (
      !signal.aborted &&
      this.unchanged.every(check => check()) &&
      permitted(caller.current()) &&
      !signal.aborted
    )
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
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const original = owner[key]
  outputAssert(typeof original === 'function', 'Purchase installed port is required')
  return () => owner[key] === original
}
function permitted(value: unknown): boolean {
  if (value instanceof Promise) {
    void value.catch(() => undefined)
    return false
  }
  return value === true
}
