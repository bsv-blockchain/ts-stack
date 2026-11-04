import { WERR_INVALID_PARAMETER } from '../../sdk/WERR_errors'
import type { WalletSnapshotArchivePosition, WalletSnapshotCursor } from './WalletReadSnapshot'

function invalid(): never {
  throw new WERR_INVALID_PARAMETER('cursor.archivePosition', 'a bounded version-one archive position')
}

/** Validates additive metadata without changing the shape of legacy cursors. */
export function copySnapshotArchivePosition(input: unknown): WalletSnapshotArchivePosition {
  const names = ['version', 'archiveId', 'sequence', 'rowOffset']
  if (
    input === null ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Reflect.ownKeys(input).length !== names.length
  )
    invalid()
  const value: Record<string, unknown> = {}
  for (const name of names) {
    const property = Object.getOwnPropertyDescriptor(input, name)
    if (property === undefined || !('value' in property) || !property.enumerable) invalid()
    value[name] = property.value
  }
  if (
    value.version !== 1 ||
    typeof value.archiveId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(value.archiveId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.sequence as number) >= 4096 ||
    !Number.isSafeInteger(value.rowOffset) ||
    (value.rowOffset as number) < 1 ||
    (value.rowOffset as number) > 1000
  )
    invalid()
  return {
    version: 1,
    archiveId: value.archiveId,
    sequence: value.sequence as number,
    rowOffset: value.rowOffset as number
  }
}

export function copySnapshotCursor(cursor: WalletSnapshotCursor): WalletSnapshotCursor
export function copySnapshotCursor(cursor: WalletSnapshotCursor | undefined): WalletSnapshotCursor | undefined
export function copySnapshotCursor(cursor: WalletSnapshotCursor | undefined): WalletSnapshotCursor | undefined {
  if (cursor === undefined) return undefined
  return {
    ...cursor,
    after: [...cursor.after],
    ...(cursor.archivePosition === undefined
      ? {}
      : { archivePosition: copySnapshotArchivePosition(cursor.archivePosition) })
  }
}

export function sameSnapshotArchivePosition(
  left: WalletSnapshotArchivePosition | undefined,
  right: WalletSnapshotArchivePosition | undefined
): boolean {
  if (left === undefined || right === undefined) return left === right
  return (
    left.version === right.version &&
    left.archiveId === right.archiveId &&
    left.sequence === right.sequence &&
    left.rowOffset === right.rowOffset
  )
}
