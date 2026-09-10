import {
  parseStorageUint64,
  type HistoryFence,
  type StorageScope,
  type StorageUint64
} from './AdmissionStorage.js'

export interface RecoveryLease extends HistoryFence {
  scope: StorageScope
  topic: string
  peerId: string
  jobId: string
  leaseToken: StorageUint64
  expiresAtMs: StorageUint64
}

/** Use database time and this predicate INSIDE the checkpoint/publication CAS. */
export function isRecoveryLeaseCurrent(
  expected: RecoveryLease,
  current: RecoveryLease,
  nowMs: StorageUint64
): boolean {
  return (
    expected.scope.network === current.scope.network &&
    expected.scope.genesisHash === current.scope.genesisHash &&
    expected.scope.nodeId === current.scope.nodeId &&
    expected.topic === current.topic &&
    expected.peerId === current.peerId &&
    expected.jobId === current.jobId &&
    parseStorageUint64(expected.chainEpoch) === parseStorageUint64(current.chainEpoch) &&
    parseStorageUint64(expected.topicHistoryGeneration) ===
      parseStorageUint64(current.topicHistoryGeneration) &&
    parseStorageUint64(expected.leaseToken) === parseStorageUint64(current.leaseToken) &&
    parseStorageUint64(current.expiresAtMs) > parseStorageUint64(nowMs)
  )
}

/** A repair's own revision/checkpoint must move together; other workers rewind. */
export interface HistoryRevisionHandoff {
  expected: RecoveryLease
  checkpoint: string
}

/** Immutable history; a current pointer must CAS both revisions and the header. */
export interface TopicAnchorRevision extends HistoryFence {
  scope: StorageScope
  topic: string
  height: StorageUint64
  blockHash: string
  basmRoot: string
  admittedCount: StorageUint64
  tac: string
  previousTac: string
  policyId: string
}

/** A local tuple does not negotiate a remote protocol. Evidence comes from S06. */
export type GaspCursorEvidence =
  | { mode: 'negotiated-tuple'; negotiated: boolean; pageFinalized: boolean }
  | {
      mode: 'inclusive-since'
      inclusiveSemanticsProven: boolean
      equalScoreDrained: boolean
      pageFinalized: boolean
    }
  | {
      mode: 'full-resync'
      noSkipSemanticsProven: boolean
      resyncCompleted: boolean
      pageFinalized: boolean
    }
  | { mode: 'unsupported'; pageFinalized: boolean }

/** Gate for a durable finalization/cursor transaction; never advances a cursor. */
export function canAdvanceGaspCursor(evidence: GaspCursorEvidence): boolean {
  if (!evidence.pageFinalized) return false
  switch (evidence.mode) {
    case 'negotiated-tuple':
      return evidence.negotiated
    case 'inclusive-since':
      return evidence.inclusiveSemanticsProven && evidence.equalScoreDrained
    case 'full-resync':
      return evidence.noSkipSemanticsProven && evidence.resyncCompleted
    default:
      return false
  }
}
