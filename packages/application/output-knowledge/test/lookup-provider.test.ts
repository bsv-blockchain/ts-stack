import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, OutputProtocolError, signOutputPacket, outputPacketDigest } from '@bsv/sdk'
import { LookupProviderContracts } from '../src/lookup/LookupProviderContracts.js'
import type { LookupIndexStorage } from '../src/lookup/LookupIndexStorage.js'
import type { LookupSessionStorage } from '../src/lookup/LookupSessionStorage.js'
import { LookupProviderWork } from '../src/lookup/LookupProviderWork.js'
import {
  providerFixture,
  providerEntry,
  providerBatch,
  providerRead
} from './lookup-provider-fixture.js'

const fixtures: Awaited<ReturnType<typeof providerFixture>>[] = []
async function fixture(authentication: 'none' | 'brc103' = 'none') {
  const value = await providerFixture(authentication)
  fixtures.push(value)
  return value
}
afterEach(async () => {
  for (const value of fixtures.splice(0)) await value.cleanup()
})

describe('durable progressive/live provider composition', () => {
  it('replays exact first bytes after writes, reads, manifest expiry, rotation and connection restart', async () => {
    const f = await fixture()
    const first = await f.service.open(f.open, f.caller),
      initial = providerBatch(first)
    await f.index.commit({ base: '0', evaluatedAt: '1000', edits: [providerEntry(0)], event: {} })
    const live = providerBatch(await f.service.read(providerRead(initial), f.caller))
    expect(live.groups).toHaveLength(1)
    f.clock.now = '1201' // Manifest expired; the original session has not.
    expect(await f.peer().service.open(f.open, f.caller)).toEqual(first)
    await f.rotate()
    expect(await f.service.open(f.open, f.caller)).toEqual(first)
    await expect(
      f.service.open({ ...f.open, query: { collection: 'changed' } }, f.caller)
    ).rejects.toMatchObject({ code: 'conflict' })
    await expect(
      f.service.open({ ...f.open, requestId: 'new-request-0000000000' }, f.caller)
    ).rejects.toMatchObject({ code: 'context-changed' })
    expect((await f.index.head()).retained.pins).toBe(1)
    f.clock.now = '1300'
    await expect(f.service.open(f.open, f.caller)).rejects.toMatchObject({ code: 'expired' })
  })

  it('joins concurrent original Opens from independent database connections', async () => {
    const f = await fixture(),
      peer = f.peer()
    const values = await Promise.all([
      f.service.open(f.open, f.caller),
      peer.service.open(f.open, f.caller)
    ])
    expect(values[0]).toEqual(values[1])
    expect((await f.index.head()).retained.pins).toBe(1)
  })

  it('delivers a coherent change to two clients and resumes a change missed while disconnected', async () => {
    const f = await fixture(),
      peer = f.peer()
    const one = providerBatch(await f.service.open(f.open, f.caller))
    const two = providerBatch(
      await peer.service.open({ ...f.open, requestId: 'second-client-0000000000' }, f.caller)
    )
    await f.index.commit({
      base: '0',
      evaluatedAt: '1000',
      edits: [providerEntry(0), providerEntry(1)],
      event: {}
    })
    const seen = await Promise.all([
      f.service.read(providerRead(one), f.caller),
      peer.service.read(providerRead(two), f.caller)
    ])
    expect(providerBatch(seen[0]).groups).toEqual(providerBatch(seen[1]).groups)
    expect(providerBatch(seen[0]).groups[0].observations).toHaveLength(2)
    await f.index.commit({ base: '1', evaluatedAt: '1000', edits: [providerEntry(2)], event: {} })
    const resumed = providerBatch(
      await f.peer().service.read(providerRead(providerBatch(seen[1])), f.caller)
    )
    expect(resumed.groups.map(value => value.sequence)).toEqual(['2'])
    expect(resumed.through).toBe('2')
  })

  it('detects another connection without any local notification', async () => {
    const f = await fixture(),
      peer = f.peer()
    const first = providerBatch(await f.service.open(f.open, f.caller))
    const read = f.service.read(providerRead(first, 1000), f.caller)
    const write = new Promise<void>((resolve, reject) =>
      setTimeout(() => {
        peer.index
          .commit({ base: '0', evaluatedAt: '1000', edits: [providerEntry(0)], event: {} })
          .then(() => resolve(), reject)
      }, 10)
    )
    const [response] = await Promise.all([read, write])
    expect(providerBatch(response).groups).toHaveLength(1)
  })

  it('cannot lose a write between checking the watermark and sleeping', async () => {
    const f = await fixture()
    const first = providerBatch(await f.service.open(f.open, f.caller))
    let inserted = false
    const index = new Proxy(f.index, {
      get(target, key) {
        if (key === 'advanceTime')
          return async (time: string, maximum: number) => {
            const captured = await target.advanceTime(time, maximum)
            if (!inserted) {
              inserted = true
              await f.peer().index.commit({
                base: '0',
                evaluatedAt: '1000',
                edits: [providerEntry(0)],
                event: {}
              })
              reader.wake.notify()
            }
            return captured
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    const reader = f.provider(index, f.sessions, { budgets: { pollMs: 1000 } })
    const response = providerBatch(await reader.read(providerRead(first, 900), f.caller))
    expect(response.groups).toHaveLength(1)
    expect(response.through).toBe('1')
  })

  it('retains the immutable snapshot across ordinary expiry and orders the withdrawal after it', async () => {
    const f = await fixture()
    await f.index.commit({
      base: '0',
      evaluatedAt: '1000',
      edits: [providerEntry(0, 'public', '1001'), providerEntry(1)],
      event: {}
    })
    const first = providerBatch(
      await f.service.open(
        { ...f.open, limits: { ...f.open.limits, maxObservations: 1 } },
        f.caller
      )
    )
    expect(first.snapshotComplete).toBe(false)
    f.clock.now = '1001'
    const finalSnapshot = providerBatch(await f.service.read(providerRead(first), f.caller))
    expect(finalSnapshot.phase).toBe('snapshot')
    expect(finalSnapshot.snapshotComplete).toBe(true)
    const live = providerBatch(await f.service.read(providerRead(finalSnapshot), f.caller))
    expect(live.groups[0].observations).toMatchObject([
      { kind: 'withdraw', payload: { reason: 'expired' } }
    ])
    expect(live.through).toBe('2')
  })

  it('completes bounded timer work before establishing a snapshot or claiming live completeness', async () => {
    const f = await fixture()
    await f.index.commit({
      base: '0',
      evaluatedAt: '999',
      edits: [0, 1, 2].map(i => providerEntry(i, 'public', '1000')),
      event: {}
    })
    const limited = f.provider(f.index, f.sessions, { budgets: { maximumExpirations: 2 } })
    await expect(limited.open(f.open, f.caller)).rejects.toMatchObject({
      code: 'limited',
      retryable: true
    })
    expect((await f.index.head()).retained.pins).toBe(0)
    const first = providerBatch(await limited.open(f.open, f.caller))
    expect(first.groups).toEqual([])
    expect(first.through).toBe('4')
  })

  it('returns a bounded quiet poll with coherent unchanged cursor and fixed deadlines', async () => {
    const f = await fixture(),
      first = providerBatch(await f.service.open(f.open, f.caller))
    const quiet = providerBatch(await f.service.read(providerRead(first, 15), f.caller))
    expect(quiet).toMatchObject({
      phase: 'live',
      groups: [],
      cursor: first.cursor,
      through: '0',
      highWater: '0',
      expiresAt: first.expiresAt,
      replayUntil: first.replayUntil
    })
  })

  it('checks authentication at entry and current authorization immediately before disclosure', async () => {
    const f = await fixture('brc103')
    await f.index.commit({
      base: '0',
      evaluatedAt: '1000',
      edits: [providerEntry(0, [f.caller.principal!])],
      event: {}
    })
    await expect(f.service.open(f.open, { ...f.caller, principal: null })).rejects.toMatchObject({
      code: 'unauthorized'
    })
    f.hooks.authorization = async context => {
      if (context.stage === 'disclosure')
        throw new OutputProtocolError('unauthorized', 'Access revoked')
    }
    await expect(f.service.open(f.open, f.caller)).rejects.toMatchObject({ code: 'unauthorized' })
    expect((await f.index.head()).retained.pins).toBe(1) // The saved original is recoverable, never recreated.
    delete f.hooks.authorization
    const first = providerBatch(await f.service.open(f.open, f.caller))
    expect(first.groups).toHaveLength(1)
    const stranger = { ...f.caller, principal: new PrivateKey(3).toPublicKey().toString() }
    await expect(f.service.read(providerRead(first), stranger)).rejects.toMatchObject({
      code: 'reset-required'
    })
  })

  it('cannot serialize a historical private group after its disclosure guard is blocked', async () => {
    const f = await fixture('brc103'),
      first = providerBatch(await f.service.open(f.open, f.caller))
    await f.index.commit({
      base: '0',
      evaluatedAt: '1000',
      edits: [providerEntry(0, [f.caller.principal!])],
      event: {}
    })
    f.hooks.authorization = async context => {
      if (context.operation === 'read' && context.stage === 'disclosure')
        await f.sessions.blockGuard('serving', '0', '01'.repeat(32))
    }
    await expect(f.service.read(providerRead(first), f.caller)).rejects.toMatchObject({
      code: 'unauthorized'
    })
  })

  it('does not return an expired successful batch when expiry occurs during a poll', async () => {
    const f = await fixture(),
      first = providerBatch(await f.service.open(f.open, f.caller))
    f.hooks.authorization = async context => {
      if (context.operation === 'read' && context.stage === 'disclosure') f.clock.now = '1300'
    }
    await expect(f.service.read(providerRead(first, 10), f.caller)).rejects.toMatchObject({
      code: 'reset-required'
    })
  })

  it('keeps Close private and idempotent while invalidating future serialization', async () => {
    const f = await fixture('brc103'),
      first = providerBatch(await f.service.open(f.open, f.caller))
    const stranger = { ...f.caller, principal: new PrivateKey(3).toPublicKey().toString() }
    const close = { version: 1, session: first.session }
    const expected = { version: 1, closed: true }
    expect(JSON.parse((await f.service.close(close, stranger)).body)).toEqual(expected)
    expect(
      JSON.parse((await f.service.close({ ...close, session: 'unknown' }, stranger)).body)
    ).toEqual(expected)
    expect(await f.service.open(f.open, f.caller)).toBeDefined()
    expect(JSON.parse((await f.service.close(close, f.caller)).body)).toEqual(expected)
    expect(JSON.parse((await f.service.close(close, f.caller)).body)).toEqual(expected)
    await expect(f.service.read(providerRead(first), f.caller)).rejects.toMatchObject({
      code: 'expired'
    })
    await expect(f.service.open(f.open, f.caller)).rejects.toMatchObject({ code: 'expired' })
  })

  it('releases cancelled polling work without consuming retained events', async () => {
    const f = await fixture(),
      first = providerBatch(await f.service.open(f.open, f.caller)),
      abort = new AbortController()
    const service = f.provider(f.index, f.sessions, { work: new LookupProviderWork(1, 1) })
    const pending = service.read(providerRead(first, 25000), f.caller, abort.signal)
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    await f.index.commit({ base: '0', evaluatedAt: '1000', edits: [providerEntry(0)], event: {} })
    const resumed = providerBatch(await service.read(providerRead(first), f.caller))
    expect(resumed.groups).toHaveLength(1)
  })
})

function overridePort<T extends object>(port: T, replacement: Partial<T>): T {
  return new Proxy(port, {
    get(target, key) {
      if (Object.hasOwn(replacement, key)) return Reflect.get(replacement, key)
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
}

describe('provider contract and authorization boundaries', () => {
  it('requires each durable store independently and rejects changed service/rules before an opening exists', async () => {
    const f = await fixture()
    for (const [index, sessions] of [
      [overridePort<LookupIndexStorage>(f.index, { durability: 'volatile' }), f.sessions],
      [f.index, overridePort<LookupSessionStorage>(f.sessions, { durability: 'volatile' })]
    ] as const)
      expect(() => f.provider(index, sessions)).toThrow(
        expect.objectContaining({
          code: 'unsupported',
          message: 'Live lookup requires durable index and sessions'
        })
      )
    for (const change of [{ service: 'other' }, { requiredRulesDigest: 'ff'.repeat(32) }])
      await expect(f.service.open({ ...f.open, ...change }, f.caller)).rejects.toMatchObject({
        code: 'context-changed',
        message: 'Lookup request changed its selected service or rules'
      })
    expect((await f.index.head()).retained.pins).toBe(0)
    const { requiredRulesDigest: _optional, ...withoutRequired } = f.open
    expect(providerBatch(await f.service.open(withoutRequired, f.caller)).scope.service).toBe(
      'records'
    )
  })

  it('owns recovery trust and verifies installed parameter rules independently of signed discovery', async () => {
    const f = await fixture()
    const trust = structuredClone(f.source.selection)
    const contracts = new LookupProviderContracts(trust, f.queries, f.manifest)
    trust.chain.genesisHash = 'ff'.repeat(32)
    const recovered = contracts.recoveryTrust()
    recovered.chain.genesisHash = 'aa'.repeat(32)
    const rules = recovered.rules as Map<string, (parameters: unknown) => void>
    const validate = rules.values().next().value!
    expect(() => validate({})).not.toThrow()
    expect(() => validate({ injected: true })).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: 'Lookup rule parameters differ from installed rules'
      })
    )
    rules.clear()
    const retained = contracts.fresh(f.caller.capabilityDigest, '1000')
    expect(contracts.restore(retained.record, f.caller.capabilityDigest).digest).toBe(
      f.caller.capabilityDigest
    )
    expect(() => contracts.restore(retained.record, 'ff'.repeat(32))).toThrow(
      expect.objectContaining({ code: 'context-changed', message: 'Lookup selection changed' })
    )
  })

  it('enforces the signed request byte limit before index work', async () => {
    const f = await fixture()
    const body = f.manifest().body
    body.services[0].profiles[0].maxRequestBytes = 1
    const manifest = signOutputPacket('capabilities', body, new PrivateKey(1))
    const contracts = new LookupProviderContracts(f.source.selection, f.queries, () => manifest)
    const service = f.provider(f.index, f.sessions, { contracts })
    await expect(
      service.open(f.open, {
        ...f.caller,
        capabilityDigest: outputPacketDigest('capabilities', body)
      })
    ).rejects.toMatchObject({ code: 'limited' })
    expect((await f.index.head()).retained.pins).toBe(0)
  })

  it('does not accept a principal on a public contract or disclose after its access partition changes', async () => {
    const f = await fixture()
    await expect(
      f.service.open(f.open, { ...f.caller, principal: new PrivateKey(2).toPublicKey().toString() })
    ).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'Lookup caller does not match selected authentication'
    })
    const first = providerBatch(await f.service.open(f.open, f.caller))
    const changed = f.provider(f.index, f.sessions, {
      authorize: async () => ({
        access: 'changed',
        guards: [{ id: 'serving', revision: '0', failure: 'unauthorized' }]
      })
    })
    await expect(changed.read(providerRead(first), f.caller)).rejects.toMatchObject({
      code: 'unauthorized',
      message: 'Lookup access partition changed'
    })
    const damaged = f.provider(f.index, f.sessions, {
      authorize: async () => ({ access: 'public', guards: [], injected: true })
    })
    await expect(damaged.open(f.open, f.caller)).rejects.toMatchObject({ code: 'invalid' })
  })

  it('hides only inaccessible Close outcomes while propagating storage and caller failures', async () => {
    const f = await fixture()
    const first = providerBatch(await f.service.open(f.open, f.caller))
    const close = { version: 1, session: first.session }
    for (const code of [
      'unauthorized',
      'reset-required',
      'expired',
      'context-changed',
      'unsupported'
    ] as const) {
      const sessions = overridePort(f.sessions, {
        session: async () => {
          throw new OutputProtocolError(code, 'private cause')
        }
      })
      const response = await f.provider(f.index, sessions).close(close, f.caller)
      expect(JSON.parse(response.body)).toEqual({ version: 1, closed: true })
      expect(response.headers).toEqual({
        'x-bsv-overlay-capability': f.caller.capabilityDigest,
        'x-bsv-overlay-profile': 'https://bsv.brc.dev/overlays/0193#lookup-live-v1'
      })
    }
    for (const failure of [
      new Error('I/O failed'),
      new OutputProtocolError('unavailable', 'I/O failed', true),
      new OutputProtocolError('invalid', 'invalid input')
    ]) {
      const closeSession = jest.fn(f.sessions.closeSession.bind(f.sessions))
      const sessions = overridePort(f.sessions, {
        session: async () => {
          throw failure
        },
        closeSession
      })
      await expect(f.provider(f.index, sessions).close(close, f.caller)).rejects.toBe(failure)
      expect(closeSession).not.toHaveBeenCalled()
    }
    expect(await f.service.open(f.open, f.caller)).toBeDefined()
  })
})

it('supplies the exact operation and stage to authorization for fresh, retained, read and close requests', async () => {
  const f = await fixture()
  const seen: { operation: string; stage: string; hasScope: boolean }[] = []
  f.hooks.authorization = async context => {
    seen.push({
      operation: context.operation,
      stage: context.stage,
      hasScope: context.scope !== null
    })
    expect(context.principal).toBeNull()
    expect(context.open).toEqual(f.open)
    expect(context.selection.service.name).toBe('records')
    context.open.query = { changedByAuthorizer: true }
    context.selection.manifest.body.chain.genesisHash = 'ff'.repeat(32)
  }
  const first = providerBatch(await f.service.open(f.open, f.caller))
  await f.service.read(providerRead(first), f.caller)
  expect(providerBatch(await f.service.open(f.open, f.caller))).toEqual(first)
  await f.service.close({ version: 1, session: first.session }, f.caller)
  expect(seen).toEqual([
    { operation: 'open', stage: 'request', hasScope: false },
    { operation: 'open', stage: 'disclosure', hasScope: true },
    { operation: 'read', stage: 'request', hasScope: true },
    { operation: 'read', stage: 'disclosure', hasScope: true },
    { operation: 'open', stage: 'request', hasScope: true },
    { operation: 'open', stage: 'disclosure', hasScope: true },
    { operation: 'close', stage: 'request', hasScope: true }
  ])
})
