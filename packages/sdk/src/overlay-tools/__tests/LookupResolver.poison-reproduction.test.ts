import LookupResolver from '../LookupResolver'
import { HostReputationTracker } from '../HostReputationTracker'
import { Transaction } from '../../transaction/index'
import { LockingScript } from '../../script/index'

// Synthetic local reproduction retained as evidence for the legacy API.
describe('legacy poisoned reputation reproduction', () => {
  const host = 'https://recovered.example'
  const empty = 'https://empty.example'
  const output = {
    beef: new Transaction(
      1,
      [],
      [{ lockingScript: LockingScript.fromHex('51'), satoshis: 1 }],
      0
    ).toBEEF(),
    outputIndex: 0
  }
  const tracker = (): HostReputationTracker =>
    new HostReputationTracker({
      get: () =>
        JSON.stringify({
          [host]: { host, backoffUntil: Date.now() + 365 * 86400000, lastUpdatedAt: Date.now() }
        }),
      set: () => {}
    })
  it('never contacts a reachable host with a future persisted cooldown', async () => {
    const lookup = jest.fn(async () => ({ type: 'output-list' as const, outputs: [output] }))
    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_kvstore: [host] },
      reputationStorage: {
        get: () => JSON.stringify({ [host]: tracker().snapshot(host) }),
        set: () => {}
      }
    })
    await expect(resolver.query({ service: 'ls_kvstore', query: {} })).rejects.toThrow(
      'backing off'
    )
    expect(lookup).not.toHaveBeenCalled()
  })
  it('returns empty while the reachable data host is excluded; reset immediately restores data', async () => {
    const lookup = jest.fn(async (url: string) => ({
      type: 'output-list' as const,
      outputs: url === host ? [output] : []
    }))
    const reputation = tracker()
    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_kvstore: [empty, host] },
      reputationStorage: {
        get: () => JSON.stringify({ [host]: reputation.snapshot(host) }),
        set: () => {}
      }
    })
    expect((await resolver.query({ service: 'ls_kvstore', query: {} })).outputs).toHaveLength(0)
    expect(lookup.mock.calls.map(call => call[0])).toEqual([empty])
    ;(resolver as any).hostReputation.reset()
    expect((await resolver.query({ service: 'ls_kvstore', query: {} })).outputs).toHaveLength(1)
  })
})

it('a normal persisted penalty becomes year-long exclusion after the browser clock is corrected', async () => {
  jest.useFakeTimers()
  const data = new Map<string, string>()
  const storage = {
    get: (key: string) => data.get(key),
    set: (key: string, value: string) => {
      data.set(key, value)
    }
  }
  const host = 'https://clock-recovered.example'
  try {
    jest.setSystemTime(new Date('2027-09-04T00:00:00Z'))
    const oldTab = new HostReputationTracker(storage)
    for (let i = 0; i < 8; i++) oldTab.recordFailure(host, new Error('Failed to fetch'))
    oldTab.flush()
    jest.setSystemTime(new Date('2026-09-04T00:00:00Z'))
    const lookup = jest.fn(async () => ({ type: 'output-list' as const, outputs: [] }))
    const reloaded = new LookupResolver({
      facilitator: { lookup },
      reputationStorage: storage,
      hostOverrides: { ls_kvstore: [host] }
    })
    await expect(reloaded.query({ service: 'ls_kvstore', query: {} })).rejects.toThrow(
      'backing off'
    )
    expect(lookup).not.toHaveBeenCalled()
    expect(
      new HostReputationTracker(storage).snapshot(host)!.backoffUntil - Date.now()
    ).toBeGreaterThan(300 * 86400000)
  } finally {
    jest.useRealTimers()
  }
})
