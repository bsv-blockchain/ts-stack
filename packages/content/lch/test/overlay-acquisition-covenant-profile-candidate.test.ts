import { expect, it } from '@jest/globals'
import { LCHOverlayCovenantProfileDomain } from '../src/overlayAcquisitionCovenantProfile.js'
import { lchNativeCovenantProfileFixture } from './overlay-acquisition-covenant-profile-native.fixture.js'

it('independently verifies complete current Script and original preparation before returning a candidate commitment without release or License checks', async () => {
  const f = await lchNativeCovenantProfileFixture({ candidateBinding: true }),
    signal = new AbortController().signal,
    binding = await f.domain.candidateBinding!(f.prepare, f.prepared, f.submission, signal)
  expect(binding.purchaseCommitment).toBe(f.purchaseCommitment)
  expect(binding.checkCurrent()).toBeUndefined()
  expect(f.candidateChecks()).toBe(1)
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
}, 60000)

it('reopens full-candidate custody and verifies historical purchase after the new-funding cutoff without granting playback', async () => {
  const f = await lchNativeCovenantProfileFixture({ candidateBinding: true }),
    signal = new AbortController().signal
  f.setNow('200')
  const reopened = await LCHOverlayCovenantProfileDomain.open(
      f.options,
      { id: f.domain.id, original: f.domain.original() },
      f.reopen()
    ),
    binding = await reopened.candidateBinding!(f.prepare, f.prepared, f.submission, signal)
  expect(binding.purchaseCommitment).toBe(f.purchaseCommitment)
  expect(binding.checkCurrent()).toBeUndefined()
  await expect(reopened.fundingPreflight(f.prepare, f.prepared, signal)).rejects.toThrow('window')
  await expect(reopened.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
}, 60000)

it('refuses changed request, acquisition, signed promise and invalid actual candidate without a private release', async () => {
  const f = await lchNativeCovenantProfileFixture({ candidateBinding: true }),
    signal = new AbortController().signal
  await expect(
    f.domain.candidateBinding!(
      { ...f.prepare, assetId: 'ab'.repeat(32) },
      f.prepared,
      f.submission,
      signal
    )
  ).rejects.toThrow('association changed')
  await expect(
    f.domain.candidateBinding!(
      f.prepare,
      f.prepared,
      { ...f.submission, acquisitionId: 'ab'.repeat(32) },
      signal
    )
  ).rejects.toThrow('association changed')
  await expect(
    f.domain.candidateBinding!(
      f.prepare,
      { ...f.prepared, signature: 'AA==' },
      f.submission,
      signal
    )
  ).rejects.toThrow()
  expect(f.candidateChecks()).toBe(0)
  await expect(
    f.domain.candidateBinding!(f.prepare, f.prepared, { ...f.submission, beef: 'AA==' }, signal)
  ).rejects.toThrow('not independently verified')
  expect(f.candidateChecks()).toBe(1)
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
}, 60000)

it('keeps omitted candidate capability absent and gives explicit full-commitment installations a distinct identity', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    full = await lchNativeCovenantProfileFixture({ candidateBinding: true }),
    verification = { ...full.options.verification }
  delete verification.candidate
  const omitted = await LCHOverlayCovenantProfileDomain.create({ ...full.options, verification })
  expect(f.domain.candidateBinding).toBeUndefined()
  expect(omitted.candidateBinding).toBeUndefined()
  expect(omitted.id).not.toBe(full.domain.id)
  await expect(
    LCHOverlayCovenantProfileDomain.open(
      { ...full.options, verification },
      { id: full.domain.id, original: full.domain.original() },
      full.objects
    )
  ).rejects.toThrow('installation differs')
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
}, 60000)

it('pins the independent candidate verifier and current access through the returned guard', async () => {
  const f = await lchNativeCovenantProfileFixture({ candidateBinding: true }),
    signal = new AbortController().signal,
    binding = await f.domain.candidateBinding!(f.prepare, f.prepared, f.submission, signal),
    original = f.options.verification.candidate!
  f.options.verification.candidate = async (...args) => original(...args)
  expect(() => binding.checkCurrent()).toThrow('verifier changed')
  await expect(
    f.domain.candidateBinding!(f.prepare, f.prepared, f.submission, signal)
  ).rejects.toThrow('verifier changed')
  f.options.verification.candidate = original
  f.setAccess(false)
  expect(() => binding.checkCurrent()).toThrow('inaccessible')
  f.setAccess(true)
  expect(binding.checkCurrent()).toBeUndefined()
  expect(f.candidateChecks()).toBe(1)
}, 60000)
