import { IDBFactory } from 'fake-indexeddb'
import { indexedDBReputationStorage } from '../IndexedDBReputationStorage'
import { ReliableHostReputation } from '../ReliableHostReputation'

const KEY = 'bsvsdk_overlay_host_reputation_v4'

describe('transactional browser reputation', () => {
  it('merges concurrent writers with independent prior reads', async () => {
    const factory = new IDBFactory()
    const a = indexedDBReputationStorage(factory)
    const b = indexedDBReputationStorage(factory)
    expect(await a.get(KEY)).toBeNull()
    expect(await b.get(KEY)).toBeNull()
    const trackers = [new ReliableHostReputation(a), new ReliableHostReputation(b)]
    await Promise.all(
      Array.from({ length: 32 }, (_, i) =>
        trackers[i % 2].record('mainnet', `ls_service_${i}`, 'https://one.example', 'transport')
      )
    )
    const reloaded = indexedDBReputationStorage(factory)
    const entries = JSON.parse((await reloaded.get(KEY))!).entries
    expect(Object.keys(entries)).toHaveLength(32)
    expect(Object.values(entries).every((entry: any) => entry.penalty === 2)).toBe(true)
  })

  it('serializes updates of the same key and refreshes reloaded ranking', async () => {
    const factory = new IDBFactory()
    const stores = [indexedDBReputationStorage(factory), indexedDBReputationStorage(factory)]
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const storage = stores[i % 2]
        return storage.update(KEY, current => String(Number(current ?? 0) + 1))
      })
    )
    expect(await stores[0].get(KEY)).toBe('20')
    const tracker = new ReliableHostReputation(stores[0])
    await tracker.record('mainnet', 'ls_service', 'https://one.example', 'invalid')
    const reloaded = new ReliableHostReputation(indexedDBReputationStorage(factory))
    await reloaded.refresh()
    expect(
      reloaded.rank('mainnet', 'ls_service', ['https://one.example', 'https://two.example'])
    ).toEqual(['https://two.example', 'https://one.example'])
  })

  it('aborts failed updates without changing committed data', async () => {
    const storage = indexedDBReputationStorage(new IDBFactory())
    await storage.update(KEY, () => 'committed')
    await expect(
      storage.update(KEY, () => {
        throw new Error('synthetic update failure')
      })
    ).rejects.toThrow('Reputation transaction aborted')
    expect(await storage.get(KEY)).toBe('committed')
  })

  it('rejects a malformed database without an uncaught event-handler error', async () => {
    const factory = new IDBFactory()
    await new Promise<void>((resolve, reject) => {
      const open = factory.open(KEY)
      open.onsuccess = () => {
        open.result.close()
        resolve()
      }
      open.onerror = () => reject(open.error)
    })
    const storage = indexedDBReputationStorage(factory)
    await expect(storage.get(KEY)).rejects.toBeDefined()
    await expect(
      new ReliableHostReputation(storage).record('mainnet', 'ls_test', 'https://one.example')
    ).resolves.toBeUndefined()
  })

  it('fails open when browser database access is unavailable', async () => {
    const factory = new IDBFactory()
    jest.spyOn(factory, 'open').mockImplementation(() => {
      throw new Error('access denied')
    })
    const tracker = new ReliableHostReputation(indexedDBReputationStorage(factory))
    await expect(tracker.refresh()).rejects.toThrow('access denied')
    await expect(
      tracker.record('mainnet', 'ls_test', 'https://one.example', 'timeout')
    ).resolves.toBeUndefined()
    expect(tracker.rank('mainnet', 'ls_test', ['https://one.example'])).toEqual([
      'https://one.example'
    ])
  })
})
