import { knex } from 'knex'
import { StorageKnex } from '../../../StorageKnex'
import { createSyncMap, type EntityStorage } from '../EntityBase'
import { EntityOutput } from '../EntityOutput'

function incoming(): EntityOutput {
  const output = new EntityOutput()
  Object.assign(output.api, {
    outputId: 41,
    userId: 88,
    transactionId: 7,
    basketId: 9,
    created_at: new Date('2026-09-01'),
    updated_at: new Date('2026-09-02')
  })
  return output
}

function mapping() {
  const syncMap = createSyncMap()
  syncMap.transaction.idMap[7] = 1
  return syncMap
}

function captureStorage() {
  const insertOutput = jest.fn(async () => 100)
  const updateOutput = jest.fn(async () => 1)
  return { insertOutput, updateOutput, storage: { insertOutput, updateOutput } as unknown as EntityStorage }
}

describe('output basket mapping during synchronization', () => {
  test('compares a spent output using both its basket and spending-transaction mappings', () => {
    const source = incoming().api
    source.spentBy = 8
    const local = new EntityOutput({ ...source, transactionId: 1, basketId: 77, spentBy: 2 })
    const syncMap = mapping()
    syncMap.outputBasket.idMap[9] = 77
    syncMap.transaction.idMap[8] = 2
    expect(local.equals(source, syncMap)).toBe(true)
    syncMap.transaction.idMap[8] = 3
    expect(local.equals(source, syncMap)).toBe(false)
    source.spentBy = undefined
    local.spentBy = undefined
    expect(local.equals(source, syncMap)).toBe(true)
  })

  test.each([undefined, 0, -1, 1.5])(
    'rejects invalid mapped basket %s before changing the incoming entity',
    async mapped => {
      const output = incoming()
      const before = structuredClone(output.api)
      const syncMap = mapping()
      if (mapped !== undefined) syncMap.outputBasket.idMap[9] = mapped
      const { storage, insertOutput } = captureStorage()
      await expect(output.mergeNew(storage, 1, syncMap)).rejects.toThrow()
      expect(output.api).toEqual(before)
      expect(insertOutput).not.toHaveBeenCalled()
      syncMap.outputBasket.idMap[9] = 77
      await output.mergeNew(storage, 1, syncMap)
      expect(insertOutput).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 1, basketId: 77, transactionId: 1 }),
        undefined
      )
    }
  )

  test('retains a genuinely unbasketed new output', async () => {
    const output = incoming()
    output.basketId = undefined
    const { storage, insertOutput } = captureStorage()
    await output.mergeNew(storage, 1, mapping())
    expect(insertOutput).toHaveBeenCalledWith(expect.objectContaining({ basketId: undefined }), undefined)
  })

  test('rejects a newer incoherent update before mutation, then repairs a missing basket on a valid newer update', async () => {
    const source = incoming().api
    const local = new EntityOutput({
      ...source,
      outputId: 100,
      basketId: undefined,
      updated_at: new Date('2026-09-01')
    })
    const before = structuredClone(local.api)
    const syncMap = mapping()
    const { storage, updateOutput } = captureStorage()
    await expect(local.mergeExisting(storage, undefined, source, syncMap)).rejects.toThrow()
    expect(local.api).toEqual(before)
    expect(updateOutput).not.toHaveBeenCalled()
    syncMap.outputBasket.idMap[9] = 77
    await expect(local.mergeExisting(storage, undefined, source, syncMap)).resolves.toBe(true)
    expect(local.basketId).toBe(77)
    await expect(local.mergeExisting(storage, undefined, source, syncMap)).resolves.toBe(false)
    expect(updateOutput).toHaveBeenCalledTimes(1)
    await local.mergeExisting(
      storage,
      undefined,
      { ...source, basketId: undefined, updated_at: new Date('2026-09-03') },
      syncMap
    )
    expect(local.basketId).toBeUndefined()
  })

  test.each(['2026-09-01', '2026-09-02'])(
    'preserves a local relinquishment against same or older source time %s',
    async date => {
      const local = incoming()
      local.basketId = undefined
      const { storage, updateOutput } = captureStorage()
      await expect(
        local.mergeExisting(storage, undefined, { ...incoming().api, updated_at: new Date(date) }, mapping())
      ).resolves.toBe(false)
      expect(local.basketId).toBeUndefined()
      expect(updateOutput).not.toHaveBeenCalled()
    }
  )

  test('rolls back preceding writes when a basket mapping is missing and accepts a coherent retry', async () => {
    const storage = new StorageKnex({
      ...StorageKnex.defaultOptions(),
      chain: 'test',
      knex: knex({
        client: 'better-sqlite3',
        connection: { filename: ':memory:' },
        useNullAsDefault: true,
        pool: { min: 1, max: 1 }
      })
    })
    try {
      await storage.migrate('fixture', '1'.repeat(64))
      await storage.makeAvailable()
      await storage
        .knex('users')
        .insert({ userId: 1, identityKey: '02' + '11'.repeat(32), activeStorage: '1'.repeat(64) })
      await storage.knex('transactions').insert({
        transactionId: 1,
        userId: 1,
        status: 'completed',
        reference: 'fixture',
        satoshis: 0,
        description: 'fixture',
        isOutgoing: false
      })
      await storage.knex('output_baskets').insert({
        basketId: 77,
        userId: 1,
        name: 'mapped',
        numberOfDesiredUTXOs: 0,
        minimumDesiredUTXOValue: 0,
        isDeleted: false
      })
      const syncMap = mapping()
      const merge = async () =>
        storage.transaction(async trx => {
          const first = incoming()
          first.basketId = undefined
          first.vout = 0
          await first.mergeNew(storage, 1, syncMap, trx)
          const second = incoming()
          second.vout = 1
          await second.mergeNew(storage, 1, syncMap, trx)
        })
      await expect(merge()).rejects.toThrow()
      expect(await storage.knex('outputs').select()).toEqual([])
      syncMap.outputBasket.idMap[9] = 77
      await merge()
      const outputs = await storage.findOutputs({ partial: { userId: 1 } })
      expect(outputs).toHaveLength(2)
      expect(outputs.find(output => output.vout === 1)?.basketId).toBe(77)
    } finally {
      await storage.destroy()
    }
  })
})
