import type { WalletStorageProvider } from '../../../sdk/WalletStorage.interfaces'
import type { RetainedReadSnapshotOptions } from '../RetainedReadSnapshot'
import type { WalletReadSnapshot } from '../WalletReadSnapshot'
import type {
  SnapshotJournalReceipt,
  SnapshotJournalReceiptBinding,
  SnapshotJournalPosition,
  SnapshotJournalDeltaPage,
  SnapshotJournalSourceIdentity,
  SnapshotJournalDestinationBinding,
  SnapshotJournalDestinationCheckpoint,
  SnapshotJournalProgress,
  SnapshotJournalCurrentDataResult
} from './SnapshotJournalTypes'
import type { SnapshotJournalRevision } from './SnapshotJournalRevision'

export interface SnapshotJournalSource extends WalletReadSnapshot {
  readonly sourceSchema: string
  validateClosure: () => Promise<void>
  readonly receipt: SnapshotJournalReceipt
  readonly receiptBinding: SnapshotJournalReceiptBinding
}
export interface SnapshotJournalDeltaRequest {
  bootstrap?: true
  stream: 'scope' | 'physical'
  tableId: number
  low: SnapshotJournalRevision
  after?: SnapshotJournalPosition
  maximumRows: number
  maximumBytes: number
}
/** Portable source contract. A supplied digest is data; providers must retain
 * actual physical source ownership and verify current authority independently. */
export interface SnapshotJournalReconciliationSource extends SnapshotJournalSource {
  readonly primary: { activeStorage: string | null; epoch: SnapshotJournalRevision }
  verifyLive: () => Promise<void>
  withCommitFence: <T>(commit: () => Promise<T>) => Promise<T>
  withCurrentDataFence: <T>(
    since: SnapshotJournalRevision,
    commit: () => Promise<T>
  ) => Promise<SnapshotJournalCurrentDataResult<T>>
  hasChangesSince: (since: SnapshotJournalRevision) => Promise<boolean>
  readDeltaPage: (
    request: SnapshotJournalDeltaRequest,
    captureIdentities: (
      frameDigest: string,
      changeIndex: number,
      identities: ReadonlyMap<string, SnapshotJournalSourceIdentity>
    ) => Promise<void>
  ) => Promise<{ page: SnapshotJournalDeltaPage; frameDigest: string }>
}
export type SnapshotJournalWriterAdmission = <T>(operation: () => Promise<T>, observe?: 'observe') => Promise<T>
export interface SnapshotJournalDestinationLimits {
  version?: 2
  maximumBytes: number
  maximumPages: number
  maximumIdentities: number
  maximumMappings: number
  maximumPendingAssociations: number
  maximumMemberships: number
  maximumRetirements: number
  maximumProvenanceRows: number
  maximumProvenanceBytes: number
  maximumRows: number
  maximumPayloadBytes: number
  maximumChanges: number
  maximumAllocationBytes: number
}
export interface SnapshotJournalCutoverSource {
  source: SnapshotJournalReconciliationSource
  since: SnapshotJournalRevision
}
export interface SnapshotJournalReceiver {
  readonly binding: Readonly<SnapshotJournalDestinationBinding>
  status: () => Promise<{ checkpoint: SnapshotJournalDestinationCheckpoint; progress: SnapshotJournalProgress }>
  intake: (checkpoint: SnapshotJournalDestinationCheckpoint) => Promise<unknown>
  promote: (checkpoint: SnapshotJournalDestinationCheckpoint) => Promise<unknown>
  selectPrimary: (
    checkpoint: SnapshotJournalDestinationCheckpoint,
    activeStorage: string,
    sources: readonly SnapshotJournalCutoverSource[],
    onSelected?: (changed: boolean) => void
  ) => Promise<boolean>
}
/** These hooks are local scheduling contracts, not a JSON-RPC allowlist. A
 * remote implementation needs its separately authenticated durable protocol. */
export interface SnapshotJournalProvider extends WalletStorageProvider {
  supportsSnapshotJournalSync: () => Promise<boolean>
  openCurrentSnapshotJournalSource: (
    identityKey: string,
    options?: RetainedReadSnapshotOptions
  ) => Promise<SnapshotJournalReconciliationSource>
  openSnapshotJournalDestination: (
    source: SnapshotJournalReconciliationSource,
    low: SnapshotJournalRevision,
    limits: SnapshotJournalDestinationLimits,
    admission: SnapshotJournalWriterAdmission,
    signal?: AbortSignal,
    bootstrap?: true,
    preferIncremental?: true
  ) => Promise<{ destination: SnapshotJournalReceiver; checkpoint: SnapshotJournalDestinationCheckpoint }>
}
