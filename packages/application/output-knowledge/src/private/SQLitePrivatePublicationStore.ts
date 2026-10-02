import {
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputString,
  outputU64,
  parseOutputJSON
} from '@bsv/sdk'
import { PrivateServiceDomain } from './PrivateServiceDomain.js'
import {
  protectedInteger,
  protectedValue,
  type ProtectedLedgerGuard,
  type ProtectedLedgerRecord
} from './ProtectedLedgerCodec.js'
import {
  createPrivatePublicationRecords,
  parsePrivatePublicationBlob,
  parsePrivatePublicationRecords,
  privatePublicationFenceAddress,
  type PrivatePublicationFence
} from './PrivatePublicationRecords.js'
import {
  advancePrivatePublicationProgress,
  parsePrivatePublicationProgress,
  type PrivatePublicationEvent,
  type PrivatePublicationProgress
} from './PrivatePublicationProgress.js'

interface Limits {
  maximumBlobBytes: number
  maximumFenceBytes: number
  supportedExtensions: readonly string[]
}
interface Loaded {
  revision: string
  observedAt: string
  record: ProtectedLedgerRecord
  blob: ReturnType<typeof parsePrivatePublicationBlob>
  fence: PrivatePublicationFence
  request: ReturnType<typeof parsePrivatePublicationRecords>['request']
}

/**
 * Internal durable publication owner. Installed service ports must first validate
 * publisher authority, the exact Bitcoin output and key/content relationship.
 * Progress events require actual retained admission/binding evidence; this class
 * does not turn caller assertions into authority and has no remote mutation API.
 * Effects happen only after their reservation has physically committed.
 */
export class SQLitePrivatePublicationStore {
  private readonly limits: Limits
  constructor(
    private readonly domain: PrivateServiceDomain,
    input: Limits
  ) {
    const value = parseOutputJSON(canonicalOutputJSON(input, { bytes: 16384 }))
    closedOutputObject(value, ['maximumBlobBytes', 'maximumFenceBytes', 'supportedExtensions'])
    outputAssert(
      Array.isArray(value.supportedExtensions) && value.supportedExtensions.length <= 32,
      'Invalid private publication extensions'
    )
    this.limits = {
      maximumBlobBytes: protectedInteger(value.maximumBlobBytes, 2 * 1024 * 1024),
      maximumFenceBytes: protectedInteger(value.maximumFenceBytes, 2 * 1024 * 1024),
      supportedExtensions: value.supportedExtensions.map(extension => outputString(extension))
    }
  }

  stage(
    request: unknown,
    selected: { publisher: string; lookup: { service: string; rulesDigest: string } },
    stagedUntil: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePublicationProgress {
    // Own the request and selection before any authorization or custody callback.
    const choice = parseOutputJSON(canonicalOutputJSON(selected, { bytes: 16384 }))
    closedOutputObject(choice, ['publisher', 'lookup'])
    const prepared = createPrivatePublicationRecords(
      request,
      this.domain.identity,
      {
        publisher: outputString(choice.publisher),
        chain: this.domain.scope.chain,
        lookup: choice.lookup as unknown as { service: string; rulesDigest: string }
      },
      '0',
      stagedUntil,
      this.limits.supportedExtensions
    )
    const address = privatePublicationFenceAddress(
      this.domain.identity,
      prepared.fence.state.publicationId
    )
    const blobAddress = { kind: 'publication' as const, key: prepared.fence.state.blobKey }
    const current = this.domain.ledger.read([address, blobAddress], clock, guard)
    const [prior, retainedBlob] = current.records
    if (prior) {
      outputAssert(
        retainedBlob !== undefined,
        'Private publication blob is unavailable',
        'unavailable'
      )
      const retained = parsePrivatePublicationRecords(
        prior.value,
        retainedBlob.value,
        this.domain.identity,
        this.limits.supportedExtensions
      )
      outputAssert(
        retained.fence.state.publicationId === prepared.fence.state.publicationId &&
          retained.fence.state.requestDigest === prepared.fence.state.requestDigest,
        'Private publication request conflicts',
        'conflict'
      )
      return retained.fence.state
    }
    if (retainedBlob)
      outputAssert(
        canonicalOutputJSON(parsePrivatePublicationBlob(retainedBlob.value)) ===
          canonicalOutputJSON(prepared.blob),
        'Private publication blob conflicts',
        'conflict'
      )
    prepared.fence.state.updatedAt = current.observedAt
    outputAssert(
      outputU64(current.observedAt) < outputU64(stagedUntil),
      'Private publication staging deadline has elapsed',
      'expired'
    )
    // Reserve the entire maximum progress representation, not just today's state.
    const skeleton = canonicalOutputJSON({ ...prepared.fence, state: {} })
    outputAssert(
      Buffer.byteLength(skeleton) + 65536 - 2 <= this.limits.maximumFenceBytes,
      'Private publication completion does not fit its reservation',
      'limited'
    )
    const fence = protectedValue(prepared.fence, this.limits.maximumFenceBytes).value
    const blob = protectedValue(prepared.blob, this.limits.maximumBlobBytes).value
    const changes = [
      {
        ...address,
        expectedRevision: null,
        reservedBytes: this.limits.maximumFenceBytes,
        reservedUpdates: 5,
        value: fence
      }
    ]
    if (!retainedBlob)
      changes.push({
        ...blobAddress,
        expectedRevision: null,
        reservedBytes: this.limits.maximumBlobBytes,
        reservedUpdates: 0,
        value: blob
      })
    this.domain.ledger.commit(current.revision, changes, clock, view => {
      outputAssert(guard(view) === undefined, 'Private publication guard must be synchronous')
      outputAssert(
        outputU64(view.observedAt) < outputU64(stagedUntil),
        'Private publication staging deadline has elapsed',
        'expired'
      )
    })
    return prepared.fence.state
  }

  load(
    publicationId: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): Loaded | undefined {
    const address = privatePublicationFenceAddress(this.domain.identity, publicationId)
    const found = this.domain.ledger.read([address], clock, guard).records[0]
    if (!found) return undefined
    const state = parsePrivatePublicationProgress(found.value.state)
    const current = this.domain.ledger.read(
      [address, { kind: 'publication', key: state.blobKey }],
      clock,
      guard
    )
    const [record, blob] = current.records
    outputAssert(
      record !== undefined && blob !== undefined,
      'Private publication retained records are unavailable',
      'unavailable'
    )
    const result = parsePrivatePublicationRecords(
      record.value,
      blob.value,
      this.domain.identity,
      this.limits.supportedExtensions
    )
    outputAssert(
      result.fence.state.publicationId === publicationId,
      'Private publication address binding differs',
      'unavailable'
    )
    return { revision: current.revision, observedAt: current.observedAt, record, ...result }
  }

  advance(
    publicationId: string,
    expectedRecordRevision: string,
    event: PrivatePublicationEvent,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePublicationProgress {
    const id = outputHex32(publicationId),
      revision = outputU64(expectedRecordRevision).toString()
    const owned = parseOutputJSON(
      canonicalOutputJSON(event, { bytes: 65536 })
    ) as unknown as PrivatePublicationEvent
    const retained = this.load(id, clock, guard)
    outputAssert(retained !== undefined, 'Private publication is absent', 'not-found')
    outputAssert(retained.record.revision === revision, 'Private publication changed', 'conflict')
    const state = advancePrivatePublicationProgress(
      retained.fence.state,
      owned,
      retained.observedAt
    )
    const value = protectedValue({ ...retained.fence, state }, retained.record.reservedBytes).value
    const terminal = state.progress.phase === 'rejected' || state.progress.phase === 'expired'
    // Consumed promises may be released at terminal state. Ready states retain
    // two slots for a later readiness loss and verified restoration.
    const reservedUpdates = terminal
      ? Math.max(0, retained.record.reservedUpdates - 1)
      : Math.max(2, retained.record.reservedUpdates - 1)
    this.domain.ledger.commit(
      retained.revision,
      [
        {
          kind: retained.record.kind,
          key: retained.record.key,
          expectedRevision: revision,
          reservedBytes: retained.record.reservedBytes,
          reservedUpdates,
          value
        }
      ],
      clock,
      view => {
        outputAssert(guard(view) === undefined, 'Private publication guard must be synchronous')
        if (owned.kind === 'reserve-admission')
          outputAssert(
            outputU64(view.observedAt) < outputU64(state.stagedUntil),
            'Private publication staging deadline has elapsed',
            'expired'
          )
      }
    )
    return state
  }
}
