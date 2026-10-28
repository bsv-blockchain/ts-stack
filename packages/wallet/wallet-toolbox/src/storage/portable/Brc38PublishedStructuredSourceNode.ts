import { measureBrc38StructuredFilesystem } from './Brc38StructuredFilesystemNode'
import type { Knex } from 'knex'
import { dirname, isAbsolute, resolve } from 'node:path'
import { Brc38OwnedImportReads } from './Brc38OwnedImportReads'
import { Brc38NodeJsonIndex } from './Brc38NodeJsonIndex'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { brc38PrivateStructuredPolicy, type Brc38PrivateStructuredPolicy } from './Brc38PrivateStructuredPolicy'
import { isBrc38OwnedPrivateNativeSqlite } from './KnexBrc38StagingStore'
import { privateNativeTransactionIdentity } from './Brc38PrivateNativeOwnershipNode'
import {
  isBrc38PublishedCopyInspection,
  requireBrc38PublishedCopyInspection,
  requireBrc38NativeProfileTransaction,
  isBrc38OwnedPublishedNativeSqlite
} from './Brc38PublishedProfileNode'
import { verifyBrc38AuthenticatedSourceSeal } from './Brc38AuthenticatedSourceSealNode'
import { brc38JsonStructuredField, type Brc38JsonStructuredField } from './Brc38JsonStructuredFields'
import { readBrc38SqlStructuredDescriptors, readBrc38SqlStructuredRange } from './Brc38SqlStructuredStaging'
import type { Brc38StageTable } from './Brc38SemanticStage'
import type { Brc38JsonMemberIndex, Brc38StreamedStructured } from './Brc38StructuredJson'
import { SnapshotResourceLimitError } from '../snapshot/SnapshotResourceLimitError'

/** Current actor check only; it grants no source/schema/semantic verdict. A
 * permanent profile or copied inspection never acquires a private writer. */
export function requireBrc38StructuredProjectionRead(k: Knex.Transaction): void {
  if (isBrc38OwnedPrivateNativeSqlite(k) && privateNativeTransactionIdentity(k)?.slot === 3) return
  if (isBrc38PublishedCopyInspection(k)) {
    requireBrc38PublishedCopyInspection(k)
    return
  }
  if (!isBrc38OwnedPublishedNativeSqlite(k))
    throw new Error(
      'Structured projection requires the actual private read-only destination view or published inspection'
    )
  requireBrc38NativeProfileTransaction(k)
  const driver = require('./NativeProfileSqlite.cjs') as {
    nativeTransactionIdentity: (trx: Knex.Transaction) => { slot: number } | undefined
  }
  if (driver.nativeTransactionIdentity(k)?.slot !== 3)
    throw new Error(
      'Structured projection requires the actual private read-only destination view or published inspection'
    )
}
export interface Brc38PublishedStructuredSourcePolicy extends Brc38PrivateStructuredPolicy {
  /** New finite inspection lifetime, never renewal of the original import.
   * RECEIVING copies independently retain the original factory deadline. */
  readonly expiresAt: number
  /** Combined physical scratch reservation for this grammar index and separately
   * admitted projection indexes; filesystem overhead remains separate. */
  readonly maximumCombinedTemporaryBytes: number
}
function invalid(): never {
  throw new Error('Actual published structured source differs from its retained inspection')
}

/** Actual read-only copied/READY source only. Its callback owns one-use raw
 * reads and external indexes; all source membership/authentication/descriptors
 * are checked freshly around I/O. Whole digest and wallet semantics belong to
 * the independent visitor, not a cached result from this adapter. */
export async function withBrc38PublishedStructuredFieldSource<T>(
  k: Knex.Transaction,
  table: Brc38StageTable,
  index: number,
  field: string,
  selected: Brc38PublishedStructuredSourcePolicy,
  work: (source: Readonly<Brc38StreamedStructured>, descriptor: Readonly<Brc38JsonStructuredField>) => Promise<T>,
  additionalTemporaryFileBytes = 0
): Promise<T> {
  const policy = brc38PrivateStructuredPolicy(selected),
    expiresAt = selected.expiresAt,
    combined = selected.maximumCombinedTemporaryBytes,
    extra = additionalTemporaryFileBytes,
    began = performance.now(),
    lifetime = expiresAt - Date.now(),
    scope = new Brc38OwnedImportReads(),
    indexes = new Set<Brc38NodeJsonIndex>(),
    retained = new Set<Brc38StagingCleanupError>()
  const actor = (): void => {
    policy.signal?.throwIfAborted()
    requireBrc38StructuredProjectionRead(k)
    if (isBrc38OwnedPrivateNativeSqlite(k)) invalid()
    if (Date.now() >= expiresAt || performance.now() - began >= lifetime)
      throw new SnapshotResourceLimitError('Published structured source inspection expired')
  }
  actor()
  if (
    !Number.isSafeInteger(index) ||
    index < 0 ||
    index >= 1000000000 ||
    !brc38JsonStructuredField(table, field) ||
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
    throw new RangeError('Invalid published structured source inspection policy')
  const databases = (await k.raw('PRAGMA database_list')) as Array<{ name: string; file: string }>,
    main = databases.filter(value => value.name === 'main')
  if (
    main.length !== 1 ||
    typeof main[0].file !== 'string' ||
    Buffer.byteLength(main[0].file) > 4096 ||
    !isAbsolute(main[0].file) ||
    resolve(main[0].file) !== main[0].file
  )
    invalid()
  brc38PrivateStructuredPolicy(policy, dirname(main[0].file))
  let bindingSha256: string | undefined,
    archiveSha256: string | undefined,
    issued = false
  const current = async (expected?: Brc38JsonStructuredField): Promise<Brc38JsonStructuredField> => {
    actor()
    await verifyBrc38AuthenticatedSourceSeal(k)
    const original = await k('private_binding')
        .where({ slot: 1 })
        .first(
          k.raw(
            "CASE WHEN typeof(digest)='text' AND length(CAST(digest AS BLOB))=64 THEN digest ELSE NULL END AS digest"
          ),
          k.raw(
            "CASE WHEN typeof(limitsJson)='text' AND length(CAST(limitsJson AS BLOB)) BETWEEN 1 AND 256 THEN limitsJson ELSE NULL END AS limitsJson"
          ),
          k.raw(
            "CASE WHEN typeof(bindingJson)='text' AND length(CAST(bindingJson AS BLOB))<=4096 THEN json_extract(bindingJson,'$.archiveSha256') ELSE NULL END AS archiveSha256"
          )
        ),
      authenticated = await k('private_import')
        .where({ slot: 1 })
        .first(
          k.raw(
            "CASE WHEN typeof(archiveSha256)='text' AND length(CAST(archiveSha256 AS BLOB))=64 THEN archiveSha256 ELSE NULL END AS archiveSha256"
          )
        ),
      header = await k('metadata')
        .where({ slot: 1 })
        .first(
          k.raw("CASE WHEN state='sealed' THEN 1 ELSE 0 END AS sealed"),
          k.raw(
            "CASE WHEN typeof(header)='text' AND length(CAST(header AS BLOB)) BETWEEN 1 AND 16777216 THEN length(CAST(header AS BLOB)) ELSE NULL END AS headerBytes"
          )
        ),
      count = await k('table_counts')
        .where({ tableName: table })
        .first(
          k.raw("CASE WHEN typeof(rows)='integer' AND rows BETWEEN 0 AND 1000000000 THEN rows ELSE NULL END AS rows")
        ),
      row = await k('rows').where({ tableName: table, position: index }).first('position'),
      descriptor = (await readBrc38SqlStructuredDescriptors(k, table, index))[field]
    if (typeof original?.limitsJson !== 'string') invalid()
    const limits = JSON.parse(original.limitsJson) as number[]
    if (
      !Array.isArray(limits) ||
      limits.length !== 6 ||
      limits.some(value => !Number.isSafeInteger(value) || value < 0) ||
      typeof original.digest !== 'string' ||
      !/^[0-9a-f]{64}$/.test(original.digest) ||
      typeof original.archiveSha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(original.archiveSha256) ||
      authenticated?.archiveSha256 !== original.archiveSha256 ||
      header?.sealed !== 1 ||
      typeof header.headerBytes !== 'number' ||
      header.headerBytes > limits[3] ||
      typeof count?.rows !== 'number' ||
      !Number.isSafeInteger(count.rows) ||
      count.rows <= index ||
      count.rows > limits[0] ||
      row?.position !== index ||
      descriptor === undefined ||
      descriptor.bytes > policy.maximumStructuredBytes ||
      (expected !== undefined && JSON.stringify(descriptor) !== JSON.stringify(expected)) ||
      (bindingSha256 !== undefined && bindingSha256 !== original.digest) ||
      (archiveSha256 !== undefined && archiveSha256 !== original.archiveSha256)
    )
      invalid()
    await measureBrc38StructuredFilesystem(
      dirname(main[0].file),
      [
        'wallet.sqlite',
        'wallet.sqlite-journal',
        'wallet.sqlite-wal',
        'wallet.sqlite-shm',
        'profile.sqlite',
        'profile.sqlite-journal',
        'owner.sqlite',
        'owner.sqlite-journal'
      ],
      limits[2],
      policy.maximumTemporaryIndexBytes + extra,
      policy.signal
    )
    bindingSha256 = original.digest
    archiveSha256 = original.archiveSha256
    actor()
    return descriptor
  }
  const expected = await current(),
    source: Readonly<Brc38StreamedStructured> = Object.freeze({
      encoding: 'utf8',
      length: expected.bytes,
      sha256: expected.sha256,
      read: (offset: number, length: number) =>
        scope.run(async () => {
          if (
            policy.maximumReadBytes !== undefined &&
            (!Number.isSafeInteger(length) || length > policy.maximumReadBytes)
          )
            throw new SnapshotResourceLimitError('Structured source exceeds its original transfer window')
          const scratch = policy.workingAllocation?.claim(3072 + 8 * length)
          let value: Uint8Array | undefined
          try {
            await current(expected)
            value = await readBrc38SqlStructuredRange(
              k,
              table,
              index,
              field,
              offset,
              length,
              expected,
              policy.maximumReadBytes,
              actor
            )
            await current(expected)
            return value
          } catch (error) {
            value?.fill(0)
            throw error
          } finally {
            scratch?.close()
          }
        }),
      openIndex: () =>
        scope.run(async () => {
          if (issued) throw new Error('Published structured grammar index was already issued')
          issued = true
          await current(expected)
          let actual: Brc38NodeJsonIndex
          try {
            actual = await Brc38NodeJsonIndex.open({
              privateParent: policy.privateIndexParent,
              sourceBytes: expected.bytes,
              maximumTemporaryFileBytes: policy.maximumTemporaryIndexBytes,
              maximumTemporaryPhysicalBytes: policy.maximumTemporaryIndexBytes,
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
              scope.run(async () => {
                await current(expected)
                await actual.put(object, member)
                await current(expected)
              }),
            seal: () =>
              scope.run(async () => {
                await current(expected)
                await actual.seal()
                await current(expected)
              }),
            lookup: (object, key) =>
              scope.run(async () => {
                await current(expected)
                const value = await actual.lookup(object, key)
                await current(expected)
                return value
              }),
            entries: async function* (object) {
              const iterator = actual.entries(object)
              try {
                for (;;) {
                  const value = await scope.run(async () => {
                    await current(expected)
                    const value = await iterator.next()
                    await current(expected)
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
    for (const value of indexes) {
      try {
        await value.close()
        indexes.delete(value)
      } catch (cause) {
        failures.push(cause)
      }
    }
    for (const value of retained) {
      try {
        await value.retryCleanup()
        retained.delete(value)
      } catch (cause) {
        failures.push(cause)
      }
    }
    if (failures.length !== 0)
      throw new Brc38StagingCleanupError(
        failures,
        'Published structured inspection retains private index cleanup',
        cleanup
      )
  }
  let result!: T,
    failed = false,
    original: unknown
  try {
    result = await scope.retain(async () => {
      const value = await work(source, expected)
      await current(expected)
      return value
    })
  } catch (cause) {
    failed = true
    original = cause
  }
  try {
    await cleanup()
  } catch (cause) {
    throw new Brc38StagingCleanupError(
      failed ? [original, cause] : [cause],
      'Published structured source retains physical cleanup',
      cleanup
    )
  }
  if (failed) throw original
  return result
}
