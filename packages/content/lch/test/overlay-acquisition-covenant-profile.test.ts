import { expect, it } from '@jest/globals'
import {
  LCHOverlayCovenantProfileDomain,
  type LCHOverlayCovenantProfilePreparation
} from '../src/overlayAcquisitionCovenantProfile.js'
import { LCHOverlayCovenantDomain } from '../src/overlayAcquisitionCovenant.js'
import { lchNativeCovenantProfileFixture } from './overlay-acquisition-covenant-profile-native.fixture.js'

it('executes reserve-stage genesis, activation, original funded purchase and released purchase before retaining playable current rights', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    funding = await f.domain.fundingPreflight(f.prepare, f.prepared, signal)
  expect(f.family.decode(f.genesis.outputs[0].lockingScript.toBinary(), f.descriptor).stage).toBe(
    'activation'
  )
  expect(f.family.decode(f.active.outputs[0].lockingScript.toBinary(), f.descriptor).stage).toBe(
    'active'
  )
  expect(f.family.decode(f.purchased.outputs[0].lockingScript.toBinary(), f.descriptor).stage).toBe(
    'active'
  )
  expect(funding.checkCurrent()).toBeUndefined()
  expect(f.counts).toEqual({ preparation: 1, purchase: 0, release: 0 })
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  expect(f.counts).toEqual({ preparation: 1, purchase: 1, release: 1 })
  expect(await f.domain.playback(f.delivered, signal)).toEqual(f.plaintext)
}, 60000)

it('rechecks the accepted funding cutoff without revoking an already purchased obligation or retained offline playback', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    funding = await f.domain.fundingPreflight(f.prepare, f.prepared, signal)
  f.setNow('99')
  expect(funding.checkCurrent()).toBeUndefined()
  f.setNow('100')
  expect(() => funding.checkCurrent()).toThrow('new-purchase window')
  f.setNow('200')
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  const reopened = await LCHOverlayCovenantProfileDomain.open(
    f.options,
    { id: f.domain.id, original: f.domain.original() },
    f.reopen()
  )
  expect(await reopened.playback(f.delivered, signal)).toEqual(f.plaintext)
  expect(f.counts).toEqual({ preparation: 1, purchase: 1, release: 1 })
}, 60000)

it('requires owned active-stage and installed-height assessments and pins their fields through funding', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    original = f.options.verification.preparation
  let returned: LCHOverlayCovenantProfilePreparation | undefined
  const options = {
      ...f.options,
      verification: {
        ...f.options.verification,
        preparation: async (...args: Parameters<typeof original>) => {
          returned = await original(...args)
          return returned
        }
      }
    },
    domain = await LCHOverlayCovenantProfileDomain.create(options)
  await domain.initializeCustody(f.objects)
  const funding = await domain.fundingPreflight(f.prepare, f.prepared, signal)
  returned!.currentHeight = '1000'
  expect(() => funding.checkCurrent()).toThrow('assessment changed')
  await [
    { stage: 'activation', currentHeight: '101' },
    { stage: 'active', currentHeight: '1000' },
    { stage: 'active', currentHeight: '0101' },
    { stage: 'active', currentHeight: 101 },
    {
      currentHeight: '101',
      get stage() {
        return 'active'
      }
    }
  ].reduce(async (previous, fields) => {
    await previous
    const selected = {
        ...f.options,
        verification: {
          ...f.options.verification,
          preparation: async (...args: Parameters<typeof original>) => {
            const verified = await original(...args)
            Object.defineProperties(verified, Object.getOwnPropertyDescriptors(fields))
            return verified
          }
        }
      },
      fresh = await LCHOverlayCovenantProfileDomain.create(selected)
    await fresh.initializeCustody(f.objects)
    await expect(fresh.fundingPreflight(f.prepare, f.prepared, signal)).rejects.toThrow()
  }, Promise.resolve())
}, 60000)

it('keeps historical descriptor/custody selection explicit and refuses the wrong wallet or unsigned funding preparation', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal
  await expect(LCHOverlayCovenantDomain.create(f.options as never)).rejects.toThrow()
  await expect(
    LCHOverlayCovenantProfileDomain.create({ ...f.options, wallet: f.sellerWallet })
  ).rejects.toThrow('Installed buyer wallet')
  await expect(f.domain.fundingPreflight(f.prepare, null as never, signal)).rejects.toThrow(
    'Signed preparation'
  )
  await expect(
    LCHOverlayCovenantProfileDomain.open(
      f.options,
      { id: f.domain.id + 'changed', original: f.domain.original() },
      f.objects
    )
  ).rejects.toThrow('installation differs')
}, 60000)

it('requires the independently verified original wallet subject and the exact complete commitment before accepting current delivery', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    domain = await LCHOverlayCovenantProfileDomain.create(f.options)
  await expect(domain.fundingPreflight(f.prepare, f.prepared, signal)).rejects.toThrow(
    'not initialized'
  )
  await expect(
    f.domain.verify(
      f.prepare,
      f.prepared,
      { ...f.submission, acquisitionId: 'ab'.repeat(32) },
      f.delivered,
      signal
    )
  ).rejects.toThrow('Original wallet transaction')
  await expect(
    f.domain.verify(f.prepare, f.prepared, { ...f.submission, beef: 'AA==' }, f.delivered, signal)
  ).rejects.toThrow()
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
  expect(f.counts.purchase).toBe(0)
}, 60000)
