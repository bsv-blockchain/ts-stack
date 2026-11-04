import { expect, it, jest } from '@jest/globals'
import { privatePurchaseHTTPFixture } from './PrivatePurchaseRoutes.fixture.js'

it('refuses occupied authenticated purchase work without another admission and releases it after settlement', async () => {
  const f = await privatePurchaseHTTPFixture({ maximumWork: 1, maximumWorkPerPrincipal: 1 })
  let finish!: () => void, began!: () => void
  const blocked = new Promise<void>(resolve => {
      finish = resolve
    }),
    started = new Promise<void>(resolve => {
      began = resolve
    })
  try {
    expect((await f.fetch()).status).toBe(200)
    const original = f.coordinator.prepare.bind(f.coordinator),
      changed = jest.spyOn(f.coordinator, 'prepare').mockImplementationOnce(async (...args) => {
        began()
        await blocked
        return await original(...args)
      }),
      pending = f.fetch()
    try {
      await started
      const response = await f.fetch()
      expect(response.status).toBe(413)
      expect((await response.json()).error).toEqual({
        code: 'limited',
        message: 'Private purchase request limited',
        retryable: true
      })
      expect(f.owner.counts.admission).toBe(0)
      expect(f.owner.counts.issue).toBe(0)
    } finally {
      finish()
      await pending
      changed.mockRestore()
    }
    expect((await f.fetch()).status).toBe(200)
    expect(f.owner.counts.terms).toBe(1)
  } finally {
    finish()
    await f.close()
  }
})
