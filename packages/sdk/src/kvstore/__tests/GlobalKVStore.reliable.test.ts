import GlobalKVStore from '../ReliableGlobalKVStore'
import LookupResolver from '../../overlay-tools/ReliableLookupResolver'
import HTTPSOverlayLookupFacilitator from '../../overlay-tools/ReliableHTTPSLookupFacilitator'
import { ReliableHostReputation } from '../../overlay-tools/ReliableHostReputation'
import { KVStoreReadState, confirmKVWrite, KVStoreWriteError } from '../ReliableKVStore'
import { fixture, chainTracker } from './fixtures/reliableKV'

const good = 'https://good.example'
const bad = 'https://bad.example'
const empty = { type: 'output-list' as const, outputs: [] }
const sleep = async (ms: number) => await new Promise(resolve => setTimeout(resolve, ms))

describe('verified KV reliability', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => {
    f = await fixture()
  })
  afterEach(() => jest.useRealTimers())
  function setup(lookup: jest.Mock, hosts = [good, bad], authoritativeHosts = hosts) {
    const resolver = new LookupResolver({
      facilitator: { lookup },
      hostOverrides: { ls_kvstore: hosts }
    })
    return new GlobalKVStore({
      lookupResolver: resolver,
      reliability: { chainTracker, authoritativeHosts }
    })
  }
  async function advance<T>(promise: Promise<T>, ms = 5000): Promise<T> {
    await jest.advanceTimersByTimeAsync(ms)
    return await promise
  }
  it('one healthy host returns verified data and exact txid', async () => {
    const store = setup(
      jest.fn(async () => ({ ...empty, outputs: [f.output] })),
      [good]
    )
    const result = await store.getResult(f.query)
    expect(result).toMatchObject({
      kind: 'data',
      completeness: 'complete',
      entries: [{ value: 'synthetic value', token: { txid: f.tx.id('hex') } }]
    })
  })
  it.each([20000, Infinity])(
    'healthy host survives another with delay %s under one deadline',
    async delay => {
      jest.useFakeTimers()
      const lookup = jest.fn(async (host: string) => {
        if (host === bad) {
          if (delay === Infinity) await new Promise(() => {})
          else await sleep(delay)
        }
        return { ...empty, outputs: [f.output] }
      })
      const result = await advance(setup(lookup).getResult(f.query), 2100)
      expect(result).toMatchObject({
        kind: 'data',
        completeness: 'partial',
        evidence: { failedHosts: 1, durationMs: 2000 }
      })
    }
  )
  it('fastest empty cannot beat delayed valid data', async () => {
    jest.useFakeTimers()
    const lookup = jest.fn(async (host: string) => {
      await sleep(host === good ? 800 : 10)
      return host === good ? { ...empty, outputs: [f.output] } : empty
    })
    const result = await advance(setup(lookup).getResult(f.query))
    expect(result).toMatchObject({ kind: 'data', completeness: 'partial' })
  })
  it('unanimous configured authoritative empties distinguish absence', async () => {
    expect(await setup(jest.fn(async () => empty)).getResult(f.query)).toMatchObject({
      kind: 'absent'
    })
    expect(
      await setup(
        jest.fn(async () => empty),
        [good],
        []
      ).getResult(f.query)
    ).toMatchObject({ kind: 'incomplete' })
  })
  it('all unavailable is explicit and bounded', async () => {
    jest.useFakeTimers()
    expect(
      await advance(setup(jest.fn(async () => await new Promise(() => {}))).getResult(f.query))
    ).toMatchObject({ kind: 'unavailable', retryable: true, evidence: { durationMs: 2000 } })
  })
  it.each([404, 429, 500])('HTTP %s remains a failure rather than absence', async status => {
    const facilitator = new HTTPSOverlayLookupFacilitator(
      jest.fn(async () => new Response('', { status }))
    )
    const resolver = new LookupResolver({ facilitator, hostOverrides: { ls_kvstore: [good] } })
    const store = new GlobalKVStore({
      lookupResolver: resolver,
      reliability: { chainTracker, authoritativeHosts: [good] }
    })
    expect((await store.getResult(f.query)).kind).toBe(status === 404 ? 'rejected' : 'unavailable')
  })
  it.each([
    { type: 'output-list', outputs: [{ beef: [1, 2, 3], outputIndex: 0 }] },
    { type: 'output-list', outputs: 'invalid' },
    { type: 'freeform', result: null }
  ])('malformed peer cannot poison valid peer: %j', async answer => {
    const store = setup(
      jest.fn(async host => (host === good ? { ...empty, outputs: [f.output] } : answer))
    )
    expect(await store.getResult(f.query)).toMatchObject({ kind: 'data', completeness: 'partial' })
  })
  it('all invalid proofs never become empty', async () => {
    const altered = { ...f.output, txid: '00'.repeat(32) }
    expect(
      await setup(jest.fn(async () => ({ ...empty, outputs: [altered] }))).getResult(f.query)
    ).toMatchObject({ kind: 'malformed' })
  })
  it('wrong query selector never validates', async () => {
    expect(
      await setup(jest.fn(async () => ({ ...empty, outputs: [f.output] }))).getResult({
        ...f.query,
        key: 'another key'
      })
    ).toMatchObject({ kind: 'malformed' })
  })
  it('cryptographically valid successor replaces stale predecessor', async () => {
    const successor = await fixture('updated', f.tx)
    const store = setup(
      jest.fn(async host => ({ ...empty, outputs: [host === good ? successor.output : f.output] }))
    )
    expect(await store.getResult(f.query)).toMatchObject({
      kind: 'data',
      entries: [{ value: 'updated' }]
    })
  })
  it('two valid incomparable states are a conflict', async () => {
    const competitor = await fixture('competing')
    const store = setup(
      jest.fn(async host => ({ ...empty, outputs: [host === good ? competitor.output : f.output] }))
    )
    expect(await store.getResult(f.query)).toMatchObject({ kind: 'conflict' })
  })
  it('deduplicates verified output identity', async () => {
    expect(
      await setup(jest.fn(async () => ({ ...empty, outputs: [f.output, f.output] }))).getResult(
        f.query
      )
    ).toMatchObject({ kind: 'data', entries: [expect.any(Object)] })
  })
  it('aborts HTTP requests when the operation deadline expires', async () => {
    jest.useFakeTimers()
    const signals: AbortSignal[] = []
    const fetch = jest.fn(async (_url, init) => {
      signals.push(init.signal)
      return await new Promise<Response>(() => {})
    })
    const resolver = new LookupResolver({
      facilitator: new HTTPSOverlayLookupFacilitator(fetch),
      hostOverrides: { ls_kvstore: [good] }
    })
    await advance(
      resolver.queryReliable(
        { service: 'ls_kvstore', query: {} },
        { validate: async () => [], deadlineMs: 100, hostTimeoutMs: 2000 }
      )
    )
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(true)
  })
  it('recovered host recorded in v4 cooldown is probed and rehabilitated', async () => {
    const values = new Map<string, string>()
    const storage = {
      get: async key => values.get(key),
      update: async (key, transform) => {
        values.set(key, transform(values.get(key)))
      }
    }
    const reputation = new ReliableHostReputation(storage)
    await reputation.record('mainnet', 'ls_kvstore', good, 'invalid')
    const resolver = new LookupResolver({
      facilitator: { lookup: jest.fn(async () => ({ ...empty, outputs: [f.output] })) },
      reliableReputationStorage: storage,
      hostOverrides: { ls_kvstore: [good] }
    })
    const store = new GlobalKVStore({
      lookupResolver: resolver,
      reliability: { chainTracker, authoritativeHosts: [good] }
    })
    expect((await store.getResult(f.query)).kind).toBe('data')
    await Promise.resolve()
    expect(
      JSON.parse(values.get('bsvsdk_overlay_host_reputation_v4')!).entries[
        JSON.stringify(['mainnet', 'ls_kvstore', good])
      ].penalty
    ).toBe(0)
  })
  it('retains last-known-good during failures and clears it on account change', async () => {
    const state = new KVStoreReadState()
    const data = await setup(
      jest.fn(async () => ({ ...empty, outputs: [f.output] })),
      [good]
    ).getResult(f.query)
    state.apply(data)
    const failure = {
      kind: 'unavailable' as const,
      retryable: true as const,
      evidence: data.evidence
    }
    expect(state.apply(failure)).toMatchObject({
      kind: 'stale',
      entries: [{ value: 'synthetic value' }]
    })
    state.clear()
    expect(state.apply(failure).kind).toBe('unavailable')
  })
  it('indexing delay confirms the same write without constructing retries', async () => {
    jest.useFakeTimers()
    const data = await setup(
      jest.fn(async () => ({ ...empty, outputs: [f.output] })),
      [good]
    ).getResult(f.query)
    const read = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'incomplete', evidence: data.evidence })
      .mockResolvedValue(data)
    expect(await advance(confirmKVWrite(read, `${f.tx.id('hex')}.0`))).toBe(true)
    expect(read).toHaveBeenCalledTimes(2)
  })
  it('returned broadcast errors fail reliable writes', async () => {
    const store = setup(jest.fn(), [good])
    ;(store as any).topicBroadcaster.broadcast = jest.fn(async () => ({
      status: 'error',
      code: 'ERR_REJECTED',
      description: 'synthetic'
    }))
    await expect((store as any).submitToOverlay(f.tx)).rejects.toBeInstanceOf(KVStoreWriteError)
  })
})

describe('read validation boundaries', () => {
  it('rejects an untrusted Merkle root rather than accepting a structurally valid BEEF', async () => {
    const f = await fixture('untrusted')
    const resolver = new LookupResolver({
      facilitator: { lookup: async () => ({ type: 'output-list', outputs: [f.output] }) },
      hostOverrides: { ls_kvstore: [good] }
    })
    const store = new GlobalKVStore({
      lookupResolver: resolver,
      reliability: {
        chainTracker: { currentHeight: async () => 100, isValidRootForHeight: async () => false },
        authoritativeHosts: [good]
      }
    })
    expect(await store.getResult(f.query)).toMatchObject({ kind: 'malformed' })
  })
  it('does not replace a last-known successor with its stale predecessor', async () => {
    const old = await fixture('earlier')
    const latest = await fixture('later', old.tx)
    let output = latest.output
    const resolver = new LookupResolver({
      facilitator: { lookup: async () => ({ type: 'output-list', outputs: [output] }) },
      hostOverrides: { ls_kvstore: [good] }
    })
    const store = new GlobalKVStore({
      lookupResolver: resolver,
      reliability: { chainTracker, authoritativeHosts: [good] }
    })
    const state = new KVStoreReadState()
    state.apply(await store.getResult(latest.query))
    output = old.output
    expect(state.apply(await store.getResult(old.query))).toMatchObject({
      kind: 'stale',
      entries: [{ value: 'later' }]
    })
  })
  it('rejects an oversized HTTP body before parsing', async () => {
    const facilitator = new HTTPSOverlayLookupFacilitator(
      jest.fn(async () => new Response('x', { headers: { 'content-length': '5000000' } }))
    )
    await expect(facilitator.lookup(good, { service: 'ls_kvstore', query: {} })).rejects.toThrow(
      /malformed/i
    )
  })
})

describe('pending write idempotence within a runtime', () => {
  it('blocks another transaction until an ambiguous write is reconciled', async () => {
    const { author } = await import('./fixtures/reliableKV')
    const f = await fixture('pending write')
    const resolver = new LookupResolver({
      facilitator: { lookup: async () => ({ type: 'output-list', outputs: [f.output] }) },
      hostOverrides: { ls_kvstore: [good] }
    })
    const store = new GlobalKVStore({
      wallet: author as any,
      lookupResolver: resolver,
      protocolID: f.query.protocolID,
      reliability: { chainTracker, authoritativeHosts: [good] }
    })
    const first = jest.fn(async () => {
      throw (store as any).submissionError('unconfirmed', f.tx)
    })
    const next = jest.fn(async () => 'another transaction')
    await expect(
      (store as any).write(f.query.key, f.query.protocolID, first)
    ).rejects.toBeInstanceOf(KVStoreWriteError)
    await expect(
      (store as any).write(f.query.key, f.query.protocolID, next)
    ).rejects.toBeInstanceOf(KVStoreWriteError)
    expect(next).not.toHaveBeenCalled()
    const resend = jest.fn(async () => ({ status: 'success', txid: f.tx.id('hex') }))
    ;(store as any).topicBroadcaster.broadcast = resend
    expect(await store.reconcilePendingWrite(f.query.key, f.query.protocolID)).toBe(true)
    expect(resend).toHaveBeenCalledTimes(1)
    expect(resend).toHaveBeenCalledWith(f.tx)
    expect(await (store as any).write(f.query.key, f.query.protocolID, next)).toBe(
      'another transaction'
    )
  })
})

it('proof infrastructure failure is unavailable rather than blaming a host or reporting absence', async () => {
  const f = await fixture('proof service unavailable')
  const resolver = new LookupResolver({
    facilitator: { lookup: async () => ({ type: 'output-list', outputs: [f.output] }) },
    hostOverrides: { ls_kvstore: [good] }
  })
  const store = new GlobalKVStore({
    lookupResolver: resolver,
    reliability: {
      chainTracker: {
        currentHeight: async () => 100,
        isValidRootForHeight: async () => {
          throw new Error('offline')
        }
      },
      authoritativeHosts: [good]
    }
  })
  expect(await store.getResult(f.query)).toMatchObject({ kind: 'unavailable' })
})

it('requires a runtime-validated chain tracker instead of silently using a default network', () => {
  expect(() => new GlobalKVStore({ reliability: {} } as any)).toThrow('explicit chain tracker')
})

it('waits for indexing before acknowledging a competing replacement to the retry helper', async () => {
  const { ReliableTopicBroadcaster } = await import('../../overlay-tools/ReliableTopicBroadcaster')
  const f = await fixture('competing replacement')
  const broadcast = jest
    .spyOn(ReliableTopicBroadcaster.prototype, 'broadcast')
    .mockResolvedValue({ status: 'success', txid: f.tx.id('hex'), message: 'synthetic' })
  jest.useFakeTimers()
  const lookup = jest
    .fn()
    .mockResolvedValueOnce({ type: 'output-list', outputs: [] })
    .mockResolvedValue({ type: 'output-list', outputs: [f.output] })
  const resolver = new LookupResolver({
    facilitator: { lookup },
    hostOverrides: { ls_kvstore: [good] }
  })
  const store = new GlobalKVStore({
    lookupResolver: resolver,
    reliability: { chainTracker, authoritativeHosts: [good] }
  })
  try {
    const pending = (store as any).topicBroadcaster.broadcast(f.tx)
    await jest.advanceTimersByTimeAsync(500)
    expect(await pending).toMatchObject({ status: 'success' })
    expect(broadcast).toHaveBeenCalledTimes(1)
    expect(lookup).toHaveBeenCalledTimes(2)
  } finally {
    broadcast.mockRestore()
    jest.useRealTimers()
  }
})
