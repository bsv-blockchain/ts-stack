import { snapshotJournalArchiveStreams } from './SnapshotJournalArchiveBinding'
import type { SnapshotJournalDeltaFrameContext } from './SnapshotJournalDeltaFrame'

/** Version-three auxiliary packet labels, below the existing64-character SQL
 * column bound. They identify actual packet kind/stream, not BRC-38 tables. */
export function snapshotJournalArchiveStorageTable(
  packet: 'frame' | 'identities',
  context: SnapshotJournalDeltaFrameContext
): string {
  const stream = snapshotJournalArchiveStreams.find(
    value => value.stream === context.stream && value.tableId === context.tableId
  )
  if (stream === undefined || (packet !== 'frame' && packet !== 'identities'))
    throw new TypeError('Invalid journal artifact packet stream')
  return 'journal-' + packet + '/' + stream.stream + '/' + stream.table
}

export function parseSnapshotJournalArchiveStorageTable(input: unknown) {
  if (typeof input !== 'string' || input.length > 64) throw new TypeError('Invalid journal artifact packet label')
  const [kind, scope, table] = input.split('/'),
    packet =
      kind === 'journal-frame'
        ? ('frame' as const)
        : kind === 'journal-identities'
          ? ('identities' as const)
          : undefined,
    stream = snapshotJournalArchiveStreams.find(value => value.stream === scope && value.table === table)
  if (packet === undefined || stream === undefined || input !== snapshotJournalArchiveStorageTable(packet, stream))
    throw new TypeError('Invalid journal artifact packet label')
  return { packet, ...stream }
}

export function snapshotJournalFieldArchiveStorageTable(
  packet: 'frame' | 'identities' | 'content',
  context: SnapshotJournalDeltaFrameContext
): string {
  const stream = snapshotJournalArchiveStreams.find(
    value => value.stream === context.stream && value.tableId === context.tableId
  )
  if (stream === undefined || !['frame', 'identities', 'content'].includes(packet))
    throw new TypeError('Invalid journal field packet stream')
  return 'journal-fields-' + packet + '/' + stream.stream + '/' + stream.table
}
export function parseSnapshotJournalFieldArchiveStorageTable(input: unknown) {
  if (typeof input !== 'string' || input.length > 64) throw new TypeError('Invalid journal field packet label')
  const [kind, scope, table] = input.split('/'),
    packet =
      kind === 'journal-fields-frame'
        ? ('frame' as const)
        : kind === 'journal-fields-identities'
          ? ('identities' as const)
          : kind === 'journal-fields-content'
            ? ('content' as const)
            : undefined,
    stream = snapshotJournalArchiveStreams.find(value => value.stream === scope && value.table === table)
  if (packet === undefined || stream === undefined || input !== snapshotJournalFieldArchiveStorageTable(packet, stream))
    throw new TypeError('Invalid journal field packet label')
  return { packet, ...stream }
}
