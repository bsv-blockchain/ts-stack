import {
  canonicalOutputJSON,
  outputAssert,
  outputHex32,
  outputString,
  outputU64,
  parseOutputJSON,
  parseOutputRootEvictionResult,
  parseOutputRootEvictionStatus,
  type OutputRootEvictionResult
} from '@bsv/sdk'
import {
  rootCommitContext,
  type RootEvictionCheckedStorage,
  type RootEvictionCommitGuard,
  type RootEvictionObservation
} from './RootEvictionCommitContext.js'
import { synchronousPromise } from '../internal/synchronousPromise.js'
import { rootDecimal, rootPosition, rootTarget } from './RootEvictionCodec.js'
import { RootEvictionContractRecords } from './RootEvictionContractRecords.js'
import type { RootEvictionContracts } from './RootEvictionContracts.js'
import type {
  RootEvictionCoordinatedRequest,
  RootEvictionCoordinatedStorage
} from './RootEvictionCoordinatedStorage.js'
import type {
  RootEvictionRecoveredRequest,
  RootEvictionRecoveryStorage
} from './RootEvictionRecoveryStorage.js'
import { RootEvictionRequests } from './RootEvictionRequests.js'
import { RootEvictionServingRecords } from './RootEvictionServingRecords.js'
import { SQLiteRootEvictionDatabase } from './SQLiteRootEvictionDatabase.js'
import type {
  RootEvictionConfiguration,
  RootEvictionAssessment,
  RootEvictionBasis,
  RootEvictionEvaluation,
  RootEvictionHead,
  RootEvictionProjection,
  RootEvictionRetainedRequest,
  RootEvictionServing,
  RootEvictionServingTarget,
  RootEvictionStorage
} from './RootEvictionStorage.js'

/**
 * Node-only bounded root decision journal. This is a trusted service port, not a
 * peer administration API: requester/status access, evidence and authority are
 * installed-service responsibilities. The journal provides atomic decisions,
 * immutable retry fences and a shared final synchronous enqueue gate.
 */
export class SQLiteRootEvictionStore
  implements
    RootEvictionStorage,
    RootEvictionCheckedStorage,
    RootEvictionCoordinatedStorage,
    RootEvictionRecoveryStorage
{
  readonly durability = 'durable' as const
  private readonly database: SQLiteRootEvictionDatabase
  private readonly requests: RootEvictionRequests
  private readonly views: RootEvictionServingRecords
  private readonly contracts: RootEvictionContractRecords

  private constructor(
    path: string,
    configuration: RootEvictionConfiguration,
    policy?: string,
    upgradeCoordination = false,
    upgradeLocalRules = false
  ) {
    this.database = new SQLiteRootEvictionDatabase(
      path,
      configuration,
      policy,
      upgradeCoordination,
      upgradeLocalRules
    )
    this.requests = new RootEvictionRequests(this.database)
    this.views = new RootEvictionServingRecords(this.database)
    this.contracts = new RootEvictionContractRecords(this.database, this.requests)
  }
  static create(
    path: string,
    configuration: RootEvictionConfiguration,
    initialPolicyDigest: string
  ): SQLiteRootEvictionStore {
    return new SQLiteRootEvictionStore(path, configuration, initialPolicyDigest)
  }
  static open(path: string, configuration: RootEvictionConfiguration): SQLiteRootEvictionStore {
    return new SQLiteRootEvictionStore(path, configuration)
  }
  /** Existing format1 only, or an exact retry of the same completed upgrade. */
  static upgradeCoordination(
    path: string,
    configuration: RootEvictionConfiguration
  ): SQLiteRootEvictionStore {
    return new SQLiteRootEvictionStore(path, configuration, undefined, true)
  }
  /** Existing format2 only, or an exact retry of the completed format3 upgrade. */
  static upgradeLocalRules(
    path: string,
    configuration: RootEvictionConfiguration
  ): SQLiteRootEvictionStore {
    return new SQLiteRootEvictionStore(path, configuration, undefined, false, true)
  }
  private work<T>(body: () => T): Promise<T> {
    return synchronousPromise(() => this.database.transaction(body))
  }
  private checked<T>(
    guard: RootEvictionCommitGuard,
    body: (now: string) => T
  ): Promise<RootEvictionObservation<T>> {
    return this.work(() => {
      const observedAt = rootCommitContext(this.database.head(), guard)
      const value = body(observedAt)
      return { value, head: this.database.head(), observedAt }
    })
  }
  retainCoordinated(
    request: unknown,
    requester: string,
    selection: { manifest: unknown; selector: string; futureClockSeconds: string },
    contracts: RootEvictionContracts,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionCoordinatedRequest>> {
    return this.checked(guard, now =>
      this.contracts.retain(request, requester, selection, contracts, now)
    )
  }
  resultCoordinated(
    requester: string,
    requestId: string,
    selector: string,
    contracts: RootEvictionContracts,
    guard: RootEvictionCommitGuard
  ): Promise<
    RootEvictionObservation<{
      retained: RootEvictionCoordinatedRequest
      result: OutputRootEvictionResult
    }>
  > {
    return this.checked(guard, now => {
      const record = this.requests.get(requester, requestId)
      outputAssert(record, 'Root request is not retained', 'not-found')
      const retained = this.contracts.restore(record, selector, contracts)
      return { retained, result: this.resultWithinGate(requester, requestId, now) }
    })
  }
  recoverCoordinated(
    digest: string,
    contracts: RootEvictionContracts,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionRecoveredRequest>> {
    return this.checked(guard, now => {
      const record = this.requests.byDigest(digest)
      outputAssert(record, 'Root request is not retained', 'not-found')
      const retained = this.contracts.recover(record, contracts)
      return {
        retained,
        result: this.resultWithinGate(
          record.request.body.requester,
          record.request.body.requestId,
          now
        )
      }
    })
  }
  retainChecked(
    request: unknown,
    requester: string,
    window: { maximumLifetimeSeconds: string; futureClockSeconds: string },
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<RootEvictionRetainedRequest>> {
    return this.checked(guard, now => this.requests.retain(request, requester, { ...window, now }))
  }
  evaluateChecked(
    input: Omit<RootEvictionEvaluation, 'now'>,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<undefined>> {
    return this.checked(guard, now => {
      this.evaluateWithinGate({ ...input, now })
      return undefined
    })
  }
  assessChecked(
    input: RootEvictionAssessment,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<string>> {
    return this.checked(guard, () => this.assessWithinGate(input))
  }
  resultChecked(
    requester: string,
    requestId: string,
    guard: RootEvictionCommitGuard
  ): Promise<RootEvictionObservation<OutputRootEvictionResult>> {
    return this.checked(guard, now => this.resultWithinGate(requester, requestId, now))
  }
  head(): Promise<RootEvictionHead> {
    return this.work(() => this.database.head())
  }
  retain(
    request: unknown,
    requester: string,
    clock: { now: string; maximumLifetimeSeconds: string; futureClockSeconds: string }
  ): Promise<RootEvictionRetainedRequest> {
    return this.work(() => this.requests.retain(request, requester, clock))
  }
  get(requester: string, requestId: string): Promise<RootEvictionRetainedRequest | undefined> {
    return this.work(() => this.requests.get(requester, requestId))
  }
  basis(decisionId: string): Promise<RootEvictionBasis | undefined> {
    return this.work(() => this.views.basis(decisionId))
  }
  assess(input: RootEvictionAssessment): Promise<string> {
    return this.work(() => this.assessWithinGate(input))
  }
  private assessWithinGate(input: RootEvictionAssessment): string {
    outputAssert(
      Object.keys(input).length === 6 && typeof input.eligible === 'boolean',
      'Invalid root assessment'
    )
    const operationId = parseOutputRootEvictionStatus({
      version: 1,
      requester: this.database.configuration.root,
      requestId: input.operationId
    }).requestId
    const target = this.selectedTarget(input.target)
    const semantic = canonicalOutputJSON({
      target,
      eligible: input.eligible,
      evidenceDigest: outputHex32(input.evidenceDigest),
      reasonCode: outputString(input.reasonCode)
    })
    outputU64(input.expectedRevision)
    const previous = this.database.get(
      'SELECT semantic,revision FROM root_assessments WHERE operation_id=?',
      operationId
    )
    if (previous) {
      outputAssert(
        previous.semantic === semantic,
        'Root assessment operation conflicts with its retained meaning',
        'conflict'
      )
      return rootDecimal(previous.revision)
    }
    const head = this.database.head()
    outputAssert(
      head.revision === input.expectedRevision,
      'Root assessment lost its decision fence',
      'conflict'
    )
    outputAssert(
      Number(this.database.get('SELECT count(*) AS n FROM root_assessments')!.n) <
        this.database.configuration.capacity.assessments,
      'Root assessment history capacity is full',
      'limited'
    )
    const revision = this.database.advance()
    this.database.run(
      'INSERT INTO root_assessments VALUES (?,?,?,?)',
      operationId,
      semantic,
      head.policyDigest,
      rootPosition(revision)
    )
    this.views.stage(target, input.eligible, revision)
    return revision
  }
  evaluate(input: RootEvictionEvaluation): Promise<void> {
    return this.work(() => this.evaluateWithinGate(input))
  }
  private evaluateWithinGate(input: RootEvictionEvaluation): void {
    const selected = this.evaluation(input)
    const record = this.requests.byDigest(selected.requestDigest)
    outputAssert(record, 'Root request is not retained', 'not-found')
    outputAssert(
      selected.targets.every(target => target.index < record.request.body.targets.length),
      'Root evaluation selects an absent target'
    )
    this.requests.expire(record, selected.now)
    const pending = this.requests.pending(record)
    const changes = selected.targets.filter(target => pending.includes(target.index))
    if (changes.length === 0) return
    outputAssert(
      this.database.head().revision === selected.expectedRevision,
      'Root evaluation lost its decision fence',
      'conflict'
    )
    const revision = this.database.advance()
    for (const item of changes) this.apply(record, item, revision)
  }
  private apply(
    record: RootEvictionRetainedRequest,
    item: RootEvictionEvaluation['targets'][number],
    revision: string
  ): void {
    if (item.disposition === 'reject') {
      this.requests.save(record, item.index, {
        actionStatus: 'rejected',
        reasonCode: item.reasonCode,
        affectedDecisionIds: [],
        revision
      })
      return
    }
    const original = record.request.body.targets[item.index]
    const target = this.selectedTarget(original)
    const applied =
      record.request.body.action === 'suppress'
        ? { decisionId: this.views.suppress(record, item.index, revision), affected: '' }
        : this.views.restore(record, item.index, revision)
    const affected =
      record.request.body.action === 'suppress' ? applied.decisionId! : applied.affected
    this.requests.save(record, item.index, {
      actionStatus: applied.decisionId ? 'applied' : 'no-op',
      reasonCode: item.reasonCode,
      revision,
      ...(applied.decisionId ? { decisionId: applied.decisionId } : {}),
      affectedDecisionIds: [affected]
    })
    if (applied.decisionId) this.views.stage(target, item.eligible, revision)
  }
  private selectedTarget(target: RootEvictionServingTarget): RootEvictionServingTarget {
    const selected = rootTarget({
      service: target.service,
      outpoint: target.outpoint,
      advertisementDigest: target.advertisementDigest
    })
    outputAssert(
      canonicalOutputJSON(selected.outpoint.chain) ===
        canonicalOutputJSON(this.database.configuration.chain),
      'Root target uses another chain'
    )
    return selected
  }
  private evaluation(input: RootEvictionEvaluation): RootEvictionEvaluation {
    const owned = parseOutputJSON(
      canonicalOutputJSON(input, { bytes: 131072 })
    ) as unknown as RootEvictionEvaluation
    outputAssert(
      Object.keys(owned).length === 4 &&
        Array.isArray(owned.targets) &&
        owned.targets.length >= 1 &&
        owned.targets.length <= 64,
      'Invalid root evaluation'
    )
    outputHex32(owned.requestDigest)
    outputU64(owned.expectedRevision)
    outputU64(owned.now)
    let previous = -1
    for (const target of owned.targets) {
      outputAssert(
        Object.keys(target).length === 4 &&
          Number.isSafeInteger(target.index) &&
          target.index > previous &&
          (target.disposition === 'accept' || target.disposition === 'reject') &&
          typeof target.eligible === 'boolean',
        'Invalid or duplicate root evaluation target'
      )
      outputString(target.reasonCode)
      previous = target.index
    }
    return owned
  }
  result(requester: string, requestId: string, now: string): Promise<OutputRootEvictionResult> {
    return this.work(() => this.resultWithinGate(requester, requestId, now))
  }
  private resultWithinGate(
    requester: string,
    requestId: string,
    now: string
  ): OutputRootEvictionResult {
    outputU64(now)
    const record = this.requests.get(requester, requestId)
    outputAssert(record, 'Root request is not retained', 'not-found')
    this.requests.expire(record, now)
    const body: OutputRootEvictionResult = {
      version: 1,
      root: this.database.configuration.root,
      requestDigest: record.digest,
      policyDigest: record.policyDigest,
      issuedAt: now,
      outcomes: record.request.body.targets.map((target, index) => ({
        service: target.service,
        outpoint: target.outpoint,
        ...this.requests.action(record, index),
        // A rejected target may have proposed a wrong advertisement digest;
        // status still reports this root's actual state for the named outpoint.
        serving: this.views.serving(this.selectedTarget(target), false)
      }))
    }
    // This validates the complete closed body. Only the installed root signer
    // creates the real signature; this internal sentinel is never returned.
    return parseOutputRootEvictionResult({ body, signature: 'AA==' }).body
  }
  changePolicy(policy: string): Promise<RootEvictionHead> {
    return this.work(() => {
      const previous = this.database.head()
      this.requests.changePolicy(policy)
      const current = this.database.head()
      if (previous.revision !== current.revision) this.views.invalidate(current.revision)
      return current
    })
  }
  serving(target: RootEvictionServingTarget): Promise<RootEvictionServing> {
    return this.work(() => this.views.serving(this.selectedTarget(target)))
  }
  projections(maximum: number): Promise<RootEvictionProjection[]> {
    return this.work(() => this.views.projections(maximum))
  }
  projected(intent: RootEvictionProjection): Promise<boolean> {
    return this.work(() =>
      this.views.projected({ ...intent, target: this.selectedTarget(intent.target) })
    )
  }

  /**
   * Queue already-hydrated, already-signed complete bytes while holding the same
   * cross-process gate as suppression. The trusted adapter supplies a synchronous
   * current-authorization check and the actual final transport enqueue, after any
   * asynchronous middleware signing. A handler's buffered res.send is insufficient.
   */
  enqueue(
    candidate: { revision: string; targets: RootEvictionServingTarget[]; bytes: Uint8Array },
    authorize: () => boolean,
    enqueue: (bytes: Uint8Array) => undefined
  ): Promise<void> {
    return this.work(() => {
      outputU64(candidate.revision)
      outputAssert(
        Array.isArray(candidate.targets) &&
          candidate.targets.length <= 1024 &&
          candidate.bytes instanceof Uint8Array &&
          candidate.bytes.byteLength <= 4194304,
        'Invalid root response candidate'
      )
      outputAssert(
        authorize.constructor.name !== 'AsyncFunction' &&
          enqueue.constructor.name !== 'AsyncFunction',
        'Root send callbacks must be synchronous'
      )
      const targets = candidate.targets.map(target => this.selectedTarget(target))
      const bytes = new Uint8Array(candidate.bytes)
      outputAssert(
        this.database.head().revision === candidate.revision,
        'Root serving revision changed before enqueue',
        'reset-required'
      )
      outputAssert(authorize() === true, 'Root response is no longer authorized', 'unauthorized')
      outputAssert(
        targets.every(target => this.views.serving(target).state === 'eligible'),
        'Root response contains a prohibited or unresolved advertisement',
        'reset-required'
      )
      outputAssert(
        enqueue(bytes) === undefined,
        'Root transport enqueue must complete synchronously'
      )
    })
  }
  close(): Promise<void> {
    return synchronousPromise(() => this.database.close())
  }
}

export { SQLiteRootEvictionMaintenance } from './SQLiteRootEvictionMaintenance.js'

export { SQLiteRootEvictionLocalRules } from './SQLiteRootEvictionLocalRules.js'
