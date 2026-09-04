import { ReliableHostReputation } from '../ReliableHostReputation'
const KEY = 'bsvsdk_overlay_host_reputation_v4'
const h1 = 'https://one.example'
const h2 = 'https://two.example'
function storage() {
  const data = new Map<string, string>()
  let pending = Promise.resolve()
  return {
    data,
    get: async (key: string) => data.get(key),
    update: (key: string, transform: (raw: string | null | undefined) => string): Promise<void> => {
      const result = pending.then(() => {
        data.set(key, transform(data.get(key)))
      })
      pending = result.catch(() => {})
      return result
    }
  }
}
describe('versioned advisory reputation', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.setSystemTime(1000000)
  })
  afterEach(() => jest.useRealTimers())
  it.each(['{', 'null', '[]', '{"version":3,"entries":{}}', '{"version":4,"entries":null}'])(
    'fails open for corrupt/legacy schema %s',
    async raw => {
      const s = storage()
      s.data.set(KEY, raw)
      const tracker = new ReliableHostReputation(s)
      await tracker.refresh()
      expect(tracker.rank('mainnet', 'ls_kvstore', [h1, h2])).toEqual([h1, h2])
    }
  )
  it('does not import poisoned v1-v3 or mutate legacy browser records', async () => {
    const s = storage()
    for (const version of [1, 2, 3])
      s.data.set(`bsvsdk_overlay_host_reputation_v${version}`, 'poison')
    const tracker = new ReliableHostReputation(s)
    expect(tracker.rank('mainnet', 'ls_kvstore', [h1])).toEqual([h1])
    await tracker.record('mainnet', 'ls_kvstore', h1)
    expect(s.data.get('bsvsdk_overlay_host_reputation_v3')).toBe('poison')
  })
  it('isolates network and service', async () => {
    const tracker = new ReliableHostReputation(storage())
    await tracker.record('mainnet', 'ls_kvstore', h1, 'invalid')
    expect(tracker.rank('mainnet', 'ls_kvstore', [h1, h2])).toEqual([h2, h1])
    expect(tracker.rank('testnet', 'ls_kvstore', [h1, h2])).toEqual([h1, h2])
    expect(tracker.rank('mainnet', 'ls_ship', [h1, h2])).toEqual([h1, h2])
  })
  it.each([1, 1000000000])('expires penalties after clock moves to %s', async now => {
    const tracker = new ReliableHostReputation(storage())
    await tracker.record('mainnet', 'ls_kvstore', h1, 'invalid')
    jest.setSystemTime(now)
    expect(tracker.rank('mainnet', 'ls_kvstore', [h1, h2])).toEqual([h1, h2])
  })
  it('serializes concurrent tabs without dropping another host update', async () => {
    const s = storage()
    const a = new ReliableHostReputation(s)
    const b = new ReliableHostReputation(s)
    await Promise.all([
      a.record('mainnet', 'ls_kvstore', h1, 'timeout'),
      b.record('mainnet', 'ls_kvstore', h2, 'invalid')
    ])
    const entries = JSON.parse(s.data.get(KEY)!).entries
    expect(Object.keys(entries)).toHaveLength(2)
    expect(entries[JSON.stringify(['mainnet', 'ls_kvstore', h1])].penalty).toBeLessThan(
      entries[JSON.stringify(['mainnet', 'ls_kvstore', h2])].penalty
    )
  })
  it('bounded penalties decay and successful probes reset immediately', async () => {
    const s = storage()
    const tracker = new ReliableHostReputation(s)
    for (let i = 0; i < 100; i++) await tracker.record('mainnet', 'ls_kvstore', h1, 'invalid')
    let entry = Object.values(JSON.parse(s.data.get(KEY)!).entries)[0] as any
    expect(entry.penalty).toBe(64)
    expect(entry.cooldownUntil - entry.updatedAt).toBeLessThanOrEqual(30000)
    jest.advanceTimersByTime(60000)
    await tracker.record('mainnet', 'ls_kvstore', h1, 'timeout')
    entry = Object.values(JSON.parse(s.data.get(KEY)!).entries)[0] as any
    expect(entry.penalty).toBe(33)
    await tracker.record('mainnet', 'ls_kvstore', h1)
    expect(tracker.rank('mainnet', 'ls_kvstore', [h1, h2])).toEqual([h1, h2])
  })
  it('bounds serialized state size', async () => {
    const s = storage()
    const tracker = new ReliableHostReputation(s)
    for (let i = 0; i < 300; i++) {
      jest.advanceTimersByTime(1)
      await tracker.record('mainnet', 'ls_kvstore', `https://${i}.example`, 'timeout')
    }
    expect(Object.keys(JSON.parse(s.data.get(KEY)!).entries)).toHaveLength(256)
  })
})
