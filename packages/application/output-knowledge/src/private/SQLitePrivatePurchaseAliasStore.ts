import {
  canonicalOutputJSON,
  Hash,
  Utils,
  parseOutputPurchaseSubmit,
  type OutputPurchaseSubmit,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputString,
  outputU64,
  ownOutputJSON,
  parseOutputJSON,
  type OutputPurchaseEnvelope,
  type OutputSignedPurchaseTerms
} from '@bsv/sdk'
import { assembleOutputEvidence } from '../EvidenceAssembler.js'
import {
  PrivateAcquisitionPayloads,
  parsePrivateAcquisitionPayload
} from './PrivateAcquisitionPayloads.js'
import type {
  PrivatePurchaseContracts,
  PrivatePurchaseOriginal
} from './PrivatePurchaseContracts.js'
import {
  createPrivatePurchaseProgress,
  advancePrivatePurchaseProgress,
  parsePrivatePurchaseProgress,
  privatePurchaseEnvelope,
  PRIVATE_PURCHASE_PROGRESS_BYTES
} from './PrivatePurchaseProgress.js'
import {
  parsePrivatePurchaseAliasState,
  type PrivatePurchaseAliasPlacement
} from './PrivatePurchaseAliasState.js'
import { projectPrivatePurchaseAliasSelection } from './PrivatePurchaseAliasSelection.js'
import type { PrivatePurchaseValidation } from './PrivatePurchasePorts.js'
import type {
  PrivatePurchaseCustody,
  PrivatePurchaseStoreLimits
} from './SQLitePrivatePurchaseStore.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type {
  SQLitePrivatePurchaseAliases,
  PrivatePurchaseAliasWrite
} from './SQLitePrivatePurchaseAliases.js'
import {
  protectedInteger,
  protectedValue,
  type ProtectedLedgerChange,
  type ProtectedLedgerGuard,
  type ProtectedLedgerRecord,
  type ProtectedLedgerView
} from './ProtectedLedgerCodec.js'
import type {
  PrivatePurchaseAliasOwner,
  PrivatePurchaseAliasedLoaded,
  PrivatePurchaseAliasedState
} from './PrivatePurchaseAliasOwnerPorts.js'

const PROFILE = 'full-purchase-commitment-v1' as const

/** Explicit new owner; historical formats cannot be opened or migrated here.
 * Native custody is distinct from installed domain/chain/admission authority.
 * The first financial reservation and complete first signed result are each
 * committed with their alias contribution in the SAME authenticated writer. */
export class SQLitePrivatePurchaseAliasStore implements PrivatePurchaseAliasOwner {
  private readonly payloads: PrivateAcquisitionPayloads
  private readonly limits: PrivatePurchaseStoreLimits
  private readonly policy: PrivatePurchaseCustody['validationPolicy']
  private readonly pins: readonly (() => boolean)[]
  private readonly updates: number
  private readonly aliasLimits: import('./SQLitePrivatePurchaseAliases.js').PrivatePurchaseAliasLimits
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly contracts: PrivatePurchaseContracts,
    private readonly aliases: SQLitePrivatePurchaseAliases,
    limits: PrivatePurchaseStoreLimits,
    policy: PrivatePurchaseCustody['validationPolicy'],
    maximumSelections: number
  ) {
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
      'Alias result metadata cannot fit its completion',
      'limited'
    )
    outputAssert(
      Number.isSafeInteger(maximumSelections) && maximumSelections >= 1 && maximumSelections <= 60,
      'Invalid alias selection capacity'
    )
    this.updates = maximumSelections + 1
    closedOutputObject(policy, ['id', 'digest'])
    this.policy = { id: outputString(policy.id), digest: outputHex32(policy.digest) }
    this.payloads = new PrivateAcquisitionPayloads(domain.identity)
    aliases.installedOn(domain, contracts)
    this.aliasLimits = Object.freeze(aliases.configuration())
    outputAssert(
      this.limits.maximumCandidateBytes === this.aliasLimits.maximumCandidateBytes,
      'Alias candidate reservation differs from result owner',
      'context-changed'
    )
    const installed = contracts.configuration()
    outputAssert(
      installed.seller === domain.scope.seller &&
        canonicalOutputJSON(installed.chain) === canonicalOutputJSON(domain.scope.chain),
      'Alias owner differs from installation',
      'context-changed'
    )
    this.pins = [
      pin(domain, 'ledger'),
      pin(domain, 'identity'),
      pin(domain.identity, 'address'),
      pin(domain.ledger, 'read'),
      pin(domain.ledger, 'commitPrepared'),
      pin(domain.ledger, 'disclose'),
      pin(contracts, 'configuration'),
      pin(contracts, 'original'),
      pin(contracts, 'restore'),
      pin(aliases, 'installedOn'),
      pin(aliases, 'configuration'),
      pin(aliases, 'reserve'),
      pin(aliases, 'inspect'),
      pin(aliases, 'release')
    ]
  }
  installedOn(domain: PrivateServiceDomain, contracts: PrivatePurchaseContracts): void {
    outputAssert(
      domain === this.domain && contracts === this.contracts,
      'Alias effect owner installation changed',
      'context-changed'
    )
    this.current()
  }
  private current(): void {
    outputAssert(
      this.pins.every(check => check()),
      'Alias effect owner capability changed',
      'context-changed'
    )
    this.aliases.installedOn(this.domain, this.contracts)
  }
  private authorize(guard: ProtectedLedgerGuard, view: ProtectedLedgerView): void {
    this.current()
    outputAssert(
      typeof guard === 'function' && guard.constructor.name !== 'AsyncFunction',
      'Alias owner guard must be synchronous'
    )
    const checked: unknown = guard(view)
    if (checked instanceof Promise) void checked.catch(() => undefined)
    outputAssert(checked === undefined, 'Alias owner guard must finish synchronously')
    this.current()
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
      value.format === 'private-purchase-custody/1' &&
        value.validationPolicy.id === this.policy.id &&
        value.validationPolicy.digest === this.policy.digest,
      'Alias original custody or policy differs',
      'unavailable'
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
  private rows(
    descriptor: ReturnType<typeof parsePrivateAcquisitionPayload>,
    view: ProtectedLedgerView
  ) {
    return this.payloads.addresses(descriptor).map(address => view.get(address))
  }
  private descriptors(original: PrivatePurchaseOriginal) {
    const id = original.terms.body.acquisitionId,
      digest = original.terms.body.requestDigest
    return {
      original: this.payloads.reserve(id, digest, 'material', this.limits.maximumOriginalBytes)
        .descriptor,
      result: this.payloads.reserve(id, digest, 'result', this.limits.maximumResultBytes).descriptor
    }
  }
  private validatePayloadReservations(
    original: PrivatePurchaseOriginal,
    originalPayload: ReturnType<typeof parsePrivateAcquisitionPayload>,
    resultPayload: ReturnType<typeof parsePrivateAcquisitionPayload>
  ): void {
    const expected = this.descriptors(original)
    for (const [actual, reservation] of [
      [originalPayload, expected.original],
      [resultPayload, expected.result]
    ]) {
      outputAssert(
        actual.acquisitionId === reservation.acquisitionId &&
          actual.requestDigest === reservation.requestDigest &&
          actual.purpose === reservation.purpose &&
          actual.maximumBytes === reservation.maximumBytes &&
          actual.chunks === reservation.chunks,
        'Alias payload reservation differs',
        'unavailable'
      )
    }
  }
  private restore(
    row: ProtectedLedgerRecord,
    buyer: string,
    view: ProtectedLedgerView,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded | undefined {
    const value = row.value
    closedOutputObject(value, [
      'format',
      'clockProfile',
      'candidateProfile',
      'recipient',
      'firstReservedAt',
      'selectedTxid',
      'progress',
      'original',
      'result'
    ])
    outputAssert(
      value.format === 'private-purchase-state/3' &&
        value.clockProfile === 'native-observation-v1' &&
        value.candidateProfile === PROFILE,
      'Unsupported alias effect owner state',
      'unavailable'
    )
    if (outputIdentity(value.recipient) !== buyer) return undefined
    const originalPayload = parsePrivateAcquisitionPayload(value.original),
      resultPayload = parsePrivateAcquisitionPayload(value.result)
    const custody = this.custody(
        decoded(
          this.payloads.read(originalPayload, this.rows(originalPayload, view)),
          this.limits.maximumOriginalBytes
        )
      ),
      original = custody.original
    this.validatePayloadReservations(original, originalPayload, resultPayload)
    const progress = parsePrivatePurchaseProgress(value.progress, original, PROFILE),
      id = progress.acquisitionId,
      fence = view.get(this.fence(id))
    outputAssert(
      row.key === this.address(id).key &&
        row.kind === this.address(id).kind &&
        row.reservedBytes === this.limits.maximumStateBytes &&
        row.reservedUpdates >= 0 &&
        row.reservedUpdates <= this.updates &&
        fence?.reservedBytes === 1024 &&
        fence.reservedUpdates === 0 &&
        canonicalOutputJSON(fence.value) ===
          canonicalOutputJSON({
            format: 'private-purchase-fence/2',
            owner: this.aliases.id,
            acquisitionId: id,
            requestDigest: progress.requestDigest,
            recipient: buyer
          }),
      'Alias record or request fence differs',
      'unavailable'
    )
    const firstReservedAt =
        value.firstReservedAt === null ? null : outputU64(value.firstReservedAt).toString(),
      selectedTxid = value.selectedTxid === null ? null : outputHex32(value.selectedTxid),
      aliases = this.aliases.inspect(original, view, guard)
    outputAssert(
      (firstReservedAt === null) === (selectedTxid === null) &&
        (firstReservedAt === null) === (aliases.state.original === null) &&
        (resultPayload.digest !== null) ===
          (progress.status === 'delivered' || progress.status === 'delivery-failed'),
      'Alias financial or result reservation differs',
      'unavailable'
    )
    const completed = progress.status === 'delivered' || progress.status === 'delivery-failed'
    outputAssert(
      completed ||
        ((progress.status === 'prepared' || progress.status === 'expired') &&
          row.reservedUpdates >= 1),
      'Alias completion capacity or persisted phase differs',
      'unavailable'
    )
    let current = progress
    let candidate = null as PrivatePurchaseAliasedLoaded['candidate']
    if (progress.status === 'delivered') {
      outputAssert(
        aliases.state.historical?.txid === progress.txid &&
          selectedTxid === progress.txid &&
          aliases.state.purchaseCommitment === progress.purchaseCommitment,
        'Alias historical release differs',
        'unavailable'
      )
      candidate = aliases.candidates.get('historical') ?? null
    } else if (progress.status === 'delivery-failed') {
      outputAssert(
        aliases.state.historical === null &&
          selectedTxid === progress.txid &&
          aliases.state.purchaseCommitment === progress.purchaseCommitment,
        'Failed alias cannot carry a private historical release',
        'unavailable'
      )
      const terminal = ownOutputJSON(
        decoded(
          this.payloads.read(resultPayload, this.rows(resultPayload, view)),
          this.limits.maximumResultBytes
        ),
        { bytes: this.limits.maximumResultBytes }
      ).value
      closedOutputObject(terminal, ['format', 'candidate', 'candidateDigest', 'envelope'])
      candidate = parseOutputPurchaseSubmit(terminal.candidate)
      outputAssert(
        terminal.format === 'private-purchase-failure-custody/1' &&
          candidate.acquisitionId === id &&
          candidate.txid === progress.txid &&
          this.rawDigest(original, candidate) === outputHex32(terminal.candidateDigest) &&
          canonicalOutputJSON(terminal.envelope) ===
            canonicalOutputJSON(privatePurchaseEnvelope(progress, original, undefined, PROFILE)),
        'Failed alias exact candidate or immutable decision differs',
        'unavailable'
      )
    } else {
      outputAssert(
        aliases.state.historical === null,
        'Alias historical copy has no completed result',
        'unavailable'
      )
      current = projectPrivatePurchaseAliasSelection(
        original,
        aliases,
        firstReservedAt,
        selectedTxid,
        view
      ).progress
      if (selectedTxid !== null)
        candidate =
          [...aliases.candidates.values()].find(item => item.txid === selectedTxid) ?? null
    }
    outputAssert(
      current.txid === null || candidate?.txid === current.txid,
      'Selected alias raw candidate is missing',
      'unavailable'
    )
    const state: PrivatePurchaseAliasedState = {
      format: value.format,
      clockProfile: value.clockProfile,
      candidateProfile: PROFILE,
      recipient: buyer,
      firstReservedAt,
      selectedTxid,
      progress,
      original: originalPayload,
      result: resultPayload
    }
    return {
      revision: view.revision,
      observedAt: view.observedAt,
      row,
      custody,
      state,
      aliases,
      progress: current,
      candidate
    }
  }
  load(
    idInput: string,
    buyerInput: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded | undefined {
    const id = outputHex32(idInput),
      buyer = outputIdentity(buyerInput)
    let loaded: PrivatePurchaseAliasedLoaded | undefined
    this.domain.ledger.read([this.address(id)], clock, view => {
      this.authorize(guard, view)
      const row = view.get(this.address(id))
      if (row) loaded = this.restore(row, buyer, view, guard)
    })
    return loaded
  }
  prepare(
    input: PrivatePurchaseCustody,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded {
    const custody = this.custody(input),
      id = custody.original.terms.body.acquisitionId,
      buyer = custody.original.request.recipient
    const prior = this.load(id, buyer, clock, guard)
    if (prior) {
      outputAssert(
        prior.progress.requestDigest === custody.original.terms.body.requestDigest,
        'Alias preparation body conflicts',
        'conflict'
      )
      return prior
    }
    this.feasible(custody)
    // These staged local reservations return no promise. All mandatory custody
    // must exist before the coordinator exposes terms through the native gate.
    this.aliases.reserve(custody.original, clock, guard)
    const read = this.domain.ledger.read([this.address(id), this.fence(id)], clock, view =>
      this.authorize(guard, view)
    )
    outputAssert(
      read.records.every(row => row === undefined),
      'Alias original reservation already exists',
      'unavailable'
    )
    let observed: string | undefined
    this.domain.ledger.commitPrepared(
      read.revision,
      view => {
        this.authorize(guard, view)
        observed = outputU64(view.observedAt).toString()
        outputAssert(
          outputU64(observed) >= outputU64(custody.original.createdAt) &&
            outputU64(observed) < outputU64(custody.original.terms.body.purchaseUntil),
          'Alias preparation clock or cutoff changed',
          'expired'
        )
        const actual = this.custody({
            ...custody,
            original: { ...custody.original, createdAt: observed }
          }),
          progress = createPrivatePurchaseProgress(actual.original, PROFILE)
        const original = this.payloads.reserve(
            id,
            progress.requestDigest,
            'material',
            this.limits.maximumOriginalBytes,
            encoded(actual, this.limits.maximumOriginalBytes)
          ),
          result = this.payloads.reserve(
            id,
            progress.requestDigest,
            'result',
            this.limits.maximumResultBytes
          )
        const state: PrivatePurchaseAliasedState = {
          format: 'private-purchase-state/3',
          clockProfile: 'native-observation-v1',
          candidateProfile: PROFILE,
          recipient: buyer,
          firstReservedAt: null,
          selectedTxid: null,
          progress,
          original: original.descriptor,
          result: result.descriptor
        }
        const aliases = this.aliases.inspect(actual.original, view, guard)
        outputAssert(
          aliases.state.original === null && aliases.state.historical === null,
          'Unprepared alias owner contains financial work',
          'unavailable'
        )
        return [
          {
            ...this.address(id),
            expectedRevision: null,
            reservedBytes: this.limits.maximumStateBytes,
            reservedUpdates: this.updates,
            value: protectedValue(state, this.limits.maximumStateBytes).value
          },
          {
            ...this.fence(id),
            expectedRevision: null,
            reservedBytes: 1024,
            reservedUpdates: 0,
            value: {
              format: 'private-purchase-fence/2',
              owner: this.aliases.id,
              acquisitionId: id,
              requestDigest: progress.requestDigest,
              recipient: buyer
            }
          },
          ...original.changes,
          ...result.changes
        ]
      },
      clock,
      view => {
        this.authorize(guard, view)
        outputAssert(
          observed === undefined || view.observedAt === observed,
          'Alias reservation observation changed',
          'context-changed'
        )
      },
      { maximumBatchBytes: this.limits.maximumBatchBytes }
    )
    return this.require(id, buyer, clock, guard)
  }
  retain(
    loaded: PrivatePurchaseAliasedLoaded,
    write: Extract<PrivatePurchaseAliasWrite, { status: 'ready' }>,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    combined: PrivatePurchaseValidation
  ): PrivatePurchaseAliasedLoaded {
    const selectedCandidate = parseOutputPurchaseSubmit(
        Object.getOwnPropertyDescriptor(write, 'candidate')?.value
      ),
      prepared = write.prepare(guard, combined),
      id = loaded.progress.acquisitionId
    outputAssert(
      prepared.revision === loaded.revision,
      'Alias planner native head changed',
      'conflict'
    )
    const derive = (view: ProtectedLedgerView): ProtectedLedgerChange[] => {
      this.authorize(guard, view)
      prepared.checkCurrent(view)
      const row = view.get(this.address(id)),
        actual = row && this.restore(row, loaded.state.recipient, view, guard)
      outputAssert(
        actual?.row.revision === loaded.row.revision,
        'Alias effect record changed',
        'conflict'
      )
      const changes = [...prepared.changes(view)]
      outputAssert(
        changes.every(change => change.key !== actual.row.key || change.kind !== actual.row.kind),
        'Alias planner cannot rewrite effect custody',
        'conflict'
      )
      const metadata = changes.filter(
        change =>
          change.value.format === 'private-purchase-alias-slots/1' &&
          Object.hasOwn(change.value, 'state')
      )
      outputAssert(metadata.length <= 1, 'Alias planner has ambiguous metadata')
      if (metadata.length === 1) {
        closedOutputObject(metadata[0].value, ['format', 'binding', 'state'])
        closedOutputObject(metadata[0].value.binding, [
          'owner',
          'acquisitionId',
          'requestDigest',
          'recipient',
          'originalDigest'
        ])
        outputAssert(
          metadata[0].value.binding.owner === this.aliases.id &&
            metadata[0].value.binding.acquisitionId === id &&
            metadata[0].value.binding.requestDigest === actual.progress.requestDigest &&
            metadata[0].value.binding.recipient === actual.state.recipient,
          'Alias contribution changes native binding',
          'conflict'
        )
      }
      const next =
        metadata.length === 0
          ? actual.aliases.state
          : parsePrivatePurchaseAliasState(metadata[0].value.state)
      outputAssert(
        next.acquisitionId === id &&
          next.requestDigest === actual.progress.requestDigest &&
          next.owner === this.aliases.id &&
          next.original !== null &&
          next.purchaseCommitment === outputHex32(combined.purchaseCommitment),
        'Alias contribution changes original identity',
        'conflict'
      )
      const bounded = (): ProtectedLedgerChange[] => {
        outputAssert(
          changes.length <= 64,
          'Alias composition exceeds atomic row capacity',
          'limited'
        )
        canonicalOutputJSON(changes, { bytes: this.limits.maximumBatchBytes })
        return changes
      }
      if (
        actual.state.progress.status === 'delivered' ||
        actual.state.progress.status === 'delivery-failed'
      )
        return bounded()
      outputAssert(
        [next.original, next.selected, ...next.unconfirmed, ...next.pending].some(
          entry => entry?.txid === selectedCandidate.txid
        ),
        'Pending selection has no retained exact alias',
        'unavailable'
      )
      const firstReservedAt = actual.state.firstReservedAt ?? outputU64(view.observedAt).toString(),
        selectedTxid = selectedCandidate.txid
      outputAssert(
        actual.state.firstReservedAt !== null ||
          outputU64(firstReservedAt) < outputU64(actual.custody.original.terms.body.recoveryUntil),
        'Unconstructed alias reservation expired',
        'expired'
      )
      if (
        firstReservedAt !== actual.state.firstReservedAt ||
        selectedTxid !== actual.state.selectedTxid
      ) {
        outputAssert(
          actual.row.reservedUpdates > 1,
          'Alias selection would consume promised result completion',
          'limited'
        )
        changes.push({
          ...this.address(id),
          expectedRevision: actual.row.revision,
          reservedBytes: this.limits.maximumStateBytes,
          reservedUpdates: actual.row.reservedUpdates - 1,
          value: protectedValue(
            { ...actual.state, firstReservedAt, selectedTxid },
            this.limits.maximumStateBytes
          ).value
        })
      }
      return bounded()
    }
    let unchanged = false
    this.domain.ledger.read([this.address(id)], clock, view => {
      outputAssert(
        view.revision === prepared.revision,
        'Alias retry native head changed',
        'conflict'
      )
      unchanged = derive(view).length === 0
    })
    // Byte-identical retries have no database effect and consume no prepaid
    // revision. A real write derives its observation inside the actual writer.
    if (!unchanged)
      this.domain.ledger.commitPrepared(
        prepared.revision,
        derive,
        clock,
        view => {
          this.authorize(guard, view)
          prepared.checkCurrent(view)
        },
        { maximumBatchBytes: this.limits.maximumBatchBytes }
      )
    return this.require(id, loaded.state.recipient, clock, guard)
  }
  complete(
    loaded: PrivatePurchaseAliasedLoaded,
    input: OutputPurchaseEnvelope,
    placement: PrivatePurchaseAliasPlacement | undefined,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded {
    const id = loaded.progress.acquisitionId,
      actual = this.require(id, loaded.state.recipient, clock, guard)
    outputAssert(
      actual.revision === loaded.revision && actual.row.revision === loaded.row.revision,
      'Alias release native head changed',
      'conflict'
    )
    if (actual.progress.status === 'delivered') {
      this.disclose(actual, actual.state.recipient, clock, guard, prior =>
        outputAssert(
          canonicalOutputJSON(prior) === canonicalOutputJSON(input),
          'Historical alias result is immutable',
          'conflict'
        )
      )
      return actual
    }
    outputAssert(
      actual.progress.status === 'admitted-delivery-pending' &&
        actual.state.firstReservedAt !== null,
      'Alias lacks actual admitted delivery work',
      'unavailable'
    )
    if (actual.custody.original.terms.body.releasePolicy.kind === 'mined')
      outputAssert(
        placement !== undefined && actual.aliases.state.selected?.txid === actual.progress.txid,
        'First mined release needs the actual selected alias',
        'unavailable'
      )
    const envelope = privatePurchaseEnvelope(
      advancePrivatePurchaseProgress(
        actual.progress,
        actual.custody.original,
        { type: 'delivered', envelope: input },
        actual.observedAt,
        PROFILE
      ),
      actual.custody.original,
      input,
      PROFILE
    )
    outputAssert(
      !Object.hasOwn(envelope, 'currentAlias'),
      'First alias result cannot retain a currentness report'
    )
    outputAssert(
      envelope.result.status === 'delivered' &&
        envelope.result.potatoes.body.schema === actual.custody.schema,
      'Alias result schema differs'
    )
    decodeOutputBytes(envelope.result.potatoes.body.secret, actual.custody.maximumSecretBytes)
    const progress = advancePrivatePurchaseProgress(
      actual.progress,
      actual.custody.original,
      { type: 'delivered', envelope },
      actual.observedAt,
      PROFILE
    )
    let resultChanges: ProtectedLedgerChange[] | undefined
    this.domain.ledger.read([this.address(id)], clock, view => {
      this.authorize(guard, view)
      outputAssert(
        view.revision === actual.revision && view.observedAt === actual.observedAt,
        'Alias result preparation observation changed',
        'context-changed'
      )
      const sealed = this.payloads.seal(
        actual.state.result,
        this.rows(actual.state.result, view),
        encoded(envelope, this.limits.maximumResultBytes)
      )
      outputAssert(
        actual.row.reservedUpdates >= 1,
        'Alias result completion is missing',
        'unavailable'
      )
      resultChanges = [
        {
          ...this.address(id),
          expectedRevision: actual.row.revision,
          reservedBytes: this.limits.maximumStateBytes,
          reservedUpdates: actual.row.reservedUpdates - 1,
          value: protectedValue(
            { ...actual.state, selectedTxid: progress.txid, progress, result: sealed.descriptor },
            this.limits.maximumStateBytes
          ).value
        },
        ...sealed.changes
      ]
    })
    outputAssert(resultChanges, 'Alias result completion reservation is unavailable', 'unavailable')
    const sameObservation: ProtectedLedgerGuard = view => {
      this.authorize(guard, view)
      outputAssert(
        view.observedAt === actual.observedAt,
        'Alias result clock changed before commit',
        'context-changed'
      )
    }
    const release = this.aliases.release(
      actual.custody.original,
      actual.progress.txid!,
      placement,
      resultChanges,
      clock,
      sameObservation
    )
    outputAssert(
      release.status === 'ready',
      'Alias historical result cannot be committed',
      'unavailable'
    )
    release.retain(clock, sameObservation)
    return this.require(id, actual.state.recipient, clock, guard)
  }
  /** Only the installed domain coordinator may declare an irrecoverable local
   * failure. Transient issuance errors leave admitted-delivery-pending untouched.
   * This commits no secret or historical release and asserts no global outcome. */
  fail(
    loaded: PrivatePurchaseAliasedLoaded,
    input: { reason: string; evidence: string },
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded {
    const decision = ownOutputJSON(input, { bytes: this.limits.maximumOutcomeBytes }).value
    closedOutputObject(decision, ['reason', 'evidence'])
    const reason = outputString(decision.reason)
    outputAssert(typeof decision.evidence === 'string', 'Failure evidence must be bytes')
    decodeOutputBytes(decision.evidence, this.limits.maximumOutcomeBytes)
    const evidence = decision.evidence
    const id = loaded.progress.acquisitionId,
      actual = this.require(id, loaded.state.recipient, clock, guard)
    outputAssert(
      actual.revision === loaded.revision && actual.row.revision === loaded.row.revision,
      'Alias failure native head changed',
      'conflict'
    )
    if (actual.progress.status === 'delivery-failed') {
      outputAssert(
        actual.progress.decision?.reason === reason &&
          actual.progress.decision.evidence === evidence,
        'Retained alias failure is immutable',
        'conflict'
      )
      return actual
    }
    outputAssert(
      actual.progress.status === 'admitted-delivery-pending' && actual.candidate !== null,
      'Alias failure lacks actual admitted delivery work',
      'unavailable'
    )
    this.domain.ledger.commitPrepared(
      actual.revision,
      view => {
        this.authorize(guard, view)
        const row = view.get(this.address(id)),
          current = row && this.restore(row, actual.state.recipient, view, guard)
        outputAssert(
          current?.row.revision === actual.row.revision &&
            current.progress.status === 'admitted-delivery-pending' &&
            current.candidate !== null,
          'Alias failed work changed before commit',
          'conflict'
        )
        const progress = advancePrivatePurchaseProgress(
          current.progress,
          current.custody.original,
          { type: 'delivery-failed', reason, evidence },
          view.observedAt,
          PROFILE
        )
        const envelope = privatePurchaseEnvelope(
          progress,
          current.custody.original,
          undefined,
          PROFILE
        )
        const sealed = this.payloads.seal(
          current.state.result,
          this.rows(current.state.result, view),
          encoded(
            {
              format: 'private-purchase-failure-custody/1',
              candidate: current.candidate,
              candidateDigest: this.rawDigest(current.custody.original, current.candidate),
              envelope
            },
            this.limits.maximumResultBytes
          )
        )
        outputAssert(
          current.row.reservedUpdates >= 1,
          'Alias failure completion reservation is unavailable',
          'unavailable'
        )
        const changes: ProtectedLedgerChange[] = [
          {
            ...this.address(id),
            expectedRevision: current.row.revision,
            reservedBytes: this.limits.maximumStateBytes,
            reservedUpdates: current.row.reservedUpdates - 1,
            value: protectedValue(
              {
                ...current.state,
                selectedTxid: progress.txid,
                progress,
                result: sealed.descriptor
              },
              this.limits.maximumStateBytes
            ).value
          },
          ...sealed.changes
        ]
        outputAssert(changes.length <= 64, 'Alias failure exceeds atomic row capacity', 'limited')
        canonicalOutputJSON(changes, { bytes: this.limits.maximumBatchBytes })
        return changes
      },
      clock,
      view => this.authorize(guard, view),
      { maximumBatchBytes: this.limits.maximumBatchBytes }
    )
    return this.require(id, actual.state.recipient, clock, guard)
  }
  private rawDigest(original: PrivatePurchaseOriginal, candidate: OutputPurchaseSubmit): string {
    const assembled = assembleOutputEvidence(
      { txid: candidate.txid, beef: candidate.beef, outputIndex: 0 },
      original.request.listing.chain,
      { bytes: this.limits.maximumCandidateBytes, transactions: 4096, dependencies: 16384 }
    )
    outputAssert(
      assembled.target !== undefined && assembled.missing.length === 0,
      'Failed alias complete raw candidate is unavailable',
      'unavailable'
    )
    const raw = Uint8Array.from(
      decodeOutputBytes(assembled.target.rawTransaction, this.limits.maximumCandidateBytes)
    )
    try {
      return Utils.toHex(Hash.sha256(raw))
    } finally {
      raw.fill(0)
    }
  }
  private require(
    id: string,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasedLoaded {
    const loaded = this.load(id, buyer, clock, guard)
    outputAssert(loaded, 'Purchase not found', 'not-found')
    return loaded
  }
  disclose(
    loaded: PrivatePurchaseAliasedLoaded,
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
      (actual, view) => {
        const retained =
          actual.progress.status === 'delivered'
            ? decoded(
                this.payloads.read(actual.state.result, this.rows(actual.state.result, view)),
                this.limits.maximumResultBytes
              )
            : undefined
        return privatePurchaseEnvelope(actual.progress, actual.custody.original, retained, PROFILE)
      },
      send
    )
  }
  discloseTerms(
    loaded: PrivatePurchaseAliasedLoaded,
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
      (actual, view) => {
        outputAssert(
          actual.state.firstReservedAt === null &&
            actual.progress.status === 'prepared' &&
            outputU64(view.observedAt) <
              outputU64(actual.custody.original.terms.body.purchaseUntil),
          'Alias preparation is no longer payable',
          'expired'
        )
        return this.contracts.original(actual.custody.original).terms
      },
      send
    )
  }
  private enqueue<T>(
    loaded: PrivatePurchaseAliasedLoaded,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    select: (actual: PrivatePurchaseAliasedLoaded, view: ProtectedLedgerView) => T,
    send: (value: T) => void
  ): void {
    outputAssert(
      typeof send === 'function' && send.constructor.name !== 'AsyncFunction',
      'Alias result enqueue must be synchronous'
    )
    const id = loaded.progress.acquisitionId
    let prepared: { value: T; revision: string } | undefined
    this.domain.ledger.disclose(
      loaded.revision,
      [this.address(id)],
      clock,
      view => {
        this.authorize(guard, view)
        const row = view.get(this.address(id)),
          actual = row && this.restore(row, outputIdentity(buyer), view, guard)
        outputAssert(
          actual?.row.revision === loaded.row.revision &&
            actual.progress.requestDigest === loaded.progress.requestDigest,
          'Alias disclosure changed',
          'not-found'
        )
        const value = select(actual, view),
          selection = this.contracts.restore(actual.custody.original.capability)
        canonicalOutputJSON(value, { bytes: selection.profile.maxResponseBytes })
        prepared = { value, revision: actual.row.revision }
      },
      rows => {
        outputAssert(
          prepared && rows[0]?.revision === prepared.revision,
          'Alias disclosure changed before enqueue',
          'conflict'
        )
        const checked: unknown = send(prepared.value)
        if (checked instanceof Promise) void checked.catch(() => undefined)
        outputAssert(checked === undefined, 'Alias result enqueue must finish synchronously')
      }
    )
  }
  private feasible(custody: PrivatePurchaseCustody): void {
    const selection = this.contracts.restore(custody.original.capability),
      body = custody.original.terms.body
    const frame = canonicalOutputJSON({
      result: {
        version: 1,
        status: 'delivered',
        acquisitionId: body.acquisitionId,
        txid: '0'.repeat(64),
        purchaseCommitment: '0'.repeat(64),
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
            purchaseCommitment: '0'.repeat(64),
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
    })
    const releaseBaseBytes = Buffer.byteLength(
      canonicalOutputJSON({
        chain: body.listing.chain,
        txid: '0'.repeat(64),
        policy: body.releasePolicy,
        acceptedAt: '18446744073709551615'
      })
    )
    // Alias outcome slots have a fixed 128 KiB admission ceiling, independently
    // of the effect owner's separately configured local failure-decision budget.
    // Local-admission evidence has a closed fixed shape. A mined block report
    // additionally carries this bounded candidate BEEF plus bounded context and
    // header metadata. Processor evidence retains the existing 128 KiB ceiling.
    let releaseMaximum = 131072
    if (body.releasePolicy.kind === 'local-admission') releaseMaximum = releaseBaseBytes
    else if (body.releasePolicy.kind === 'mined')
      releaseMaximum = Math.min(131072, releaseBaseBytes + this.limits.maximumCandidateBytes + 8192)
    const deliveryMaximum =
      Buffer.byteLength(frame) +
      4 * Math.ceil(custody.maximumSecretBytes / 3) +
      131072 +
      releaseMaximum
    const failureMaximum =
      this.limits.maximumCandidateBytes + 131072 + this.limits.maximumOutcomeBytes + 16384
    outputAssert(
      deliveryMaximum <= selection.profile.maxResponseBytes &&
        Math.max(deliveryMaximum, failureMaximum) <= this.limits.maximumResultBytes,
      'Alias result cannot fit its promised envelope',
      'limited'
    )
    // First release changes only alias metadata, the historical header/chunks,
    // result owner metadata and its complete signed-result chunks. Reserve their
    // combined native batch before terms are payable, rather than finding a
    // capacity shortfall after an admitted purchase.
    const candidateChunks = Math.ceil(this.aliasLimits.maximumCandidateBytes / 786432),
      resultChunks = Math.ceil(this.limits.maximumResultBytes / 786432)
    const completionBytes =
      16384 +
      131072 +
      8192 +
      4 * Math.ceil(this.aliasLimits.maximumCandidateBytes / 3) +
      candidateChunks * 8192 +
      this.limits.maximumStateBytes +
      4 * Math.ceil(this.limits.maximumResultBytes / 3) +
      resultChunks * 8192 +
      65536
    outputAssert(
      3 + candidateChunks + resultChunks <= 64 &&
        completionBytes <= this.aliasLimits.maximumBatchBytes &&
        completionBytes <= this.limits.maximumBatchBytes,
      'Alias first result exceeds reserved atomic completion capacity',
      'limited'
    )
  }
}
function encoded(input: unknown, maximum: number): string {
  return Buffer.from(canonicalOutputJSON(input, { bytes: maximum }), 'utf8').toString('base64')
}
function decoded(input: string, maximum: number): unknown {
  return parseOutputJSON(Uint8Array.from(decodeOutputBytes(input, maximum)), { bytes: maximum })
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const method = owner[key]
  return () => owner[key] === method
}
