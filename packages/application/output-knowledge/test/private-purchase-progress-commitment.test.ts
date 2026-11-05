import { expect, it } from '@jest/globals'
import {
  advancePrivatePurchaseProgress,
  createPrivatePurchaseProgress,
  parsePrivatePurchaseProgress,
  privatePurchaseEnvelope
} from '../src/private/PrivatePurchaseProgress.js'
import { purchaseProgressFixture } from './private-purchase-progress.fixture.js'

const profile = 'full-purchase-commitment-v1' as const
const purchaseCommitment = 'a4'.repeat(32)

it('keeps unpinned obligations without a commitment and binds every pinned status to one identity', () => {
  const f = purchaseProgressFixture(),
    prepared = createPrivatePurchaseProgress(f.original, profile),
    pinned = advancePrivatePurchaseProgress(
      prepared,
      f.original,
      { type: 'pin', txid: f.txid, purchaseCommitment },
      '29',
      profile
    )
  expect(prepared).toEqual(f.initial())
  expect(
    privatePurchaseEnvelope(prepared, f.original, undefined, profile).result
  ).not.toHaveProperty('purchaseCommitment')
  expect(privatePurchaseEnvelope(pinned, f.original, undefined, profile).result).toHaveProperty(
    'purchaseCommitment',
    purchaseCommitment
  )
  for (const failure of ['admission-rejected', 'delivery-failed'] as const) {
    const prior =
        failure === 'admission-rejected'
          ? pinned
          : advancePrivatePurchaseProgress(
              pinned,
              f.original,
              {
                type: 'admitted',
                steak: f.steak,
                acceptedAt: '30',
                assessmentContextId: 'fixture'
              },
              '31',
              profile
            ),
      rejected = advancePrivatePurchaseProgress(
        prior,
        f.original,
        { type: failure, reason: 'Local refusal', evidence: 'AA==' },
        '32',
        profile
      )
    expect(privatePurchaseEnvelope(rejected, f.original, undefined, profile).result).toMatchObject({
      purchaseCommitment,
      status: failure,
      decision: { globalOutcome: 'unknown' }
    })
  }
  const expired = advancePrivatePurchaseProgress(
    prepared,
    f.original,
    { type: 'expire' },
    f.original.terms.body.recoveryUntil,
    profile
  )
  expect(
    privatePurchaseEnvelope(expired, f.original, undefined, profile).result
  ).not.toHaveProperty('purchaseCommitment')
})

it('requires the explicitly selected companion and refuses missing, injected or changed identity fields', () => {
  const f = purchaseProgressFixture(),
    pinned = advancePrivatePurchaseProgress(
      f.initial(),
      f.original,
      { type: 'pin', txid: f.txid, purchaseCommitment },
      '29',
      profile
    )
  expect(() => parsePrivatePurchaseProgress(pinned, f.original)).toThrow()
  expect(() => parsePrivatePurchaseProgress(f.pinned(), f.original, profile)).toThrow()
  expect(() =>
    parsePrivatePurchaseProgress({ ...f.initial(), purchaseCommitment }, f.original, profile)
  ).toThrow()
  expect(() =>
    advancePrivatePurchaseProgress(
      pinned,
      f.original,
      { type: 'pin', txid: f.txid, purchaseCommitment: 'b4'.repeat(32) },
      '30',
      profile
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(
    advancePrivatePurchaseProgress(
      pinned,
      f.original,
      { type: 'pin', txid: f.txid, purchaseCommitment },
      '30',
      profile
    )
  ).toEqual(pinned)
  expect(() => createPrivatePurchaseProgress(f.original, 'unknown' as never)).toThrow(
    expect.objectContaining({ code: 'unsupported' })
  )
})
