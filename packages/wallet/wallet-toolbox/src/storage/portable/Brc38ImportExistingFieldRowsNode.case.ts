import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import type { Brc38ImportEntityTarget } from './Brc38ImportEntityTargets'
import {
  prepareBrc38ImportExistingFieldTargets,
  assertBrc38ImportExistingFieldTargets
} from './Brc38ImportExistingRows'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'

/** Authored UNRUN. The finite native controller supplies its real query-only
 * retained packed destination, current independently selected output natural
 * key and an independent large locking-script descriptor oracle. Query
 * observation checks the boundary that complete field bytes never cross SQL
 * into JS during metadata preparation; it is not source/actor authority. */
export async function verifyNativeExistingFieldMetadataBound(
  trx: Knex.Transaction,
  storage: StorageKnex,
  userId: number,
  target: Brc38ImportEntityTarget,
  expected: Readonly<{ bytes: number; sha256: string }>,
  maximumAllocationBytes: number
): Promise<void> {
  if (
    target.table !== 'outputs' ||
    !target.found ||
    expected.bytes < 65537 ||
    !Number.isSafeInteger(expected.bytes) ||
    !/^[0-9a-f]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(maximumAllocationBytes) ||
    maximumAllocationBytes < 32768 ||
    maximumAllocationBytes > 65536
  )
    throw new RangeError('Independent occupied output metadata fixture required')
  let queries = 0,
    metadataQueries = 0,
    fullPayloadSelection = false
  const observe = (event: { sql: string }): void => {
    if (++queries > 8192) throw new Error('Metadata case exceeded its finite native query count')
    const sql = event.sql
    if (typeof sql !== 'string' || sql.length > 65536)
      throw new Error('Native query observation exceeded its fixed bound')
    if (!/^select\b/i.test(sql) || !/from\s+["`]?outputs["`]?\b/i.test(sql)) return
    if (sql.includes('__brc38NativeBinaryRowId')) metadataQueries++
    if (/^select\s+\*/i.test(sql) || /["`]lockingScript["`]\s*(?:,|\sfrom\b)/i.test(sql)) fullPayloadSelection = true
  }
  trx.on('query', observe)
  try {
    const prepared = await prepareBrc38ImportExistingFieldTargets(
      trx,
      storage,
      userId,
      'outputs',
      [target],
      maximumAllocationBytes
    )
    if (prepared.length !== 1) throw new Error('Occupied output metadata cardinality differs')
    const row = prepared[0],
      metadata = row.metadata,
      field = row.binaries.lockingScript
    if (
      metadata === undefined ||
      metadata.outputId !== target.localId ||
      Object.hasOwn(metadata, 'lockingScript') ||
      field === undefined ||
      field.bytes !== expected.bytes ||
      field.sha256 !== expected.sha256 ||
      prepared[0].allocationBytes > maximumAllocationBytes ||
      metadataQueries !== 1 ||
      fullPayloadSelection
    )
      throw new Error('Occupied output preparation materialized or changed its actual separate field metadata')
  } finally {
    trx.removeListener('query', observe)
  }
}

/** Authored UNRUN. Fresh READ preparation is compared again in the actual
 * private writer. A changed small scalar must refuse even though every large
 * field descriptor remains unchanged; the countercase mutation rolls back. */
export async function verifyNativeExistingFieldWriterFence(
  store: KnexBrc38StagingStore,
  storage: StorageKnex,
  userId: number,
  target: Brc38ImportEntityTarget
): Promise<void> {
  if (target.table !== 'outputs' || !target.found || target.localId === undefined)
    throw new RangeError('Occupied output fixture required')
  const read = async () =>
      await store.withPrivateNativeDatabase(
        true,
        async database =>
          await database.transaction(async trx => {
            store.assertPrivateNativeReadTransaction(trx)
            return await prepareBrc38ImportExistingFieldTargets(trx, storage, userId, 'outputs', [target], 65536)
          })
      ),
    prepared = await read(),
    rollback = new Error('Rollback stale metadata writer countercase')
  if (prepared.length !== 1 || !Number.isSafeInteger(prepared[0].metadata?.satoshis))
    throw new Error('Output metadata fixture differs')
  try {
    await store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async trx => {
          store.assertPrivateNativeWriteTransaction(trx)
          await assertBrc38ImportExistingFieldTargets(trx, storage, userId, 'outputs', [target], prepared, 65536)
          const changed = prepared[0].metadata?.satoshis === 1 ? 2 : 1
          if ((await trx('outputs').where({ outputId: target.localId, userId }).update({ satoshis: changed })) !== 1)
            throw new Error('Stale scalar countercase did not change exactly one original output')
          let refused = false
          try {
            await assertBrc38ImportExistingFieldTargets(trx, storage, userId, 'outputs', [target], prepared, 65536)
          } catch (cause) {
            if (!(cause instanceof Error) || !cause.message.includes('prepared indexed identity')) throw cause
            refused = true
          }
          if (!refused) throw new Error('Writer accepted stale metadata with unchanged large field descriptors')
          throw rollback
        })
    )
    throw new Error('Stale metadata countercase unexpectedly committed')
  } catch (cause) {
    if (cause !== rollback) throw cause
  }
  if (JSON.stringify(await read()) !== JSON.stringify(prepared))
    throw new Error('Stale metadata writer countercase did not roll back')
}
