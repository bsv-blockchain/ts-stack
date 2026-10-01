import type { TableSettings, TableUser } from '../schema/tables'
import type {
  WalletReadSnapshot,
  WalletReadSnapshotOptions,
  WalletSnapshotCursor,
  WalletSnapshotPage
} from './WalletReadSnapshot'

/** Dependency order for replica merges. Source operational sync states are archive provenance, not replica cursors. */
export const snapshotSyncTables = Object.freeze([
  'provenTxs',
  'outputBaskets',
  'outputTags',
  'txLabels',
  'transactions',
  'outputs',
  'txLabelMaps',
  'outputTagMaps',
  'certificates',
  'certificateFields',
  'commissions',
  'provenTxReqs'
] as const)
export type SnapshotSyncTable = (typeof snapshotSyncTables)[number]

/** Version one binds the packed row schema as well as the source view and profile. Local only. */
export interface SnapshotSyncSource {
  version: 1
  snapshotId: string
  sourceStorage: TableSettings
  user: TableUser
  expiresAt: number
}

export interface SnapshotSyncCheckpoint {
  version: 1
  sessionId: string
  identityKey: string
  sourceStorageIdentityKey: string
  destinationStorageIdentityKey: string
  snapshotId: string
  /** Next table in snapshotSyncTables. Its length means complete. */
  tableIndex: number
  sequence: number
  cursor?: WalletSnapshotCursor
  done: boolean
}

export interface SnapshotSyncCommit {
  checkpoint: SnapshotSyncCheckpoint
  inserts: number
  updates: number
}

/** Additive provider capability. These adapter methods are absent from the RPC allowlist. */
export interface SnapshotSyncStorage {
  /** False prevents switching away from an accepted immutable remote view on a resource error. */
  fallbackOnResourceError?: boolean
  /** True only after the version-one auxiliary schema and primary fencing migration committed. */
  supportsDestination: () => Promise<boolean>
  /** Undefined means this configuration cannot retain a view while foreground writes proceed. */
  openSource: (identityKey: string, options?: WalletReadSnapshotOptions) => Promise<WalletReadSnapshot | undefined>
  /** Same-view retry resumes the destination cursor. A different view atomically fences its predecessor and starts at table zero. */
  begin: (source: SnapshotSyncSource, activeStorage: string | undefined) => Promise<SnapshotSyncCheckpoint>
  /** Observe the durable outcome after a lost acknowledgement. Never infer progress from a sender log. */
  checkpoint: (identityKey: string, sourceStorageIdentityKey: string) => Promise<SnapshotSyncCheckpoint | undefined>
  /** Detaches input and completes proof I/O before returning a one-use atomic merge/checkpoint operation. */
  prepare: (
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotPage<SnapshotSyncTable>
  ) => Promise<() => Promise<SnapshotSyncCommit>>
}
