import { beforeAll, describe, expect, it } from '@jest/globals'
import { canonicalOutputJSON, OutputProtocolError, type OutputPaidLookupPayment } from '@bsv/sdk'
import {
  privateAcquisitionCandidateDigest,
  advancePrivateAcquisitionProgress as advance,
  createPrivateAcquisitionProgress as create,
  parsePrivateAcquisitionProgress as parse,
  type PrivateAcquisitionEvent
} from '../src/private/PrivateAcquisitionProgress.js'
import { acquisitionFixture } from './private-acquisition.fixture.js'

describe('durable acquisition lifecycle representation', () => {
  let f: Awaited<ReturnType<typeof acquisitionFixture>>
  beforeAll(async () => {
    f = await acquisitionFixture()
  })
  it('owns the original quote and walks each observable funded/delivery state', () => {
    const state = f.initial()
    expect(state).toMatchObject({
      phase: 'quoted',
      candidate: null,
      funding: null,
      recoveryUntil: '86500'
    })
    const pinned = f.pinned(),
      pending = f.reserved(),
      funded = f.funded()
    expect(pinned).toMatchObject({
      phase: 'quoted',
      candidate: { verdict: 'pending', receivedAt: '20' },
      funding: null
    })
    expect(pending.phase).toBe('funding-pending')
    expect(pending.funding!.operation.funding.outputIndex).toBe(1)
    expect(funded.phase).toBe('funded')
    const prepared = advance(funded, { type: 'prepare-delivery' }, '90000')
    expect(prepared).toMatchObject({
      phase: 'delivery-pending',
      recoveryUntil: '176400',
      delivery: { preparedAt: '90000', deliveredAt: null }
    })
    const delivered = advance(prepared, { type: 'delivered' }, '90003')
    expect(delivered).toMatchObject({
      phase: 'delivered',
      recoveryUntil: '176403',
      delivery: { preparedAt: '90000', deliveredAt: '90003' }
    })
    expect(funded.delivery).toBeNull()
    expect(parse(JSON.parse(canonicalOutputJSON(delivered)))).toEqual(delivered)
  })
  it.each(['99', '100', '86499'])(
    'pins the original payment received at %s, including after construction cutoff',
    time => {
      const state = f.pinned(time)
      expect(state.candidate!.receivedAt).toBe(time)
      expect(advance(state, { type: 'pin', payment: f.payment() }, '999999')).toEqual(state)
      expect(() => advance(state, { type: 'expire' }, '999999')).toThrow('cannot expire')
    }
  )
  it.each(['86500', '86501'])(
    'refuses a new payment at/after the exact recovery deadline %s',
    time => {
      expect(() => f.pinned(time)).toThrow(expect.objectContaining({ code: 'expired' }))
    }
  )
  it('finishes an in-time candidate after the recovery deadline without a new quote', () => {
    const state = f.reserved('86499', '90000')
    expect(state.phase).toBe('funding-pending')
    expect(state.challenge).toEqual(f.challenge)
    expect(state.candidate!.receivedAt).toBe('86499')
    expect(state.funding!.acceptance.acceptedAt).toBe('19')
  })
  it('rejects changed prefixes without pinning or modifying a quote', () => {
    const state = f.initial()
    expect(() =>
      advance(
        state,
        { type: 'pin', payment: { ...f.payment(), derivationPrefix: 'another' } },
        '20'
      )
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
    expect(state.candidate).toBeNull()
  })
  it('retains invalid-candidate evidence and permits a different candidate only before expiry', () => {
    const original = f.pinned()
    const invalid = advance(
      original,
      { type: 'invalid', candidateDigest: original.candidate!.digest, reason: 'invalid-evidence' },
      '30'
    )
    expect(invalid).toMatchObject({
      phase: 'quoted',
      funding: null,
      reason: null,
      candidate: { verdict: 'invalid', reason: 'invalid-evidence' }
    })
    const changed: OutputPaidLookupPayment = { ...f.payment(), derivationSuffix: 'different' }
    expect(() => advance(original, { type: 'pin', payment: changed }, '31')).toThrow(
      expect.objectContaining({ code: 'conflict' })
    )
    const retried = advance(invalid, { type: 'pin', payment: changed }, '31')
    expect(retried.candidate).toMatchObject({ verdict: 'pending', receivedAt: '31', reason: null })
    expect(retried.challenge).toEqual(f.challenge)
    expect(() => advance(invalid, { type: 'pin', payment: changed }, '86500')).toThrow(
      expect.objectContaining({ code: 'expired' })
    )
    expect(advance(invalid, { type: 'expire' }, '86500').phase).toBe('expired')
  })
  it('retains wallet rejection as terminal with exact funding and never renews the invoice', () => {
    const pending = f.reserved(),
      operation = pending.funding!.operation
    const failed = advance(
      pending,
      { type: 'wallet-rejected', operationId: operation.id, reason: 'payment-script-mismatch' },
      '23'
    )
    expect(failed).toMatchObject({
      phase: 'failed',
      funding: pending.funding,
      walletReceipt: null,
      reason: 'payment-script-mismatch'
    })
    expect(advance(failed, { type: 'pin', payment: f.payment() }, '999999')).toEqual(failed)
    expect(() =>
      advance(failed, { type: 'wallet-accepted', receipt: f.receipt(pending) }, '24')
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
  })
  it.each(['operationId', 'seller', 'satoshis', 'funding'] as const)(
    'rejects a wallet receipt with changed %s',
    field => {
      const state = f.reserved(),
        receipt = f.receipt(state)
      const bad = {
        ...receipt,
        [field]: field === 'funding' ? { ...receipt.funding, outputIndex: 0 } : 'changed'
      }
      expect(() => advance(state, { type: 'wallet-accepted', receipt: bad }, '22')).toThrow(
        expect.objectContaining({ code: 'unavailable' })
      )
      expect(state.walletReceipt).toBeNull()
    }
  )
  it('distinguishes absent/unknown wallet work from accepted work by having no advancing event for either', () => {
    for (const type of ['wallet-absent', 'wallet-unknown', 'timeout'])
      expect(() => advance(f.reserved(), { type } as PrivateAcquisitionEvent, '86501')).toThrow(
        expect.objectContaining({ code: 'unsupported' })
      )
  })
  it('preserves the original recovery floor and supports replayable delivery intents', () => {
    const a = advance(f.funded(), { type: 'prepare-delivery' }, '23')
    expect(a.recoveryUntil).toBe('86500')
    const b = advance(a, { type: 'prepare-delivery' }, '1000')
    expect(b).toMatchObject({
      recoveryUntil: '87400',
      delivery: { preparedAt: '1000', deliveredAt: null }
    })
    const c = advance(b, { type: 'delivered' }, '999')
    expect(c).toMatchObject({
      updatedAt: '1000',
      recoveryUntil: '87400',
      delivery: { deliveredAt: '1000' }
    })
  })
  it('retains funded delivery failure and refuses failure after delivery', () => {
    const funded = f.funded(),
      prepared = advance(funded, { type: 'prepare-delivery' }, '24')
    for (const state of [funded, prepared])
      expect(
        advance(state, { type: 'fail', reason: 'protected-material-unavailable' }, '90000')
      ).toMatchObject({
        phase: 'failed',
        funding: state.funding,
        walletReceipt: state.walletReceipt
      })
    const delivered = advance(prepared, { type: 'delivered' }, '25')
    expect(() =>
      advance(delivered, { type: 'fail', reason: 'transport-later-failed' }, '26')
    ).toThrow(expect.objectContaining({ code: 'conflict' }))
  })
  it('checks final recovery arithmetic before a delivery transition', () => {
    const edge = (18446744073709551615n - 86400n).toString()
    const valid = advance(f.funded(), { type: 'prepare-delivery' }, edge)
    expect(valid.recoveryUntil).toBe('18446744073709551615')
    expect(() => advance(valid, { type: 'delivered' }, (BigInt(edge) + 1n).toString())).toThrow(
      expect.objectContaining({ code: 'limited' })
    )
    expect(valid.phase).toBe('delivery-pending')
  })
  it.each(['99', '100'])('requires quote creation strictly before payableUntil (%s)', time => {
    if (time === '99') expect(f.initial(time).createdAt).toBe(time)
    else expect(() => f.initial(time)).toThrow()
  })
  it('binds quote identities and owns request data without invoking getters', () => {
    expect(() =>
      create({ ...f.request, recipient: f.seller }, f.challenge, f.selected, '1')
    ).toThrow()
    let called = false
    expect(() =>
      create(
        {
          ...f.request,
          get request() {
            called = true
            return ''
          }
        },
        f.challenge,
        f.selected,
        '1'
      )
    ).toThrow()
    expect(called).toBe(false)
    const state = f.initial()
    state.challenge.satoshis = '999'
    expect(f.challenge.satoshis).toBe('100')
  })
  it.each([
    ['format', 'future'],
    ['phase', 'other'],
    ['createdAt', '100'],
    ['updatedAt', '0'],
    ['recoveryUntil', '86499'],
    ['reason', 'leaked'],
    ['unexpected', true]
  ])('rejects malformed retained %s', (field, value) => {
    expect(() => parse({ ...f.initial(), [field]: value })).toThrow(OutputProtocolError)
  })
  it('checks retained candidate digests, receipt time and invalid verdict reasons', () => {
    const state = f.pinned(),
      value = state.candidate!
    for (const candidate of [
      { ...value, digest: 'ff'.repeat(32) },
      { ...value, receivedAt: '86500' },
      { ...value, receivedAt: '0' },
      { ...value, receivedAt: '21' },
      { ...value, verdict: 'invalid' },
      { ...value, reason: 'unexpected' }
    ])
      expect(() => parse({ ...state, candidate })).toThrow(OutputProtocolError)
  })
  it('checks every retained funding operation against all outputs and the exact original payment', () => {
    const state = f.reserved(),
      funding = state.funding!
    expect(() =>
      parse({
        ...state,
        funding: {
          ...funding,
          operation: {
            ...funding.operation,
            funding: { ...funding.operation.funding, outputIndex: 0 }
          }
        }
      })
    ).toThrow(OutputProtocolError)
    expect(() => parse({ ...state, funding: { ...funding, sellerPaymentKey: f.seller } })).toThrow(
      OutputProtocolError
    )
    expect(() =>
      parse({
        ...state,
        funding: { ...funding, acceptance: { ...funding.acceptance, txid: '11'.repeat(32) } }
      })
    ).toThrow(OutputProtocolError)
    const changed = structuredClone(state)
    changed.candidate!.payment.derivationSuffix = 'changed'
    changed.candidate!.digest = privateAcquisitionCandidateDigest(changed.candidate!.payment)
    expect(() => parse(changed)).toThrow(OutputProtocolError)
  })
  it('refuses impossible stored phases and delivery histories', () => {
    const initial = f.initial(),
      funded = f.funded(),
      prepared = advance(funded, { type: 'prepare-delivery' }, '24')
    for (const value of [
      { ...initial, phase: 'funded' },
      { ...initial, phase: 'failed', reason: 'synthetic' },
      { ...initial, phase: 'expired', reason: 'too-early' },
      { ...funded, phase: 'quoted' },
      { ...funded, phase: 'funding-pending' },
      { ...funded, recoveryUntil: '99999' },
      { ...prepared, phase: 'delivered' },
      { ...prepared, delivery: { preparedAt: '25', deliveredAt: null } },
      { ...prepared, phase: 'delivered', delivery: { preparedAt: '24', deliveredAt: '23' } },
      { ...prepared, delivery: { preparedAt: '1000', deliveredAt: null }, updatedAt: '1000' }
    ])
      expect(() => parse(value)).toThrow(OutputProtocolError)
  })
  it('rejects oversized retained reasons and asynchronous event-shaped values', () => {
    const state = f.pinned()
    expect(() =>
      advance(
        state,
        { type: 'invalid', candidateDigest: state.candidate!.digest, reason: 'x'.repeat(1025) },
        '21'
      )
    ).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() =>
      advance(
        state,
        Promise.resolve({ type: 'expire' }) as unknown as PrivateAcquisitionEvent,
        '21'
      )
    ).toThrow(OutputProtocolError)
    expect(() =>
      advance(state, { type: 'expire', extra: true } as PrivateAcquisitionEvent, '90000')
    ).toThrow(OutputProtocolError)
  })
})
