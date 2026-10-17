import { isOwnedNativeSqlite } from '../schema/ownedNativeSqliteRuntimeNode'
import { createOwnedNativeReadDatabase } from '../schema/ownedNativeSqliteConnectionsNode'
import { lstat, realpath } from 'node:fs/promises'
import { isOwnedPrivateNativeSqlite } from '../schema/privateNativeSqliteRuntimeNode'
import { knex, type Knex } from 'knex'
import { brc38PrivateDestinationLease } from './Brc38PrivateDestinationLeaseNode'
import { createHash } from 'node:crypto'
import {
  prepareSnapshotJournalCaptureBackend,
  bindSnapshotJournalCaptureBackend,
  closeSnapshotJournalCapturePool,
  type SnapshotJournalCaptureBackend
} from '../snapshot/journal/SnapshotJournalCaptureBackend'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { readKnexSnapshotSourceSchema } from '../snapshot/archive/KnexSnapshotArchiveSource'
import type { StorageKnex } from '../StorageKnex'
import { runInSeries } from '../../utility/runInSeries'
import { WERR_INVALID_OPERATION } from '../../sdk/WERR_errors'
import { readSnapshotJournalSqliteGeneration } from '../snapshot/journal/SnapshotJournalSqliteGeneration'
import { snapshotJournalRevision, type SnapshotJournalRevision } from '../snapshot/journal/SnapshotJournalRevision'
import {
  snapshotJournalReceiptPolicy,
  type SnapshotJournalReceiptPolicy
} from '../snapshot/journal/SnapshotJournalReceipt'

export type Brc38ImportMode = 'restore' | 'merge'
export interface Brc38DestinationSelection {
  readonly identityKey: string
  readonly chain: 'main' | 'test'
  readonly targetStorageIdentityKey: string
  readonly mode: Brc38ImportMode
}
export interface Brc38KnexDestinationFence extends Brc38DestinationSelection {
  readonly backend: 'SQLite'
  readonly backendSha256: string
  readonly schemaVersionSha256: string
  readonly schemaSha256: string
  readonly epoch: string
  readonly revision: SnapshotJournalRevision
  readonly ceiling: SnapshotJournalRevision
  readonly userId: number | null
  readonly activeStorage: string | null
  readonly primaryEpoch: SnapshotJournalRevision | null
}
const restoreTables = [
  'users',
  'proven_txs',
  'proven_tx_reqs',
  'output_baskets',
  'transactions',
  'commissions',
  'outputs',
  'output_tags',
  'output_tags_map',
  'tx_labels',
  'tx_labels_map',
  'certificates',
  'certificate_fields',
  'sync_states',
  'monitor_events'
]
function invalid(): never {
  throw new WERR_INVALID_OPERATION('BRC-38 destination requires a complete enabled owned SQLite generation')
}
function local(storage: StorageKnex): void {
  const client = storage.knex.client.config.client
  if (storage.dbtype !== 'SQLite' || (client !== 'better-sqlite3' && !isOwnedNativeSqlite(storage.knex))) invalid()
}
export function brc38DestinationSelection(value: Brc38DestinationSelection): Readonly<Brc38DestinationSelection> {
  if (
    typeof value.identityKey !== 'string' ||
    value.identityKey.length < 1 ||
    value.identityKey.length > 256 ||
    !['main', 'test'].includes(value.chain) ||
    !['restore', 'merge'].includes(value.mode)
  )
    throw new TypeError('Invalid explicit BRC-38 destination profile, network or mode')
  if (
    typeof value.targetStorageIdentityKey !== 'string' ||
    value.targetStorageIdentityKey.length < 1 ||
    value.targetStorageIdentityKey.length > 256
  )
    throw new TypeError('Invalid explicit BRC-38 destination identity')
  return Object.freeze({
    identityKey: value.identityKey,
    chain: value.chain,
    targetStorageIdentityKey: value.targetStorageIdentityKey,
    mode: value.mode
  })
}
async function settings(k: Knex, selected: Brc38DestinationSelection): Promise<void> {
  const extents: Array<{ identityBytes: number; chainBytes: number; typeBytes: number }> = await k('settings')
    .select(
      k.raw(
        'length(CAST(storageIdentityKey AS BLOB)) identityBytes, length(CAST(chain AS BLOB)) chainBytes, length(CAST(dbtype AS BLOB)) typeBytes'
      )
    )
    .limit(2)
  if (
    extents.length !== 1 ||
    !Number.isSafeInteger(extents[0].identityBytes) ||
    extents[0].identityBytes < 1 ||
    extents[0].identityBytes > 256 ||
    ![4].includes(extents[0].chainBytes) ||
    extents[0].typeBytes !== 6
  )
    invalid()
  const rows: Array<{ storageIdentityKey: string; chain: string; dbtype: string }> = await k('settings')
    .select('storageIdentityKey', 'chain', 'dbtype')
    .limit(2)
  if (
    rows.length !== 1 ||
    rows[0].storageIdentityKey !== selected.targetStorageIdentityKey ||
    rows[0].chain !== selected.chain ||
    rows[0].dbtype !== 'SQLite'
  )
    throw new WERR_INVALID_OPERATION('BRC-38 destination identity or network differs from the import binding')
}
async function profile(
  k: Knex,
  identityKey: string
): Promise<{
  userId: number | null
  activeStorage: string | null
  primaryEpoch: SnapshotJournalRevision | null
}> {
  const rows: Array<{ userId: number; activeBytes: number }> = await k('users')
    .where({ identityKey })
    .select('userId', k.raw('length(CAST(activeStorage AS BLOB)) activeBytes'))
    .limit(2)
  if (rows.length === 0) return { userId: null, activeStorage: null, primaryEpoch: null }
  const row = rows[0]
  if (
    rows.length !== 1 ||
    !Number.isSafeInteger(row.userId) ||
    !Number.isSafeInteger(row.activeBytes) ||
    row.activeBytes < 0 ||
    row.activeBytes > 256
  )
    invalid()
  const value: { activeStorage: string } | undefined = await k('users')
    .where({ identityKey, userId: row.userId })
    .first('activeStorage')
  if (typeof value?.activeStorage !== 'string') invalid()
  return {
    userId: row.userId,
    activeStorage: value.activeStorage,
    primaryEpoch: await primaryEpoch(k, row.userId)
  }
}
/** The source-owned trigger records independent away-and-back primary writes.
 * Its actual users-table DDL is included in the validated journal source hash. */
async function primaryEpoch(k: Knex, userId: number): Promise<SnapshotJournalRevision> {
  const extents: Array<{ bytes: number; kind: string }> = await k('snapshot_sync_primary_epochs')
    .where({ userId })
    .select(k.raw('length(CAST(epoch AS BLOB)) bytes, typeof(epoch) kind'))
    .limit(2)
  if (extents.length === 0) return snapshotJournalRevision('0')
  if (
    extents.length !== 1 ||
    extents[0].kind !== 'integer' ||
    !Number.isSafeInteger(extents[0].bytes) ||
    extents[0].bytes < 1 ||
    extents[0].bytes > 19
  )
    invalid()
  const value: { epoch: string } | undefined = await k('snapshot_sync_primary_epochs')
    .where({ userId })
    .first(k.raw('CAST(epoch AS TEXT) epoch'))
  if (value === undefined) invalid()
  return snapshotJournalRevision(value.epoch)
}
export async function assertBrc38RestoreDestinationEmpty(k: Knex): Promise<void> {
  await runInSeries(restoreTables, async table => {
    const row = await k(table).select(k.raw('1 AS occupied')).first()
    if (row !== undefined) throw new Error('BRC-38 restore requires an empty target storage except settings')
  })
}
async function readFence(
  storage: StorageKnex,
  k: Knex,
  backendSha256: string,
  selected: Brc38DestinationSelection,
  policy: SnapshotJournalReceiptPolicy,
  checkRestoreEmpty = true
): Promise<Readonly<Brc38KnexDestinationFence>> {
  return await readBrc38KnexRetainedSourceFence(
    k,
    backendSha256,
    selected,
    policy,
    storage.knex.client.config.migrations,
    checkRestoreEmpty
  )
}
/** Exact source DATA from a genuinely retained view. The enclosing factory
 * supplies actual physical ownership and verifies it before/after this read;
 * this helper neither creates providers nor acquires writer/primary authority. */
export async function readBrc38KnexRetainedSourceFence(
  k: Knex,
  backendSha256: string,
  selected: Brc38DestinationSelection,
  policy: SnapshotJournalReceiptPolicy,
  migrations?: Knex.MigratorConfig,
  checkRestoreEmpty = true
): Promise<Readonly<Brc38KnexDestinationFence>> {
  const generation = await readSnapshotJournalSqliteGeneration(k, policy, migrations)
  if (!generation.complete || !generation.enabled) invalid()
  const clocks: Array<{ revision: string }> = await k('snapshot_journal_clock')
    .select(k.raw('CAST(revision AS TEXT) revision'))
    .where({ id: 1 })
    .limit(2)
  if (clocks.length !== 1) invalid()
  const revision = snapshotJournalRevision(clocks[0].revision)
  await settings(k, selected)
  const user = await profile(k, selected.identityKey)
  if (checkRestoreEmpty && selected.mode === 'restore') await assertBrc38RestoreDestinationEmpty(k)
  const schemaVersionSha256 = createHash('sha256')
    .update(await readKnexSnapshotSourceSchema(k, migrations))
    .digest('hex')
  return Object.freeze({
    ...selected,
    backend: 'SQLite',
    backendSha256,
    schemaVersionSha256,
    schemaSha256: generation.source,
    epoch: generation.epoch,
    revision,
    ceiling: generation.ceiling,
    ...user
  })
}
/** The file identity is captured BEFORE constructing this fresh, one-slot
 * native pool. Existing caller handles do not establish this ownership proof. */
async function withActualDestination<T>(
  storage: StorageKnex,
  work: (k: Knex, backendSha256: string, expected: SnapshotJournalCaptureBackend) => Promise<T>,
  readOnly = false
): Promise<T> {
  const privateLease = brc38PrivateDestinationLease(storage)
  privateLease?.assertLive()
  if (privateLease !== undefined && isOwnedPrivateNativeSqlite(storage.knex)) {
    // The actual C owner independently pins this inode/directory on each SQL
    // operation. This fresh DATA vector is compared with the native main file;
    // it is never saved as a reusable backend/source/schema verdict.
    const path = await realpath(privateLease.filename),
      info = await lstat(path, { bigint: true })
    if (!info.isFile()) invalid()
    const expected: SnapshotJournalCaptureBackend = {
      kind: 'sqlite',
      file: { path, device: info.dev.toString(), inode: info.ino.toString() }
    }
    return await privateLease.withDatabase(readOnly, async k => {
      privateLease.assertLive()
      const connection = await k.client.acquireConnection()
      let backendSha256: string
      try {
        const modes: Array<{ journal_mode: string }> = await k.raw('PRAGMA journal_mode').connection(connection),
          pages: Array<{ max_page_count: number }> = await k.raw('PRAGMA max_page_count').connection(connection)
        if (
          modes.length !== 1 ||
          modes[0].journal_mode !== 'delete' ||
          pages.length !== 1 ||
          pages[0].max_page_count !== privateLease.maximumPages
        )
          invalid()
        backendSha256 = await bindSnapshotJournalCaptureBackend(k, connection, k, connection, expected)
      } finally {
        await k.client.releaseConnection(connection)
      }
      const value = await work(k, backendSha256, expected)
      privateLease.assertLive()
      return value
    })
  }
  const config = storage.knex.client.config,
    expected = await prepareSnapshotJournalCaptureBackend(config, storage.knex)
  if (expected.kind !== 'sqlite') invalid()
  const native = isOwnedNativeSqlite(storage.knex),
    borrowed = native && !readOnly,
    owned = native
      ? readOnly
        ? createOwnedNativeReadDatabase(storage.knex)
        : storage.knex
      : knex({ ...config, pool: { ...(privateLease === undefined ? {} : config.pool), min: 0, max: 1 } })
  let connection: unknown,
    failed = false,
    cause: unknown,
    value!: T
  try {
    connection = await owned.client.acquireConnection()
    if (privateLease !== undefined) {
      await owned.raw('PRAGMA foreign_keys=ON').connection(connection)
      const bound: Array<{ max_page_count: number }> = await owned.raw('PRAGMA max_page_count').connection(connection)
      if (bound.at(0)?.max_page_count !== privateLease.maximumPages) invalid()
    }
    const rows: Array<{ journal_mode: string }> = await owned.raw('PRAGMA journal_mode').connection(connection)
    if (rows.length !== 1 || rows[0].journal_mode !== (privateLease === undefined ? 'wal' : 'delete')) invalid()
    const backendSha256 = await bindSnapshotJournalCaptureBackend(owned, connection, owned, connection, expected)
    await owned.client.releaseConnection(connection)
    value = await work(owned, backendSha256, expected)
  } catch (error) {
    failed = true
    cause = error
  }
  try {
    if (!borrowed) {
      if (connection === undefined) await owned.destroy()
      else await closeSnapshotJournalCapturePool(owned, connection)
    }
  } catch (error_) {
    throw new Brc38StagingCleanupError(
      [...(failed ? [cause] : []), error_],
      'Private import destination retains physical cleanup',
      async () => {
        if (connection === undefined) await owned.destroy()
        else await closeSnapshotJournalCapturePool(owned, connection)
      }
    )
  }
  if (failed) throw cause
  privateLease?.assertLive()
  return value
}
/** No active target rows or receipts are written. Every value is from the same
 * real provider-owned read transaction, including exact INTEGER clock text. */
export async function captureBrc38KnexDestinationFence(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy
): Promise<Readonly<Brc38KnexDestinationFence>> {
  local(storage)
  const selected = brc38DestinationSelection(selection),
    policy = Object.freeze({ ...snapshotJournalReceiptPolicy(receiptPolicy) })
  return await withActualDestination(
    storage,
    async (k, backendSha256, expected) =>
      await k.transaction(async trx => {
        const connection = await trx.client.acquireConnection()
        if ((await bindSnapshotJournalCaptureBackend(trx, connection, trx, connection, expected)) !== backendSha256)
          invalid()
        return await readFence(storage, trx, backendSha256, selected, policy)
      }),
    true
  )
}
/** Writer ownership precedes every target read. A stale view never invokes the
 * caller's bounded atomic activation step. This is a fence primitive, not the
 * complete mapping/activation journal or primary role authorization. */
export async function withBrc38KnexDestinationFence<T>(
  storage: StorageKnex,
  expected: Brc38KnexDestinationFence,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  write: (trx: Knex.Transaction) => Promise<T>
): Promise<T> {
  local(storage)
  const selected = brc38DestinationSelection(expected),
    wanted = JSON.stringify(expected),
    policy = Object.freeze({ ...snapshotJournalReceiptPolicy(receiptPolicy) })
  return await withActualDestination(
    storage,
    async (k, backendSha256, expectedBackend) =>
      await k.transaction(async trx => {
        if (
          (await trx('snapshot_journal_clock')
            .where({ id: 1 })
            .update({ revision: trx.ref('revision') })) !== 1
        )
          invalid()
        const connection = await trx.client.acquireConnection()
        if (
          (await bindSnapshotJournalCaptureBackend(trx, connection, trx, connection, expectedBackend)) !== backendSha256
        )
          invalid()
        const actual = await readFence(storage, trx, backendSha256, selected, policy)
        if (JSON.stringify(actual) !== wanted)
          throw new WERR_INVALID_OPERATION('BRC-38 destination changed after its private import preview')
        return await write(trx)
      })
  )
}

/** Internal import-journal owner. A real writer precedes every target view;
 * continuation deliberately uses the authenticated destination checkpoint
 * rather than repeating initial restore emptiness after its own rows exist. */
export async function withBrc38KnexImportDestination<T>(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  work: (trx: Knex.Transaction, read: () => Promise<Readonly<Brc38KnexDestinationFence>>) => Promise<T>
): Promise<T> {
  local(storage)
  const selected = brc38DestinationSelection(selection),
    policy = Object.freeze({ ...snapshotJournalReceiptPolicy(receiptPolicy) })
  return await withActualDestination(
    storage,
    async (k, backendSha256, expectedBackend) =>
      await k.transaction(async trx => {
        if (
          (await trx('snapshot_journal_clock')
            .where({ id: 1 })
            .update({ revision: trx.ref('revision') })) !== 1
        )
          invalid()
        const connection = await trx.client.acquireConnection()
        const read = importFenceReader(storage, trx, connection, backendSha256, expectedBackend, selected, policy)
        return await work(trx, read)
      })
  )
}

function importFenceReader(
  storage: StorageKnex,
  trx: Knex.Transaction,
  connection: unknown,
  backendSha256: string,
  expectedBackend: SnapshotJournalCaptureBackend,
  selected: Brc38DestinationSelection,
  policy: SnapshotJournalReceiptPolicy
): () => Promise<Readonly<Brc38KnexDestinationFence>> {
  return async () => {
    if ((await bindSnapshotJournalCaptureBackend(trx, connection, trx, connection, expectedBackend)) !== backendSha256)
      invalid()
    return await readFence(storage, trx, backendSha256, selected, policy, false)
  }
}

/** A fresh physical read-only pool pins one destination snapshot for bounded
 * preparation. It never takes the SQL writer. Its view is not commit authority:
 * the subsequent writer must compare the destination-authoritative receipt. */
export async function withBrc38KnexImportReadDestination<T>(
  storage: StorageKnex,
  selection: Brc38DestinationSelection,
  receiptPolicy: SnapshotJournalReceiptPolicy,
  prepare: (trx: Knex.Transaction, actual: Readonly<Brc38KnexDestinationFence>) => Promise<T>
): Promise<T> {
  local(storage)
  const selected = brc38DestinationSelection(selection),
    policy = Object.freeze({ ...snapshotJournalReceiptPolicy(receiptPolicy) })
  return await withActualDestination(
    storage,
    async (k, backendSha256, expectedBackend) => {
      // The owned native read connection sets this before installing its
      // authorizer. Frozen comparison correctly refuses subsequent setters.
      if (!isOwnedNativeSqlite(k)) await k.raw('PRAGMA query_only=ON')
      return await k.transaction(async trx => {
        const assertReadOnly = async () => {
          const rows: Array<{ query_only: number }> = await trx.raw('PRAGMA query_only')
          if (rows.length !== 1 || rows[0].query_only !== 1) invalid()
        }
        await assertReadOnly()
        const connection = await trx.client.acquireConnection()
        const read = importFenceReader(storage, trx, connection, backendSha256, expectedBackend, selected, policy)
        const actual = await read(),
          value = await prepare(trx, actual)
        await assertReadOnly()
        if (JSON.stringify(await read()) !== JSON.stringify(actual)) invalid()
        return value
      })
    },
    true
  )
}
