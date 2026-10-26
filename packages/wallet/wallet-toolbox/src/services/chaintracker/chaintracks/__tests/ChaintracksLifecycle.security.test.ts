import { Chaintracks } from '../Chaintracks'

function makeChaintracks(overrides: Record<string, unknown> = {}): {
  chaintracks: Chaintracks
  storage: Record<string, any>
  bulk: Record<string, jest.Mock>
  live: Record<string, jest.Mock>
} {
  const storage = {
    log: jest.fn(),
    migrateLatest: jest.fn(async () => {}),
    bulkManager: { destroy: jest.fn(async () => {}), getStats: jest.fn(() => ({})) },
    destroy: jest.fn(async () => {}),
    ...overrides
  }
  const bulk = {
    setStorage: jest.fn(async () => {}),
    shutdown: jest.fn(async () => {}),
    getPresentHeight: jest.fn(async () => undefined)
  }
  const live = {
    setStorage: jest.fn(async () => {}),
    startListening: jest.fn(async () => {}),
    stopListening: jest.fn(),
    shutdown: jest.fn(async () => {}),
    getHeaderByHash: jest.fn(async () => undefined)
  }
  const chaintracks = new Chaintracks({
    chain: 'main',
    storage: storage as never,
    bulkIngestors: [bulk as never],
    liveIngestors: [live as never],
    addLiveRecursionLimit: 36,
    readonly: false
  })
  return { chaintracks, storage, bulk, live }
}

describe('Chaintracks lifecycle and callback security boundaries', () => {
  test('propagates startListening initialization failures', async () => {
    const { chaintracks } = makeChaintracks()
    const failure = new Error('initialization failed')
    jest.spyOn(chaintracks, 'makeAvailable').mockRejectedValue(failure)

    await expect(chaintracks.startListening()).rejects.toBe(failure)
  })

  test('clears stale startup state, permits retry, and cleans up a failed instance', async () => {
    const first = new Error('first migration failure')
    const second = new Error('second migration failure')
    const migrateLatest = jest.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(second)
    const { chaintracks, storage, bulk, live } = makeChaintracks({ migrateLatest })

    await expect(chaintracks.makeAvailable()).rejects.toBe(first)
    await expect(chaintracks.makeAvailable()).rejects.toBe(second)
    expect(migrateLatest).toHaveBeenCalledTimes(2)
    expect(live.stopListening).toHaveBeenCalledTimes(2)
    expect(chaintracks.getAvailabilitySnapshot().startupError).toBe(second.message)

    await expect(chaintracks.destroy()).resolves.toBeUndefined()
    expect(live.shutdown).toHaveBeenCalledTimes(1)
    expect(bulk.shutdown).toHaveBeenCalledTimes(1)
    expect(storage.bulkManager.destroy).toHaveBeenCalledTimes(1)
    expect(storage.destroy).toHaveBeenCalledTimes(1)
    await expect(chaintracks.destroy()).resolves.toBeUndefined()
    expect(storage.destroy).toHaveBeenCalledTimes(1)
  })

  test('deletes subscriptions and isolates callback arguments from sibling listeners', async () => {
    const { chaintracks } = makeChaintracks()
    const seen: string[] = []
    const header = {
      version: 1,
      previousHash: '00'.repeat(32),
      merkleRoot: '11'.repeat(32),
      time: 1,
      bits: 1,
      nonce: 1,
      height: 2,
      hash: '22'.repeat(32)
    }
    const firstId = await chaintracks.subscribeHeaders(received => {
      received.hash = 'ff'.repeat(32)
    })
    await chaintracks.subscribeHeaders(received => seen.push(received.hash))

    ;(chaintracks as any).notifyHeaderListeners(header)
    expect(seen).toEqual([header.hash])
    await expect(chaintracks.unsubscribe(firstId)).resolves.toBe(true)
    expect(Object.prototype.hasOwnProperty.call((chaintracks as any).callbacks.header, firstId)).toBe(false)
    await expect(chaintracks.unsubscribe(firstId)).resolves.toBe(false)
    await expect(chaintracks.subscribeHeaders(null as never)).rejects.toThrow('header listener')
  })
})
