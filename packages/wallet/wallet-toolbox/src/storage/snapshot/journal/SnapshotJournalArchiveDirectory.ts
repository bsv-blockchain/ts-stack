import type { SnapshotArchiveChain } from '../archive/SnapshotArchiveChain'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { toHex } from '@bsv/sdk/primitives/utils'
import { snapshotArchiveLimits } from '../archive/SnapshotArchive'
import type { WalletSnapshotTable } from '../WalletReadSnapshot'
import {
  parseSnapshotJournalFieldArchiveBinding,
  type SnapshotJournalFieldArchiveManifest,
  parseSnapshotJournalArchiveBinding,
  snapshotJournalArchiveStreams,
  type SnapshotJournalArchiveManifest
} from './SnapshotJournalArchiveBinding'
import {
  snapshotJournalArchiveEncoding,
  snapshotJournalFieldArchiveEncoding,
  parseSnapshotJournalFieldContentIndex,
  type SnapshotJournalFieldContentIndex
} from './SnapshotJournalArchivePacket'
import {
  snapshotJournalDataDigest,
  snapshotJournalDataRecord,
  snapshotJournalDataText,
  parseSnapshotJournalArchivePosition,
  type SnapshotJournalArchivePosition
} from './SnapshotJournalReceiptData'
import { compareSnapshotJournalRevisions } from './SnapshotJournalRevision'
import {
  snapshotJournalArchiveStorageTable,
  snapshotJournalFieldArchiveStorageTable
} from './SnapshotJournalArchiveStorageTable'

export interface SnapshotJournalArchivePageReceipt {
  readonly sequence: number
  readonly table: WalletSnapshotTable
  readonly rows: number
  readonly done: boolean
  readonly digest: string
  readonly packet: 'frame' | 'identities'
  readonly stream: 'scope' | 'physical'
  readonly tableId: number
}
export interface VerifiedSnapshotJournalArchiveDirectory {
  readonly manifest: Readonly<SnapshotJournalArchiveManifest>
  /** Exact hash preimage, never a reserialized metadata object. */
  readonly bindingJson: string
  readonly receipts: ReadonlyArray<Readonly<SnapshotJournalArchivePageReceipt>>
  /** Intake checkpoint sequence counts real frames, never identity prefixes.
   * This bounded metadata index avoids a payload/OFFSET scan on retry. */
  readonly frames: ReadonlyArray<Readonly<{ sequence: number; firstPrefix: number; streamIndex: number }>>
}
export interface SnapshotJournalArchiveExpectedSource {
  identityKey: string
  chain: SnapshotArchiveChain
  sourceStorageIdentityKey: string
  sourceSchema: string
  archiveId: string
  digest: string
  expiresAt: number
  position?: SnapshotJournalArchivePosition
}
function invalid(): never {
  throw new TypeError('Invalid snapshot journal archive directory DATA')
}
function integer(value: unknown, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum || value > maximum) invalid()
  return value
}
function hash(text: string): string {
  return toHex(sha256(new TextEncoder().encode(text)))
}

/** Pure bounded inclusion/provenance verification. Authentication, actual lease
 * ownership and destination admission remain outside this DATA parser. */
export function verifySnapshotJournalArchiveDirectory(
  input: unknown,
  expected: SnapshotJournalArchiveExpectedSource,
  now: number
): VerifiedSnapshotJournalArchiveDirectory {
  integer(now, 0, Number.MAX_SAFE_INTEGER)
  const row = snapshotJournalDataRecord(input, [
      'version',
      'encoding',
      'archiveId',
      'expiresAt',
      'pages',
      'rows',
      'digest',
      'bindingJson',
      'receipts'
    ]),
    bindingJson = snapshotJournalDataText(row.bindingJson, snapshotArchiveLimits.bindingBytes, 1),
    binding = parseSnapshotJournalArchiveBinding(JSON.parse(bindingJson)),
    archiveId = snapshotJournalDataDigest(row.archiveId),
    digest = snapshotJournalDataDigest(row.digest),
    expiresAt = integer(row.expiresAt, 1, Number.MAX_SAFE_INTEGER),
    pages = integer(row.pages, 15, snapshotArchiveLimits.pages),
    totalRows = integer(row.rows, 0, pages * 256),
    position = parseSnapshotJournalArchivePosition(expected.position ?? null)
  if (
    row.version !== 1 ||
    row.encoding !== snapshotJournalArchiveEncoding ||
    archiveId !== expected.archiveId ||
    digest !== expected.digest ||
    expiresAt !== expected.expiresAt ||
    expiresAt <= now ||
    expiresAt - now > snapshotArchiveLimits.lifetimeMs ||
    expiresAt > binding.journal.receipt.expiresAt ||
    binding.user.identityKey !== expected.identityKey ||
    binding.sourceStorage.chain !== expected.chain ||
    binding.sourceStorage.storageIdentityKey !== expected.sourceStorageIdentityKey ||
    binding.sourceSchema !== expected.sourceSchema
  )
    invalid()
  const same = position !== undefined && position.binding === binding.journal.receipt.binding
  if (same && compareSnapshotJournalRevisions(position.highWater, binding.journal.receipt.highWater) > 0) invalid()
  const incremental = same && compareSnapshotJournalRevisions(position.highWater, binding.journal.receipt.floor) >= 0
  if (binding.journal.bootstrap === incremental || (incremental && binding.journal.low !== position.highWater))
    invalid()
  if (
    !Array.isArray(row.receipts) ||
    Object.getOwnPropertyDescriptor(row.receipts, 'length')?.value !== pages ||
    Reflect.ownKeys(row.receipts).length !== pages + 1
  )
    invalid()
  let chain = hash(bindingJson),
    rows = 0,
    streamIndex = 0,
    firstPrefix = 0
  const receipts: SnapshotJournalArchivePageReceipt[] = [],
    frames: Array<{ sequence: number; firstPrefix: number; streamIndex: number }> = []
  for (let sequence = 0; sequence < pages; sequence++) {
    const descriptor = Object.getOwnPropertyDescriptor(row.receipts, String(sequence))
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
    const value = snapshotJournalDataRecord(descriptor.value, [
        'sequence',
        'table',
        'rows',
        'done',
        'digest',
        'packet',
        'stream',
        'tableId'
      ]),
      stream = snapshotJournalArchiveStreams[streamIndex]
    if (
      stream === undefined ||
      value.sequence !== sequence ||
      value.table !== stream.table ||
      value.stream !== stream.stream ||
      value.tableId !== stream.tableId ||
      (value.packet !== 'frame' && value.packet !== 'identities') ||
      typeof value.done !== 'boolean'
    )
      invalid()
    const count = integer(value.rows, 0, 256),
      pageDigest = snapshotJournalDataDigest(value.digest)
    if (value.packet === 'identities' && (count !== 0 || value.done)) invalid()
    const receipt: SnapshotJournalArchivePageReceipt = Object.freeze({
      sequence,
      table: stream.table,
      rows: count,
      done: value.done,
      digest: pageDigest,
      packet: value.packet,
      stream: stream.stream,
      tableId: stream.tableId
    })
    receipts.push(receipt)
    chain = hash(
      JSON.stringify([
        chain,
        sequence,
        snapshotJournalArchiveStorageTable(receipt.packet, stream),
        count,
        receipt.done,
        pageDigest
      ])
    )
    rows += count
    if (receipt.packet === 'frame') {
      frames.push(Object.freeze({ sequence, firstPrefix, streamIndex }))
      firstPrefix = sequence + 1
    }
    if (receipt.done) streamIndex++
  }
  if (streamIndex !== 15 || firstPrefix !== pages || rows !== totalRows || chain !== digest) invalid()
  return Object.freeze({
    manifest: Object.freeze({ version: 1, archiveId, binding, expiresAt, pages, rows, digest }),
    bindingJson,
    receipts: Object.freeze(receipts),
    frames: Object.freeze(frames)
  })
}

export interface SnapshotJournalFieldArchivePageReceipt extends Omit<SnapshotJournalArchivePageReceipt, 'packet'> {
  readonly packet: 'frame' | 'identities' | 'content'
  readonly content: Readonly<SnapshotJournalFieldContentIndex> | null
}
export interface VerifiedSnapshotJournalFieldArchiveDirectory {
  readonly manifest: Readonly<SnapshotJournalFieldArchiveManifest>
  readonly bindingJson: string
  readonly receipts: ReadonlyArray<Readonly<SnapshotJournalFieldArchivePageReceipt>>
  readonly frames: ReadonlyArray<Readonly<{ sequence: number; firstPrefix: number; streamIndex: number }>>
}
/** Inclusion and complete ordered-stream DATA only. A destination still proves
 * every declared extent and whole-content hash before any semantic ACK. */
export function verifySnapshotJournalFieldArchiveDirectory(
  input: unknown,
  expected: SnapshotJournalArchiveExpectedSource,
  now: number
): VerifiedSnapshotJournalFieldArchiveDirectory {
  integer(now, 0, Number.MAX_SAFE_INTEGER)
  const row = snapshotJournalDataRecord(input, [
      'version',
      'encoding',
      'archiveId',
      'expiresAt',
      'pages',
      'rows',
      'digest',
      'bindingJson',
      'receipts'
    ]),
    bindingJson = snapshotJournalDataText(row.bindingJson, snapshotArchiveLimits.bindingBytes, 1),
    binding = parseSnapshotJournalFieldArchiveBinding(JSON.parse(bindingJson)),
    archiveId = snapshotJournalDataDigest(row.archiveId),
    digest = snapshotJournalDataDigest(row.digest),
    expiresAt = integer(row.expiresAt, 1, Number.MAX_SAFE_INTEGER),
    pages = integer(row.pages, 15, snapshotArchiveLimits.pages),
    totalRows = integer(row.rows, 0, pages * 256),
    position = parseSnapshotJournalArchivePosition(expected.position ?? null)
  if (
    row.version !== 1 ||
    row.encoding !== snapshotJournalFieldArchiveEncoding ||
    archiveId !== expected.archiveId ||
    digest !== expected.digest ||
    expiresAt !== expected.expiresAt ||
    expiresAt <= now ||
    expiresAt - now > snapshotArchiveLimits.lifetimeMs ||
    expiresAt > binding.journal.receipt.expiresAt ||
    binding.user.identityKey !== expected.identityKey ||
    binding.sourceStorage.chain !== expected.chain ||
    binding.sourceStorage.storageIdentityKey !== expected.sourceStorageIdentityKey ||
    binding.sourceSchema !== expected.sourceSchema
  )
    invalid()
  const same = position !== undefined && position.binding === binding.journal.receipt.binding
  if (same && compareSnapshotJournalRevisions(position.highWater, binding.journal.receipt.highWater) > 0) invalid()
  const incremental = same && compareSnapshotJournalRevisions(position.highWater, binding.journal.receipt.floor) >= 0
  if (binding.journal.bootstrap === incremental || (incremental && binding.journal.low !== position.highWater))
    invalid()
  if (
    !Array.isArray(row.receipts) ||
    Object.getOwnPropertyDescriptor(row.receipts, 'length')?.value !== pages ||
    Reflect.ownKeys(row.receipts).length !== pages + 1
  )
    invalid()
  let chain = hash(bindingJson),
    rows = 0,
    streamIndex = 0,
    firstPrefix = 0
  const receipts: SnapshotJournalFieldArchivePageReceipt[] = [],
    frames: Array<{ sequence: number; firstPrefix: number; streamIndex: number }> = []
  for (let sequence = 0; sequence < pages; sequence++) {
    const descriptor = Object.getOwnPropertyDescriptor(row.receipts, String(sequence))
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid()
    const value = snapshotJournalDataRecord(descriptor.value, [
        'sequence',
        'table',
        'rows',
        'done',
        'digest',
        'packet',
        'stream',
        'tableId',
        'content'
      ]),
      stream = snapshotJournalArchiveStreams[streamIndex]
    if (
      stream === undefined ||
      value.sequence !== sequence ||
      value.table !== stream.table ||
      value.stream !== stream.stream ||
      value.tableId !== stream.tableId ||
      (value.packet !== 'frame' && value.packet !== 'identities' && value.packet !== 'content') ||
      typeof value.done !== 'boolean'
    )
      invalid()
    const count = integer(value.rows, 0, 256),
      pageDigest = snapshotJournalDataDigest(value.digest)
    if (value.packet !== 'frame' && (count !== 0 || value.done)) invalid()
    const receipt: SnapshotJournalFieldArchivePageReceipt = Object.freeze({
      sequence,
      table: stream.table,
      rows: count,
      done: value.done,
      digest: pageDigest,
      packet: value.packet,
      stream: stream.stream,
      tableId: stream.tableId,
      content: value.packet === 'content' ? parseSnapshotJournalFieldContentIndex(value.content) : null
    })
    if (value.packet !== 'content' && value.content !== null) invalid()
    receipts.push(receipt)
    chain = hash(
      JSON.stringify([
        chain,
        sequence,
        snapshotJournalFieldArchiveStorageTable(receipt.packet, stream),
        count,
        receipt.done,
        pageDigest,
        receipt.content
      ])
    )
    rows += count
    if (receipt.packet === 'frame') {
      frames.push(Object.freeze({ sequence, firstPrefix, streamIndex }))
      firstPrefix = sequence + 1
    }
    if (receipt.done) streamIndex++
  }
  if (streamIndex !== 15 || firstPrefix !== pages || rows !== totalRows || chain !== digest) invalid()
  return Object.freeze({
    manifest: Object.freeze({ version: 1, archiveId, binding, expiresAt, pages, rows, digest }),
    bindingJson,
    receipts: Object.freeze(receipts),
    frames: Object.freeze(frames)
  })
}
