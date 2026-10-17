import type { TableSettings, TableUser } from '../schema/tables'
import { decodeSyncTransfer } from '../remoting/SyncTransfer'
import { defineOwnValues } from '../remoting/BinaryJson'
import {
  snapshotSyncTables,
  type SnapshotSyncCheckpoint,
  type SnapshotSyncSource,
  type SnapshotSyncTable,
  type SnapshotSyncCommit
} from './SnapshotSync'
import type { WalletSnapshotCursor, WalletSnapshotPage } from './WalletReadSnapshot'
import { copySnapshotArchivePosition } from './SnapshotCursor'
import { remoteSnapshotKeys, validateRemoteSnapshotRows } from './archive/RemoteSnapshotRows'
import { detachSnapshotSyncPage } from './SnapshotSyncRows'
import { isSyncChain } from '../sync/syncFailure'

export const remoteSnapshotSyncRequestBytes = 1048576
export const remoteSnapshotSyncResponseBytes = 16384
export const remoteSnapshotSyncInlineFrameBytes = 524288
export const remoteSnapshotSyncFrameBytes = 16777216
export const remoteSnapshotSyncPartBytes = 262144
export const remoteSnapshotSyncCapabilities = Object.freeze({
  version: 1 as const,
  maxRows: 128,
  maxBytes: 10000000,
  maxIoMs: 30000
})
export type RemoteSnapshotSyncCapabilities = typeof remoteSnapshotSyncCapabilities
export const remoteSnapshotSyncMethods = Object.freeze([
  'beginSnapshotSync',
  'getSnapshotSyncCheckpoint',
  'commitSnapshotSyncPage',
  'beginSnapshotSyncPageTransfer',
  'writeSnapshotSyncPageTransferPart',
  'commitSnapshotSyncPageTransfer',
  'releaseSnapshotSyncPageTransfer'
] as const)
export type RemoteSnapshotSyncMethod = (typeof remoteSnapshotSyncMethods)[number]

function invalid(): never {
  throw new TypeError('Invalid authenticated snapshot sync protocol value')
}
function object(
  input: unknown,
  required: readonly string[],
  optional: readonly string[] = []
): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    ![null, Object.prototype].includes(Object.getPrototypeOf(input))
  )
    invalid()
  const names = Reflect.ownKeys(input)
  if (names.length > required.length + optional.length || required.some(name => !names.includes(name))) invalid()
  const result: Record<string, unknown> = Object.create(null)
  const values: Array<readonly [string, unknown]> = []
  for (const name of names) {
    if (typeof name !== 'string' || (!required.includes(name) && !optional.includes(name))) invalid()
    const property = Object.getOwnPropertyDescriptor(input, name)
    if (property === undefined || !('value' in property) || !property.enumerable) invalid()
    values.push([name, property.value])
  }
  defineOwnValues(result, values)
  return result
}
function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) invalid()
  return value as number
}
export function remoteSnapshotStorageKey(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 130 ||
    Array.from(value).some(character => {
      const point = character.codePointAt(0)!
      return point <= 0x1f || (point >= 0x7f && point <= 0x9f)
    })
  )
    invalid()
  return value
}
function digest(value: unknown): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) invalid()
  return value
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || !/^(02|03)[0-9a-fA-F]{64}$/.test(value)) invalid()
  return value
}
function date(value: unknown): Date {
  if (typeof value !== 'string' || value.length !== 24) invalid()
  const result = new Date(value)
  if (!Number.isFinite(result.getTime()) || result.toISOString() !== value) invalid()
  return result
}

export function validateRemoteSnapshotSyncCapabilities(input: unknown): RemoteSnapshotSyncCapabilities {
  const value = object(input, ['version', 'maxRows', 'maxBytes', 'maxIoMs'])
  for (const name of ['version', 'maxRows', 'maxBytes', 'maxIoMs'] as const)
    if (value[name] !== remoteSnapshotSyncCapabilities[name]) invalid()
  return remoteSnapshotSyncCapabilities
}

export function parseRemoteSnapshotSyncSource(
  input: unknown,
  authenticatedIdentity: string,
  chain: TableSettings['chain']
): SnapshotSyncSource {
  const value = object(input, ['version', 'snapshotId', 'sourceStorage', 'user', 'expiresAt'])
  const user = object(value.user, ['userId', 'identityKey', 'created_at', 'updated_at'], ['activeStorage'])
  const settings = object(value.sourceStorage, [
    'storageIdentityKey',
    'storageName',
    'chain',
    'dbtype',
    'maxOutputScript',
    'created_at',
    'updated_at'
  ])
  if (
    value.version !== 1 ||
    !isSyncChain(chain) ||
    identity(user.identityKey) !== authenticatedIdentity ||
    settings.chain !== chain ||
    typeof settings.storageName !== 'string' ||
    settings.storageName.length > 4096 ||
    !['SQLite', 'MySQL', 'Postgres', 'IndexedDB'].includes(settings.dbtype as string)
  )
    invalid()
  const expiresAt = integer(value.expiresAt, 1)
  if (expiresAt <= Date.now() || expiresAt > Date.now() + 3600000) invalid()
  return {
    version: 1,
    snapshotId: digest(value.snapshotId),
    expiresAt,
    user: {
      userId: integer(user.userId, 1),
      identityKey: authenticatedIdentity,
      created_at: date(user.created_at),
      updated_at: date(user.updated_at),
      activeStorage: (user.activeStorage == null ? undefined : remoteSnapshotStorageKey(user.activeStorage)) as string
    } satisfies TableUser,
    sourceStorage: {
      storageIdentityKey: remoteSnapshotStorageKey(settings.storageIdentityKey),
      storageName: settings.storageName,
      chain,
      dbtype: settings.dbtype as TableSettings['dbtype'],
      maxOutputScript: integer(settings.maxOutputScript, 0, 16777216),
      created_at: date(settings.created_at),
      updated_at: date(settings.updated_at)
    }
  }
}

function cursor(input: unknown, snapshotId: string, table: SnapshotSyncTable): WalletSnapshotCursor | undefined {
  if (input === undefined) return undefined
  const value = object(input, ['version', 'snapshotId', 'table', 'after'], ['archivePosition'])
  const keys = remoteSnapshotKeys(table)
  if (
    value.version !== 1 ||
    value.snapshotId !== snapshotId ||
    value.table !== table ||
    !Array.isArray(value.after) ||
    value.after.length !== keys.length
  )
    invalid()
  const after = keys.map((name, index) => {
    const item = value.after as unknown[],
      property = Object.getOwnPropertyDescriptor(item, String(index))
    if (property === undefined || !('value' in property)) invalid()
    if (name !== 'fieldName') return integer(property.value, 1)
    if (typeof property.value !== 'string' || property.value.length > 200 || Array.from(property.value).length > 100)
      invalid()
    return property.value as string
  })
  return {
    version: 1,
    snapshotId,
    table,
    after,
    ...(value.archivePosition === undefined
      ? {}
      : {
          archivePosition: copySnapshotArchivePosition(value.archivePosition as WalletSnapshotCursor['archivePosition'])
        })
  }
}

export function parseRemoteSnapshotSyncCheckpoint(
  input: unknown,
  expected: {
    identityKey: string
    sourceStorageIdentityKey: string
    destinationStorageIdentityKey: string
  }
): SnapshotSyncCheckpoint {
  const value = object(
    input,
    [
      'version',
      'sessionId',
      'identityKey',
      'sourceStorageIdentityKey',
      'destinationStorageIdentityKey',
      'snapshotId',
      'tableIndex',
      'sequence',
      'done'
    ],
    ['cursor']
  )
  const tableIndex = integer(value.tableIndex, 0, snapshotSyncTables.length),
    snapshotId = digest(value.snapshotId)
  if (
    value.version !== 1 ||
    identity(value.identityKey) !== expected.identityKey ||
    remoteSnapshotStorageKey(value.sourceStorageIdentityKey) !== expected.sourceStorageIdentityKey ||
    remoteSnapshotStorageKey(value.destinationStorageIdentityKey) !== expected.destinationStorageIdentityKey ||
    value.done !== (tableIndex === snapshotSyncTables.length) ||
    (value.done && value.cursor !== undefined)
  )
    invalid()
  return {
    version: 1,
    sessionId: digest(value.sessionId),
    identityKey: expected.identityKey,
    sourceStorageIdentityKey: expected.sourceStorageIdentityKey,
    destinationStorageIdentityKey: expected.destinationStorageIdentityKey,
    snapshotId,
    tableIndex,
    sequence: integer(value.sequence, 0),
    done: value.done as boolean,
    ...(value.cursor === undefined ? {} : { cursor: cursor(value.cursor, snapshotId, snapshotSyncTables[tableIndex]) })
  }
}

export function parseRemoteSnapshotSyncPage(
  input: unknown,
  checkpoint: SnapshotSyncCheckpoint,
  sourceUserId: number
): WalletSnapshotPage<SnapshotSyncTable> {
  if (
    !(input instanceof Uint8Array) ||
    input.length < 1 ||
    input.length > remoteSnapshotSyncFrameBytes ||
    checkpoint.done
  )
    invalid()
  return parsePageValue(decodeSyncTransfer(input), checkpoint, sourceUserId)
}

function parsePageValue(
  input: unknown,
  checkpoint: SnapshotSyncCheckpoint,
  sourceUserId: number
): WalletSnapshotPage<SnapshotSyncTable> {
  const value = object(input, ['rows', 'payloadBytes', 'done'], ['cursor'])
  if (
    !Array.isArray(value.rows) ||
    value.rows.length > remoteSnapshotSyncCapabilities.maxRows ||
    typeof value.done !== 'boolean'
  )
    invalid()
  const payloadBytes = integer(value.payloadBytes, 0, remoteSnapshotSyncCapabilities.maxBytes)
  const table = snapshotSyncTables[checkpoint.tableIndex]
  const rows = validateRemoteSnapshotRows(value.rows, table, integer(sourceUserId, 1))
  const page = {
    rows: rows as unknown as WalletSnapshotPage<SnapshotSyncTable>['rows'],
    payloadBytes,
    done: value.done,
    ...(value.cursor === undefined ? {} : { cursor: cursor(value.cursor, checkpoint.snapshotId, table) })
  }
  // Fresh full-record allocation/cursor checks precede proof preparation or SQL.
  detachSnapshotSyncPage(checkpoint, page)
  return page
}

export function parseRemoteSnapshotSyncStagedPage(
  input: Uint8Array,
  expected: SnapshotSyncCheckpoint,
  sourceUserId: number
): WalletSnapshotPage<SnapshotSyncTable> {
  if (input.length < 1 || input.length > remoteSnapshotSyncFrameBytes || expected.done) invalid()
  const value = object(decodeSyncTransfer(input), ['checkpoint', 'page'])
  const actual = parseRemoteSnapshotSyncCheckpoint(value.checkpoint, expected),
    original = parseRemoteSnapshotSyncCheckpoint(expected, expected)
  if (JSON.stringify(actual) !== JSON.stringify(original)) invalid()
  return parsePageValue(value.page, original, sourceUserId)
}

export function parseRemoteSnapshotSyncTransfer(
  input: unknown,
  method: RemoteSnapshotSyncMethod
): {
  transferId?: string
  digest?: string
  totalBytes?: number
  offset?: number
  bytes?: Uint8Array
} {
  if (method === 'beginSnapshotSyncPageTransfer') {
    const value = object(input, ['digest', 'totalBytes'])
    return { digest: digest(value.digest), totalBytes: integer(value.totalBytes, 1, remoteSnapshotSyncFrameBytes) }
  }
  if (method === 'writeSnapshotSyncPageTransferPart') {
    const value = object(input, ['transferId', 'offset', 'bytes'])
    if (
      !(value.bytes instanceof Uint8Array) ||
      value.bytes.length < 1 ||
      value.bytes.length > remoteSnapshotSyncPartBytes
    )
      invalid()
    return {
      transferId: digest(value.transferId),
      offset: integer(value.offset, 0, remoteSnapshotSyncFrameBytes - 1),
      bytes: new Uint8Array(value.bytes)
    }
  }
  const value = object(input, ['transferId'])
  return { transferId: digest(value.transferId) }
}

export function parseRemoteSnapshotSyncCommit(input: unknown, previous: SnapshotSyncCheckpoint): SnapshotSyncCommit {
  const value = object(input, ['checkpoint', 'inserts', 'updates'])
  const checkpoint = parseRemoteSnapshotSyncCheckpoint(value.checkpoint, previous)
  if (
    checkpoint.sessionId !== previous.sessionId ||
    checkpoint.snapshotId !== previous.snapshotId ||
    checkpoint.sequence !== previous.sequence + 1 ||
    checkpoint.tableIndex < previous.tableIndex ||
    checkpoint.tableIndex > previous.tableIndex + 1
  )
    invalid()
  return { checkpoint, inserts: integer(value.inserts, 0), updates: integer(value.updates, 0) }
}
