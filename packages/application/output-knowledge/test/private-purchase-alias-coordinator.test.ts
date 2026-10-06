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
    expect(f.load().aliases.state.pending.some(entry => entry?.txid === paid.txid)).toBe(true)
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
