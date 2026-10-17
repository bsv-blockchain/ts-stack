import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import type { SnapshotJournalRevision } from './SnapshotJournalRevision'

/** Portable journal data contracts. These values describe custody; they do
 * not grant backend, profile, schema, capability or primary authority.
 * This module deliberately has no SQL or native implementation imports. */
export interface SnapshotJournalReceiptPolicy {
  receiptLimit: number
  receiptLifetimeMs: number
}
export interface SnapshotJournalReceiptBinding {
  backend: string
  epoch: string
  source: string
  schema: string
  storageIdentity: string
  identityKey: string
  userId: number
  chain: string
}
export interface SnapshotJournalReceipt {
  requestId: string
  binding: string
  highWater: SnapshotJournalRevision
  floor: SnapshotJournalRevision
  expiresAt: number
}
export interface SnapshotJournalRetention {
  floor: SnapshotJournalRevision
  receiptLimit: number
  receiptLifetimeMs: number
}

export interface SnapshotJournalPosition {
  revision: SnapshotJournalRevision
  id1: number
  id2: number
  exactText: string
}

export interface SnapshotJournalMetadata extends SnapshotJournalPosition {
  present: boolean
  generation?: SnapshotJournalRevision
}

export interface SnapshotJournalDestinationBinding {
  /** V2 profile-scoped association data supports freshly authorized full repair. */
  lineageVersion?: 2
  /** Complete current-state scan; never represents retained historical deltas. */
  bootstrap?: true
  source: SnapshotJournalReceiptBinding
  receipt: SnapshotJournalReceipt
  low: SnapshotJournalRevision
  destinationBackend: string
  destinationStorageIdentity: string
  destinationUserId: number
  primaryEpoch: SnapshotJournalRevision
  activeStorage: string | null
}

export interface SnapshotJournalDestinationCheckpoint {
  version: 1
  sessionId: string
  binding: string
  sequence: number
  phase: 'intake' | 'promoting' | 'acknowledged'
  streamIndex: number
  tableIndex: number
  after?: SnapshotJournalPosition
  promotionSequence: number
}

/** Stored source values retain nulls, dates and packed binary cells. Remapping and
 * semantic validation belong to the destination's separately fenced transaction. */
export type SnapshotJournalDelta =
  | { metadata: SnapshotJournalMetadata; present: false }
  | { metadata: SnapshotJournalMetadata; present: true; row: Record<string, unknown> }

export interface SnapshotJournalDeltaPage {
  table: WalletSnapshotTable
  changes: SnapshotJournalDelta[]
  /** Includes physical changes irrelevant to this profile; none may be skipped by the cursor. */
  examined: number
  /** Conservative stored-cell and metadata charge, not encoded bytes or RSS. */
  payloadBytes: number
  complete: boolean
  after?: SnapshotJournalPosition
}

export interface SnapshotJournalSourceGeneration {
  generation: SnapshotJournalRevision
  revision: SnapshotJournalRevision
}

export type SnapshotJournalSourceNaturalKey =
  | { tableId: 0; reference: string; txid?: string }
  | { tableId: 1; transactionId: number; vout: number }
  | { tableId: 2; serialNumber: string; certifier: string }
  | { tableId: 3; label: string }
  | { tableId: 4; name: string }
  | { tableId: 5; tag: string }
  | { tableId: 6; transactionId: number }
  | { tableId: 8 | 9; txid: string }

export interface SnapshotJournalSourceIdentity extends SnapshotJournalSourceGeneration {
  tableId: SnapshotJournalIdentityTable
  incomingId: number
  naturalIdentity: string
  naturalKey: Readonly<SnapshotJournalSourceNaturalKey>
  /** An unchanged parent must already have an acknowledged destination association. */
  required: boolean
}

export interface SnapshotJournalProgress {
  commits: number
  pages: number
  examined: number
  payloadBytes: number
  inserts: number
  updates: number
}

export type SnapshotJournalCurrentDataResult<T> = { current: false } | { current: true; value: T }

/** Only entities with independent numeric identifiers have ID-map entries. */
export type SnapshotJournalIdentityTable = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 8 | 9

export interface SnapshotJournalAutomaticRetentionPolicy {
  /** Event-clock allowance; does not grant a physical database/WAL byte quota. */
  minimumEvents: number
  /** Each native collection page examines at most 256 metadata rows. */
  maximumCollectionPages: number
}
