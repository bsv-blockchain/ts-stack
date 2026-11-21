import type { SnapshotSyncContentPosition, SnapshotSyncContentRevision } from './SnapshotSyncContentRevision'
import type { TableSettings, TableUser } from '../schema/tables'
import type {
  WalletReadSnapshot,
  WalletReadSnapshotOptions,
  WalletSnapshotCursor,
  WalletSnapshotPage,
  WalletSnapshotFieldMetadataPage
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

/** Version one binds the packed row schema as well as the source view and profile. */
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

/** Previous completed-copy DATA, distinct from a newly opened physical view. */
export interface SnapshotSyncContentReceipt {
  readonly checkpoint: SnapshotSyncCheckpoint
  readonly source: Readonly<SnapshotSyncContentRevision>
}

/** One-use preparation owns any staged content/allocation until close drains.
 * Close is required after success, refusal and cancellation, outside manager
 * write admission. Neither metadata nor this local callback is a durable ACK. */
export interface SnapshotSyncFieldPreparation {
  apply: () => Promise<SnapshotSyncCommit>
  close: () => Promise<void>
}

/** Additive provider capability. Adapter callbacks stay local; an authenticated
 * remote adapter uses the separately bounded destination RPC protocol. */
export interface SnapshotSyncStorage {
  /** Authenticated remote adapters dispatch a server-owned atomic transaction.
   * Manager admission fences dispatch, then releases before HTTP/proof I/O.
   * The server must freshly fence its durable session and primary at commit. */
  commitOutsideManager?: true
  /** Negotiated full-row transport ceilings, intersected with caller policy. */
  pageLimits?: Readonly<{ maxRows: number; maxBytes: number }>
  /** False prevents switching away from an accepted immutable remote view on a resource error. */
  fallbackOnResourceError?: boolean
  /** True only after the version-one auxiliary schema and primary fencing migration committed. */
  supportsDestination: () => Promise<boolean>
  /** Separately negotiated optional content comparison. Every probe is fresh;
   * old providers retain the original row/session path. */
  supportsContentDestination?: () => Promise<boolean>
  openContentSource?: (
    identityKey: string,
    options?: WalletReadSnapshotOptions
  ) => Promise<WalletReadSnapshot | undefined>
  /** Physically close the actual observation before returning comparison DATA. */
  observeContentRevision?: (
    identityKey: string,
    since?: SnapshotSyncContentPosition,
    options?: WalletReadSnapshotOptions
  ) => Promise<Readonly<SnapshotSyncContentRevision> | undefined>
  previousContentReceipt?: (
    identityKey: string,
    sourceStorageIdentityKey: string
  ) => Promise<SnapshotSyncContentReceipt | undefined>
  /** Return the previous durable ACK only after fresh destination confirmation. */
  confirmContentReceipt?: (
    identityKey: string,
    sourceStorageIdentityKey: string,
    revision: SnapshotSyncContentRevision
  ) => Promise<SnapshotSyncCheckpoint | undefined>
  beginContent?: (
    source: SnapshotSyncSource,
    activeStorage: string | undefined,
    revision: SnapshotSyncContentRevision,
    limits?: Readonly<{ maximumSourceScopes: number }>
  ) => Promise<SnapshotSyncCheckpoint>
  /** Undefined means this configuration cannot retain a view while foreground writes proceed. */
  openSource: (identityKey: string, options?: WalletReadSnapshotOptions) => Promise<WalletReadSnapshot | undefined>
  /** Same-view retry resumes the destination cursor. A different view atomically fences its predecessor and starts at table zero. */
  begin: (
    source: SnapshotSyncSource,
    activeStorage: string | undefined,
    limits?: Readonly<{ maximumSourceScopes: number }>
  ) => Promise<SnapshotSyncCheckpoint>
  /** Observe the durable outcome after a lost acknowledgement. Never infer progress from a sender log. */
  checkpoint: (identityKey: string, sourceStorageIdentityKey: string) => Promise<SnapshotSyncCheckpoint | undefined>
  /** Detaches input and completes proof I/O before returning a one-use atomic merge/checkpoint operation. */
  prepare: (
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotPage<SnapshotSyncTable>
  ) => Promise<() => Promise<SnapshotSyncCommit>>
  /** Optional fresh local probe. False keeps the compatible row path; errors
   * indicate changed/partial installation and must propagate. No RPC feature. */
  supportsFieldDestination?: () => Promise<boolean>
  /** Additive local negotiation. Only paired source/destination support selects
   * this path. Detach/validate metadata, read/hash/prove original fields and
   * stage bounded content before returning; apply must perform no source I/O.
   * Current destination/profile/primary/data/proof fences and atomic row/maps/
   * checkpoint commit remain mandatory. A preparation failure drains its own
   * resources before rejecting. Check cancellation and the original source
   * deadline before/after each bounded read/stage. There is no version-one RPC advertisement. */
  prepareFields?: (
    checkpoint: SnapshotSyncCheckpoint,
    page: WalletSnapshotFieldMetadataPage<SnapshotSyncTable>,
    source: WalletReadSnapshot,
    signal?: AbortSignal
  ) => Promise<SnapshotSyncFieldPreparation>
  /** Additive local field-page ceilings. The coordinator intersects these
   * with the caller's original row/byte limits; old providers omit them. */
  fieldPageLimits?: Readonly<{ maxRows: number; maxBytes: number }>
}
