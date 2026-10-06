import { createHash, randomBytes } from 'node:crypto'
import { lstat, open, realpath } from 'node:fs/promises'
import type { Duplex } from 'node:stream'
import { knex as createKnex, type Knex } from 'knex'
import { WERR_INVALID_OPERATION, WERR_NOT_IMPLEMENTED } from '../../../sdk/WERR_errors'
import { SnapshotResourceLimitError } from '../SnapshotResourceLimitError'
import { SnapshotArchiveSourceCleanupError } from './KnexSnapshotArchiveSource'
import { snapshotArchiveLimits } from './SnapshotArchive'

interface FileIdentity {
  path: string
  device: string
  inode: string
}

interface SQLiteGuardBinding {
  version: 1
  kind: 'sqlite'
  database: FileIdentity
  guard: FileIdentity & { marker: string }
}

interface MySQLGuardBinding {
  version: 1
  kind: 'mysql'
  serverUuid: string
  database: string
  lock: string
}

export type SnapshotArchiveGuardBinding = SQLiteGuardBinding | MySQLGuardBinding

export class SnapshotArchiveGuardBusyError extends SnapshotResourceLimitError {
  constructor() {
    super('Snapshot archive source guard is occupied')
  }
}

function unavailable(): never {
  throw new WERR_INVALID_OPERATION('Snapshot archive source backend or guard identity changed')
}

async function fileIdentity(path: string): Promise<FileIdentity> {
  const info = await lstat(path, { bigint: true })
  if (!info.isFile()) unavailable()
  return { path, device: info.dev.toString(), inode: info.ino.toString() }
}

function sqliteGuardPool(filename: string, existing: boolean): Knex {
  // Knex's option declaration omits this supported better-sqlite3 option.
  const options = { fileMustExist: true, readonly: existing }
  return createKnex({
    client: 'better-sqlite3',
    connection: { filename, options },
    useNullAsDefault: true,
    pool: { min: 0, max: 1 },
    acquireConnectionTimeout: 5000
  })
}

async function guardFile(database: FileIdentity, slot: number, existing: boolean): Promise<SQLiteGuardBinding> {
  const path = `${database.path}.snapshot-owner-${slot}.sqlite`
  if (!existing) {
    try {
      const file = await open(path, 'wx', 0o600)
      await file.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  }
  const before = await fileIdentity(path)
  const guard = sqliteGuardPool(path, existing)
  try {
    if (!existing) {
      await guard.raw('PRAGMA busy_timeout = 0')
      await guard.transaction(async trx => {
        await trx.raw(
          'CREATE TABLE IF NOT EXISTS snapshot_owner_guard (id INTEGER PRIMARY KEY, marker TEXT NOT NULL, held INTEGER NOT NULL)'
        )
        await trx('snapshot_owner_guard')
          .insert({ id: 1, marker: randomBytes(32).toString('hex'), held: 0 })
          .onConflict('id')
          .ignore()
      })
    }
    const row: { marker?: unknown } | undefined = await guard('snapshot_owner_guard').where({ id: 1 }).first('marker')
    if (typeof row?.marker !== 'string' || !/^[0-9a-f]{64}$/.test(row.marker)) unavailable()
    if (JSON.stringify(await fileIdentity(path)) !== JSON.stringify(before)) unavailable()
    return { version: 1, kind: 'sqlite', database, guard: { ...before, marker: row.marker } }
  } finally {
    await guard.destroy()
  }
}

async function mysqlIdentity(k: Knex, connection?: unknown): Promise<{ serverUuid: string; database: string }> {
  const query = k.raw('SELECT @@server_uuid AS serverUuid, DATABASE() AS databaseName')
  if (connection !== undefined) void query.connection(connection)
  const [rows]: Array<Array<{ serverUuid?: unknown; databaseName?: unknown }>> = await query
  const row = rows[0]
  if (
    typeof row?.serverUuid !== 'string' ||
    !/^[0-9a-f-]{36}$/i.test(row.serverUuid) ||
    typeof row.databaseName !== 'string' ||
    row.databaseName.length < 1 ||
    row.databaseName.length > 64
  )
    unavailable()
  return { serverUuid: row.serverUuid, database: row.databaseName }
}

/** No main writer lock is held while probing files or opening a guard metadata connection. */
export async function prepareSnapshotArchiveGuardBackend(
  k: Knex,
  slot: number,
  existing: string | null
): Promise<SnapshotArchiveGuardBinding> {
  if (!Number.isSafeInteger(slot) || slot < 0 || slot >= snapshotArchiveLimits.archives) unavailable()
  let binding: SnapshotArchiveGuardBinding
  if (String(k.client.config.client).includes('mysql')) {
    const identity = await mysqlIdentity(k)
    const namespace = createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 40)
    binding = { version: 1, kind: 'mysql', ...identity, lock: `wallet-snapshot-v1:${namespace}:${slot}` }
  } else if (k.client.config.client === 'better-sqlite3') {
    const modes: Array<{ journal_mode: string }> = await k.raw('PRAGMA journal_mode')
    if (modes[0]?.journal_mode.toLowerCase() !== 'wal') unavailable()
    const rows: Array<{ name: string; file: string }> = await k.raw('PRAGMA database_list')
    const filename = rows.find(row => row.name === 'main')?.file
    if (typeof filename !== 'string' || filename.length === 0) unavailable()
    const database = await fileIdentity(await realpath(filename))
    binding = await guardFile(database, slot, existing !== null)
  } else {
    throw new WERR_NOT_IMPLEMENTED('Snapshot archive source guards require better-sqlite3 WAL or MySQL')
  }
  if (existing !== null && JSON.stringify(binding) !== existing) unavailable()
  return binding
}

/** Recheck the physical connection, not merely the configured address or an earlier pooled query. */
export async function assertSnapshotArchiveGuardBackend(
  k: Knex,
  binding: SnapshotArchiveGuardBinding,
  connection?: unknown
): Promise<void> {
  if (binding.kind === 'mysql') {
    const actual = await mysqlIdentity(k, connection)
    if (actual.serverUuid !== binding.serverUuid || actual.database !== binding.database) unavailable()
  } else {
    const query = k.raw('PRAGMA database_list')
    if (connection !== undefined) void query.connection(connection)
    const rows: Array<{ name: string; file: string }> = await query
    const filename = rows.find(row => row.name === 'main')?.file
    if (typeof filename !== 'string' || (await realpath(filename)) !== binding.database.path) unavailable()
    if (JSON.stringify(await fileIdentity(binding.database.path)) !== JSON.stringify(binding.database)) unavailable()
    const { marker: _marker, ...guard } = binding.guard
    if (JSON.stringify(await fileIdentity(guard.path)) !== JSON.stringify(guard)) unavailable()
  }
}

async function attachGuard(k: Knex, connection: unknown, binding: SnapshotArchiveGuardBinding): Promise<void> {
  await assertSnapshotArchiveGuardBackend(k, binding, connection)
  if (binding.kind === 'mysql') {
    const [rows]: Array<Array<{ acquired: number | null }>> = await k
      .raw('SELECT GET_LOCK(?, 0) AS acquired', [binding.lock])
      .connection(connection)
    if (rows[0]?.acquired === 0) throw new SnapshotArchiveGuardBusyError()
    if (rows[0]?.acquired !== 1) unavailable()
    await k.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY').connection(connection)
  } else {
    await k.raw('ATTACH DATABASE ? AS snapshot_owner', [binding.guard.path]).connection(connection)
    await k.raw('PRAGMA busy_timeout = 0').connection(connection)
  }
}

async function holdSQLiteGuard(trx: Knex, binding: SQLiteGuardBinding): Promise<void> {
  try {
    const changed = await trx('snapshot_owner.snapshot_owner_guard')
      .where({ id: 1, marker: binding.guard.marker })
      .update({ held: 1 })
    if (changed !== 1) unavailable()
    // The private connection only reads the wallet after establishing its guard.
    await trx.raw('PRAGMA query_only = ON')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'SQLITE_BUSY') throw new SnapshotArchiveGuardBusyError()
    throw error
  }
}

/** This pool is exclusively owned by this operation; no connection is returned for reuse. */
async function closeGuardPool(k: Knex, connection: { open?: boolean; stream?: Duplex }): Promise<void> {
  const stream = connection.stream
  let closedListener: (() => void) | undefined
  const nativeClose =
    stream === undefined || stream.closed
      ? undefined
      : new Promise<void>(resolve => {
          closedListener = resolve
          stream.once('close', resolve)
        })
  try {
    const destruction = k.destroy()
    const settled = await Promise.allSettled([destruction, k.client.releaseConnection(connection)])
    for (const result of settled) if (result.status === 'rejected') throw result.reason
    // mysql2's graceful-quit callback precedes the socket's physical close.
    await nativeClose
    const closed = String(k.client.config.client).includes('mysql')
      ? connection.stream?.closed === true
      : connection.open === false
    if (closed !== true) throw new Error('Snapshot archive source connection did not close')
  } catch (error) {
    throw new SnapshotArchiveSourceCleanupError(error)
  } finally {
    if (closedListener !== undefined) stream!.removeListener('close', closedListener)
  }
}

/**
 * Keep the same-connection guard until physical destruction. SQLite's normal
 * COMMIT would release it too early, so the private pool closes the still-open
 * read transaction. Knex then settles its expected closed-connection rollback;
 * only proved physical closure can supersede that internal completion result.
 */
export async function withSnapshotArchiveBackendGuard<T>(
  k: Knex,
  binding: SnapshotArchiveGuardBinding,
  read: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  const connection = await k.client.acquireConnection()
  let released = false
  const close = async (): Promise<void> => {
    released = true
    await closeGuardPool(k, connection)
  }
  try {
    await attachGuard(k, connection, binding)
    const trx = await k.transaction({ connection })
    void trx.executionPromise.catch(() => undefined)
    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      if (binding.kind === 'sqlite') await holdSQLiteGuard(trx, binding)
      outcome = { ok: true, value: await read(trx) }
    } catch (error) {
      outcome = { ok: false, error }
    }
    // A failed physical close deliberately leaves this manual transaction and
    // its guard held. Automatic rollback would falsely prove source cleanup.
    await close()
    await trx.rollback().catch(() => undefined)
    await trx.executionPromise.catch(() => undefined)
    if (!outcome.ok) throw outcome.error
    return outcome.value
  } finally {
    if (!released) await close()
  }
}
