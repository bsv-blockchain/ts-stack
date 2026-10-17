import { expect, it } from '@jest/globals'
import { PrivatePurchaseCoordinator } from '../src/private/PrivatePurchaseCoordinator.js'
import type { PrivatePurchaseValidation } from '../src/private/PrivatePurchasePorts.js'
import { purchaseCoordinatorFixture } from './private-purchase-coordinator.fixture.js'
import { purchaseStoreFixture } from './private-purchase-store.fixture.js'

it('retains a verified commitment in every issuance field and recovers the exact first result after expiry', async () => {
  const f = purchaseCoordinatorFixture(
    {},
    purchaseStoreFixture({}, 'native-observation-v1', 'full-purchase-commitment-v1')
  )
  try {
    await f.prepare()
    f.setAdmitted(false)
    await f.submit()
    expect(f.projected()).toHaveProperty('result.purchaseCommitment', f.f.purchaseCommitment)
    f.setAdmitted(true)
    f.setRelease(false)
    await f.recover()
    expect(f.current()!.progress.status).toBe('admitted-delivery-pending')
    expect(f.projected()).toHaveProperty('result.purchaseCommitment', f.f.purchaseCommitment)
    f.setRelease(true)
    await f.recover()
    const original = f.projected()
    expect(original).toHaveProperty('result.purchaseCommitment', f.f.purchaseCommitment)
    expect(original).toHaveProperty(
      'result.potatoes.body.purchaseCommitment',
      f.f.purchaseCommitment
    )
    await f.reopen()
    f.f.setNow('100000')
    await f.recover()
    expect(f.projected()).toEqual(original)
    expect(f.counts.potatoes).toBe(1)
    expect(f.counts.issue).toBe(1)
  } finally {
    await f.dispose()
  }
})

it.each(['missing', 'inherited', 'accessor', 'mutable', 'method-change'] as const)(
  'refuses a %s verified identity assessment before native reservation or external admission',
  async kind => {
    const f = purchaseCoordinatorFixture(
        {},
        purchaseStoreFixture({}, undefined, 'full-purchase-commitment-v1')
      ),
      verify = f.domain.verify
    await f.coordinator.stop()
    f.domain.verify = async (...args) => {
      const base = await verify(...args)
      if (kind === 'missing') return { checkCurrent: base.checkCurrent }
      if (kind === 'inherited')
        return Object.assign(Object.create({ purchaseCommitment: f.f.purchaseCommitment }), {
          checkCurrent: base.checkCurrent
        })
      if (kind === 'accessor')
        return {
          get purchaseCommitment() {
            return f.f.purchaseCommitment
          },
          checkCurrent: base.checkCurrent
        }
      const value = {
        purchaseCommitment: f.f.purchaseCommitment,
        checkCurrent: () => {
          base.checkCurrent()
          if (kind === 'mutable') value.purchaseCommitment = 'b4'.repeat(32)
          else value.checkCurrent = () => undefined
        }
      }
      return value
    }
    const owner = new PrivatePurchaseCoordinator(f.owner)
    try {
      await owner.prepare(f.f.f.f.request, f.caller)
      await expect(owner.submit(f.f.candidate, f.caller)).rejects.toThrow(
        expect.objectContaining({
          code: kind === 'mutable' || kind === 'method-change' ? 'context-changed' : 'invalid'
        })
      )
      expect(f.current()!.progress.status).toBe('prepared')
      expect(f.current()!.candidate).toBeNull()
      expect(f.counts.admission).toBe(0)
      expect(f.counts.issue).toBe(0)
    } finally {
      await owner.stop()
      await f.dispose()
    }
  }
)

it.each(['admission', 'issuance'] as const)(
  'keeps a changed commitment unresolved across awaited %s instead of committing a release',
  async phase => {
    const f = purchaseCoordinatorFixture(
        {},
        purchaseStoreFixture({}, undefined, 'full-purchase-commitment-v1')
      ),
      verify = f.domain.verify,
      admission = f.admission.recover,
      issue = f.domain.issue
    await f.coordinator.stop()
    let assessment: PrivatePurchaseValidation & { purchaseCommitment?: string }
    f.domain.verify = async (...args) => {
      assessment = { ...(await verify(...args)) }
      return assessment
    }
    if (phase === 'admission')
      f.admission.recover = async (...args) => {
        const result = await admission(...args)
        Object.assign(assessment!, { purchaseCommitment: 'b4'.repeat(32) })
        return result
      }
    else
      f.domain.issue = async (...args) => {
        const result = await issue(...args)
        Object.assign(assessment!, { purchaseCommitment: 'b4'.repeat(32) })
        return result
      }
    const owner = new PrivatePurchaseCoordinator(f.owner)
    try {
      await owner.prepare(f.f.f.f.request, f.caller)
      await expect(owner.submit(f.f.candidate, f.caller)).rejects.toThrow(
        'Verified purchase commitment changed'
      )
      expect(f.current()!.progress).toMatchObject({
        status: phase === 'admission' ? 'admission-pending' : 'admitted-delivery-pending',
        purchaseCommitment: f.f.purchaseCommitment
      })
      expect(f.counts.potatoes).toBe(0)
      expect(f.current()!.state.result.digest).toBeNull()
    } finally {
      await owner.stop()
      await f.dispose()
    }
  }
)
