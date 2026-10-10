import { expect, it } from '@jest/globals'
import { outputPacketDigest, Utils } from '@bsv/sdk'
import {
  encodeDeterministicCbor,
  signObject,
  sha256,
  objectId,
  toHex,
  type LCHValue
} from '../src/index.js'
import { LCH_OVERLAY_PROFILES } from '../src/overlayAcquisitionCodec.js'
import {
  validateLCHOverlayPaidTerms,
  validateLCHOverlayPaidWindow
} from '../src/overlayAcquisitionTerms.js'
import {
  createLCHOverlayFixedRenderAgreement,
  validateLCHOverlayFixedRenderAgreement,
  validateLCHOverlayFixedRenderPolicy
} from '../src/overlayAcquisitionPolicy.js'
import { lchOverlayFixture } from './overlay-acquisition.fixture.js'

it('binds actual signed Offer/Request bytes and exact policy, ciphertext and installed mechanisms', async () => {
  const f = await lchOverlayFixture(),
    terms = await validateLCHOverlayPaidTerms(f.input)
  expect(terms.policy.satoshis).toBe(100n)
  expect(terms.requestBytes).toEqual(f.requestBytes)
  const agreement = await createLCHOverlayFixedRenderAgreement(terms.policy)
  await expect(
    validateLCHOverlayFixedRenderAgreement(terms.policy, agreement as never)
  ).resolves.toBeUndefined()
  expect(
    JSON.parse(new TextDecoder().decode(agreement.inline as Uint8Array)).permission[0].duty
  ).toBeUndefined()
  const changed = JSON.parse(new TextDecoder().decode(agreement.inline as Uint8Array))
  changed.prohibition = []
  const inline = new TextEncoder().encode(JSON.stringify(changed))
  await expect(
    validateLCHOverlayFixedRenderAgreement(terms.policy, {
      mediaType: 'application/ld+json',
      inline,
      digest: await sha256(inline)
    })
  ).rejects.toThrow('changed accepted rights')
})
it('rejects a correctly signed Request that did not consent to the original Policy', async () => {
  const f = await lchOverlayFixture(),
    wrong = await signObject(
      'license-request',
      {
        ...f.request.body,
        acceptedPolicyDigest: new Uint8Array(32)
      },
      f.buyer
    )
  await expect(
    validateLCHOverlayPaidTerms({
      ...f.input,
      request: encodeDeterministicCbor(wrong as unknown as LCHValue),
      acquire: {
        ...f.acquire,
        requestId: toHex(await objectId('license-request', wrong.body)),
        request: Utils.toBase64(encodeDeterministicCbor(wrong as unknown as LCHValue))
      }
    })
  ).rejects.toThrow('Accepted Policy differs')
  for (const field of ['assetId', 'termsDigest', 'recipient', 'requestId', 'service'] as const)
    await expect(
      validateLCHOverlayPaidTerms({ ...f.input, acquire: { ...f.acquire, [field]: 'wrong' } })
    ).rejects.toThrow('Outer acquisition differs')
})
it('rejects duplicate decoded policy keys and BOMs even with their correct signed-byte digests', async () => {
  const f = await lchOverlayFixture(),
    terms = await validateLCHOverlayPaidTerms(f.input),
    source = JSON.stringify(f.policy)
  for (const text of [
    source.replace('"assigner":', '"assigner":"urn:unconsented","assigner":'),
    '\ufeff' + source
  ]) {
    const inline = new TextEncoder().encode(text)
    await expect(
      validateLCHOverlayFixedRenderPolicy({
        ...terms.policy,
        reference: { mediaType: 'application/ld+json', inline, digest: await sha256(inline) }
      })
    ).rejects.toThrow('unambiguous JSON')
  }
})
it('refuses missing, duplicate and uninstalled authenticated capability bindings', async () => {
  const f = await lchOverlayFixture()
  for (const extension of [
    undefined,
    { version: 1, bindings: [] },
    {
      version: 1,
      bindings: [
        {
          kind: 'lookup',
          service: 'catalogue',
          mode: 'paid-lookup',
          mechanisms: ['urn:z', 'urn:a']
        }
      ]
    }
  ]) {
    const selection = {
      ...f.selection,
      manifest: {
        ...f.selection.manifest,
        body: {
          ...f.body,
          extensions:
            extension === undefined ? {} : { [LCH_OVERLAY_PROFILES.acquisition]: extension }
        }
      }
    }
    await expect(validateLCHOverlayPaidTerms({ ...f.input, selection })).rejects.toThrow()
  }
  await expect(
    validateLCHOverlayPaidTerms({ ...f.input, installedMechanisms: new Set() })
  ).rejects.toThrow('not installed and advertised')
})
it('rejects unknown prerequisite terms, old shorthand compensation and fractional prices', async () => {
  const f = await lchOverlayFixture(),
    terms = await validateLCHOverlayPaidTerms(f.input)
  const variants = [
    { ...f.policy, permission: [{ ...f.policy.permission[0], constraint: [{ unknown: true }] }] },
    {
      ...f.policy,
      permission: [
        {
          ...f.policy.permission[0],
          duty: [{ uid: 'urn:reference:compensation', action: 'compensate', payAmount: 100 }]
        }
      ]
    },
    { ...f.policy, inheritFrom: 'urn:unknown' }
  ]
  for (const policy of variants) {
    const inline = new TextEncoder().encode(JSON.stringify(policy))
    await expect(
      validateLCHOverlayFixedRenderPolicy({
        ...terms.policy,
        reference: { mediaType: 'application/ld+json', inline, digest: await sha256(inline) }
      })
    ).rejects.toThrow()
  }
  const policy = JSON.parse(JSON.stringify(f.policy))
  policy.permission[0].duty[0].action.refinement[0].rightOperand['@value'] = '100.5'
  const inline = new TextEncoder().encode(JSON.stringify(policy))
  await expect(
    validateLCHOverlayFixedRenderPolicy({
      ...terms.policy,
      reference: { mediaType: 'application/ld+json', inline, digest: await sha256(inline) }
    })
  ).rejects.toThrow('exact unsigned integer')
})
it('checks new-work windows, price, frozen request and the full advertised recovery promise', async () => {
  const f = await lchOverlayFixture(),
    terms = await validateLCHOverlayPaidTerms(f.input),
    challenge = {
      version: 1 as const,
      acquisitionId: outputPacketDigest('acquisition', {
        chain: f.acquire.listing.chain,
        seller: f.body.identity,
        buyer: f.acquire.recipient,
        service: f.acquire.service,
        requestId: f.acquire.requestId
      }),
      requestDigest: outputPacketDigest('acquire-request', f.acquire),
      seller: f.body.identity,
      buyer: f.acquire.recipient,
      assetId: f.acquire.assetId,
      termsDigest: f.acquire.termsDigest,
      satoshis: '100',
      derivationPrefix: 'prefix',
      acceptancePolicy: { kind: 'local-admission' as const },
      rulesDigest: f.selection.service.rulesDigest,
      payableUntil: '100',
      recoveryUntil: '86500'
    }
  expect(() => validateLCHOverlayPaidWindow(terms, challenge, '20', '86400')).not.toThrow()
  expect(() => validateLCHOverlayPaidWindow(terms, challenge, '100', '86400')).toThrow('window')
  for (const change of [
    { satoshis: '101' },
    { payableUntil: '101', recoveryUntil: '86501' },
    { requestDigest: '00'.repeat(32) },
    { recoveryUntil: '86499' }
  ])
    expect(() =>
      validateLCHOverlayPaidWindow(terms, { ...challenge, ...change }, '20', '86400')
    ).toThrow()
  expect(() => validateLCHOverlayPaidWindow(terms, challenge, '20', '172800')).toThrow(
    'recovery promise'
  )
})
