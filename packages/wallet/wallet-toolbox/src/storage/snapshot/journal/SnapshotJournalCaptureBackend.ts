import type { Knex } from 'knex'
import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { WERR_INVALID_OPERATION } from '../../../sdk/WERR_errors'

interface FileIdentity {
  path: string
  device: string
  inode: string
}
export type SnapshotJournalCaptureBackend = { kind: 'sqlite'; file: FileIdentity } | { kind: 'mysql' }

function unavailable(): never {
  throw new WERR_INVALID_OPERATION('Snapshot journal capture backend is unavailable or changed')
}
async function fileIdentity(filename: string): Promise<FileIdentity> {
  const path = await realpath(filename)
  const info = await lstat(path, { bigint: true })
  if (!info.isFile()) return unavailable()
  return { path, device: info.dev.toString(), inode: info.ino.toString() }
}

/** Call before constructing either fresh owned pool; existing open SQLite handles
 * cannot establish file identity by rechecking only their configured pathname. */
export async function prepareSnapshotJournalCaptureBackend(
  config: Knex.Config
): Promise<SnapshotJournalCaptureBackend> {
  const connection: unknown = config.connection
  if (
    connection === null ||
    typeof connection !== 'object' ||
    ('connectionPool' in config && config.connectionPool != null)
  )
    return unavailable()
  if (config.client === 'better-sqlite3') {
    const filename = (connection as Knex.Sqlite3ConnectionConfig).filename
    if (typeof filename !== 'string' || !filename || filename === ':memory:' || filename.startsWith('file:'))
      return unavailable()
    return { kind: 'sqlite', file: await fileIdentity(filename) }
  }
  if (config.client === 'mysql2' && 'database' in connection && typeof connection.database === 'string')
    return { kind: 'mysql' }
  return unavailable()
}
interface ActualBackendIdentity {
  backend: unknown
  connectionId?: string
}
async function actualIdentity(
  k: Knex,
  connection: unknown,
  expected: SnapshotJournalCaptureBackend
): Promise<ActualBackendIdentity> {
  if (expected.kind === 'sqlite') {
    const rows: Array<{ name: string; file: string }> = await k.raw('PRAGMA database_list').connection(connection)
    const main = rows.filter(row => row.name === 'main')
    if (main.length !== 1 || typeof main[0].file !== 'string') return unavailable()
    const actual = await fileIdentity(main[0].file)
    if (JSON.stringify(actual) !== JSON.stringify(expected.file)) return unavailable()
    return { backend: actual }
  }
  const [rows]: Array<Array<{ serverUuid?: unknown; databaseName?: unknown; connectionId?: unknown }>> = await k
    .raw(
      'SELECT @@server_uuid AS serverUuid, DATABASE() AS databaseName, CAST(CONNECTION_ID() AS CHAR) AS connectionId'
    )
    .connection(connection)
  const row = rows.at(0)
  if (
    rows.length !== 1 ||
    typeof row?.serverUuid !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.serverUuid) ||
    typeof row.databaseName !== 'string' ||
    !row.databaseName ||
    Buffer.byteLength(row.databaseName, 'utf8') > 256 ||
    typeof row.connectionId !== 'string' ||
    !/^[1-9]\d{0,19}$/.test(row.connectionId) ||
    BigInt(row.connectionId) > 18446744073709551615n
  )
    return unavailable()
  return {
    backend: { serverUuid: row.serverUuid.toLowerCase(), database: row.databaseName },
    connectionId: row.connectionId
  }
}

/** Both actual native connections must address the same backend before a barrier. */
export async function bindSnapshotJournalCaptureBackend(
  writer: Knex,
  writerConnection: unknown,
  reader: Knex,
  readerConnection: unknown,
  expected: SnapshotJournalCaptureBackend
): Promise<string> {
  const write = await actualIdentity(writer, writerConnection, expected)
  const read = await actualIdentity(reader, readerConnection, expected)
  if (
    JSON.stringify(write.backend) !== JSON.stringify(read.backend) ||
    (expected.kind === 'mysql' && write.connectionId === read.connectionId)
  )
    return unavailable()
  return createHash('sha256')
    .update('snapshot-journal-backend-v1\n')
    .update(JSON.stringify([expected.kind, write.backend]))
    .digest('hex')
}

/** The pool is owned exclusively by one capture. Destroy it while releasing its
 * reserved slot, and wait for native closure before reporting physical cleanup. */
export async function closeSnapshotJournalCapturePool(k: Knex, value: unknown): Promise<void> {
  const connection = value as { open?: boolean; stream?: Duplex }
  const stream = connection.stream
  let listener: (() => void) | undefined
  const nativeClose =
    stream === undefined || stream.closed
      ? undefined
      : new Promise<void>(resolve => {
          listener = resolve
          stream.once('close', resolve)
        })
  try {
    const results = await Promise.allSettled([k.destroy(), k.client.releaseConnection(value)])
    const failed = results.filter(result => result.status === 'rejected')
    if (failed.length)
      throw new AggregateError(
        failed.map(result => result.reason),
        'Snapshot capture pool did not close'
      )
    await nativeClose
    if (k.client.config.client === 'better-sqlite3' ? connection.open !== false : stream?.closed !== true)
      throw new Error('Snapshot capture native connection did not close')
  } finally {
    if (listener !== undefined) stream!.removeListener('close', listener)
  }
}
