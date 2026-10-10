import fc from 'fast-check'
import { makeFamily, corpus, previous, accepted } from './RevenueListing.fixture.js'
import { planRevenueListingSpend, readRevenueListingPrevious } from '../RevenueListingPlan.js'
import PrivateKey from '../../../primitives/PrivateKey.js'
import Transaction from '../../../transaction/Transaction.js'
import { planRevenueListingProfileSpend } from '../RevenueListingProfilePlan.js'
import { fixture as current, activation, profile } from './RevenueListingProfile.fixture.js'

const MIN_PROPERTY_RUNS = 300
const runs = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const seed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
const path = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(runs) ? Math.max(MIN_PROPERTY_RUNS, runs) : MIN_PROPERTY_RUNS,
  ...(Number.isSafeInteger(seed) ? { seed } : {}),
  ...(path ? { path } : {})
})

test('integer revenue quanta preserve retained value and exact externally funded retirement', () => {
  const family = makeFamily()
  const base = previous(accepted[0])[0]
  fc.assert(
    fc.property(
      fc.integer({ min: 1, max: 5000 }),
      fc.integer({ min: 1, max: 5000 }),
      fc.integer({ min: 1, max: 100000 }),
      fc.integer({ min: 0, max: 9999 }),
      (first, second, units, residueSeed) => {
        const quantum = first + second
        const remainder = residueSeed % quantum
        const value = units * quantum + remainder + 1
        const descriptor = {
          ...corpus.descriptor,
          initialRevenue: {
            revision: '0',
            recipients: corpus.descriptor.initialRevenue.recipients.map((item, index) => ({
              ...item,
              weight: index === 0 ? first : second
            }))
          }
        }
        const source = readRevenueListingPrevious(base.rawTransaction)
        source.outputs[0].satoshis = value
        source.outputs[0].lockingScript = family.lock(descriptor)
        // These local construction inputs are not claimed as verified lineage evidence.
        const sources = [{ rawTransaction: source.toHex(), outputIndex: 0 }]
        const payout = planRevenueListingSpend(family, descriptor, sources, {
          operation: 'payout',
          units: String(units)
        })
        expect(payout.outputs.map(item => item.satoshis)).toEqual([
          String(remainder + 1),
          '1',
          String(units * first),
          String(units * second)
        ])
        expect(payout.minimumExternalFunding).toBe('1')
        const retire = planRevenueListingSpend(family, descriptor, sources, { operation: 'retire' })
        const retiredUnits = Math.ceil(value / quantum)
        const topUp = retiredUnits * quantum - value
        expect(retire.outputs.map(item => item.satoshis)).toEqual([
          '1',
          String(retiredUnits * first),
          String(retiredUnits * second)
        ])
        expect(retire.retirementTopUp).toBe(String(topUp))
        expect(retire.minimumExternalFunding).toBe(String(topUp + 1))
        expect(topUp).toBeGreaterThanOrEqual(0)
        expect(topUp).toBeLessThan(quantum)
        expect(payout.signers.recipients).toEqual([])
        expect(retire.successorState).toBeUndefined()
      }
    )
  )
}, 120000)

test('immutable profile keeps all listing value, exact quanta and bounded final top-ups for one through eight recipients', () => {
  const identities = Array.from({ length: 8 }, (_, index) =>
    new PrivateKey(index + 21).toPublicKey().toString()
  ).sort()
  fc.assert(
    fc.property(
      fc.array(fc.integer({ min: 1, max: 1250 }), { minLength: 1, maxLength: 8 }),
      fc.integer({ min: 1, max: 100000 }),
      fc.integer({ min: 1, max: 5000 }),
      fc.integer({ min: 0, max: 9999 }),
      fc.integer({ min: 1, max: 499999999 }),
      (weights, units, reserve, residueSeed, expiryHeight) => {
        const quantum = weights.reduce((sum, weight) => sum + weight, 0)
        const remainder = residueSeed % quantum
        const value = 2 * reserve + units * quantum + remainder
        const descriptor = {
          ...current.descriptor,
          reserve: String(reserve),
          expiryHeight,
          initialRevenue: {
            recipients: weights.map((weight, index) => ({
              identity: identities[index],
              weight
            }))
          }
        }
        // These construction inputs establish neither signed genesis nor activation ancestry.
        const source = Transaction.fromHex(activation.toHex())
        source.outputs[0].satoshis = value
        source.outputs[0].lockingScript = profile.lock('active', descriptor)
        const sources = [{ rawTransaction: source.toHex(), outputIndex: 0 }]
        const payout = planRevenueListingProfileSpend(profile, descriptor, sources, {
          operation: 'payout',
          units: String(units)
        })
        expect(payout.outputs[0].satoshis).toBe(String(2 * reserve + remainder))
        expect(payout.outputs.slice(2).map(output => output.satoshis)).toEqual(
          weights.map(weight => String(units * weight))
        )
        expect(payout.sellerAuthorization).toBeUndefined()
        const split = planRevenueListingProfileSpend(profile, descriptor, sources, {
          operation: 'split',
          firstAmount: String(reserve)
        })
        expect(split.outputs.slice(0, 2).map(output => output.satoshis)).toEqual([
          String(reserve),
          String(value - reserve)
        ])
        expect(split.sellerAuthorization!.publicKey).not.toBe(descriptor.seller)
        for (const authority of ['seller', 'expiry'] as const) {
          const action =
            authority === 'seller'
              ? { operation: 'retire', authority }
              : { operation: 'retire', authority, lockHeight: expiryHeight }
          const retire = planRevenueListingProfileSpend(profile, descriptor, sources, action)
          const finalUnits = Math.ceil(value / quantum)
          const topUp = finalUnits * quantum - value
          expect(retire.outputs.slice(1).map(output => output.satoshis)).toEqual(
            weights.map(weight => String(finalUnits * weight))
          )
          expect(retire.retirementTopUp).toBe(String(topUp))
          expect(retire.minimumExternalFunding).toBe(String(topUp + 1))
          expect(topUp).toBeGreaterThanOrEqual(0)
          expect(topUp).toBeLessThan(quantum)
          expect(retire.lockTime).toBe(authority === 'expiry' ? expiryHeight : 0)
          expect(retire.receiptIndex).toBe(0)
        }
      }
    )
  )
}, 120000)
