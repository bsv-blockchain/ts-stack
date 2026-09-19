import { createHash } from 'node:crypto'
import type { HistoryRevisionHandoff } from './RecoveryContract.js'

/** Canonical unsigned decimal, 0..2^64-1. Never round through a JS number. */
export type StorageUint64 = string & { readonly __brand: unique symbol }

export interface StorageScope {
  network: string
  genesisHash: string
  nodeId: string
}

/** These revisions are independent: a late admission need not be a reorg. */
export interface HistoryFence {
  chainEpoch: StorageUint64
  topicHistoryGeneration: StorageUint64
}

export interface AdmissionIdentity {
  scope: StorageScope
  /** Derived from verified immutable transaction bytes before storage is called. */
  txid: string
  mode: 'live' | 'historical'
  /** Digest of off-chain values and any other immutable admission-policy inputs. */
  contextDigest: string
  topics: Array<{ topic: string; policyId: string }>
}

export interface AdmissionOperationKey {
  scope: StorageScope
  operationId: string
  semanticDigest: string
}

/** Small reference to content published outside the database transaction. */
export interface AdmissionPayloadRef {
  digest: string
  byteLength: StorageUint64
  kind: 'raw-transaction' | 'merkle-path' | 'beef-manifest' | 'locking-script' | 'outbox-data'
}

export interface AdmissionOutpoint {
  txid: string
  /** Canonical decimal uint32, the transaction wire outpoint index domain. */
  outputIndex: StorageUint64
}

/** Adapter-issued revision token; absence is also a read predicate. */
export interface AdmissionReadPredicate {
  key: string
  expectedVersion: string | null
}

export interface AdmissionOutput extends AdmissionOutpoint {
  satoshis: StorageUint64
  score: StorageUint64
  /** A byte range supports even an individually oversized output script. */
  script: { payload: AdmissionPayloadRef; offset: StorageUint64; byteLength: StorageUint64 }
}

export interface AdmissionTopicDecision {
  topic: string
  expectedHistory: HistoryFence
  /** Includes all point/range/projection reads that influenced topic admission. */
  reads: AdmissionReadPredicate[]
  spends: Array<{ outpoint: AdmissionOutpoint; expectedVersion: string; spender: string }>
  /** Remove current serving outputs only; retain applied history and evidence. */
  evictions: AdmissionOutpoint[]
  outputs: AdmissionOutput[]
  edges: Array<{ source: AdmissionOutpoint; consumer: AdmissionOutpoint }>
  /** Retain this history after output spend, serving moderation or index eviction. */
  applied: {
    txid: string
    firstSeenHeight?: StorageUint64
    proof?: AdmissionPayloadRef
    block?: { height: StorageUint64; hash: string; index: StorageUint64; merkleRoot: string }
  }
  /** Invalidate downstream anchors/comparisons; own repair checkpoint moves atomically. */
  historyUpdate?: {
    nextTopicHistoryGeneration: StorageUint64
    affectedFromHeight: StorageUint64
    /** Present when a recovery worker itself caused this history revision. */
    handoff?: HistoryRevisionHandoff
  }
}

/** Every event has a stable scope-local ID and ready payload references. */
export interface AdmissionOutboxIntent {
  eventId: string
  kind: 'lookup' | 'propagation'
  target: string
  payloads: AdmissionPayloadRef[]
}

export interface AdmissionCommit {
  key: AdmissionOperationKey
  identity: AdmissionIdentity
  /** Shared raw/proof components or a manifest; never per-output inline BEEF. */
  payloads: AdmissionPayloadRef[]
  decisions: AdmissionTopicDecision[]
  outbox: AdmissionOutboxIntent[]
  /** Exact UTF-8 STEAK JSON saved with the commit, then replayed without regeneration. */
  steak: string
}

export interface AdmissionReceipt {
  operationId: string
  semanticDigest: string
  /** Only the selected adapter can establish this guarantee. */
  durability: 'atomic-local'
  steak: string
  /** Only enlisted indexes may be visible at commit. External indexes remain pending. */
  indexes: Array<{ target: string; state: 'visible' | 'pending' }>
  propagation: 'not-requested' | 'pending'
}

/** Pending is not an ACK. Unknown commit must retain its opaque attempt identity. */
export type AdmissionCommitResult =
  | { state: 'committed'; receipt: AdmissionReceipt }
  | { state: 'pending'; attemptId: string }
  | {
      state: 'rejected'
      code:
        | 'digest-mismatch'
        | 'read-conflict'
        | 'spend-conflict'
        | 'payload-not-ready'
        | 'unsupported-projection'
        | 'invalid-plan'
    }

export type AdmissionReconcileResult = AdmissionCommitResult | { state: 'aborted' }

/**
 * Optional v1 contract, separate from legacy CRUD Storage. No current adapter or
 * Engine call path implements it. A provider must atomically revalidate reads,
 * fences, conditional spends and ready-payload pins, and save every effect plus
 * the receipt. Matching retries return the saved receipt before checking stale
 * reads; conflicting semantic digests reject. Do not run verification, uploads,
 * network requests or arbitrary plug-ins inside commitAdmission.
 *
 * TransientTransactionError permits a fresh whole-body attempt after abort and
 * reread/redecision. UnknownTransactionCommitResult requires reconcileAdmission
 * on the SAME attempt until committed or definitively aborted; absence of an
 * operation record alone does not establish abort. Repeated commitAdmission
 * must first recover any persisted unresolved attempt for this operation, even
 * after a lost response or process restart, before it can start a fresh body.
 * Transport failures remain
 * errors, never rejection/abort or a successful local ACK.
 */
export interface AdmissionStorage {
  readonly protocol: 'overlay-admission-v1'
  commitAdmission: (plan: AdmissionCommit) => Promise<AdmissionCommitResult>
  reconcileAdmission: (
    key: AdmissionOperationKey,
    attemptId?: string
  ) => Promise<AdmissionReconcileResult>
}

/** External projection delivery may be retried only with both capabilities. */
export interface ReplaySafeProjection {
  readonly protocol: 'overlay-projection-v1'
  applyEvent: (
    scope: StorageScope,
    intent: AdmissionOutboxIntent
  ) => Promise<{ checkpoint: string }>
  reconcile: (scope: StorageScope, checkpoint: string | null) => Promise<{ checkpoint: string }>
}

/** Shape detection is a declaration, not proof that an adapter is durable. */
export function getAdmissionStorage(storage: unknown): AdmissionStorage | undefined {
  if (typeof storage !== 'object' || storage === null || !('admission' in storage)) return undefined
  const candidate = storage.admission
  if (typeof candidate !== 'object' || candidate === null) return undefined
  if (!('protocol' in candidate) || candidate.protocol !== 'overlay-admission-v1') return undefined
  if (!('commitAdmission' in candidate) || typeof candidate.commitAdmission !== 'function')
    return undefined
  if (!('reconcileAdmission' in candidate) || typeof candidate.reconcileAdmission !== 'function')
    return undefined
  return candidate as AdmissionStorage
}

export function isReplaySafeProjection(projection: unknown): projection is ReplaySafeProjection {
  return (
    typeof projection === 'object' &&
    projection !== null &&
    'protocol' in projection &&
    projection.protocol === 'overlay-projection-v1' &&
    'applyEvent' in projection &&
    typeof projection.applyEvent === 'function' &&
    'reconcile' in projection &&
    typeof projection.reconcile === 'function'
  )
}

export function parseStorageUint64(value: string): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,19})$/.test(value))
    throw new Error('Invalid storage uint64')
  const result = BigInt(value)
  if (result > BigInt('18446744073709551615')) throw new Error('Invalid storage uint64')
  return result
}

export function asStorageUint64(value: string): StorageUint64 {
  parseStorageUint64(value)
  return value as StorageUint64
}

/** Validate the wire outpoint domain before conversion to an exact STEAK number. */
export function parseStorageOutputIndex(value: string): number {
  const result = parseStorageUint64(value)
  if (result > BigInt('4294967295')) throw new Error('Invalid storage output index')
  return Number(result)
}

/**
 * SHA-256 of UTF-8 length-framed fields, see specs/overlay/persistence-v1.md.
 * Mutable reads/decisions and proof variants are deliberately outside semantic
 * identity. Their validation and atomic read predicates remain mandatory.
 */
export function admissionSemanticDigest(identity: AdmissionIdentity): string {
  if (
    !/^[0-9a-f]{64}$/.test(identity.txid) ||
    !/^[0-9a-f]{64}$/.test(identity.scope.genesisHash) ||
    !/^[0-9a-f]{64}$/.test(identity.contextDigest)
  ) {
    throw new Error('Invalid admission hash')
  }
  if (identity.mode !== 'live' && identity.mode !== 'historical')
    throw new Error('Invalid admission mode')
  const topics = [...identity.topics].sort((a, b) =>
    Buffer.compare(Buffer.from(a.topic), Buffer.from(b.topic))
  )
  if (
    topics.length === 0 ||
    topics.some((item, index) => index > 0 && item.topic === topics[index - 1].topic)
  ) {
    throw new Error('Invalid admission topics')
  }
  const fields = [
    'overlay-admission-v1',
    identity.scope.network,
    identity.scope.genesisHash,
    identity.scope.nodeId,
    identity.txid,
    identity.mode,
    identity.contextDigest,
    String(topics.length),
    ...topics.flatMap(({ topic, policyId }) => [topic, policyId])
  ]
  const hash = createHash('sha256')
  for (const field of fields) {
    if (field.length === 0 || !field.isWellFormed()) throw new Error('Invalid admission identity')
    const bytes = Buffer.from(field, 'utf8')
    hash.update(String(bytes.length) + ':')
    hash.update(bytes)
  }
  return hash.digest('hex')
}
