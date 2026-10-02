import { OutputProtocolError, outputAssert } from '@bsv/sdk'
import type { OutputCapabilitySelection, OutputPrivatePublish, STEAK } from '@bsv/sdk'
import type { PrivatePublicationVerificationReference } from './PrivatePublicationVerificationLeases.js'
import type { VerifiedPrivatePublicationEvidence } from './SDKPrivatePublicationEvidence.js'

/** Trusted installation port, structurally implemented by the optional Engine adapter. */
export interface PrivatePublicationAdmission {
  readonly maximumPrivateBytes: number
  readonly maximumOutcomeBytes: number
  recover(
    job: {
      publisher: string
      publicationId: string
      requestDigest: string
      operationId: string
      rawTransaction: string
      request: OutputPrivatePublish
    },
    selected: OutputCapabilitySelection,
    verification: PrivatePublicationVerificationReference
  ): Promise<
    {
      operationId: string
      txid: string
    } & (
      | { status: 'unresolved' }
      | {
          status: 'admitted' | 'excluded'
          steak: STEAK
          assessmentContextId: string
          context: 'matching-private-values' | 'public'
        }
    )
  >
}

/** Constructed by authenticated transport, never deserialized from a request body. */
export interface PrivatePublicationCaller {
  publisher: string
  capability: string
  profile: string
  current: () => boolean
  signal?: AbortSignal
}

/** Installed application schema: prove publisher authority and the asset/key relationship. */
export type PrivatePublicationValidator = (
  request: OutputPrivatePublish,
  evidence: VerifiedPrivatePublicationEvidence,
  signal: AbortSignal
) => Promise<void>

export interface PrivatePublicationStorageSnapshot {
  revision: string
  observedAt: string
  record: import('./ProtectedLedgerCodec.js').ProtectedLedgerRecord
  blob: import('./PrivatePublicationRecords.js').PrivatePublicationBlob
  fence: import('./PrivatePublicationRecords.js').PrivatePublicationFence
  request: OutputPrivatePublish
  original: import('./PrivatePublicationContractRecord.js').PrivatePublicationContractRecord
  binding: import('./PrivateLookupBinding.js').PrivateLookupBinding
  bindingRecord: import('./ProtectedLedgerCodec.js').ProtectedLedgerRecord
}

/** Metadata is an original protected record, never a current readiness proof. */
export interface PrivatePublicationStatusSnapshot extends Pick<
  PrivatePublicationStorageSnapshot,
  'revision' | 'observedAt' | 'record' | 'fence' | 'original'
> {
  availability: 'unchecked'
}

/**
 * Installed protected owner. A conforming backend preserves atomic reservations,
 * original records, exact CAS semantics and synchronous current guards on the same
 * physical domain used for disclosure. A shape-compatible object alone is no proof
 * of these guarantees; alternate backends require the same conformance evidence.
 */
export interface PrivatePublicationStore {
  loadStatus(
    publicationId: string,
    clock: () => string,
    guard: import('./ProtectedLedgerCodec.js').ProtectedLedgerGuard
  ): PrivatePublicationStatusSnapshot | undefined
  markUnavailable(
    publicationId: string,
    expectedRecordRevision: string,
    clock: () => string,
    guard: import('./ProtectedLedgerCodec.js').ProtectedLedgerGuard
  ): import('./PrivatePublicationProgress.js').PrivatePublicationProgress

  stageVerified(
    request: unknown,
    selected: { publisher: string; lookup: { service: string; rulesDigest: string } },
    stagedUntil: string,
    original: unknown,
    clock: () => string,
    guard: import('./ProtectedLedgerCodec.js').ProtectedLedgerGuard
  ): import('./PrivatePublicationProgress.js').PrivatePublicationProgress
  loadVerified(
    publicationId: string,
    clock: () => string,
    guard: import('./ProtectedLedgerCodec.js').ProtectedLedgerGuard
  ): PrivatePublicationStorageSnapshot | undefined
  advance(
    publicationId: string,
    expectedRecordRevision: string,
    event: import('./PrivatePublicationProgress.js').PrivatePublicationEvent,
    clock: () => string,
    guard: import('./ProtectedLedgerCodec.js').ProtectedLedgerGuard
  ): import('./PrivatePublicationProgress.js').PrivatePublicationProgress
  bindVerified(
    publicationId: string,
    expectedRecordRevision: string,
    clock: () => string,
    guard: import('./ProtectedLedgerCodec.js').ProtectedLedgerGuard
  ): import('./PrivatePublicationProgress.js').PrivatePublicationProgress
}

export interface PrivatePublicationWorker {
  isCurrent(signal?: AbortSignal): boolean
  resolve(
    publicationId: string,
    signal?: AbortSignal
  ): import('./PrivatePublicationWork.js').PrivatePublicationWorkItem | undefined
  scan(
    afterKey: string | null,
    maximum: number,
    signal?: AbortSignal
  ): {
    entries: import('./PrivatePublicationWork.js').PrivatePublicationWorkItem[]
    blocked: { key: string; status: string }[]
    next: string | null
  }
}

/** A ready projection requires the actual complete records; loss retains a durable fence. */
export function readCurrentPrivatePublicationStatus(
  store: Pick<PrivatePublicationStore, 'loadStatus' | 'loadVerified' | 'markUnavailable'>,
  publicationId: string,
  clock: () => string,
  guard: import('./ProtectedLedgerCodec.js').ProtectedLedgerGuard,
  validateMetadata: (metadata: PrivatePublicationStatusSnapshot) => void
):
  | { metadata: PrivatePublicationStatusSnapshot; verified?: PrivatePublicationStorageSnapshot }
  | undefined {
  const metadata = store.loadStatus(publicationId, clock, guard)
  if (!metadata) return undefined
  outputAssert(
    typeof validateMetadata === 'function' && validateMetadata.constructor.name !== 'AsyncFunction',
    'Publication metadata selection validation must be synchronous'
  )
  const validation: unknown = validateMetadata(metadata)
  if (validation instanceof Promise) void validation.catch(() => undefined)
  outputAssert(
    validation === undefined,
    'Publication metadata selection validation must finish synchronously'
  )
  if (metadata.fence.state.progress.phase !== 'ready') return { metadata }
  try {
    const verified = store.loadVerified(publicationId, clock, guard)
    outputAssert(verified, 'Private publication is absent', 'unavailable')
    return { metadata: { ...verified, availability: 'unchecked' }, verified }
  } catch (error) {
    if (!(error instanceof OutputProtocolError) || error.code !== 'unavailable') throw error
    store.markUnavailable(publicationId, metadata.record.revision, clock, guard)
    const retained = store.loadStatus(publicationId, clock, guard)
    outputAssert(
      retained && retained.fence.state.progress.phase === 'unavailable',
      'Private publication loss is not durably recorded',
      'unavailable'
    )
    return { metadata: retained }
  }
}
