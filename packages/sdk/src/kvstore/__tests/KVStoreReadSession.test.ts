import { KVStoreReadSession } from '../KVStoreReadSession'
import type { KVStoreReadResult } from '../ReliableKVStore'
const evidence = { completedHosts: 1, failedHosts: 0, discoveryComplete: true, durationMs: 5 }
const data: KVStoreReadResult = {
  kind: 'data',
  entries: [{ key: 'fixture', value: 'synthetic', controller: 'fixture', protocolID: [1, 'test'] }],
  completeness: 'complete',
  freshness: 'observed',
  evidence
}
const unavailable: KVStoreReadResult = { kind: 'unavailable', retryable: true, evidence }
describe('shared UI lifecycle', () => {
  afterEach(() => jest.useRealTimers())
  it('preserves data on failure, exposes retry, and recovers automatically', async () => {
    jest.useFakeTimers()
    const read = jest
      .fn()
      .mockResolvedValueOnce(data)
      .mockResolvedValueOnce(unavailable)
      .mockResolvedValue(data)
    const change = jest.fn()
    const session = new KVStoreReadSession(read, change)
    await session.refresh()
    await session.refresh()
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({
        refreshing: false,
        result: expect.objectContaining({ kind: 'stale' })
      })
    )
    await jest.advanceTimersByTimeAsync(2000)
    expect(read).toHaveBeenCalledTimes(3)
    expect(change).toHaveBeenLastCalledWith({ refreshing: false, result: data })
    session.stop()
  })
  it('retry coalesces and stop aborts pending work without an empty UI update', async () => {
    let signal: AbortSignal | undefined
    let finish: (result: KVStoreReadResult) => void = () => {}
    const read = jest.fn(async s => {
      signal = s
      return await new Promise<KVStoreReadResult>(resolve => {
        finish = resolve
      })
    })
    const change = jest.fn()
    const session = new KVStoreReadSession(read, change)
    const a = session.refresh()
    const b = session.refresh()
    await Promise.resolve()
    session.stop()
    expect(signal?.aborted).toBe(true)
    finish(unavailable)
    await Promise.all([a, b])
    expect(read).toHaveBeenCalledTimes(1)
    expect(change).toHaveBeenCalledTimes(1)
  })
})
