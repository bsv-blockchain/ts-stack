import { expect, it } from '@jest/globals'
import { retainLCHCovenantPurchaseAssessment } from '../src/overlayAcquisitionCovenantProof.js'

it('retains the complete independently verified digest and rechecks its original guard', () => {
  let checks = 0
  const input = {
      purchaseCommitment: '65'.repeat(32),
      checkCurrent: () => {
        checks++
      }
    },
    retained = retainLCHCovenantPurchaseAssessment(input)
  expect(retained.purchaseCommitment).toBe(input.purchaseCommitment)
  retained.checkCurrent()
  retained.checkCurrent()
  expect(checks).toBe(2)
  input.purchaseCommitment = '66'.repeat(32)
  expect(retained.purchaseCommitment).toBe('65'.repeat(32))
  expect(() => retained.checkCurrent()).toThrow('commitment changed')
})

it('requires an owned full canonical commitment without invoking accessors', () => {
  for (const purchaseCommitment of [undefined, '', '65', 'AA'.repeat(32), '65'.repeat(33), 1]) {
    expect(() =>
      retainLCHCovenantPurchaseAssessment({ purchaseCommitment, checkCurrent: () => {} } as never)
    ).toThrow()
  }
  for (const input of [
    { checkCurrent: () => {} },
    Object.assign(Object.create({ purchaseCommitment: '65'.repeat(32) }), {
      checkCurrent: () => {}
    }),
    Object.defineProperty({ checkCurrent: () => {} }, 'purchaseCommitment', {
      value: '65'.repeat(32)
    }),
    Object.defineProperty({ checkCurrent: () => {} }, 'purchaseCommitment', {
      enumerable: true,
      get: () => {
        throw new Error('Accessor must not run')
      }
    })
  ])
    expect(() => retainLCHCovenantPurchaseAssessment(input as never)).toThrow('owned data field')
})

it('requires an owned synchronous guard and consumes rejected promises without accepting them', async () => {
  for (const input of [
    Object.assign(Object.create({ checkCurrent: () => {} }), {
      purchaseCommitment: '65'.repeat(32)
    }),
    { purchaseCommitment: '65'.repeat(32), checkCurrent: async () => {} }
  ])
    expect(() => retainLCHCovenantPurchaseAssessment(input)).toThrow('synchronous')
  for (const checkCurrent of [
    () => true,
    () => Promise.resolve(),
    () => Promise.reject(new Error('Guard did not finish synchronously'))
  ]) {
    const retained = retainLCHCovenantPurchaseAssessment({
      purchaseCommitment: '65'.repeat(32),
      checkCurrent
    } as never)
    expect(() => retained.checkCurrent()).toThrow('did not finish')
  }
  await Promise.resolve()
})

it('detects guard replacement and changed commitment during an assessment', () => {
  for (const field of ['checkCurrent', 'purchaseCommitment'] as const) {
    const input = {
        purchaseCommitment: '65'.repeat(32),
        checkCurrent: () => {
          if (field === 'checkCurrent') input.checkCurrent = () => {}
          else input.purchaseCommitment = '66'.repeat(32)
        }
      },
      retained = retainLCHCovenantPurchaseAssessment(input)
    expect(() => retained.checkCurrent()).toThrow('changed')
  }
})
