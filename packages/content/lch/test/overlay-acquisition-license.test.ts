import { expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import {
  LCHReader,
  WalletBRC77Signer,
  WalletBRC78KeyDelivery,
  objectId,
  signObject,
  type LCHValue,
  type KeyGrant
} from '../src/index.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import { validateLCHOverlayLicense } from '../src/overlayAcquisitionLicense.js'
import {
  LCH_OVERLAY_COVENANT_MECHANISMS,
  validateLCHOverlayCovenantTerms
} from '../src/overlayAcquisitionCovenantTerms.js'
import type { LCHOverlayAuthorityPath } from '../src/overlayAcquisitionAuthority.js'
import { lchOverlayLicenseFixture } from './overlay-acquisition-license.fixture.js'

it('validates C rights, original Agreement and actual recipient grants before authenticating plaintext', async () => {
  const f = await lchOverlayLicenseFixture(),
    keys = await validateLCHOverlayLicense(f.input),
    reader = new LCHReader(f.storage)
  expect(keys).toEqual(f.asset.keys)
  expect(await reader.decrypt(f.terms.inspected, keys)).toEqual(f.plaintext)
  expect(f.license.body.critical).not.toContain(LCH_OVERLAY_PROFILES.standingOffer)
})

it('rejects genuinely signed wrong recipients, overgrants, rights periods and request/settlement bindings', async () => {
  const f = await lchOverlayLicenseFixture(),
    wrong = new Uint8Array(32),
    changes: Record<string, LCHValue>[] = [
      { subject: f.seller.identityKey },
      { requestId: wrong },
      { offerId: wrong },
      { assetId: wrong },
      { selection: { type: 'range', start: 0, end: 1 } },
      { notAfter: 100 },
      { issuedAt: 20 },
      { issuedAt: 23 },
      { keyGrants: [] },
      { extra: true },
      {
        fulfillments: [
          {
            dutyUid: 'urn:other',
            settlementProfile: LCH_OVERLAY_PROFILES.collectorSettlement,
            receiptIds: [wrong]
          }
        ]
      },
      {
        extensions: {
          [LCH_OVERLAY_PROFILES.acquisition]: {
            version: 1,
            mode: 'paid-lookup',
            settlementId: wrong
          },
          [LCH_OVERLAY_PROFILES.collectorSettlement]: { version: 1 }
        }
      },
      {
        critical: [
          LCH_OVERLAY_PROFILES.acquisition,
          LCH_OVERLAY_PROFILES.collectorSettlement,
          'urn:unknown'
        ]
      }
    ]
  for (const change of changes) {
    const license = await signObject('license', { ...f.license.body, ...change }, f.seller)
    await expect(
      validateLCHOverlayLicense({ ...f.input, context: { ...f.context, license } })
    ).rejects.toThrow()
  }
  await expect(validateLCHOverlayLicense({ ...f.input, mode: 'paid-lookup' })).rejects.toThrow()
})

it('requires exact selected typed evidence and cannot widen a paid or covenant mode', async () => {
  const f = await lchOverlayLicenseFixture()
  await expect(
    validateLCHOverlayLicense({ ...f.input, context: { ...f.context, evidence: [] } })
  ).rejects.toThrow('incomplete')
  await expect(validateLCHOverlayLicense({ ...f.input, mode: 'unknown' as never })).rejects.toThrow(
    'Unsupported License'
  )
  await expect(
    validateLCHOverlayLicense({
      ...f.input,
      current: () => {
        throw new Error('Owner closed')
      }
    })
  ).rejects.toThrow('Owner closed')
  const grants = f.license.body.keyGrants as Record<string, LCHValue>[],
    wrongGrant = { ...grants[0], delivery: 'urn:other' },
    license = await signObject(
      'license',
      { ...f.license.body, keyGrants: [wrongGrant, ...grants.slice(1)] },
      f.seller
    )
  await expect(
    validateLCHOverlayLicense({ ...f.input, context: { ...f.context, license } })
  ).rejects.toThrow('key grant')
})

it('checks separately delegated License issuance and key release at their retained role times', async () => {
  const f = await lchOverlayLicenseFixture(),
    issuer = await WalletBRC77Signer.create({ wallet: new ProtoWallet(new PrivateKey(85)) }),
    releaserWallet = new ProtoWallet(new PrivateKey(86)),
    releaser = await WalletBRC77Signer.create({ wallet: releaserWallet }),
    paths: LCHOverlayAuthorityPath[] = []
  for (const [actor, capability] of [
    [issuer.identityKey, 'https://bsv.brc.dev/apps/0170#issueLicense'],
    [releaser.identityKey, 'https://bsv.brc.dev/apps/0170#releaseKey']
  ] as const) {
    const authority = await signObject(
      'authority',
      {
        version: 1,
        assetId: f.asset.assetId,
        grantor: f.seller.identityKey,
        grantee: actor,
        interests: ['sound-recording'],
        capabilities: [capability],
        policyActions: [f.terms.policy.action],
        usageProfiles: [f.offer.body.usageProfile],
        notBefore: 1,
        notAfter: 100,
        mayDelegate: false,
        revocationOutpoint: 'a1'.repeat(32) + '.' + paths.length,
        revocationMaxAgeSeconds: 10,
        nonce: new Uint8Array(16).fill(paths.length + 1)
      },
      f.seller
    )
    paths.push({
      controller: f.seller.identityKey,
      actor,
      interest: 'sound-recording',
      capability,
      chain: [authority]
    })
  }
  const offer = await signObject(
      'offer',
      {
        ...f.offer.body,
        licenseIssuer: issuer.identityKey,
        authorityIds: await Promise.all(
          paths.map(path => objectId('authority', path.chain[0].body))
        )
      },
      f.seller
    ),
    selected = await f.requestFor(f.buyer, offer),
    published = await f.publisher.publish(f.asset, [
      { mode: 'inline', offer: offer as unknown as LCHValue }
    ]),
    terms = await validateLCHOverlayCovenantTerms({
      reader: new LCHReader(f.storage),
      header: published.bytes,
      offer,
      request: selected.requestBytes,
      prepare: selected.prepare,
      descriptor: { ...f.descriptor, termsDigest: selected.prepare.termsDigest },
      selection: f.selection,
      installedMechanisms: new Set(LCH_OVERLAY_COVENANT_MECHANISMS)
    })
  const delivery = new WalletBRC78KeyDelivery(releaserWallet),
    keyGrants: KeyGrant[] = []
  for (const [key, cek] of f.asset.keys) {
    const keyId = Uint8Array.from(Utils.toArray(key, 'hex'))
    keyGrants.push({
      keyId,
      delivery: 'https://bsv.brc.dev/apps/0170#brc78-key-v1',
      payload: await delivery.deliver(selected.prepare.recipient, keyId, cek)
    })
  }
  const license = await signObject(
      'license',
      {
        ...f.license.body,
        issuer: issuer.identityKey,
        offerId: await objectId('offer', offer.body),
        requestId: await objectId('license-request', selected.request.body),
        keyGrants: keyGrants as unknown as LCHValue
      },
      issuer
    ),
    assessments: string[] = [],
    input = {
      ...f.input,
      terms,
      paths,
      requestId: selected.prepare.requestId,
      context: {
        ...f.context,
        license,
        evidence: [
          { type: 'offer' as const, object: offer },
          ...paths.map(path => ({ type: 'authority' as const, object: path.chain[0] }))
        ]
      },
      revocations: {
        at: (time: string) => {
          assessments.push(time)
          return {
            status: () =>
              Promise.resolve({
                status: 'unspent' as const,
                network: 'testnet' as const,
                observedAt: BigInt(time)
              })
          }
        }
      }
    }
  expect(await validateLCHOverlayLicense(input)).toEqual(f.asset.keys)
  expect(assessments).toContain('20')
  expect(assessments).toContain('22')
  await expect(validateLCHOverlayLicense({ ...input, paths: paths.slice(0, 1) })).rejects.toThrow()
  await expect(validateLCHOverlayLicense({ ...input, revocations: undefined })).rejects.toThrow(
    'No revocation-status'
  )
  await expect(
    validateLCHOverlayLicense({
      ...input,
      revocations: {
        at: () => ({
          status: () =>
            Promise.resolve({
              status: 'spent' as const,
              network: 'testnet' as const,
              observedAt: 22n
            })
        })
      }
    })
  ).rejects.toThrow()
})
