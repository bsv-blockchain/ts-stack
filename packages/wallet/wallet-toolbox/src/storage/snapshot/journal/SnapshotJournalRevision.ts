import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

/** Common nonnegative INTEGER range for SQLite and MySQL journal positions. */
export const MAX_SNAPSHOT_JOURNAL_REVISION = '9223372036854775807'

declare const journalRevision: unique symbol
export type SnapshotJournalRevision = string & { readonly [journalRevision]: true }

/** Canonical decimal strings preserve exact persisted and transported positions. */
export function snapshotJournalRevision(value: unknown): SnapshotJournalRevision {
  if (
    typeof value !== 'string' ||
    !/^(?:0|[1-9]\d{0,18})$/.test(value) ||
    (value.length === 19 && value > MAX_SNAPSHOT_JOURNAL_REVISION)
  ) {
    throw new WERR_INVALID_OPERATION('Invalid snapshot journal revision')
  }
  return value as SnapshotJournalRevision
}

/** The caller must validate both values at each persisted or transport boundary. */
export function compareSnapshotJournalRevisions(
  left: SnapshotJournalRevision,
  right: SnapshotJournalRevision
): -1 | 0 | 1 {
  if (left === right) return 0
  if (left.length !== right.length) return left.length < right.length ? -1 : 1
  return left < right ? -1 : 1
}
