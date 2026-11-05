import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, decodeOutputBytes } from '@bsv/sdk'
import { decodeDeterministicCbor } from '../src/cbor.js'
import { LCHOverlayCovenantSeller } from '../src/overlayAcquisitionCovenantSeller.js'
import { LCHOverlayCovenantProfileSeller } from '../src/overlayAcquisitionCovenantProfileSeller.js'
import type { LCHOverlayCovenantProfilePreparation } from '../src/overlayAcquisitionCovenantProfile.js'
import { lchCovenantProfileSellerFixture } from './overlay-acquisition-covenant-profile-seller.fixture.js'

const signal = () => new AbortController().signal

it('prepares current immutable material and issues complete independently verified rights accepted by the current buyer', async () => {
  const f = await lchCovenantProfileSellerFixture(),
    custody = await f.prepareSeller(),
    abort = signal(),
    material = decodeDeterministicCbor(
      Uint8Array.from(decodeOutputBytes(custody.material, 4194304))
    ) as Record<string, unknown>
  expect(custody.original.terms).toEqual(f.prepared)
  expect(material.keys).toHaveLength(f.asset.keys.size)
  const proof = await f.sellerDomain.verify(f.submission, custody, abort)
  expect(proof.purchaseCommitment).toBe(f.purchaseCommitment)
  proof.checkCurrent()
  f.setNow('22')
  const secret = await f.sellerDomain.issue(custody, f.progress, f.release, abort, f.submission),
    delivered = await f.sellerDeliver(secret)
  await f.domain.verify(f.prepare, custody.original.terms, f.submission, delivered, abort)
  expect(await f.domain.playback(delivered, abort)).toEqual(f.plaintext)
  expect(f.sellerCounts).toEqual({ load: 1, lineage: 1, purchase: 2, release: 1 })
}, 60000)

it('keeps the existing complete verifier as the default assessment and requires explicit installation for pending assessments', async () => {
  const f = await lchCovenantProfileSellerFixture(),
    custody = await f.prepareSeller(),
    abort = signal()
  const result = await f.sellerDomain.assess(f.submission, custody, abort)
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error('Default assessment refused complete proof')
  expect(result.validation.purchaseCommitment).toBe(f.purchaseCommitment)
  result.validation.checkCurrent()
  const verification = {
    ...f.sellerOptions.verification,
    assessPurchase: async () => ({ status: 'pending-finality' as const, checkCurrent: () => {} })
  }
  const installed = new LCHOverlayCovenantProfileSeller({ ...f.sellerOptions, verification })
  expect(installed.id).not.toBe(f.sellerDomain.id)
  await expect(installed.assess(f.submission, custody, abort)).rejects.toThrow()
  const fresh = await f.prepareSeller(installed),
    pending = await installed.assess(f.submission, fresh, abort)
  expect(pending.status).toBe('pending-finality')
  if (pending.status === 'verified')
    throw new Error('Controlled pending assessment granted authority')
  pending.checkCurrent()
  expect(f.sellerCounts.release).toBe(0)
  verification.assessPurchase = async () => ({
    status: 'pending-finality' as const,
    checkCurrent: () => {}
  })
  await expect(installed.assess(f.submission, fresh, abort)).rejects.toThrow('assessment changed')
}, 60000)

it('fulfills retained current rights after catalogue withdrawal and Offer expiry without rewriting original custody', async () => {
  const f = await lchCovenantProfileSellerFixture(),
    custody = await f.prepareSeller(),
    original = canonicalOutputJSON(custody, { bytes: 4194304 }),
    reopened = new LCHOverlayCovenantProfileSeller(f.sellerOptions),
    abort = signal()
  expect(reopened.id).toBe(f.sellerDomain.id)
  f.setAvailable(false)
  f.setNow('200')
  const secret = await reopened.issue(custody, f.progress, f.release, abort, f.submission),
    delivered = await f.sellerDeliver(secret)
  expect(canonicalOutputJSON(custody, { bytes: 4194304 })).toBe(original)
  expect(f.sellerCounts.lineage).toBe(1)
  await f.domain.verify(f.prepare, f.prepared, f.submission, delivered, abort)
  expect(await f.domain.playback(delivered, abort)).toEqual(f.plaintext)
  await expect(reopened.prepare(f.prepare, f.selection, abort)).rejects.toThrow(
    'Catalogue unavailable'
  )
}, 60000)

it('retains owned stage/height and both Offer and bounded preparation-window guards before any promise', async () => {
  const f = await lchCovenantProfileSellerFixture(),
    abort = signal(),
    lineage = f.sellerOptions.verification.lineage
  let assessment: LCHOverlayCovenantProfilePreparation | undefined
  const options = {
      ...f.sellerOptions,
      verification: {
        ...f.sellerOptions.verification,
        lineage: async (...args: Parameters<typeof lineage>) => {
          assessment = await lineage(...args)
          return assessment
        }
      }
    },
    seller = new LCHOverlayCovenantProfileSeller(options),
    ready = await seller.prepare(f.prepare, f.selection, abort)
  ready.validation.checkCurrent()
  f.setNow('99')
  ready.validation.checkCurrent()
  f.setNow('100')
  expect(() => ready.validation.checkCurrent()).toThrow()
  f.setNow('20')
  assessment!.currentHeight = '1000'
  expect(() => ready.validation.checkCurrent()).toThrow('assessment changed')
  const short = new LCHOverlayCovenantProfileSeller({ ...f.sellerOptions, purchaseSeconds: '1' }),
    brief = await short.prepare(f.prepare, f.selection, abort)
  f.setNow('21')
  expect(() => brief.validation.checkCurrent()).toThrow('preparation window elapsed')
}, 60000)

it('refuses activation, expired height, noncanonical height and accessor-backed stage assessments', async () => {
  const f = await lchCovenantProfileSellerFixture(),
    abort = signal(),
    lineage = f.sellerOptions.verification.lineage
  await [
    { stage: 'activation', currentHeight: '101' },
    { stage: 'active', currentHeight: '1000' },
    { stage: 'active', currentHeight: '0101' },
    {
      currentHeight: '101',
      get stage() {
        return 'active'
      }
    }
  ].reduce(async (previous, fields) => {
    await previous
    const seller = new LCHOverlayCovenantProfileSeller({
      ...f.sellerOptions,
      verification: {
        ...f.sellerOptions.verification,
        lineage: async (...args: Parameters<typeof lineage>) => {
          const result = await lineage(...args)
          Object.defineProperties(result, Object.getOwnPropertyDescriptors(fields))
          return result
        }
      }
    })
    await expect(seller.prepare(f.prepare, f.selection, abort)).rejects.toThrow()
  }, Promise.resolve())
  expect(f.sellerCounts.purchase).toBe(0)
  expect(f.sellerCounts.release).toBe(0)
}, 60000)

it('uses a distinct current installation and refuses historical reinterpretation, missing admission and wrong original candidate', async () => {
  const f = await lchCovenantProfileSellerFixture(),
    custody = await f.prepareSeller(),
    abort = signal(),
    historical = new LCHOverlayCovenantSeller(f.sellerOptions as never)
  expect(historical.id).not.toBe(f.sellerDomain.id)
  await expect(historical.verify(f.submission, custody, abort)).rejects.toThrow('material differs')
  await expect(f.sellerDomain.issue(custody, f.progress, f.release, abort)).rejects.toThrow(
    'Complete retained candidate'
  )
  await expect(
    f.sellerDomain.issue(
      custody,
      { ...f.progress, status: 'admission-pending' },
      f.release,
      abort,
      f.submission
    )
  ).rejects.toThrow('original admitted purchase')
  await expect(
    f.sellerDomain.verify({ ...f.submission, acquisitionId: 'ac'.repeat(32) }, custody, abort)
  ).rejects.toThrow('another original request')
}, 60000)

it.each(['pending-finality', 'pending-evidence'] as const)(
  'retains the installed %s assessment without granting purchase or release authority',
  async status => {
    const f = await lchCovenantProfileSellerFixture(),
      abort = signal()
    let current = true
    const seller = new LCHOverlayCovenantProfileSeller({
      ...f.sellerOptions,
      verification: {
        ...f.sellerOptions.verification,
        assessPurchase: async () => ({
          status,
          checkCurrent() {
            if (!current) throw new Error('Installed assessment context changed')
          }
        })
      }
    })
    const custody = await f.prepareSeller(seller)
    const result = await seller.assess(f.submission, custody, abort)
    expect(result.status).toBe(status)
    if (result.status === 'verified') throw new Error('Pending assessment granted authority')
    result.checkCurrent()
    expect(f.sellerCounts.purchase).toBe(0)
    expect(f.sellerCounts.release).toBe(0)
    current = false
    expect(() => result.checkCurrent()).toThrow('Installed assessment context changed')
  },
  60000
)

it('retains a complete installed positive assessment and refuses its changed verification context', async () => {
  const f = await lchCovenantProfileSellerFixture(),
    abort = signal()
  let current = true
  const seller = new LCHOverlayCovenantProfileSeller({
    ...f.sellerOptions,
    verification: {
      ...f.sellerOptions.verification,
      assessPurchase: async (...args) => {
        const verified = await f.sellerOptions.verification.purchase(...args)
        return {
          status: 'verified' as const,
          validation: {
            purchaseCommitment: verified.purchaseCommitment,
            checkCurrent() {
              verified.checkCurrent()
              if (!current) throw new Error('Installed assessment context changed')
            }
          }
        }
      }
    }
  })
  const custody = await f.prepareSeller(seller)
  const result = await seller.assess(f.submission, custody, abort)
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error('Complete installed assessment refused')
  expect(result.validation.purchaseCommitment).toBe(f.purchaseCommitment)
  result.validation.checkCurrent()
  expect(f.sellerCounts.purchase).toBe(1)
  expect(f.sellerCounts.release).toBe(0)
  current = false
  expect(() => result.validation.checkCurrent()).toThrow('Installed assessment context changed')
}, 60000)
