import type * as tables from '../schema/tables'
import type { RetainedReadSnapshotOptions } from './RetainedReadSnapshot'

/** Version-one retained row contract. Binary columns never expand into number arrays. */
export type PackedSnapshotRow<T> = { [K in keyof T]: PackedSnapshotValue<T[K]> }
type PackedSnapshotValue<T> = T extends number[] ? Uint8Array : T

export interface WalletSnapshotTables {
  provenTxs: tables.TableProvenTx
  provenTxReqs: tables.TableProvenTxReq
  outputBaskets: tables.TableOutputBasket
  transactions: tables.TableTransaction
  commissions: tables.TableCommission
  outputs: tables.TableOutput
  outputTags: tables.TableOutputTag
  outputTagMaps: tables.TableOutputTagMap
  txLabels: tables.TableTxLabel
  txLabelMaps: tables.TableTxLabelMap
  certificates: tables.TableCertificate
  certificateFields: tables.TableCertificateField
  syncStates: tables.TableSyncState
}

export type WalletSnapshotTable = keyof WalletSnapshotTables

/** Verified position inside an immutable remote archive; never an authorization credential. */
export interface WalletSnapshotArchivePosition {
  readonly version: 1
  readonly archiveId: string
  readonly sequence: number
  readonly rowOffset: number
}

/** A position within this retained view, not a durable checkpoint or authorization credential. */
export interface WalletSnapshotCursor {
  readonly version: 1
  readonly snapshotId: string
  readonly table: WalletSnapshotTable
  readonly after: ReadonlyArray<number | string>
  readonly archivePosition?: WalletSnapshotArchivePosition
}

export interface WalletSnapshotPageLimits {
  /** Defaults to 128. Integer from 1 to 1,000. */
  maxRows?: number
  /**
   * Defaults to 262,144. Integer from 1 to 16,777,216. The SQL preflight charges
   * twice each cell's stored byte length plus 64 bytes per cell before fetching
   * payloads. This is a payload allocation budget, not encoded wire size or RSS.
   * An individual row over the budget rejects; it is never silently omitted.
   */
  maxBytes?: number
}

export interface WalletSnapshotPage<T extends WalletSnapshotTable> {
  rows: Array<PackedSnapshotRow<WalletSnapshotTables[T]>>
  /** Preflight charge for the returned rows. */
  payloadBytes: number
  /** True only when this table's retained view has been exhausted. */
  done: boolean
  /** Last returned position, usable for retry or continuation only in this view. */
  cursor?: WalletSnapshotCursor
}

export type WalletSnapshotBinaryColumn =
  'rawTx' | 'inputBEEF' | 'merklePath' | 'lockingScript' | 'noSendExpiryReclaimRawTx'
export interface WalletSnapshotMetadataRow<T extends WalletSnapshotTable> {
  /** Native binary cells are omitted; dates/booleans and original structured
   * history remain in their native form, under the metadata allocation cap. */
  fields: Partial<PackedSnapshotRow<WalletSnapshotTables[T]>>
  binaries: Partial<Record<WalletSnapshotBinaryColumn, number>>
  cursor: WalletSnapshotCursor
}
export interface WalletSnapshotMetadataPage<T extends WalletSnapshotTable> {
  rows: Array<WalletSnapshotMetadataRow<T>>
  payloadBytes: number
  done: boolean
  cursor?: WalletSnapshotCursor
}
export interface WalletSnapshotBinaryReader {
  readMetadataPage: <T extends WalletSnapshotTable>(
    table: T,
    cursor?: WalletSnapshotCursor,
    limits?: WalletSnapshotPageLimits
  ) => Promise<WalletSnapshotMetadataPage<T>>
  /** Same owned immutable view/profile as metadata. One exact <=65,536-byte
   * extent; expectedLength is data and must match the actual native value. */
  readBinaryCell: (
    table: WalletSnapshotTable,
    cursor: WalletSnapshotCursor,
    column: WalletSnapshotBinaryColumn,
    offset: number,
    length: number,
    expectedLength: number
  ) => Promise<Uint8Array>
}

/** Field metadata belongs to this retained view. It identifies bytes, never
 * a source grant, completed proof, destination receipt or activation. Text
 * encoding is explicit so a native browser string is not mistaken for UTF-8. */
export interface WalletSnapshotFieldDescriptor {
  readonly kind: 'binary' | 'utf8' | 'utf16le'
  readonly bytes: number
  readonly sha256?: string
}
export interface WalletSnapshotFieldMetadataRow<T extends WalletSnapshotTable> {
  fields: Partial<PackedSnapshotRow<WalletSnapshotTables[T]>>
  extents: Readonly<Record<string, Readonly<WalletSnapshotFieldDescriptor>>>
  cursor: WalletSnapshotCursor
}
export interface WalletSnapshotFieldMetadataPage<T extends WalletSnapshotTable> {
  rows: Array<WalletSnapshotFieldMetadataRow<T>>
  payloadBytes: number
  done: boolean
  cursor?: WalletSnapshotCursor
}
export interface WalletSnapshotFieldReader {
  /** Cumulative bytes actually returned by field-extent calls, including
   * repeated verification/replay reads. Local telemetry DATA, never encoded
   * wire size, allocation/RSS or source/destination permission. */
  readonly extentBytesRead?: number
  readMetadataPage: <T extends WalletSnapshotTable>(
    table: T,
    cursor?: WalletSnapshotCursor,
    limits?: WalletSnapshotPageLimits
  ) => Promise<WalletSnapshotFieldMetadataPage<T>>
  /** One exact <=65,536-byte extent, freshly compared with this source's actual
   * field. Expected metadata is DATA and cannot select another view/profile. */
  readFieldExtent: (
    table: WalletSnapshotTable,
    cursor: WalletSnapshotCursor,
    field: string,
    offset: number,
    length: number,
    expected: Readonly<WalletSnapshotFieldDescriptor>
  ) => Promise<Uint8Array>
}

export interface WalletReadSnapshot {
  readonly version: 1
  readonly snapshotId: string
  readonly sourceStorage: tables.TableSettings
  readonly user: tables.TableUser
  readonly expiresAt: number
  readonly isOpen: boolean
  readonly closed: Promise<void>
  /** Additive local capabilities; old providers keep their bounded full-row
   * path. Neither interface changes version-one wire negotiation. */
  readonly binaryReader?: WalletSnapshotBinaryReader
  readonly fieldReader?: WalletSnapshotFieldReader
  /**
   * One read at a time. Repeating a cursor and limits repeats the same page.
   * Rows include tombstones and stored values; no operational policy is applied.
   * This local interface is not exposed over RPC and does not validate a complete
   * portable document. Settings, user and every page share the same read view.
   */
  readPage: <T extends WalletSnapshotTable>(
    table: T,
    cursor?: WalletSnapshotCursor,
    limits?: WalletSnapshotPageLimits
  ) => Promise<WalletSnapshotPage<T>>
  close: () => Promise<void>
}

export type WalletReadSnapshotOptions = RetainedReadSnapshotOptions
