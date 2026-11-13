import { createHash, randomBytes } from 'node:crypto'
import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import {
  Brc38NativePreparedFieldLifetime,
  retireExpiredBrc38NativePreparedFields
} from './Brc38NativePreparedFieldsNode'
import { nativePreparedFieldsTable } from './Brc38NativePreparedFieldSchemaNode'
import { nativePackedTables } from './Brc38NativePackedSchemaNode'
import { collectBrc38NativePackedGarbage } from './Brc38NativePackedFieldsNode'

function same(actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Independent native preparation lifetime oracle differs')
}
/** Authored UNRUN. A freshly admitted finite native controller supplies its
 * actual authenticated structured store with the additive lifetime migration.
 * This checks lifetime/partial-prefix retirement and actual quota accounting;
 * it is not a source proof, entity merge, activation or production claim. */
export async function verifyNativePreparedFieldLifetimes(
  store: KnexBrc38StagingStore,
  expiresAt: number
): Promise<void> {
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > store.limits.expiresAt)
    throw new RangeError('Original finite native lifetime required')
  const payload = randomBytes(17),
    sha256 = createHash('sha256').update(payload).digest('hex'),
    writer = async <T>(run: (trx: import('knex').Knex.Transaction) => Promise<T>): Promise<T> =>
      await store.withPrivateNativeDatabase(
        false,
        async database =>
          await database.transaction(async trx => {
            store.assertPrivateNativeWriteTransaction(trx)
            return await run(trx)
          })
      )
  let first: Brc38NativePreparedFieldLifetime | undefined, second: Brc38NativePreparedFieldLifetime | undefined
  const before = await writer(async trx => {
    if (
      (await trx(nativePackedTables.garbage).first('sha256')) !== undefined ||
      (await trx(nativePreparedFieldsTable).first('id')) !== undefined
    )
      throw new Error('Lifetime case requires a fresh drained native candidate')
    return await trx(nativePackedTables.budget).where({ slot: 1 }).first('reservedBytes')
  })
  try {
    first = await writer(async trx => {
      await trx(nativePackedTables.versions).insert({
        sha256,
        bytes: payload.length,
        accepted: 0,
        chunks: 0,
        state: 'PENDING'
      })
      await trx(nativePackedTables.chunks).insert({
        sha256,
        offset: 0,
        bytes: payload.length,
        payload,
        chunkSha256: sha256
      })
      return await Brc38NativePreparedFieldLifetime.begin(trx, 'binary', sha256, expiresAt)
    })
    second = await writer(async trx => await Brc38NativePreparedFieldLifetime.begin(trx, 'binary', sha256, expiresAt))
    await writer(async trx => {
      await first!.check(trx)
      await second!.check(trx)
      await first!.release(trx)
      same(await trx(nativePackedTables.versions).where({ sha256 }).first('state'), { state: 'PENDING' })
      same(await trx(nativePackedTables.garbage).where({ sha256 }).first('sha256'), undefined)
      await second!.check(trx)
    })
    await writer(async trx => {
      let refused = false
      try {
        await first!.check(trx)
      } catch {
        refused = true
      }
      if (!refused) throw new Error('Released native preparation regained liveness')
      await second!.check(trx)
      await second!.release(trx)
      same(await trx(nativePackedTables.versions).where({ sha256 }).first('state', 'accepted', 'chunks'), {
        state: 'RETIRING',
        accepted: payload.length,
        chunks: 1
      })
      same(await trx(nativePackedTables.garbage).where({ sha256 }).first('sha256'), { sha256 })
      await collectBrc38NativePackedGarbage(trx, 1)
      same(await trx(nativePackedTables.versions).where({ sha256 }).first('sha256'), undefined)
      same(await trx(nativePackedTables.budget).where({ slot: 1 }).first('reservedBytes'), before)
    })
    // Expired durable metadata is cleanup DATA only. No actor or source grant
    // is minted from this deliberately abandoned original fixture record.
    await writer(async trx => {
      await trx(nativePackedTables.versions).insert({
        sha256,
        bytes: payload.length,
        accepted: 0,
        chunks: 0,
        state: 'PENDING'
      })
      await trx(nativePreparedFieldsTable).insert({
        id: randomBytes(16).toString('hex'),
        family: 'binary',
        sha256,
        expiresAt: Date.now() - 1
      })
      same((await retireExpiredBrc38NativePreparedFields(trx, 1)).retired, 1)
      await collectBrc38NativePackedGarbage(trx, 1)
      same(await trx(nativePackedTables.versions).where({ sha256 }).first('sha256'), undefined)
      same(await trx(nativePackedTables.budget).where({ slot: 1 }).first('reservedBytes'), before)
    })
  } finally {
    // Lifetime release is retryable and namespace-bound even after its earlier
    // transaction succeeded. The controller still owns overall physical drain.
    try {
      if (first !== undefined) await writer(async trx => await first!.release(trx))
    } finally {
      if (second !== undefined) await writer(async trx => await second!.release(trx))
      payload.fill(0)
    }
  }
}
