import {
  ownOutputJSON,
  canonicalOutputJSON,
  closedOutputObject,
  outputAssert,
  outputHex32,
  outputString,
  outputU64
} from '@bsv/sdk'
import {
  PrivatePublicationServiceRecords,
  type PrivatePublicationServiceInstallation
} from './PrivatePublicationServiceRecords.js'
import {
  activatePrivateLookupBinding,
  parsePrivateLookupBinding,
  privateLookupBindingAddress,
  privateLookupBindingReceipt,
  type PrivateLookupBinding
} from './PrivateLookupBinding.js'
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
  parsePrivatePublicationFenceMetadata,
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
  private readonly service?: PrivatePublicationServiceRecords
  constructor(
    private readonly domain: PrivateServiceDomain,
    input: Limits,
    service?: PrivatePublicationServiceInstallation
  ) {
    const value = ownOutputJSON(input, { bytes: 16384 }).value
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
    this.service =
      service === undefined ? undefined : new PrivatePublicationServiceRecords(domain, service)
  }

  stage(
    request: unknown,
    selected: {
      publisher: string
      lookup: { service: string; rulesDigest: string }
    },
    stagedUntil: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePublicationProgress {
    return this.stagePrepared(this.prepare(request, selected, stagedUntil), clock, guard)
  }

  stageVerified(
    request: unknown,
    selected: {
      publisher: string
      lookup: { service: string; rulesDigest: string }
    },
    stagedUntil: string,
    original: unknown,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePublicationProgress {
    outputAssert(
      this.service,
      'Verified private publication installation is required',
      'unsupported'
    )
    const prepared = this.service.prepare(this.prepare(request, selected, stagedUntil), original)
    return this.stagePrepared(prepared, clock, guard, prepared.binding)
  }

  private prepare(
    request: unknown,
    selected: {
      publisher: string
      lookup: { service: string; rulesDigest: string }
    },
    stagedUntil: string
  ) {
    // Own the request and selection before any authorization or custody callback.
    const choice = ownOutputJSON(selected, { bytes: 16384 }).value
    closedOutputObject(choice, ['publisher', 'lookup'])
    return createPrivatePublicationRecords(
      request,
      this.domain.identity,
      {
        publisher: outputString(choice.publisher),
        chain: this.domain.scope.chain,
        lookup: choice.lookup as unknown as {
          service: string
          rulesDigest: string
        }
      },
      '0',
      stagedUntil,
      this.limits.supportedExtensions
    )
  }

  private stagePrepared(
    prepared: ReturnType<typeof createPrivatePublicationRecords>,
    clock: () => string,
    guard: ProtectedLedgerGuard,
    binding?: PrivateLookupBinding
  ): PrivatePublicationProgress {
    const stagedUntil = prepared.fence.state.stagedUntil
    const address = privatePublicationFenceAddress(
      this.domain.identity,
      prepared.fence.state.publicationId
    )
    const blobAddress = {
      kind: 'publication' as const,
      key: prepared.fence.state.blobKey
    }
    const bindingAddress = binding
      ? privateLookupBindingAddress(this.domain.identity, binding)
      : undefined
    const current = this.domain.ledger.read(
      [address, blobAddress, ...(bindingAddress ? [bindingAddress] : [])],
      clock,
      guard
    )
    const [prior, retainedBlob, retainedBinding] = current.records
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
      if (binding) {
        outputAssert(
          retainedBinding,
          'Private publication lookup reservation is unavailable',
          'unavailable'
        )
        this.restoreVerified(retained, retainedBinding)
      }
      return retained.fence.state
    }
    if (retainedBinding) {
      outputAssert(retainedBlob, 'Retained private lookup has no protected blob', 'unavailable')
      parsePrivateLookupBinding(retainedBinding.value, prepared.blob, this.domain.identity)
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
    if (bindingAddress && binding && !retainedBinding)
      changes.push({
        ...bindingAddress,
        expectedRevision: null,
        reservedBytes: this.service!.maximumBindingBytes,
        reservedUpdates: 1,
        value: protectedValue(binding, this.service!.maximumBindingBytes).value
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
    return {
      revision: current.revision,
      observedAt: current.observedAt,
      record,
      ...result
    }
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
    const owned = ownOutputJSON(event, { bytes: 65536 }).value as unknown as PrivatePublicationEvent
    const retained = this.load(id, clock, guard)
    outputAssert(retained !== undefined, 'Private publication is absent', 'not-found')
    outputAssert(retained.record.revision === revision, 'Private publication changed', 'conflict')
    outputAssert(
      retained.fence.format !== 'private-publication-fence/2' ||
        (owned.kind !== 'bound' && owned.kind !== 'restored'),
      'Verified publication readiness requires its native lookup binding',
      'unsupported'
    )
    const state = advancePrivatePublicationProgress(
      retained.fence.state,
      owned,
      retained.observedAt
    )
    const value = protectedValue({ ...retained.fence, state }, retained.record.reservedBytes).value
    const terminal =
      state.progress.phase === 'rejected' ||
      state.progress.phase === 'expired' ||
      state.progress.phase === 'excluded'
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

  /** Current authorized metadata; callers must separately establish private readiness. */
  loadStatus(publicationId: string, clock: () => string, guard: ProtectedLedgerGuard) {
    outputAssert(
      this.service,
      'Verified private publication installation is required',
      'unsupported'
    )
    const address = privatePublicationFenceAddress(this.domain.identity, publicationId)
    const current = this.domain.ledger.read([address], clock, guard)
    const record = current.records[0]
    if (!record) return undefined
    const fence = parsePrivatePublicationFenceMetadata(
      record.value,
      this.domain.identity,
      this.limits.supportedExtensions
    )
    outputAssert(
      fence.state.publicationId === publicationId,
      'Private publication address binding differs',
      'unavailable'
    )
    const original = this.service.restoreStatus(fence)
    return {
      revision: current.revision,
      observedAt: current.observedAt,
      record,
      fence,
      original,
      availability: 'unchecked' as const
    }
  }

  /** Record a loss without requiring the unavailable blob/key/binding to decrypt. */
  markUnavailable(
    publicationId: string,
    expectedRecordRevision: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ) {
    const revision = outputU64(expectedRecordRevision).toString()
    const retained = this.loadStatus(publicationId, clock, guard)
    outputAssert(retained, 'Private publication is absent', 'not-found')
    outputAssert(retained.record.revision === revision, 'Private publication changed', 'conflict')
    const state = advancePrivatePublicationProgress(
      retained.fence.state,
      {
        kind: 'unavailable',
        reason: 'Original private publication material or binding is unavailable'
      },
      retained.observedAt
    )
    this.domain.ledger.commit(
      retained.revision,
      [
        {
          kind: retained.record.kind,
          key: retained.record.key,
          expectedRevision: revision,
          reservedBytes: retained.record.reservedBytes,
          reservedUpdates: Math.max(2, retained.record.reservedUpdates - 1),
          value: protectedValue({ ...retained.fence, state }, retained.record.reservedBytes).value
        }
      ],
      clock,
      view => {
        outputAssert(guard(view) === undefined, 'Private publication guard must be synchronous')
      }
    )
    return state
  }

  private restoreVerified(
    retained: ReturnType<typeof parsePrivatePublicationRecords>,
    bindingRecord: ProtectedLedgerRecord
  ) {
    outputAssert(
      this.service,
      'Verified private publication installation is required',
      'unsupported'
    )
    const original = this.service.restore(retained.fence, retained.blob)
    const binding = parsePrivateLookupBinding(
      bindingRecord.value,
      retained.blob,
      this.domain.identity
    )
    const address = this.service.bindingAddress(retained.fence.state)
    outputAssert(
      bindingRecord.key === address.key &&
        bindingRecord.kind === address.kind &&
        binding.lookup.service === retained.fence.state.lookup.service &&
        binding.lookup.rulesDigest === retained.fence.state.lookup.rulesDigest,
      'Private lookup reservation address differs',
      'unavailable'
    )
    const progress = retained.fence.state.progress
    if (progress.phase === 'ready' || progress.phase === 'unavailable') {
      const receipt = privateLookupBindingReceipt(
        binding,
        retained.fence.state,
        retained.blob,
        this.domain.identity
      )
      outputAssert(
        canonicalOutputJSON(progress.binding) === canonicalOutputJSON(receipt),
        'Private publication readiness receipt differs',
        'unavailable'
      )
    }
    return { original, binding, bindingRecord }
  }

  loadVerified(publicationId: string, clock: () => string, guard: ProtectedLedgerGuard) {
    outputAssert(
      this.service,
      'Verified private publication installation is required',
      'unsupported'
    )
    const first = this.load(publicationId, clock, guard)
    if (!first) return undefined
    const address = privatePublicationFenceAddress(this.domain.identity, publicationId)
    const current = this.domain.ledger.read(
      [
        address,
        { kind: 'publication', key: first.fence.state.blobKey },
        this.service.bindingAddress(first.fence.state)
      ],
      clock,
      guard
    )
    const [record, blob, bindingRecord] = current.records
    outputAssert(
      record && blob && bindingRecord,
      'Verified private publication records are unavailable',
      'unavailable'
    )
    const retained = parsePrivatePublicationRecords(
      record.value,
      blob.value,
      this.domain.identity,
      this.limits.supportedExtensions
    )
    outputAssert(
      retained.fence.state.publicationId === publicationId,
      'Private publication address binding differs',
      'unavailable'
    )
    const service = this.restoreVerified(retained, bindingRecord)
    return {
      revision: current.revision,
      observedAt: current.observedAt,
      record,
      ...retained,
      ...service
    }
  }

  /** Activate the actual binding and readiness in the same physical native commit. */
  bindVerified(
    publicationId: string,
    expectedRecordRevision: string,
    clock: () => string,
    guard: ProtectedLedgerGuard
  ): PrivatePublicationProgress {
    const revision = outputU64(expectedRecordRevision).toString()
    const retained = this.loadVerified(publicationId, clock, guard)
    outputAssert(retained, 'Private publication is absent', 'not-found')
    outputAssert(retained.record.revision === revision, 'Private publication changed', 'conflict')
    const phase = retained.fence.state.progress.phase
    outputAssert(
      phase === 'binding' || phase === 'unavailable',
      'Publication is not awaiting native lookup binding',
      'conflict'
    )
    const binding =
      phase === 'binding'
        ? activatePrivateLookupBinding(
            retained.binding,
            retained.fence.state,
            retained.blob,
            this.domain.identity
          )
        : retained.binding
    const receipt = privateLookupBindingReceipt(
      binding,
      retained.fence.state,
      retained.blob,
      this.domain.identity
    )
    const state = advancePrivatePublicationProgress(
      retained.fence.state,
      { kind: phase === 'binding' ? 'bound' : 'restored', binding: receipt },
      retained.observedAt
    )
    const changes = [
      {
        kind: retained.record.kind,
        key: retained.record.key,
        expectedRevision: revision,
        reservedBytes: retained.record.reservedBytes,
        reservedUpdates: Math.max(2, retained.record.reservedUpdates - 1),
        value: protectedValue({ ...retained.fence, state }, retained.record.reservedBytes).value
      }
    ]
    if (retained.binding.phase === 'reserved')
      changes.push({
        kind: retained.bindingRecord.kind,
        key: retained.bindingRecord.key,
        expectedRevision: retained.bindingRecord.revision,
        reservedBytes: retained.bindingRecord.reservedBytes,
        reservedUpdates: Math.max(0, retained.bindingRecord.reservedUpdates - 1),
        value: protectedValue(binding, retained.bindingRecord.reservedBytes).value
      })
    this.domain.ledger.commit(retained.revision, changes, clock, view => {
      outputAssert(guard(view) === undefined, 'Private publication guard must be synchronous')
    })
    return state
  }
}
