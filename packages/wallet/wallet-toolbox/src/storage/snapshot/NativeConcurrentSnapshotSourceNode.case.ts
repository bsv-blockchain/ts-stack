import { StorageKnex } from '../StorageKnex'
import { Brc38PublishedProfileNode } from '../portable/Brc38PublishedProfileNode'
import type { WalletStorageManager } from '../WalletStorageManager'
import type { TableSettings, TableUser } from '../schema/tables'
import type {
  WalletReadSnapshot,
  WalletSnapshotTable,
  WalletSnapshotCursor,
  WalletSnapshotFieldDescriptor
} from './WalletReadSnapshot'
import type { SnapshotArchiveSource } from './archive/KnexSnapshotArchiveSource'
import { ownedNativeRootIdentity } from '../schema/ownedNativeSqliteConnectionsNode'
import { snapshotArchiveTables } from './archive/SnapshotArchive'

/** The controller has already authenticated/restored/activated this isolated
 * synthetic DELETE profile. Complete the actual lifecycle, never a phase flag
 * or copied provider, and independently inspect coordinator admission. */
export async function verifyPublishedNativeSnapshotLifecycle(
  profile: Brc38PublishedProfileNode,
  manager: WalletStorageManager,
  expiresAt: number
): Promise<void> {
  const storage = manager.getActive(),
    deadline = performance.now() + expiresAt - Date.now(),
    check = (): void => {
      if (
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Date.now() ||
        expiresAt > Date.now() + 120000 ||
        performance.now() >= deadline ||
        manager.getActive() !== storage ||
        !manager.isActiveEnabled
      )
        throw new Error('Native snapshot lifecycle lost its actual isolated manager or deadline')
    },
    refuse = async (run: () => Promise<unknown>): Promise<void> => {
      let failed = false
      try {
        await run()
      } catch {
        failed = true
      }
      if (!failed) throw new Error('DELETE or copied native profile enabled its snapshot coordinator')
      check()
    }
  check()
  if (!(storage instanceof StorageKnex) || storage.getSnapshotSync() !== undefined)
    throw new Error('Original DELETE native fixture must keep its coordinator disabled')
  await refuse(() => storage.enableOwnedNativeSnapshotSync(profile))
  await profile.promoteNativeWal()
  check()
  await Brc38PublishedProfileNode.assertNativeSnapshotProvider(profile, storage)
  const sync = storage.getSnapshotSync()
  if (
    sync === undefined ||
    !(await sync.supportsDestination()) ||
    sync.supportsFieldDestination === undefined ||
    !(await sync.supportsFieldDestination())
  )
    throw new Error('Complete current native WAL profile omitted original sync/field admission')
  const copied = Object.create(Brc38PublishedProfileNode.prototype) as Brc38PublishedProfileNode
  await refuse(() => storage.enableOwnedNativeSnapshotSync(copied))
  if (storage.getSnapshotSync() === undefined)
    throw new Error('Refused copied actor changed legitimate coordinator policy')
  check()
}

/** Authored, unrun integration case. The finite serial controller supplies an
 * actual active WAL native provider, complete independent profile/table
 * fixtures and the original resource/deadline admission. No process, runtime,
 * native producer, publication or activation is constructed by this case. */
export async function verifyNativeConcurrentSnapshotSource(
  storage: StorageKnex,
  fixture: Readonly<{
    sourceStorage: Readonly<TableSettings>
    user: Readonly<TableUser>
    counts: Readonly<Record<WalletSnapshotTable, number>>
    requestId: number
    originalHistory: string
    changedHistory: string
    syncStateId: number
    originalSyncMap: string
    expiresAt: number
  }>
): Promise<void> {
  const root = storage.knex,
    origin = ownedNativeRootIdentity(root),
    expiresAt = fixture.expiresAt,
    deadline = performance.now() + expiresAt - Date.now(),
    identityKey = fixture.user.identityKey,
    requestId = fixture.requestId,
    syncStateId = fixture.syncStateId,
    originalHistory = new TextEncoder().encode(fixture.originalHistory),
    originalSyncMap = new TextEncoder().encode(fixture.originalSyncMap)
  if (
    origin?.slot !== 0 ||
    Object.keys(fixture.counts).length !== snapshotArchiveTables.length ||
    snapshotArchiveTables.some(
      table =>
        !Object.hasOwn(fixture.counts, table) ||
        !Number.isSafeInteger(fixture.counts[table]) ||
        fixture.counts[table] < 0 ||
        fixture.counts[table] > 1000
    ) ||
    originalHistory.length < 65537 ||
    originalHistory.length > 262144 ||
    originalSyncMap.length < 2 ||
    originalSyncMap.length > 262144 ||
    fixture.originalHistory === fixture.changedHistory ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + 120000
  )
    throw new Error('Independent finite native WAL source fixture required')
  const check = (): void => {
      if (
        Date.now() >= expiresAt ||
        performance.now() >= deadline ||
        storage.knex !== root ||
        ownedNativeRootIdentity(root)?.token !== origin.token
      )
        throw new Error('Native concurrent source case lost its original owner or deadline')
    },
    same = (actual: unknown, expected: unknown): void => {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        const actualRecord = typeof actual === 'object' && actual !== null ? (actual as Record<string, unknown>) : {},
          expectedRecord =
            typeof expected === 'object' && expected !== null ? (expected as Record<string, unknown>) : {},
          actualKeys = Object.keys(actualRecord),
          expectedKeys = Object.keys(expectedRecord),
          differing = [...new Set([...actualKeys, ...expectedKeys])].filter(
            key => JSON.stringify(actualRecord[key]) !== JSON.stringify(expectedRecord[key])
          )
        throw new Error(
          `Independent native retained source oracle differs; keys ${actualKeys.join(',')} / ${expectedKeys.join(',')}; differing fields ${differing.join(',') || '<order-or-scalar>'}`
        )
      }
    },
    refuse = async (run: () => Promise<unknown>): Promise<void> => {
      let rejected = false
      try {
        await run()
      } catch {
        rejected = true
      }
      if (!rejected) throw new Error('Native retained source admitted an occupied or retired lease')
      check()
    }
  let source: WalletReadSnapshot | undefined, archive: SnapshotArchiveSource | undefined
  try {
    check()
    if (!(await storage.supportsSnapshotArchiveSource()) || (await storage.supportsSnapshotArchiveSource(false)))
      throw new Error('Native local source or independent remote negotiation differs')
    const sync = storage.getSnapshotSync()
    if (sync === undefined) throw new Error('Active native provider lacks its local coordinator')
    source = await sync.openSource(identityKey, { lifetimeMs: expiresAt - Date.now() })
    check()
    if (source?.fieldReader === undefined) throw new Error('Actual native concurrent source lacks bounded fields')
    same(source.sourceStorage, fixture.sourceStorage)
    same(source.user, fixture.user)
    const reader = source.fieldReader,
      request = await reader.readMetadataPage('provenTxReqs', undefined, { maxRows: 1, maxBytes: 16384 })
    same(request.rows.length, 1)
    same(request.rows[0].fields.provenTxReqId, requestId)
    same(request.rows[0].fields.history, undefined)
    same(request.rows[0].extents.history, { kind: 'utf8', bytes: originalHistory.length })
    await refuse(() => storage.openSnapshotArchiveSource(identityKey))
    // This actual foreground writer must finish while the source remains open.
    // The retained source must continue returning the old original bytes.
    await storage.updateProvenTxReq(requestId, { history: fixture.changedHistory })
    check()
    const windows = async (
      table: WalletSnapshotTable,
      cursor: WalletSnapshotCursor,
      field: string,
      descriptor: WalletSnapshotFieldDescriptor,
      expected: Uint8Array
    ): Promise<void> => {
      for (const offset of [0, Math.min(65535, expected.length), expected.length]) {
        check()
        const length = Math.min(65536, expected.length - offset),
          actual = await reader.readFieldExtent(table, cursor, field, offset, length, descriptor)
        try {
          if (actual.length !== length || actual.some((value, index) => value !== expected[offset + index]))
            throw new Error('Native retained source changed after the foreground commit')
        } finally {
          actual.fill(0)
        }
      }
    }
    await windows('provenTxReqs', request.rows[0].cursor, 'history', request.rows[0].extents.history, originalHistory)
    await source.close()
    await source.closed
    check()
    await refuse(() => reader.readMetadataPage('provenTxReqs'))
    archive = await storage.openSnapshotArchiveSource(identityKey, { lifetimeMs: expiresAt - Date.now() })
    check()
    if (archive?.fieldReader === undefined) throw new Error('Actual native archive omitted its same-view field source')
    await archive.validateClosure()
    check()
    // Count all thirteen original archive tables, including operational states.
    // Retain only the current bounded page; no table or identifier set accumulates.
    let foundOriginalSyncState = false
    for (const table of snapshotArchiveTables) {
      let cursor: WalletSnapshotCursor | undefined,
        count = 0
      for (;;) {
        check()
        const page = await archive.fieldReader.readMetadataPage(table, cursor, { maxRows: 8, maxBytes: 16384 })
        if (page.payloadBytes > 16384 || page.rows.length > 8)
          throw new Error('Native archive metadata exceeded admission')
        count += page.rows.length
        if (count > fixture.counts[table]) throw new Error('Native archive exposed extra or duplicated profile rows')
        if (table === 'syncStates')
          for (const row of page.rows)
            if ('syncStateId' in row.fields && row.fields.syncStateId === syncStateId) {
              if (foundOriginalSyncState) throw new Error('Native archive duplicated original operational provenance')
              foundOriginalSyncState = true
              const extent = row.extents.syncMap
              same(extent, { kind: 'utf8', bytes: originalSyncMap.length })
              for (let offset = 0; offset < originalSyncMap.length; offset += 16384) {
                check()
                const length = Math.min(16384, originalSyncMap.length - offset),
                  actual = await archive.fieldReader.readFieldExtent(
                    table,
                    row.cursor,
                    'syncMap',
                    offset,
                    length,
                    extent
                  )
                try {
                  if (
                    actual.length !== length ||
                    actual.some((value, index) => value !== originalSyncMap[offset + index])
                  )
                    throw new Error('Archive replaced original operational sync-state provenance')
                } finally {
                  actual.fill(0)
                }
              }
            }
        if (page.done) break
        if (page.cursor === undefined || JSON.stringify(page.cursor) === JSON.stringify(cursor))
          throw new Error('Native archive failed to advance its bounded source cursor')
        cursor = page.cursor
      }
      same(count, fixture.counts[table])
    }
    if (!foundOriginalSyncState) throw new Error('Native archive omitted the original operational sync-state row')
    await archive.close()
    await archive.closed
    check()
    await refuse(() => archive!.fieldReader!.readMetadataPage('syncStates'))
  } finally {
    try {
      await archive?.close()
    } finally {
      try {
        await source?.close()
      } finally {
        originalHistory.fill(0)
        originalSyncMap.fill(0)
      }
    }
  }
}
