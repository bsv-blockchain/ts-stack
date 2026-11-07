import { expect, it } from '@jest/globals'
import fc from 'fast-check'
import { canonicalOutputJSON, type OutputJSONObject } from '@bsv/sdk'
import { nativePurchaseWalletFixture } from './private-purchase-wallet-native.fixture.js'
import { nativeProfilePurchaseWalletFixture } from './private-purchase-wallet-profile.fixture.js'
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
it('preserves one lost-reply native purchase over 300 generated restart and recovery histories', async () => {
  const f = await nativePurchaseWalletFixture(),
    signal = new AbortController().signal,
    plan = await f.payment.plan('79'.repeat(32), f.prepare, f.terms, signal)
  try {
    f.loseFinalization()
    await expect(f.payment.finish(plan, () => {}, signal)).rejects.toThrow('Lost native')
    const original = await f.payment.recover(plan, signal)
    if (original.state !== 'finalized') throw new Error('Original native finalization is missing')
    expect(await f.verify(original.candidate)).toMatchObject({
      status: 'verified',
      increment: f.lineage.descriptor.purchasePrice
    })
    const originalBytes = canonicalOutputJSON(original.candidate)
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('recover', 'finish', 'cancel', 'tamper', 'historical'), {
          minLength: 1,
          maxLength: 3
        }),
        async history => {
          const owner = await f.reopen()
          try {
            for (const step of history) {
              if (step === 'cancel') {
                const cancelled = new AbortController()
                cancelled.abort()
                await expect(owner.payment.recover(plan, cancelled.signal)).rejects.toThrow(
                  'cancelled'
                )
              } else if (step === 'tamper') {
                const wrong = JSON.parse(
                  canonicalOutputJSON(plan, { bytes: 4194304 })
                ) as OutputJSONObject
                ;(wrong.request as OutputJSONObject).options = { noSend: false }
                await expect(owner.payment.recover(wrong, signal)).rejects.toThrow(
                  'construction changed'
                )
              } else {
                if (step === 'historical') f.setAccess(false)
                try {
                  const recovered =
                    step === 'recover'
                      ? await owner.payment.recover(plan, signal)
                      : {
                          state: 'finalized',
                          candidate: await owner.payment.finish(
                            plan,
                            () => {
                              throw new Error('Recovery cannot authorize new financial work')
                            },
                            signal
                          )
                        }
                  expect(recovered.state).toBe('finalized')
                  if (recovered.state !== 'finalized')
                    throw new Error('Native finalized intent disappeared')
                  // Exact original bytes preserve the independently verified history;
                  // no verification result is substituted for changed evidence.
                  expect(canonicalOutputJSON(recovered.candidate)).toBe(originalBytes)
                  recovered.candidate.beef = 'AA=='
                } finally {
                  f.setAccess(true)
                }
              }
              expect(f.counts.prepare).toBe(1)
              expect(f.counts.finalize).toBe(1)
              expect(f.native.broadcast).not.toHaveBeenCalled()
            }
          } finally {
            // Each history is an independent reopened native owner; release its
            // actual pool before opening the next history against durable state.
            await owner.owner.close()
          }
        }
      )
    )
    const last = await f.payment.recover(plan, signal)
    expect(last.state).toBe('finalized')
    if (last.state === 'finalized') expect(canonicalOutputJSON(last.candidate)).toBe(originalBytes)
  } finally {
    await f.close()
  }
}, 180000)
it('preserves one current two-stage purchase over 300 generated expiry and native restart histories', async () => {
  const f = await nativeProfilePurchaseWalletFixture(),
    signal = new AbortController().signal,
    plan = await f.payment.plan('86'.repeat(32), f.prepare, f.terms, signal)
  try {
    f.loseFinalization()
    await expect(f.payment.finish(plan, () => {}, signal)).rejects.toThrow('Lost native')
    const original = await f.payment.recover(plan, signal)
    if (original.state !== 'finalized') throw new Error('Original native finalization is missing')
    expect(await f.verify(original.candidate)).toMatchObject({
      status: 'verified',
      increment: f.lineage.descriptor.purchasePrice
    })
    const originalBytes = canonicalOutputJSON(original.candidate)
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom('recover', 'finish', 'cancel', 'tamper', 'historical', 'expire'), {
          minLength: 1,
          maxLength: 3
        }),
        async history => {
          const owner = await f.reopen()
          try {
            for (const step of history) {
              if (step === 'cancel') {
                const cancelled = new AbortController()
                cancelled.abort()
                await expect(owner.payment.recover(plan, cancelled.signal)).rejects.toThrow(
                  'cancelled'
                )
              } else if (step === 'tamper') {
                const wrong = JSON.parse(
                  canonicalOutputJSON(plan, { bytes: 4194304 })
                ) as OutputJSONObject
                ;(wrong.request as OutputJSONObject).options = { noSend: false }
                await expect(owner.payment.recover(wrong, signal)).rejects.toThrow(
                  'construction changed'
                )
              } else {
                if (step === 'historical') f.setAccess(false)
                if (step === 'expire') f.setHeight(f.lineage.descriptor.expiryHeight)
                try {
                  const recovered =
                    step === 'recover'
                      ? await owner.payment.recover(plan, signal)
                      : {
                          state: 'finalized',
                          candidate: await owner.payment.finish(
                            plan,
                            () => {
                              throw new Error('Recovery cannot authorize new financial work')
                            },
                            signal
                          )
                        }
                  expect(recovered.state).toBe('finalized')
                  if (recovered.state !== 'finalized')
                    throw new Error('Native finalized intent disappeared')
                  // Exact original bytes preserve the independently verified history;
                  // no verification result is substituted for changed evidence.
                  expect(canonicalOutputJSON(recovered.candidate)).toBe(originalBytes)
                  recovered.candidate.beef = 'AA=='
                } finally {
                  f.setAccess(true)
                  f.setHeight(101)
                }
              }
              expect(f.counts.prepare).toBe(1)
              expect(f.counts.finalize).toBe(1)
              expect(f.native.broadcast).not.toHaveBeenCalled()
            }
          } finally {
            // Each history is an independent reopened native owner; release its
            // actual pool before opening the next history against durable state.
            await owner.owner.close()
          }
        }
      )
    )
    const last = await f.payment.recover(plan, signal)
    expect(last.state).toBe('finalized')
    if (last.state === 'finalized') expect(canonicalOutputJSON(last.candidate)).toBe(originalBytes)
  } finally {
    await f.close()
  }
}, 180000)
