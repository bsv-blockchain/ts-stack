import {
  canonicalOutputJSON,
  decodeOutputBytes,
  Hash,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputPaidLookupAcquire,
  parseOutputPaidLookupPayment,
  type OutputCapabilitySelection
} from '@bsv/sdk'
import { Utils } from '@bsv/sdk'
import { BoundedOutputWork, checkOutputWork } from '../internal/BoundedOutputWork.js'
import { SDKEvidenceVerifier } from '../SDKEvidenceVerifier.js'
import { parseVerificationContext } from '../validation.js'
import type { ProtectedLedgerGuard } from './ProtectedLedgerCodec.js'
import { PrivateAcquisitionAccess } from './PrivateAcquisitionAccess.js'
import { PrivateAcquisitionContracts } from './PrivateAcquisitionContracts.js'
import {
  ownPrivateAcquisitionPreparation,
  type PrivateAcquisitionCaller,
  type PrivateAcquisitionDomain,
  type PrivateAcquisitionRelease
} from './PrivateAcquisitionPorts.js'
import { SDKPrivateAcquisitionFunding } from './SDKPrivateAcquisitionFunding.js'
import { SQLitePrivateAcquisitionStore } from './SQLitePrivateAcquisitionStore.js'
import type { PrivateAcquisitionWallet } from './PrivateAcquisitionWallet.js'
import type { PrivateAcquisitionOriginal } from './PrivateAcquisitionRecords.js'

import type { PrivateAcquisitionWork } from './PrivateAcquisitionWork.js'

type Loaded = NonNullable<ReturnType<SQLitePrivateAcquisitionStore['load']>>
export interface PrivateAcquisitionCoordinatorOptions {
  store: SQLitePrivateAcquisitionStore
  contracts: PrivateAcquisitionContracts
  access: PrivateAcquisitionAccess
  listing: Pick<SDKEvidenceVerifier, 'verify'>
  funding: Pick<SDKPrivateAcquisitionFunding, 'verify'>
  wallet: PrivateAcquisitionWallet
  domain: PrivateAcquisitionDomain
  release: PrivateAcquisitionRelease
  validationPolicy: { id: string; digest: string }
  manifest(): unknown
  clock(): string
  supportedExtensions?: readonly string[]
  maximumWork?: number
  perBuyerWork?: number
  timeoutMs?: number
  /** Explicit local recovery authority; omitted disables background enumeration. */
  recovery?: PrivateAcquisitionWork
}

/**
 * Selected-host paid acquisition coordinator. A native pending operation always
 * precedes wallet work; status reconciliation precedes any retry of that exact
 * operation. Return values are identifiers for the separate guarded disclosure
 * boundary, never authority to send retained private material directly.
 */
export class PrivateAcquisitionCoordinator {
  private readonly ports: Readonly<PrivateAcquisitionCoordinatorOptions>
  private readonly installed: ReturnType<PrivateAcquisitionContracts['configuration']>
  private readonly extensions: readonly string[]
  private readonly policy: { id: string; digest: string }
  private readonly identities: readonly (() => boolean)[]
  private readonly work: BoundedOutputWork
  private readonly stopping = new AbortController()
  private readonly physical = new Set<Promise<void>>()
  constructor(options: PrivateAcquisitionCoordinatorOptions) {
    this.ports = Object.freeze({ ...options })
    this.installed = options.contracts.configuration()
    this.extensions = [...(options.supportedExtensions ?? [])]
    this.policy = {
      id: outputString(options.validationPolicy.id),
      digest: outputHex32(options.validationPolicy.digest)
    }
    for (const fn of [options.clock, options.manifest])
      outputAssert(typeof fn === 'function', 'Acquisition installation callback is required')
    outputAssert(
      options.domain.isCurrent.constructor.name !== 'AsyncFunction',
      'Acquisition domain authority must be synchronous'
    )
    this.work = new BoundedOutputWork(
      {
        invalid: 'Invalid acquisition work limits',
        capacity: 'Acquisition work capacity is occupied',
        cancelled: 'Acquisition work cancelled',
        deadline: 'Acquisition work deadline elapsed'
      },
      options.maximumWork ?? 16,
      options.perBuyerWork ?? Math.min(4, options.maximumWork ?? 16),
      options.timeoutMs ?? 30000
    )
    this.identities = [
      pin(options.store, 'load'),
      pin(options.store, 'quote'),
      pin(options.store, 'advance'),
      pin(options.store, 'material'),
      pin(options.store, 'complete'),
      pin(options.contracts, 'configuration'),
      pin(options.contracts, 'retain'),
      pin(options.contracts, 'restore'),
      pin(options.contracts, 'prepare'),
      pin(options.access, 'guard'),
      pin(options.listing, 'verify'),
      pin(options.funding, 'verify'),
      pin(options.wallet, 'status'),
      pin(options.wallet, 'internalize'),
      pin(options.domain, 'prepare'),
      pin(options.domain, 'validate'),
      pin(options.domain, 'isCurrent'),
      pin(options.domain, 'issue'),
      pin(options.release, 'assess'),
      ...(options.recovery
        ? [
            pin(options.recovery, 'isCurrent'),
            pin(options.recovery, 'scan'),
            pin(options.recovery, 'resolve')
          ]
        : [])
    ]
  }
  acquire(
    input: unknown,
    paymentInput: unknown,
    caller: PrivateAcquisitionCaller
  ): Promise<string> {
    const trusted = this.caller(caller),
      request = parseOutputPaidLookupAcquire(input, this.extensions)
    const payment =
      paymentInput === undefined ? undefined : parseOutputPaidLookupPayment(paymentInput)
    outputAssert(
      request.recipient === trusted.buyer &&
        request.service === this.installed.service &&
        canonicalOutputJSON(request.listing.chain) === canonicalOutputJSON(this.installed.chain),
      'Acquisition request differs from selected service',
      'unauthorized'
    )
    const id = outputPacketDigest('acquisition', {
      chain: this.installed.chain,
      seller: this.installed.seller,
      buyer: trusted.buyer,
      service: request.service,
      requestId: request.requestId
    })
    return this.run(trusted, async signal => {
      const guard = this.ports.access.guard(
        id,
        trusted.buyer,
        () => this.current(trusted, signal),
        request
      )
      let loaded = this.ports.store.load(id, trusted.buyer, this.ports.clock, guard)
      if (!loaded) {
        outputAssert(
          payment === undefined,
          'Payment requires its retained original acquisition',
          'not-found'
        )
        const now = this.ports.clock(),
          selected = this.ports.contracts.retain(this.ports.manifest(), now)
        this.selector(trusted, selected.selection)
        const preparation = await this.ports.domain.prepare(
          structuredClone(request),
          selected.selection,
          signal
        )
        this.requireCurrent(trusted, signal)
        const owned = ownPrivateAcquisitionPreparation(preparation)
        owned.verificationContext = parseVerificationContext(owned.verificationContext)
        outputAssert(
          owned.evidence.txid === request.listing.txid &&
            owned.evidence.outputIndex === request.listing.outputIndex,
          'Acquisition listing evidence names another output'
        )
        const verified = await this.ports.listing.verify(
          {
            chain: request.listing.chain,
            evidence: owned.evidence,
            variantId: Utils.toHex(Hash.sha256(decodeOutputBytes(owned.evidence.beef)))
          },
          owned.verificationContext,
          signal
        )
        this.requireCurrent(trusted, signal)
        if (verified.status !== 'verified')
          throw new OutputProtocolError(
            verified.status === 'unresolved' ? 'unavailable' : verified.status,
            `Acquisition listing verification ${verified.status}`
          )
        await this.ports.domain.validate(structuredClone(request), structuredClone(owned), signal)
        this.requireCurrent(trusted, signal)
        const quote = this.ports.contracts.prepare(
          request,
          selected.record.manifest,
          owned.terms,
          this.ports.clock()
        )
        const original: PrivateAcquisitionOriginal = {
          format: 'private-acquisition-original/1',
          request: quote.request,
          challenge: quote.challenge,
          capability: quote.capability,
          evidence: owned.evidence,
          verificationContext: owned.verificationContext,
          validationPolicy: this.policy,
          schema: owned.schema,
          maximumContextBytes: owned.maximumContextBytes,
          maximumAcceptanceBytes: owned.maximumAcceptanceBytes
        }
        const nativeGuard = this.guard(id, trusted, signal, original, request)
        loaded = this.ports.store.quote(original, owned.material, this.ports.clock, view => {
          nativeGuard(view)
          this.ports.contracts.retain(selected.record.manifest, view.observedAt)
        })
      }
      this.selector(trusted, this.ports.contracts.restore(loaded.original.capability))
      outputAssert(
        outputPacketDigest('acquire-request', request) === loaded.original.challenge.requestDigest,
        'Acquisition request differs from its original invoice',
        'conflict'
      )
      if (payment !== undefined)
        this.ports.store.advance(
          id,
          trusted.buyer,
          loaded.row.revision,
          { type: 'pin', payment },
          this.ports.clock,
          this.guard(id, trusted, signal, loaded.original)
        )
      await this.progress(id, trusted, signal)
      return id
    })
  }
  recover(acquisitionId: string, caller: PrivateAcquisitionCaller): Promise<string> {
    const trusted = this.caller(caller),
      id = outputHex32(acquisitionId)
    return this.run(trusted, async signal => {
      await this.progress(id, trusted, signal)
      return id
    })
  }
  scanWork(afterKey: string | null, maximum: number, signal?: AbortSignal) {
    const recovery = this.recovery(signal)
    return recovery.scan(afterKey, maximum, signal)
  }
  async reconcile(acquisitionId: string, signal?: AbortSignal) {
    const recovery = this.recovery(signal),
      item = recovery.resolve(acquisitionId, signal)
    if (!item) return undefined
    const caller: PrivateAcquisitionCaller = {
      buyer: item.buyer,
      capability: item.capability,
      profile: item.profile,
      signal,
      current: () => !this.stopping.signal.aborted && recovery.isCurrent(signal)
    }
    await this.recover(item.acquisitionId, caller)
    const current = this.load(item.acquisitionId, caller, signal ?? this.stopping.signal)
    return { acquisitionId: item.acquisitionId, status: current.state.progress.phase }
  }
  private recovery(signal?: AbortSignal): PrivateAcquisitionWork {
    outputAssert(
      !this.stopping.signal.aborted && !signal?.aborted && this.identities.every(check => check()),
      'Acquisition recovery owner stopped or changed',
      'context-changed'
    )
    const recovery = this.ports.recovery
    outputAssert(recovery, 'Acquisition background recovery is not installed', 'unsupported')
    outputAssert(
      recovery.isCurrent(signal),
      'Acquisition worker authority changed',
      'context-changed'
    )
    return recovery
  }
  /** Wait for actual service calls, even when their caller already timed out. */
  async drainReconciliation(): Promise<void> {
    await Promise.all(this.physical)
  }
  private async progress(
    id: string,
    caller: PrivateAcquisitionCaller,
    signal: AbortSignal
  ): Promise<void> {
    await Array.from({ length: 8 }, (_, index) => index).reduce(
      (previous, _attempt) =>
        previous.then(async stopped => {
          if (stopped) return true
          const loaded = this.load(id, caller, signal),
            guard = this.guard(id, caller, signal, loaded.original)
          try {
            if (await this.advanceOne(loaded, caller, signal, guard)) return true
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
          return false
        }),
      Promise.resolve(false)
    )
  }
  /** Serial phases preserve the original payment/credit obligation and stop on
   * unknown outcomes. Each physical await is followed by current-owner checks.
   */
  private async advanceOne(
    loaded: Loaded,
    caller: PrivateAcquisitionCaller,
    signal: AbortSignal,
    guard: ProtectedLedgerGuard
  ): Promise<boolean> {
    const state = loaded.state.progress,
      id = state.challenge.acquisitionId
    if (state.phase === 'quoted') return this.advanceQuoted(loaded, caller, signal, guard)
    if (state.phase === 'funding-pending') return this.advanceCredit(loaded, caller, signal, guard)
    if (state.phase === 'funded') {
      this.ports.store.advance(
        id,
        caller.buyer,
        loaded.row.revision,
        { type: 'prepare-delivery' },
        this.ports.clock,
        guard
      )
      return false
    }
    if (state.phase !== 'delivery-pending') return true
    const material = this.ports.store.material(
        id,
        caller.buyer,
        loaded.row.revision,
        this.ports.clock,
        guard
      ),
      result = await this.ports.domain.issue(loaded.original, state, material, signal)
    this.requireCurrent(caller, signal)
    this.ports.store.complete(
      id,
      caller.buyer,
      loaded.row.revision,
      result,
      this.ports.clock,
      guard
    )
    return false
  }
  private async advanceQuoted(
    loaded: Loaded,
    caller: PrivateAcquisitionCaller,
    signal: AbortSignal,
    guard: ProtectedLedgerGuard
  ): Promise<boolean> {
    const state = loaded.state.progress,
      id = state.challenge.acquisitionId,
      candidate = state.candidate
    if (candidate?.verdict !== 'pending') {
      if (outputU64(loaded.observedAt) >= outputU64(state.recoveryUntil))
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
    let verified: Awaited<ReturnType<SDKPrivateAcquisitionFunding['verify']>>
    try {
      verified = await this.ports.funding.verify(
        candidate.payment,
        state.challenge,
        state.chain,
        signal
      )
    } catch (error) {
      this.requireCurrent(caller, signal)
      if (error instanceof OutputProtocolError && error.code === 'invalid')
        this.ports.store.advance(
          id,
          caller.buyer,
          loaded.row.revision,
          {
            type: 'invalid',
            candidateDigest: candidate.digest,
            reason: 'Payment candidate failed verification'
          },
          this.ports.clock,
          guard
        )
      throw error
    }
    const acceptance = await this.ports.release.assess(loaded.original, state, verified, signal)
    this.requireCurrent(caller, signal)
    if (!acceptance) return true
    this.ports.store.advance(
      id,
      caller.buyer,
      loaded.row.revision,
      {
        type: 'reserve-funding',
        candidateDigest: candidate.digest,
        sellerPaymentKey: verified.sellerPaymentKey,
        acceptance: acceptance.evidence
      },
      this.ports.clock,
      view => {
        guard(view)
        acceptance.checkCurrent()
      }
    )
    return false
  }
  private async advanceCredit(
    loaded: Loaded,
    caller: PrivateAcquisitionCaller,
    signal: AbortSignal,
    guard: ProtectedLedgerGuard
  ): Promise<boolean> {
    const state = loaded.state.progress,
      id = state.challenge.acquisitionId
    let outcome = await this.ports.wallet.status(state, signal)
    this.requireCurrent(caller, signal)
    if (outcome.state === 'absent') {
      outcome = await this.ports.wallet.internalize(state, signal)
      this.requireCurrent(caller, signal)
    }
    if (outcome.state === 'accepted')
      this.ports.store.advance(
        id,
        caller.buyer,
        loaded.row.revision,
        { type: 'wallet-accepted', receipt: outcome.receipt },
        this.ports.clock,
        guard
      )
    else if (outcome.state === 'rejected')
      this.ports.store.advance(
        id,
        caller.buyer,
        loaded.row.revision,
        { type: 'wallet-rejected', operationId: outcome.operationId, reason: outcome.reason },
        this.ports.clock,
        guard
      )
    else return true
    return false
  }
  private load(id: string, caller: PrivateAcquisitionCaller, signal: AbortSignal): Loaded {
    this.requireCurrent(caller, signal)
    const loaded = this.ports.store.load(
      id,
      caller.buyer,
      this.ports.clock,
      this.ports.access.guard(id, caller.buyer, () => this.current(caller, signal))
    )
    outputAssert(loaded, 'Acquisition not found', 'not-found')
    this.selector(caller, this.ports.contracts.restore(loaded.original.capability))
    return loaded
  }
  private guard(
    id: string,
    caller: PrivateAcquisitionCaller,
    signal: AbortSignal,
    original: PrivateAcquisitionOriginal,
    initial?: Parameters<PrivateAcquisitionAccess['guard']>[3]
  ): ProtectedLedgerGuard {
    const access = this.ports.access.guard(
      id,
      caller.buyer,
      () => this.current(caller, signal),
      initial
    )
    return view => {
      access(view)
      const current: unknown = this.ports.domain.isCurrent(structuredClone(original))
      if (current instanceof Promise) void current.catch(() => undefined)
      outputAssert(current === true, 'Acquisition domain authority changed', 'context-changed')
    }
  }
  private caller(value: PrivateAcquisitionCaller): PrivateAcquisitionCaller {
    outputAssert(
      typeof value.current === 'function' && value.current.constructor.name !== 'AsyncFunction',
      'Current acquisition caller is required'
    )
    return {
      buyer: outputIdentity(value.buyer),
      capability: outputHex32(value.capability),
      profile: outputString(value.profile),
      current: value.current,
      signal: value.signal
    }
  }
  private selector(caller: PrivateAcquisitionCaller, selected: OutputCapabilitySelection): void {
    outputAssert(
      caller.capability === selected.digest && caller.profile === selected.profile.id,
      'Original acquisition selection differs',
      'context-changed'
    )
  }
  private current(caller: PrivateAcquisitionCaller, signal: AbortSignal): boolean {
    if (signal.aborted || !this.identities.every(check => check())) return false
    const allowed: unknown = caller.current()
    if (allowed instanceof Promise) {
      void allowed.catch(() => undefined)
      return false
    }
    return allowed === true && !signal.aborted
  }
  private requireCurrent(caller: PrivateAcquisitionCaller, signal: AbortSignal): void {
    checkOutputWork(signal, 'Acquisition work cancelled')
    outputAssert(this.current(caller, signal), 'Acquisition caller changed', 'context-changed')
  }
  private run<T>(
    caller: PrivateAcquisitionCaller,
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
  async stop(): Promise<void> {
    this.stopping.abort()
    await Promise.all(this.physical)
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const original = owner[key]
  outputAssert(typeof original === 'function', 'Acquisition port is required')
  return () => owner[key] === original
}
