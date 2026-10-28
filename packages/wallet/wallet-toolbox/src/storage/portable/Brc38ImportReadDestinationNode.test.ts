import { previewDestinationFixture, previewReceiptPolicy as policy } from './Brc38ImportPreviewFixture'
import {
  captureBrc38KnexDestinationFence,
  withBrc38KnexImportReadDestination,
  withBrc38KnexDestinationFence
} from './Brc38KnexDestinationFence'

describe('actual owned read-only destination preparation', () => {
  let target: Awaited<ReturnType<typeof previewDestinationFixture>>
  beforeEach(async () => {
    target = await previewDestinationFixture()
  })
  afterEach(async () => await target?.close())
  const selection = {
    identityKey: 'original-identity',
    chain: 'test' as const,
    targetStorageIdentityKey: 'synthetic target',
    mode: 'merge' as const
  }
  test('physical query-only preparation refuses writes and cannot contaminate the original provider pool', async () => {
    await expect(
      withBrc38KnexImportReadDestination(target.storage, selection, policy, async (trx, actual) => {
        expect(actual.userId).toBeNull()
        expect(await trx.raw('PRAGMA query_only')).toEqual([{ query_only: 1 }])
        await trx('users').insert({
          userId: 7,
          identityKey: 'original-identity',
          activeStorage: '',
          created_at: 1,
          updated_at: 1
        })
      })
    ).rejects.toThrow('readonly')
    expect(await target.k('users')).toEqual([])
    await target.storage.insertMonitorEvent({
      id: 0,
      created_at: new Date(),
      updated_at: new Date(),
      event: 'post read-only',
      details: 'separate provider'
    })
    expect(await target.k('monitor_events')).toHaveLength(1)
  })
  test('a separate WAL writer proceeds during held preparation while the read snapshot stays coherent', async () => {
    const before = await captureBrc38KnexDestinationFence(target.storage, selection, policy)
    await withBrc38KnexImportReadDestination(target.storage, selection, policy, async (trx, actual) => {
      expect(actual).toEqual(before)
      await target.writer('users').insert({
        userId: -7,
        identityKey: 'original-identity',
        activeStorage: '',
        created_at: 1,
        updated_at: 1
      })
      expect(await trx('users').where({ identityKey: selection.identityKey })).toEqual([])
    })
    const after = await captureBrc38KnexDestinationFence(target.storage, selection, policy)
    expect(after.userId).toBe(-7)
    // This independent raw SQL writer is not the source capture controller.
    // The profile fence still detects its actual mutation; S2 source-event
    // fanout/clock qualification remains a distinct whole-system requirement.
    expect(after).not.toEqual(before)
  })
  test('caller failure survives owned physical cleanup and releases the read transaction', async () => {
    const reason = new Error('bounded preparation failed')
    await expect(
      withBrc38KnexImportReadDestination(target.storage, selection, policy, async () => {
        throw reason
      })
    ).rejects.toBe(reason)
    await target.writer('users').insert({
      userId: 7,
      identityKey: 'original-identity',
      activeStorage: '',
      created_at: 1,
      updated_at: 1
    })
    expect(await target.k('users')).toHaveLength(1)
  })
  test('changing the actual read mode refuses preparation even when destination data stays unchanged', async () => {
    await expect(
      withBrc38KnexImportReadDestination(target.storage, selection, policy, async trx => {
        await trx.raw('PRAGMA query_only=OFF')
        expect(await trx.raw('PRAGMA query_only')).toEqual([{ query_only: 0 }])
        return 'unchanged destination'
      })
    ).rejects.toThrow('complete enabled owned SQLite generation')
    await withBrc38KnexImportReadDestination(target.storage, selection, policy, async trx => {
      expect(await trx.raw('PRAGMA query_only')).toEqual([{ query_only: 1 }])
    })
    expect(await target.k('users')).toEqual([])
  })
  test('away-and-back primary writes during a pinned preparation still refuse the subsequent stale writer', async () => {
    await target.storage.insertUser({
      userId: 7,
      identityKey: selection.identityKey,
      activeStorage: '',
      created_at: new Date(),
      updated_at: new Date()
    })
    const expected = await captureBrc38KnexDestinationFence(target.storage, selection, policy)
    await withBrc38KnexImportReadDestination(target.storage, selection, policy, async (_trx, actual) => {
      expect(actual).toEqual(expected)
      await target.writer('users').where({ userId: 7 }).update({ activeStorage: 'other primary' })
      await target.writer('users').where({ userId: 7 }).update({ activeStorage: '' })
    })
    const actual = await captureBrc38KnexDestinationFence(target.storage, selection, policy),
      apply = jest.fn()
    expect(actual.activeStorage).toBe(expected.activeStorage)
    expect(actual.primaryEpoch).not.toBe(expected.primaryEpoch)
    await expect(withBrc38KnexDestinationFence(target.storage, expected, policy, apply)).rejects.toThrow('changed')
    expect(apply).not.toHaveBeenCalled()
  })
})
