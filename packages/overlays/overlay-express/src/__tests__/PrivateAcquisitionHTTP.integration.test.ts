import { acquisitionNativeWalletFixture } from '../../../../application/output-knowledge/test/private-acquisition-wallet.fixture.js'
import { expect, it } from '@jest/globals'
import { PrivateKey } from '@bsv/sdk'
import { privateAcquisitionHTTPFixture } from './PrivateAcquisitionRoutes.fixture.js'
it('authenticates the original challenge, accepts exact payment and recovers without a second credit', async () => {
  const f = await privateAcquisitionHTTPFixture()
  try {
    const quoted = await f.fetch()
    expect(quoted.status).toBe(402)
    const challenge = await quoted.json()
    expect(challenge).toMatchObject({
      acquisitionId: f.f.id,
      seller: f.contract.installation.seller,
      buyer: f.caller.buyer,
      satoshis: '100'
    })
    const headers = f.wireHeaders.at(-1)!
    expect(headers.get('x-bsv-payment-satoshis-required')).toBe('100')
    expect(headers.get('x-bsv-payment-derivation-prefix')).toBe(challenge.derivationPrefix)
    expect(headers.get('x-bsv-auth-identity-key')).toBe(challenge.seller)
    const delivered = await f.fetch('acquire', undefined, f.payment)
    expect(delivered.status).toBe(200)
    expect(await delivered.json()).toMatchObject({
      status: 'delivered',
      result: { context: 'AQID' }
    })
    const recovery = await f.fetch('recover')
    expect(recovery.status).toBe(200)
    expect(await recovery.json()).toMatchObject({ status: 'delivered', challenge })
    expect(f.getCredits()).toBe(1)
    expect(f.wireHeaders.at(-1)!.get('cache-control')).toBe('private, no-store')
    expect(f.wireHeaders.at(-1)!.has('x-bsv-payment-satoshis-required')).toBe(false)
  } finally {
    await f.close()
  }
}, 30000)
it('supports paid CORS preflight and keeps legacy uncharged lookup reachable', async () => {
  const f = await privateAcquisitionHTTPFixture()
  try {
    const response = await fetch(f.origin + '/api/overlay/v1/private/acquire', {
      method: 'OPTIONS',
      headers: {
        origin: 'https://another-app.example',
        'access-control-request-headers': 'x-bsv-payment, content-type, x-bsv-overlay-profile'
      }
    })
    expect(response.status).toBe(204)
    expect(response.headers.get('access-control-allow-origin')).toBe('*')
    expect(response.headers.get('access-control-expose-headers')).toContain(
      'x-bsv-payment-satoshis-required'
    )
    expect(response.headers.has('access-control-allow-credentials')).toBe(false)
    const legacy = await fetch(f.origin + '/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(await legacy.json()).toEqual({ type: 'output-list', outputs: [] })
  } finally {
    await f.close()
  }
}, 30000)
it('rejects payment on recovery and preserves fixed wrong-buyer errors', async () => {
  const f = await privateAcquisitionHTTPFixture()
  try {
    await f.fetch()
    const paidRecovery = await f.fetch('recover', undefined, f.payment)
    expect(paidRecovery.status).toBe(400)
    expect(await paidRecovery.json()).toMatchObject({
      error: { code: 'invalid', message: 'Private acquisition request invalid' }
    })
    const wrong = await f
      .clientFor(new PrivateKey(92))
      .fetch(f.origin + '/api/overlay/v1/private/recover', {
        method: 'POST',
        headers: f.headers,
        body: JSON.stringify(f.status)
      })
    expect(wrong.status).toBe(404)
    expect(await wrong.json()).toMatchObject({
      error: { code: 'not-found', message: 'Private acquisition request not-found' }
    })
    expect(f.getCredits()).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)
it('replaces a challenge that expires during signing with a signed fixed error and no payment headers', async () => {
  const f = await privateAcquisitionHTTPFixture()
  try {
    await f.fetch()
    f.onHTTPSign(() => {
      f.f.setNow('100')
    })
    const response = await f.fetch()
    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({
      error: { code: 'expired', message: 'Private acquisition request expired' }
    })
    const sent = f.wireHeaders.at(-1)!
    expect(sent.has('x-bsv-payment-satoshis-required')).toBe(false)
    expect(sent.has('x-bsv-payment-derivation-prefix')).toBe(false)
    expect(sent.has('x-bsv-payment-version')).toBe(false)
    expect(f.getCredits()).toBe(0)
    f.onHTTPSign()
    const retry = await f.fetch()
    expect(retry.status).toBe(200)
    expect(await retry.json()).toMatchObject({ status: 'quoted' })
  } finally {
    await f.close()
  }
}, 30000)
it('withholds delivered material when buyer permission changes after response signing', async () => {
  const f = await privateAcquisitionHTTPFixture()
  try {
    await f.fetch()
    await f.fetch('acquire', undefined, f.payment)
    f.onHTTPSign(() => {
      f.setAccess(false)
    })
    const response = await f.fetch('recover')
    expect(response.status).toBe(404)
    const packet = await response.json()
    expect(packet).toEqual({
      version: 1,
      error: {
        code: 'not-found',
        message: 'Private acquisition request not-found',
        retryable: false
      }
    })
    expect(f.getCredits()).toBe(1)
    f.onHTTPSign()
    f.setAccess(true)
    const recovered = await f.fetch('recover')
    expect(await recovered.json()).toMatchObject({
      status: 'delivered',
      result: { context: 'AQID' }
    })
    expect(f.getCredits()).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)
it('closes without a body when both data and replacement-control permission change during signing', async () => {
  const f = await privateAcquisitionHTTPFixture()
  try {
    await f.fetch()
    f.onHTTPSign(() => {
      f.setAccess(false)
      f.httpState.control = false
    })
    const before = f.wireHeaders.length
    await expect(f.fetch('recover')).rejects.toThrow()
    expect(f.wireHeaders).toHaveLength(before)
    expect(f.getCredits()).toBe(0)
  } finally {
    await f.close()
  }
}, 30000)
it('does not issue a second paid challenge while a received transaction awaits its release policy', async () => {
  const f = await privateAcquisitionHTTPFixture()
  try {
    await f.fetch()
    f.setRelease(false)
    const pending = await f.fetch('acquire', undefined, f.payment)
    expect(pending.status).toBe(200)
    expect(await pending.json()).toMatchObject({ status: 'quoted' })
    f.f.setNow('201')
    const retried = await f.fetch()
    expect(retried.status).toBe(200)
    expect(f.wireHeaders.at(-1)!.has('x-bsv-payment-satoshis-required')).toBe(false)
    f.setRelease(true)
    const recovered = await f.fetch('recover')
    expect(recovered.status).toBe(200)
    expect(await recovered.json()).toMatchObject({
      status: 'delivered',
      result: { context: 'AQID' }
    })
    expect(f.getCredits()).toBe(1)
  } finally {
    await f.close()
  }
}, 30000)
it('composes authenticated payment and recovery with a real SQLite wallet receipt without broadcasting', async () => {
  const { PrivateAcquisitionCoordinator } =
    await import('../../../../application/output-knowledge/src/private/PrivateAcquisitionCoordinator.js')
  const { chain, context, resolver } =
    await import('../../../../application/output-knowledge/test/evidence-fixture.js')
  const selected = { ...chain, network: 'mock' as const }
  let wallet!: Awaited<ReturnType<typeof acquisitionNativeWalletFixture>>
  let coordinator!: InstanceType<typeof PrivateAcquisitionCoordinator>
  const f = await privateAcquisitionHTTPFixture(
    async owner => {
      const view = await resolver.resolve(
        { ...context().view, chain: selected },
        new AbortController().signal
      )
      wallet = await acquisitionNativeWalletFixture(selected, view.tracker)
      coordinator = new PrivateAcquisitionCoordinator({
        ...owner.options,
        wallet: wallet.native.bridge
      })
      return { service: coordinator }
    },
    false,
    selected
  )
  try {
    expect((await f.fetch()).status).toBe(402)
    const paid = await f.fetch('acquire', undefined, f.payment)
    expect(paid.status).toBe(200)
    expect(await paid.json()).toMatchObject({ status: 'delivered', result: { context: 'AQID' } })
    for (let i = 0; i < 2; i++) {
      const recovered = await f.fetch('recover')
      expect(recovered.status).toBe(200)
      expect(await recovered.json()).toMatchObject({
        status: 'delivered',
        result: { context: 'AQID' }
      })
    }
    const outputs = await wallet.native.active.findOutputs({
      partial: { txid: f.paymentTransaction.id('hex') }
    })
    expect(outputs).toHaveLength(1)
    expect(outputs[0]).toMatchObject({
      satoshis: 100,
      vout: 0,
      change: true,
      senderIdentityKey: f.caller.buyer
    })
    const transactions = await wallet.native.active.findTransactions({
      partial: { txid: f.paymentTransaction.id('hex') }
    })
    expect(transactions).toHaveLength(1)
    expect(transactions[0].satoshis).toBe(100)
    expect(wallet.broadcast).not.toHaveBeenCalled()
    expect(f.getCredits()).toBe(0)
  } finally {
    await coordinator.stop()
    await f.close()
    await wallet.close()
  }
}, 30000)
