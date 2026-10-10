import { expect, it } from '@jest/globals'
import { canonicalOutputJSON } from '@bsv/sdk'
import { purchaseAliasCoordinatorFixture } from './private-purchase-alias-coordinator.fixture.js'

it('composes preparation, exact per-alias admission and one immutable private release across restart and later selection', async () => {
  const f = purchaseAliasCoordinatorFixture()
  try {
    await f.prepare()
    const paid = f.f.f.variant(40)
    await f.submit(paid)
    const first = f.load()
    expect(first.progress.status).toBe('delivered')
    expect(first.aliases.state.original?.txid).toBe(paid.txid)
    expect(f.base.counts.issue).toBe(1)
    expect(f.base.counts.potatoes).toBe(1)
    let historical: unknown
    f.installation.store.disclose(first, f.f.base.buyer, f.f.f.clock, f.f.f.guard, value => {
      historical = value
    })
    await f.reopen()
    f.setMined(true)
    const later = f.f.f.variant(41)
    await f.submit(later)
    const current = f.load()
    expect(current.progress).toEqual(first.progress)
    expect(current.aliases.state.selected?.txid).toBe(later.txid)
    expect(current.aliases.state.selected?.admission).toBe('admitted')
    expect(f.base.counts.issue).toBe(1)
    expect(f.base.counts.potatoes).toBe(1)
    let replay: unknown
    f.installation.store.disclose(current, f.f.base.buyer, f.f.f.clock, f.f.f.guard, value => {
      replay = value
    })
    expect(canonicalOutputJSON(replay)).toBe(canonicalOutputJSON(historical))
    const report = (await f.coordinator.currentAlias(f.f.base.id, f.base.caller))!
    expect(report.currentAlias.txid).toBe(later.txid)
    f.setCurrent(false)
    expect(() => report.placement.checkCurrent()).toThrow('chain changed')
    await f.recover()
    expect(f.load().progress).toEqual(first.progress)
    expect(f.base.counts.issue).toBe(1)
  } finally {
    await f.dispose()
  }
})

it('retains an unknown external job before the call and reconciles it after restart without freezing later private recovery', async () => {
  const f = purchaseAliasCoordinatorFixture()
  try {
    await f.prepare()
    f.base.setAdmitted(false)
    const paid = f.f.f.variant(42)
    await f.submit(paid)
    expect(f.load().progress.status).toBe('admission-pending')
    const pending = f.load().aliases
    expect(pending.state.original?.txid).toBe(paid.txid)
    expect(pending.state.original?.admission).toBe('pending')
    expect(pending.candidates.get('original')).toEqual(paid)
    expect(pending.state.pending).toEqual([null, null])
    expect(f.base.counts.admission).toBe(1)
    await f.reopen()
    f.base.setAdmitted(true)
    await f.recover()
    expect(f.load().progress.status).toBe('delivered')
    expect(f.base.counts.admission).toBe(2)
    const counts = { ...f.base.counts }
    await f.submit(paid)
    await f.recover()
    expect(f.base.counts.issue).toBe(counts.issue)
    expect(f.base.counts.admission).toBe(counts.admission)
  } finally {
    await f.dispose()
  }
})

it('leaves ordinary issue failure pending and retries retained material without another admission or payment', async () => {
  const f = purchaseAliasCoordinatorFixture()
  try {
    await f.prepare()
    f.base.setIssue(false)
    const paid = f.f.f.variant(43)
    await expect(f.submit(paid)).rejects.toThrow('issuer unavailable')
    const pending = f.load()
    expect(pending.progress.status).toBe('admitted-delivery-pending')
    expect(pending.progress.decision).toBeNull()
    expect(pending.aliases.state.historical).toBeNull()
    f.base.setIssue(true)
    await f.reopen()
    await f.recover()
    expect(f.load().progress.status).toBe('delivered')
    expect(f.base.counts.admission).toBe(1)
    expect(f.base.counts.potatoes).toBe(1)
  } finally {
    await f.dispose()
  }
})

it('retains only an explicit independently guarded irrecoverable local decision without issuing a secret', async () => {
  const f = purchaseAliasCoordinatorFixture()
  try {
    await f.prepare()
    f.setFailure(true)
    const paid = f.f.f.variant(44)
    await f.submit(paid)
    const failed = f.load()
    expect(failed.progress.status).toBe('delivery-failed')
    expect(failed.progress.decision?.globalOutcome).toBe('unknown')
    expect(failed.candidate).toEqual(paid)
    expect(failed.aliases.state.historical).toBeNull()
    expect(f.base.counts.issue).toBe(0)
    expect(f.base.counts.potatoes).toBe(0)
    await f.reopen()
    f.setFailure(false)
    await f.recover()
    expect(f.load().progress).toEqual(failed.progress)
    expect(f.base.counts.issue).toBe(0)
  } finally {
    await f.dispose()
  }
})

it('refuses a changed native alias head during signing before committing historical release', async () => {
  const f = purchaseAliasCoordinatorFixture({
    sign: async (...args) => {
      const packet = await f.base.owner.sign(...args)
      if (args[0] === 'potatoes') f.f.f.put(f.f.f.variant(45), true)
      return packet
    }
  })
  try {
    await f.prepare()
    const paid = f.f.f.variant(46)
    await expect(f.submit(paid)).rejects.toThrow('Alias release native head changed')
    const saved = f.load()
    expect(saved.state.progress.status).toBe('prepared')
    expect(saved.aliases.state.original?.txid).toBe(paid.txid)
    expect(saved.aliases.state.selected?.txid).toBe(f.f.f.variant(45).txid)
    expect(saved.aliases.state.historical).toBeNull()
    expect(f.base.counts.issue).toBe(1)
    expect(f.base.counts.potatoes).toBe(1)
  } finally {
    await f.dispose()
  }
})

function installedMethods(f: ReturnType<typeof purchaseAliasCoordinatorFixture>) {
  const methods: ReadonlyArray<readonly [string, object, string]> = [
    ['store.load', f.installation.store, 'load'],
    ['store.installedOn', f.installation.store, 'installedOn'],
    ['store.prepare', f.installation.store, 'prepare'],
    ['store.retain', f.installation.store, 'retain'],
    ['store.fail', f.installation.store, 'fail'],
    ['store.complete', f.installation.store, 'complete'],
    ['contracts.configuration', f.installation.contracts, 'configuration'],
    ['contracts.retain', f.installation.contracts, 'retain'],
    ['contracts.restore', f.installation.contracts, 'restore'],
    ['contracts.prepare', f.installation.contracts, 'prepare'],
    ['contracts.authenticate', f.installation.contracts, 'authenticate'],
    ['contracts.original', f.installation.contracts, 'original'],
    ['access.guard', f.installation.access, 'guard'],
    ['domain.prepare', f.installation.domain, 'prepare'],
    ['domain.verify', f.installation.domain, 'verify'],
    ['domain.isCurrent', f.installation.domain, 'isCurrent'],
    ['domain.issue', f.installation.domain, 'issue'],
    ['admission.recover', f.installation.admission, 'recover'],
    ['release.assess', f.installation.release, 'assess'],
    ['aliases.installedOn', f.installation.aliases, 'installedOn'],
    ['aliases.configuration', f.installation.aliases, 'configuration'],
    ['aliases.propose', f.installation.aliases, 'propose'],
    ['aliases.admission', f.installation.aliases, 'admission'],
    ['currentness.assess', f.installation.currentness, 'assess'],
    ['failure.assess', f.installation.failure!, 'assess']
  ]
  return methods
}

it('refuses every changed installed method before recovery or external effects', async () => {
  const f = purchaseAliasCoordinatorFixture()
  try {
    await f.prepare()
    const originalState = canonicalOutputJSON(f.load().state)
    const originalAliases = canonicalOutputJSON(f.load().aliases.state)
    const counts = { ...f.base.counts }
    for (const [label, owner, key] of installedMethods(f)) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)
      try {
        Object.defineProperty(owner, key, {
          configurable: true,
          enumerable: descriptor?.enumerable ?? false,
          value() {
            throw new Error(`Changed installed method reached: ${label}`)
          }
        })
        await expect(f.recover()).rejects.toThrow('Purchase owner/authentication changed')
      } finally {
        if (descriptor) Object.defineProperty(owner, key, descriptor)
        else Reflect.deleteProperty(owner, key)
      }
      expect(f.base.counts).toEqual(counts)
      expect(canonicalOutputJSON(f.load().state)).toBe(originalState)
      expect(canonicalOutputJSON(f.load().aliases.state)).toBe(originalAliases)
    }
  } finally {
    await f.dispose()
  }
})

it('reads installed getters afresh in original order before each caller assessment', async () => {
  const f = purchaseAliasCoordinatorFixture()
  const reads: string[] = []
  const restore: Array<() => void> = []
  try {
    await f.prepare()
    const methods = installedMethods(f)
    for (const [label, owner, key] of methods) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)
      const original: unknown = Reflect.get(owner, key)
      Object.defineProperty(owner, key, {
        configurable: true,
        enumerable: descriptor?.enumerable ?? false,
        get() {
          reads.push(label)
          return original
        }
      })
      restore.push(() => {
        if (descriptor) Object.defineProperty(owner, key, descriptor)
        else Reflect.deleteProperty(owner, key)
      })
    }
    const caller = {
      ...f.base.caller,
      current() {
        reads.push('caller.current')
        return f.base.caller.current()
      }
    }
    const expected = [...methods.map(([label]) => label), 'caller.current']
    for (let attempt = 0; attempt < 2; attempt++) {
      reads.length = 0
      await f.coordinator.recover(f.f.base.id, caller)
      expect(reads.slice(0, expected.length)).toEqual(expected)
    }
  } finally {
    for (const reset of [...restore].reverse()) reset()
    await f.dispose()
  }
})
