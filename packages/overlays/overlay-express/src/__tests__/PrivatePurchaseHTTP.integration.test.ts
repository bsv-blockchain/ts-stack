import { expect, it } from '@jest/globals'
import { PrivateKey, verifyOutputPurchaseEnvelope } from '@bsv/sdk'
import { privatePurchaseHTTPFixture } from './PrivatePurchaseRoutes.fixture.js'

it('authenticates original covenant terms and retains one bound STEAK/POTATOES result without an HTTP charge', async () => {
  const f = await privatePurchaseHTTPFixture()
  try {
    const first = await f.fetch(),
      terms = await first.json()
    expect(first.status).toBe(200)
    expect(terms.body).toMatchObject({
      recipient: f.owner.caller.buyer,
      acquisitionId: f.owner.f.id
    })
    expect(await (await f.fetch()).json()).toEqual(terms)
    const sent = await f.fetch('submit'),
      envelope = await sent.json()
    expect(sent.status).toBe(200)
    expect(envelope.result).toMatchObject({
      status: 'delivered',
      txid: f.owner.f.candidate.txid,
      steak: f.owner.f.f.steak,
      potatoes: { body: { recipient: f.owner.caller.buyer } }
    })
    expect(verifyOutputPurchaseEnvelope(envelope, terms, f.owner.f.candidate.txid)).toEqual(
      envelope
    )
    expect(await (await f.fetch('recover')).json()).toEqual(envelope)
    expect(f.owner.counts.terms).toBe(1)
    expect(f.owner.counts.potatoes).toBe(1)
    for (const headers of f.wireHeaders) {
      expect(headers.get('x-bsv-auth-identity-key')).toBe(f.contract.installation.seller)
      expect([...headers.keys()].some(name => name.startsWith('x-bsv-payment'))).toBe(false)
      expect(headers.get('cache-control')).toBe('private, no-store')
    }
  } finally {
    await f.close()
  }
}, 30000)

it('keeps unknown admission and delayed release distinct without disclosing a key', async () => {
  const f = await privatePurchaseHTTPFixture()
  try {
    await f.fetch()
    f.owner.setAdmitted(false)
    expect(await (await f.fetch('submit')).json()).toMatchObject({
      result: { status: 'admission-pending' }
    })
    f.owner.setAdmitted(true)
    f.owner.setRelease(false)
    const pending = await (await f.fetch('recover')).json()
    expect(pending).toMatchObject({
      result: { status: 'admitted-delivery-pending', steak: f.owner.f.f.steak }
    })
    expect(pending.result.potatoes).toBeUndefined()
    expect(f.owner.counts.issue).toBe(0)
    f.owner.f.setNow('100000')
    f.owner.setRelease(true)
    expect(await (await f.fetch('recover')).json()).toMatchObject({
      result: { status: 'delivered' }
    })
  } finally {
    await f.close()
  }
}, 30000)

it('replaces material revoked during HTTP signing with a fixed authenticated not-found response', async () => {
  const f = await privatePurchaseHTTPFixture()
  try {
    await f.fetch()
    await f.fetch('submit')
    f.onHTTPSign(() => {
      f.setPermitted(false)
    })
    const response = await f.fetch('recover'),
      packet = await response.json()
    expect(response.status).toBe(404)
    expect(packet).toEqual({
      version: 1,
      error: { code: 'not-found', message: 'Private purchase request not-found', retryable: false }
    })
    expect(f.wireHeaders.at(-1)!.get('x-bsv-auth-identity-key')).toBe(
      f.contract.installation.seller
    )
  } finally {
    await f.close()
  }
}, 30000)

it('refuses wrong recipients and payment headers, preserving legacy submission and lookup', async () => {
  const f = await privatePurchaseHTTPFixture()
  try {
    await f.fetch()
    const wrong = await f
      .clientFor(new PrivateKey(45))
      .fetch(f.origin + '/api/overlay/v1/purchases/recover', {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify({ version: 1, acquisitionId: f.owner.f.id })
      })
    expect(wrong.status).toBe(404)
    expect(await wrong.json()).toMatchObject({ error: { code: 'not-found' } })
    // Transport headers are refused before authentication or private work.
    const paid = await fetch(f.origin + '/api/overlay/v1/purchases/submit', {
      method: 'POST',
      headers: { ...f.headers, 'x-bsv-payment': '{}' },
      body: JSON.stringify(f.owner.f.candidate)
    })
    expect(paid.status).toBe(400)
    expect(await paid.json()).toMatchObject({ error: { code: 'invalid' } })
    for (const [route, expected] of [
      ['submit', { legacy: { outputsToAdmit: [0], coinsToRetain: [] } }],
      ['lookup', { type: 'output-list', outputs: [] }]
    ] as const) {
      const response = await fetch(f.origin + '/' + route, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      expect(await response.json()).toEqual(expected)
    }
  } finally {
    await f.close()
  }
}, 30000)

it('exposes only authenticated covenant headers through credential-free CORS', async () => {
  const f = await privatePurchaseHTTPFixture()
  try {
    const endpoint = f.origin + '/api/overlay/v1/purchases/prepare'
    const response = await fetch(endpoint, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://app.example',
        'access-control-request-headers': 'content-type, x-bsv-overlay-profile'
      }
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-expose-headers')).toContain('x-bsv-overlay-profile')
    expect(response.headers.get('access-control-expose-headers')).not.toContain('x-bsv-payment')
    expect(response.headers.has('access-control-allow-credentials')).toBe(false)
    expect(
      (
        await fetch(endpoint, {
          method: 'OPTIONS',
          headers: { 'access-control-request-headers': 'x-bsv-payment' }
        })
      ).status
    ).toBe(403)
  } finally {
    await f.close()
  }
}, 30000)
