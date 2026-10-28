import { expect, it } from '@jest/globals'
import { OutputProtocolError, type OutputJSONObject, type OutputJSON } from '@bsv/sdk'
import { acquisitionStoreFixture } from './private-acquisition-store.fixture.js'
import { privateAcquisitionAddress } from '../src/private/PrivateAcquisitionState.js'
import { PrivateAcquisitionWork } from '../src/private/PrivateAcquisitionWork.js'
import { PrivateAcquisitionCoordinator } from '../src/private/PrivateAcquisitionCoordinator.js'
import { PrivateAcquisitionReconciler } from '../src/private/PrivateAcquisitionReconciler.js'
import { acquisitionCoordinatorFixture } from './private-acquisition-coordinator.fixture.js'
async function fixture() {
  const f = await acquisitionCoordinatorFixture()
  let allowed = true
  const work = new PrivateAcquisitionWork(
    f.f.owner.domain,
    f.f.owner.store,
    f.f.f.contracts,
    f.options.clock,
    () => allowed
  )
  const coordinator = new PrivateAcquisitionCoordinator({ ...f.options, recovery: work })
  const worker = new PrivateAcquisitionReconciler(coordinator, 1)
  return {
    ...f,
    work,
    worker,
    background: coordinator,
    setWorker: (value: boolean) => {
      allowed = value
    },
    close: async () => {
      await coordinator.stop()
      await f.dispose()
    }
  }
}
it('finishes a retained paid candidate after client departure without repricing or a second credit', async () => {
  const f = await fixture()
  try {
    await f.quote()
    f.setRelease(false)
    await f.pay()
    const page = f.work.scan(null, 1)
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({
      acquisitionId: f.f.id,
      buyer: f.caller.buyer,
      phase: 'quoted',
      capability: f.caller.capability,
      profile: f.caller.profile
    })
    expect(JSON.stringify(page)).not.toContain('transaction')
    f.f.setNow(f.current()!.original.challenge.recoveryUntil)
    f.setAvailable(false)
    f.setRelease(true)
    expect(await f.worker.runOnce()).toMatchObject({
      outcomes: [{ acquisitionId: f.f.id, status: 'delivered' }],
      blocked: [],
      wrapped: true
    })
    expect(f.getCredits()).toBe(1)
    expect(f.counts.prepare).toBe(1)
    expect(f.projected()).toMatchObject({ status: 'delivered', result: { context: 'AQID' } })
    expect(await f.worker.runOnce()).toEqual({ outcomes: [], blocked: [], wrapped: true })
    expect(f.getCredits()).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)
it('keeps worker permission separate from the current buyer and domain permissions', async () => {
  const f = await fixture()
  try {
    await f.quote()
    f.setRelease(false)
    await f.pay()
    f.setRelease(true)
    f.setWorker(false)
    expect(() => f.work.scan(null, 1)).toThrow('authority changed')
    await expect(f.worker.runOnce()).rejects.toThrow('authority changed')
    f.setWorker(true)
    f.setAccess(false)
    expect(await f.worker.runOnce()).toMatchObject({ outcomes: [{ status: 'not-found' }] })
    expect(f.getCredits()).toBe(0)
    f.setAccess(true)
    f.setAuthority(false)
    expect(await f.worker.runOnce()).toMatchObject({ outcomes: [{ status: 'context-changed' }] })
    expect(f.getCredits()).toBe(0)
    f.setAuthority(true)
    expect(await f.worker.runOnce()).toMatchObject({ outcomes: [{ status: 'delivered' }] })
    expect(f.getCredits()).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)
it('expires unpaid retained quotes but never creates payment or another original', async () => {
  const f = await fixture()
  try {
    await f.quote()
    f.f.setNow(f.current()!.original.challenge.recoveryUntil)
    expect(await f.worker.runOnce()).toMatchObject({ outcomes: [{ status: 'expired' }] })
    expect(f.getCredits()).toBe(0)
    expect(f.counts.prepare).toBe(1)
    expect(f.work.resolve(f.f.id)).toBeUndefined()
    expect(await f.worker.runOnce()).toMatchObject({ outcomes: [], wrapped: true })
  } finally {
    await f.close()
  }
}, 30000)
it('requires explicit recovery installation and pinned native worker methods', async () => {
  const f = await fixture()
  try {
    expect(() => f.coordinator.scanWork(null, 1)).toThrow('not installed')
    await expect(f.coordinator.reconcile(f.f.id)).rejects.toThrow('not installed')
    await f.quote()
    f.work.resolve = () => undefined
    await expect(f.worker.runOnce()).rejects.toThrow('stopped or changed')
    expect(f.getCredits()).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)
it('stops the explicit loop and rejects future passes without keeping an unattended timer', async () => {
  const f = await fixture()
  try {
    await f.quote()
    f.f.setNow(f.current()!.original.challenge.recoveryUntil)
    let report!: () => void
    const observed = new Promise<void>(resolve => {
      report = resolve
    })
    const running = f.worker.start(100, result => {
      expect(result.outcomes[0]?.status).toBe('expired')
      report()
    })
    await Promise.race([observed, running.done])
    await running.stop()
    await running.done
    await expect(f.worker.runOnce()).rejects.toThrow('stopped or changed')
    expect(() => f.worker.start(100, () => {})).toThrow('already started or stopped')
    expect(f.getCredits()).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)
it('cancels a caller pass without letting another pass overlap unresolved physical wallet work', async () => {
  const f = await acquisitionCoordinatorFixture()
  let finish!: (value: { state: 'unknown' }) => void, entered!: () => void
  const observed = new Promise<void>(resolve => {
    entered = resolve
  })
  const wallet = {
    status: async () => {
      entered()
      return await new Promise<{ state: 'unknown' }>(resolve => {
        finish = resolve
      })
    },
    internalize: f.options.wallet.internalize
  }
  const recovery = new PrivateAcquisitionWork(
    f.f.owner.domain,
    f.f.owner.store,
    f.f.f.contracts,
    f.options.clock,
    () => true
  )
  const owner = new PrivateAcquisitionCoordinator({ ...f.options, recovery, wallet })
  const worker = new PrivateAcquisitionReconciler(owner),
    abort = new AbortController()
  try {
    await f.quote()
    f.setRelease(false)
    await f.pay()
    f.setRelease(true)
    const running = worker.runOnce(abort.signal)
    await observed
    abort.abort()
    await expect(worker.runOnce()).rejects.toThrow('already active')
    finish({ state: 'unknown' })
    await expect(running).rejects.toThrow()
    expect(f.getCredits()).toBe(0)
  } finally {
    finish?.({ state: 'unknown' })
    await owner.stop()
    await f.dispose()
  }
}, 30000)

it('refuses cancelled discovery and a changed pinned native enumeration method', async () => {
  const f = await fixture()
  const ledger = f.f.owner.domain.ledger,
    enumerate = ledger.enumerate
  try {
    const abort = new AbortController()
    abort.abort()
    expect(f.work.isCurrent(abort.signal)).toBe(false)
    expect(() => f.work.scan(null, 1, abort.signal)).toThrow('authority changed')
    ledger.enumerate = enumerate.bind(ledger)
    expect(f.work.isCurrent()).toBe(false)
    expect(() => f.work.scan(null, 1)).toThrow('authority changed')
    expect(f.getCredits()).toBe(0)
  } finally {
    ledger.enumerate = enumerate
    await f.close()
  }
}, 30000)
it('returns an empty bounded page without inventing recovery work', async () => {
  const f = await fixture()
  try {
    expect(f.work.scan('ff'.repeat(32), 1)).toEqual({ entries: [], blocked: [], next: null })
    expect(f.getCredits()).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)
it('never treats promised worker authority as synchronous permission', async () => {
  const f = await fixture()
  try {
    const work = new PrivateAcquisitionWork(
      f.f.owner.domain,
      f.f.owner.store,
      f.f.f.contracts,
      f.options.clock,
      (() => Promise.resolve(true)) as unknown as () => boolean
    )
    expect(work.isCurrent()).toBe(false)
    expect(() => work.scan(null, 1)).toThrow('authority changed')
    expect(f.getCredits()).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)
it('separates foreign state and reports future or malformed acquisition records independently', async () => {
  const f = await fixture()
  try {
    const ledger = f.f.owner.domain.ledger
    const keys = [31, 32, 33, 34].map(n => n.toString(16).padStart(64, '0'))
    const values: OutputJSONObject[] = [
      { format: 7 },
      { format: 'other-state/1' },
      { format: 'private-acquisition-state/2' },
      { format: 'private-acquisition-state/1', progress: {} }
    ]
    const revision = ledger.read(
      [{ kind: 'acquisition', key: keys[0] }],
      f.options.clock,
      () => {}
    ).revision
    ledger.commit(
      revision,
      values.map((value, index) => ({
        kind: 'acquisition' as const,
        key: keys[index],
        expectedRevision: null,
        reservedBytes: 1024,
        reservedUpdates: 4,
        value
      })),
      f.options.clock,
      () => {}
    )
    expect(f.work.scan(null, 64)).toEqual({
      entries: [],
      blocked: [
        { key: keys[2], status: 'unsupported' },
        { key: keys[3], status: 'invalid' }
      ],
      next: null
    })
    expect(f.getCredits()).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)
it('reports an unavailable projection port without returning deliverable work or crediting payment', async () => {
  const f = await fixture()
  try {
    await f.quote()
    const ledger = f.f.owner.domain.ledger
    const key = ledger.enumerate('acquisition', null, 1, f.options.clock, () => {}).entries[0].key
    const work = new PrivateAcquisitionWork(
      f.f.owner.domain,
      {
        load() {
          throw new Error('synthetic projection unavailable')
        }
      },
      f.f.f.contracts,
      f.options.clock,
      () => true
    )
    expect(work.scan(null, 1)).toEqual({
      entries: [],
      blocked: [{ key, status: 'unavailable' }],
      next: null
    })
    expect(f.getCredits()).toBe(0)
    expect(f.counts.prepare).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)

function nativeWork(f: Awaited<ReturnType<typeof acquisitionStoreFixture>>, current = () => true) {
  return new PrivateAcquisitionWork(f.owner.domain, f.owner.store, f.f.contracts, f.clock, current)
}
it.each([undefined, 0])(
  'requires an installed synchronous clock (%s)',
  async clock => {
    const f = await acquisitionStoreFixture()
    try {
      expect(
        () =>
          new PrivateAcquisitionWork(
            f.owner.domain,
            f.owner.store,
            f.f.contracts,
            clock as unknown as () => string,
            () => true
          )
      ).toThrow('Acquisition worker clock is required')
    } finally {
      f.dispose()
    }
  },
  30000
)
it.each([undefined, 0, async () => true])(
  'refuses non-synchronous worker authorization (%s)',
  async authority => {
    const f = await acquisitionStoreFixture()
    try {
      expect(
        () =>
          new PrivateAcquisitionWork(
            f.owner.domain,
            f.owner.store,
            f.f.contracts,
            f.clock,
            authority as unknown as () => boolean
          )
      ).toThrow('Acquisition worker authority must be synchronous')
    } finally {
      f.dispose()
    }
  },
  30000
)
it.each(['seller', 'chain'] as const)(
  'refuses a worker installed for another custody %s',
  async field => {
    const f = await acquisitionStoreFixture(),
      contracts = f.f.contracts,
      configuration = contracts.configuration,
      installed = configuration.call(contracts)
    try {
      contracts.configuration = () =>
        field === 'seller'
          ? { ...installed, seller: 'different-installed-seller' }
          : { ...installed, chain: { ...installed.chain, genesisHash: 'ef'.repeat(32) } }
      expect(() => nativeWork(f)).toThrow(
        expect.objectContaining({
          code: 'context-changed',
          message: 'Acquisition work custody installation differs'
        })
      )
    } finally {
      contracts.configuration = configuration
      f.dispose()
    }
  },
  30000
)
it.each(['ledger', 'identity', 'address', 'read', 'enumerate', 'load', 'restore'] as const)(
  'retires worker authority when its pinned %s owner or method changes',
  async name => {
    const f = await acquisitionStoreFixture(),
      work = nativeWork(f)
    const owners = {
      ledger: f.owner.domain,
      identity: f.owner.domain,
      address: f.owner.domain.identity,
      read: f.owner.domain.ledger,
      enumerate: f.owner.domain.ledger,
      load: f.owner.store,
      restore: f.f.contracts
    }
    const owner = owners[name]
    const descriptor = Object.getOwnPropertyDescriptor(owner, name)
    const original: unknown = Reflect.get(owner, name)
    try {
      const replacement =
        typeof original === 'function' ? original.bind(owner) : new Proxy(original as object, {})
      Object.defineProperty(owner, name, { configurable: true, writable: true, value: replacement })
      expect(work.isCurrent()).toBe(false)
    } finally {
      if (descriptor) Object.defineProperty(owner, name, descriptor)
      else Reflect.deleteProperty(owner, name)
      expect(work.isCurrent()).toBe(true)
      f.dispose()
    }
  },
  30000
)
it('rechecks cancellation after the synchronous authority callback', async () => {
  const f = await acquisitionStoreFixture(),
    abort = new AbortController()
  try {
    const work = nativeWork(f, () => {
      abort.abort()
      return true
    })
    expect(work.isCurrent(abort.signal)).toBe(false)
  } finally {
    f.dispose()
  }
}, 30000)
it.each([null, 7, [], { service: 7 }] as OutputJSON[])(
  'blocks a retained original with a malformed service request (%j)',
  async request => {
    const f = await acquisitionStoreFixture()
    try {
      f.quote()
      const ledger = f.owner.domain.ledger,
        address = privateAcquisitionAddress(f.owner.domain.identity, 'quote', f.id),
        snapshot = ledger.read([address], f.clock, f.guard),
        original = snapshot.records[0]!
      ledger.commit(
        snapshot.revision,
        [
          {
            kind: original.kind,
            key: original.key,
            expectedRevision: original.revision,
            reservedBytes: original.reservedBytes,
            reservedUpdates: original.reservedUpdates,
            value: { ...original.value, request }
          }
        ],
        f.clock,
        f.guard
      )
      const work = nativeWork(f),
        key = privateAcquisitionAddress(f.owner.domain.identity, 'acquisition', f.id).key
      expect(work.scan(null, 1)).toEqual({
        entries: [],
        blocked: [{ key, status: 'unavailable' }],
        next: null
      })
      expect(() => work.resolve(f.id)).toThrow(
        expect.objectContaining({
          code: 'unavailable',
          message: 'Acquisition work request is unavailable'
        })
      )
    } finally {
      f.dispose()
    }
  },
  30000
)
it('leaves a different service tag out of this worker queue', async () => {
  const f = await acquisitionStoreFixture()
  try {
    f.quote()
    const ledger = f.owner.domain.ledger,
      address = privateAcquisitionAddress(f.owner.domain.identity, 'quote', f.id),
      snapshot = ledger.read([address], f.clock, f.guard),
      original = snapshot.records[0]!
    ledger.commit(
      snapshot.revision,
      [
        {
          kind: original.kind,
          key: original.key,
          expectedRevision: original.revision,
          reservedBytes: original.reservedBytes,
          reservedUpdates: original.reservedUpdates,
          value: { ...original.value, request: { ...f.original.request, service: 'ls_another' } }
        }
      ],
      f.clock,
      f.guard
    )
    const work = nativeWork(f)
    expect(work.scan(null, 1)).toEqual({ entries: [], blocked: [], next: null })
    expect(work.resolve(f.id)).toBeUndefined()
  } finally {
    f.dispose()
  }
}, 30000)
it.each(['kind', 'key'] as const)(
  'blocks an adapter returning a record under a different %s',
  async field => {
    const f = await acquisitionStoreFixture(),
      ledger = f.owner.domain.ledger,
      read = ledger.read
    try {
      f.quote()
      ledger.read = (...args) => {
        const snapshot = read.apply(ledger, args)
        return {
          ...snapshot,
          records: snapshot.records.map(record =>
            !record || record.kind !== 'acquisition'
              ? record
              : {
                  ...record,
                  ...(field === 'kind' ? { kind: 'quote' as const } : { key: 'fe'.repeat(32) })
                }
          )
        }
      }
      const work = nativeWork(f),
        key = privateAcquisitionAddress(f.owner.domain.identity, 'acquisition', f.id).key
      expect(work.scan(null, 1)).toEqual({
        entries: [],
        blocked: [{ key: field === 'key' ? 'fe'.repeat(32) : key, status: 'unavailable' }],
        next: null
      })
      expect(() => work.resolve(f.id)).toThrow(
        expect.objectContaining({
          code: 'unavailable',
          message: 'Acquisition work record address differs'
        })
      )
    } finally {
      ledger.read = read
      f.dispose()
    }
  },
  30000
)
it('blocks an original that disappears at the installed native projection port', async () => {
  const f = await acquisitionStoreFixture(),
    load = f.owner.store.load
  try {
    f.quote()
    f.owner.store.load = () => undefined
    const work = nativeWork(f),
      key = privateAcquisitionAddress(f.owner.domain.identity, 'acquisition', f.id).key
    expect(work.scan(null, 1)).toEqual({
      entries: [],
      blocked: [{ key, status: 'unavailable' }],
      next: null
    })
    expect(() => work.resolve(f.id)).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Acquisition work original is unavailable'
      })
    )
  } finally {
    f.owner.store.load = load
    f.dispose()
  }
}, 30000)
it.each(['seller', 'service', 'chain'] as const)(
  'blocks a native projection returning another installed %s',
  async field => {
    const f = await acquisitionStoreFixture(),
      store = f.owner.store,
      load = store.load
    try {
      f.quote()
      store.load = (...args) => {
        const loaded = load.apply(store, args)
        if (!loaded) return loaded
        const changed = structuredClone(loaded)
        if (field === 'seller') changed.original.challenge.seller = 'different-seller'
        else if (field === 'service') changed.original.request.service = 'ls_another'
        else changed.original.request.listing.chain.genesisHash = 'ef'.repeat(32)
        return changed
      }
      const work = nativeWork(f),
        key = privateAcquisitionAddress(f.owner.domain.identity, 'acquisition', f.id).key
      expect(work.scan(null, 1)).toEqual({
        entries: [],
        blocked: [{ key, status: 'context-changed' }],
        next: null
      })
      expect(() => work.resolve(f.id)).toThrow(
        expect.objectContaining({
          code: 'context-changed',
          message: 'Acquisition work installation differs'
        })
      )
    } finally {
      store.load = load
      f.dispose()
    }
  },
  30000
)
it.each(['quote', 'reserve', 'fund', 'prepare'] as const)(
  'resolves actual retained %s work through native ownership',
  async operation => {
    const f = await acquisitionStoreFixture()
    try {
      const retained = f[operation](),
        work = nativeWork(f),
        selected = f.f.contracts.restore(retained.original.capability)
      const expected = {
        acquisitionId: f.id,
        buyer: f.buyer,
        recordRevision: retained.row.revision,
        phase: retained.state.progress.phase,
        capability: selected.digest,
        profile: selected.profile.id
      }
      expect(work.resolve(f.id)).toEqual(expected)
      expect(work.scan(null, 1)).toEqual({ entries: [expected], blocked: [], next: null })
    } finally {
      f.dispose()
    }
  },
  30000
)
it.each(['expired', 'failed'] as const)(
  'leaves actual terminal %s records out of the recovery queue',
  async phase => {
    const f = await acquisitionStoreFixture()
    try {
      const retained = phase === 'expired' ? f.quote() : f.fund()
      if (phase === 'expired') f.setNow(retained.original.challenge.recoveryUntil)
      f.owner.store.advance(
        f.id,
        f.buyer,
        retained.row.revision,
        phase === 'expired'
          ? { type: 'expire' }
          : { type: 'fail', reason: 'protected-material-unavailable' },
        f.clock,
        f.guard
      )
      const work = nativeWork(f)
      expect(work.resolve(f.id)).toBeUndefined()
      expect(work.scan(null, 1)).toEqual({ entries: [], blocked: [], next: null })
    } finally {
      f.dispose()
    }
  },
  30000
)
it('refuses a projection failure after worker authority is revoked instead of reporting a recoverable item', async () => {
  const f = await acquisitionStoreFixture(),
    store = f.owner.store,
    load = store.load
  let allowed = true
  try {
    f.quote()
    store.load = () => {
      allowed = false
      throw new Error('synthetic projection unavailable')
    }
    const work = nativeWork(f, () => allowed)
    expect(() => work.scan(null, 1)).toThrow(
      expect.objectContaining({
        code: 'context-changed',
        message: 'Acquisition worker authority changed'
      })
    )
  } finally {
    store.load = load
    f.dispose()
  }
}, 30000)

it.each(['absent', 'unavailable', 'limited'] as const)(
  'reports %s reconciliation without exposing private diagnostics or starting payment',
  async outcome => {
    const f = await fixture(),
      coordinator = f.background,
      reconcile = coordinator.reconcile
    try {
      await f.quote()
      coordinator.reconcile = async () => {
        if (outcome === 'absent') return undefined
        if (outcome === 'limited')
          throw new OutputProtocolError('limited', 'synthetic-private-diagnostic')
        throw new Error('synthetic-private-diagnostic')
      }
      const worker = new PrivateAcquisitionReconciler(coordinator, 1)
      const report = await worker.runOnce()
      expect(report).toEqual({
        outcomes: [
          { acquisitionId: f.f.id, status: outcome === 'absent' ? 'no-pending-work' : outcome }
        ],
        blocked: [],
        wrapped: true
      })
      expect(JSON.stringify(report)).not.toContain('synthetic-private-diagnostic')
      expect(f.getCredits()).toBe(0)
    } finally {
      coordinator.reconcile = reconcile
      await f.close()
    }
  },
  30000
)
it.each([0, 65, 1.5, NaN])(
  'bounds installed recovery page capacity (%s)',
  async maximum => {
    const f = await fixture()
    try {
      expect(() => new PrivateAcquisitionReconciler(f.background, maximum)).toThrow(
        'Invalid acquisition reconciliation page capacity'
      )
    } finally {
      await f.close()
    }
  },
  30000
)
it.each(['scanWork', 'reconcile', 'drainReconciliation'] as const)(
  'refuses a replaced installed coordinator %s method before discovery',
  async method => {
    const f = await fixture(),
      coordinator = f.background,
      worker = new PrivateAcquisitionReconciler(coordinator)
    const descriptor = Object.getOwnPropertyDescriptor(coordinator, method),
      original: unknown = Reflect.get(coordinator, method)
    try {
      Object.defineProperty(coordinator, method, {
        configurable: true,
        writable: true,
        value: (original as (...args: never[]) => unknown).bind(coordinator)
      })
      await expect(worker.runOnce()).rejects.toThrow(
        expect.objectContaining({
          code: 'context-changed',
          message: 'Private acquisition reconciler stopped or changed'
        })
      )
      expect(f.getCredits()).toBe(0)
    } finally {
      if (descriptor) Object.defineProperty(coordinator, method, descriptor)
      else Reflect.deleteProperty(coordinator, method)
      await f.close()
    }
  },
  30000
)
it.each([99, 60001, 100.5, NaN])(
  'refuses an invalid explicit loop interval (%s)',
  async interval => {
    const f = await fixture()
    try {
      expect(() => f.worker.start(interval, () => {})).toThrow(
        'Invalid acquisition reconciliation interval'
      )
    } finally {
      await f.close()
    }
  },
  30000
)
it.each([undefined, 1, async () => {}])(
  'requires a synchronous report observer (%s)',
  async report => {
    const f = await fixture()
    try {
      expect(() => f.worker.start(100, report as unknown as () => void)).toThrow(
        'Acquisition reconciler requires a synchronous report observer'
      )
    } finally {
      await f.close()
    }
  },
  30000
)
it.each(['throw', 'number', 'promise'] as const)(
  'keeps explicit-loop observer failure observable (%s)',
  async behavior => {
    const f = await fixture(),
      failure = new Error('synthetic observer failed')
    let running: ReturnType<PrivateAcquisitionReconciler['start']> | undefined
    try {
      const observers = {
        throw: () => {
          throw failure
        },
        number: () => 1,
        promise: () => Promise.reject(failure)
      }
      running = f.worker.start(100, observers[behavior])
      if (behavior === 'throw') await expect(running.done).rejects.toBe(failure)
      else
        await expect(running.done).rejects.toThrow(
          'Acquisition reconciliation observer must finish synchronously'
        )
      expect(f.getCredits()).toBe(0)
    } finally {
      if (running) await running.stop().catch(() => undefined)
      await f.close()
    }
  },
  30000
)
it('finishes stopped-loop cleanup when the observer throws after cancelling that loop', async () => {
  const f = await fixture(),
    failure = new Error('synthetic observer failure after stop')
  let running!: ReturnType<PrivateAcquisitionReconciler['start']>,
    stopping: Promise<void> | undefined
  try {
    running = f.worker.start(100, () => {
      stopping = running.stop()
      throw failure
    })
    await expect(running.done).resolves.toBeUndefined()
    await stopping
    await expect(f.worker.runOnce()).rejects.toThrow('stopped or changed')
    expect(f.getCredits()).toBe(0)
  } finally {
    if (running) await running.stop()
    await f.close()
  }
}, 30000)
it('advances a bounded native recovery cursor across multiple originals and wraps without payment', async () => {
  const f = await fixture()
  try {
    await f.quote()
    // A fresh quote needs its own permanently reserved payment prefix.
    f.f.f.terms.derivationPrefix = 'c2Vjb25kLXVucGFpZC1xdW90ZQ=='
    await f.background.acquire(
      { ...f.request, requestId: 'second-unpaid-native-work' },
      undefined,
      f.caller
    )
    f.f.setNow(f.current()!.original.challenge.recoveryUntil)
    const first = await f.worker.runOnce(),
      second = await f.worker.runOnce()
    expect(first.outcomes).toHaveLength(1)
    expect(first.outcomes[0].status).toBe('expired')
    expect(first.wrapped).toBe(false)
    expect(second.outcomes).toHaveLength(1)
    expect(second.outcomes[0].status).toBe('expired')
    expect(second.outcomes[0].acquisitionId).not.toBe(first.outcomes[0].acquisitionId)
    expect(second.wrapped).toBe(true)
    expect((await f.worker.runOnce()).outcomes).toEqual([])
    expect(f.getCredits()).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)

it.each([1, 64])(
  'accepts the exact supported recovery page boundary (%s)',
  async maximum => {
    const f = await fixture()
    try {
      const worker = new PrivateAcquisitionReconciler(f.background, maximum)
      expect(await worker.runOnce()).toEqual({ outcomes: [], blocked: [], wrapped: true })
    } finally {
      await f.close()
    }
  },
  30000
)
it.each([100, 60000])(
  'accepts the exact supported explicit-loop interval (%s)',
  async interval => {
    const f = await fixture()
    let running!: ReturnType<PrivateAcquisitionReconciler['start']>,
      stopping: Promise<void> | undefined
    try {
      running = f.worker.start(interval, () => {
        stopping = running.stop()
      })
      await running.done
      await stopping
      expect(f.getCredits()).toBe(0)
    } finally {
      if (running) await running.stop()
      await f.close()
    }
  },
  30000
)
it('refuses a recovery adapter resolving another acquisition under a requested identity', async () => {
  const f = await acquisitionStoreFixture(),
    ledger = f.owner.domain.ledger,
    read = ledger.read
  try {
    f.quote()
    const address = privateAcquisitionAddress(f.owner.domain.identity, 'acquisition', f.id)
    ledger.read = (addresses, clock, guard) =>
      read.call(
        ledger,
        addresses.map(value => (value.kind === 'acquisition' ? address : value)),
        clock,
        guard
      )
    const work = nativeWork(f)
    expect(() => work.resolve('cd'.repeat(32))).toThrow(
      expect.objectContaining({
        code: 'unavailable',
        message: 'Acquisition work address differs'
      })
    )
  } finally {
    ledger.read = read
    f.dispose()
  }
}, 30000)
it('skips a record no longer returned by the installed recovery read port', async () => {
  const f = await acquisitionStoreFixture(),
    ledger = f.owner.domain.ledger,
    read = ledger.read
  try {
    f.quote()
    ledger.read = (...args) => {
      const snapshot = read.apply(ledger, args)
      return {
        ...snapshot,
        records: snapshot.records.map(record =>
          record?.kind === 'acquisition' ? undefined : record
        )
      }
    }
    expect(nativeWork(f).scan(null, 1)).toEqual({ entries: [], blocked: [], next: null })
  } finally {
    ledger.read = read
    f.dispose()
  }
}, 30000)
