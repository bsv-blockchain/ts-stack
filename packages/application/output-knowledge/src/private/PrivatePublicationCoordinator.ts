import { readCurrentPrivatePublicationStatus } from './PrivatePublicationPorts.js'
import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputPacketDigest,
  outputPrivatePublicationRequestDigest,
  outputString,
  outputU64,
  OutputProtocolError,
  parseOutputJSON,
  parseOutputPrivatePublish,
  parseOutputPrivatePublicationStatus,
  type OutputCapabilitySelection,
  type OutputPrivatePublish
} from '@bsv/sdk'
import { parseOutputSTEAK } from '@bsv/sdk/overlay-tools/OutputObservation'
import { BoundedOutputWork, checkOutputWork } from '../internal/BoundedOutputWork.js'
import { PrivatePublicationAccess } from './PrivatePublicationAccess.js'
import { PrivatePublicationContracts } from './PrivatePublicationContracts.js'
import { PrivatePublicationVerificationLeases } from './PrivatePublicationVerificationLeases.js'
import { SDKPrivatePublicationEvidence } from './SDKPrivatePublicationEvidence.js'
import {
  privatePublicationOperation,
  privatePublicationResult
} from './PrivatePublicationProgress.js'
import type { ProtectedLedgerGuard } from './ProtectedLedgerCodec.js'
import type {
  PrivatePublicationStore,
  PrivatePublicationWorker,
  PrivatePublicationAdmission,
  PrivatePublicationCaller,
  PrivatePublicationValidator
} from './PrivatePublicationPorts.js'

export interface PrivatePublicationCoordinatorOptions {
  worker?: PrivatePublicationWorker
  store: PrivatePublicationStore
  contracts: PrivatePublicationContracts
  evidence: Pick<SDKPrivatePublicationEvidence, 'verify'>
  access: Pick<PrivatePublicationAccess, 'guard'>
  leases: Pick<PrivatePublicationVerificationLeases, 'run' | 'isCurrent'>
  admission: PrivatePublicationAdmission
  validate: PrivatePublicationValidator
  validationPolicy: { id: string; digest: string }
  lookup: { service: string; rulesDigest: string }
  manifest: () => unknown
  clock: () => string
  stagingSeconds: string
  maximumWork?: number
  perPublisherWork?: number
  timeoutMs?: number
  supportedExtensions?: readonly string[]
}
type Loaded = NonNullable<ReturnType<PrivatePublicationStore['loadVerified']>>

/**
 * Trusted service orchestration. Its returned projection is preparation only:
 * authenticated transport must separately revalidate under the physical disclosure
 * gate after signing and before enqueue. No private material is returned here.
 */
export class PrivatePublicationCoordinator {
  private readonly ports: Readonly<PrivatePublicationCoordinatorOptions>
  private readonly installed: ReturnType<PrivatePublicationContracts['configuration']>
  private readonly policy: PrivatePublicationCoordinatorOptions['validationPolicy']
  private readonly lookup: PrivatePublicationCoordinatorOptions['lookup']
  private readonly extensions: readonly string[]
  private readonly stagingSeconds: bigint
  private readonly work: BoundedOutputWork
  private readonly stopping = new AbortController()
  private readonly physical = new Set<Promise<void>>()
  private readonly workerPhysical = new Set<Promise<void>>()
  private readonly identities: readonly (() => boolean)[]

  constructor(options: PrivatePublicationCoordinatorOptions) {
    this.ports = Object.freeze({ ...options })
    this.installed = options.contracts.configuration()
    const owned = parseOutputJSON(
      canonicalOutputJSON(
        {
          policy: options.validationPolicy,
          lookup: options.lookup,
          extensions: options.supportedExtensions ?? []
        },
        { bytes: 16384 }
      )
    )
    closedOutputObject(owned, ['policy', 'lookup', 'extensions'])
    closedOutputObject(owned.policy, ['id', 'digest'])
    closedOutputObject(owned.lookup, ['service', 'rulesDigest'])
    this.policy = { id: outputString(owned.policy.id), digest: outputHex32(owned.policy.digest) }
    this.lookup = {
      service: outputString(owned.lookup.service),
      rulesDigest: outputHex32(owned.lookup.rulesDigest)
    }
    outputAssert(
      Array.isArray(owned.extensions) && owned.extensions.length <= 32,
      'Invalid publication extensions'
    )
    this.extensions = owned.extensions.map(value => outputString(value))
    this.stagingSeconds = outputU64(options.stagingSeconds)
    outputAssert(
      this.stagingSeconds > 0n && this.stagingSeconds <= 86400n,
      'Invalid publication staging lifetime'
    )
    for (const callback of [options.validate, options.manifest, options.clock])
      outputAssert(typeof callback === 'function', 'Publication installation callback is required')
    outputAssert(
      Number.isSafeInteger(options.admission.maximumOutcomeBytes) &&
        options.admission.maximumOutcomeBytes >= 128 &&
        options.admission.maximumOutcomeBytes <= 65536,
      'Invalid admission result bound'
    )
    outputAssert(
      Number.isSafeInteger(options.admission.maximumPrivateBytes) &&
        options.admission.maximumPrivateBytes >= this.installed.maximumPrivateBytes,
      'Installed private capacity exceeds admission capacity'
    )
    this.work = new BoundedOutputWork(
      {
        invalid: 'Invalid private publication work limits',
        capacity: 'Private publication work capacity is occupied',
        cancelled: 'Private publication work was cancelled',
        deadline: 'Private publication work deadline elapsed'
      },
      options.maximumWork ?? 16,
      options.perPublisherWork ?? Math.min(4, options.maximumWork ?? 16),
      options.timeoutMs ?? 30000
    )
    this.identities = [
      pin(options.store, 'stageVerified'),
      pin(options.store, 'loadVerified'),
      pin(options.store, 'loadStatus'),
      pin(options.store, 'markUnavailable'),
      pin(options.store, 'advance'),
      pin(options.store, 'bindVerified'),
      pin(options.contracts, 'configuration'),
      pin(options.contracts, 'retain'),
      pin(options.contracts, 'restore'),
      pin(options.evidence, 'verify'),
      pin(options.access, 'guard'),
      pin(options.leases, 'run'),
      pin(options.admission, 'recover'),
      pin(options.leases, 'isCurrent'),
      pinValue(options.admission, 'maximumPrivateBytes'),
      pinValue(options.admission, 'maximumOutcomeBytes'),
      ...(options.worker
        ? [
            pin(options.worker, 'resolve'),
            pin(options.worker, 'scan'),
            pin(options.worker, 'isCurrent')
          ]
        : [])
    ]
  }

  publish(input: unknown, caller: PrivatePublicationCaller) {
    const trusted = this.caller(caller)
    const request = parseOutputPrivatePublish(input, this.extensions)
    return this.run(trusted.publisher, trusted.signal, async signal => {
      outputAssert(
        request.topic === this.installed.topic,
        'Private publication topic is not installed',
        'unsupported'
      )
      const id = this.id(request, trusted.publisher)
      const { privateValues: _secret, ...reference } = request
      const current = () => this.current(trusted, signal)
      const guard = this.ports.access.guard(id, trusted.publisher, current, reference)
      const prior = this.ports.store.loadVerified(id, this.ports.clock, guard)
      const selected = prior
        ? this.ports.contracts.restore(prior.original.capability)
        : this.ports.contracts.retain(this.ports.manifest(), this.ports.clock()).selection
      this.selector(trusted, selected)
      if (prior)
        outputAssert(
          prior.fence.state.requestDigest ===
            outputPrivatePublicationRequestDigest(request, this.extensions),
          'Private publication request conflicts',
          'conflict'
        )
      canonicalOutputJSON(request, { bytes: selected.profile.maxRequestBytes })
      const parameters = selected.profile.parameters as {
        schemas: string[]
        maxPrivateBytes: number
      }
      outputAssert(
        parameters.schemas.includes(request.schema),
        'Publication schema is not installed',
        'unsupported'
      )
      outputAssert(
        decodeOutputBytes(request.privateValues).length <= parameters.maxPrivateBytes,
        'Publication private capacity exceeded',
        'limited'
      )
      const verified = await this.ports.evidence.verify(
        structuredClone(request),
        trusted.publisher,
        structuredClone(this.installed.chain),
        signal
      )
      outputAssert(
        verified.publisher === trusted.publisher &&
          verified.requestDigest ===
            outputPrivatePublicationRequestDigest(request, this.extensions),
        'Publication evidence port returned another request',
        'context-changed'
      )
      this.requireCurrent(trusted, signal)
      if (prior)
        outputAssert(
          verified.rawTransaction === prior.original.rawTransaction,
          'Publication proof variant changes the original transaction',
          'conflict'
        )
      const validated = await this.ports.validate(
        structuredClone(request),
        structuredClone(verified),
        signal
      )
      outputAssert(
        validated === undefined,
        'Publication validator must complete without a replacement decision'
      )
      this.requireCurrent(trusted, signal)
      if (!prior) {
        await this.ports.leases.run(
          request,
          trusted.publisher,
          verified.verificationContext,
          signal,
          current,
          reference => {
            const now = this.ports.clock()
            const retained = this.ports.contracts.retain(selected.manifest, now)
            this.selector(trusted, retained.selection)
            const original = {
              format: 'private-publication-contract/1',
              publicationId: id,
              requestDigest: verified.requestDigest,
              rawTransaction: verified.rawTransaction,
              capability: retained.record,
              verificationContext: verified.verificationContext,
              validationPolicy: this.policy
            }
            const fresh: ProtectedLedgerGuard = view => {
              guard(view)
              outputAssert(
                this.ports.leases.isCurrent(reference),
                'Original publication verification changed',
                'context-changed'
              )
              this.ports.contracts.retain(selected.manifest, view.observedAt)
            }
            this.ports.store.stageVerified(
              request,
              { publisher: trusted.publisher, lookup: this.lookup },
              outputU64((outputU64(now) + this.stagingSeconds).toString()).toString(),
              original,
              this.ports.clock,
              fresh
            )
            return Promise.resolve()
          }
        )
      }
      return this.progress(id, trusted, signal)
    })
  }

  status(input: unknown, caller: PrivatePublicationCaller) {
    const trusted = this.caller(caller)
    const request = parseOutputPrivatePublicationStatus(input)
    return this.run(trusted.publisher, trusted.signal, signal => {
      this.requireCurrent(trusted, signal)
      const loaded = readCurrentPrivatePublicationStatus(
        this.ports.store,
        request.publicationId,
        this.ports.clock,
        this.ports.access.guard(request.publicationId, trusted.publisher, () =>
          this.current(trusted, signal)
        ),
        metadata => {
          this.project(metadata, trusted)
        }
      )
      outputAssert(loaded, 'Private publication not found', 'not-found')
      return Promise.resolve(this.project(loaded.metadata, trusted))
    })
  }

  resume(input: unknown, caller: PrivatePublicationCaller) {
    const trusted = this.caller(caller)
    const request = parseOutputPrivatePublicationStatus(input)
    return this.run(trusted.publisher, trusted.signal, signal =>
      this.progress(request.publicationId, trusted, signal)
    )
  }

  /** Internal worker entry: principal and selector come from the original protected record. */
  reconcile(publicationId: string, signal?: AbortSignal) {
    outputAssert(this.ports.worker, 'Private publication worker is not installed', 'unsupported')
    const worker = this.ports.worker,
      active = signal ? AbortSignal.any([signal, this.stopping.signal]) : this.stopping.signal
    const job = worker.resolve(outputHex32(publicationId), active)
    if (!job) return Promise.resolve(undefined)
    const caller = {
      publisher: job.publisher,
      capability: job.capability,
      profile: job.profile,
      current: () => worker.isCurrent(active),
      signal: active
    }
    return this.run(
      job.publisher,
      active,
      signal => this.progress(job.publicationId, caller, signal),
      true
    )
  }

  scanWork(afterKey: string | null, maximum: number, signal?: AbortSignal) {
    outputAssert(this.ports.worker, 'Private publication worker is not installed', 'unsupported')
    checkOutputWork(this.stopping.signal, 'Private publication service stopped')
    return this.ports.worker.scan(afterKey, maximum, signal)
  }
  async drainReconciliation(): Promise<void> {
    await Promise.all(this.workerPhysical)
  }

  /** Stop intake, revoke in-flight service work and await actual physical settlement. */
  async stop(): Promise<void> {
    this.stopping.abort(new OutputProtocolError('cancelled', 'Private publication service stopped'))
    await Promise.all(this.physical)
  }

  private run<T>(
    publisher: string,
    signal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
    worker = false
  ): Promise<T> {
    let started = false,
      finish: () => void = () => {}
    const settled = new Promise<void>(resolve => {
      finish = resolve
    })
    this.physical.add(settled)
    if (worker) this.workerPhysical.add(settled)
    const release = () => {
      this.physical.delete(settled)
      this.workerPhysical.delete(settled)
      finish()
    }
    const pending = this.work.run(
      publisher,
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
    return pending.finally(() => {
      if (!started) release()
    })
  }

  private async progress(id: string, caller: PrivatePublicationCaller, signal: AbortSignal) {
    const current = () => this.current(caller, signal)
    const guard = this.ports.access.guard(id, caller.publisher, current)
    // Each physical transition reloads the current record. A concurrent CAS winner
    // never authorizes replaying another effect or discarding the retained receipt.
    for (let attempt = 0; attempt < 5; attempt++) {
      const loaded = this.load(id, caller, signal)
      const state = loaded.fence.state
      const selected = this.ports.contracts.restore(loaded.original.capability)
      this.selector(caller, selected)
      if (!['staged', 'admitting', 'binding'].includes(state.progress.phase))
        return this.project(loaded, caller)
      try {
        await this.ports.leases.run(
          loaded.request,
          caller.publisher,
          loaded.original.verificationContext,
          signal,
          current,
          async reference => {
            const verifiedGuard: ProtectedLedgerGuard = view => {
              guard(view)
              outputAssert(
                this.ports.leases.isCurrent(reference),
                'Original publication verification changed',
                'context-changed'
              )
            }
            if (state.progress.phase === 'staged') {
              this.ports.store.advance(
                id,
                loaded.record.revision,
                outputU64(loaded.observedAt) >= outputU64(state.stagedUntil)
                  ? {
                      kind: 'expired',
                      reason: 'Publication staging deadline elapsed before admission'
                    }
                  : { kind: 'reserve-admission' },
                this.ports.clock,
                verifiedGuard
              )
            } else if (state.progress.phase === 'binding') {
              this.ports.store.bindVerified(
                id,
                loaded.record.revision,
                this.ports.clock,
                verifiedGuard
              )
            } else {
              const outcome = await this.ports.admission.recover(
                {
                  publisher: caller.publisher,
                  publicationId: id,
                  requestDigest: state.requestDigest,
                  operationId: privatePublicationOperation(state),
                  rawTransaction: loaded.original.rawTransaction,
                  request: loaded.request
                },
                selected,
                reference
              )
              this.requireCurrent(caller, signal)
              const checked = parseOutputJSON(
                canonicalOutputJSON(outcome, { bytes: this.ports.admission.maximumOutcomeBytes })
              )
              outputAssert(
                checked !== null && typeof checked === 'object' && !Array.isArray(checked),
                'Invalid private admission outcome'
              )
              closedOutputObject(
                checked,
                ['operationId', 'txid', 'status'],
                checked.status === 'unresolved' ? [] : ['steak', 'assessmentContextId', 'context']
              )
              outputAssert(
                checked.operationId === privatePublicationOperation(state) &&
                  checked.txid === state.txid,
                'Private admission outcome binding differs',
                'conflict'
              )
              if (checked.status === 'unresolved') return
              outputAssert(
                (checked.status === 'admitted' || checked.status === 'excluded') &&
                  ['matching-private-values', 'public'].includes(checked.context as string),
                'Invalid private admission decision'
              )
              const admission = {
                operationId: checked.operationId,
                txid: checked.txid,
                steak: parseOutputSTEAK(checked.steak),
                assessmentContextId: outputString(checked.assessmentContextId)
              }
              this.ports.store.advance(
                id,
                loaded.record.revision,
                checked.status === 'admitted'
                  ? { kind: 'admitted', admission }
                  : {
                      kind: 'excluded',
                      admission,
                      reason: 'The original topic assessment excludes the selected output'
                    },
                this.ports.clock,
                verifiedGuard
              )
            }
          }
        )
        if (
          state.progress.phase === 'admitting' &&
          this.load(id, caller, signal).record.revision === loaded.record.revision
        )
          return this.project(this.load(id, caller, signal), caller)
      } catch (error) {
        this.requireCurrent(caller, signal)
        if (
          error instanceof OutputProtocolError &&
          error.code === 'conflict' &&
          this.load(id, caller, signal).record.revision !== loaded.record.revision
        )
          continue
        throw error
      }
    }
    return this.project(this.load(id, caller, signal), caller)
  }

  private load(id: string, caller: PrivatePublicationCaller, signal: AbortSignal): Loaded {
    this.requireCurrent(caller, signal)
    const loaded = this.ports.store.loadVerified(
      id,
      this.ports.clock,
      this.ports.access.guard(id, caller.publisher, () => this.current(caller, signal))
    )
    outputAssert(loaded, 'Private publication not found', 'not-found')
    return loaded
  }
  private project(loaded: Pick<Loaded, 'original' | 'fence'>, caller: PrivatePublicationCaller) {
    const selected = this.ports.contracts.restore(loaded.original.capability)
    this.selector(caller, selected)
    const result = privatePublicationResult(loaded.fence.state)
    canonicalOutputJSON(result, { bytes: selected.profile.maxResponseBytes })
    return result
  }
  private id(request: OutputPrivatePublish, publisher: string) {
    return outputPacketDigest('private-publication', {
      chain: this.installed.chain,
      publisher,
      topic: request.topic,
      requestId: request.requestId
    })
  }
  private caller(caller: PrivatePublicationCaller): PrivatePublicationCaller {
    outputAssert(
      typeof caller.current === 'function' && caller.current.constructor.name !== 'AsyncFunction',
      'Current authenticated publication context is required'
    )
    return {
      publisher: outputIdentity(caller.publisher),
      capability: outputHex32(caller.capability),
      profile: outputString(caller.profile),
      current: caller.current,
      signal: caller.signal
    }
  }
  private selector(caller: PrivatePublicationCaller, selection: OutputCapabilitySelection) {
    outputAssert(
      caller.capability === selection.digest && caller.profile === selection.profile.id,
      'Original publication capability selector differs',
      'context-changed'
    )
  }
  private current(caller: PrivatePublicationCaller, signal: AbortSignal) {
    if (signal.aborted || !this.identities.every(check => check())) return false
    const allowed: unknown = caller.current()
    if (allowed instanceof Promise) {
      void allowed.catch(() => undefined)
      return false
    }
    return allowed === true && !signal.aborted
  }
  private requireCurrent(caller: PrivatePublicationCaller, signal: AbortSignal) {
    checkOutputWork(signal, 'Private publication work was cancelled')
    outputAssert(
      this.current(caller, signal),
      'Private publication context changed',
      'context-changed'
    )
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const original = owner[key]
  outputAssert(typeof original === 'function', 'Private publication port is required')
  return () => owner[key] === original
}

function pinValue<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const original = owner[key]
  return () => owner[key] === original
}
