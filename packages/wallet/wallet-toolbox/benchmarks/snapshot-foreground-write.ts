import type { StorageReaderWriter } from '../src/storage/StorageReaderWriter'

/** A benchmark write is counted only after a changed wallet row is read back.
 * The caller owns actual writer admission and measures its queue wait. */
export async function mutateSnapshotForegroundBasket(
  storage: Pick<StorageReaderWriter, 'findOutputBaskets' | 'updateOutputBasket'>,
  userId: number,
  name: string
): Promise<{ basketId: number; before: number; after: number }> {
  const rows = await storage.findOutputBaskets({ partial: { userId, name }, paged: { limit: 2, offset: 0 } })
  if (rows.length !== 1 || rows[0].isDeleted) throw new Error('Foreground measurement requires one active basket')
  const basket = rows[0],
    before = basket.numberOfDesiredUTXOs,
    after = before === 1 ? 2 : 1
  if (
    (await storage.updateOutputBasket(basket.basketId, { numberOfDesiredUTXOs: after, updated_at: new Date() })) !== 1
  )
    throw new Error('Foreground measurement did not update exactly one basket')
  const readback = await storage.findOutputBaskets({
    partial: { userId, basketId: basket.basketId, name },
    paged: { limit: 2, offset: 0 }
  })
  if (readback.length !== 1 || readback[0].isDeleted || readback[0].numberOfDesiredUTXOs !== after)
    throw new Error('Foreground measurement write was not independently read back')
  return { basketId: basket.basketId, before, after }
}
