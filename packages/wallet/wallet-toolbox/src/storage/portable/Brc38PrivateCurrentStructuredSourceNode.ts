import { brc38WorkingAllocation } from './Brc38WorkingAllocation'
import { Brc38NativeLocalBaselineSource } from './Brc38NativeLocalBaselineSourceNode'
import { withBrc38NativeLocalCheckpointDatabaseSource } from './Brc38NativeLocalStructuredSourceNode'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { isBrc38OwnedPrivateNativeSqlite, type KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { privateNativeDatabaseIdentity, privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
import {
  readBrc38NativePackedTextDescriptorData,
  readBrc38NativePackedTextExtentData,
  readBrc38NativePackedTextVersionDescriptorData,
  readBrc38NativePackedTextVersionExtentData
} from './Brc38NativePackedTextFieldsNode'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { Brc38NodeJsonIndex } from './Brc38NodeJsonIndex'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { brc38PrivateStructuredPolicy, type Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import { measureBrc38StructuredFilesystem } from './Brc38StructuredFilesystemNode'
import type { Brc38JsonMemberIndex, Brc38StreamedStructured } from './Brc38StructuredJson'
import type { Brc38NativeTextRead } from './Brc38NativeBlobProtocol'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'
import {
  checkpointBrc38SyncMap,
  type Brc38CheckpointSyncMapDelta,
  type Brc38CheckpointSyncMapDeltas
} from './Brc38CheckpointSyncMap'

export interface Brc38PrivateCurrentStructuredPolicy extends Brc38PrivateStructuredPolicy {
  readonly expiresAt: number
  readonly maximumCombinedTemporaryBytes: number
}
type Coordinate = Pick<Brc38NativeTextRead, 'table' | 'field' | 'rowId'>
type StructuredCoordinate = Coordinate | Readonly<{ version: Readonly<{ bytes: number; sha256: string }> }>
function invalid(): never {
  throw new Error('Private current structured source differs from its actual retained owner/view/content')
}
/** Actual same-owner read-only packed CURRENT field, distinct from archived
 * original raw fields. This factory never invents a WalletReadSnapshot or
 * treats a row coordinate/hash as source admission. It supplies bounded reads
 * and one genuine finite grammar index only within this retained callback. */
export async function withBrc38PrivateCurrentStructuredSource<T>(
  storage: StorageKnex,
  trx: Knex.Transaction,
  input: Coordinate,
  selected: Brc38PrivateCurrentStructuredPolicy,
  work: (
    source: Readonly<Brc38StreamedStructured>,
    descriptor: Readonly<{ bytes: number; sha256: string }>
  ) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<T> {
  const actual = (): void => {
    const identity = privateNativeTransactionIdentity(trx)
    if (
      identity?.slot !== 3 ||
      !isBrc38OwnedPrivateNativeSqlite(trx) ||
      identity.token !== privateNativeDatabaseIdentity(storage.toDb())?.token
    )
      invalid()
  }
  actual()
  return await withCurrentStructuredActor(
    storage,
    async operation => {
      actual()
      const result = await operation(trx)
      actual()
      return result
    },
    actual,
    input,
    selected,
    work,
    additionalTemporaryFileBytes
  )
}

/** Actual private producer with a drained query-only transaction per operation.
 * The source is one immutable current version: native range reads, index
 * issuance and final callback completion freshly compare the same row pointer, exact source seal and native schema.
 * It holds no SQL read transaction while its consumer stages derived bytes.
 * The final row/journal writer must still compare current metadata and pointers. */
export async function withBrc38PrivateCurrentStructuredActor<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  input: Coordinate,
  selected: Brc38PrivateCurrentStructuredPolicy,
  work: (
    source: Readonly<Brc38StreamedStructured>,
    descriptor: Readonly<{ bytes: number; sha256: string }>
  ) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<T> {
  const root = storage.toDb(),
    origin = privateNativeDatabaseIdentity(root),
    actual = (): void => {
      if (
        root !== store.knex ||
        storage.toDb() !== root ||
        origin?.slot !== 0 ||
        privateNativeDatabaseIdentity(root)?.token !== origin.token
      )
        invalid()
      store.assertPrivateNativeDestination(root)
    }
  actual()
  return await store.withPrivateNativeDatabase(
    true,
    async database =>
      await withBrc38PrivateCurrentStructuredDatabaseSource(
        store,
        storage,
        database,
        input,
        selected,
        work,
        additionalTemporaryFileBytes
      )
  )
}

/** Share one actual enrolled query-only facade with an original-field actor.
 * Each operation still starts and drains its own transaction; this does not
 * accept an arbitrary read callback or return a persistent source lease. */
export async function withBrc38PrivateCurrentStructuredDatabaseSource<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  database: Knex,
  input: StructuredCoordinate,
  selected: Brc38PrivateCurrentStructuredPolicy,
  work: (
    source: Readonly<Brc38StreamedStructured>,
    descriptor: Readonly<{ bytes: number; sha256: string }>
  ) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<T> {
  const root = storage.toDb(),
    origin = privateNativeDatabaseIdentity(root),
    actual = (): void => {
      if (
        root !== store.knex ||
        storage.toDb() !== root ||
        origin?.slot !== 0 ||
        privateNativeDatabaseIdentity(root)?.token !== origin.token ||
        privateNativeDatabaseIdentity(database)?.slot !== 3 ||
        privateNativeDatabaseIdentity(database)?.token !== origin.token ||
        !isBrc38OwnedPrivateNativeSqlite(database)
      )
        invalid()
      store.assertPrivateNativeDestination(root)
    }
  actual()
  return await withCurrentStructuredActor(
    storage,
    async operation =>
      await database.transaction(async trx => {
        actual()
        store.assertPrivateNativeReadTransaction(trx)
        const result = await operation(trx)
        store.assertPrivateNativeReadTransaction(trx)
        actual()
        return result
      }),
    actual,
    input,
    selected,
    work,
    additionalTemporaryFileBytes
  )
}

async function withCurrentStructuredActor<T>(
  storage: StorageKnex,
  withRead: <V>(operation: (trx: Knex.Transaction) => Promise<V>) => Promise<V>,
  actualProducer: () => void,
  input: StructuredCoordinate,
  selected: Brc38PrivateCurrentStructuredPolicy,
  work: (
    source: Readonly<Brc38StreamedStructured>,
    descriptor: Readonly<{ bytes: number; sha256: string }>
  ) => Promise<T>,
  additionalTemporaryFileBytes: number
): Promise<T> {
  const root = storage.toDb(),
    original = privateNativeDatabaseIdentity(root),
    coordinate =
      'version' in input
        ? Object.freeze({ version: Object.freeze({ bytes: input.version.bytes, sha256: input.version.sha256 }) })
        : Object.freeze({ table: input.table, field: input.field, rowId: input.rowId }),
    policy = brc38PrivateStructuredPolicy(selected),
    expiresAt = selected.expiresAt,
    combined = selected.maximumCombinedTemporaryBytes,
    extra = additionalTemporaryFileBytes,
    began = performance.now(),
    lifetime = expiresAt - Date.now(),
    owned = new Brc38OwnedImportReads(),
    indexes = new Set<Brc38NodeJsonIndex>(),
    retained = new Set<Brc38StagingCleanupError>()
  const actor = (): void => {
    policy.signal?.throwIfAborted()
    actualProducer()
    const current = privateNativeDatabaseIdentity(storage.toDb())
    if (
      storage.toDb() !== root ||
      original?.slot !== 0 ||
      current?.token !== original.token ||
      !isBrc38OwnedPrivateNativeSqlite(root)
    )
      invalid()
    if (Date.now() >= expiresAt || performance.now() - began >= lifetime)
      throw new SnapshotResourceLimitError('Private current structured field reached its original deadline')
  }
  actor()
  if (
    'version' in coordinate
      ? !Number.isSafeInteger(coordinate.version.bytes) ||
        coordinate.version.bytes < 2 ||
        coordinate.version.bytes > policy.maximumStructuredBytes ||
        !/^[0-9a-f]{64}$/.test(coordinate.version.sha256)
      : !Number.isSafeInteger(coordinate.rowId) ||
        (coordinate.table !== 'syncStates' && coordinate.rowId < 1) ||
        !(
          (coordinate.table === 'provenTxReqs' && ['history', 'notify'].includes(coordinate.field)) ||
          (coordinate.table === 'syncStates' && ['syncMap', 'errorLocal', 'errorOther'].includes(coordinate.field))
        )
  )
    invalid()
  if (
    !Number.isSafeInteger(expiresAt) ||
    lifetime < 1 ||
    lifetime > 3600000 ||
    !Number.isSafeInteger(combined) ||
    combined < 1048576 ||
    combined > 17179869184 ||
    !Number.isSafeInteger(extra) ||
    extra < 0 ||
    extra > combined ||
    policy.maximumTemporaryIndexBytes > combined - extra
  )
    throw new RangeError('Invalid private current structured source coordinates or finite policy')
  const databases: Array<{ name: string; file: string }> = await withRead(
      async trx => await trx.raw('PRAGMA database_list')
    ),
    main = databases.filter(value => value.name === 'main')
  if (
    main.length !== 1 ||
    typeof main[0].file !== 'string' ||
    Buffer.byteLength(main[0].file) > 4096 ||
    !isAbsolute(main[0].file) ||
    resolve(main[0].file) !== main[0].file ||
    basename(main[0].file) !== 'stage.sqlite'
  )
    invalid()
  const directory = dirname(main[0].file)
  brc38PrivateStructuredPolicy(policy, directory)
  let bindingDigest: string | undefined, physicalMaximumBytes: number | undefined
  const currentRead = async (
    trx: Knex.Transaction,
    expected?: Readonly<{ bytes: number; sha256: string }>
  ): Promise<Readonly<{ bytes: number; sha256: string }>> => {
    actor()
    const identity = privateNativeTransactionIdentity(trx)
    if (identity?.slot !== 3 || identity.token !== original?.token || !isBrc38OwnedPrivateNativeSqlite(trx)) invalid()
    await verifyBrc38AuthenticatedSourceSeal(trx)
    if (!(await hasBrc38NativePackedTextSchema(trx))) invalid()
    const binding = (await trx('private_binding')
      .where({ slot: 1 })
      .first(
        trx.raw("CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 THEN digest END AS digest"),
        trx.raw(
          "CASE WHEN typeof(limitsJson)='text' AND length(CAST(limitsJson AS BLOB))<=256 THEN limitsJson END AS limitsJson"
        )
      )) as { digest: string; limitsJson: string } | undefined
    if (
      typeof binding?.limitsJson !== 'string' ||
      !/^[0-9a-f]{64}$/.test(binding.digest) ||
      (bindingDigest !== undefined && bindingDigest !== binding.digest)
    )
      invalid()
    const limits: unknown = JSON.parse(binding.limitsJson)
    if (
      !Array.isArray(limits) ||
      limits.length !== 6 ||
      limits.some((value: unknown) => typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    )
      invalid()
    const maximumPhysicalBytes: unknown = limits[2],
      originalExpiry: unknown = limits[5]
    if (
      typeof maximumPhysicalBytes !== 'number' ||
      typeof originalExpiry !== 'number' ||
      expiresAt > originalExpiry ||
      combined > maximumPhysicalBytes
    )
      invalid()
    const value =
      'version' in coordinate
        ? await readBrc38NativePackedTextVersionDescriptorData(trx, coordinate.version.sha256)
        : await readBrc38NativePackedTextDescriptorData(trx, coordinate)
    if (
      value === undefined ||
      value.bytes < 2 ||
      value.bytes > policy.maximumStructuredBytes ||
      ('version' in coordinate &&
        (value.bytes !== coordinate.version.bytes || value.sha256 !== coordinate.version.sha256)) ||
      (expected !== undefined && (value.bytes !== expected.bytes || value.sha256 !== expected.sha256))
    )
      invalid()
    await measureBrc38StructuredFilesystem(
      directory,
      ['stage.sqlite', 'stage.sqlite-journal', 'brc38-owner.sqlite', 'brc38-owner.sqlite-journal'],
      maximumPhysicalBytes,
      policy.maximumTemporaryIndexBytes + extra,
      policy.signal
    )
    bindingDigest = binding.digest
    physicalMaximumBytes = maximumPhysicalBytes
    actor()
    if (privateNativeTransactionIdentity(trx)?.token !== original.token || !isBrc38OwnedPrivateNativeSqlite(trx))
      invalid()
    return value
  }
  const current = async (expected?: Readonly<{ bytes: number; sha256: string }>) =>
    await withRead(async trx => await currentRead(trx, expected))
  const initial = await current(),
    expected = Object.freeze({ bytes: initial.bytes, sha256: initial.sha256 })
  // Resource DATA from the original complete admission, not a schema verdict
  // or source grant. Temporary index I/O reads no native bytes; it retains
  // actual actor/lifetime and complete physical checks at both boundaries.
  const checkIndexOperation = async (): Promise<void> => {
    actor()
    if (physicalMaximumBytes === undefined) invalid()
    await measureBrc38StructuredFilesystem(
      directory,
      ['stage.sqlite', 'stage.sqlite-journal', 'brc38-owner.sqlite', 'brc38-owner.sqlite-journal'],
      physicalMaximumBytes,
      policy.maximumTemporaryIndexBytes + extra,
      policy.signal
    )
    actor()
  }
  let issued = false
  const maximumOpenIndexes = policy.maximumOpenIndexes ?? 1,
    maximumIndexBytes = Math.floor(policy.maximumTemporaryIndexBytes / maximumOpenIndexes)
  const source: Readonly<Brc38StreamedStructured> = Object.freeze({
    encoding: 'utf8',
    length: expected.bytes,
    sha256: expected.sha256,
    read: (offset: number, length: number) =>
      owned.run(async () => {
        if (
          !Number.isSafeInteger(offset) ||
          offset < 0 ||
          !Number.isSafeInteger(length) ||
          length < 1 ||
          length > Math.min(65536, policy.maximumReadBytes ?? 65536) ||
          offset + length > expected.bytes
        )
          throw new RangeError('Private current structured read exceeds its bounded actual field')
        const reservation = policy.workingAllocation?.claim(4096 + 16 * length)
        let bytes: Uint8Array | undefined
        try {
          await withRead(async trx => {
            await currentRead(trx, expected)
            bytes =
              'version' in coordinate
                ? await readBrc38NativePackedTextVersionExtentData(
                    trx,
                    { sha256: expected.sha256, offset, length, totalBytes: expected.bytes },
                    policy.signal
                  )
                : await readBrc38NativePackedTextExtentData(
                    trx,
                    { ...coordinate, offset, length, totalBytes: expected.bytes },
                    policy.signal
                  )
            if (bytes.length !== length) invalid()
            await currentRead(trx, expected)
          })
          if (bytes === undefined) invalid()
          return bytes
        } catch (cause) {
          bytes?.fill(0)
          throw cause
        } finally {
          reservation?.close()
        }
      }),
    openIndex: () =>
      owned.run(async () => {
        if (maximumOpenIndexes === 1 && issued)
          throw new Error('Private current field grammar index was already issued')
        if (indexes.size >= maximumOpenIndexes)
          throw new Error('Private current field grammar index allowance is already owned')
        issued = true
        await current(expected)
        let actual: Brc38NodeJsonIndex
        try {
          actual = await Brc38NodeJsonIndex.open({
            privateParent: policy.privateIndexParent,
            sourceBytes: expected.bytes,
            maximumTemporaryFileBytes: maximumIndexBytes,
            maximumTemporaryPhysicalBytes: maximumIndexBytes,
            maximumMembers: policy.maximumIndexMembers,
            maximumAllocationBytes: policy.maximumIndexAllocationBytes,
            workingAllocation: policy.workingAllocation,
            expiresAt,
            signal: policy.signal
          })
        } catch (cause) {
          if (cause instanceof Brc38StagingCleanupError) retained.add(cause)
          throw cause
        }
        indexes.add(actual)
        await current(expected)
        return Object.freeze({
          put: (object, member) =>
            owned.run(async () => {
              await checkIndexOperation()
              await actual.put(object, member)
              await checkIndexOperation()
            }),
          seal: () =>
            owned.run(async () => {
              await checkIndexOperation()
              await actual.seal()
              await checkIndexOperation()
            }),
          lookup: (object, key) =>
            owned.run(async () => {
              await checkIndexOperation()
              const value = await actual.lookup(object, key)
              await checkIndexOperation()
              return value
            }),
          entries: async function* (object) {
            const iterator = actual.entries(object)
            try {
              for (;;) {
                const value = await owned.run(async () => {
                  await checkIndexOperation()
                  const value = await iterator.next()
                  await checkIndexOperation()
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
            await actual.close()
            indexes.delete(actual)
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
        'Private current structured source retains actual grammar-index cleanup',
        cleanup
      )
  }
  let result!: T,
    failed = false,
    originalFailure: unknown
  try {
    result = await owned.retain(async () => {
      const value = await work(source, expected)
      await current(expected)
      return value
    })
  } catch (cause) {
    failed = true
    originalFailure = cause
  }
  try {
    await cleanup()
  } catch (cause) {
    throw new Brc38StagingCleanupError(
      failed ? [originalFailure, cause] : [cause],
      'Private current structured callback retains concrete cleanup',
      cleanup
    )
  }
  if (failed) throw originalFailure
  return result
}

/** Current packed checkpoint preparation only. The consumer writes provisional
 * output to separate owned scratch, never this retained database's row writer.
 * It must drain the complete codec before its result can leave the callback.
 * The final journal writer still rechecks the current pointer and actual IDs;
 * neither this prior descriptor nor the maximum timestamp grants admission. */
export async function withBrc38PrivateCurrentCheckpointDelta<T>(
  storage: StorageKnex,
  trx: Knex.Transaction,
  syncStateId: number,
  policy: Brc38PrivateCurrentStructuredPolicy,
  delta: Brc38CheckpointSyncMapDelta,
  work: (chunks: AsyncIterable<Uint8Array>, prior: Readonly<{ bytes: number; sha256: string }>) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<
  Readonly<{
    value: T
    prior: Readonly<{ bytes: number; sha256: string }>
    maximumUpdatedAt?: string
  }>
> {
  return await withCheckpointDelta(
    policy,
    delta,
    work,
    async operation =>
      await withBrc38PrivateCurrentStructuredSource(
        storage,
        trx,
        { table: 'syncStates', field: 'syncMap', rowId: syncStateId },
        policy,
        operation,
        additionalTemporaryFileBytes
      )
  )
}

/** Same complete codec on the actual drained current actor. Derived staging
 * may use short writers between completed reads because the original current
 * version/pointer stays immutable until the final atomic checkpoint effect. */
export async function withBrc38PrivateCurrentCheckpointActor<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  syncStateId: number,
  policy: Brc38PrivateCurrentStructuredPolicy,
  delta: Brc38CheckpointSyncMapDeltas,
  work: (chunks: AsyncIterable<Uint8Array>, prior: Readonly<{ bytes: number; sha256: string }>) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<CheckpointDeltaResult<T>> {
  return await withCheckpointDelta(
    policy,
    delta,
    work,
    async operation =>
      await withBrc38PrivateCurrentStructuredActor(
        store,
        storage,
        { table: 'syncStates', field: 'syncMap', rowId: syncStateId },
        policy,
        operation,
        additionalTemporaryFileBytes
      )
  )
}
/** Complete postimage codec starting from the genuine original map or a
 * freshly opened previously reconstructed SEALED version. It never treats the
 * candidate row as the expected checkpoint. The caller's receipt/clock fence
 * surrounds each producer operation; actual source and version leases remain
 * checked at every read by the concrete factories. */
export async function withBrc38PrivateReconstructedCheckpointDatabaseDelta<T>(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  database: Knex,
  source: Brc38NativeLocalBaselineSource,
  current: Readonly<{ localRowId: number }> | Readonly<{ version: Readonly<{ bytes: number; sha256: string }> }>,
  policy: Brc38PrivateCurrentStructuredPolicy,
  delta: Brc38CheckpointSyncMapDeltas,
  work: (chunks: AsyncIterable<Uint8Array>, prior: Readonly<{ bytes: number; sha256: string }>) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<CheckpointDeltaResult<T>> {
  const selected:
      Readonly<{ localRowId: number }> | Readonly<{ version: Readonly<{ bytes: number; sha256: string }> }> =
      Object.freeze(
        'localRowId' in current
          ? { localRowId: current.localRowId }
          : { version: Object.freeze({ bytes: current.version.bytes, sha256: current.version.sha256 }) }
      ),
    effectivePolicy =
      'localRowId' in selected
        ? policy
        : { ...policy, maximumStructuredBytes: Math.max(policy.maximumStructuredBytes, policy.maximumCanonicalBytes) }
  const working = brc38WorkingAllocation(policy.workingAllocation)
  if (working === undefined) invalid()
  Brc38NativeLocalBaselineSource.assertSharedWorking(source, working)
  return await withCheckpointDelta(effectivePolicy, delta, work, async operation =>
    'localRowId' in selected
      ? await withBrc38NativeLocalCheckpointDatabaseSource(
          store,
          source,
          database,
          selected.localRowId,
          effectivePolicy,
          operation,
          additionalTemporaryFileBytes
        )
      : await withBrc38PrivateCurrentStructuredDatabaseSource(
          store,
          storage,
          database,
          { version: selected.version },
          effectivePolicy,
          operation,
          additionalTemporaryFileBytes
        )
  )
}
type CheckpointDeltaResult<T> = Readonly<{
  value: T
  prior: Readonly<{ bytes: number; sha256: string }>
  maximumUpdatedAt?: string
}>
async function withCheckpointDelta<T>(
  policy: Brc38PrivateCurrentStructuredPolicy,
  delta: Brc38CheckpointSyncMapDeltas,
  work: (chunks: AsyncIterable<Uint8Array>, prior: Readonly<{ bytes: number; sha256: string }>) => Promise<T>,
  withSource: (
    operation: (
      source: Readonly<Brc38StreamedStructured>,
      prior: Readonly<{ bytes: number; sha256: string }>
    ) => Promise<CheckpointDeltaResult<T>>
  ) => Promise<CheckpointDeltaResult<T>>
): Promise<CheckpointDeltaResult<T>> {
  const selectedPolicy = Object.freeze({
    ...brc38PrivateStructuredPolicy(policy),
    expiresAt: policy.expiresAt,
    maximumCombinedTemporaryBytes: policy.maximumCombinedTemporaryBytes
  })
  const deltas: readonly Brc38CheckpointSyncMapDelta[] = Array.isArray(delta)
    ? delta
    : [delta as Brc38CheckpointSyncMapDelta]
  if (deltas.length < 1 || deltas.length > 128) invalid()
  let mappings = 0
  for (const page of deltas) {
    if (!Array.isArray(page.mappings) || page.mappings.length > 4000) invalid()
    mappings += page.mappings.length
    if (mappings > 4000) invalid()
  }
  const captureCharge = selectedPolicy.workingAllocation?.claim(8192 + 1024 * mappings + 1024 * (deltas.length - 1))
  try {
    const selectedDelta = Object.freeze(
      deltas.map(page =>
        Object.freeze({
          entity: page.entity,
          count: page.count,
          done: page.done,
          maximumUpdatedAt: page.maximumUpdatedAt === undefined ? undefined : new Date(page.maximumUpdatedAt.getTime()),
          mappings: Object.freeze(
            page.mappings.map(value => Object.freeze({ incomingId: value.incomingId, localId: value.localId }))
          )
        })
      )
    )
    return await withSource(async (source, prior) => {
      const output = new Brc38OwnedImportReads(),
        iterator = checkpointBrc38SyncMap(
          source,
          {
            maximumInputBytes: selectedPolicy.maximumStructuredBytes,
            maximumOutputBytes: selectedPolicy.maximumCanonicalBytes,
            maximumChunkBytes: selectedPolicy.maximumReadBytes ?? 65536,
            maximumAllocationBytes: selectedPolicy.maximumGrammarAllocationBytes,
            workingAllocation: selectedPolicy.workingAllocation,
            maximumDateCodeUnits: 8192,
            signal: selectedPolicy.signal
          },
          selectedDelta
        )
      let finished = false,
        maximumUpdatedAt: string | undefined,
        issued = false
      const chunks: AsyncIterable<Uint8Array> = Object.freeze({
        [Symbol.asyncIterator]: async function* () {
          if (issued) throw new Error('Private current checkpoint stream was already issued')
          issued = true
          try {
            for (;;) {
              const next = await output.run(async () => await iterator.next())
              if (next.done) {
                finished = true
                maximumUpdatedAt = next.value.maximumUpdatedAt
                return
              }
              yield next.value
            }
          } finally {
            await iterator.return(Object.freeze({}))
          }
        }
      })
      let value!: T
      try {
        value = await output.retain(async () => await work(chunks, prior))
        if (!finished) throw new Error('Private current checkpoint output must reach authenticated EOF before use')
      } finally {
        await iterator.return(Object.freeze({}))
      }
      return Object.freeze({ value, prior, ...(maximumUpdatedAt === undefined ? {} : { maximumUpdatedAt }) })
    })
  } finally {
    captureCharge?.close()
  }
}
