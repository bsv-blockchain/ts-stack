import type { SnapshotSyncContentRevision } from '../SnapshotSyncContentRevision'
import type { SnapshotJournalDataContentReceipt } from './SnapshotJournalDataContentReceipt'
import type {
  SnapshotJournalWriterAdmission,
  SnapshotJournalDestinationLimits,
  SnapshotJournalReconciliationSource
} from './SnapshotJournalProvider'
import type { SnapshotJournalArchiveBinding } from './SnapshotJournalArchiveBinding'
import type { SnapshotJournalArchivePosition } from './SnapshotJournalReceiptData'
import type { RemoteSnapshotJournalArchive } from './openRemoteSnapshotJournalArchive'
import type { SnapshotJournalDataStatus } from './SnapshotJournalDataProtocol'
import type { SnapshotJournalDataDestination } from './runSnapshotJournalArchiveReconciliation'
import type { WalletReadSnapshotOptions } from '../WalletReadSnapshot'

/** Local scheduling CODE is never serialized or accepted as a remote grant. */
export interface SnapshotJournalDataOptions {
  admission?: SnapshotJournalWriterAdmission
  signal?: AbortSignal
}
export interface SnapshotJournalDataProvider {
  readonly journalDataCommitOutsideManager?: true
  supportsSnapshotJournalDataSync: () => Promise<boolean>
  getSnapshotJournalDataStatus: (
    identityKey: string,
    sourceStorageIdentity: string,
    options?: SnapshotJournalDataOptions
  ) => Promise<SnapshotJournalDataStatus | undefined>
  openSnapshotJournalDataDestination: (
    identityKey: string,
    source: SnapshotJournalArchiveBinding,
    options?: SnapshotJournalDataOptions
  ) => Promise<SnapshotJournalDataDestination | undefined>
}
export interface SnapshotJournalDataContentProvider extends SnapshotJournalDataProvider {
  supportsSnapshotJournalDataContent: () => Promise<boolean>
  getSnapshotJournalDataContentReceipt: (
    identityKey: string,
    sourceStorageIdentity: string,
    options?: SnapshotJournalDataOptions
  ) => Promise<Readonly<SnapshotJournalDataContentReceipt> | undefined>
  confirmSnapshotJournalDataContentReceipt: (
    identityKey: string,
    sourceStorageIdentity: string,
    revision: SnapshotSyncContentRevision,
    options?: SnapshotJournalDataOptions
  ) => Promise<Readonly<SnapshotJournalDataContentReceipt> | undefined>
}
/** Optional actual-local primary-aware comparison. This is not an RPC
 * capability, primary grant or selection operation. */
export interface SnapshotJournalPrimaryContentProvider extends SnapshotJournalDataContentProvider {
  confirmSnapshotJournalPrimaryContentReceipt: (
    identityKey: string,
    sourceStorageIdentity: string,
    revision: SnapshotSyncContentRevision,
    activeStorage: string | null,
    options?: SnapshotJournalDataOptions
  ) => Promise<Readonly<SnapshotJournalDataContentReceipt> | undefined>
}
export function snapshotJournalPrimaryContentProvider(value: unknown): value is SnapshotJournalPrimaryContentProvider {
  return (
    snapshotJournalDataContentProvider(value) &&
    typeof (value as Partial<SnapshotJournalPrimaryContentProvider>).confirmSnapshotJournalPrimaryContentReceipt ===
      'function'
  )
}
export function snapshotJournalDataContentProvider(value: unknown): value is SnapshotJournalDataContentProvider {
  const provider = value as Partial<SnapshotJournalDataContentProvider> | null
  return (
    provider != null &&
    typeof provider.supportsSnapshotJournalDataContent === 'function' &&
    typeof provider.getSnapshotJournalDataContentReceipt === 'function' &&
    typeof provider.confirmSnapshotJournalDataContentReceipt === 'function'
  )
}
export interface SnapshotJournalArchiveProvider {
  supportsSnapshotJournalArchive: () => Promise<boolean>
  supportsSnapshotJournalArchiveContent?: () => Promise<boolean>
  openSnapshotJournalArchive: (
    identityKey: string,
    position?: SnapshotJournalArchivePosition,
    options?: WalletReadSnapshotOptions
  ) => Promise<RemoteSnapshotJournalArchive | undefined>
}
export function snapshotJournalDataProvider(value: unknown): value is SnapshotJournalDataProvider {
  const provider = value as Partial<SnapshotJournalDataProvider> | null
  return (
    provider != null &&
    typeof provider.supportsSnapshotJournalDataSync === 'function' &&
    typeof provider.getSnapshotJournalDataStatus === 'function' &&
    typeof provider.openSnapshotJournalDataDestination === 'function'
  )
}
export function snapshotJournalArchiveProvider(value: unknown): value is SnapshotJournalArchiveProvider {
  const provider = value as Partial<SnapshotJournalArchiveProvider> | null
  return (
    provider != null &&
    typeof provider.supportsSnapshotJournalArchive === 'function' &&
    typeof provider.openSnapshotJournalArchive === 'function'
  )
}
export type { SnapshotJournalDestinationLimits, SnapshotJournalReconciliationSource }

export interface SnapshotJournalFieldArchiveProvider {
  supportsSnapshotJournalFieldArchive: () => Promise<boolean>
  openSnapshotJournalFieldArchive: (
    identityKey: string,
    position?: SnapshotJournalArchivePosition,
    options?: WalletReadSnapshotOptions
  ) => Promise<import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive | undefined>
}
export function snapshotJournalFieldArchiveProvider(value: unknown): value is SnapshotJournalFieldArchiveProvider {
  const provider = value as Partial<SnapshotJournalFieldArchiveProvider> | null
  return (
    provider != null &&
    typeof provider.supportsSnapshotJournalFieldArchive === 'function' &&
    typeof provider.openSnapshotJournalFieldArchive === 'function'
  )
}

/** Local field receiver CODE. These methods are deliberately separate from the
 * version-three row RPC: method presence cannot mint an archive or SQL grant. */
export interface SnapshotJournalFieldOptions extends SnapshotJournalDataOptions {
  limits?: SnapshotJournalDestinationLimits
}
export interface SnapshotJournalFieldStatus {
  binding: Readonly<import('./SnapshotJournalTypes').SnapshotJournalDestinationBinding>
  checkpoint: import('./SnapshotJournalTypes').SnapshotJournalDestinationCheckpoint
  progress: import('./SnapshotJournalTypes').SnapshotJournalProgress
}
export interface SnapshotJournalFieldProvider extends SnapshotJournalDataContentProvider {
  supportsSnapshotJournalFieldSync: () => Promise<boolean>
  getSnapshotJournalFieldStatus: (
    identityKey: string,
    sourceStorageIdentity: string,
    options?: SnapshotJournalFieldOptions
  ) => Promise<SnapshotJournalFieldStatus | undefined>
  openSnapshotJournalFieldDestination: (
    identityKey: string,
    source: import('./SnapshotJournalArchiveBinding').SnapshotJournalFieldArchiveBinding,
    options?: SnapshotJournalFieldOptions
  ) => Promise<import('./runSnapshotJournalArchiveReconciliation').SnapshotJournalFieldDestination | undefined>
  getSnapshotJournalFieldContentReceipt: SnapshotJournalDataContentProvider['getSnapshotJournalDataContentReceipt']
  confirmSnapshotJournalFieldContentReceipt: SnapshotJournalDataContentProvider['confirmSnapshotJournalDataContentReceipt']
}
export function snapshotJournalFieldProvider(value: unknown): value is SnapshotJournalFieldProvider {
  const provider = value as Partial<SnapshotJournalFieldProvider> | null
  return (
    snapshotJournalDataProvider(value) &&
    snapshotJournalDataContentProvider(value) &&
    provider != null &&
    typeof provider.supportsSnapshotJournalFieldSync === 'function' &&
    typeof provider.getSnapshotJournalFieldStatus === 'function' &&
    typeof provider.openSnapshotJournalFieldDestination === 'function' &&
    typeof provider.getSnapshotJournalFieldContentReceipt === 'function' &&
    typeof provider.confirmSnapshotJournalFieldContentReceipt === 'function'
  )
}

/** Local acknowledged provenance only. A caller checkpoint is comparison DATA,
 * never a writer grant or a substitute for the actual current SQL window. */
export interface SnapshotJournalFieldReadOptions extends SnapshotJournalFieldOptions {
  checkpoint?: import('./SnapshotJournalTypes').SnapshotJournalDestinationCheckpoint
  after?: number
  maximumRows?: number
  maximumMetadataBytes?: number
}
export interface SnapshotJournalFieldProvenanceRead {
  checkpoint: import('./SnapshotJournalTypes').SnapshotJournalDestinationCheckpoint
  page: import('./SnapshotJournalFieldTypes').SnapshotJournalFieldProvenancePage
}
export interface SnapshotJournalStoredFieldReader {
  readonly descriptor: Readonly<{ kind: 'binary' | 'utf8'; bytes: number; sha256: string }>
  read: (offset: number, length: number) => Promise<Uint8Array>
  close: () => void
}
export interface SnapshotJournalFieldProvenanceProvider extends SnapshotJournalFieldProvider {
  readSnapshotJournalFieldProvenance: (
    identityKey: string,
    sourceStorageIdentity: string,
    options?: SnapshotJournalFieldReadOptions
  ) => Promise<SnapshotJournalFieldProvenanceRead>
  openSnapshotJournalProvenanceField: (
    identityKey: string,
    sourceStorageIdentity: string,
    incomingId: number,
    fieldName: string,
    options?: SnapshotJournalFieldReadOptions
  ) => Promise<SnapshotJournalStoredFieldReader>
}
export function snapshotJournalFieldProvenanceProvider(
  value: unknown
): value is SnapshotJournalFieldProvenanceProvider {
  const provider = value as Partial<SnapshotJournalFieldProvenanceProvider> | null
  return (
    snapshotJournalFieldProvider(value) &&
    provider != null &&
    typeof provider.readSnapshotJournalFieldProvenance === 'function' &&
    typeof provider.openSnapshotJournalProvenanceField === 'function'
  )
}

/** Optional exact immutable-source recovery, separately negotiated from the
 * original field advertisement. It never returns a wallet SQL/source fence. */
export interface SnapshotJournalFieldArchiveRecoveryProvider extends SnapshotJournalFieldArchiveProvider {
  supportsSnapshotJournalFieldArchiveRecovery: () => Promise<boolean>
  resumeSnapshotJournalFieldArchive: (
    identityKey: string,
    reference: import('./SnapshotJournalReceiptData').SnapshotJournalFieldArchiveReference,
    options?: WalletReadSnapshotOptions
  ) => Promise<import('./openRemoteSnapshotJournalFieldArchive').RemoteSnapshotJournalFieldArchive | undefined>
  retireSnapshotJournalFieldArchive: (
    identityKey: string,
    reference: import('./SnapshotJournalReceiptData').SnapshotJournalFieldArchiveReference
  ) => Promise<void>
}
export function snapshotJournalFieldArchiveRecoveryProvider(
  value: unknown
): value is SnapshotJournalFieldArchiveRecoveryProvider {
  const provider = value as Partial<SnapshotJournalFieldArchiveRecoveryProvider> | null
  return (
    snapshotJournalFieldArchiveProvider(value) &&
    provider != null &&
    typeof provider.supportsSnapshotJournalFieldArchiveRecovery === 'function' &&
    typeof provider.resumeSnapshotJournalFieldArchive === 'function' &&
    typeof provider.retireSnapshotJournalFieldArchive === 'function'
  )
}
export interface SnapshotJournalFieldRecoveryProvider extends SnapshotJournalFieldProvider {
  supportsSnapshotJournalFieldRecovery: () => Promise<boolean>
  findSnapshotJournalFieldUpload: (
    identityKey: string,
    sourceStorageIdentity: string,
    options?: SnapshotJournalFieldOptions
  ) => Promise<import('./RemoteSnapshotJournalFieldDestination').SnapshotJournalFieldUploadResume | undefined>
  resumeSnapshotJournalFieldDestination: (
    identityKey: string,
    resume: import('./RemoteSnapshotJournalFieldDestination').SnapshotJournalFieldUploadResume,
    options?: SnapshotJournalFieldOptions
  ) => Promise<import('./RemoteSnapshotJournalFieldDestination').RemoteSnapshotJournalFieldDestination>
}
export function snapshotJournalFieldRecoveryProvider(value: unknown): value is SnapshotJournalFieldRecoveryProvider {
  const provider = value as Partial<SnapshotJournalFieldRecoveryProvider> | null
  return (
    snapshotJournalFieldProvider(value) &&
    provider != null &&
    typeof provider.supportsSnapshotJournalFieldRecovery === 'function' &&
    typeof provider.findSnapshotJournalFieldUpload === 'function' &&
    typeof provider.resumeSnapshotJournalFieldDestination === 'function'
  )
}

/** Resume an existing actual local financial window without BEGIN/replacement.
 * The reference is comparison DATA, not admission or an SQL source actor. */
export interface SnapshotJournalFieldWindowRecoveryProvider extends SnapshotJournalFieldProvider {
  resumeSnapshotJournalFieldWindow: (
    identityKey: string,
    reference: import('./SnapshotJournalReceiptData').SnapshotJournalFieldArchiveReference,
    options?: SnapshotJournalFieldOptions
  ) => Promise<import('./runSnapshotJournalArchiveReconciliation').SnapshotJournalFieldDestination | undefined>
}
export function snapshotJournalFieldWindowRecoveryProvider(
  value: unknown
): value is SnapshotJournalFieldWindowRecoveryProvider {
  return (
    snapshotJournalFieldProvider(value) &&
    typeof (value as Partial<SnapshotJournalFieldWindowRecoveryProvider>).resumeSnapshotJournalFieldWindow ===
      'function'
  )
}
