import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, Utils } from '@bsv/sdk'
import { signObject, WalletBRC78KeyDelivery } from '../src/index.js'
import { LCHOverlayPaidDomain } from '../src/overlayAcquisitionPaid.js'
import {
  lchOverlayEntitlementLicense,
  lchOverlayPaidEntitlementDigest
} from '../src/overlayAcquisitionEntitlement.js'
import {
  decodeLCHOverlayJSON,
  encodeLCHOverlayContext,
  type UnverifiedLCHOverlayContext
} from '../src/overlayAcquisitionCodec.js'
import { lchPaidFixture } from './overlay-acquisition-paid.fixture.js'

it('normalizes only reissue noise while owning every original License right and grant identity', () => {
  const sender = new Uint8Array(33).fill(2),
    recipient = new Uint8Array(33).fill(3),
    payload = new Uint8Array(103),
    keyId = new Uint8Array(32).fill(4),
    subject = new Uint8Array(33).fill(5)
  payload.set(sender, 4)
  payload.set(recipient, 37)
  const original = {
      body: {
        issuedAt: 20,
        subject,
        permissions: [{ action: 'render' }],
        keyGrants: [{ keyId, delivery: 'urn:reference:key-delivery', payload }]
      },
      signatures: [Uint8Array.of(1)]
    },
    retained = lchOverlayEntitlementLicense(original)
  expect(retained).toEqual({
    subject,
    permissions: [{ action: 'render' }],
    keyGrants: [{ keyId, delivery: 'urn:reference:key-delivery', sender, recipient }]
  })
  expect(original.body.issuedAt).toBe(20)
  expect(original.body.keyGrants[0].payload).toBe(payload)
  subject.fill(0)
  keyId.fill(0)
  payload.fill(0)
  expect(retained.subject).toEqual(new Uint8Array(33).fill(5))
  expect((retained.keyGrants as Array<Record<string, unknown>>)[0]).toEqual({
    keyId: new Uint8Array(32).fill(4),
    delivery: 'urn:reference:key-delivery',
    sender,
    recipient
  })
})

it('refuses missing grants and truncated or wrongly represented grant payloads', () => {
  for (const keyGrants of [undefined, null, {}, 'invalid']) {
    const body = keyGrants === undefined ? {} : { keyGrants }
    expect(() => lchOverlayEntitlementLicense({ body, signatures: [] } as never)).toThrow(
      'Missing key grants'
    )
  }
  for (const payload of [null, [], new Uint8Array(102)])
    expect(() =>
      lchOverlayEntitlementLicense({ body: { keyGrants: [{ payload }] }, signatures: [] } as never)
    ).toThrow('payload is truncated')
})

it('keeps a paid entitlement fingerprint stable across representation-only reissue noise without mutating delivery', async () => {
  const f = await lchPaidFixture(),
    before = canonicalOutputJSON(f.delivered),
    digest = await lchOverlayPaidEntitlementDigest(f.delivered),
    settlement = decodeLCHOverlayJSON(f.wrapper.settlement) as Record<string, unknown>,
    keyGrants = f.licenseOptions.keyGrants.map(grant => {
      const payload = grant.payload.slice()
      payload.fill(7, 70)
      return { ...grant, payload }
    }),
    wrapper: UnverifiedLCHOverlayContext = {
      ...f.wrapper,
      license: {
        body: { ...f.license.body, issuedAt: 99, keyGrants: keyGrants as never },
        signatures: [Uint8Array.of(2)]
      },
      evidence: f.wrapper.evidence.map(entry => ({
        ...entry,
        object: { ...entry.object, signatures: [Uint8Array.of(3)] }
      })),
      settlement: new TextEncoder().encode(
        canonicalOutputJSON({ ...settlement, signature: 'ab'.repeat(32) })
      )
    },
    reissue = {
      ...f.delivered,
      result: {
        ...f.delivered.result!,
        context: Utils.toBase64(await encodeLCHOverlayContext(wrapper, 'paid-lookup'))
      }
    }
  expect(digest).toMatch(/^[0-9a-f]{64}$/u)
  expect(await lchOverlayPaidEntitlementDigest(reissue)).toBe(digest)
  expect(canonicalOutputJSON(f.delivered)).toBe(before)
  expect(f.counts).toEqual({ funding: 0, listing: 0, release: 0 })
})

it('changes a paid fingerprint for every changed right, grant identity, settlement or payment and authority evidence', async () => {
  const f = await lchPaidFixture(),
    digest = await lchOverlayPaidEntitlementDigest(f.delivered),
    settlement = decodeLCHOverlayJSON(f.wrapper.settlement) as { body: Record<string, unknown> },
    changes: UnverifiedLCHOverlayContext[] = [
      {
        ...f.wrapper,
        license: { ...f.license, body: { ...f.license.body, subject: new Uint8Array(33).fill(8) } }
      },
      {
        ...f.wrapper,
        license: { ...f.license, body: { ...f.license.body, permissions: [{ action: 'unwrap' }] } }
      },
      {
        ...f.wrapper,
        settlement: new TextEncoder().encode(
          canonicalOutputJSON({
            ...settlement,
            body: { ...settlement.body, acquisitionId: 'ab'.repeat(32) }
          })
        )
      },
      { ...f.wrapper, paymentEvidence: new TextEncoder().encode('{}') },
      {
        ...f.wrapper,
        evidence: f.wrapper.evidence.map(entry => ({
          ...entry,
          object: { ...entry.object, body: { ...entry.object.body, issuedAt: 999 } }
        }))
      },
      { ...f.wrapper, evidence: f.wrapper.evidence.map(entry => ({ ...entry, type: 'authority' })) }
    ]
  for (const offset of [4, 37]) {
    const grants = f.licenseOptions.keyGrants.map(grant => {
      const payload = grant.payload.slice()
      payload[offset] ^= 1
      return { ...grant, payload }
    })
    changes.push({
      ...f.wrapper,
      license: { ...f.license, body: { ...f.license.body, keyGrants: grants as never } }
    })
  }
  changes.push({
    ...f.wrapper,
    license: {
      ...f.license,
      body: {
        ...f.license.body,
        keyGrants: f.licenseOptions.keyGrants.map(grant => ({
          ...grant,
          keyId: new Uint8Array(32).fill(8)
        })) as never
      }
    }
  })
  for (const wrapper of changes) {
    const changed = {
      ...f.delivered,
      result: {
        ...f.delivered.result!,
        context: Utils.toBase64(await encodeLCHOverlayContext(wrapper, 'paid-lookup'))
      }
    }
    expect(await lchOverlayPaidEntitlementDigest(changed)).not.toBe(digest)
  }
  expect(
    await lchOverlayPaidEntitlementDigest({ ...f.delivered, recoveryUntil: '90000' })
  ).not.toBe(digest)
  expect(
    await lchOverlayPaidEntitlementDigest({
      ...f.delivered,
      result: { ...f.delivered.result!, schema: 'urn:changed:schema' }
    })
  ).not.toBe(digest)
  expect(f.counts).toEqual({ funding: 0, listing: 0, release: 0 })
})

it('requires complete delivered material and an own settlement body before fingerprinting paid rights', async () => {
  const f = await lchPaidFixture()
  await expect(
    lchOverlayPaidEntitlementDigest({ ...f.delivered, status: 'quoted' } as never)
  ).rejects.toThrow('complete delivered material')
  const missing = { ...f.delivered }
  Reflect.deleteProperty(missing, 'result')
  await expect(lchOverlayPaidEntitlementDigest(missing)).rejects.toThrow(
    'complete delivered material'
  )
  for (const settlement of [null, [], 'invalid', 1, {}]) {
    const context = await encodeLCHOverlayContext(
        { ...f.wrapper, settlement: new TextEncoder().encode(canonicalOutputJSON(settlement)) },
        'paid-lookup'
      ),
      changed = {
        ...f.delivered,
        result: { ...f.delivered.result!, context: Utils.toBase64(context) }
      }
    await expect(lchOverlayPaidEntitlementDigest(changed)).rejects.toThrow(
      'Settlement packet is missing'
    )
  }
})

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
