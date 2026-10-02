import { expect, it } from '@jest/globals'
import { signObject, WalletBRC78KeyDelivery } from '../src/index.js'
import { LCHOverlayPaidDomain } from '../src/overlayAcquisitionPaid.js'
import { lchPaidFixture } from './overlay-acquisition-paid.fixture.js'

it('independently verifies the signed payment, exact License and recipient-bound keys before authenticated playback', async () => {
  const f = await lchPaidFixture(),
    signal = new AbortController().signal
  await f.domain.preflight(f.acquire, f.challenge, signal)
  expect(f.counts).toEqual({ funding: 0, listing: 0, release: 0 })
  await f.domain.verify(f.acquire, f.challenge, f.payment, f.delivered, signal)
  expect(f.counts).toEqual({ funding: 1, listing: 1, release: 1 })
  expect(await f.domain.usable(f.delivered, signal)).toBe(true)
  expect(await f.domain.playback(f.delivered, signal)).toEqual(f.plaintext)
  expect(f.counts).toEqual({ funding: 1, listing: 1, release: 1 })
})
it('reopens original funded terms after Offer expiry without another quote or payment', async () => {
  const f = await lchPaidFixture(),
    retained = { id: f.domain.id, original: f.domain.original() },
    signal = new AbortController().signal
  await f.domain.verify(f.acquire, f.challenge, f.payment, f.delivered, signal)
  await f.objects.close()
  f.setNow('200')
  const objects = f.openObjects(),
    reopened = await LCHOverlayPaidDomain.open(f.options, retained, objects)
  await expect(reopened.preflight(f.acquire, null, signal)).rejects.toThrow('window')
  expect(await reopened.playback(f.delivered, signal)).toEqual(f.plaintext)
  await expect(
    LCHOverlayPaidDomain.open(f.options, { ...retained, id: retained.id + 'changed' }, objects)
  ).rejects.toThrow('installation differs')
})
it('rejects signed entitlement substitutions and an unrelated settlement profile', async () => {
  const f = await lchPaidFixture(),
    signal = new AbortController().signal
  for (const change of [
    { subject: f.seller.identityKey },
    { assetId: new Uint8Array(32) },
    {
      fulfillments: [
        {
          dutyUid: f.terms.policy.dutyUid,
          settlementProfile: 'https://bsv.brc.dev/apps/0170#receipt-complete-v1',
          receiptIds: []
        }
      ]
    },
    { notAfter: 1000 },
    { permissions: [{ action: 'unwrap' }] }
  ]) {
    const license = await signObject('license', { ...f.license.body, ...change }, f.seller),
      delivered = await f.replaceLicense(license)
    await expect(
      f.domain.verify(f.acquire, f.challenge, f.payment, delivered, signal)
    ).rejects.toThrow()
    await expect(f.domain.playback(delivered, signal)).rejects.toThrow('not been locally verified')
  }
})
it('refuses a key grant for another recipient before exposing plaintext', async () => {
  const f = await lchPaidFixture(),
    signal = new AbortController().signal,
    grants = f.licenseOptions.keyGrants.map(grant => ({ ...grant, payload: grant.payload.slice() }))
  grants[0].payload.set(f.seller.identityKey, 37)
  const license = await f.issuer.issueLicense({ ...f.licenseOptions, keyGrants: grants })
  await expect(
    f.domain.verify(f.acquire, f.challenge, f.payment, await f.replaceLicense(license), signal)
  ).rejects.toThrow('identity binding')
})
it('stops changed proof/source installations, revocation of local access and cancellation', async () => {
  const f = await lchPaidFixture(),
    signal = new AbortController().signal
  await f.domain.verify(f.acquire, f.challenge, f.payment, f.delivered, signal)
  f.setAccess(false)
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('inaccessible')
  f.setAccess(true)
  const abort = new AbortController()
  abort.abort()
  await expect(f.domain.playback(f.delivered, abort.signal)).rejects.toThrow('cancelled')
  f.options.verification.funding = () => {
    throw new Error('Changed verifier must never run')
  }
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('changed')
})
it('requires protected custody before preflight and checks the actual buyer wallet before funding', async () => {
  const f = await lchPaidFixture(),
    signal = new AbortController().signal,
    uninitialized = await LCHOverlayPaidDomain.create(f.options)
  await expect(uninitialized.preflight(f.acquire, null, signal)).rejects.toThrow('not initialized')
  await expect(
    LCHOverlayPaidDomain.create({ ...f.options, wallet: f.sellerWallet })
  ).rejects.toThrow('Installed buyer wallet')
  expect(f.counts).toEqual({ funding: 0, listing: 0, release: 0 })
})
it('accepts equivalent License reissue from retained entitlement without online payment or chain checks', async () => {
  const f = await lchPaidFixture(),
    signal = new AbortController().signal
  await f.domain.verify(f.acquire, f.challenge, f.payment, f.delivered, signal)
  const delivery = new WalletBRC78KeyDelivery(f.sellerWallet),
    grants = []
  for (const grant of f.licenseOptions.keyGrants)
    grants.push({
      ...grant,
      payload: await delivery.deliver(
        f.acquire.recipient,
        grant.keyId,
        f.asset.keys.get(
          Array.from(grant.keyId, byte => byte.toString(16).padStart(2, '0')).join('')
        )!
      )
    })
  f.setNow('200')
  const license = await f.issuer.issueLicense({
      ...f.licenseOptions,
      issuedAt: 200,
      keyGrants: grants
    }),
    equivalent = await f.replaceLicense(license)
  expect(equivalent.result!.context).not.toBe(f.delivered.result!.context)
  expect(await f.domain.playback(equivalent, signal)).toEqual(f.plaintext)
  expect(f.counts).toEqual({ funding: 1, listing: 1, release: 1 })
  const forged = await f.replaceLicense({ ...license, signatures: [Uint8Array.of(1)] })
  await expect(f.domain.playback(forged, signal)).rejects.toThrow()
})
it('never treats a retained representation fingerprint as authentication of changed encrypted grant bytes', async () => {
  const f = await lchPaidFixture(),
    signal = new AbortController().signal
  await f.domain.verify(f.acquire, f.challenge, f.payment, f.delivered, signal)
  const grants = f.licenseOptions.keyGrants.map(grant => ({
    ...grant,
    payload: grant.payload.slice()
  }))
  grants[0].payload[grants[0].payload.length - 1] ^= 1
  const license = await f.issuer.issueLicense({ ...f.licenseOptions, keyGrants: grants })
  await expect(f.domain.playback(await f.replaceLicense(license), signal)).rejects.toThrow(
    'recovery failed'
  )
  expect(f.counts).toEqual({ funding: 1, listing: 1, release: 1 })
})
