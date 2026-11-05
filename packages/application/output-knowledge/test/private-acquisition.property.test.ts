import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import {
  advancePrivateAcquisitionProgress as advance,
  parsePrivateAcquisitionProgress as parse,
  type PrivateAcquisitionEvent,
  type PrivateAcquisitionProgress
} from '../src/private/PrivateAcquisitionProgress.js'
import { acquisitionFixture } from './private-acquisition.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number.parseInt(process.env.FAST_CHECK_NUM_RUNS ?? '', 10)
const requestedSeed = Number.parseInt(process.env.FAST_CHECK_SEED ?? '', 10)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {})
})

it('preserves one invoice, funding operation and delivery obligation through 300 deadline/recovery schedules', async () => {
  const f = await acquisitionFixture()
  await fc.assert(
    fc.asyncProperty(
      fc.array(
        fc.tuple(
          fc.constantFrom(
            'pin',
            'invalid',
            'reserve',
            'credit',
            'reject',
            'prepare',
            'deliver',
            'fail',
            'expire',
            'restart'
          ),
          fc.integer({ min: 0, max: 90000 })
        ),
        { minLength: 4, maxLength: 24 }
      ),
      async schedule => {
        let state = f.initial(),
          phase: PrivateAcquisitionProgress['phase'] = 'quoted'
        let candidate: 'none' | 'pending' | 'invalid' | 'accepted' = 'none',
          funded = false,
          credited = false,
          now = 1
        for (const [action, advanceSeconds] of schedule) {
          now += advanceSeconds
          if (action === 'restart') {
            state = parse(JSON.parse(JSON.stringify(state)))
            continue
          }
          let event: PrivateAcquisitionEvent,
            allowed = false
          switch (action) {
            case 'pin':
              event = { type: 'pin', payment: f.payment() }
              allowed = candidate !== 'none' || (phase === 'quoted' && now < 86500)
              break
            case 'invalid':
              event = {
                type: 'invalid',
                candidateDigest: state.candidate?.digest ?? '00'.repeat(32),
                reason: 'invalid-evidence'
              }
              allowed = phase === 'quoted' && candidate === 'pending'
              break
            case 'reserve':
              event = {
                type: 'reserve-funding',
                candidateDigest: state.candidate?.digest ?? '00'.repeat(32),
                sellerPaymentKey: f.sellerPaymentKey,
                acceptance: {
                  chain: f.chain,
                  txid: f.transaction.id('hex'),
                  policy: { kind: 'local-admission' },
                  acceptedAt: '19'
                }
              }
              allowed = phase === 'quoted' && candidate === 'pending'
              break
            case 'credit':
              event = { type: 'wallet-accepted', receipt: f.receipt(f.reserved()) }
              allowed = phase === 'funding-pending'
              break
            case 'reject':
              event = {
                type: 'wallet-rejected',
                operationId: f.reserved().funding!.operation.id,
                reason: 'payment-script-mismatch'
              }
              allowed = phase === 'funding-pending'
              break
            case 'prepare':
              event = { type: 'prepare-delivery' }
              allowed = phase === 'funded' || phase === 'delivery-pending'
              break
            case 'deliver':
              event = { type: 'delivered' }
              allowed = phase === 'delivery-pending'
              break
            case 'fail':
              event = { type: 'fail', reason: 'protected-material-unavailable' }
              allowed = phase === 'funded' || phase === 'delivery-pending'
              break
            case 'expire':
              event = { type: 'expire' }
              allowed = phase === 'quoted' && candidate !== 'pending' && now >= 86500
              break
          }
          const before = JSON.stringify(state)
          if (!allowed) {
            expect(() => advance(state, event, now.toString())).toThrow()
            expect(JSON.stringify(state)).toBe(before)
            continue
          }
          state = advance(state, event, now.toString())
          if (action === 'pin' && candidate === 'none') candidate = 'pending'
          if (action === 'invalid') candidate = 'invalid'
          if (action === 'reserve') {
            candidate = 'accepted'
            funded = true
            phase = 'funding-pending'
          }
          if (action === 'credit') {
            credited = true
            phase = 'funded'
          }
          if (action === 'reject' || action === 'fail') phase = 'failed'
          if (action === 'prepare') phase = 'delivery-pending'
          if (action === 'deliver') phase = 'delivered'
          if (action === 'expire') phase = 'expired'
          expect(state.phase).toBe(phase)
          expect(state.challenge).toEqual(f.challenge)
          expect(state.funding !== null).toBe(funded)
          expect(state.walletReceipt !== null).toBe(credited)
          expect(state.candidate?.verdict ?? 'none').toBe(candidate)
          if (funded) expect(state.funding!.operation).toEqual(f.reserved().funding!.operation)
          if (state.delivery !== null)
            expect(BigInt(state.recoveryUntil)).toBeGreaterThanOrEqual(
              BigInt(state.delivery.deliveredAt ?? state.delivery.preparedAt) + 86400n
            )
        }
      }
    )
  )
}, 160000)
