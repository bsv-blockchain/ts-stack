import { createHash } from 'node:crypto'
import {
  Beef,
  Utils,
  canonicalOutputJSONWithInlineRecords as canonicalOutputJSON,
  createClosedOutputObjectValidator,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputPacketDigestWithInlineStrings as outputPacketDigest,
  outputU64,
  ownOutputJSONWithCountedRecords as ownOutputJSON,
  parseOutputJSONWithOwnedRecords as parseOutputJSON,
  parseOutputPurchaseSubmitWithOwnedRecords as parseOutputPurchaseSubmit,
  type OutputJSONObject,
  type OutputPurchaseSubmit
} from '@bsv/sdk'
import { assembleOutputEvidence } from '../EvidenceAssembler.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import type {
  PrivatePurchaseContracts,
  PrivatePurchaseOriginal
} from './PrivatePurchaseContracts.js'
import { privatePurchaseOperation } from './PrivatePurchaseProgress.js'
import {
  ownPrivatePurchaseAdmissionOutcome,
  type PrivatePurchaseAdmissionOutcome,
  type PrivatePurchaseValidation
} from './PrivatePurchasePorts.js'
import {
  createPrivatePurchaseAliasState,
  parsePrivatePurchaseAliasState,
  retainPrivatePurchaseAlias,
  advancePrivatePurchaseAliasAdmission,
  releasePrivatePurchaseAlias,
  type PrivatePurchaseAliasState,
  type PrivatePurchaseAliasPlacement,
  type PrivatePurchaseAliasEntry
} from './PrivatePurchaseAliasState.js'
import {
  protectedInteger,
  type ProtectedLedgerAddress,
  type ProtectedLedgerChange,
  type ProtectedLedgerGuard,
  type ProtectedLedgerRecord,
  type ProtectedLedgerView
} from './ProtectedLedgerCodec.js'

// Capture only fixed field definitions; validate every supplied value afresh.
const assertAliasLimitFields: ReturnType<typeof createClosedOutputObjectValidator> =
  createClosedOutputObjectValidator([
    'maximumCandidateBytes',
    'maximumUnconfirmed',
    'maximumPending',
    'maximumWrites',
    'maximumBatchBytes'
  ])
const assertMetadataFields: ReturnType<typeof createClosedOutputObjectValidator> =
  createClosedOutputObjectValidator(['format', 'binding', 'state'])
const assertChunkFields: ReturnType<typeof createClosedOutputObjectValidator> =
  createClosedOutputObjectValidator(['format', 'binding', 'role', 'index', 'data'])
const assertHeaderFields: ReturnType<typeof createClosedOutputObjectValidator> =
  createClosedOutputObjectValidator([
    'format',
    'binding',
    'role',
    'admission',
    'bytes',
    'digest',
    'outcome',
    'completedAt'
  ])

const FORMAT = 'private-purchase-alias-slots/1',
  CHUNK = 786432,
  STATE_BYTES = 16384,
  OUTCOME_BYTES = 131072
export interface PrivatePurchaseAliasLimits {
  maximumCandidateBytes: number
  maximumUnconfirmed: number
  maximumPending: number
  maximumWrites: number
  maximumBatchBytes: number
}
export interface PrivatePurchaseAliasSnapshot {
  state: PrivatePurchaseAliasState
  candidates: ReadonlyMap<string, OutputPurchaseSubmit>
  outcomes: ReadonlyMap<string, PrivatePurchaseAdmissionOutcome>
  /** First local terminal record time, derived from its committing native view. */
  completedAt: ReadonlyMap<string, string>
  /** Fresh native read fence, not a saved Bitcoin/current-chain verdict. */
  checkCurrent: ProtectedLedgerGuard
}
interface Snapshot extends PrivatePurchaseAliasSnapshot {
  binding: OutputJSONObject
  revision: string
  records: ProtectedLedgerRecord[]
}
interface AliasPlan {
  original: PrivatePurchaseOriginal
  snapshot: Snapshot
  state: PrivatePurchaseAliasState
  candidates: ReadonlyMap<string, OutputPurchaseSubmit>
  outcomes: ReadonlyMap<string, PrivatePurchaseAdmissionOutcome>
  guard: ProtectedLedgerGuard
  verification: ProtectedLedgerGuard
  extra: readonly ProtectedLedgerChange[]
  cumulative?: OutputPurchaseSubmit
}
/** Owned contribution for a separately installed SAME-ledger effect owner.
 * It grants no admission/release authority. Commit these exact changes with the
 * result owner's changes under checkCurrent in one native transaction. */
export interface PrivatePurchaseAliasPrepared {
  revision: string
  /** Derive exact owned changes inside the SAME authenticated native writer. */
  changes(view: ProtectedLedgerView): readonly ProtectedLedgerChange[]
  checkCurrent: ProtectedLedgerGuard
}
export type PrivatePurchaseAliasWrite =
  | { status: 'pending'; reason: 'external-operations-unresolved' | 'cache-operations-unresolved' }
  | {
      status: 'ready'
      /** Proposed metadata only; read again after retention for actual native custody. */
      state: PrivatePurchaseAliasState
      /** Independently verify the returned cumulative candidate before retention. */
      candidate?: OutputPurchaseSubmit
      /** No I/O or effect. The effect owner binds this contribution to its own
       * actual native observation and complete signed-result preparation. */
      prepare(
        guard: ProtectedLedgerGuard,
        combined?: PrivatePurchaseValidation
      ): PrivatePurchaseAliasPrepared
      retain(
        clock: () => string,
        guard: ProtectedLedgerGuard,
        combined?: PrivatePurchaseValidation
      ): void
    }

/** Independent explicitly installed alias companion. Every mandatory role and
 * cache slot is prepaid before signed preparation leaves the host. It records
 * exact transactions and per-txid jobs; it does not sign, admit, issue a secret,
 * prove Script/inclusion or turn historical metadata into current authority.
 * Combine first historical-copy changes with first signed-result custody at the
 * effect owner; the existing exact-txid stores are not silently migrated. */
export class SQLitePrivatePurchaseAliases {
  readonly id: string
  private readonly installedId: string
  private readonly limits: PrivatePurchaseAliasLimits
  private readonly chunks: number
  private readonly roles: string[]
  private readonly ledger: PrivateServiceDomain['ledger']
  private readonly identity: PrivateServiceDomain['identity']
  private readonly pins: (() => boolean)[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    private readonly contracts: PrivatePurchaseContracts,
    limits: PrivatePurchaseAliasLimits
  ) {
    const value = ownOutputJSON(limits, { bytes: 4096 }).value
    assertAliasLimitFields(value)
    this.limits = Object.freeze({
      maximumCandidateBytes: protectedInteger(value.maximumCandidateBytes, 4194304),
      maximumUnconfirmed: protectedInteger(value.maximumUnconfirmed, 4),
      maximumPending: protectedInteger(value.maximumPending, 2),
      maximumWrites: protectedInteger(value.maximumWrites, 64),
      maximumBatchBytes: protectedInteger(value.maximumBatchBytes, 64 * 1024 * 1024 + 65536)
    })
    outputAssert(
      this.limits.maximumWrites >= 4,
      'Alias custody cannot complete its first promised release',
      'limited'
    )
    this.chunks = Math.ceil(this.limits.maximumCandidateBytes / CHUNK)
    this.roles = [
      'original',
      'historical',
      'selected',
      ...Array.from({ length: this.limits.maximumUnconfirmed }, (_, i) => `unconfirmed/${i}`),
      ...Array.from({ length: this.limits.maximumPending }, (_, i) => `pending/${i}`)
    ]
    Object.freeze(this.roles)
    outputAssert(
      1 + this.roles.length * (1 + this.chunks) <= 64,
      'Alias reservation exceeds the native atomic row limit',
      'limited'
    )
    outputAssert(
      this.limits.maximumBatchBytes >=
        this.roles.length *
          (Math.ceil(this.limits.maximumCandidateBytes / 3) * 4 +
            this.chunks * 8192 +
            OUTCOME_BYTES +
            8192) +
          STATE_BYTES +
          65536,
      'Alias native batch cannot honor every prepaid role',
      'limited'
    )
    this.id = outputPacketDigest('purchase', {
      purpose: FORMAT,
      scope: domain.scope,
      limits: this.limits
    })
    this.installedId = this.id
    const configured = contracts.configuration()
    outputAssert(
      configured.seller === domain.scope.seller &&
        canonicalOutputJSON(configured.chain) === canonicalOutputJSON(domain.scope.chain),
      'Alias physical domain differs from its purchase installation',
      'context-changed'
    )
    this.ledger = domain.ledger
    this.identity = domain.identity
    this.pins = [
      pin(this.ledger, 'read'),
      pin(this.ledger, 'commit'),
      pin(this.ledger, 'commitPrepared'),
      pin(this.identity, 'address'),
      pin(contracts, 'original')
    ]
  }
  /** Owned local capacity descriptor for SAME-writer effect composition.
   * It is not admission, chain or release authority. */
  configuration(): PrivatePurchaseAliasLimits {
    this.current()
    return { ...this.limits }
  }
  /** Composition requires the same physical owner and immutable contracts. */
  installedOn(domain: PrivateServiceDomain, contracts: PrivatePurchaseContracts): void {
    this.current()
    outputAssert(
      domain === this.domain && contracts === this.contracts,
      'Alias owner does not belong to this purchase installation',
      'context-changed'
    )
  }
  private current(): void {
    outputAssert(
      this.id === this.installedId &&
        this.domain.ledger === this.ledger &&
        this.domain.identity === this.identity &&
        this.pins.every(check => check()),
      'Purchase alias custody installation changed',
      'context-changed'
    )
  }
  private authorized(guard: ProtectedLedgerGuard): ProtectedLedgerGuard {
    outputAssert(
      typeof guard === 'function' && guard.constructor.name !== 'AsyncFunction',
      'Alias native authorization must be synchronous'
    )
    return view => {
      this.current()
      const result: unknown = guard(view)
      if (result instanceof Promise) void result.catch(() => undefined)
      outputAssert(result === undefined, 'Alias native authorization must finish synchronously')
    }
  }
  private binding(input: PrivatePurchaseOriginal): OutputJSONObject {
    this.current()
    const original = this.contracts.original(input)
    return {
      owner: this.id,
      acquisitionId: original.terms.body.acquisitionId,
      requestDigest: original.terms.body.requestDigest,
      recipient: original.request.recipient,
      originalDigest: outputPacketDigest('purchase', {
        request: original.request,
        terms: original.terms,
        capability: original.capability
      })
    }
  }
  private addresses(binding: OutputJSONObject): ProtectedLedgerAddress[] {
    const common = { purpose: FORMAT, acquisitionId: binding.acquisitionId }
    return [
      this.identity.address('candidate', { ...common, role: 'state' }),
      ...this.roles.flatMap(role =>
        Array.from({ length: this.chunks + 1 }, (_, index) =>
          this.identity.address('candidate', { ...common, role, index })
        )
      )
    ]
  }
  private stateValue(
    binding: OutputJSONObject,
    state: PrivatePurchaseAliasState
  ): OutputJSONObject {
    return { format: FORMAT, binding, state: state as unknown as OutputJSONObject }
  }
  private entry(state: PrivatePurchaseAliasState, role: string): PrivatePurchaseAliasEntry | null {
    if (role === 'original') return state.original
    if (role === 'historical') return state.historical
    if (role === 'selected') return state.selected
    if (role.startsWith('unconfirmed/'))
      return state.unconfirmed[Number(role.slice('unconfirmed/'.length))]
    return state.pending[Number(role.slice('pending/'.length))]
  }
  private updates(entry: PrivatePurchaseAliasEntry | null): number {
    if (entry === null) return 0
    if (entry.admission === 'retained') return 2
    return entry.admission === 'pending' ? 1 : 0
  }
  private stateUpdates(state: PrivatePurchaseAliasState): number {
    const pending = new Map<string, number>()
    for (const role of this.roles) {
      const entry = this.entry(state, role)
      if (entry) pending.set(entry.txid, this.updates(entry))
    }
    return (
      (state.historical === null ? 1 : 0) + [...pending.values()].reduce((sum, n) => sum + n, 0)
    )
  }
  private header(
    binding: OutputJSONObject,
    role: string,
    entry: PrivatePurchaseAliasEntry | null,
    candidate: OutputPurchaseSubmit | null,
    outcome: PrivatePurchaseAdmissionOutcome | null,
    completedAt: string | null = null
  ): OutputJSONObject {
    const text =
      candidate === null
        ? null
        : canonicalOutputJSON(candidate, { bytes: this.limits.maximumCandidateBytes })
    return {
      format: FORMAT,
      binding,
      role,
      admission: entry?.admission ?? null,
      bytes: text === null ? null : Buffer.byteLength(text),
      digest: text === null ? null : hash(text),
      outcome: outcome as unknown as OutputJSONObject | null,
      completedAt
    }
  }
  private chunk(
    binding: OutputJSONObject,
    role: string,
    index: number,
    data: string | null
  ): OutputJSONObject {
    return { format: FORMAT, binding, role, index, data }
  }
  private allowance(index: number): number {
    return (
      Math.ceil(Math.min(CHUNK, this.limits.maximumCandidateBytes - index * CHUNK) / 3) * 4 + 8192
    )
  }
  reserve(
    original: PrivatePurchaseOriginal,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): void {
    const binding = this.binding(original),
      addresses = this.addresses(binding),
      read = this.ledger.read(addresses, clock, this.authorized(guard))
    if (read.records[0]) {
      this.snapshot(original, clock, guard)
      return
    }
    outputAssert(
      read.records.every(x => x === undefined),
      'Alias reservation is partial',
      'unavailable'
    )
    const state = createPrivatePurchaseAliasState(
      String(binding.acquisitionId),
      String(binding.requestDigest),
      this.id,
      this.limits.maximumUnconfirmed,
      this.limits.maximumPending
    )
    const changes: ProtectedLedgerChange[] = [
      {
        ...addresses[0],
        expectedRevision: null,
        reservedBytes: STATE_BYTES,
        reservedUpdates: this.limits.maximumWrites,
        value: this.stateValue(binding, state)
      }
    ]
    for (let slot = 0; slot < this.roles.length; slot++) {
      const role = this.roles[slot],
        offset = 1 + slot * (this.chunks + 1)
      changes.push({
        ...addresses[offset],
        expectedRevision: null,
        reservedBytes: OUTCOME_BYTES + 8192,
        reservedUpdates: this.limits.maximumWrites,
        value: this.header(binding, role, null, null, null)
      })
      for (let index = 0; index < this.chunks; index++)
        changes.push({
          ...addresses[offset + index + 1],
          expectedRevision: null,
          reservedBytes: this.allowance(index),
          reservedUpdates: this.limits.maximumWrites,
          value: this.chunk(binding, role, index, null)
        })
    }
    this.ledger.commit(read.revision, changes, clock, this.authorized(guard), {
      maximumBatchBytes: this.limits.maximumBatchBytes
    })
  }
  read(
    original: PrivatePurchaseOriginal,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasSnapshot {
    const snapshot = this.snapshot(original, clock, guard)
    return publicSnapshot(snapshot)
  }
  private snapshot(
    original: PrivatePurchaseOriginal,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): Snapshot {
    const binding = this.binding(original),
      addresses = this.addresses(binding),
      read = this.ledger.read(addresses, clock, this.authorized(guard))
    return this.restoreSnapshot(original, binding, addresses, read, guard)
  }
  /** Bounded inspection inside the effect owner's existing authenticated
   * native read/writer. No nested ledger transaction or saved chain verdict.
   * The caller supplies the actual view from this same installed ledger. */
  inspect(
    original: PrivatePurchaseOriginal,
    view: ProtectedLedgerView,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasSnapshot {
    this.authorized(guard)(view)
    const binding = this.binding(original),
      addresses = this.addresses(binding)
    return publicSnapshot(
      this.restoreSnapshot(
        original,
        binding,
        addresses,
        {
          revision: view.revision,
          records: addresses.map(address => view.get(address))
        },
        guard
      )
    )
  }
  private restoreSnapshot(
    original: PrivatePurchaseOriginal,
    binding: OutputJSONObject,
    addresses: ProtectedLedgerAddress[],
    read: { revision: string; records: (ProtectedLedgerRecord | undefined)[] },
    guard: ProtectedLedgerGuard
  ): Snapshot {
    outputAssert(
      read.records.every((x): x is ProtectedLedgerRecord => x !== undefined),
      'Original alias custody is missing',
      'unavailable'
    )
    const records = read.records as ProtectedLedgerRecord[],
      body = records[0].value
    // This binding was constructed for this fresh snapshot from owned strings.
    // Serialize it lazily once; every stored binding is still checked afresh.
    let expectedBinding: string | undefined
    const matchesBinding = (value: unknown): boolean =>
      canonicalOutputJSON(value) === (expectedBinding ??= canonicalOutputJSON(binding))
    assertMetadataFields(body)
    outputAssert(
      body.format === FORMAT && matchesBinding(body.binding),
      'Alias original binding changed',
      'unavailable'
    )
    const state = parsePrivatePurchaseAliasState(body.state)
    outputAssert(
      state.owner === this.id &&
        state.acquisitionId === binding.acquisitionId &&
        state.requestDigest === binding.requestDigest &&
        state.unconfirmed.length === this.limits.maximumUnconfirmed &&
        state.pending.length === this.limits.maximumPending &&
        records[0].reservedBytes === STATE_BYTES &&
        records[0].reservedUpdates === this.budget(records[0]) &&
        records[0].reservedUpdates >= this.stateUpdates(state),
      'Alias native state capacity changed',
      'unavailable'
    )
    const candidates = new Map<string, OutputPurchaseSubmit>(),
      outcomes = new Map<string, PrivatePurchaseAdmissionOutcome>(),
      completedAt = new Map<string, string>(),
      exactOutcomes = new Map<string, string>()
    const restoreFrames = (
      offset: number,
      role: string,
      entry: PrivatePurchaseAliasEntry | null
    ): string => {
      let encoded = ''
      for (let index = 0; index < this.chunks; index++) {
        const chunkRow = records[offset + index + 1],
          frame = chunkRow.value
        assertChunkFields(frame)
        outputAssert(
          frame.format === FORMAT &&
            frame.role === role &&
            frame.index === index &&
            matchesBinding(frame.binding) &&
            chunkRow.reservedBytes === this.allowance(index) &&
            chunkRow.reservedUpdates === this.budget(chunkRow),
          'Alias native chunk reservation changed',
          'unavailable'
        )
        outputAssert(
          entry === null ? frame.data === null : typeof frame.data === 'string',
          'Alias native chunk is incomplete',
          'unavailable'
        )
        if (typeof frame.data === 'string') {
          outputAssert(
            frame.data.length <= this.allowance(index),
            'Alias chunk exceeds bound',
            'unavailable'
          )
          encoded += frame.data
        }
      }
      return encoded
    }
    const restoreRole = (slot: number): void => {
      const role = this.roles[slot],
        offset = 1 + slot * (this.chunks + 1),
        entry = this.entry(state, role),
        row = records[offset],
        header = row.value
      assertHeaderFields(header)
      outputAssert(
        header.format === FORMAT &&
          header.role === role &&
          matchesBinding(header.binding) &&
          row.reservedBytes === OUTCOME_BYTES + 8192 &&
          row.reservedUpdates === this.budget(row) &&
          row.reservedUpdates >= this.updates(entry) &&
          header.admission === (entry?.admission ?? null),
        'Alias native header changed',
        'unavailable'
      )
      const encoded = restoreFrames(offset, role, entry)
      if (entry === null) {
        outputAssert(
          header.bytes === null &&
            header.digest === null &&
            header.outcome === null &&
            header.completedAt === null,
          'Empty alias role changed',
          'unavailable'
        )
        return
      }
      const bytes = Uint8Array.from(decodeOutputBytes(encoded, this.limits.maximumCandidateBytes))
      try {
        const candidate = parseOutputPurchaseSubmit(
            parseOutputJSON(bytes, { bytes: this.limits.maximumCandidateBytes })
          ),
          text = canonicalOutputJSON(candidate, { bytes: this.limits.maximumCandidateBytes })
        outputAssert(
          candidate.acquisitionId === binding.acquisitionId &&
            candidate.txid === entry.txid &&
            Buffer.from(bytes).toString('utf8') === text &&
            bytes.byteLength === header.bytes &&
            hash(text) === header.digest &&
            this.rawDigest(original, candidate) === entry.candidateDigest &&
            privatePurchaseOperation(original, entry.txid) === entry.operationId,
          'Alias raw candidate or operation differs',
          'unavailable'
        )
        candidates.set(role, candidate)
      } finally {
        bytes.fill(0)
      }
      if (header.outcome !== null) {
        const outcome = ownPrivatePurchaseAdmissionOutcome(header.outcome)
        outputAssert(
          outcome.txid === entry.txid &&
            outcome.operationId === entry.operationId &&
            outcome.status !== 'unresolved' &&
            outcome.status === entry.admission,
          'Alias admission outcome differs',
          'unavailable'
        )
        const time = outputU64(header.completedAt).toString(),
          terminalIdentity = canonicalOutputJSON(
            { outcome, completedAt: time },
            { bytes: OUTCOME_BYTES + 8192 }
          ),
          previousOutcome = exactOutcomes.get(entry.txid)
        outputAssert(
          outputU64(time) >= outputU64(original.createdAt) &&
            (outcome.status !== 'admitted' || outputU64(outcome.acceptedAt) <= outputU64(time)) &&
            (previousOutcome === undefined || previousOutcome === terminalIdentity),
          'Alias terminal time or repeated exact outcome differs',
          'unavailable'
        )
        exactOutcomes.set(entry.txid, terminalIdentity)
        completedAt.set(role, time)
        outcomes.set(role, outcome)
      } else
        outputAssert(
          header.completedAt === null &&
            (entry.admission === 'retained' || entry.admission === 'pending'),
          'Alias terminal outcome is missing',
          'unavailable'
        )
    }
    for (let slot = 0; slot < this.roles.length; slot++) restoreRole(slot)
    const checkCurrent: ProtectedLedgerGuard = view => {
      this.authorized(guard)(view)
      outputAssert(
        view.revision === read.revision &&
          addresses.every(
            (address, index) => view.get(address)?.revision === records[index].revision
          ),
        'Alias custody changed before effect',
        'conflict'
      )
    }
    return {
      binding,
      revision: read.revision,
      records,
      state,
      candidates,
      outcomes,
      completedAt,
      checkCurrent
    }
  }
  /** Complete verification supplies the full identity and synchronous guard.
   * Incoming/cumulative evidence must be independently checked by the caller.
   * This planner never accepts a wire digest or claims Script validity itself. */
  propose(
    original: PrivatePurchaseOriginal,
    input: unknown,
    verification: PrivatePurchaseValidation,
    placement: PrivatePurchaseAliasPlacement | undefined,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasWrite {
    const candidate = parseOutputPurchaseSubmit(
        ownOutputJSON(input, { bytes: this.limits.maximumCandidateBytes }).value
      ),
      snapshot = this.snapshot(original, clock, guard),
      entry: PrivatePurchaseAliasEntry = {
        txid: candidate.txid,
        candidateDigest: this.rawDigest(original, candidate),
        operationId: privatePurchaseOperation(original, candidate.txid),
        admission: 'retained'
      },
      validation = ownedValidation(verification)
    outputAssert(
      candidate.acquisitionId === snapshot.binding.acquisitionId,
      'Alias acquisition differs'
    )
    validation.checkCurrent()
    const place = placement ? capturedCheck(placement) : undefined
    // Retry proof custody is cumulative, independently of cache routing. A
    // byte-identical immutable role needs no optional cache allocation: full
    // caches must not prevent recovery of the original financial transaction.
    const cumulativeCandidate = (): OutputPurchaseSubmit => {
      let combined = candidate
      for (const previous of snapshot.candidates.values())
        if (previous.txid === candidate.txid) combined = this.combine(original, previous, combined)
      return combined
    }
    const combined = cumulativeCandidate(),
      immutable = ['original', 'historical']
        .map(role => snapshot.candidates.get(role))
        .some(
          prior =>
            prior?.txid === candidate.txid &&
            canonicalOutputJSON(prior, { bytes: this.limits.maximumCandidateBytes }) ===
              canonicalOutputJSON(combined, { bytes: this.limits.maximumCandidateBytes })
        )
    if (!place && immutable)
      return this.plan({
        original,
        snapshot,
        state: snapshot.state,
        candidates: snapshot.candidates,
        outcomes: snapshot.outcomes,
        guard,
        verification: () => validation.checkCurrent(),
        extra: [],
        cumulative: combined
      })
    const proposal = retainPrivatePurchaseAlias(
      snapshot.state,
      { purchaseCommitment: validation.purchaseCommitment, entry },
      place ? { checkCurrent: place } : undefined
    )
    if (proposal.status === 'pending') return proposal
    const remapCandidates = (): {
      candidates: Map<string, OutputPurchaseSubmit>
      outcomes: Map<string, PrivatePurchaseAdmissionOutcome>
    } => {
      const candidates = new Map(snapshot.candidates),
        outcomes = new Map(snapshot.outcomes)
      for (const role of this.roles) {
        const before = this.entry(snapshot.state, role),
          next = this.entry(proposal.state, role)
        if (next === null || next.txid === before?.txid) continue
        const source = this.roles.find(r => this.entry(snapshot.state, r)?.txid === next.txid)
        const oldCandidate = source ? snapshot.candidates.get(source) : undefined
        const oldOutcome = source ? snapshot.outcomes.get(source) : undefined
        if (oldCandidate) candidates.set(role, oldCandidate)
        if (oldOutcome) outcomes.set(role, oldOutcome)
        else outcomes.delete(role)
      }
      return { candidates, outcomes }
    }
    const { candidates, outcomes } = remapCandidates()
    candidates.set(proposal.role, combined)
    if (place) candidates.set('selected', combined)
    return this.plan({
      original,
      snapshot,
      state: proposal.state,
      candidates,
      outcomes,
      guard,
      verification: () => {
        validation.checkCurrent()
        place?.()
      },
      extra: [],
      cumulative: combined
    })
  }
  /** Durably reserve the exact job BEFORE an external admission call. Unknown
   * outcomes remain pending and cannot be evicted, replaced or called rejected. */
  admission(
    original: PrivatePurchaseOriginal,
    txid: string,
    outcome: PrivatePurchaseAdmissionOutcome | undefined,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasWrite {
    const snapshot = this.snapshot(original, clock, guard),
      id = outputHex32(txid),
      owned = outcome === undefined ? undefined : ownPrivatePurchaseAdmissionOutcome(outcome),
      status = owned?.status === 'unresolved' || owned === undefined ? 'pending' : owned.status
    if (owned)
      outputAssert(
        owned.txid === id && owned.operationId === privatePurchaseOperation(original, id),
        'Alias outcome changes the exact admission job'
      )
    const retained = this.roles
        .map(role => this.entry(snapshot.state, role))
        .find(entry => entry?.txid === id),
      terminal = retained?.admission === 'admitted' || retained?.admission === 'rejected'
    outputAssert(
      retained !== undefined,
      'Alias exact admission candidate is missing',
      'unavailable'
    )
    // A lost or late external reply cannot regress a retained terminal decision.
    // A conflicting definitive decision is still rejected below or by the transition.
    const state =
        terminal && status === 'pending'
          ? snapshot.state
          : advancePrivatePurchaseAliasAdmission(snapshot.state, id, status),
      outcomes = new Map(snapshot.outcomes)
    if (owned && owned.status !== 'unresolved')
      for (const role of this.roles) {
        if (this.entry(state, role)?.txid !== id) continue
        const before = outcomes.get(role)
        outputAssert(
          before === undefined ||
            canonicalOutputJSON(before, { bytes: OUTCOME_BYTES }) ===
              canonicalOutputJSON(owned, { bytes: OUTCOME_BYTES }),
          'A retained exact admission outcome cannot change',
          'conflict'
        )
        outcomes.set(role, owned)
      }
    return this.plan({
      original,
      snapshot,
      state,
      candidates: snapshot.candidates,
      outcomes,
      guard,
      verification: () => undefined,
      extra: []
    })
  }
  /** Call under independent release/selected-view guards; include signed result
   * changes in this SAME native commit. A historical result cannot be rewritten. */
  release(
    original: PrivatePurchaseOriginal,
    txid: string,
    placement: PrivatePurchaseAliasPlacement | undefined,
    resultChanges: readonly ProtectedLedgerChange[],
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePurchaseAliasWrite {
    const snapshot = this.snapshot(original, clock, guard),
      id = outputHex32(txid),
      state = releasePrivatePurchaseAlias(snapshot.state, id, placement),
      role = [
        'selected',
        ...this.roles.filter(r => r !== 'selected' && r !== 'original' && r !== 'historical'),
        'original',
        'historical'
      ].find(role => this.entry(snapshot.state, role)?.txid === id)
    outputAssert(role !== undefined, 'Historical alias candidate is missing', 'unavailable')
    const candidate = snapshot.candidates.get(role),
      outcome = snapshot.outcomes.get(role)
    outputAssert(
      candidate !== undefined && outcome?.status === 'admitted',
      'Historical exact admission is missing'
    )
    const candidates = new Map(snapshot.candidates),
      outcomes = new Map(snapshot.outcomes)
    candidates.set('historical', candidate)
    outcomes.set('historical', outcome)
    outputAssert(
      snapshot.state.historical === null || resultChanges.length === 0,
      'A retained historical alias cannot rewrite signed-result custody',
      'conflict'
    )
    outputAssert(
      snapshot.state.historical !== null || resultChanges.length > 0,
      'First historical alias requires the native signed-result write'
    )
    return this.plan({
      original,
      snapshot,
      state,
      candidates,
      outcomes,
      guard,
      verification: placement ? capturedCheck(placement) : () => undefined,
      extra: resultChanges
    })
  }
  private plan(input: AliasPlan): PrivatePurchaseAliasWrite {
    const {
      original,
      snapshot,
      state,
      candidates,
      outcomes,
      guard,
      verification,
      extra,
      cumulative
    } = input

    const addresses = this.addresses(snapshot.binding),
      changes: ProtectedLedgerChange[] = [],
      next = parsePrivatePurchaseAliasState(state)
    if (canonicalOutputJSON(next) !== canonicalOutputJSON(snapshot.state)) {
      const remaining = this.budget(snapshot.records[0]) - 1
      outputAssert(
        remaining >= this.stateUpdates(next),
        'Alias completion revisions are exhausted',
        'limited'
      )
      changes.push({
        ...addresses[0],
        expectedRevision: snapshot.records[0].revision,
        reservedBytes: STATE_BYTES,
        reservedUpdates: remaining,
        value: this.stateValue(snapshot.binding, next)
      })
    }
    const appendChunks = (offset: number, role: string, candidate: OutputPurchaseSubmit): void => {
      const bytes = Buffer.from(
        canonicalOutputJSON(candidate, { bytes: this.limits.maximumCandidateBytes }),
        'utf8'
      )
      try {
        for (let index = 0; index < this.chunks; index++) {
          outputAssert(
            this.budget(snapshot.records[offset + index + 1]) > 0,
            'Alias proof write capacity is exhausted',
            'limited'
          )
          changes.push({
            ...addresses[offset + index + 1],
            expectedRevision: snapshot.records[offset + index + 1].revision,
            reservedBytes: this.allowance(index),
            reservedUpdates: this.budget(snapshot.records[offset + index + 1]) - 1,
            value: this.chunk(
              snapshot.binding,
              role,
              index,
              bytes.subarray(index * CHUNK, (index + 1) * CHUNK).toString('base64')
            )
          })
        }
      } finally {
        bytes.fill(0)
      }
    }
    const appendSlot = (slot: number): void => {
      const role = this.roles[slot],
        offset = 1 + slot * (this.chunks + 1),
        entry = this.entry(next, role),
        previous = this.entry(snapshot.state, role),
        candidate = candidates.get(role),
        outcome = outcomes.get(role) ?? null
      if (entry === null) return
      outputAssert(
        candidate !== undefined &&
          candidate.txid === entry.txid &&
          candidate.acquisitionId === original.terms.body.acquisitionId,
        'Alias candidate slot is incomplete'
      )
      const existingTimeRole = this.roles.find(
          r => this.entry(snapshot.state, r)?.txid === entry.txid && snapshot.completedAt.has(r)
        ),
        completedAt =
          existingTimeRole === undefined ? null : snapshot.completedAt.get(existingTimeRole)!,
        header = this.header(snapshot.binding, role, entry, candidate, outcome, completedAt),
        oldHeader = snapshot.records[offset]
      if (
        canonicalOutputJSON(header, { bytes: OUTCOME_BYTES + 8192 }) !==
        canonicalOutputJSON(oldHeader.value, { bytes: OUTCOME_BYTES + 8192 })
      ) {
        outputAssert(
          this.budget(oldHeader) - 1 >= this.updates(entry),
          'Alias admission completion is exhausted',
          'limited'
        )
        changes.push({
          ...addresses[offset],
          expectedRevision: oldHeader.revision,
          reservedBytes: OUTCOME_BYTES + 8192,
          reservedUpdates: this.budget(oldHeader) - 1,
          value: header
        })
      }
      const old = snapshot.candidates.get(role)
      if ((role === 'original' || role === 'historical') && old)
        outputAssert(
          canonicalOutputJSON(old, { bytes: this.limits.maximumCandidateBytes }) ===
            canonicalOutputJSON(candidate, { bytes: this.limits.maximumCandidateBytes }),
          'Original and historical alias payloads are immutable',
          'conflict'
        )
      if (
        previous === null ||
        old === undefined ||
        canonicalOutputJSON(old, { bytes: this.limits.maximumCandidateBytes }) !==
          canonicalOutputJSON(candidate, { bytes: this.limits.maximumCandidateBytes })
      ) {
        appendChunks(offset, role, candidate)
      }
    }
    for (let slot = 0; slot < this.roles.length; slot++) appendSlot(slot)
    outputAssert(
      changes.length + extra.length <= 64,
      'Alias effect exceeds atomic native rows',
      'limited'
    )
    const commitGuard: ProtectedLedgerGuard = view => {
      this.authorized(guard)(view)
      snapshot.checkCurrent(view)
      verification(view)
    }
    // Own every external result change before any later callback or effect.
    const extras = extra.map(
      change =>
        ownOutputJSON(change, { bytes: 2 * 1024 * 1024 + 1024 })
          .value as unknown as ProtectedLedgerChange
    )
    const aliasAddresses = new Set(addresses.map(address => canonicalOutputJSON(address)))
    outputAssert(
      extras.every(
        change => !aliasAddresses.has(canonicalOutputJSON({ kind: change.kind, key: change.key }))
      ),
      'Result owner cannot rewrite alias custody addresses',
      'conflict'
    )
    const ownedChanges = [...changes, ...extras].map(
      change =>
        ownOutputJSON(change, { bytes: 2 * 1024 * 1024 + 8192 })
          .value as unknown as ProtectedLedgerChange
    )
    const combinedBytes = cumulative
      ? canonicalOutputJSON(cumulative, { bytes: this.limits.maximumCandidateBytes })
      : undefined
    const plan: PrivatePurchaseAliasWrite = {
      status: 'ready',
      state: parsePrivatePurchaseAliasState(next),
      ...(cumulative ? { candidate: structuredClone(cumulative) } : {}),
      prepare: (current, complete) => {
        outputAssert(
          plan.status === 'ready' && plan.prepare === ownedPrepare && plan.retain === ownedRetain,
          'Alias write proposal method changed',
          'context-changed'
        )
        const verified = combinedBytes === undefined ? undefined : ownedValidation(complete!)
        if (combinedBytes !== undefined)
          outputAssert(
            plan.status === 'ready' &&
              plan.candidate &&
              canonicalOutputJSON(plan.candidate, { bytes: this.limits.maximumCandidateBytes }) ===
                combinedBytes &&
              verified?.purchaseCommitment === next.purchaseCommitment,
            'Alias combined proof or full identity changed',
            'context-changed'
          )
        const authorize: ProtectedLedgerGuard = view => {
          commitGuard(view)
          this.authorized(current)(view)
          verified?.checkCurrent()
        }
        const prepareChanges = (view: ProtectedLedgerView): readonly ProtectedLedgerChange[] => {
          authorize(view)
          const now = outputU64(view.observedAt).toString()
          const changes = ownedChanges.map(change => {
            const owned = ownOutputJSON(change, { bytes: 2 * 1024 * 1024 + 8192 })
              .value as unknown as ProtectedLedgerChange
            if (
              aliasAddresses.has(canonicalOutputJSON({ kind: owned.kind, key: owned.key })) &&
              Object.hasOwn(owned.value, 'completedAt') &&
              owned.value.outcome !== null &&
              owned.value.completedAt === null
            ) {
              const outcome = ownPrivatePurchaseAdmissionOutcome(owned.value.outcome)
              outputAssert(
                outcome.status !== 'unresolved' &&
                  outputU64(now) >= outputU64(original.createdAt) &&
                  (outcome.status !== 'admitted' ||
                    outputU64(outcome.acceptedAt) <= outputU64(now)),
                'Alias outcome precedes its native terminal observation',
                'context-changed'
              )
              owned.value.completedAt = now
            }
            return freezeChange(owned)
          })
          boundedBatch(changes, this.limits.maximumBatchBytes)
          return Object.freeze(changes)
        }
        const prepared: PrivatePurchaseAliasPrepared = Object.freeze({
          revision: snapshot.revision,
          changes: prepareChanges,
          checkCurrent: authorize
        })
        return prepared
      },
      retain: (now, current, complete) => {
        const prepared = plan.status === 'ready' ? ownedPrepare(current, complete) : undefined
        outputAssert(prepared, 'Alias write proposal changed', 'context-changed')
        if (ownedChanges.length === 0) {
          this.ledger.read(addresses, now, prepared.checkCurrent)
          return
        }
        this.ledger.commitPrepared(
          prepared.revision,
          prepared.changes,
          now,
          prepared.checkCurrent,
          {
            maximumBatchBytes: this.limits.maximumBatchBytes
          }
        )
      }
    }
    const ownedPrepare = plan.prepare,
      ownedRetain = plan.retain
    return plan
  }
  private budget(record: ProtectedLedgerRecord): number {
    const count = BigInt(record.revision) - 1n
    outputAssert(
      count >= 0n && count <= BigInt(this.limits.maximumWrites),
      'Alias native write generation exceeds its prepaid capacity',
      'unavailable'
    )
    return this.limits.maximumWrites - Number(count)
  }
  private assemble(original: PrivatePurchaseOriginal, candidate: OutputPurchaseSubmit) {
    return assembleOutputEvidence(
      { txid: candidate.txid, beef: candidate.beef, outputIndex: 0 },
      original.request.listing.chain,
      { bytes: this.limits.maximumCandidateBytes, transactions: 4096, dependencies: 16384 }
    )
  }
  private rawDigest(original: PrivatePurchaseOriginal, candidate: OutputPurchaseSubmit): string {
    const assembled = this.assemble(original, candidate)
    outputAssert(
      assembled.target !== undefined && assembled.missing.length === 0,
      'Alias complete raw transaction is unavailable',
      'unavailable'
    )
    const bytes = Uint8Array.from(
      decodeOutputBytes(assembled.target.rawTransaction, this.limits.maximumCandidateBytes)
    )
    try {
      return createHash('sha256').update(bytes).digest('hex')
    } finally {
      bytes.fill(0)
    }
  }
  private combine(
    original: PrivatePurchaseOriginal,
    previous: OutputPurchaseSubmit,
    incoming: OutputPurchaseSubmit
  ): OutputPurchaseSubmit {
    outputAssert(
      previous.txid === incoming.txid,
      'Alias proof union changes the exact transaction',
      'conflict'
    )
    const prior = this.assemble(original, previous),
      next = this.assemble(original, incoming)
    outputAssert(
      prior.target?.rawTransaction !== undefined &&
        prior.target.rawTransaction === next.target?.rawTransaction &&
        next.missing.length === 0,
      'Alias proof union changes complete raw transaction',
      'conflict'
    )
    const raws = new Map(prior.transactions.map(tx => [tx.txid, tx.rawTransaction]))
    for (const tx of next.transactions)
      outputAssert(
        !raws.has(tx.txid) || raws.get(tx.txid) === tx.rawTransaction,
        'Alias proof union changes a dependency',
        'conflict'
      )
    if (
      canonicalOutputJSON(previous, { bytes: this.limits.maximumCandidateBytes }) ===
      canonicalOutputJSON(incoming, { bytes: this.limits.maximumCandidateBytes })
    )
      return structuredClone(previous)
    const beef = Beef.fromBinaryStrict(
      decodeOutputBytes(previous.beef, this.limits.maximumCandidateBytes)
    )
    beef.mergeBeef(
      Uint8Array.from(decodeOutputBytes(incoming.beef, this.limits.maximumCandidateBytes))
    )
    const combined = { ...incoming, beef: Utils.toBase64(beef.toBinary()) }
    canonicalOutputJSON(combined, { bytes: this.limits.maximumCandidateBytes })
    this.assemble(original, combined)
    return combined
  }
}
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
function publicSnapshot(input: PrivatePurchaseAliasSnapshot): PrivatePurchaseAliasSnapshot {
  return {
    state: parsePrivatePurchaseAliasState(input.state),
    candidates: new Map([...input.candidates].map(([key, value]) => [key, structuredClone(value)])),
    outcomes: new Map(
      [...input.outcomes].map(([key, value]) => [key, ownPrivatePurchaseAdmissionOutcome(value)])
    ),
    completedAt: new Map(input.completedAt),
    checkCurrent: input.checkCurrent
  }
}
function pin<T, K extends keyof T>(owner: T, key: K): () => boolean {
  const method = owner[key]
  outputAssert(typeof method === 'function', 'Alias native capability is required')
  return () => owner[key] === method
}
function capturedCheck(input: { checkCurrent(): void }): () => void {
  const method: unknown = Object.getOwnPropertyDescriptor(input, 'checkCurrent')?.value
  outputAssert(
    typeof method === 'function' && method.constructor.name !== 'AsyncFunction',
    'Alias validation requires an owned synchronous guard'
  )
  return () => {
    outputAssert(
      Object.getOwnPropertyDescriptor(input, 'checkCurrent')?.value === method,
      'Alias validation guard changed',
      'context-changed'
    )
    const result: unknown = method.call(input)
    if (result instanceof Promise) void result.catch(() => undefined)
    outputAssert(
      result === undefined &&
        Object.getOwnPropertyDescriptor(input, 'checkCurrent')?.value === method,
      'Alias validation guard changed',
      'context-changed'
    )
  }
}
function ownedValidation(input: PrivatePurchaseValidation): {
  purchaseCommitment: string
  checkCurrent(): void
} {
  outputAssert(
    input !== null && typeof input === 'object',
    'Complete alias proof validation is required'
  )
  const purchaseCommitment = outputHex32(
      Object.getOwnPropertyDescriptor(input, 'purchaseCommitment')?.value
    ),
    check = capturedCheck(input)
  check()
  return {
    purchaseCommitment,
    checkCurrent: () => {
      outputAssert(
        Object.getOwnPropertyDescriptor(input, 'purchaseCommitment')?.value === purchaseCommitment,
        'Alias complete purchase commitment changed',
        'context-changed'
      )
      check()
    }
  }
}

/** Only already owned JSON enters this bounded recursive freeze. */
function freezeChange(change: ProtectedLedgerChange): ProtectedLedgerChange {
  const freeze = (value: unknown): void => {
    if (value !== null && typeof value === 'object') {
      for (const nested of Object.values(value)) freeze(nested)
      Object.freeze(value)
    }
  }
  freeze(change)
  return change
}
function boundedBatch(changes: readonly ProtectedLedgerChange[], maximum: number): void {
  outputAssert(changes.length <= 64, 'Alias contribution exceeds atomic rows', 'limited')
  let bytes = 2 + Math.max(0, changes.length - 1)
  for (const change of changes) {
    bytes += Buffer.byteLength(canonicalOutputJSON(change, { bytes: 2 * 1024 * 1024 + 8192 }))
    outputAssert(bytes <= maximum, 'Alias contribution exceeds native batch capacity', 'limited')
  }
}
