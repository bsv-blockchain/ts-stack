import type { TableSettings, TableUser } from '../../schema/tables'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'

/** Persistent transport staging; these auxiliary records never enter BRC-38. */
export const snapshotArchiveTables = Object.freeze([
  'provenTxs',
  'provenTxReqs',
  'outputBaskets',
  'transactions',
  'commissions',
  'outputs',
  'outputTags',
  'outputTagMaps',
  'txLabels',
  'txLabelMaps',
  'certificates',
  'certificateFields',
  'syncStates'
] as const satisfies readonly WalletSnapshotTable[])

export const snapshotArchiveLimits = Object.freeze({
  archives: 8,
  totalBytes: 128 * 1024 * 1024,
  archiveBytes: 32 * 1024 * 1024,
  pageBytes: 1024 * 1024,
  pages: 4096,
  rowsPerPage: 1000,
  lifetimeMs: 3600000,
  bindingBytes: 65536,
  headerCharge: 4096,
  pageCharge: 512
})

export interface SnapshotArchiveBinding {
  version: 1
  /** The original retained source view, never a replacement replica checkpoint. */
  snapshotId: string
  sourceStorage: TableSettings
  sourceSchema: string
  user: TableUser
}

export interface SnapshotArchiveWriter {
  archiveId: string
  /** Internal capture ownership only. Never return this token to an RPC caller. */
  writerToken: string
}

export interface SnapshotArchiveManifest {
  version: 1
  archiveId: string
  binding: SnapshotArchiveBinding
  expiresAt: number
  pages: number
  rows: number
  digest: string
}

export interface SnapshotArchivePage {
  sequence: number
  table: WalletSnapshotTable
  rows: number
  done: boolean
  bytes: Uint8Array
  digest: string
}
