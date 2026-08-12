import { jest } from '@jest/globals'

import { CollectionIndexes } from '../shared/collectionIndexes.js'

/**
 * Opt-in repair for the production failure this package hit on overlay-us-1 and
 * overlay-ap-1: a collection that predates a unique index holds rows violating it, so the
 * build fails with E11000 forever. With OVERLAY_INDEX_REPAIR=true the offending duplicates
 * are removed (oldest row per key wins) and the build is retried. Deleting production rows
 * is never the default.
 */

const duplicateKeyError = (): Error =>
  Object.assign(new Error('Index build failed: E11000 duplicate key error'), {
    name: 'MongoServerError',
    code: 11000
  })

interface Harness {
  collection: any
  createIndex: jest.Mock
  deleteOne: jest.Mock
  aggregate: jest.Mock
}

const harness = (
  groups: Array<{ _id: Record<string, unknown>, n: number, docs: Array<{ id: string, createdAt?: Date }> }>,
  { failForever = false }: { failForever?: boolean } = {}
): Harness => {
  let attempts = 0
  const createIndex = jest.fn(async () => {
    attempts++
    if (failForever || attempts === 1) throw duplicateKeyError()
    return 'index'
  }) as unknown as jest.Mock
  const aggregate = jest.fn(() => ({ toArray: async () => groups })) as unknown as jest.Mock
  const deleteOne = jest.fn(async () => ({ acknowledged: true, deletedCount: 1 })) as unknown as jest.Mock
  return { collection: { createIndex, aggregate, deleteOne }, createIndex, deleteOne, aggregate }
}

const uniqueIndex = (collection: any): CollectionIndexes =>
  new CollectionIndexes('Test', () => [
    { label: 'txid_1_outputIndex_1', collection, keys: { txid: 1, outputIndex: 1 }, options: { unique: true } }
  ])

describe('CollectionIndexes duplicate repair', () => {
  const previous = process.env.OVERLAY_INDEX_REPAIR

  afterEach(() => {
    if (previous === undefined) delete process.env.OVERLAY_INDEX_REPAIR
    else process.env.OVERLAY_INDEX_REPAIR = previous
  })

  test('does nothing without the opt-in flag', async () => {
    delete process.env.OVERLAY_INDEX_REPAIR
    const { collection, deleteOne, aggregate } = harness([
      { _id: { f0: 't', f1: 0 }, n: 2, docs: [{ id: 'a' }, { id: 'b' }] }
    ])

    await expect(uniqueIndex(collection).ensure()).resolves.toBeUndefined()

    expect(aggregate).not.toHaveBeenCalled()
    expect(deleteOne).not.toHaveBeenCalled()
  })

  test('deletes the extra rows and rebuilds when opted in', async () => {
    process.env.OVERLAY_INDEX_REPAIR = 'true'
    const { collection, createIndex, deleteOne } = harness([
      {
        _id: { f0: 't', f1: 0 },
        n: 3,
        docs: [
          { id: 'newest', createdAt: new Date('2026-08-10T00:00:00Z') },
          { id: 'oldest', createdAt: new Date('2026-01-01T00:00:00Z') },
          { id: 'middle', createdAt: new Date('2026-05-01T00:00:00Z') }
        ]
      }
    ])

    await uniqueIndex(collection).ensure()

    // Oldest row survives; the other two go.
    const deleted = (deleteOne as jest.Mock).mock.calls.map((c: any[]) => c[0]._id)
    expect(deleted).toEqual(['middle', 'newest'])
    // Once to fail, once to rebuild after the repair.
    expect(createIndex).toHaveBeenCalledTimes(2)
  })

  test('treats a row with no createdAt as the extra, never the survivor', async () => {
    process.env.OVERLAY_INDEX_REPAIR = 'true'
    const { collection, deleteOne } = harness([
      {
        _id: { f0: 't', f1: 0 },
        n: 2,
        docs: [{ id: 'undated' }, { id: 'dated', createdAt: new Date('2026-05-01T00:00:00Z') }]
      }
    ])

    await uniqueIndex(collection).ensure()

    expect((deleteOne as jest.Mock).mock.calls.map((c: any[]) => c[0]._id)).toEqual(['undated'])
  })

  test('groups by the failing index\'s own key fields', async () => {
    process.env.OVERLAY_INDEX_REPAIR = 'true'
    const { collection, aggregate } = harness([])

    await uniqueIndex(collection).ensure()

    const [pipeline] = (aggregate as jest.Mock).mock.calls[0] as any[]
    expect(pipeline[0].$group._id).toEqual({ f0: '$txid', f1: '$outputIndex' })
    expect(pipeline[1].$match).toEqual({ n: { $gt: 1 } })
  })

  test('leaves non-unique indexes alone', async () => {
    process.env.OVERLAY_INDEX_REPAIR = 'true'
    const { collection, deleteOne, aggregate } = harness([
      { _id: { f0: 't' }, n: 2, docs: [{ id: 'a' }, { id: 'b' }] }
    ])
    const indexes = new CollectionIndexes('Test', () => [
      { label: 'txid_1', collection, keys: { txid: 1 } }
    ])

    await expect(indexes.ensure()).resolves.toBeUndefined()

    expect(aggregate).not.toHaveBeenCalled()
    expect(deleteOne).not.toHaveBeenCalled()
  })

  test('does not repair when the build failed for some other reason', async () => {
    process.env.OVERLAY_INDEX_REPAIR = 'true'
    const createIndex = jest.fn(async () => {
      throw new Error('not authorized on admin to execute command')
    }) as unknown as jest.Mock
    const aggregate = jest.fn(() => ({ toArray: async () => [] })) as unknown as jest.Mock
    const deleteOne = jest.fn(async () => ({ acknowledged: true, deletedCount: 0 })) as unknown as jest.Mock
    const indexes = uniqueIndex({ createIndex, aggregate, deleteOne })

    await expect(indexes.ensure()).resolves.toBeUndefined()

    expect(aggregate).not.toHaveBeenCalled()
    expect(deleteOne).not.toHaveBeenCalled()
  })

  test('still resolves when the rebuild fails after a repair', async () => {
    process.env.OVERLAY_INDEX_REPAIR = 'true'
    const { collection, deleteOne } = harness(
      [{ _id: { f0: 't', f1: 0 }, n: 2, docs: [{ id: 'a' }, { id: 'b' }] }],
      { failForever: true }
    )

    await expect(uniqueIndex(collection).ensure()).resolves.toBeUndefined()

    expect(deleteOne).toHaveBeenCalled()
  })
})
