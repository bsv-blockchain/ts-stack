import { syncTransferDigest } from '../../remoting/SyncTransfer'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import {
  snapshotArchiveLimits,
  snapshotArchiveTables,
  type SnapshotArchiveBinding,
  type SnapshotArchiveManifest,
  type SnapshotArchivePage
} from './SnapshotArchive'

export const snapshotArchiveEncoding = 'wallet-snapshot-rows/1'
export const snapshotArchiveDirectoryBytes = 1024 * 1024

export type SnapshotArchiveReceipt = Omit<SnapshotArchivePage, 'bytes'>

/** The exact binding JSON is the hash preimage, not a reserialized object. */
export interface SnapshotArchiveDirectory {
  version: 1
  encoding: typeof snapshotArchiveEncoding
  archiveId: string
  expiresAt: number
  pages: number
  rows: number
  digest: string
  bindingJson: string
  receipts: SnapshotArchiveReceipt[]
}

export interface SnapshotArchiveExpectedSource {
  identityKey: string
  chain: 'main' | 'test'
  sourceStorageIdentityKey: string
  archiveId?: string
  digest?: string
  sourceSchema?: string
}

export interface SnapshotArchiveTableRange {
  first: number
  pages: number
  rows: number
}

export interface VerifiedSnapshotArchiveDirectory {
  manifest: SnapshotArchiveManifest
  bindingJson: string
  receipts: ReadonlyArray<Readonly<SnapshotArchiveReceipt>>
  tables: Readonly<Record<WalletSnapshotTable, Readonly<SnapshotArchiveTableRange>>>
}

function invalid(): never {
  throw new TypeError('Invalid snapshot archive directory')
}

function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const keys = Reflect.ownKeys(value)
  if (keys.length !== fields.length) invalid()
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const property = Object.getOwnPropertyDescriptor(value, field)
    if (property === undefined || !('value' in property) || property.enumerable !== true) invalid()
    result[field] = property.value
  }
  return result
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid()
  return value as number
}

function text(value: unknown, maximum: number, minimum = 1): string {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) invalid()
  return value
}

function digest(value: unknown): string {
  const result = text(value, 64)
  if (!/^[0-9a-f]{64}$/.test(result)) invalid()
  return result
}

function date(value: unknown): Date {
  const result = new Date(text(value, 32))
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== value) invalid()
  return result
}

function binding(encoded: string, expected: SnapshotArchiveExpectedSource): SnapshotArchiveBinding {
  const bytes = new TextEncoder().encode(encoded)
  if (bytes.length > snapshotArchiveLimits.bindingBytes || new TextDecoder().decode(bytes) !== encoded) invalid()
  const value = record(JSON.parse(encoded), ['version', 'snapshotId', 'sourceStorage', 'sourceSchema', 'user'])
  if (value.version !== 1) invalid()
  const storage = record(value.sourceStorage, [
    'created_at',
    'updated_at',
    'storageIdentityKey',
    'storageName',
    'chain',
    'dbtype',
    'maxOutputScript'
  ])
  const user = record(value.user, ['created_at', 'updated_at', 'userId', 'identityKey', 'activeStorage'])
  if (expected.sourceSchema !== undefined && value.sourceSchema !== expected.sourceSchema) invalid()
  if (
    storage.chain !== expected.chain ||
    storage.storageIdentityKey !== expected.sourceStorageIdentityKey ||
    user.identityKey !== expected.identityKey
  )
    invalid()
  if (storage.dbtype !== 'SQLite' && storage.dbtype !== 'MySQL') invalid()
  return {
    version: 1,
    snapshotId: digest(value.snapshotId),
    sourceSchema: text(value.sourceSchema, 256),
    sourceStorage: {
      created_at: date(storage.created_at),
      updated_at: date(storage.updated_at),
      storageIdentityKey: text(storage.storageIdentityKey, 130),
      storageName: text(storage.storageName, snapshotArchiveLimits.bindingBytes, 0),
      chain: expected.chain,
      dbtype: storage.dbtype,
      maxOutputScript: integer(storage.maxOutputScript, 0, Number.MAX_SAFE_INTEGER)
    },
    user: {
      created_at: date(user.created_at),
      updated_at: date(user.updated_at),
      userId: integer(user.userId, 1, Number.MAX_SAFE_INTEGER),
      identityKey: text(user.identityKey, 66),
      activeStorage: text(user.activeStorage, 130, 0)
    }
  }
}

interface ValidatedDirectoryHeader {
  archiveId: string
  expiresAt: number
  pages: number
  rows: number
  digest: string
  bindingJson: string
  source: SnapshotArchiveBinding
  receipts: unknown[]
}

function directoryHeader(
  input: unknown,
  expected: SnapshotArchiveExpectedSource,
  now: number
): ValidatedDirectoryHeader {
  const value = record(input, [
    'version',
    'encoding',
    'archiveId',
    'expiresAt',
    'pages',
    'rows',
    'digest',
    'bindingJson',
    'receipts'
  ])
  if (value.version !== 1 || value.encoding !== snapshotArchiveEncoding) invalid()
  const archiveId = digest(value.archiveId)
  if (expected.archiveId !== undefined && archiveId !== expected.archiveId) invalid()
  const expiresAt = integer(value.expiresAt, 1, Number.MAX_SAFE_INTEGER)
  integer(now, 0, Number.MAX_SAFE_INTEGER)
  if (expiresAt <= now || expiresAt - now > snapshotArchiveLimits.lifetimeMs) invalid()
  const pages = integer(value.pages, snapshotArchiveTables.length, snapshotArchiveLimits.pages)
  const rows = integer(value.rows, 0, snapshotArchiveLimits.pages * snapshotArchiveLimits.rowsPerPage)
  const root = digest(value.digest)
  if (expected.digest !== undefined && root !== expected.digest) invalid()
  const bindingJson = text(value.bindingJson, snapshotArchiveLimits.bindingBytes)
  const source = binding(bindingJson, expected)
  if (!Array.isArray(value.receipts) || value.receipts.length !== pages) invalid()
  return { archiveId, expiresAt, pages, rows, digest: root, bindingJson, source, receipts: value.receipts }
}

function pageReceipt(
  input: unknown[],
  index: number,
  table: WalletSnapshotTable | undefined
): Readonly<SnapshotArchiveReceipt> {
  const slot = Object.getOwnPropertyDescriptor(input, index)
  if (slot === undefined || !('value' in slot)) invalid()
  const raw = record(slot.value, ['sequence', 'table', 'rows', 'done', 'digest'])
  if (table === undefined || raw.sequence !== index || raw.table !== table || typeof raw.done !== 'boolean') invalid()
  const rows = integer(raw.rows, 0, snapshotArchiveLimits.rowsPerPage)
  if (rows === 0 && !raw.done) invalid()
  return Object.freeze({ sequence: index, table, rows, done: raw.done, digest: digest(raw.digest) })
}

function receiptDirectory(
  header: ValidatedDirectoryHeader
): Pick<VerifiedSnapshotArchiveDirectory, 'receipts' | 'tables'> {
  let previous = syncTransferDigest(new TextEncoder().encode(header.bindingJson))
  let tableIndex = 0
  let totalRows = 0
  const receipts: Array<Readonly<SnapshotArchiveReceipt>> = []
  const tables: Partial<Record<WalletSnapshotTable, Readonly<SnapshotArchiveTableRange>>> = {}
  let first = 0
  let tableRows = 0
  for (let index = 0; index < header.pages; index++) {
    const receipt = pageReceipt(header.receipts, index, snapshotArchiveTables[tableIndex])
    previous = syncTransferDigest(
      new TextEncoder().encode(
        JSON.stringify([previous, index, receipt.table, receipt.rows, receipt.done, receipt.digest])
      )
    )
    receipts.push(receipt)
    totalRows += receipt.rows
    tableRows += receipt.rows
    if (receipt.done) {
      tables[receipt.table] = Object.freeze({ first, pages: index - first + 1, rows: tableRows })
      first = index + 1
      tableRows = 0
      tableIndex++
    }
  }
  if (tableIndex !== snapshotArchiveTables.length || totalRows !== header.rows || previous !== header.digest) invalid()
  return {
    receipts: Object.freeze(receipts),
    tables: Object.freeze(tables) as VerifiedSnapshotArchiveDirectory['tables']
  }
}

/** Verify the complete bounded receipt chain before requesting arbitrary tables. */
export function verifySnapshotArchiveDirectory(
  input: unknown,
  expected: SnapshotArchiveExpectedSource,
  now = Date.now()
): VerifiedSnapshotArchiveDirectory {
  const header = directoryHeader(input, expected, now)
  const directory = receiptDirectory(header)
  // Field and receipt limits bound the reconstructed metadata below one MiB.
  // The transport separately caps bytes before parsing the response envelope.
  Object.freeze(header.source.sourceStorage)
  Object.freeze(header.source.user)
  Object.freeze(header.source)
  return Object.freeze({
    manifest: Object.freeze({
      version: 1 as const,
      archiveId: header.archiveId,
      expiresAt: header.expiresAt,
      pages: header.pages,
      rows: header.rows,
      digest: header.digest,
      binding: header.source
    }),
    bindingJson: header.bindingJson,
    ...directory
  })
}

/** Validate bytes against the already-verified directory, not a peer-supplied digest alone. */
export function verifySnapshotArchivePage(input: unknown, receipt: Readonly<SnapshotArchiveReceipt>): Uint8Array {
  const value = record(input, ['sequence', 'table', 'rows', 'done', 'digest', 'bytes'])
  if (
    value.sequence !== receipt.sequence ||
    value.table !== receipt.table ||
    value.rows !== receipt.rows ||
    value.done !== receipt.done ||
    value.digest !== receipt.digest
  )
    invalid()
  if (
    !(value.bytes instanceof Uint8Array) ||
    value.bytes.length < 1 ||
    value.bytes.length > snapshotArchiveLimits.pageBytes
  )
    invalid()
  const bytes = new Uint8Array(value.bytes)
  if (syncTransferDigest(bytes) !== receipt.digest) invalid()
  return bytes
}
