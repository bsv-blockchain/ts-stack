import { afterEach, expect, it, jest } from '@jest/globals'
import fc from 'fast-check'
import { buyerFixture } from './private-lookup-buyer.fixture.js'
import { buyerRemote } from './private-lookup-buyer-transport.fixture.js'
import { PrivateLookupBuyer } from '../src/private/PrivateLookupBuyer.js'
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
afterEach(() => {
  jest.restoreAllMocks()
})
it('keeps one original financial operation across generated interruption, restart, expiry and validation histories', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('none', 'quote', 'pay'),
      fc.array(fc.constantFrom('advance', 'recover', 'reopen', 'expire', 'validate', 'unusable'), {
        minLength: 1,
        maxLength: 12
      }),
      async (lost, history) => {
        const f = await buyerFixture(),
          wire = buyerRemote(f)
        let owner = await f.open(true),
          expired = false
        if (lost !== 'none') wire.lose(lost)
        try {
          for (const command of history) {
            const priorCount = f.counts.finish,
              priorPhase = await owner.buyer.status()
            try {
              switch (command) {
                case 'advance':
                  await owner.buyer.advance()
                  break
                case 'recover':
                  await owner.buyer.recover()
                  break
                case 'reopen':
                  owner = await f.open()
                  break
                case 'expire':
                  f.setNow('200')
                  expired = true
                  break
                case 'validate':
                  await owner.buyer.validate()
                  break
                case 'unusable':
                  f.setUsable(false)
                  break
              }
            } catch (error) {
              expect(error).toBeInstanceOf(Error)
              const code = (error as { code?: string }).code
              if (command === 'advance')
                expect(
                  code === 'expired' || (error as Error).message.startsWith('Lost original')
                ).toBe(true)
              else expect(command === 'validate' && code === 'unavailable').toBe(true)
            }
            expect(f.counts.finish).toBeLessThanOrEqual(1)
            if (expired && ['ready', 'quoted'].includes(priorPhase))
              expect(f.counts.finish).toBe(priorCount)
            expect(wire.calls.filter(value => value === 'pay').length).toBeLessThanOrEqual(1)
            expect(f.partial.original).toEqual({
              contract: f.f.quote.capability,
              request: f.f.f.request,
              derivationSuffix: f.f.f.payment().derivationSuffix
            })
            const phase = await owner.buyer.status()
            if (phase === 'usable') expect(f.counts.verify).toBeGreaterThan(0)
            if (phase === 'received') expect(f.counts.finish).toBe(1)
          }
          if (!expired) {
            await owner.buyer.recover()
            try {
              await owner.buyer.advance()
            } catch (error) {
              expect((error as Error).message.startsWith('Lost original')).toBe(true)
            }
            await owner.buyer.recover()
            await owner.buyer.advance()
            expect(['received', 'validated', 'usable']).toContain(await owner.buyer.status())
            expect(f.counts.finish).toBe(1)
          }
        } finally {
          wire.send.mockRestore()
          await f.dispose()
        }
      }
    )
  )
}, 180000)
it.each(['funding', 'paid', 'received'])(
  'reconciles a committed %s control write with a lost acknowledgement',
  async phase => {
    const f = await buyerFixture(),
      wire = buyerRemote(f),
      first = await f.open(true),
      cas = first.state.compareAndSwap.bind(first.state)
    let lost = false
    jest.spyOn(first.state, 'compareAndSwap').mockImplementation(async (revision, value) => {
      const result = await cas(revision, value)
      if (!lost && value.phase === phase) {
        lost = true
        throw new Error('Lost original control acknowledgement')
      }
      return result
    })
    const owner = await PrivateLookupBuyer.open(first.ports)
    try {
      await expect(owner.advance()).rejects.toThrow('Lost original control')
      const recovered = await f.open()
      await recovered.buyer.recover()
      if (phase !== 'received') await recovered.buyer.advance()
      expect(await recovered.buyer.status()).toBe('received')
      expect(f.counts.finish).toBe(1)
      expect(wire.calls.filter(value => value === 'pay')).toHaveLength(1)
    } finally {
      await owner.stop()
      wire.send.mockRestore()
    }
  }
)
