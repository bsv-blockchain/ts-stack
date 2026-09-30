import type * as tables from '../schema/tables'
import type { RetainedReadSnapshotOptions } from './RetainedReadSnapshot'

/** Version-one local row contract. Binary columns never expand into number arrays. */
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

/** A position within this live local view, not a durable checkpoint or authorization credential. */
export interface WalletSnapshotCursor {
  readonly version: 1
  readonly snapshotId: string
  readonly table: WalletSnapshotTable
  readonly after: ReadonlyArray<number | string>
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

export interface WalletReadSnapshot {
  readonly version: 1
  readonly snapshotId: string
  readonly sourceStorage: tables.TableSettings
  readonly user: tables.TableUser
  readonly expiresAt: number
  readonly isOpen: boolean
  readonly closed: Promise<void>
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
