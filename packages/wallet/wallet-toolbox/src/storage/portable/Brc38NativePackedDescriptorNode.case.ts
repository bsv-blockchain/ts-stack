import type { KnexBrc38StagingStore } from './KnexBrc38StagingStore'
import { readBrc38NativePackedDescriptor } from './Brc38NativePackedFieldsNode'
import { nativePackedTables } from './Brc38NativePackedSchemaNode'

/** Authored UNRUN. A finite native controller supplies its actual currently
 * authenticated private owner and a pointer-free NULL-script fixture output.
 * A nonnull marker without content is a malformed row, not an absent field.
 * The concrete writer rolls back the countercase before this operation exits. */
export async function verifyNativePackedMissingPointerRefusal(
  store: KnexBrc38StagingStore,
  rowId: number
): Promise<void> {
  if (!Number.isSafeInteger(rowId) || rowId < 1) throw new RangeError('Actual output fixture ID required')
  const rollback = new Error('Rollback incomplete packed marker countercase')
  try {
    await store.withPrivateNativeDatabase(
      false,
      async database =>
        await database.transaction(async trx => {
          store.assertPrivateNativeWriteTransaction(trx)
          const row = await trx('outputs').where({ outputId: rowId }).first(trx.raw('lockingScript IS NULL AS empty')),
            pointer = await trx(nativePackedTables.fields).where({ tableId: 3, rowId, fieldId: 0 }).first('sha256')
          if (row?.empty !== 1 || pointer !== undefined) throw new Error('Original NULL-script fixture differs')
          await trx('outputs')
            .where({ outputId: rowId })
            .update({ lockingScript: trx.raw('zeroblob(0)') })
          let refused = false
          try {
            await readBrc38NativePackedDescriptor(trx, { table: 'outputs', field: 'lockingScript', rowId })
          } catch (cause) {
            if (!(cause instanceof Error) || !cause.message.includes('current owned content')) throw cause
            refused = true
          }
          if (!refused) throw new Error('Incomplete nonnull marker was treated as absent content')
          throw rollback
        })
    )
    throw new Error('Descriptor countercase unexpectedly committed')
  } catch (cause) {
    if (cause !== rollback) throw cause
  }
  await store.withPrivateNativeDatabase(
    true,
    async database =>
      await database.transaction(async trx => {
        store.assertPrivateNativeReadTransaction(trx)
        const row = await trx('outputs').where({ outputId: rowId }).first(trx.raw('lockingScript IS NULL AS empty'))
        if (
          row?.empty !== 1 ||
          (await readBrc38NativePackedDescriptor(trx, { table: 'outputs', field: 'lockingScript', rowId })) !==
            undefined
        )
          throw new Error('Descriptor countercase did not drain and roll back')
      })
  )
}
