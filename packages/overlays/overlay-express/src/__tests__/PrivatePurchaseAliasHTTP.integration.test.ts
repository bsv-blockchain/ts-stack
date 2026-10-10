import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, verifyOutputPurchaseCommitmentEnvelope } from '@bsv/sdk'
import { privatePurchaseAliasHTTPFixture } from './PrivatePurchaseAliasHTTP.fixture.js'
import { identity } from '../../../../application/output-knowledge/test/private-purchase-aliases.fixture.js'

it('authenticates free alias recovery over actual HTTP while preserving the first signed weak-policy release', async () => {
  const f = await privatePurchaseAliasHTTPFixture()
  try {
    const terms = await (await f.fetch()).json()
    const first = await (await f.fetch('submit')).json()
    expect(first.result.status).toBe('delivered')
    expect(first.currentAlias).toBeUndefined()
    f.owner.setMined(true)
    const selected = f.owner.f.f.variant(81)
    const replacement = await f.fetch('submit', JSON.stringify(selected))
    expect(replacement.status).toBe(200)
    const report = await replacement.json()
    expect(report.currentAlias).toEqual({ txid: selected.txid, beef: selected.beef })
    expect(canonicalOutputJSON(report.result)).toBe(canonicalOutputJSON(first.result))
    expect(canonicalOutputJSON(report.releaseEvidence)).toBe(
      canonicalOutputJSON(first.releaseEvidence)
    )
    expect(
      verifyOutputPurchaseCommitmentEnvelope(report, terms, {
        profile: 'full-purchase-commitment-v1',
        domainProfile: terms.body.domainProfile,
        purchaseCommitment: identity
      })
    ).toEqual(report)
    expect(await (await f.fetch('recover')).json()).toEqual(report)
    expect(f.owner.base.counts.issue).toBe(1)
    expect(f.owner.base.counts.potatoes).toBe(1)
    for (const headers of f.wireHeaders) {
      expect(headers.get('x-bsv-auth-identity-key')).toBe(f.contract.installation.seller)
      expect(headers.get('cache-control')).toBe('private, no-store')
      expect([...headers.keys()].some(name => name.startsWith('x-bsv-payment'))).toBe(false)
    }
  } finally {
    await f.close()
  }
}, 30000)

it('withdraws a prepared alias during actual HTTP signing and recovers historical material on a subsequent request', async () => {
  const f = await privatePurchaseAliasHTTPFixture()
  try {
    await f.fetch()
    await f.fetch('submit')
    f.owner.setMined(true)
    await f.fetch('submit', JSON.stringify(f.owner.f.f.variant(82)))
    f.onHTTPSign(() => {
      f.owner.setCurrent(false)
    })
    const changed = await f.fetch('recover'),
      packet = await changed.json()
    expect(changed.status).toBe(409)
    expect(packet).toMatchObject({ version: 1, error: { code: 'context-changed' } })
    expect(packet.result).toBeUndefined()
    expect(packet.currentAlias).toBeUndefined()
    f.onHTTPSign()
    const recovered = await f.fetch('recover'),
      historical = await recovered.json()
    expect(recovered.status).toBe(200)
    expect(historical.result.status).toBe('delivered')
    expect(historical.currentAlias).toBeUndefined()
    expect(f.owner.base.counts.issue).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)

it('preserves legacy lookup and submission alongside explicitly installed asynchronous alias disclosure', async () => {
  const f = await privatePurchaseAliasHTTPFixture()
  try {
    for (const [path, expected] of [
      ['submit', { legacy: { outputsToAdmit: [0], coinsToRetain: [] } }],
      ['lookup', { type: 'output-list', outputs: [] }]
    ] as const) {
      const response = await fetch(f.origin + '/' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual(expected)
    }
    const response = await f.fetch()
    expect(response.status).toBe(200)
    expect(f.owner.counts.assessments).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)
