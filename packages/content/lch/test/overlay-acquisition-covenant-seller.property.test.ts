import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON } from '@bsv/sdk'
import { lchCovenantSellerFixture } from './overlay-acquisition-covenant-seller.fixture.js'
import { lchCovenantProfileSellerFixture } from './overlay-acquisition-covenant-profile-seller.fixture.js'

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
  interruptAfterTimeLimit: 50000,
  markInterruptAsFailure: true
})

it('preserves one complete original preparation across 300 independent currentness and catalogue histories', async () => {
  const f = await lchCovenantSellerFixture(),
    custody = await f.prepareSeller(),
    signal = new AbortController().signal,
    original = canonicalOutputJSON(custody, { bytes: 4194304 }),
    verified = await f.sellerDomain.verify(f.submission, custody, signal)
  fc.assert(
    fc.property(
      fc.record({ allowed: fc.boolean(), catalogue: fc.boolean(), expired: fc.boolean() }),
      history => {
        f.setAccess(history.allowed)
        f.setAvailable(history.catalogue)
        f.setNow(history.expired ? '200' : '22')
        // Independent policy oracle: only current recipient/installation access
        // controls this retained obligation. Catalogue visibility and a new-offer
        // window cannot rewrite consent or erase already accepted rights.
        expect(f.sellerDomain.isCurrent(custody.original)).toBe(history.allowed)
        if (history.allowed) expect(() => verified.checkCurrent()).not.toThrow()
        else expect(() => verified.checkCurrent()).toThrow()
        expect(canonicalOutputJSON(custody, { bytes: 4194304 })).toBe(original)
      }
    )
  )
  f.setAccess(true)
  f.setAvailable(false)
  f.setNow('200')
  const secret = await f.sellerDomain.issue(custody, f.progress, f.release, signal, f.submission),
    delivered = await f.sellerDeliver(secret)
  await f.domain.verify(f.prepare, f.prepared, f.submission, delivered, signal)
  expect(await f.domain.playback(delivered, signal)).toEqual(f.plaintext)
  expect(f.sellerCounts).toEqual({ load: 1, lineage: 1, purchase: 2, release: 1 })
}, 60000)

it('keeps current retained issuance separate from 300 generated new-preparation windows', async () => {
  const f = await lchCovenantProfileSellerFixture(),
    custody = await f.prepareSeller(),
    abort = new AbortController().signal,
    original = canonicalOutputJSON(custody, { bytes: 4194304 }),
    ready = await f.sellerDomain.prepare(f.prepare, f.selection, abort),
    purchased = await f.sellerDomain.verify(f.submission, custody, abort)
  fc.assert(
    fc.property(
      fc.integer({ min: 20, max: 99 }),
      fc.integer({ min: 100, max: 1000000 }),
      (accepted, expired) => {
        f.setNow(String(accepted))
        ready.validation.checkCurrent()
        purchased.checkCurrent()
        f.setNow(String(expired))
        expect(() => ready.validation.checkCurrent()).toThrow()
        purchased.checkCurrent()
        expect(canonicalOutputJSON(custody, { bytes: 4194304 })).toBe(original)
      }
    )
  )
  f.setNow('200')
  f.setAvailable(false)
  const secret = await f.sellerDomain.issue(custody, f.progress, f.release, abort, f.submission),
    delivered = await f.sellerDeliver(secret)
  await f.domain.verify(f.prepare, f.prepared, f.submission, delivered, abort)
  expect(await f.domain.playback(delivered, abort)).toEqual(f.plaintext)
}, 60000)
