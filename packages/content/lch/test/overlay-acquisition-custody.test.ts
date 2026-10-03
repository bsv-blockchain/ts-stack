import { expect, it } from '@jest/globals'
import {
  LCHOverlayPaidCustody,
  type LCHOverlayObjectCustody
} from '../src/overlayAcquisitionCustody.js'
import { lchPaidFixture } from './overlay-acquisition-paid.fixture.js'

it('refuses missing, changed or smaller native reservations on read-only reopen', async () => {
  const f = await lchPaidFixture(),
    original = f.domain.original(),
    owner = (read: LCHOverlayObjectCustody['read']): LCHOverlayObjectCustody => ({
      durability: 'durable',
      configuration: f.objects.configuration,
      reserve: f.objects.reserve.bind(f.objects),
      put: f.objects.put.bind(f.objects),
      read
    })
  for (const role of ['original', 'verified']) {
    const missing = owner((id, binding) =>
      binding.role === role ? Promise.resolve({ state: 'absent' }) : f.objects.read(id, binding)
    )
    await expect(
      LCHOverlayPaidCustody.open(missing, f.domain.id, f.acquire.recipient, original)
    ).rejects.toThrow()
  }
  const smaller = owner(async (id, binding) => {
      const value = await f.objects.read(id, binding)
      return binding.role === 'verified'
        ? { state: 'reserved', reservation: { maximumBytes: 1 } }
        : value
    }),
    changed = owner(async (id, binding) => {
      const value = await f.objects.read(id, binding)
      if (value.state === 'stored' && binding.role === 'original') value.bytes[0] ^= 1
      return value
    })
  await expect(
    LCHOverlayPaidCustody.open(smaller, f.domain.id, f.acquire.recipient, original)
  ).rejects.toThrow('reservation')
  await expect(
    LCHOverlayPaidCustody.open(changed, f.domain.id, f.acquire.recipient, original)
  ).rejects.toThrow('original LCH terms')
})
it('does not infer a positive verification receipt from an existing original or a different entitlement', async () => {
  const f = await lchPaidFixture(),
    custody = await LCHOverlayPaidCustody.open(
      f.objects,
      f.domain.id,
      f.acquire.recipient,
      f.domain.original()
    ),
    digest = 'e1'.repeat(32)
  expect(await custody.verified(digest)).toBe(false)
  await custody.record(digest)
  expect(await custody.verified(digest)).toBe(true)
  expect(await custody.verified('e2'.repeat(32))).toBe(false)
  await expect(custody.record('e2'.repeat(32))).rejects.toThrow()
})
