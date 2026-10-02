import { expect, it } from '@jest/globals'
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
