import fc from 'fast-check'
import { construct, fixture, purchase, purchaseAction } from './RevenueListingProfile.fixture.js'
import type { RevenueListingProfileAction } from '../RevenueListingProfilePlan.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('complete positive active routes preserve exact value, fixed-child authority and finality', async () => {
  const actions: fc.Arbitrary<RevenueListingProfileAction> = fc.oneof(
    fc.constant(purchaseAction),
    fc
      .integer({ min: 1, max: 1001 })
      .map(firstAmount => ({ operation: 'split', firstAmount: String(firstAmount) })),
    fc.integer({ min: 1, max: 100 }).map(units => ({ operation: 'payout', units: String(units) })),
    fc.constant({ operation: 'retire', authority: 'seller' } as const),
    fc
      .integer({
        min: fixture.descriptor.expiryHeight,
        max: fixture.descriptor.expiryHeight + 1000
      })
      .map(lockHeight => ({ operation: 'retire', authority: 'expiry', lockHeight }))
  )
  await fc.assert(
    fc.asyncProperty(actions, fc.integer({ min: 1, max: 100 }), async (action, fee) => {
      const { completed, plan } = await construct(purchase, action, fixture.descriptor, fee)
      const inputTotal = completed.inputs.reduce(
        (total, input) =>
          total + input.sourceTransaction!.outputs[input.sourceOutputIndex].satoshis!,
        0
      )
      const outputTotal = completed.outputs.reduce((total, output) => total + output.satoshis!, 0)
      expect(inputTotal - outputTotal).toBe(fee)
      expect(completed.inputs[0].unlockingScript!.chunks).toHaveLength(15)
      expect(completed.outputs).toHaveLength(plan.outputs.length + 1)
      const expiry = action.operation === 'retire' && action.authority === 'expiry'
      expect(completed.lockTime).toBe(expiry ? action.lockHeight : 0)
      expect(completed.inputs[0].sequence).toBe(expiry ? 0xfffffffe : 0xffffffff)
      expect(plan.retirementTopUp).toBe(action.operation === 'retire' ? '8' : '0')
    })
  )
}, 120000)
