import { beforeAll, describe, expect, it } from '@jest/globals'
import { OutputProtocolError } from '@bsv/sdk'
import { acquisitionFixture } from './private-acquisition.fixture.js'
import { advancePrivateAcquisitionProgress as advance } from '../src/private/PrivateAcquisitionProgress.js'
import { privateAcquisitionResult } from '../src/private/PrivateAcquisitionResult.js'

describe('private acquisition recipient projection', () => {
  let f: Awaited<ReturnType<typeof acquisitionFixture>>
  beforeAll(async () => {
    f = await acquisitionFixture()
  })
  it('keeps candidate bytes, native wallet receipts and derivations off pending responses', () => {
    for (const state of [f.initial(), f.pinned(), f.reserved(), f.funded()]) {
      const result = privateAcquisitionResult(state, f.request)
      expect(result.status).toBe(state.phase)
      expect(Object.keys(result).sort()).toEqual(
        [
          'version',
          'acquisitionId',
          'status',
          'recoveryUntil',
          'challenge',
          ...(state.funding ? ['funding'] : []),
          ...(state.phase === 'funded' ? ['acceptance'] : [])
        ].sort()
      )
      expect(JSON.stringify(result)).not.toContain('fixture-only')
      expect(JSON.stringify(result)).not.toContain('derivationSuffix')
    }
  })
  it('binds delivered output to the original acquired listing', () => {
    const ready = advance(
      advance(f.funded(), { type: 'prepare-delivery' }, '24'),
      { type: 'delivered' },
      '25'
    )
    const result = {
      evidence: { txid: f.request.listing.txid, outputIndex: 0, beef: '' },
      context: 'a2V5',
      schema: 'content-access-v1'
    }
    const projected = privateAcquisitionResult(ready, f.request, result)
    expect(projected.result).toEqual(result)
    expect(() => privateAcquisitionResult(ready, f.request)).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
    expect(() =>
      privateAcquisitionResult(ready, f.request, {
        ...result,
        evidence: { ...result.evidence, outputIndex: 1 }
      })
    ).toThrow(OutputProtocolError)
    expect(() => privateAcquisitionResult(f.funded(), f.request, result)).toThrow(
      expect.objectContaining({ code: 'unavailable' })
    )
  })
  it('retains exact reason and funding on failure, without asserting external nonsettlement', () => {
    const pending = f.reserved()
    const failed = advance(
      pending,
      {
        type: 'wallet-rejected',
        operationId: pending.funding!.operation.id,
        reason: 'payment-script-mismatch'
      },
      '22'
    )
    expect(privateAcquisitionResult(failed, f.request)).toMatchObject({
      status: 'failed',
      reason: 'payment-script-mismatch',
      funding: pending.funding!.operation.funding,
      acceptance: pending.funding!.acceptance
    })
    const expired = advance(f.initial(), { type: 'expire' }, '86500')
    expect(privateAcquisitionResult(expired, f.request)).toMatchObject({
      status: 'expired',
      reason: 'recovery-expired'
    })
  })
  it('refuses a replacement request even if price and recipient are unchanged', () => {
    expect(() =>
      privateAcquisitionResult(f.pinned(), { ...f.request, assetId: '00'.repeat(32) })
    ).toThrow(OutputProtocolError)
  })
})
