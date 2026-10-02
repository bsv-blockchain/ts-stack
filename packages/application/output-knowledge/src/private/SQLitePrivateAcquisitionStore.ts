import {
  canonicalOutputJSON,
  closedOutputObject,
  decodeOutputBytes,
  outputAssert,
  outputHex32,
  outputIdentity,
  outputU64,
  parseOutputJSON
} from '@bsv/sdk'
import { PrivateAcquisitionFundingIndex } from './PrivateAcquisitionFundingIndex.js'
import { PrivateAcquisitionPayloads } from './PrivateAcquisitionPayloads.js'
import {
  PrivateAcquisitionRecords,
  type PrivateAcquisitionOriginal,
  type PrivateAcquisitionRecordInstallation
} from './PrivateAcquisitionRecords.js'
import {
  advancePrivateAcquisitionProgress,
  PRIVATE_ACQUISITION_PROGRESS_BYTES,
  type PrivateAcquisitionEvent
} from './PrivateAcquisitionProgress.js'
import { privateAcquisitionResult } from './PrivateAcquisitionResult.js'
import {
  createPrivateAcquisitionState,
  parsePrivateAcquisitionState,
  privateAcquisitionAddress,
  privateAcquisitionPrefix,
  type PrivateAcquisitionState
} from './PrivateAcquisitionState.js'
import type { PrivateServiceDomain } from './PrivateServiceDomain.js'
import {
  protectedInteger,
  protectedValue,
  type ProtectedLedgerChange,
  type ProtectedLedgerGuard,
  type ProtectedLedgerRecord,
  type ProtectedLedgerView
} from './ProtectedLedgerCodec.js'

interface Limits {
  maximumStateBytes: number
  maximumMaterialBytes: number
  maximumBatchBytes: number
}
export interface Loaded {
  revision: string
  observedAt: string
  row: ProtectedLedgerRecord
  state: PrivateAcquisitionState
  original: PrivateAcquisitionOriginal
}
/**
 * Native atomic paid-acquisition custody and progress owner. Trusted service ports
 * establish domain eligibility, funding evidence/acceptance and actual wallet
 * receipts before these operations; no remote input is itself such a verdict.
 * All seller/chain services must share this domain and its authorization protocol.
 */
export class SQLitePrivateAcquisitionStore {
  private readonly records: PrivateAcquisitionRecords
  private readonly payloads: PrivateAcquisitionPayloads
  private readonly funding: PrivateAcquisitionFundingIndex
  private readonly limits: Limits
  private readonly extensions: readonly string[]
  constructor(
    private readonly domain: PrivateServiceDomain,
    limits: Limits,
    installation: PrivateAcquisitionRecordInstallation
  ) {
    const input = parseOutputJSON(canonicalOutputJSON(limits, { bytes: 4096 }))
    closedOutputObject(input, ['maximumStateBytes', 'maximumMaterialBytes', 'maximumBatchBytes'])
    this.limits = {
      maximumStateBytes: protectedInteger(input.maximumStateBytes, 1048576),
      maximumMaterialBytes: protectedInteger(input.maximumMaterialBytes, 4194304),
      maximumBatchBytes: protectedInteger(input.maximumBatchBytes, 64 * 1048576 + 65536)
    }
    outputAssert(
      this.limits.maximumStateBytes >= PRIVATE_ACQUISITION_PROGRESS_BYTES + 8192,
      'Acquisition progress cannot fit its future reservation',
      'limited'
    )
    this.extensions = [...(installation.supportedExtensions ?? [])]
    this.records = new PrivateAcquisitionRecords(installation)
    this.payloads = new PrivateAcquisitionPayloads(domain.identity)
    this.funding = new PrivateAcquisitionFundingIndex(domain)
    const installed = installation.contracts.configuration()
    outputAssert(
      installed.seller === domain.scope.seller &&
        canonicalOutputJSON(installed.chain) === canonicalOutputJSON(domain.scope.chain),
      'Acquisition native domain differs from installation',
      'context-changed'
    )
  }
  private addresses(id: string) {
    return [
      privateAcquisitionAddress(this.domain.identity, 'acquisition', id),
      privateAcquisitionAddress(this.domain.identity, 'quote', id)
    ] as const
  }
  private restore(
    rows: readonly (ProtectedLedgerRecord | undefined)[],
    buyer: string
  ): Omit<Loaded, 'revision' | 'observedAt'> | undefined {
    const [row, quote] = rows
    if (!row && !quote) return undefined
    outputAssert(row && quote, 'Acquisition original or progress is unavailable', 'unavailable')
    const original = this.records.restore(quote.value).record
    if (original.challenge.buyer !== buyer) return undefined
    const state = parsePrivateAcquisitionState(row.value, original)
    const addresses = this.addresses(original.challenge.acquisitionId)
    outputAssert(
      row.kind === addresses[0].kind &&
        row.key === addresses[0].key &&
        quote.kind === addresses[1].kind &&
        quote.key === addresses[1].key &&
        row.reservedBytes === this.limits.maximumStateBytes &&
        quote.reservedBytes === this.records.maximumRecordBytes,
      'Acquisition native record binding differs',
      'unavailable'
    )
    return { row, state, original }
  }
  load(
    id: string,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): Loaded | undefined {
    const identity = outputIdentity(buyer),
      addresses = this.addresses(outputHex32(id))
    const read = this.domain.ledger.read(addresses, clock, guard),
      restored = this.restore(read.records, identity)
    if (!restored) return undefined
    return { ...restored, revision: read.revision, observedAt: read.observedAt }
  }
  /** Recover before preparing new terms; an existing request always owns its original quote. */
  quote(
    input: PrivateAcquisitionOriginal,
    material: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): Loaded {
    const original = this.records.restore(input).record,
      id = original.challenge.acquisitionId
    const addresses = this.addresses(id),
      prefix = privateAcquisitionPrefix(this.domain.identity, original)
    const read = this.domain.ledger.read([...addresses, prefix.address], clock, guard)
    const prior = this.restore(read.records, original.challenge.buyer)
    if (prior) {
      outputAssert(
        prior.original.challenge.requestDigest === original.challenge.requestDigest,
        'Acquisition request conflicts with its original invoice',
        'conflict'
      )
      return { ...prior, revision: read.revision, observedAt: read.observedAt }
    }
    outputAssert(!read.records[2], 'Acquisition payment prefix is permanently reserved', 'conflict')
    const frozen = this.payloads.reserve(
      id,
      original.challenge.requestDigest,
      'material',
      this.limits.maximumMaterialBytes,
      material
    )
    const result = this.payloads.reserve(
      id,
      original.challenge.requestDigest,
      'result',
      original.maximumContextBytes
    )
    const state = createPrivateAcquisitionState(
      original,
      frozen.descriptor,
      result.descriptor,
      read.observedAt,
      this.extensions
    )
    const changes: ProtectedLedgerChange[] = [
      {
        ...addresses[0],
        expectedRevision: null,
        reservedBytes: this.limits.maximumStateBytes,
        reservedUpdates: 6,
        value: protectedValue(state, this.limits.maximumStateBytes).value
      },
      {
        ...addresses[1],
        expectedRevision: null,
        reservedBytes: this.records.maximumRecordBytes,
        reservedUpdates: 0,
        value: protectedValue(original, this.records.maximumRecordBytes).value
      },
      {
        ...prefix.address,
        expectedRevision: null,
        reservedBytes: 1024,
        reservedUpdates: 0,
        value: prefix.value
      },
      this.funding.reserveQuote(state.progress),
      ...frozen.changes,
      ...result.changes
    ]
    const revision = this.domain.ledger.commit(
      read.revision,
      changes,
      clock,
      view => {
        this.authorize(guard, view)
        outputAssert(
          view.observedAt === state.progress.createdAt &&
            outputU64(view.observedAt) < outputU64(original.challenge.payableUntil),
          'Acquisition quote clock changed before reservation',
          'conflict'
        )
      },
      { maximumBatchBytes: this.limits.maximumBatchBytes }
    )
    return {
      revision,
      observedAt: read.observedAt,
      row: { ...changes[0], revision: '1' },
      state,
      original
    }
  }
  private authorize(guard: ProtectedLedgerGuard, view: ProtectedLedgerView): void {
    outputAssert(guard(view) === undefined, 'Acquisition native guard must be synchronous')
  }
  private require(
    id: string,
    buyer: string,
    expectedRecordRevision: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): Loaded {
    const retained = this.load(id, buyer, clock, guard)
    outputAssert(retained, 'Acquisition is absent', 'not-found')
    outputAssert(
      retained.row.revision === outputU64(expectedRecordRevision).toString(),
      'Acquisition progress changed',
      'conflict'
    )
    return retained
  }
  advance(
    id: string,
    buyer: string,
    expectedRecordRevision: string,
    event: Exclude<PrivateAcquisitionEvent, { type: 'delivered' }>,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): Loaded {
    const owned = parseOutputJSON(
      canonicalOutputJSON(event, { bytes: 262144 })
    ) as unknown as PrivateAcquisitionEvent
    outputAssert(
      owned.type !== 'delivered',
      'Acquisition completion requires retained result',
      'unsupported'
    )
    const retained = this.require(id, buyer, expectedRecordRevision, clock, guard)
    const progress = advancePrivateAcquisitionProgress(
      retained.state.progress,
      owned,
      retained.observedAt
    )
    if (canonicalOutputJSON(progress) === canonicalOutputJSON(retained.state.progress))
      return retained
    if (progress.funding)
      canonicalOutputJSON(progress.funding.acceptance, {
        bytes: retained.original.maximumAcceptanceBytes
      })
    const state = parsePrivateAcquisitionState({ ...retained.state, progress }, retained.original)
    const changes: ProtectedLedgerChange[] = []
    if (owned.type === 'reserve-funding') {
      const assignment = this.funding.assign(progress, retained.revision, clock, guard)
      outputAssert(
        assignment !== null,
        'Acquisition funding assignment precedes its state',
        'unavailable'
      )
      changes.push(assignment)
    }
    return this.commitState(retained, state, changes, clock, guard, view => {
      outputAssert(
        canonicalOutputJSON(
          advancePrivateAcquisitionProgress(retained.state.progress, owned, view.observedAt)
        ) === canonicalOutputJSON(progress),
        'Acquisition event clock changed before commit',
        'conflict'
      )
    })
  }
  private commitState(
    retained: Loaded,
    state: PrivateAcquisitionState,
    extra: ProtectedLedgerChange[],
    clock: () => string,
    guard: ProtectedLedgerGuard,
    check: ProtectedLedgerGuard
  ): Loaded {
    const phase = state.progress.phase
    const required =
      phase === 'quoted'
        ? state.progress.candidate?.verdict === 'pending'
          ? 5
          : 6
        : phase === 'funding-pending'
          ? 3
          : phase === 'funded'
            ? 2
            : phase === 'delivery-pending'
              ? 1
              : 0
    const change: ProtectedLedgerChange = {
      kind: retained.row.kind,
      key: retained.row.key,
      expectedRevision: retained.row.revision,
      reservedBytes: retained.row.reservedBytes,
      reservedUpdates: Math.max(required, retained.row.reservedUpdates - 1),
      value: protectedValue(state, retained.row.reservedBytes).value
    }
    const revision = this.domain.ledger.commit(
      retained.revision,
      [change, ...extra],
      clock,
      view => {
        this.authorize(guard, view)
        check(view)
      },
      { maximumBatchBytes: this.limits.maximumBatchBytes }
    )
    return {
      ...retained,
      revision,
      state,
      row: {
        kind: change.kind,
        key: change.key,
        reservedBytes: change.reservedBytes,
        reservedUpdates: change.reservedUpdates,
        revision: (outputU64(retained.row.revision) + 1n).toString(),
        value: change.value
      }
    }
  }
  material(
    id: string,
    buyer: string,
    expectedRecordRevision: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): string {
    const retained = this.require(id, buyer, expectedRecordRevision, clock, guard)
    const read = this.domain.ledger.read(
      this.payloads.addresses(retained.state.material),
      clock,
      guard
    )
    outputAssert(
      read.revision === retained.revision,
      'Acquisition changed before material read',
      'conflict'
    )
    return this.payloads.read(retained.state.material, read.records)
  }
  /** Issue only after the delivery intent; seal its result and delivered state atomically. */
  complete(
    id: string,
    buyer: string,
    expectedRecordRevision: string,
    context: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): Loaded {
    const retained = this.require(id, buyer, expectedRecordRevision, clock, guard)
    // Own/bound bytes before observing callbacks. No text or exception is a release verdict.
    decodeOutputBytes(context, retained.original.maximumContextBytes)
    const read = this.domain.ledger.read(
      this.payloads.addresses(retained.state.result),
      clock,
      guard
    )
    outputAssert(
      read.revision === retained.revision,
      'Acquisition result reservation changed',
      'conflict'
    )
    const sealed = this.payloads.seal(retained.state.result, read.records, context)
    if (retained.state.progress.phase === 'delivered') return retained
    const progress = advancePrivateAcquisitionProgress(
      retained.state.progress,
      { type: 'delivered' },
      read.observedAt
    )
    const state = parsePrivateAcquisitionState(
      { ...retained.state, progress, result: sealed.descriptor },
      retained.original
    )
    const response = privateAcquisitionResult(
      progress,
      retained.original.request,
      { evidence: retained.original.evidence, schema: retained.original.schema, context },
      this.extensions
    )
    canonicalOutputJSON(response, {
      bytes: this.records.restore(retained.original).selection.profile.maxResponseBytes
    })
    return this.commitState(retained, state, sealed.changes, clock, guard, view => {
      outputAssert(
        canonicalOutputJSON(
          advancePrivateAcquisitionProgress(
            retained.state.progress,
            { type: 'delivered' },
            view.observedAt
          )
        ) === canonicalOutputJSON(progress),
        'Acquisition delivery clock changed before commit',
        'conflict'
      )
    })
  }
  /** Final native enqueue, after response signing; current authority shares this gate. */
  disclose(
    retained: Loaded,
    buyer: string,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    enqueue: (response: ReturnType<typeof privateAcquisitionResult>) => void
  ): void {
    outputAssert(
      enqueue.constructor.name !== 'AsyncFunction',
      'Acquisition enqueue must be synchronous'
    )
    const identity = outputIdentity(buyer),
      id = retained.original.challenge.acquisitionId
    const slots =
      retained.state.progress.phase === 'delivered'
        ? this.payloads.addresses(retained.state.result)
        : []
    this.domain.ledger.disclose(
      retained.revision,
      [...this.addresses(id), ...slots],
      clock,
      guard,
      rows => {
        const current = this.restore(rows, identity)
        outputAssert(current, 'Acquisition is absent', 'not-found')
        const result =
          current.state.progress.phase === 'delivered'
            ? {
                evidence: current.original.evidence,
                schema: current.original.schema,
                context: this.payloads.read(current.state.result, rows.slice(2))
              }
            : undefined
        const response = privateAcquisitionResult(
          current.state.progress,
          current.original.request,
          result,
          this.extensions
        )
        canonicalOutputJSON(response, {
          bytes: this.records.restore(current.original).selection.profile.maxResponseBytes
        })
        outputAssert(enqueue(response) === undefined, 'Acquisition enqueue must be synchronous')
      }
    )
  }
}
