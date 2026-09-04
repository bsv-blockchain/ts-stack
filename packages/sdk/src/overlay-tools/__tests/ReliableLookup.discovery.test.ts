import LookupResolver from '../ReliableLookupResolver'
import OverlayAdminTokenTemplate from '../OverlayAdminTokenTemplate'
import Transaction from '../../transaction/Transaction'
import { author } from '../../kvstore/__tests/fixtures/reliableKV'
import { withKVWriteLock } from '../../kvstore/withKVWriteLock'
const good = 'https://good.example'
const retired = 'https://retired.example'
const empty = { type: 'output-list' as const, outputs: [] }
describe('reliable discovery and local write serialization', () => {
  afterEach(() => jest.useRealTimers())
  async function advertisement(host: string) {
    const lockingScript = await new OverlayAdminTokenTemplate(author as any).lock(
      'SLAP',
      host,
      'ls_kvstore'
    )
    return {
      beef: new Transaction(1, [], [{ lockingScript, satoshis: 1 }], 0).toBEEF(),
      outputIndex: 0
    }
  }
  it('collects the later tracker candidate despite a retired first advertisement', async () => {
    const stale = await advertisement(retired)
    const fresh = await advertisement(good)
    jest.useFakeTimers()
    const lookup = jest.fn(async host => {
      if (host === 'https://first.example') return { ...empty, outputs: [stale] }
      if (host === 'https://second.example') {
        await new Promise(resolve => setTimeout(resolve, 400))
        return { ...empty, outputs: [fresh] }
      }
      if (host === retired) return await new Promise(() => {})
      return empty
    })
    const resolver = new LookupResolver({
      facilitator: { lookup },
      slapTrackers: ['https://first.example', 'https://second.example']
    })
    const pending = resolver.queryReliable(
      { service: 'ls_kvstore', query: {} },
      { validate: async () => ['validated fixture'] }
    )
    await jest.advanceTimersByTimeAsync(5000)
    const result = await pending
    expect(result.hosts).toContainEqual({
      host: good,
      kind: 'answer',
      values: ['validated fixture']
    })
    expect(result.durationMs).toBe(2400)
  })
  it('does not cache failed discovery across attempts', async () => {
    const fresh = await advertisement(good)
    let recovered = false
    const lookup = jest.fn(async host =>
      host === good ? empty : recovered ? { ...empty, outputs: [fresh] } : empty
    )
    const resolver = new LookupResolver({
      facilitator: { lookup },
      slapTrackers: ['https://tracker.example']
    })
    const question = { service: 'ls_kvstore', query: {} }
    expect(
      (await resolver.queryReliable(question, { validate: async () => [] })).hosts
    ).toHaveLength(0)
    recovered = true
    expect(
      (await resolver.queryReliable(question, { validate: async () => [] })).hosts
    ).toHaveLength(1)
  })
  it('serializes competing operations across store instances and releases after failure', async () => {
    jest.useFakeTimers()
    const timeline: string[] = []
    const a = withKVWriteLock('synthetic scope', async () => {
      timeline.push('a:start')
      await new Promise(resolve => setTimeout(resolve, 50))
      timeline.push('a:end')
      throw new Error('synthetic')
    }).catch(() => {})
    const b = withKVWriteLock('synthetic scope', async () => {
      timeline.push('b:start')
    })
    await jest.advanceTimersByTimeAsync(60)
    await Promise.all([a, b])
    expect(timeline).toEqual(['a:start', 'a:end', 'b:start'])
  })
})
