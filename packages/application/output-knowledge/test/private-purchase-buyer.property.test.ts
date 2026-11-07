import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { purchaseBuyerFixture } from './private-purchase-buyer.fixture.js'
type BuyerFixture = ReturnType<typeof purchaseBuyerFixture>
type BuyerOwner = Awaited<ReturnType<BuyerFixture['open']>>

async function applyOperation(
  fixture: BuyerFixture,
  owner: BuyerOwner,
  operation: string
): Promise<BuyerOwner> {
  switch (operation) {
    case 'advance':
      await owner.buyer.advance()
      break
    case 'recover':
      await owner.buyer.recover()
      break
    case 'reopen': {
      const replacement = await fixture.open()
      await fixture.close(owner)
      return replacement
    }
    case 'expire':
      fixture.setNow('200')
      break
    case 'validate':
      await owner.buyer.validate()
      break
    default:
      fixture.setAccess(false)
      await expect(owner.buyer.recover()).rejects.toThrow('access')
      fixture.setAccess(true)
  }
  return owner
}

async function assertHistoryStep(
  fixture: BuyerFixture,
  owner: BuyerOwner,
  operation: string,
  finishBefore: number,
  previous: string,
  expired: boolean
): Promise<void> {
  expect(fixture.counts.finish).toBeLessThanOrEqual(1)
  if (operation === 'recover' || operation === 'reopen')
    expect(fixture.counts.finish).toBe(finishBefore)
  if (expired && ['ready', 'prepared'].includes(previous))
    expect(fixture.counts.finish).toBe(finishBefore)
  expect(fixture.server.counts.issue).toBeLessThanOrEqual(1)
  expect(fixture.activeOwners()).toBe(1)
  if ((await owner.buyer.status()) === 'usable') expect(fixture.counts.verify).toBeGreaterThan(0)
}

const MIN_PROPERTY_RUNS = 300
const requestedRuns = Number(process.env.FAST_CHECK_NUM_RUNS),
  requestedSeed = Number(process.env.FAST_CHECK_SEED)
fc.configureGlobal({
  numRuns: Number.isSafeInteger(requestedRuns)
    ? Math.max(MIN_PROPERTY_RUNS, requestedRuns)
    : MIN_PROPERTY_RUNS,
  seed: Number.isSafeInteger(requestedSeed) ? requestedSeed : 3242026,
  ...(process.env.FAST_CHECK_PATH ? { path: process.env.FAST_CHECK_PATH } : {}),
  interruptAfterTimeLimit: 150000,
  markInterruptAsFailure: true
})
it('preserves one financial operation over 300 interrupted native buyer/seller histories', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('none' as const, 'prepare' as const, 'finish' as const, 'submit' as const),
      fc.array(fc.constantFrom('advance', 'recover', 'reopen', 'expire', 'validate', 'deny'), {
        minLength: 1,
        maxLength: 8
      }),
      async (lost, history) => {
        const f = purchaseBuyerFixture()
        let owner = await f.open(true),
          expired = false
        if (lost !== 'none') f.lose(lost)
        try {
          for (const operation of history) {
            const count = f.counts.finish,
              previous = await owner.buyer.status()
            try {
              owner = await applyOperation(f, owner, operation)
              if (operation === 'expire') expired = true
            } catch (error) {
              expect(error).toBeInstanceOf(Error)
              expect(operation === 'advance' || operation === 'validate').toBe(true)
              if (operation === 'advance')
                expect(
                  (error as { code?: string }).code === 'expired' ||
                    (error as Error).message.startsWith('Lost original')
                ).toBe(true)
            }
            await assertHistoryStep(f, owner, operation, count, previous, expired)
          }
          if (!expired) {
            try {
              await owner.buyer.advance()
            } catch (error) {
              expect((error as Error).message.startsWith('Lost original')).toBe(true)
            }
            await owner.buyer.advance()
            await owner.buyer.recover()
            expect(f.counts.finish).toBe(1)
            expect(await owner.buyer.validate()).toBe('usable')
          }
        } finally {
          await f.dispose()
        }
      }
    )
  )
}, 180000)

it('retains one protected full identity through generated lost replies and historical recovery', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.constantFrom('none' as const, 'prepare' as const, 'finish' as const, 'submit' as const),
      fc.array(fc.constantFrom('recover', 'reopen', 'deny'), { minLength: 1, maxLength: 5 }),
      fc.boolean(),
      async (lost, history, expire) => {
        const f = purchaseBuyerFixture('full-purchase-commitment-v1')
        let owner = await f.open(true)
        if (lost !== 'none') f.lose(lost)
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              await owner.buyer.advance()
            } catch (error) {
              expect((error as Error).message.startsWith('Lost original')).toBe(true)
            }
          }
          expect(await owner.buyer.validate()).toBe('usable')
          const historical = await owner.buyer.usableResult()
          expect(historical).toHaveProperty(
            'result.purchaseCommitment',
            f.server.f.purchaseCommitment
          )
          expect(f.bindingChecks()).toBe(1)
          if (expire) f.setNow('100000')
          for (const operation of history) {
            if (operation === 'reopen') {
              const next = await f.open()
              await f.close(owner)
              owner = next
            } else if (operation === 'deny') {
              f.setAccess(false)
              await expect(owner.buyer.recover()).rejects.toThrow('access')
              f.setAccess(true)
            } else expect(await owner.buyer.recover()).toEqual(historical)
            expect(await owner.buyer.usableResult()).toEqual(historical)
            expect(f.bindingChecks()).toBe(1)
            expect(f.counts.finish).toBe(1)
            expect(f.server.counts.issue).toBe(1)
            expect(f.activeOwners()).toBe(1)
          }
        } finally {
          await f.dispose()
        }
      }
    )
  )
}, 180000)
