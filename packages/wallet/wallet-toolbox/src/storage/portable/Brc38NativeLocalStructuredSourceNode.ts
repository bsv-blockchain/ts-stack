import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { isBrc38OwnedPrivateNativeSqlite, type KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity } from './Brc38PrivateNativeOwnershipNode'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import type { Brc38PrivateCurrentStructuredPolicy } from './Brc38PrivateCurrentStructuredSourceNode'
import type { Brc38StreamedStructured, Brc38JsonMemberIndex } from './Brc38StructuredJson'
import { Brc38NodeJsonIndex } from './Brc38NodeJsonIndex'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { measureBrc38StructuredFilesystem } from './Brc38StructuredFilesystemNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'

function invalid(): never {
  throw new Error('Coherent local structured field differs from its actual source lease or original resource bounds')
}
/** Genuine callback-scoped structured field from the retained local source.
 * It opens the actual source row and field through that actor, independently
 * hashes its complete bytes, and owns finite real grammar indexes. It never
 * wraps final candidate bytes as an original source or invents empty content.
 * The caller must drain other source-row leases before entering this scope. */
export async function withBrc38NativeLocalStructuredSource<T>(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  k: Knex.Transaction,
  selectedRowId: number,
  selectedField: 'history' | 'notify',
  selected: Brc38PrivateCurrentStructuredPolicy,
  work: (
    field: Readonly<Brc38StreamedStructured>,
    descriptor: Readonly<{ bytes: number; sha256: string }>
  ) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<T> {
  const actual = (): void => {
    store.assertPrivateNativeReadTransaction(k)
  }
  actual()
  return await withLocalStructuredActor(
    store,
    source,
    async operation => {
      actual()
      const result = await operation(k)
      actual()
      return result
    },
    actual,
    'proven_tx_reqs',
    selectedRowId,
    selectedField,
    selected,
    work,
    additionalTemporaryFileBytes
  )
}

/** The same coherent original row, with an actual enrolled query-only facade.
 * Each private-stage probe drains its transaction before returning to the
 * consumer. The original source row remains owned until all reads drain; no
 * SQL reader is retained while a consumer writes derived comparison data. */
export async function withBrc38NativeLocalStructuredDatabaseSource<T>(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  database: Knex,
  selectedRowId: number,
  selectedField: 'history' | 'notify',
  selected: Brc38PrivateCurrentStructuredPolicy,
  work: (
    field: Readonly<Brc38StreamedStructured>,
    descriptor: Readonly<{ bytes: number; sha256: string }>
  ) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<T> {
  const root = store.knex,
    origin = privateNativeDatabaseIdentity(root),
    actual = (): void => {
      const current = privateNativeDatabaseIdentity(database)
      if (
        store.knex !== root ||
        origin?.slot !== 0 ||
        privateNativeDatabaseIdentity(root)?.token !== origin.token ||
        current?.slot !== 3 ||
        current.token !== origin.token ||
        !isBrc38OwnedPrivateNativeSqlite(database)
      )
        invalid()
      store.assertPrivateNativeDestination(root)
    }
  actual()
  return await withLocalStructuredActor(
    store,
    source,
    async operation =>
      await database.transaction(async k => {
        actual()
        store.assertPrivateNativeReadTransaction(k)
        const result = await operation(k)
        store.assertPrivateNativeReadTransaction(k)
        actual()
        return result
      }),
    actual,
    'proven_tx_reqs',
    selectedRowId,
    selectedField,
    selected,
    work,
    additionalTemporaryFileBytes
  )
}

/** Independent original operational checkpoint map, with the same actual
 * enrolled short-query facade and full source-row ownership as request fields. */
export async function withBrc38NativeLocalCheckpointDatabaseSource<T>(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  database: Knex,
  selectedRowId: number,
  selected: Brc38PrivateCurrentStructuredPolicy,
  work: (
    field: Readonly<Brc38StreamedStructured>,
    descriptor: Readonly<{ bytes: number; sha256: string }>
  ) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<T> {
  const root = store.knex,
    origin = privateNativeDatabaseIdentity(root),
    actual = (): void => {
      const current = privateNativeDatabaseIdentity(database)
      if (
        store.knex !== root ||
        origin?.slot !== 0 ||
        privateNativeDatabaseIdentity(root)?.token !== origin.token ||
        current?.slot !== 3 ||
        current.token !== origin.token ||
        !isBrc38OwnedPrivateNativeSqlite(database)
      )
        invalid()
      store.assertPrivateNativeDestination(root)
    }
  actual()
  return await withLocalStructuredActor(
    store,
    source,
    async operation =>
      await database.transaction(async k => {
        actual()
        store.assertPrivateNativeReadTransaction(k)
        const result = await operation(k)
        store.assertPrivateNativeReadTransaction(k)
        actual()
        return result
      }),
    actual,
    'sync_states',
    selectedRowId,
    'syncMap',
    selected,
    work,
    additionalTemporaryFileBytes
  )
}

async function withLocalStructuredActor<T>(
  store: KnexBrc38StagingStore,
  source: Brc38NativeLocalBaselineSource,
  withRead: <V>(operation: (k: Knex.Transaction) => Promise<V>) => Promise<V>,
  actualProducer: () => void,
  selectedTable: 'proven_tx_reqs' | 'sync_states',
  selectedRowId: number,
  selectedField: 'history' | 'notify' | 'syncMap',
  selected: Brc38PrivateCurrentStructuredPolicy,
  work: (
    field: Readonly<Brc38StreamedStructured>,
    descriptor: Readonly<{ bytes: number; sha256: string }>
  ) => Promise<T>,
  additionalTemporaryFileBytes: number
): Promise<T> {
  const policy = brc38PrivateStructuredPolicy(selected, store.directory),
    working = policy.workingAllocation,
    table = selectedTable,
    rowId = selectedRowId,
    field = selectedField,
    binding = store.binding,
    expiresAt = selected.expiresAt,
    extra = additionalTemporaryFileBytes,
    combined = selected.maximumCombinedTemporaryBytes,
    deadline = performance.now() + Math.max(0, expiresAt - Date.now()),
    width = policy.maximumReadBytes ?? 65536,
    maximumOpen = policy.maximumOpenIndexes ?? 1,
    indexMaximum = Math.floor(policy.maximumTemporaryIndexBytes / maximumOpen)
  if (
    working === undefined ||
    binding === undefined ||
    working.maximum > store.limits.maximumRowAllocationBytes ||
    !Number.isSafeInteger(rowId) ||
    !(
      (table === 'proven_tx_reqs' && ['history', 'notify'].includes(field)) ||
      (table === 'sync_states' && field === 'syncMap')
    ) ||
    expiresAt !== store.limits.expiresAt ||
    !Number.isSafeInteger(extra) ||
    extra < 0 ||
    !Number.isSafeInteger(combined) ||
    combined < 1048576 ||
    combined > store.limits.maximumPhysicalBytes ||
    extra > combined - policy.maximumTemporaryIndexBytes
  )
    invalid()
  let live = true
  const check = (): void => {
      policy.signal?.throwIfAborted()
      if (!live || store.binding !== binding || Date.now() >= expiresAt || performance.now() >= deadline) invalid()
      actualProducer()
      Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
      const fence = source.fence
      if (
        fence.mode !== 'merge' ||
        fence.identityKey !== binding.binding.identityKey ||
        fence.chain !== binding.binding.chain ||
        fence.targetStorageIdentityKey !== binding.binding.targetStorageIdentityKey ||
        fence.userId === null
      )
        invalid()
    },
    probe = async (): Promise<void> => {
      check()
      await withRead(async k => {
        check()
        await verifyBrc38AuthenticatedSourceSeal(k)
        check()
      })
      await measureBrc38StructuredFilesystem(
        store.directory,
        ['stage.sqlite', 'stage.sqlite-journal', 'brc38-owner.sqlite', 'brc38-owner.sqlite-journal'],
        store.limits.maximumPhysicalBytes,
        policy.maximumTemporaryIndexBytes + extra,
        policy.signal
      )
      check()
    }
  check()
  const frame = working.claim(65536)
  try {
    return await Brc38NativeLocalBaselineSource.withOwnedRow(source, table, rowId, async row => {
      check()
      const original = row.fields.find(value => value.field === field)
      if (
        original?.kind !== 'text' ||
        original.bytes === null ||
        original.bytes < 2 ||
        original.bytes > policy.maximumStructuredBytes
      )
        invalid()
      const bytes = original.bytes,
        sourceWidth = Math.min(width, Brc38NativeLocalBaselineSource.maximumReadBytes(source)),
        hash = createHash('sha256'),
        indexes = new Set<Brc38NodeJsonIndex>(),
        retained = new Set<Brc38StagingCleanupError>(),
        io = new Brc38OwnedImportReads()
      for (let offset = 0; offset < bytes;) {
        await probe()
        const length = Math.min(sourceWidth, bytes - offset)
        await row.withFieldExtent(field, offset, length, async value => {
          check()
          if (value.length !== length) invalid()
          hash.update(value)
        })
        offset += length
      }
      const descriptor = Object.freeze({ bytes, sha256: hash.digest('hex') })
      let issued = false
      const actor: Readonly<Brc38StreamedStructured> = Object.freeze({
        encoding: 'utf8',
        length: bytes,
        sha256: descriptor.sha256,
        read: (offset: number, length: number) =>
          io.run(async () => {
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(length) ||
              length < 1 ||
              length > width ||
              offset > bytes - length
            )
              invalid()
            await probe()
            const charge = working.claim(1048576 + 64 * length)
            let output: Uint8Array | undefined
            try {
              output = new Uint8Array(length)
              for (let used = 0; used < length;) {
                const amount = Math.min(sourceWidth, length - used),
                  start = used
                await row.withFieldExtent(field, offset + used, amount, async value => {
                  check()
                  if (value.length !== amount) invalid()
                  output!.set(value, start)
                })
                used += amount
              }
              await probe()
              return output
            } catch (cause) {
              output?.fill(0)
              throw cause
            } finally {
              charge.close()
            }
          }),
        openIndex: () =>
          io.run(async () => {
            await probe()
            if ((maximumOpen === 1 && issued) || indexes.size >= maximumOpen) invalid()
            issued = true
            let index: Brc38NodeJsonIndex
            try {
              index = await Brc38NodeJsonIndex.open({
                privateParent: policy.privateIndexParent,
                sourceBytes: bytes,
                maximumTemporaryFileBytes: indexMaximum,
                maximumTemporaryPhysicalBytes: indexMaximum,
                maximumMembers: policy.maximumIndexMembers,
                maximumAllocationBytes: policy.maximumIndexAllocationBytes,
                workingAllocation: working,
                expiresAt,
                signal: policy.signal
              })
            } catch (cause) {
              if (cause instanceof Brc38StagingCleanupError) retained.add(cause)
              throw cause
            }
            indexes.add(index)
            await probe()
            return Object.freeze({
              put: (object, member) =>
                io.run(async () => {
                  await probe()
                  await index.put(object, member)
                  await probe()
                }),
              seal: () =>
                io.run(async () => {
                  await probe()
                  await index.seal()
                  await probe()
                }),
              lookup: (object, key) =>
                io.run(async () => {
                  await probe()
                  const value = await index.lookup(object, key)
                  await probe()
                  return value
                }),
              entries: async function* (object) {
                const iterator = index.entries(object)
                try {
                  for (;;) {
                    const value = await io.run(async () => {
                      await probe()
                      const value = await iterator.next()
                      await probe()
                      return value
                    })
                    if (value.done) return
                    yield value.value
                  }
                } finally {
                  await iterator.return(undefined)
                }
              },
              close: async () => {
                await index.close()
                indexes.delete(index)
              }
            } satisfies Brc38JsonMemberIndex)
          })
      })
      const cleanup = async (): Promise<void> => {
        const failures: unknown[] = []
        for (const index of indexes)
          try {
            await index.close()
            indexes.delete(index)
          } catch (cause) {
            failures.push(cause)
          }
        for (const failure of retained)
          try {
            await failure.retryCleanup()
            retained.delete(failure)
          } catch (cause) {
            failures.push(cause)
          }
        if (failures.length !== 0)
          throw new Brc38StagingCleanupError(
            failures,
            'Local structured source retains actual grammar-index cleanup',
            cleanup
          )
      }
      let result!: T,
        failed = false,
        failure: unknown
      try {
        result = await io.retain(async () => await work(actor, descriptor))
        // finish closes admission and drains an unawaited queued read before
        // the final actual SQL/filesystem probe uses this same read facade.
        await probe()
      } catch (cause) {
        failed = true
        failure = cause
      }
      try {
        await cleanup()
      } catch (cause) {
        throw new Brc38StagingCleanupError(
          failed ? [failure, cause] : [cause],
          'Local structured source and cleanup failed',
          cleanup
        )
      }
      if (failed) throw failure
      return result
    })
  } finally {
    live = false
    frame.close()
  }
}
