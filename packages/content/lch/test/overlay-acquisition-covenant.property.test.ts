import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { lchNativeCovenantProfileFixture } from './overlay-acquisition-covenant-profile-native.fixture.js'
import { LCHOverlayPaidCustody } from '../src/overlayAcquisitionCustody.js'
import { lchOverlayCovenantEntitlementDigest } from '../src/overlayAcquisitionCovenantEntitlement.js'
import { LCHOverlayCovenantDomain } from '../src/overlayAcquisitionCovenant.js'
import { lchNativeCovenantFixture } from './overlay-acquisition-covenant-native.fixture.js'

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number(process.env.FAST_CHECK_NUM_RUNS),
  requestedSeed = Number(process.env.FAST_CHECK_SEED),
  replayPath = process.env.FAST_CHECK_PATH
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(replayPath ? { path: replayPath } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})

it('retains one fully verified purchase through generated expiry, cancellation and local access histories', async () => {
  const f = await lchNativeCovenantFixture(),
    signal = new AbortController().signal,
    retained = { id: f.domain.id, original: f.domain.original() }
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  await f.objects.close()
  const objects = f.reopen(),
    reopened = await LCHOverlayCovenantDomain.open(f.options, retained, objects),
    custody = await LCHOverlayPaidCustody.open(
      objects,
      retained.id,
      f.prepare.recipient,
      retained.original
    ),
    entitlement = await lchOverlayCovenantEntitlementDigest(f.delivered)
  f.setNow('200')
  await expect(reopened.preflight(f.prepare, null, signal)).rejects.toThrow('window')
  await fc.assert(
    fc.asyncProperty(
      fc.integer({ min: 101, max: 1000000 }),
      fc.array(fc.constantFrom('cancel', 'deny'), { minLength: 1, maxLength: 6 }),
      async (now, history) => {
        f.setNow(String(now))
        for (const action of history) {
          f.setAccess(action !== 'deny')
          const abort = new AbortController()
          if (action === 'cancel') abort.abort()
          const result = reopened.playback(f.delivered, abort.signal)
          await expect(result).rejects.toThrow()
        }
        f.setAccess(true)
        expect(await custody.verified(entitlement)).toBe(true)
        expect(reopened.original()).toEqual(retained.original)
        expect(f.counts).toEqual({ preparation: 0, purchase: 1, release: 1 })
      }
    )
  )
  expect(await reopened.playback(f.delivered, signal)).toEqual(f.plaintext)
  await expect(reopened.preflight(f.prepare, null, signal)).rejects.toThrow('window')
}, 180000)

it('fences generated current funding windows without revoking the original acquired entitlement', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    funding = await f.domain.fundingPreflight(f.prepare, f.prepared, signal)
  await fc.assert(
    fc.property(
      fc.integer({ min: 22, max: 99 }),
      fc.integer({ min: 100, max: 1000000 }),
      (valid, expired) => {
        f.setNow(String(valid))
        expect(funding.checkCurrent()).toBeUndefined()
        f.setNow(String(expired))
        expect(() => funding.checkCurrent()).toThrow('window')
      }
    )
  )
  f.setNow('200')
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  expect(await f.domain.playback(f.delivered, signal)).toEqual(f.plaintext)
  expect(f.counts).toEqual({ preparation: 1, purchase: 1, release: 1 })
}, 180000)
