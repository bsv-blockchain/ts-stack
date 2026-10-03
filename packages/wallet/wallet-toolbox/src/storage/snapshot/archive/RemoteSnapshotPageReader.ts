import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import type {
  PackedSnapshotRow,
  WalletReadSnapshot,
  WalletSnapshotCursor,
  WalletSnapshotPage,
  WalletSnapshotPageLimits,
  WalletSnapshotTable,
  WalletSnapshotTables
} from '../WalletReadSnapshot'
import type { VerifiedSnapshotArchiveDirectory } from './SnapshotArchiveDirectory'
import type { SnapshotArchiveTransport } from './SnapshotArchiveTransport'
import type { RemoteSnapshotLease } from './RemoteSnapshotLease'
import {
  decodeRemoteSnapshotFrame,
  detachRemoteSnapshotRow,
  remoteSnapshotKeys,
  type RemoteSnapshotFrame,
  type RemoteSnapshotRow
} from './RemoteSnapshotRows'

interface Position {
  sequence: number
  rowOffset: number
}
interface DetachedCursor {
  cursor: WalletSnapshotCursor
  position: Position
}

function invalidCursor(): never {
  throw new WERR_INVALID_PARAMETER('cursor', 'a verified position in this snapshot archive and table')
}
function data(input: unknown, names: string[]): Record<string, unknown> {
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== names.length
  )
    invalidCursor()
  return Object.fromEntries(
    names.map(name => {
      const property = Object.getOwnPropertyDescriptor(input, name)
      if (property === undefined || !('value' in property) || !property.enumerable) invalidCursor()
      return [name, property.value]
    })
  )
}
function detachCursor(
  input: WalletSnapshotCursor | undefined,
  table: WalletSnapshotTable,
  directory: VerifiedSnapshotArchiveDirectory
): DetachedCursor | undefined {
  if (input === undefined) return undefined
  const cursor = data(input, ['version', 'snapshotId', 'table', 'after', 'archivePosition'])
  const position = data(cursor.archivePosition, ['version', 'archiveId', 'sequence', 'rowOffset'])
  const keys = remoteSnapshotKeys(table)
  const range = directory.tables[table]
  if (
    cursor.version !== 1 ||
    cursor.snapshotId !== directory.manifest.binding.snapshotId ||
    cursor.table !== table ||
    !Array.isArray(cursor.after) ||
    cursor.after.length !== keys.length ||
    position.version !== 1 ||
    position.archiveId !== directory.manifest.archiveId ||
    !Number.isSafeInteger(position.sequence) ||
    (position.sequence as number) < range.first ||
    (position.sequence as number) >= range.first + range.pages ||
    !Number.isSafeInteger(position.rowOffset) ||
    (position.rowOffset as number) < 1
  )
    invalidCursor()
  const sequence = position.sequence as number
  const rowOffset = position.rowOffset as number
  if (rowOffset > directory.receipts[sequence].rows) invalidCursor()
  const after = keys.map((key, index) => {
    const property = Object.getOwnPropertyDescriptor(cursor.after, index)
    if (property === undefined || !('value' in property)) invalidCursor()
    const value: unknown = property.value
    if (
      key === 'fieldName'
        ? typeof value !== 'string' || value.length > 200 || Array.from(value).length > 100
        : !Number.isSafeInteger(value) || (value as number) < 1
    )
      invalidCursor()
    return value as number | string
  })
  return {
    position: { sequence, rowOffset },
    cursor: {
      version: 1,
      snapshotId: directory.manifest.binding.snapshotId,
      table,
      after,
      archivePosition: { version: 1, archiveId: directory.manifest.archiveId, sequence, rowOffset }
    }
  }
}

function limit(value: number | undefined, fallback: number, ceiling: number, name: string): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > ceiling)
    throw new WERR_INVALID_PARAMETER(name, `an integer from 1 to ${ceiling}`)
  return result
}

function fitsPage(rows: number, payloadBytes: number, charge: number, maxBytes: number): boolean {
  if (payloadBytes + charge <= maxBytes) return true
  if (rows === 0)
    throw new SnapshotResourceLimitError('Snapshot row exceeds maxBytes; large-value streaming is required')
  return false
}

/** One private decoded frame, plus returned rows charged to the caller's allocation budget. */
export function createRemoteSnapshotPageReader(
  transport: SnapshotArchiveTransport,
  directory: VerifiedSnapshotArchiveDirectory,
  lease: RemoteSnapshotLease
): WalletReadSnapshot['readPage'] {
  let cached: { sequence: number; frame: RemoteSnapshotFrame } | undefined
  let busy = false
  const discard = (): void => {
    cached = undefined
  }
  void lease.closed.then(discard, discard)
  const assertActive = (): void => {
    lease.assertOpen()
    if (lease.now() >= directory.manifest.expiresAt) {
      const error = new SnapshotResourceLimitError('Remote snapshot expired')
      void lease.close(error).catch(() => undefined)
      throw error
    }
  }
  const frameAt = async (sequence: number): Promise<RemoteSnapshotFrame> => {
    assertActive()
    if (cached?.sequence === sequence) return cached.frame
    discard()
    try {
      const bytes = await lease.runIdempotent(signal => transport.page(directory, sequence, signal))
      assertActive()
      const frame = decodeRemoteSnapshotFrame(
        bytes,
        directory.receipts[sequence],
        directory.manifest.binding.user.userId
      )
      cached = { sequence, frame }
      return frame
    } catch (error) {
      void lease.close(new WERR_INVALID_OPERATION('Remote snapshot read failed')).catch(() => undefined)
      throw error
    }
  }
  const cursorAfter = (
    table: WalletSnapshotTable,
    row: RemoteSnapshotRow,
    sequence: number,
    rowOffset: number
  ): WalletSnapshotCursor => ({
    version: 1,
    snapshotId: directory.manifest.binding.snapshotId,
    table,
    after: remoteSnapshotKeys(table).map(key => row[key] as number | string),
    archivePosition: { version: 1, archiveId: directory.manifest.archiveId, sequence, rowOffset }
  })
  const verifiedPosition = async (
    table: WalletSnapshotTable,
    cursor: DetachedCursor | undefined
  ): Promise<Position> => {
    if (cursor === undefined) return { sequence: directory.tables[table].first, rowOffset: 0 }
    const frame = await frameAt(cursor.position.sequence)
    const row = frame.rows[cursor.position.rowOffset - 1]
    if (cursor.cursor.after.some((value, index) => value !== row[remoteSnapshotKeys(table)[index]])) invalidCursor()
    return { ...cursor.position }
  }
  return async <T extends WalletSnapshotTable>(
    table: T,
    cursor?: WalletSnapshotCursor,
    limits: WalletSnapshotPageLimits = {}
  ): Promise<WalletSnapshotPage<T>> => {
    assertActive()
    if (busy) throw new WERR_INVALID_OPERATION('Remote snapshot already has a read in flight')
    remoteSnapshotKeys(table)
    const initialCursor = detachCursor(cursor, table, directory)
    const maxRows = limit(limits.maxRows, 128, 1000, 'maxRows')
    const maxBytes = limit(limits.maxBytes, 262144, 16777216, 'maxBytes')
    busy = true
    try {
      const position = await verifiedPosition(table, initialCursor)
      const rows: Array<PackedSnapshotRow<WalletSnapshotTables[T]>> = []
      let payloadBytes = 0
      let nextCursor = initialCursor?.cursor
      let done = false
      let full = false
      while (!done && !full) {
        const frame = await frameAt(position.sequence)
        const receipt = directory.receipts[position.sequence]
        while (position.rowOffset < frame.rows.length && rows.length < maxRows) {
          const charge = frame.charges[position.rowOffset]
          if (!fitsPage(rows.length, payloadBytes, charge, maxBytes)) {
            full = true
            break
          }
          const row = frame.rows[position.rowOffset]
          rows.push(detachRemoteSnapshotRow(row) as PackedSnapshotRow<WalletSnapshotTables[T]>)
          payloadBytes += charge
          position.rowOffset++
          nextCursor = cursorAfter(table, row, position.sequence, position.rowOffset)
        }
        const consumed = position.rowOffset === frame.rows.length
        done = consumed && receipt.done
        full ||= rows.length === maxRows
        if (consumed && !done) {
          position.sequence++
          position.rowOffset = 0
        }
      }
      assertActive()
      return { rows, payloadBytes, cursor: nextCursor, done }
    } finally {
      busy = false
    }
  }
}
