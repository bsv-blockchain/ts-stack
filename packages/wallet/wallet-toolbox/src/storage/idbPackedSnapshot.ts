import type { TableSettings, TableUser } from './schema/tables'
import type {
  WalletReadSnapshot,
  WalletReadSnapshotOptions,
  WalletSnapshotCursor,
  WalletSnapshotPage,
  WalletSnapshotPageLimits,
  WalletSnapshotTable,
  WalletSnapshotTables,
  PackedSnapshotRow,
  WalletSnapshotFieldDescriptor,
  WalletSnapshotFieldReader,
  WalletSnapshotFieldMetadataPage
} from './snapshot/WalletReadSnapshot'
import { SnapshotResourceLimitError } from './snapshot/SnapshotResourceLimitError'
import { Brc38StagingCleanupError } from './portable/Brc38StagingCleanupError'
import { WERR_UNAUTHORIZED } from '../sdk/WERR_errors'
import { getPackedIdbConnection, requirePackedIdbTransaction, type PackedIdbConnection } from './idbPackedConnection'
import { collectPackedIdbJsonIndexes } from './idbPackedJsonIndex'
import {
  chargePackedIdb,
  packedIdbIsAbortError,
  hydratePackedIdbRow,
  newPackedIdbId,
  packedIdbAllocationBytes,
  packedIdbInvalid,
  packedIdbKey,
  packedIdbMetadataCharge,
  packedIdbPortableKey,
  packedIdbReplicaKey,
  packedIdbPositive,
  packedIdbRowAllocation,
  packedIdbStores,
  readPackedIdbClock,
  readPackedIdbExtent,
  retainPackedIdbFields,
  unpackPackedIdbMetadata,
  packedIdbVersionCharge,
  verifyPackedIdbReferences,
  type PackedIdbField,
  type PackedIdbRow,
  type PackedIdbTransaction
} from './idbPackedFields'
import type { IDBPDatabase } from 'idb'
import type { StorageIdbSchema } from './schema/StorageIdbSchema'
import type { IdbPackedCursor, IdbPackedPage, IdbPackedPageOptions } from './idbPackedPage'

const tables: Readonly<Record<WalletSnapshotTable, string>> = Object.freeze({
  provenTxs: 'proven_txs',
  provenTxReqs: 'proven_tx_reqs',
  outputBaskets: 'output_baskets',
  transactions: 'transactions',
  commissions: 'commissions',
  outputs: 'outputs',
  outputTags: 'output_tags',
  outputTagMaps: 'output_tags_map',
  txLabels: 'tx_labels',
  txLabelMaps: 'tx_labels_map',
  certificates: 'certificates',
  certificateFields: 'certificate_fields',
  syncStates: 'sync_states'
})
export interface PackedIdbMetadataRow<T extends WalletSnapshotTable> {
  fields: Partial<PackedSnapshotRow<WalletSnapshotTables[T]>>
  /** Binary and UTF-16 text descriptors. These identify data, never admission. */
  extents: Readonly<Record<string, Readonly<PackedIdbField>>>
  cursor: WalletSnapshotCursor
}
export interface PackedIdbMetadataPage<T extends WalletSnapshotTable> {
  rows: Array<PackedIdbMetadataRow<T>>
  payloadBytes: number
  done: boolean
  cursor?: WalletSnapshotCursor
  examined: number
}
export interface PackedIdbPageLimits extends WalletSnapshotPageLimits {
  maxExamined?: number
  order?: 'native' | 'portable' | 'replica'
}
export interface PackedIdbSnapshotFieldReader extends WalletSnapshotFieldReader {
  readMetadataPage: <T extends WalletSnapshotTable>(
    table: T,
    cursor?: WalletSnapshotCursor,
    limits?: PackedIdbPageLimits
  ) => Promise<WalletSnapshotFieldMetadataPage<T>>
}
export interface PackedIdbReadSnapshot extends WalletReadSnapshot {
  readonly fieldReader: PackedIdbSnapshotFieldReader
  readPage: <T extends WalletSnapshotTable>(
    table: T,
    cursor?: WalletSnapshotCursor,
    limits?: PackedIdbPageLimits
  ) => Promise<WalletSnapshotPage<T> & { examined: number }>
  readFieldMetadataPage: <T extends WalletSnapshotTable>(
    table: T,
    cursor?: WalletSnapshotCursor,
    limits?: PackedIdbPageLimits
  ) => Promise<PackedIdbMetadataPage<T>>
  readFieldExtent: (
    table: WalletSnapshotTable,
    cursor: WalletSnapshotCursor,
    field: string,
    offset: number,
    length: number,
    expected: Readonly<PackedIdbField>
  ) => Promise<Uint8Array>
  /** Independent complete metadata/relationship pass at the owned ceiling. */
  validateClosure: () => Promise<void>
}
const snapshotOwners = new WeakMap<
  object,
  { owner: PackedIdbConnection; fresh: (tx: PackedIdbTransaction) => Promise<void> }
>()
/** Actual factory membership selects the snapshot; fresh then checks its real
 * current profile/primary/lease/schema in this caller's actual transaction. */
export async function requirePackedIdbSnapshotInTransaction(
  view: PackedIdbReadSnapshot,
  owner: PackedIdbConnection,
  tx: PackedIdbTransaction
): Promise<void> {
  const actual = snapshotOwners.get(view)
  if (actual === undefined || actual.owner !== owner || getPackedIdbConnection(owner.database) !== owner)
    packedIdbInvalid()
  requirePackedIdbTransaction(owner.database, tx)
  await actual.fresh(tx)
}
function bounded(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) packedIdbInvalid()
  return result
}
function unmarked(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object') packedIdbInvalid()
  const row = value as Record<string, unknown>
  if (!Object.hasOwn(row, '__walletPackedV1')) return row
  const packed = unpackPackedIdbMetadata(row)
  if (Object.keys(packed.extents).length !== 0) packedIdbInvalid()
  return packed.fields
}
async function versionAt(
  tx: PackedIdbTransaction,
  store: string,
  key: IDBValidKey,
  revision: number
): Promise<PackedIdbRow | undefined> {
  const cursor = await tx
    .objectStore(packedIdbStores.versions)
    .openCursor(IDBKeyRange.bound([store, key, 0], [store, key, revision]), 'prev')
  if (cursor === null) return undefined
  const value = cursor.value
  if (
    value.store !== store ||
    indexedDB.cmp(value.key as IDBValidKey, key) !== 0 ||
    typeof value.revision !== 'number' ||
    value.revision > revision ||
    typeof value.deleted !== 'boolean'
  )
    packedIdbInvalid()
  return value.deleted ? undefined : unpackPackedIdbMetadata(value.value)
}
async function own(
  tx: PackedIdbTransaction,
  store: string,
  id: unknown,
  revision: number,
  userId: number
): Promise<boolean> {
  const row = await versionAt(tx, store, packedIdbPositive(id), revision)
  return row !== undefined && row.fields.userId === userId
}
/** Historic reverse references are looked up at the same captured ceiling as
 * the parent rows. A current index cannot establish an old archive closure. */
async function referenced(
  tx: PackedIdbTransaction,
  store: string,
  subject: 'txid' | 'proof',
  value: IDBValidKey,
  revision: number,
  match: (row: PackedIdbRow) => Promise<boolean>
): Promise<boolean> {
  const index = tx.objectStore(packedIdbStores.versions).index(subject)
  let cursor = await index.openCursor([store, value])
  for (let examined = 0; cursor !== null; examined++) {
    if (examined >= 256) throw new SnapshotResourceLimitError('Packed IndexedDB historic reference policy reached')
    const candidate = cursor.value
    if (typeof candidate.revision !== 'number') packedIdbInvalid()
    const key = packedIdbKey(candidate.key),
      row = await versionAt(tx, store, key, revision)
    if (
      row !== undefined &&
      (subject === 'txid' ? row.fields.txid === value : row.fields.provenTxId === value) &&
      (await match(row))
    )
      return true
    // The index's primary key ends in a numeric revision. The array sentinel
    // sorts after every numeric revision for this exact native row, so many
    // updates do not multiply relation probes. This is a position, not a cache.
    cursor = await cursor.continuePrimaryKey([store, value], [store, key, []])
  }
  return false
}
async function rowSelected(
  tx: PackedIdbTransaction,
  table: WalletSnapshotTable,
  row: PackedIdbRow,
  revision: number,
  userId: number
): Promise<boolean> {
  const r = row.fields
  if (table === 'outputTagMaps' || table === 'txLabelMaps') {
    const left =
      table === 'outputTagMaps'
        ? await own(tx, 'outputs', r.outputId, revision, userId)
        : await own(tx, 'transactions', r.transactionId, revision, userId)
    const right =
      table === 'outputTagMaps'
        ? await own(tx, 'output_tags', r.outputTagId, revision, userId)
        : await own(tx, 'tx_labels', r.txLabelId, revision, userId)
    if (left !== right) packedIdbInvalid()
    return left
  }
  if (table === 'provenTxReqs') {
    if (typeof r.txid !== 'string' || !/^[0-9a-f]{64}$/.test(r.txid)) packedIdbInvalid()
    return await referenced(tx, 'transactions', 'txid', r.txid, revision, async txRow => txRow.fields.userId === userId)
  }
  if (table === 'provenTxs') {
    const id = packedIdbPositive(r.provenTxId)
    if (await referenced(tx, 'transactions', 'proof', id, revision, async txRow => txRow.fields.userId === userId))
      return true
    return await referenced(tx, 'proven_tx_reqs', 'proof', id, revision, async req => {
      if (typeof req.fields.txid !== 'string') packedIdbInvalid()
      return await referenced(
        tx,
        'transactions',
        'txid',
        req.fields.txid,
        revision,
        async txRow => txRow.fields.userId === userId
      )
    })
  }
  if (r.userId !== userId) return false
  if (table === 'certificateFields' && !(await own(tx, 'certificates', r.certificateId, revision, userId)))
    packedIdbInvalid()
  return true
}
async function drain<T>(tx: PackedIdbTransaction, run: () => Promise<T>): Promise<T> {
  try {
    const answer = await run()
    await tx.done
    return answer
  } catch (error_) {
    try {
      tx.abort()
    } catch {
      /* A settled transaction has no active work. */
    }
    try {
      await tx.done
    } catch (error) {
      if (error !== error_ && !packedIdbIsAbortError(error))
        throw new AggregateError([error_, error], 'Packed IndexedDB snapshot and transaction cleanup failed', {
          cause: error_
        })
    }
    throw error_
  }
}
/** One durable finite lease, no retained IndexedDB transaction. All calls read
 * actual current schema/profile/primary/lease before serving immutable versions.
 * Foreground writers may advance between every page and extent. */
export async function openPackedIdbSnapshot(
  db: IDBPDatabase<StorageIdbSchema>,
  identityKey: string,
  chain: string,
  selected: WalletReadSnapshotOptions = {}
): Promise<PackedIdbReadSnapshot> {
  const options = Object.freeze({ ...selected })
  const owner = getPackedIdbConnection(db)
  if (
    owner === undefined ||
    !owner.isOpen ||
    typeof identityKey !== 'string' ||
    identityKey.length < 1 ||
    identityKey.length > 130
  )
    packedIdbInvalid()
  const lifetimeMs = bounded(options.lifetimeMs, 300000, 3600000),
    expiresAt = Date.now() + lifetimeMs,
    monotonicExpires = performance.now() + lifetimeMs,
    id = newPackedIdbId()
  let closed = false,
    busy = false,
    inFlight: Promise<unknown> | undefined,
    closePromise: Promise<void> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let resolveClosed!: () => void, rejectClosed!: (error: unknown) => void
  const closedPromise = new Promise<void>((resolve, reject) => {
    resolveClosed = resolve
    rejectClosed = reject
  })
  void closedPromise.catch(() => undefined)
  const current = () => {
    owner.assertOpen()
    options.signal?.throwIfAborted()
    if (closed || Date.now() >= expiresAt || performance.now() >= monotonicExpires)
      throw new SnapshotResourceLimitError('Packed IndexedDB snapshot closed or expired')
  }
  current()
  const opening = owner.rawTransaction(['settings', 'users'], 'readwrite')
  const source = await drain(opening, async () => {
    current()
    const clock = await readPackedIdbClock(opening),
      settingsRows = await opening.objectStore('settings').getAll(undefined, 2)
    const rawUser = await opening.objectStore('users').index('identityKey').get(identityKey)
    if (rawUser === undefined) throw new WERR_UNAUTHORIZED()
    const settings = settingsRows.length === 1 ? unmarked(settingsRows[0]) : packedIdbInvalid(),
      user = unmarked(rawUser)
    packedIdbMetadataCharge(settings)
    packedIdbMetadataCharge(user)
    if (
      settings.chain !== chain ||
      typeof settings.storageIdentityKey !== 'string' ||
      settings.storageIdentityKey.length < 1 ||
      user.identityKey !== identityKey ||
      typeof user.activeStorage !== 'string'
    )
      packedIdbInvalid()
    const userId = packedIdbPositive(user.userId),
      userHead = await opening.objectStore(packedIdbStores.heads).get(['users', userId])
    if (userHead === undefined) packedIdbInvalid()
    const count = await opening.objectStore(packedIdbStores.leases).count()
    if (count >= 64)
      throw new SnapshotResourceLimitError('Packed IndexedDB snapshot lease capacity reached; collect expired leases')
    await chargePackedIdb(opening, 1024, 1)
    await opening.objectStore(packedIdbStores.leases).add({
      id,
      epoch: clock.epoch,
      revision: clock.revision,
      expiresAt,
      identityKey,
      userId,
      storageIdentityKey: settings.storageIdentityKey,
      userRevision: userHead.revision
    })
    current()
    return { epoch: clock.epoch, revision: clock.revision, settings, user, userId, userRevision: userHead.revision }
  })
  const fresh = async (tx: PackedIdbTransaction) => {
    current()
    const clock = await readPackedIdbClock(tx),
      lease = await tx.objectStore(packedIdbStores.leases).get(id)
    if (
      clock.epoch !== source.epoch ||
      clock.revision < source.revision ||
      lease?.epoch !== source.epoch ||
      lease.revision !== source.revision ||
      lease.expiresAt !== expiresAt ||
      lease.identityKey !== identityKey ||
      lease.userId !== source.userId ||
      lease.userRevision !== source.userRevision ||
      lease.storageIdentityKey !== source.settings.storageIdentityKey
    )
      packedIdbInvalid()
    const rows = await tx.objectStore('settings').getAll(undefined, 2),
      user = await tx.objectStore('users').get(source.userId),
      head = await tx.objectStore(packedIdbStores.heads).get(['users', source.userId])
    if (
      rows.length !== 1 ||
      JSON.stringify(unmarked(rows[0])) !== JSON.stringify(source.settings) ||
      user === undefined ||
      unmarked(user).identityKey !== identityKey ||
      unmarked(user).activeStorage !== source.user.activeStorage ||
      head?.revision !== source.userRevision
    )
      packedIdbInvalid()
  }
  const position = (table: WalletSnapshotTable, key: IDBValidKey): WalletSnapshotCursor => ({
    version: 1,
    snapshotId: id,
    table,
    after: Array.isArray(key) ? (key as Array<number | string>) : [key as number | string]
  })
  const keyFrom = (table: WalletSnapshotTable, cursor: WalletSnapshotCursor): IDBValidKey => {
    if (
      cursor.version !== 1 ||
      cursor.snapshotId !== id ||
      cursor.table !== table ||
      !Array.isArray(cursor.after) ||
      cursor.archivePosition !== undefined
    )
      packedIdbInvalid()
    const key =
      table === 'outputTagMaps' || table === 'txLabelMaps' || table === 'certificateFields'
        ? cursor.after
        : cursor.after.length === 1
          ? cursor.after[0]
          : packedIdbInvalid()
    return packedIdbKey(key)
  }
  const operation = async <T>(run: (tx: PackedIdbTransaction) => Promise<T>): Promise<T> => {
    current()
    if (busy) packedIdbInvalid()
    busy = true
    try {
      const tx = owner.rawTransaction(['settings', 'users'], 'readonly')
      const pending = drain(tx, async () => {
        await fresh(tx)
        const answer = await run(tx)
        await fresh(tx)
        current()
        return answer
      })
      inFlight = pending
      const answer = await pending
      current()
      return answer
    } finally {
      busy = false
      inFlight = undefined
    }
  }
  const page = async <T extends WalletSnapshotTable>(
    table: T,
    previous: WalletSnapshotCursor | undefined,
    limits: PackedIdbPageLimits | undefined,
    hydrate: boolean
  ): Promise<(WalletSnapshotPage<T> & { examined: number }) | PackedIdbMetadataPage<T>> =>
    operation(async tx => {
      if (!Object.hasOwn(tables, table)) packedIdbInvalid()
      const maximumRows = bounded(limits?.maxRows, 128, 256),
        maximumBytes = bounded(limits?.maxBytes, 262144, packedIdbAllocationBytes),
        maximumExamined = bounded(limits?.maxExamined, 256, 256),
        after = previous === undefined ? undefined : keyFrom(table, previous),
        store = tables[table]
      if (limits?.order !== undefined && !['native', 'portable', 'replica'].includes(limits.order)) packedIdbInvalid()
      const order = limits?.order ?? 'native',
        orderedKey = (key: IDBValidKey): IDBValidKey =>
          order === 'portable'
            ? packedIdbPortableKey(store, key)
            : order === 'replica'
              ? packedIdbReplicaKey(store, key)
              : key,
        seek = after === undefined ? undefined : orderedKey(after),
        range = IDBKeyRange.bound(
          seek === undefined ? [store] : [store, seek],
          [store + '\u0000'],
          after !== undefined
        ),
        heads = tx.objectStore(packedIdbStores.heads)
      let cursor = order === 'native' ? await heads.openCursor(range) : await heads.index(order).openCursor(range),
        examined = 0,
        payloadBytes = 0,
        last = previous
      const pending: Array<{ row: PackedIdbRow; cursor: WalletSnapshotCursor }> = []
      while (cursor !== null && examined < maximumExamined && pending.length < maximumRows) {
        current()
        const native = packedIdbKey(cursor.value.key)
        if (
          cursor.value.store !== store ||
          indexedDB.cmp(cursor.primaryKey, [store, native]) !== 0 ||
          indexedDB.cmp(cursor.key, [store, orderedKey(native)]) !== 0 ||
          JSON.stringify(cursor.value.portableKey) !== JSON.stringify(packedIdbPortableKey(store, native)) ||
          JSON.stringify(cursor.value.replicaKey) !== JSON.stringify(packedIdbReplicaKey(store, native))
        )
          packedIdbInvalid()
        const row = await versionAt(tx, store, native, source.revision)
        if (row !== undefined && (await rowSelected(tx, table, row, source.revision, source.userId))) {
          const charge = hydrate
            ? packedIdbRowAllocation(row, false)
            : packedIdbMetadataCharge(row.fields) + Object.keys(row.extents).length * 256
          if (charge > maximumBytes - payloadBytes) {
            if (pending.length === 0)
              throw new SnapshotResourceLimitError(
                'Packed IndexedDB snapshot row exceeds selected budget; use field metadata/extents'
              )
            break
          }
          pending.push({ row, cursor: position(table, native) })
          payloadBytes += charge
        }
        examined++
        last = position(table, native)
        cursor = await cursor.continue()
      }
      if (hydrate) {
        const rows: Array<PackedSnapshotRow<WalletSnapshotTables[T]>> = []
        for (const item of pending)
          rows.push(
            (await hydratePackedIdbRow(tx, item.row, false, maximumBytes)) as unknown as PackedSnapshotRow<
              WalletSnapshotTables[T]
            >
          )
        return { rows, payloadBytes, examined, done: cursor === null, ...(last === undefined ? {} : { cursor: last }) }
      }
      return {
        rows: pending.map(item => ({
          fields: item.row.fields as Partial<PackedSnapshotRow<WalletSnapshotTables[T]>>,
          extents: item.row.extents,
          cursor: item.cursor
        })),
        payloadBytes,
        examined,
        done: cursor === null,
        ...(last === undefined ? {} : { cursor: last })
      }
    })
  const close = (): Promise<void> => {
    if (closePromise !== undefined) return closePromise
    closed = true
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    options.signal?.removeEventListener('abort', abort)
    closePromise = (async () => {
      try {
        try {
          await inFlight
        } catch {
          /* The operation caller receives its original failure. */
        }
        if (!owner.isOpen || getPackedIdbConnection(db) !== owner) packedIdbInvalid()
        {
          const tx = owner.rawTransaction([], 'readwrite')
          await drain(tx, async () => {
            const clock = await readPackedIdbClock(tx),
              lease = await tx.objectStore(packedIdbStores.leases).get(id)
            if (clock.epoch !== source.epoch) packedIdbInvalid()
            if (lease !== undefined) {
              if (
                lease.id !== id ||
                lease.epoch !== source.epoch ||
                lease.revision !== source.revision ||
                lease.expiresAt !== expiresAt ||
                lease.identityKey !== identityKey ||
                lease.userId !== source.userId ||
                lease.userRevision !== source.userRevision ||
                lease.storageIdentityKey !== source.settings.storageIdentityKey
              )
                packedIdbInvalid()
              await tx.objectStore(packedIdbStores.leases).delete(id)
              await chargePackedIdb(tx, -1024, -1)
            }
          })
        }
        resolveClosed()
      } catch (cause) {
        const error = new Brc38StagingCleanupError(
          [cause],
          'Packed snapshot retains its actual lease and storage charge until physical cleanup',
          close
        )
        rejectClosed(error)
        throw error
      }
    })()
    void closePromise.catch(() => {
      closePromise = undefined
    })
    return closePromise
  }
  const abort = () => {
    void close().catch(() => undefined)
  }
  expiryTimer = setTimeout(abort, Math.max(0, expiresAt - Date.now()))
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const result: PackedIdbReadSnapshot = {
    version: 1,
    snapshotId: id,
    sourceStorage: structuredClone(source.settings) as unknown as TableSettings,
    user: structuredClone(source.user) as unknown as TableUser,
    expiresAt,
    get isOpen() {
      return (
        !closed &&
        owner.isOpen &&
        Date.now() < expiresAt &&
        performance.now() < monotonicExpires &&
        !options.signal?.aborted
      )
    },
    closed: closedPromise,
    close,
    fieldReader: {
      readMetadataPage: async (table, cursor, limits) => {
        const maximumBytes = bounded(limits?.maxBytes, 262144, packedIdbAllocationBytes),
          maximumRows = bounded(limits?.maxRows, 128, 1000),
          metadata = (await page(
            table,
            cursor,
            { ...limits, maxRows: Math.min(256, maximumRows), maxBytes: Math.max(1, Math.floor(maximumBytes / 4)) },
            false
          )) as PackedIdbMetadataPage<typeof table>
        // Reserve the native detached page plus public descriptor/cursor/row
        // copies before constructing the latter. This is an allocation charge,
        // not an encoded-byte estimate or a renewed source allowance.
        if (4 * metadata.payloadBytes > maximumBytes) packedIdbInvalid()
        const rows = metadata.rows.map(row => {
          const extents: Record<string, Readonly<WalletSnapshotFieldDescriptor>> = Object.create(null)
          for (const [name, field] of Object.entries(row.extents))
            extents[name] = Object.freeze<WalletSnapshotFieldDescriptor>({
              kind: field.kind === 'utf16' ? 'utf16le' : 'binary',
              bytes: field.bytes,
              sha256: field.sha256
            })
          return {
            fields: row.fields,
            extents: Object.freeze(extents),
            cursor: { ...row.cursor, after: [...row.cursor.after] }
          }
        })
        return {
          rows,
          payloadBytes: 4 * metadata.payloadBytes,
          done: metadata.done,
          ...(metadata.cursor === undefined
            ? {}
            : { cursor: { ...metadata.cursor, after: [...metadata.cursor.after] } })
        }
      },
      readFieldExtent: async (table, cursor, field, offset, length, selectedExpected) => {
        const expected = Object.freeze({
          kind: selectedExpected.kind,
          bytes: selectedExpected.bytes,
          sha256: selectedExpected.sha256
        })
        return await operation(async tx => {
          if (
            !Object.hasOwn(tables, table) ||
            typeof field !== 'string' ||
            field.length < 1 ||
            field.length > 128 ||
            cursor.archivePosition !== undefined ||
            !Number.isSafeInteger(expected.bytes) ||
            expected.bytes < 0 ||
            (expected.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(expected.sha256))
          )
            packedIdbInvalid()
          const row = await versionAt(tx, tables[table], keyFrom(table, cursor), source.revision)
          if (row === undefined || !(await rowSelected(tx, table, row, source.revision, source.userId)))
            packedIdbInvalid()
          const actual = row.extents[field]
          if (
            actual === undefined ||
            expected.kind !== (actual.kind === 'utf16' ? 'utf16le' : 'binary') ||
            actual.bytes !== expected.bytes ||
            (expected.sha256 !== undefined && actual.sha256 !== expected.sha256)
          )
            packedIdbInvalid()
          return await readPackedIdbExtent(tx, actual, offset, length)
        })
      }
    },
    readPage: async (table, cursor, limits) =>
      (await page(table, cursor, limits, true)) as WalletSnapshotPage<typeof table> & { examined: number },
    readFieldMetadataPage: async (table, cursor, limits) =>
      (await page(table, cursor, limits, false)) as PackedIdbMetadataPage<typeof table>,
    readFieldExtent: async (table, cursor, field, offset, length, expected) =>
      await operation(async tx => {
        if (!Object.hasOwn(tables, table) || typeof field !== 'string') packedIdbInvalid()
        const row = await versionAt(tx, tables[table], keyFrom(table, cursor), source.revision)
        if (row === undefined || !(await rowSelected(tx, table, row, source.revision, source.userId)))
          packedIdbInvalid()
        const actual = row.extents[field]
        if (
          actual === undefined ||
          actual.content !== expected.content ||
          actual.kind !== expected.kind ||
          actual.bytes !== expected.bytes ||
          actual.sha256 !== expected.sha256
        )
          packedIdbInvalid()
        return await readPackedIdbExtent(tx, actual, offset, length)
      }),
    validateClosure: async () => {
      for (const table of Object.keys(tables) as WalletSnapshotTable[]) {
        let after: WalletSnapshotCursor | undefined,
          done = false
        while (!done) {
          const next = await operation(async tx => {
            const store = tables[table],
              key = after === undefined ? undefined : keyFrom(table, after),
              range = IDBKeyRange.bound(
                key === undefined ? [store] : [store, key],
                [store + '\u0000'],
                key !== undefined
              )
            let cursor = await tx.objectStore(packedIdbStores.heads).openCursor(range),
              last = after
            for (let examined = 0; cursor !== null && examined < 128; examined++, cursor = await cursor.continue()) {
              current()
              const native = packedIdbKey(cursor.value.key)
              if (
                cursor.value.store !== store ||
                indexedDB.cmp(cursor.primaryKey, [store, native]) !== 0 ||
                JSON.stringify(cursor.value.portableKey) !== JSON.stringify(packedIdbPortableKey(store, native)) ||
                JSON.stringify(cursor.value.replicaKey) !== JSON.stringify(packedIdbReplicaKey(store, native))
              )
                packedIdbInvalid()
              const row = await versionAt(tx, store, native, source.revision)
              if (row !== undefined && (await rowSelected(tx, table, row, source.revision, source.userId)))
                await validateRowReferences(tx, table, row, source.revision, source.userId)
              last = position(table, native)
            }
            return { cursor: last, done: cursor === null }
          })
          if (!next.done && next.cursor === undefined) packedIdbInvalid()
          after = next.cursor
          done = next.done
        }
      }
    }
  }
  snapshotOwners.set(result, { owner, fresh })
  return result
}

async function validateRowReferences(
  tx: PackedIdbTransaction,
  table: WalletSnapshotTable,
  row: PackedIdbRow,
  revision: number,
  userId: number
): Promise<void> {
  const references: Partial<Record<WalletSnapshotTable, ReadonlyArray<readonly [string, string, boolean, boolean]>>> = {
    transactions: [['provenTxId', 'proven_txs', false, true]],
    provenTxReqs: [['provenTxId', 'proven_txs', false, true]],
    commissions: [['transactionId', 'transactions', true, false]],
    outputs: [
      ['transactionId', 'transactions', true, false],
      ['basketId', 'output_baskets', true, true],
      ['spentBy', 'transactions', true, true]
    ],
    txLabelMaps: [
      ['transactionId', 'transactions', true, false],
      ['txLabelId', 'tx_labels', true, false]
    ],
    outputTagMaps: [
      ['outputId', 'outputs', true, false],
      ['outputTagId', 'output_tags', true, false]
    ],
    certificateFields: [
      ['certificateId', 'certificates', true, false],
      ['userId', 'users', true, false]
    ]
  }
  for (const [field, target, scoped, optional] of references[table] ?? []) {
    const value = row.fields[field]
    if (value == null && optional) continue
    const parent = await versionAt(tx, target, packedIdbPositive(value), revision)
    if (parent === undefined || (scoped && parent.fields.userId !== userId)) packedIdbInvalid()
  }
}

/** Compatibility page adapter with typed payloads and bounded metadata-first
 * preflight. Each call owns a fresh lease/view; only openWalletReadSnapshot
 * promises cross-page immutability. Original cursor metadata is never a lease. */
export async function readCurrentPackedIdbPage<T extends WalletSnapshotTable>(
  db: IDBPDatabase<StorageIdbSchema>,
  identityKey: string,
  chain: string,
  table: T,
  previous?: IdbPackedCursor,
  options: IdbPackedPageOptions = {}
): Promise<IdbPackedPage<T>> {
  const snapshot = await openPackedIdbSnapshot(db, identityKey, chain, { signal: options.signal })
  try {
    if (
      previous !== undefined &&
      (previous.version !== 1 ||
        previous.database !== db.name ||
        previous.schemaVersion !== db.version ||
        previous.storageIdentityKey !== snapshot.sourceStorage.storageIdentityKey ||
        previous.identityKey !== identityKey ||
        previous.table !== table)
    )
      packedIdbInvalid()
    const after = previous === undefined ? undefined : packedIdbKey(previous.after)
    const cursor =
      after === undefined
        ? undefined
        : {
            version: 1 as const,
            snapshotId: snapshot.snapshotId,
            table,
            after: Array.isArray(after) ? (after as Array<number | string>) : [after as number | string]
          }
    const page = await snapshot.readPage(table, cursor, {
      maxRows: options.maximumRows,
      maxBytes: options.maximumBytes,
      maxExamined: options.maximumExamined
    })
    const next = page.cursor?.after
    const result: IdbPackedPage<T> = {
      version: 1,
      consistency: 'transaction',
      rows: page.rows,
      examined: page.examined,
      payloadBytes: page.payloadBytes,
      complete: page.done,
      ...(next === undefined
        ? {}
        : {
            cursor: {
              version: 1 as const,
              database: db.name,
              schemaVersion: db.version,
              storageIdentityKey: snapshot.sourceStorage.storageIdentityKey,
              identityKey,
              table,
              after:
                table === 'outputTagMaps' || table === 'txLabelMaps' || table === 'certificateFields'
                  ? [...next]
                  : next[0]
            }
          })
    }
    await snapshot.close()
    return result
  } catch (error_) {
    try {
      await snapshot.close()
    } catch (error__) {
      if (error__ !== error_)
        throw new AggregateError([error_, error__], 'Packed IndexedDB current page and snapshot cleanup failed', {
          cause: error_
        })
    }
    throw error_
  }
}

/** Indexed, finite maintenance. A live lease protects every version needed at
 * its ceiling. Logical charge release does not assert browser disk reclamation. */
export async function collectPackedIdb(
  db: IDBPDatabase<StorageIdbSchema>,
  maximumVersions = 128,
  maximumChunks = 256
): Promise<{ versions: number; chunks: number }> {
  const owner = getPackedIdbConnection(db)
  if (owner === undefined) packedIdbInvalid()
  bounded(maximumVersions, 128, 256)
  bounded(maximumChunks, 256, 256)
  const tx = owner.rawTransaction([], 'readwrite')
  return await drain(tx, async () => {
    const clock = await readPackedIdbClock(tx),
      leases = tx.objectStore(packedIdbStores.leases)
    let expired = await leases.index('expiresAt').openCursor(IDBKeyRange.upperBound(Date.now()))
    for (let count = 0; expired !== null && count < 64; count++) {
      await expired.delete()
      await chargePackedIdb(tx, -1024, -1)
      expired = await expired.continue()
    }
    const oldest = await leases.index('revision').openCursor(),
      floor = oldest === null ? clock.revision : (oldest.value.revision as number)
    if (!Number.isSafeInteger(floor) || floor < 0 || floor > clock.revision) packedIdbInvalid()
    let versions = 0,
      chunks = 0,
      old = await tx.objectStore(packedIdbStores.versions).index('obsoleteAt').openCursor(IDBKeyRange.upperBound(floor))
    while (old !== null && versions < maximumVersions) {
      const value = old.value
      if (typeof value.charge !== 'number' || !Number.isSafeInteger(value.charge) || value.charge < 256)
        packedIdbInvalid()
      const row = value.deleted ? undefined : unpackPackedIdbMetadata(value.value)
      if (value.charge !== packedIdbVersionCharge(row)) packedIdbInvalid()
      verifyPackedIdbReferences(value.references, row ?? { extents: {} })
      if (row !== undefined) await retainPackedIdbFields(tx, row, -1)
      await old.delete()
      await chargePackedIdb(tx, -value.charge, -1)
      versions++
      old = await old.continue()
    }
    // Drop the final physical-delete marker/head only after all older versions
    // are gone and no lease needs a pre-delete view. Reinsertions have a newer
    // head and remain untouched.
    let deleted = await tx
      .objectStore(packedIdbStores.versions)
      .index('deletedAt')
      .openCursor(IDBKeyRange.upperBound(floor))
    let examinedDeletes = 0
    while (deleted !== null && versions < maximumVersions && examinedDeletes++ < 256) {
      const value = deleted.value,
        key = packedIdbKey(value.key),
        store = value.store
      if (
        typeof store !== 'string' ||
        typeof value.revision !== 'number' ||
        value.deleted !== true ||
        value.charge !== 256
      )
        packedIdbInvalid()
      verifyPackedIdbReferences(value.references, { extents: {} })
      const head = await tx.objectStore(packedIdbStores.heads).get([store, key])
      const count = await tx
        .objectStore(packedIdbStores.versions)
        .count(IDBKeyRange.bound([store, key, 0], [store, key, value.revision]))
      if (head?.revision === value.revision && count === 1) {
        await tx.objectStore(packedIdbStores.heads).delete([store, key])
        await deleted.delete()
        await chargePackedIdb(tx, -768, -2)
        versions++
      }
      deleted = await deleted.continue()
    }
    const contentStore = tx.objectStore(packedIdbStores.contents)
    let expiredContent = await contentStore.index('expiresAt').openCursor(IDBKeyRange.upperBound(Date.now()))
    for (let count = 0; expiredContent !== null && count < 64; count++) {
      if (expiredContent.value.refs !== 0) packedIdbInvalid()
      await expiredContent.update({ ...expiredContent.value, retired: 1 })
      expiredContent = await expiredContent.continue()
    }
    const retired = await contentStore.index('retired').openCursor(1)
    if (retired !== null) {
      const content = retired.value
      if (
        content.refs !== 0 ||
        typeof content.id !== 'string' ||
        !['pending', 'sealed', 'retiring'].includes(content.state as string)
      )
        packedIdbInvalid()
      await contentStore.put({ ...content, state: 'retiring' })
      let chunk = await tx.objectStore(packedIdbStores.chunks).index('content').openCursor(content.id)
      while (chunk !== null && chunks < maximumChunks) {
        const value = chunk.value
        if (!(value.data instanceof Uint8Array) || value.data.length > 65536) packedIdbInvalid()
        await chunk.delete()
        await chargePackedIdb(tx, -value.data.length - 256, -1)
        chunks++
        chunk = await chunk.continue()
      }
      if (chunk === null) {
        const reserved = content.received === undefined ? 0 : (content.bytes as number) - (content.received as number)
        if (!Number.isSafeInteger(reserved) || reserved < 0) packedIdbInvalid()
        await contentStore.delete(content.id)
        await chargePackedIdb(tx, -512 - reserved, -1)
      }
    }
    owner.assertOpen()
    await collectPackedIdbJsonIndexes(tx, 128)
    return { versions, chunks }
  })
}
