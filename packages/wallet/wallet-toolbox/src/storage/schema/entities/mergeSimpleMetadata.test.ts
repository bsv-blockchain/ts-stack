import { EntityOutputBasket } from './EntityOutputBasket'
import { EntityOutputTag } from './EntityOutputTag'
import { EntityTxLabel } from './EntityTxLabel'
import { EntityTxLabelMap } from './EntityTxLabelMap'
import { EntityOutputTagMap } from './EntityOutputTagMap'
import { createSyncMap, type EntityStorage, type SyncMap } from './EntityBase'
import type { TableOutputBasket, TableOutputTag, TableTxLabel, TableTxLabelMap, TableOutputTagMap } from '../tables'

interface Metadata {
  created_at: Date
  updated_at: Date
  isDeleted: boolean
}
interface PolicyEntity<T> {
  mergeExisting(storage: EntityStorage, since: undefined, incoming: T, map: SyncMap): Promise<boolean>
  toApi(): T
}
const date = (day: number): Date => new Date(`2026-10-${String(day).padStart(2, '0')}T00:00:00.000Z`)
/** Finite full-row policy oracle only. Capturing original provider calls does
 * not emulate a SQL owner, import/source admission or native controller. */
async function exercise<T extends Metadata>(
  original: T,
  make: (row: T) => PolicyEntity<T>,
  method: string
): Promise<void> {
  for (const day of [1, 2, 3]) {
    const api = { ...original, created_at: date(1), updated_at: date(2), isDeleted: false },
      entity = make(api),
      update = jest.fn(async () => 1),
      storage = { [method]: update } as unknown as EntityStorage,
      incoming = { ...original, created_at: date(3), updated_at: date(day), isDeleted: true }
    expect(await entity.mergeExisting(storage, undefined, incoming, createSyncMap())).toBe(day === 3)
    expect(entity.toApi()).toBe(api)
    expect(api.created_at).toEqual(date(1))
    expect(api.updated_at).toEqual(date(day === 3 ? 3 : 2))
    expect(api.isDeleted).toBe(day === 3)
    for (const key of Object.keys(original))
      if (!['created_at', 'updated_at', 'isDeleted'].includes(key))
        expect(Reflect.get(api, key)).toEqual(Reflect.get(original, key))
    expect(update).toHaveBeenCalledTimes(day === 3 ? 1 : 0)
  }
}
test('all five original scalar entity policies retain API identity, keys and creation time across timestamp/tombstone boundaries', async () => {
  const common = { created_at: date(1), updated_at: date(2), isDeleted: false },
    basket: TableOutputBasket = {
      ...common,
      userId: 4,
      basketId: 9,
      name: 'operator selected',
      numberOfDesiredUTXOs: 7,
      minimumDesiredUTXOValue: 11
    },
    tag: TableOutputTag = { ...common, userId: 4, outputTagId: 9, tag: 'original tag' },
    label: TableTxLabel = { ...common, userId: 4, txLabelId: 9, label: 'original label' },
    labelMap: TableTxLabelMap = { ...common, transactionId: 8, txLabelId: 9 },
    tagMap: TableOutputTagMap = { ...common, outputId: 8, outputTagId: 9 }
  await exercise(basket, row => new EntityOutputBasket(row, true), 'updateOutputBasket')
  await exercise(tag, row => new EntityOutputTag(row), 'updateOutputTag')
  await exercise(label, row => new EntityTxLabel(row), 'updateTxLabel')
  await exercise(labelMap, row => new EntityTxLabelMap(row), 'updateTxLabelMap')
  await exercise(tagMap, row => new EntityOutputTagMap(row), 'updateOutputTagMap')
})
test.each([false, true])(
  'basket metadata keeps the original opt-in archived policy choice (%s)',
  async preserveArchived => {
    const original: TableOutputBasket = {
        created_at: date(1),
        updated_at: date(2),
        isDeleted: false,
        userId: 4,
        basketId: 9,
        name: 'default',
        numberOfDesiredUTXOs: 144,
        minimumDesiredUTXOValue: 5000
      },
      entity = new EntityOutputBasket(original, preserveArchived),
      update = jest.fn(async () => 1),
      storage = { updateOutputBasket: update } as unknown as EntityStorage
    expect(
      await entity.mergeExisting(
        storage,
        undefined,
        { ...original, updated_at: date(3), minimumDesiredUTXOValue: 32 },
        createSyncMap()
      )
    ).toBe(true)
    expect(original.minimumDesiredUTXOValue).toBe(preserveArchived ? 32 : 5000)
    expect(original.numberOfDesiredUTXOs).toBe(144)
    expect(original.basketId).toBe(9)
    expect(update).toHaveBeenCalledTimes(1)
  }
)
