import { LookupResolver, LookupUnavailableError, LookupValidationError } from '../../../mod'
import { Transaction } from '../../transaction/index'
import { LockingScript } from '../../script/index'
import type { ReliableReputationStorage } from '../ReliableHostReputation'
import OverlayAdminTokenTemplate from '../OverlayAdminTokenTemplate'
import { CompletedProtoWallet } from '../../auth/certificates/__tests/CompletedProtoWallet'
import { PrivateKey } from '../../primitives/index'

const good = 'https://recovered.example'
const down = 'https://down.example'
const empty = { type: 'output-list' as const, outputs: [] }
const output = {
  beef: new Transaction(
    1,
    [],
    [{ lockingScript: LockingScript.fromHex('51'), satoshis: 1 }],
    0
  ).toBEEF(),
  outputIndex: 0
}
const answer = { ...empty, outputs: [output] }

function storageFixture(): { storage: ReliableReputationStorage; data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    storage: {
      get: key => data.get(key),
      set: (key, value) => {
        data.set(key, value)
      },
      lock: async (_name, action) => await action()
    }
  }
}

describe('standard package resolver reliability for every overlay service', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it.each(['ls_identity', 'ls_ship', 'ls_custom', 'ls_kvstore'])(
    'probes a cooled host and merges past a fast empty response for %s',
    async service => {
      const { storage, data } = storageFixture()
      const scope = JSON.stringify(['mainnet', service, good])
      data.set(
        'bsvsdk_overlay_host_reputation_v4',
        JSON.stringify({
          version: 4,
          entries: {
            [scope]: { updatedAt: Date.now(), cooldownUntil: Date.now() + 30000, penalty: 64 }
          }
        })
      )
      const lookup = jest.fn(async host => {
        if (host !== good) return empty
        await new Promise(resolve => setTimeout(resolve, 250))
        return answer
      })
      const resolver = new LookupResolver({
        facilitator: { lookup },
        reliableReputationStorage: storage,
        hostOverrides: { [service]: [down, good] }
      })
      const pending = resolver.query({ service, query: {} })
      await jest.advanceTimersByTimeAsync(250)
      expect((await pending).outputs).toEqual([output])
      expect(lookup).toHaveBeenCalledTimes(2)
      const healed = JSON.parse(data.get('bsvsdk_overlay_host_reputation_v4')!).entries[scope]
      expect(healed).toMatchObject({ cooldownUntil: 0, penalty: 0 })
    }
  )

  it.each(['query', 'queryDetailed', 'query$'] as const)(
    '%s bounds hung hosts for a non-KV service',
    async api => {
      const service = 'ls_custom'
      const signals: AbortSignal[] = []
      const lookup = jest.fn(async (host, _q, _ms, signal: AbortSignal) => {
        signals.push(signal)
        return host === good ? answer : await new Promise<never>(() => {})
      })
      const resolver = new LookupResolver({
        facilitator: { lookup },
        hostOverrides: { [service]: [good, down] }
      })
      const start = performance.now()
      const pending =
        api === 'query$'
          ? (async () => {
              const emissions = []
              for await (const result of resolver.query$({ service, query: {} }))
                emissions.push(result)
              return emissions.at(-1)!
            })()
          : resolver[api]({ service, query: {} })
      await jest.advanceTimersByTimeAsync(2000)
      const result = await pending
      expect(performance.now() - start).toBe(2000)
      expect('answer' in result ? result.answer.outputs : result.outputs).toEqual([output])
      if ('progress' in result)
        expect(result.progress).toMatchObject({
          status: 'incomplete',
          failedHosts: 1,
          successfulHosts: 1
        })
      if ('isFinal' in result)
        expect(result).toMatchObject({ status: 'incomplete', isFinal: true, failedHosts: 1 })
      expect(signals.every(signal => signal.aborted)).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
    }
  )

  it('includes discovery in the total deadline even with a non-cooperative host', async () => {
    const service = 'ls_custom'
    const wallet = new CompletedProtoWallet(new PrivateKey(42))
    const lockingScript = await new OverlayAdminTokenTemplate(wallet).lock('SLAP', down, service)
    const advertisement = {
      ...empty,
      outputs: [
        {
          beef: new Transaction(1, [], [{ lockingScript, satoshis: 1 }], 0).toBEEF(),
          outputIndex: 0
        }
      ]
    }
    const lookup = jest.fn(async (_host, q) => {
      if (q.service === 'ls_slap') {
        await new Promise(resolve => setTimeout(resolve, 1400))
        return advertisement
      }
      return await new Promise<never>(() => {})
    })
    const resolver = new LookupResolver({
      facilitator: { lookup },
      slapTrackers: ['https://tracker.example']
    })
    const pending = resolver.queryDetailed({ service, query: {} }, undefined, { deadlineMs: 1600 })
    await jest.advanceTimersByTimeAsync(1599)
    let done = false
    void pending.then(() => {
      done = true
    })
    await Promise.resolve()
    expect(done).toBe(false)
    await jest.advanceTimersByTimeAsync(1)
    expect((await pending).progress).toMatchObject({
      status: 'unavailable',
      completedHosts: 1,
      failedHosts: 1
    })
    expect(jest.getTimerCount()).toBe(0)
  })

  it('throws retryable unavailability instead of returning a failed empty aggregate', async () => {
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async () => {
          throw new Error('offline')
        }
      },
      hostOverrides: { ls_identity: [down] }
    })
    await expect(resolver.query({ service: 'ls_identity', query: {} })).rejects.toBeInstanceOf(
      LookupUnavailableError
    )
    await expect(resolver.query({ service: 'ls_identity', query: {} })).rejects.toMatchObject({
      retryable: true,
      progress: { status: 'unavailable', failedHosts: 1 }
    })
  })

  it('aborts outstanding requests when a progressive consumer closes the iterator', async () => {
    const signals: AbortSignal[] = []
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async (host, _q, _ms, signal) => {
          signals.push(signal!)
          return host === good ? answer : await new Promise<never>(() => {})
        }
      },
      hostOverrides: { ls_identity: [good, down] }
    })
    const pending = (async () => {
      for await (const result of resolver.query$({ service: 'ls_identity', query: {} })) {
        expect(result).toMatchObject({ isFinal: false, status: 'incomplete' })
        break
      }
    })()
    await jest.advanceTimersByTimeAsync(80)
    await pending
    expect(signals).toHaveLength(2)
    expect(signals.every(signal => signal.aborted)).toBe(true)
    expect(jest.getTimerCount()).toBe(0)
  })

  it('keeps soft snapshots non-final and continues with later data', async () => {
    const resolver = new LookupResolver({
      facilitator: {
        lookup: async () => {
          await new Promise(resolve => setTimeout(resolve, 400))
          return answer
        }
      },
      hostOverrides: { ls_identity: [good] }
    })
    const snapshots: Array<{ isFinal: boolean; outputs: unknown[]; status?: string }> = []
    const pending = (async () => {
      for await (const result of resolver.query$({ service: 'ls_identity', query: {} }, undefined, {
        softTimeoutMs: 50
      }))
        snapshots.push(result)
    })()
    await jest.advanceTimersByTimeAsync(500)
    await pending
    expect(snapshots[0]).toMatchObject({ isFinal: false, outputs: [], status: 'unavailable' })
    expect(snapshots.at(-1)).toMatchObject({ isFinal: true, outputs: [output], status: 'complete' })
  })

  it('exposes service-specific validation from the standard package export', async () => {
    const resolver = new LookupResolver({
      facilitator: { lookup: async host => (host === good ? answer : empty) },
      hostOverrides: { ls_custom: [good, down] }
    })
    const result = await resolver.queryReliable(
      { service: 'ls_custom', query: {} },
      {
        validate: async response => {
          if (response.outputs.length === 0) throw new LookupValidationError('invalid')
          return ['custom verified value']
        }
      }
    )
    expect(result.hosts).toContainEqual({
      host: good,
      kind: 'answer',
      values: ['custom verified value']
    })
    expect(result.hosts).toContainEqual({ host: down, kind: 'invalid' })
  })
  it.each([
    { ...output, beef: [1, 2, 3] },
    { ...output, txid: 'ff'.repeat(32) }
  ])('does not turn an unparseable BEEF or forged txid hint into empty success', async invalid => {
    const resolver = new LookupResolver({
      facilitator: { lookup: async () => ({ ...empty, outputs: [invalid] }) },
      hostOverrides: { ls_custom: [good] }
    })
    const result = await resolver.queryDetailed({ service: 'ls_custom', query: {} })
    expect(result.progress).toMatchObject({
      status: 'unavailable',
      successfulHosts: 0,
      failedHosts: 1
    })
  })

  it('does not carry one service failure into another service or network', async () => {
    const { storage, data } = storageFixture()
    const lookup = jest.fn(async (_host, question) => {
      if (question.service === 'ls_failed') throw new Error('offline')
      return answer
    })
    const resolver = new LookupResolver({
      facilitator: { lookup },
      reliableReputationStorage: storage,
      hostOverrides: { ls_failed: [good], ls_healthy: [good] }
    })
    await resolver.queryDetailed({ service: 'ls_failed', query: {} })
    await resolver.query({ service: 'ls_healthy', query: {} })
    const testnet = new LookupResolver({
      networkPreset: 'testnet',
      reliableReputationStorage: storage,
      facilitator: { lookup: async () => answer },
      hostOverrides: { ls_failed: [good] }
    })
    await testnet.query({ service: 'ls_failed', query: {} })
    const entries = JSON.parse(data.get('bsvsdk_overlay_host_reputation_v4')!).entries
    expect(entries[JSON.stringify(['mainnet', 'ls_failed', good])].penalty).toBe(2)
    expect(entries[JSON.stringify(['mainnet', 'ls_healthy', good])].penalty).toBe(0)
    expect(entries[JSON.stringify(['testnet', 'ls_failed', good])].penalty).toBe(0)
  })
})
