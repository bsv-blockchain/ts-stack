import LookupResolver, { type LookupResolverConfig } from '../LookupResolver'
import { getOverlayHostReputationTracker } from '../HostReputationTracker'
import OverlayAdminTokenTemplate from '../OverlayAdminTokenTemplate'
import { CompletedProtoWallet } from '../../auth/certificates/__tests/CompletedProtoWallet'
import { PrivateKey } from '../../primitives/index'
import { Transaction } from '../../transaction/index'

const tracker = 'https://tracker.example'
const host = 'https://host.example'
const question = { service: 'ls_timeout', query: {} }

describe('LookupResolver tracker timeout configuration', () => {
  beforeEach(() => {
    getOverlayHostReputationTracker().reset()
    jest.useFakeTimers()
  })
  afterEach(() => jest.useRealTimers())

  it('preserves the five-second discovery cap independently of host and whole-query timeouts', async () => {
    const lookup = jest.fn(() => new Promise<never>(() => {}))
    const resolver = new LookupResolver({ slapTrackers: [tracker], facilitator: { lookup } })
    const pending = resolver.queryDetailed(question, 20_000, { deadlineMs: 25_000 })
    const rejected = expect(pending).rejects.toThrow('No competent mainnet hosts')
    await jest.advanceTimersByTimeAsync(4_999)
    expect(lookup).toHaveBeenCalledWith(
      tracker,
      { service: 'ls_slap', query: { service: question.service } },
      5_000,
      expect.any(AbortSignal),
      expect.any(Object)
    )
    expect(lookup.mock.calls[0][3].aborted).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    await rejected
    expect(lookup.mock.calls[0][3].aborted).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('accepts a delayed signed discovery response while retaining the requested host timeout', async () => {
    const token = new OverlayAdminTokenTemplate(new CompletedProtoWallet(new PrivateKey(101)))
    const lockingScript = await token.lock('SLAP', host, question.service)
    const transaction = new Transaction(1, [], [{ lockingScript, satoshis: 1 }], 0)
    const receipt = { beef: transaction.toBEEF(), outputIndex: 0 }
    const lookup = jest.fn(async (url: string) => {
      if (url === tracker) {
        await new Promise(resolve => setTimeout(resolve, 6_000))
        return { type: 'output-list' as const, outputs: [receipt] }
      }
      return { type: 'output-list' as const, outputs: [] }
    })
    const config: LookupResolverConfig = {
      trackerTimeoutMs: 20_000,
      slapTrackers: [tracker],
      facilitator: { lookup }
    }
    const resolver = new LookupResolver(config)
    config.trackerTimeoutMs = 1
    const pending = resolver.queryDetailed(question, 1_000, { deadlineMs: 25_000 })
    await jest.advanceTimersByTimeAsync(6_100)
    await expect(pending).resolves.toMatchObject({ answer: { type: 'output-list', outputs: [] } })
    expect(lookup.mock.calls.map(call => [call[0], call[2]])).toEqual([
      [tracker, 20_000],
      [host, 1_000]
    ])
    expect(jest.getTimerCount()).toBe(0)
  })

  it.each([
    [250, 10_000],
    [20_000, 1_000]
  ])(
    'keeps tracker timeout %i and whole-query deadline %i independently bounded',
    async (trackerTimeoutMs, deadlineMs) => {
      const lookup = jest.fn(() => new Promise<never>(() => {}))
      const resolver = new LookupResolver({
        trackerTimeoutMs,
        slapTrackers: [tracker],
        facilitator: { lookup }
      })
      const pending = resolver.queryDetailed(question, 30_000, { deadlineMs })
      const rejected = expect(pending).rejects.toThrow()
      await jest.advanceTimersByTimeAsync(Math.min(trackerTimeoutMs, deadlineMs))
      await rejected
      expect(lookup.mock.calls[0][3].aborted).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
    }
  )

  it('does not change configured-host routing or its per-host timeout', async () => {
    const lookup = jest.fn(async () => ({ type: 'output-list' as const, outputs: [] }))
    const resolver = new LookupResolver({
      trackerTimeoutMs: 20_000,
      hostOverrides: { [question.service]: [host] },
      facilitator: { lookup }
    })
    const pending = resolver.queryDetailed(question, 7_000)
    await jest.advanceTimersByTimeAsync(100)
    await pending
    expect(lookup.mock.calls).toEqual([
      [host, question, 7_000, expect.any(AbortSignal), expect.any(Object)]
    ])
  })

  it.each([0, -1, 1.5, NaN, Infinity, 60_001, null, '20000'])(
    'rejects invalid tracker timeout %p',
    value => {
      expect(() => new LookupResolver({ trackerTimeoutMs: value as number })).toThrow(RangeError)
    }
  )

  it.each([1, 60_000])('accepts supported tracker timeout boundary %i', trackerTimeoutMs => {
    expect(() => new LookupResolver({ trackerTimeoutMs })).not.toThrow()
  })
})
