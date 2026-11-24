import { expect, it } from '@jest/globals'
import { outputPacketDigest, signOutputPacket, type OutputPurchaseEnvelope } from '@bsv/sdk'
import {
  advancePrivatePurchaseProgress,
  parsePrivatePurchaseProgress,
  privatePurchaseEnvelope,
  privatePurchaseOperation,
  type PrivatePurchaseEvent
} from '../src/private/PrivatePurchaseProgress.js'
import { purchaseProgressFixture } from './private-purchase-progress.fixture.js'

it('separates preparation, admission intent, retained STEAK and delivered private result', () => {
  const f = purchaseProgressFixture()
  expect(privatePurchaseEnvelope(f.initial(), f.original).result).toMatchObject({
    status: 'prepared'
  })
  expect(privatePurchaseEnvelope(f.pinned(), f.original).result).toMatchObject({
    status: 'admission-pending',
    txid: f.txid
  })
  const pending = privatePurchaseEnvelope(f.admitted(), f.original)
  expect(pending.result).toMatchObject({ status: 'admitted-delivery-pending', steak: f.steak })
  expect(pending).not.toHaveProperty('releaseEvidence')
  expect(pending.result).not.toHaveProperty('potatoes')
  expect(privatePurchaseEnvelope(f.delivered(), f.original, f.envelope())).toEqual(f.envelope())
  expect(f.pinned().operationId).toBe(privatePurchaseOperation(f.original, f.txid))
})

it('accepts a valid first delivery after construction cutoff and retains a pinned obligation after recovery deadline', () => {
  const f = purchaseProgressFixture(),
    late = f.pinned('101')
  expect(late.status).toBe('admission-pending')
  expect(advancePrivatePurchaseProgress(late, f.original, { type: 'expire' }, '86501')).toEqual(
    late
  )
  expect(() => f.pinned('86500')).toThrow(expect.objectContaining({ code: 'expired' }))
  const expired = advancePrivatePurchaseProgress(
    f.initial(),
    f.original,
    { type: 'expire' },
    '86500'
  )
  expect(privatePurchaseEnvelope(expired, f.original).result.status).toBe('expired')
  expect(() =>
    advancePrivatePurchaseProgress(expired, f.original, { type: 'pin', txid: f.txid }, '86501')
  ).toThrow(expect.objectContaining({ code: 'expired' }))
})

it('never replaces a reserved transaction and never interprets a local rejection as global failure', () => {
  const f = purchaseProgressFixture(),
    pending = f.pinned()
  expect(
    advancePrivatePurchaseProgress(pending, f.original, { type: 'pin', txid: f.txid }, '30')
  ).toEqual(pending)
  expect(() =>
    advancePrivatePurchaseProgress(
      pending,
      f.original,
      { type: 'pin', txid: '66'.repeat(32) },
      '30'
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  const rejected = advancePrivatePurchaseProgress(
    pending,
    f.original,
    { type: 'admission-rejected', reason: 'Selected host declined its topic', evidence: 'AA==' },
    '30'
  )
  expect(privatePurchaseEnvelope(rejected, f.original).result).toMatchObject({
    status: 'admission-rejected',
    decision: { globalOutcome: 'unknown', decidedAt: '30' }
  })
  expect(
    advancePrivatePurchaseProgress(rejected, f.original, { type: 'pin', txid: f.txid }, '31')
  ).toEqual(rejected)
  expect(() =>
    advancePrivatePurchaseProgress(
      rejected,
      f.original,
      { type: 'admitted', steak: f.steak, acceptedAt: '30', assessmentContextId: 'fixture' },
      '31'
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
})

it('preserves admission and its STEAK when private delivery conclusively fails', () => {
  const f = purchaseProgressFixture(),
    failed = advancePrivatePurchaseProgress(
      f.admitted(),
      f.original,
      {
        type: 'delivery-failed',
        reason: 'Original protected material is unavailable',
        evidence: 'AA=='
      },
      '32'
    )
  expect(privatePurchaseEnvelope(failed, f.original).result).toMatchObject({
    status: 'delivery-failed',
    steak: f.steak,
    txid: f.txid,
    decision: { globalOutcome: 'unknown' }
  })
  expect(() =>
    advancePrivatePurchaseProgress(
      failed,
      f.original,
      { type: 'delivered', envelope: f.envelope() },
      '33'
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
})

it.each(['admitted', 'admission-rejected', 'delivery-failed', 'delivered'] as const)(
  'refuses %s without its required retained predecessor',
  type => {
    const f = purchaseProgressFixture(),
      event: PrivatePurchaseEvent =
        type === 'admitted'
          ? { type, steak: f.steak, acceptedAt: '30', assessmentContextId: 'fixture' }
          : type === 'delivered'
            ? { type, envelope: f.envelope() }
            : { type, reason: 'Fixture refusal', evidence: 'AA==' }
    expect(() => advancePrivatePurchaseProgress(f.initial(), f.original, event, '33')).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
  }
)

it.each([
  'acquisitionId',
  'requestDigest',
  'recipient',
  'createdAt',
  'recoveryUntil',
  'operationId',
  'status',
  'txid',
  'admission',
  'updatedAt'
])('refuses altered retained %s', field => {
  const f = purchaseProgressFixture(),
    value = { ...f.admitted(), [field]: field === 'admission' ? null : 'bad' }
  expect(() => parsePrivatePurchaseProgress(value, f.original)).toThrow()
})

it('owns admission arrays and refuses topic/time substitution', () => {
  const f = purchaseProgressFixture(),
    admitted = f.admitted()
  f.steak[f.original.request.topic].outputsToAdmit.push(9)
  expect(admitted.admission!.steak[f.original.request.topic].outputsToAdmit).toEqual([0])
  expect(() =>
    advancePrivatePurchaseProgress(
      f.pinned(),
      f.original,
      { type: 'admitted', steak: {}, acceptedAt: '30', assessmentContextId: 'fixture' },
      '31'
    )
  ).toThrow()
  expect(() =>
    advancePrivatePurchaseProgress(
      f.pinned(),
      f.original,
      { type: 'admitted', steak: f.steak, acceptedAt: '32', assessmentContextId: 'fixture' },
      '31'
    )
  ).toThrow()
  expect(() =>
    advancePrivatePurchaseProgress(
      f.pinned(),
      f.original,
      { type: 'admitted', steak: f.steak, acceptedAt: '19', assessmentContextId: 'fixture' },
      '31'
    )
  ).toThrow()
})

it('retains an original complete delivery and rejects another signed secret or saved admission', () => {
  const f = purchaseProgressFixture(),
    delivered = f.delivered(),
    replacement = f.envelope()
  if (replacement.result.status !== 'delivered') throw new Error('Fixture delivery missing')
  replacement.result.potatoes = signOutputPacket(
    'potatoes',
    { ...replacement.result.potatoes.body, secret: 'AQ==' },
    f.f.key
  )
  expect(() => privatePurchaseEnvelope(delivered, f.original, replacement)).toThrow(
    expect.objectContaining({ code: 'unavailable' })
  )
  const changed = f.envelope()
  if (changed.result.status !== 'delivered') throw new Error('Fixture delivery missing')
  changed.result.steak[f.original.request.topic].outputsToAdmit = []
  expect(() =>
    advancePrivatePurchaseProgress(
      f.admitted(),
      f.original,
      { type: 'delivered', envelope: changed },
      '33'
    )
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  expect(() => privatePurchaseEnvelope(delivered, f.original)).toThrow(
    expect.objectContaining({ code: 'unavailable' })
  )
  expect(() => privatePurchaseEnvelope(f.admitted(), f.original, f.envelope())).toThrow()
})

it.each(['release-time', 'issued-time', 'recovery', 'recipient'] as const)(
  'rejects a seller-signed delivery with inconsistent %s',
  field => {
    const f = purchaseProgressFixture(),
      envelope = f.envelope()
    if (envelope.result.status !== 'delivered') throw new Error('Fixture delivery missing')
    const body = { ...envelope.result.potatoes.body }
    if (field === 'release-time') {
      envelope.releaseEvidence!.acceptedAt = '29'
      body.evidenceDigest = outputPacketDigest('release-evidence', envelope.releaseEvidence)
    }
    if (field === 'issued-time') body.issuedAt = '29'
    if (field === 'recovery') {
      body.recoveryUntil = '86501'
      envelope.result.recoveryUntil = '86501'
    }
    if (field === 'recipient') body.recipient = f.original.terms.body.seller
    envelope.result.potatoes = signOutputPacket('potatoes', body, f.f.key)
    expect(() =>
      advancePrivatePurchaseProgress(
        f.admitted(),
        f.original,
        { type: 'delivered', envelope },
        '33'
      )
    ).toThrow()
  }
)

it('refuses backwards clocks, premature expiry and malformed transition bodies', () => {
  const f = purchaseProgressFixture()
  expect(() =>
    advancePrivatePurchaseProgress(f.pinned(), f.original, { type: 'expire' }, '28')
  ).toThrow(expect.objectContaining({ code: 'context-changed' }))
  expect(() =>
    advancePrivatePurchaseProgress(f.initial(), f.original, { type: 'expire' }, '100')
  ).toThrow(expect.objectContaining({ code: 'conflict' }))
  const unknown = { type: 'unsupported' } as unknown as PrivatePurchaseEvent
  expect(() => advancePrivatePurchaseProgress(f.initial(), f.original, unknown, '30')).toThrow(
    expect.objectContaining({ code: 'unsupported' })
  )
  const extra = { type: 'pin', txid: f.txid, unknown: true } as PrivatePurchaseEvent
  expect(() => advancePrivatePurchaseProgress(f.initial(), f.original, extra, '30')).toThrow()
  const altered = {
    ...f.delivered(),
    delivery: { digest: '00'.repeat(32), schema: 'urn:test:private-result', issuedAt: '19' }
  }
  expect(() => parsePrivatePurchaseProgress(altered, f.original)).toThrow()
})

it('does not leak a POTATOES-shaped object into any pending result', () => {
  const f = purchaseProgressFixture(),
    envelope: OutputPurchaseEnvelope = privatePurchaseEnvelope(f.initial(), f.original)
  expect(Object.keys(envelope)).toEqual(['result'])
  expect(Object.keys(envelope.result).sort()).toEqual([
    'acquisitionId',
    'recoveryUntil',
    'status',
    'version'
  ])
})
