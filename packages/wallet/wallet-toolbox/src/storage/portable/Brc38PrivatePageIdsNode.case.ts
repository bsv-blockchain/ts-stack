import { readBrc38PrivateIncomingIdRange } from './Brc38PrivateIncomingIdSchemaNode'
import type { Knex } from 'knex'
import type { StorageKnex } from '../StorageKnex'
import { prepareBrc38PrivatePageIds } from './Brc38PrivatePageIdsNode'
import { insertBrc38PackedPlannedMetadata, insertBrc38PackedRestoreMetadata } from './Brc38PackedRestoreMetadataNode'
import type { Brc38ImportDecodedBudget } from './Brc38ImportDecodedBudget'

interface Controller {
  readonly storage: StorageKnex
  readonly userId: number
  readonly expiresAt: number
  readonly withRead: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T>
  readonly withWriter: <T>(work: (trx: Knex.Transaction) => Promise<T>) => Promise<T>
}
function requireCase(condition: boolean): asserts condition {
  if (!condition) throw new Error('Actual private allocation/counter/rollback oracle differs')
}
const budget = (): Brc38ImportDecodedBudget => ({ maximum: 16777216, remaining: 16777216 })
function basket(userId: number, name: string): Record<string, unknown> {
  const date = new Date('2026-10-07T00:00:00.000Z')
  return {
    basketId: 0,
    userId,
    name,
    created_at: date,
    updated_at: date,
    isDeleted: false,
    numberOfDesiredUTXOs: 7,
    minimumDesiredUTXOValue: 11
  }
}
/** Authored UNRUN. The complete finite controller supplies actual private
 * owner/read/writer phases; no structural mock may acquire the allocation.
 * Original expected IDs come from the read plan; SQL rows and counter
 * postimages are then independently inspected, including rollback and an
 * intervening writer. This proves no import/provenance/checkpoint admission. */
export async function verifyPrivatePageIds(controller: Controller): Promise<void> {
  const { storage, userId, expiresAt, withRead, withWriter } = controller,
    first = basket(userId, 'allocation actual first'),
    second = basket(userId, 'allocation actual second')
  const plan = await withRead(
    async trx => await prepareBrc38PrivatePageIds(storage, trx, 'outputBaskets', 2, expiresAt, budget())
  )
  requireCase(plan.ids.length === 2 && plan.ids[0] > 0 && plan.ids[1] === plan.ids[0] + 1 && Object.isFrozen(plan.ids))
  const marker = new Error('independent allocation rollback'),
    before = await withRead(async trx =>
      Number(((await trx('output_baskets').count({ count: '*' }).first()) as { count: number }).count)
    )
  let rolledBack = false
  try {
    await withWriter(async trx => {
      requireCase(
        (await insertBrc38PackedPlannedMetadata(storage, trx, 'outputBaskets', first, [], plan, budget())) ===
          plan.ids[0]
      )
      requireCase(
        (await insertBrc38PackedPlannedMetadata(storage, trx, 'outputBaskets', second, [], plan, budget())) ===
          plan.ids[1]
      )
      const rows = (await trx('output_baskets')
        .whereIn('basketId', [...plan.ids])
        .orderBy('basketId')
        .select('basketId', 'name')) as Array<{ basketId: number; name: string }>
      requireCase(
        rows.length === 2 &&
          rows[0].basketId === plan.ids[0] &&
          rows[1].basketId === plan.ids[1] &&
          rows[0].name === first.name &&
          rows[1].name === second.name
      )
      throw marker
    })
  } catch (cause) {
    requireCase(cause === marker)
    rolledBack = true
  }
  requireCase(
    rolledBack &&
      (await withRead(async trx =>
        Number(((await trx('output_baskets').count({ count: '*' }).first()) as { count: number }).count)
      )) === before
  )
  let reuseRefused = false
  try {
    await withWriter(
      async trx => await insertBrc38PackedPlannedMetadata(storage, trx, 'outputBaskets', first, [], plan, budget())
    )
  } catch {
    reuseRefused = true
  }
  requireCase(reuseRefused)
  const next = await withRead(
    async trx => await prepareBrc38PrivatePageIds(storage, trx, 'outputBaskets', 1, expiresAt, budget())
  )
  requireCase(next.ids[0] === plan.ids[0])
  let copiedRefused = false
  try {
    await withWriter(
      async trx =>
        await insertBrc38PackedPlannedMetadata(
          storage,
          trx,
          'outputBaskets',
          first,
          [],
          Object.freeze({ table: next.table, ids: next.ids }),
          budget()
        )
    )
  } catch {
    copiedRefused = true
  }
  requireCase(copiedRefused)
  const intervening = await withWriter(
    async trx =>
      await insertBrc38PackedRestoreMetadata(
        storage,
        trx,
        'outputBaskets',
        basket(userId, 'independent actual intervening row'),
        [],
        budget()
      )
  )
  requireCase(intervening === next.ids[0])
  let staleRefused = false
  try {
    await withWriter(
      async trx => await insertBrc38PackedPlannedMetadata(storage, trx, 'outputBaskets', first, [], next, budget())
    )
  } catch {
    staleRefused = true
  }
  requireCase(staleRefused)
  const refreshed = await withRead(
    async trx => await prepareBrc38PrivatePageIds(storage, trx, 'outputBaskets', 2, expiresAt, budget())
  )
  requireCase(refreshed.ids[0] === next.ids[0] + 1)
  await withWriter(async trx => {
    requireCase(
      (await insertBrc38PackedPlannedMetadata(storage, trx, 'outputBaskets', first, [], refreshed, budget())) ===
        refreshed.ids[0]
    )
    requireCase(
      (await insertBrc38PackedPlannedMetadata(storage, trx, 'outputBaskets', second, [], refreshed, budget())) ===
        refreshed.ids[1]
    )
  })
  const after = await withRead(async trx =>
    Number(((await trx('output_baskets').count({ count: '*' }).first()) as { count: number }).count)
  )
  requireCase(after === before + 3)
}

/** UNRUN reserved-path counterpart. Independent expected range/counter values
 * are fixed before source construction. A caught unique violation cannot
 * commit an unused-prefix hole, entity row or counter change. */
export async function verifyReservedPrivatePageIds(
  controller: Controller,
  expected: Readonly<{ first: number; used: number; sourceHigh: number }>
): Promise<void> {
  const { storage, userId, expiresAt, withRead, withWriter } = controller
  requireCase(
    Number.isSafeInteger(expected.first) &&
      expected.first > 0 &&
      Number.isSafeInteger(expected.used) &&
      expected.used >= 0 &&
      Number.isSafeInteger(expected.sourceHigh) &&
      expected.sourceHigh > expected.first + expected.used + 2
  )
  const inspect = async () =>
    await withRead(async trx => {
      const range = await readBrc38PrivateIncomingIdRange(trx, 1),
        counter = (await trx('sqlite_sequence').where({ name: 'output_baskets' }).select('seq').limit(2)) as Array<{
          seq: number
        }>
      requireCase(range !== undefined && counter.length === 1)
      return { first: range.first, used: range.used, seq: counter[0].seq }
    })
  requireCase(
    JSON.stringify(await inspect()) ===
      JSON.stringify({ first: expected.first, used: expected.used, seq: expected.sourceHigh })
  )
  const first = expected.first + expected.used,
    plan = await withRead(
      async trx => await prepareBrc38PrivatePageIds(storage, trx, 'outputBaskets', 2, expiresAt, budget())
    )
  requireCase(plan.ids[0] === first && plan.ids[1] === first + 1)
  await withWriter(async trx => {
    requireCase(
      (await insertBrc38PackedPlannedMetadata(
        storage,
        trx,
        'outputBaskets',
        basket(userId, 'reserved independent A'),
        [],
        plan,
        budget()
      )) === first
    )
    requireCase(
      (await insertBrc38PackedPlannedMetadata(
        storage,
        trx,
        'outputBaskets',
        basket(userId, 'reserved independent B'),
        [],
        plan,
        budget()
      )) ===
        first + 1
    )
  })
  requireCase(
    JSON.stringify(await inspect()) ===
      JSON.stringify({ first: expected.first, used: expected.used + 2, seq: expected.sourceHigh })
  )
  const failure = await withRead(
    async trx => await prepareBrc38PrivatePageIds(storage, trx, 'outputBaskets', 1, expiresAt, budget())
  )
  await withWriter(async trx => {
    let refused = false
    try {
      await insertBrc38PackedPlannedMetadata(
        storage,
        trx,
        'outputBaskets',
        basket(userId, 'reserved independent A'),
        [],
        failure,
        budget()
      )
    } catch {
      refused = true
    }
    requireCase(refused)
  })
  requireCase(
    JSON.stringify(await inspect()) ===
      JSON.stringify({ first: expected.first, used: expected.used + 2, seq: expected.sourceHigh })
  )
  let consumed = false
  try {
    await withWriter(
      async trx =>
        await insertBrc38PackedPlannedMetadata(
          storage,
          trx,
          'outputBaskets',
          basket(userId, 'reserved independent C'),
          [],
          failure,
          budget()
        )
    )
  } catch {
    consumed = true
  }
  requireCase(consumed)
  const replay = await withRead(
    async trx => await prepareBrc38PrivatePageIds(storage, trx, 'outputBaskets', 1, expiresAt, budget())
  )
  requireCase(replay.ids[0] === first + 2)
  await withWriter(async trx => {
    requireCase(
      (await insertBrc38PackedPlannedMetadata(
        storage,
        trx,
        'outputBaskets',
        basket(userId, 'reserved independent C'),
        [],
        replay,
        budget()
      )) ===
        first + 2
    )
  })
  requireCase(
    JSON.stringify(await inspect()) ===
      JSON.stringify({ first: expected.first, used: expected.used + 3, seq: expected.sourceHigh })
  )
}
