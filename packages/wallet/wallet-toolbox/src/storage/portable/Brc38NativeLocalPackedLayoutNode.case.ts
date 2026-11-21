import type { Knex } from 'knex'
import {
  installBrc38NativeLocalPackedLayout,
  hasBrc38NativeLocalPackedLayout
} from './Brc38NativeLocalPackedLayoutNode'
import { hasBrc38NativePackedSchema } from './Brc38NativePackedSchemaNode'
import { hasBrc38NativePackedTextSchema } from './Brc38NativePackedTextSchemaNode'
interface ActualController {
  withRead<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
  withWriter<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T>
  check(): void
}
function requireCase(value: unknown): asserts value {
  if (!value) throw new Error('Actual private local packed layout case failed')
}
/** Changed, duplicate or absent proof metadata is occupied or incomplete state,
 * even when every payload table is empty. Exercise the actual owned writer and
 * roll each refused seed change back before admitting the original seed. */
export async function verifyBrc38NativeLocalPackedProofSeedRefusal(controller: ActualController): Promise<void> {
  controller.check()
  for (const mutation of ['changed', 'extra', 'absent'] as const) {
    const rollback = new Error('Independent prepared proof seed rollback')
    let refused = false
    try {
      await controller.withWriter(async trx => {
        if (mutation === 'changed')
          await trx('prepared_beef_metadata').where('preparedBeefMetadataId', 1).update({ proofEpoch: 1 })
        else if (mutation === 'extra')
          await trx('prepared_beef_metadata').insert({ preparedBeefMetadataId: 2, proofEpoch: 0 })
        else await trx('prepared_beef_metadata').delete()
        try {
          await installBrc38NativeLocalPackedLayout(trx)
        } catch (cause) {
          requireCase(
            cause instanceof Error && cause.message === 'Local packed layout requires its exact empty private candidate'
          )
          refused = true
        }
        requireCase(refused && !(await hasBrc38NativeLocalPackedLayout(trx)))
        throw rollback
      })
    } catch (cause) {
      requireCase(cause === rollback)
    }
    requireCase(refused)
    requireCase(
      await controller.withRead(async trx => {
        const rows = await trx('prepared_beef_metadata').select('preparedBeefMetadataId', 'proofEpoch').limit(2)
        return (
          rows.length === 1 &&
          rows[0].preparedBeefMetadataId === 1 &&
          rows[0].proofEpoch === 0 &&
          !(await hasBrc38NativeLocalPackedLayout(trx))
        )
      })
    )
  }
  await controller.withWriter(async trx => await installBrc38NativeLocalPackedLayout(trx))
  requireCase(await controller.withRead(async trx => await hasBrc38NativeLocalPackedLayout(trx)))
  controller.check()
}
/** Independent actual fresh candidate, BEFORE any rows/versions or generation
 * observers. No fake/SQLite-compatible transaction can supply this evidence. */
export async function verifyBrc38NativeLocalPackedLayout(controller: ActualController): Promise<void> {
  controller.check()
  requireCase(
    await controller.withRead(
      async trx =>
        !(await hasBrc38NativeLocalPackedLayout(trx)) &&
        (await hasBrc38NativePackedSchema(trx)) &&
        (await hasBrc38NativePackedTextSchema(trx))
    )
  )
  await controller.withWriter(async trx => await installBrc38NativeLocalPackedLayout(trx))
  requireCase(
    await controller.withRead(
      async trx =>
        (await hasBrc38NativeLocalPackedLayout(trx)) &&
        (await hasBrc38NativePackedSchema(trx)) &&
        (await hasBrc38NativePackedTextSchema(trx))
    )
  )
  let refused = false
  try {
    await controller.withWriter(async trx => await installBrc38NativeLocalPackedLayout(trx))
  } catch {
    refused = true
  }
  requireCase(refused)
  // Direct large auxiliary payloads cannot bypass the bounded field receiver.
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx('monitor_events').insert({
        id: -7,
        created_at: 1791331200000,
        updated_at: 1791331200000,
        event: 'independent local layout',
        details: 'x'
      })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  await controller.withWriter(async trx => {
    await trx('monitor_events').insert({
      id: -7,
      created_at: 1791331200000,
      updated_at: 1791331200000,
      event: 'independent local layout',
      details: null
    })
  })
  // A marker alone is never a complete logical field or sealed pointer.
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx('brc38_native_text_fields').insert({ tableId: 13, rowId: -7, fieldId: 0, sha256: '7'.repeat(64) })
    })
  } catch {
    refused = true
  }
  requireCase(refused)
  await controller.withWriter(async trx => {
    requireCase((await trx('monitor_events').where({ id: -7 }).delete()) === 1)
  })
  // Exact definition inspection refuses missing row guards and rolls back.
  const rollback = new Error('independent layout definition rollback')
  refused = false
  try {
    await controller.withWriter(async trx => {
      await trx.raw('DROP TRIGGER brc38_native_text_fields_row_13')
      try {
        await hasBrc38NativePackedTextSchema(trx)
      } catch {
        refused = true
      }
      throw rollback
    })
  } catch (cause) {
    requireCase(cause === rollback)
  }
  requireCase(refused && (await controller.withRead(async trx => await hasBrc38NativePackedTextSchema(trx))))
  controller.check()
}
/** Separate fresh candidate. Occupied transfer state must refuse the layout
 * installer without changing either original family. */
export async function verifyBrc38NativeLocalPackedOccupiedRefusal(controller: ActualController): Promise<void> {
  await controller.withWriter(async trx => {
    requireCase(
      (await trx('sync_transfers').where({ slot: 1 }).update({ state: 'independent occupied transfer' })) === 1
    )
  })
  let refused = false
  try {
    await controller.withWriter(async trx => await installBrc38NativeLocalPackedLayout(trx))
  } catch {
    refused = true
  }
  requireCase(
    refused &&
      (await controller.withRead(
        async trx =>
          !(await hasBrc38NativeLocalPackedLayout(trx)) &&
          (await hasBrc38NativePackedSchema(trx)) &&
          (await hasBrc38NativePackedTextSchema(trx))
      ))
  )
  controller.check()
}
