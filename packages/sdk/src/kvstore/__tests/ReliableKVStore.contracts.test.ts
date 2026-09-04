import BaseKVStore from '../GlobalKVStore'
import {
  GlobalKVStore,
  LookupResolver,
  KVStoreReadSession,
  KVStoreReadState,
  KVStoreUnavailableError,
  KVStoreWriteError,
  validateKVAnswer,
  confirmKVWrite,
  type KVStoreReadResult
} from '../reliable'
import { ReliableTopicBroadcaster } from '../../overlay-tools/ReliableTopicBroadcaster'
import Transaction from '../../transaction/Transaction'
import { LockingScript } from '../../script/index'
import { author, chainTracker, fixture, protocol } from './fixtures/reliableKV'

const host = 'https://contracts.example'
const evidence = { completedHosts: 1, failedHosts: 0, discoveryComplete: true, durationMs: 1 }
const absent: KVStoreReadResult = { kind: 'absent', authority: 'configured-hosts', evidence }
const unavailable: KVStoreReadResult = { kind: 'unavailable', retryable: true, evidence }
const conflict: KVStoreReadResult = { kind: 'conflict', retryable: true, evidence }

describe('reliable KV public contracts', () => {
  let f: Awaited<ReturnType<typeof fixture>>
  let data: Extract<KVStoreReadResult, { kind: 'data' }>
  beforeAll(async () => {
    f = await fixture('contract value')
    const values = await validateKVAnswer(
      { type: 'output-list', outputs: [f.output] },
      f.query,
      chainTracker,
      new AbortController().signal
    )
    data = {
      kind: 'data',
      entries: values.map(v => v.entry),
      completeness: 'complete',
      freshness: 'observed',
      evidence
    }
  })
  afterEach(() => {
    jest.restoreAllMocks()
    jest.useRealTimers()
  })
  function store() {
    return new GlobalKVStore({
      wallet: author as any,
      protocolID: protocol,
      lookupResolver: new LookupResolver({
        hostOverrides: { ls_kvstore: [host] },
        facilitator: { lookup: async () => ({ type: 'output-list', outputs: [f.output] }) }
      }),
      reliability: { chainTracker, authoritativeHosts: [host] }
    })
  }

  it('preserves get return shapes and only includes tokens when requested', async () => {
    const client = store()
    expect(await client.get(f.query)).toMatchObject({ value: 'contract value' })
    expect(await client.get(f.query)).not.toHaveProperty('token')
    expect(await client.get(f.query, { includeToken: true })).toMatchObject({
      token: { txid: f.tx.id('hex') }
    })
    expect(await client.get({ protocolID: protocol })).toEqual([
      expect.objectContaining({ value: 'contract value' })
    ])
    jest.spyOn(client, 'getResult').mockResolvedValue(absent)
    expect(await client.get(f.query)).toBeUndefined()
    expect(await client.get({ protocolID: protocol })).toEqual([])
  })

  it.each([unavailable, conflict, { kind: 'data', completeness: 'partial' }])(
    'get rejects incomplete or conflicting evidence: %j',
    async outcome => {
      const client = store()
      jest
        .spyOn(client, 'getResult')
        .mockResolvedValue({ ...data, ...outcome } as KVStoreReadResult)
      await expect(client.get(f.query)).rejects.toBeInstanceOf(KVStoreUnavailableError)
    }
  )

  it('requires selectors and a separate policy for verified history', async () => {
    const client = store()
    await expect(client.getResult({})).rejects.toThrow('selector')
    await expect(client.getResult({ tags: [] })).rejects.toThrow('selector')
    await expect(client.getResult(f.query, { history: true })).rejects.toThrow('history validation')
  })

  it('applies the configured service and an explicit service override', async () => {
    const lookup = jest.fn(async () => ({ type: 'output-list' as const, outputs: [] }))
    const client = new GlobalKVStore({
      serviceName: 'ls_configured',
      lookupResolver: new LookupResolver({
        hostOverrides: { ls_configured: [host], ls_override: [host] },
        facilitator: { lookup }
      }),
      reliability: { chainTracker, authoritativeHosts: [host] }
    })
    expect((await client.getResult({ tags: ['selected'] })).kind).toBe('absent')
    expect((await client.getResult(f.query, { serviceName: 'ls_override' })).kind).toBe('absent')
    expect(lookup.mock.calls.map(call => (call as any)[1].service)).toEqual([
      'ls_configured',
      'ls_override'
    ])
  })

  it('builds a default resolver without requiring a custom facilitator', () => {
    const client = new GlobalKVStore({
      networkPreset: 'local',
      hostOverrides: { ls_kvstore: [host] },
      reliability: { chainTracker }
    })
    expect(client).toBeInstanceOf(BaseKVStore)
    expect(
      () =>
        new GlobalKVStore({
          reliability: { chainTracker: { isValidRootForHeight: async () => true } }
        } as any)
    ).toThrow('chain tracker')
  })

  it('confirms set and remove through the same read contract', async () => {
    const client = store()
    const set = jest.spyOn(BaseKVStore.prototype, 'set').mockResolvedValue(`${f.tx.id('hex')}.0`)
    const remove = jest.spyOn(BaseKVStore.prototype, 'remove').mockResolvedValue(f.tx.id('hex'))
    const read = jest.spyOn(client, 'getResult').mockResolvedValue(data)
    expect(await client.set('confirmed-set', 'value', { protocolID: protocol })).toBe(
      `${f.tx.id('hex')}.0`
    )
    expect(set).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: 'confirmed-set', protocolID: protocol }),
      {},
      expect.any(AbortSignal)
    )
    read.mockResolvedValue(absent)
    expect(await client.remove('confirmed-remove')).toBe(f.tx.id('hex'))
    expect(remove).toHaveBeenCalledTimes(1)
    expect(await client.reconcilePendingWrite('confirmed-remove')).toBe(true)
  })

  it.each(['set', 'remove'] as const)(
    'retains an unconfirmed %s and reconciles without creating another transaction',
    async operation => {
      jest.useFakeTimers()
      const client = store()
      const txid = f.tx.id('hex')
      const create = jest
        .spyOn(BaseKVStore.prototype, operation)
        .mockResolvedValue(operation === 'set' ? `${txid}.0` : txid)
      const read = jest.spyOn(client, 'getResult').mockResolvedValue(unavailable)
      const key = `unconfirmed-${operation}`
      const write = () =>
        operation === 'set'
          ? client.set(key, 'value')
          : client.remove(key, [], { protocolID: protocol })
      const rejection = expect(write()).rejects.toMatchObject({ outcome: 'unconfirmed', txid })
      await jest.advanceTimersByTimeAsync(5100)
      await rejection
      await expect(write()).rejects.toBeInstanceOf(KVStoreWriteError)
      expect(create).toHaveBeenCalledTimes(1)
      read.mockResolvedValue(operation === 'set' ? data : absent)
      expect(await client.reconcilePendingWrite(key)).toBe(true)
      expect(create).toHaveBeenCalledTimes(1)
    }
  )

  it('does not turn a wallet error into a pending overlay transaction', async () => {
    const client = store()
    const failure = new Error('synthetic signing rejection')
    jest.spyOn(BaseKVStore.prototype, 'set').mockRejectedValue(failure)
    await expect(client.set('wallet-error', 'value')).rejects.toBe(failure)
    expect(await client.reconcilePendingWrite('wallet-error')).toBe(true)
  })

  it.each(['rejected', 'unconfirmed'] as const)(
    'classifies broadcaster %s and preserves the transaction identity',
    async outcome => {
      const broadcast = jest.spyOn(ReliableTopicBroadcaster.prototype, 'broadcast')
      if (outcome === 'rejected')
        broadcast.mockResolvedValue({
          status: 'error',
          code: 'ERR_REJECTED',
          description: 'synthetic rejection'
        })
      else broadcast.mockRejectedValue(new Error('synthetic disconnect'))
      const client = store()
      await expect((client as any).submitToOverlay(f.tx)).rejects.toMatchObject({
        outcome,
        txid: f.tx.id('hex')
      })
    }
  )

  it('accepts a submitted removal transaction without a replacement token', async () => {
    jest
      .spyOn(ReliableTopicBroadcaster.prototype, 'broadcast')
      .mockResolvedValue({ status: 'success', txid: f.tx.id('hex'), message: 'synthetic' })
    const client = store()
    const removal = new Transaction(
      1,
      [],
      [{ lockingScript: LockingScript.fromHex('51'), satoshis: 1 }],
      0
    )
    const read = jest.spyOn(client, 'getResult')
    await expect((client as any).submitToOverlay(removal)).resolves.toMatchObject({
      status: 'success'
    })
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps prior records during partial refresh and clears them after authoritative absence', () => {
    const state = new KVStoreReadState()
    state.apply(data)
    const partial = {
      ...data,
      completeness: 'partial' as const,
      entries: [{ ...data.entries[0], key: 'second', token: undefined }]
    }
    expect(state.apply(partial)).toMatchObject({
      kind: 'stale',
      entries: [data.entries[0], partial.entries[0]]
    })
    expect(state.apply(absent)).toEqual(absent)
    expect(state.apply(unavailable)).toEqual(unavailable)
  })

  it('rejects incomparable refreshes and corrupted cached proofs without replacing known data', async () => {
    const competitor = await fixture('independent tip')
    const values = await validateKVAnswer(
      { type: 'output-list', outputs: [competitor.output] },
      competitor.query,
      chainTracker,
      new AbortController().signal
    )
    const competing = { ...data, entries: values.map(v => v.entry) }
    const state = new KVStoreReadState()
    state.apply(data)
    expect(state.apply(competing).kind).toBe('conflict')
    const corrupt = {
      ...data,
      entries: [
        {
          ...data.entries[0],
          token: { ...data.entries[0].token!, beef: { toBinary: () => [1, 2] } as any }
        }
      ]
    }
    state.apply(corrupt)
    expect(state.apply(competing).kind).toBe('conflict')
    expect(state.apply(unavailable)).toMatchObject({ kind: 'stale', entries: corrupt.entries })
  })

  it('a complete successor refresh advances retained state', async () => {
    const successor = await fixture('successor', f.tx)
    const values = await validateKVAnswer(
      { type: 'output-list', outputs: [successor.output] },
      successor.query,
      chainTracker,
      new AbortController().signal
    )
    const updated = { ...data, entries: values.map(v => v.entry) }
    const state = new KVStoreReadState()
    state.apply(data)
    expect(state.apply(updated)).toEqual(updated)
  })

  it.each([0, 99, Infinity, NaN])('rejects an unsafe UI retry interval %s', delay => {
    expect(
      () =>
        new KVStoreReadSession(
          async () => absent,
          () => {},
          delay
        )
    ).toThrow(RangeError)
  })

  it('stopping a session is permanent and observer failures do not interrupt recovery', async () => {
    const read = jest.fn(async () => absent)
    const session = new KVStoreReadSession(read, () => {
      throw new Error('synthetic observer error')
    })
    await expect(session.refresh()).resolves.toBeUndefined()
    session.stop()
    await session.refresh()
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('stops write confirmation immediately on conflict or a failed read', async () => {
    await expect(confirmKVWrite(async () => conflict, 'tx.0')).resolves.toBe(false)
    await expect(
      confirmKVWrite(async () => {
        throw new Error('offline')
      }, 'tx.0')
    ).resolves.toBe(false)
    await expect(confirmKVWrite(async () => absent, undefined)).resolves.toBe(true)
  })
})
