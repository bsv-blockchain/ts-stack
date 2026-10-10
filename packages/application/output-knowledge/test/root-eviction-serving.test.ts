import { expect, it, jest } from '@jest/globals'
import {
  Beef,
  canonicalOutputJSON,
  PrivateKey,
  signOutputPacket,
  Utils,
  type OutputLookupBatch
} from '@bsv/sdk'
import {
  RootAdvertisementServing,
  rootAdvertisementServingTarget,
  rootLookupAdvertisementTargets
} from '../src/root-eviction/RootAdvertisementServing.js'
import {
  RootLookupServingDisclosure,
  type RootLookupServingDelegate
} from '../src/root-eviction/RootLookupServingDisclosure.js'
import { fixture, apply, request, selected, rootKey, policy } from './root-eviction-fixture.js'
import { rootAdvertisementFixture } from './root-advertisement-fixture.js'

async function eligible() {
  const f = await fixture(),
    target = selected()
  await f.store.assess({
    operationId: 'serving_admission',
    expectedRevision: '0',
    target,
    eligible: true,
    evidenceDigest: '88'.repeat(32),
    reasonCode: 'verified-fixture'
  })
  await f.store.projected((await f.store.projections(1))[0])
  return { ...f, target, serving: new RootAdvertisementServing(f.store) }
}
function batch(ad: Awaited<ReturnType<typeof rootAdvertisementFixture>>): OutputLookupBatch {
  const target = ad.body.targets[0],
    scope = {
      provider: 'https://root.example',
      queryDigest: '66'.repeat(32),
      access: 'public',
      epoch: 'root-epoch',
      chain: target.outpoint.chain,
      service: target.service,
      rulesDigest: policy
    }
  return {
    version: 1,
    session: 'root-session',
    scope,
    phase: 'snapshot',
    groups: [
      {
        id: 'root-group',
        sequence: '0',
        observations: [
          {
            id: 'root-observation',
            scope,
            kind: 'output',
            payload: { evidence: target.advertisement }
          }
        ]
      }
    ],
    cursor: 'root-cursor',
    snapshotComplete: true,
    through: '0',
    highWater: '0',
    expiresAt: '200',
    replayUntil: '300',
    limits: { maxBytes: 4194304, maxObservations: 1024, waitMs: 0 }
  }
}

it('preserves both send ports while owning complete bytes and inventory against caller mutation', async () => {
  const f = await eligible()
  try {
    const bytes = new Uint8Array([1, 2, 3]),
      inventory = [structuredClone(f.target)],
      original = f.serving.capture(),
      bound = f.serving.bind(bytes, inventory, original),
      send = jest.fn<(bytes: Uint8Array) => undefined>(() => undefined)
    bytes[0] = 9
    inventory[0].outpoint.txid = '99'.repeat(32)
    original.revision = '999'
    bound.enqueue(new Uint8Array([1, 2, 3]), () => true, send)
    expect(send).toHaveBeenCalledWith(new Uint8Array([1, 2, 3]))
    expect(() => bound.enqueue(new Uint8Array([1, 2, 3]), () => true, send)).toThrow(
      'already attempted'
    )
    expect(send).toHaveBeenCalledTimes(1)
  } finally {
    await f.cleanup()
  }
})
it('rejects stale cache/hydration after a peer suppression commits during asynchronous preparation', async () => {
  const f = await eligible()
  try {
    const head = f.serving.capture(),
      bytes = new Uint8Array([1]),
      send = jest.fn<(bytes: Uint8Array) => undefined>(() => undefined)
    await apply(f.reopen(), request('cache_eviction_0001'))
    const bound = f.serving.bind(bytes, [f.target], head)
    expect(() => bound.enqueue(bytes, () => true, send)).toThrow('revision changed')
    const refreshed = f.serving.bind(bytes, [f.target])
    expect(() => refreshed.enqueue(bytes, () => true, send)).toThrow('prohibited or unresolved')
    expect(send).not.toHaveBeenCalled()
  } finally {
    await f.cleanup()
  }
})
it('requires actual projection acknowledgement before restored membership may enqueue', async () => {
  const f = await eligible()
  try {
    await f.store.assess({
      operationId: 'new_currentness_0001',
      expectedRevision: (await f.store.head()).revision,
      target: f.target,
      eligible: true,
      evidenceDigest: '99'.repeat(32),
      reasonCode: 'reassessment'
    })
    const bytes = new Uint8Array([1]),
      send = jest.fn<(bytes: Uint8Array) => undefined>(() => undefined)
    expect(() => f.serving.bind(bytes, [f.target]).enqueue(bytes, () => true, send)).toThrow(
      'unresolved'
    )
    await f.store.projected((await f.store.projections(1))[0])
    f.serving.bind(bytes, [f.target]).enqueue(bytes, () => true, send)
    expect(send).toHaveBeenCalledTimes(1)
  } finally {
    await f.cleanup()
  }
})
it('requires unchanged native owner, current synchronous authority and exact complete bytes', async () => {
  const f = await eligible()
  try {
    const bytes = new Uint8Array([1]),
      send = jest.fn<(bytes: Uint8Array) => undefined>(() => undefined)
    expect(() => f.serving.bind(bytes, [f.target]).enqueue(bytes, () => false, send)).toThrow(
      'no longer authorized'
    )
    const bound = f.serving.bind(bytes, [f.target])
    expect(() => bound.enqueue(new Uint8Array([2]), () => true, send)).toThrow('bytes changed')
    expect(() => bound.enqueue(new Uint8Array([1, 2]), () => true, send)).toThrow('bytes changed')
    bound.enqueue(bytes, () => true, send)
    const another = f.serving.bind(bytes, [f.target])
    f.store.enqueueNow = () => undefined
    expect(() => another.enqueue(bytes, () => true, send)).toThrow('owner changed')
    expect(() => f.serving.capture()).toThrow('owner changed')
    expect(send).toHaveBeenCalledTimes(1)
  } finally {
    await f.cleanup()
  }
})
it('retains native callback, reentrancy, foreign-chain and configuration bounds', async () => {
  const f = await eligible()
  try {
    expect(
      () =>
        new RootAdvertisementServing({
          ...f.store,
          servingEnqueue: 'other'
        } as unknown as typeof f.store)
    ).toThrow('requires native')
    expect(() => f.serving.bind(new Uint8Array(4194305), [])).toThrow('byte limit')
    expect(() =>
      f.serving.bind(
        new Uint8Array(),
        Array.from({ length: 1025 }, () => f.target)
      )
    ).toThrow('inventory limit')
    const head = f.store.captureServing(),
      bytes = new Uint8Array([1]),
      candidate = { revision: head.revision, targets: [f.target], bytes }
    let calls = 0
    expect(() =>
      f.store.enqueueNow(candidate, () => true, (async () => {
        calls++
      }) as unknown as (bytes: Uint8Array) => undefined)
    ).toThrow()
    expect(calls).toBe(0)
    expect(() =>
      f.store.enqueueNow(
        candidate,
        () => true,
        () => {
          f.store.captureServing()
          return undefined
        }
      )
    ).toThrow()
    expect(() =>
      f.store.enqueueNow(
        {
          ...candidate,
          targets: [
            {
              ...f.target,
              outpoint: {
                ...f.target.outpoint,
                chain: { ...f.target.outpoint.chain, network: 'other' }
              }
            }
          ]
        },
        () => true,
        () => undefined
      )
    ).toThrow('another chain')
    expect(() =>
      f.store.enqueueNow(candidate, () => true, (() => 1) as unknown as () => undefined)
    ).toThrow('complete synchronously')
  } finally {
    await f.cleanup()
  }
})
it.each(['SHIP', 'SLAP'] as const)(
  'derives the complete exact %s responsive inventory from actual signed scripts',
  async protocol => {
    const ad = await rootAdvertisementFixture(protocol),
      b = batch(ad),
      body = canonicalOutputJSON(b)
    const actual = rootAdvertisementServingTarget(
      ad.body.targets[0].service,
      ad.body.chain,
      ad.body.targets[0].advertisement
    )
    expect(actual).toEqual({
      service: ad.body.targets[0].service,
      outpoint: ad.body.targets[0].outpoint,
      advertisementDigest: ad.body.targets[0].advertisementDigest
    })
    expect(rootLookupAdvertisementTargets(body)).toEqual([actual])
    const withdraw = structuredClone(b)
    withdraw.groups[0].observations = [
      {
        id: 'withdraw',
        scope: b.scope,
        kind: 'withdraw',
        payload: { outpoint: actual.outpoint, reason: 'source-membership-only' }
      }
    ]
    expect(rootLookupAdvertisementTargets(canonicalOutputJSON(withdraw))).toEqual([])
    const empty = structuredClone(b)
    empty.groups = []
    expect(rootLookupAdvertisementTargets(canonicalOutputJSON(empty))).toEqual([])
  }
)
it('does not infer missing raw subjects, accept inconsistent Atomic subjects or hide contextual/unknown positive inventories', async () => {
  const ad = await rootAdvertisementFixture(),
    evidence = ad.body.targets[0].advertisement,
    b = batch(ad)
  expect(() => rootAdvertisementServingTarget('records', ad.body.chain, evidence)).toThrow(
    'Not a root'
  )
  expect(() =>
    rootAdvertisementServingTarget('ls_ship', ad.body.chain, { ...evidence, txid: '99'.repeat(32) })
  ).toThrow('Atomic BEEF subject differs')
  expect(() =>
    rootAdvertisementServingTarget('ls_ship', ad.body.chain, { ...evidence, outputIndex: 9 })
  ).toThrow('output differs')
  const missing = new Beef()
  missing.mergeTxidOnly(evidence.txid)
  expect(() =>
    rootAdvertisementServingTarget('ls_ship', ad.body.chain, {
      ...evidence,
      beef: Utils.toBase64(missing.toBinary())
    })
  ).toThrow('raw subject is absent')
  if (b.groups[0].observations[0].kind !== 'output') throw new Error('Expected output')
  b.groups[0].observations[0].payload.context = {
    schema: 'https://example.test/private',
    bytes: 'AQID'
  }
  expect(() => rootLookupAdvertisementTargets(canonicalOutputJSON(b))).toThrow('no private context')
  b.scope.service = 'records'
  b.groups[0].observations[0].scope.service = 'records'
  expect(() => rootLookupAdvertisementTargets(canonicalOutputJSON(b))).toThrow('Not a root')
})
it('composes synchronous provider-to-root physical callbacks, cancellation and separate control inventory without filtering', async () => {
  const ad = await rootAdvertisementFixture(),
    target = ad.body.targets[0],
    f = await fixture({ chain: ad.body.chain })
  try {
    await f.store.assess({
      operationId: 'real_admission_0001',
      expectedRevision: '0',
      target,
      eligible: true,
      evidenceDigest: '88'.repeat(32),
      reasonCode: 'component-fixture-only'
    })
    await f.store.projected((await f.store.projections(1))[0])
    let providerGate = false,
      allowed = true
    const delegate: RootLookupServingDelegate = {
      bind: (_operation, _body, _caller) => ({
        enqueue: async (bytes, _identity, send, _signal) => {
          providerGate = true
          try {
            send(bytes)
          } finally {
            providerGate = false
          }
        }
      }),
      control: (_body, _caller) => ({
        enqueue: async (bytes, _identity, send, _signal) => {
          providerGate = true
          try {
            send(bytes)
          } finally {
            providerGate = false
          }
        }
      })
    }
    const serving = new RootAdvertisementServing(f.store),
      disclosure = new RootLookupServingDisclosure({
        disclosure: delegate,
        serving,
        authorize: () => allowed
      }),
      caller = { principal: new PrivateKey(7).toPublicKey().toString(), capabilityDigest: policy },
      body = canonicalOutputJSON(batch(ad)),
      bytes = new TextEncoder().encode(body)
    let sends = 0
    await disclosure.bind('open', body, caller).enqueue(
      bytes,
      caller.principal,
      () => {
        expect(providerGate).toBe(true)
        sends++
        return undefined
      },
      new AbortController().signal
    )
    allowed = false
    await expect(
      disclosure.bind('read', body, caller).enqueue(
        bytes,
        caller.principal,
        () => {
          sends++
          return undefined
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    allowed = true
    await expect(
      disclosure.bind('read', body, caller).enqueue(
        bytes,
        caller.principal,
        () => {
          sends++
          return undefined
        },
        AbortSignal.abort()
      )
    ).rejects.toMatchObject({ code: 'unauthorized' })
    const old = disclosure.bind('read', body, caller)
    const suppress = {
      ...ad.body,
      requestId: 'disclosure_eviction',
      requester: rootKey.toPublicKey().toString()
    }
    const signed = signOutputPacket('root-eviction-request', suppress, rootKey),
      retained = await f.store.retain(signed, suppress.requester, {
        now: '150',
        maximumLifetimeSeconds: '86400',
        futureClockSeconds: '5'
      })
    await f.store.evaluate({
      requestDigest: retained.digest,
      expectedRevision: (await f.store.head()).revision,
      now: '150',
      targets: [{ index: 0, disposition: 'accept', eligible: true, reasonCode: 'reviewed' }]
    })
    await expect(
      old.enqueue(
        bytes,
        caller.principal,
        () => {
          sends++
          return undefined
        },
        new AbortController().signal
      )
    ).rejects.toMatchObject({ code: 'reset-required' })
    const control =
      '{"version":1,"error":{"code":"reset-required","message":"Serving state changed","retryable":false}}'
    await disclosure.control(control, caller).enqueue(
      new TextEncoder().encode(control),
      caller.principal,
      () => {
        expect(providerGate).toBe(true)
        sends++
        return undefined
      },
      new AbortController().signal
    )
    expect(sends).toBe(2)
  } finally {
    await f.cleanup()
  }
})

it('requires a qualified inventory for opaque extensions and pins the installed disclosure methods', async () => {
  const ad = await rootAdvertisementFixture(),
    b = batch(ad),
    extension = 'urn:test:opaque-root-extension'
  b.extensions = { [extension]: { outputs: [ad.body.targets[0].advertisement] } }
  expect(() => rootLookupAdvertisementTargets(canonicalOutputJSON(b), [extension])).toThrow(
    'installed inventory'
  )
  delete b.extensions
  b.groups[0].observations[0].extensions = { [extension]: { output: 'additional' } }
  expect(() => rootLookupAdvertisementTargets(canonicalOutputJSON(b), [extension])).toThrow(
    'installed inventory'
  )
  delete b.groups[0].observations[0].extensions
  const f = await eligible()
  try {
    const native: RootLookupServingDelegate = {
        bind: () => ({ enqueue: async () => {} }),
        control: () => ({ enqueue: async () => {} })
      },
      disclosure = new RootLookupServingDisclosure({
        disclosure: native,
        serving: f.serving,
        authorize: () => true
      }),
      caller = { principal: null, capabilityDigest: policy },
      bind = native.bind,
      control = native.control
    const pending = disclosure.control('{}', caller)
    native.bind = () => ({ enqueue: async () => {} })
    expect(() => disclosure.bind('open', canonicalOutputJSON(b), caller)).toThrow('owner changed')
    native.bind = bind
    native.control = () => ({ enqueue: async () => {} })
    expect(() => disclosure.control('{}', caller)).toThrow('owner changed')
    let sends = 0
    await expect(
      pending.enqueue(
        new TextEncoder().encode('{}'),
        rootKey.toPublicKey().toString(),
        () => {
          sends++
          return undefined
        },
        new AbortController().signal
      )
    ).rejects.toThrow('owner changed')
    expect(sends).toBe(0)
    native.control = control
    expect(() => disclosure.control('{}', caller)).not.toThrow()
  } finally {
    await f.cleanup()
  }
})
