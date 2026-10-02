import { expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet, canonicalOutputJSON } from '@bsv/sdk'
import {
  decodeDeterministicCbor,
  encodeDeterministicCbor,
  PublicBRC77Verifier,
  signObject,
  verifySignedObject,
  WalletBRC77Signer,
  type LCHValue,
  type SignedObject
} from '../src/index.js'
import {
  decodeLCHCollectorRevenue,
  decodeLCHOverlayBinding,
  decodeLCHOverlayJSON,
  decodeUnverifiedLCHOverlayContext,
  encodeLCHOverlayContext,
  type UnverifiedLCHOverlayContext
} from '../src/overlayAcquisition.js'

const json = (value: unknown) => new TextEncoder().encode(canonicalOutputJSON(value))
const seller = new PrivateKey(91).toPublicKey().toString()
const key = Uint8Array.from(seller.match(/../g)!, byte => Number.parseInt(byte, 16))
function binding(mode = 'paid-lookup') {
  return {
    version: 1,
    mode,
    seller: key,
    service: 'catalogue',
    endpoint: 'https://seller.example/api',
    chain: { network: 'fixture', genesisHash: new Uint8Array(32).fill(9) }
  }
}
function context(): UnverifiedLCHOverlayContext {
  return {
    version: 1,
    license: { body: { version: 1 }, signatures: [Uint8Array.of(1)] },
    evidence: [],
    settlement: json({ version: 1 }),
    paymentEvidence: json({ version: 1 })
  }
}
it('keeps the canonical base path and exact chain bytes while separating paid and covenant fields', () => {
  expect(decodeLCHOverlayBinding(binding())).toEqual(binding())
  expect(() =>
    decodeLCHOverlayBinding({
      ...binding(),
      lineageAnchor: { txid: new Uint8Array(32), outputIndex: 0 }
    })
  ).toThrow('cannot carry covenant')
  expect(() => decodeLCHOverlayBinding(binding('listing-covenant'))).toThrow()
  expect(() =>
    decodeLCHOverlayBinding({ ...binding(), endpoint: 'https://seller.example/api/' })
  ).toThrow('canonical HTTPS')
  expect(() => decodeLCHOverlayBinding({ ...binding(), extra: true })).toThrow('unknown fields')
  expect(() => decodeLCHOverlayBinding({ ...binding(), seller: new Uint8Array(33) })).toThrow(
    'seller'
  )
})
it('retains a covenant anchor and exact JCS release policy, with no digest substitution', () => {
  const releasePolicy = json({ kind: 'mined', confirmations: 1 }),
    value = {
      ...binding('listing-covenant'),
      lineageAnchor: { txid: new Uint8Array(32).fill(3), outputIndex: 4294967295 },
      releasePolicy
    }
  expect(decodeLCHOverlayBinding(value).releasePolicy).toEqual(releasePolicy)
  expect(() =>
    decodeLCHOverlayBinding({
      ...value,
      lineageAnchor: { ...value.lineageAnchor, outputIndex: 4294967296 }
    })
  ).toThrow('bounds')
  expect(() => decodeLCHOverlayBinding({ ...value, releasePolicy: new Uint8Array(32) })).toThrow()
})
it.each([' {"version":1}', '{"b":2,"a":1}', '{"version":1.0}', '\ufeff{"version":1}'])(
  'rejects non-JCS spelling %s without normalizing it into evidence',
  value => {
    expect(() => decodeLCHOverlayJSON(new TextEncoder().encode(value))).toThrow()
  }
)
it('reuses the executable family state constraints for exact collector schedules', () => {
  const value = {
    version: 1,
    family: 'https://bsv.brc.dev/tokens/0197#revenue-listing-v1',
    initialRevenue: { revision: 0, recipients: [{ identity: key, weight: 3 }] },
    amendment: 'unanimous-current-recipients',
    remainders: 'retain-until-payout',
    retirement: 'externally-funded-exact-top-up'
  }
  expect(decodeLCHCollectorRevenue(value)).toEqual({
    revision: '0',
    recipients: [{ identity: seller, weight: 3 }]
  })
  expect(() => decodeLCHCollectorRevenue({ ...value, amendment: 'seller-only' })).toThrow('rules')
  expect(() =>
    decodeLCHCollectorRevenue({
      ...value,
      initialRevenue: { ...value.initialRevenue, revision: 1 }
    })
  ).toThrow('revenue')
  expect(() =>
    decodeLCHCollectorRevenue({
      ...value,
      initialRevenue: { revision: 0, recipients: [{ identity: key, weight: 0 }] }
    })
  ).toThrow('weight')
  expect(() =>
    decodeLCHCollectorRevenue({
      ...value,
      initialRevenue: {
        revision: 0,
        recipients: [
          { identity: key, weight: 3 },
          { identity: key, weight: 3 }
        ]
      }
    })
  ).toThrow('unique')
})
it('round-trips complete signed CBOR bytes and leaves cryptographic authentication explicit', async () => {
  const signer = await WalletBRC77Signer.create({
      wallet: new ProtoWallet(new PrivateKey(91)),
      random: length => new Uint8Array(length).fill(91)
    }),
    offer = await signObject('offer', { version: 1, nonce: new Uint8Array(16).fill(1) }, signer),
    value = { ...context(), evidence: [{ type: 'offer' as const, object: offer }] },
    wire = await encodeLCHOverlayContext(value, 'paid-lookup'),
    decoded = await decodeUnverifiedLCHOverlayContext(wire, 'paid-lookup')
  expect(decoded.evidence[0].object).toEqual(offer)
  expect(encodeDeterministicCbor(decodeDeterministicCbor(wire))).toEqual(wire)
  await verifySignedObject('offer', decoded.evidence[0].object, new PublicBRC77Verifier(), key)
  await expect(
    verifySignedObject('license', decoded.license, new PublicBRC77Verifier(), key)
  ).rejects.toThrow()
  decoded.evidence[0].object.body.nonce = new Uint8Array(16).fill(2)
  expect(offer.body.nonce).toEqual(new Uint8Array(16).fill(1))
  expect(await decodeUnverifiedLCHOverlayContext(wire, 'paid-lookup')).toEqual(value)
})
it('rejects unknown evidence domains, unsigned envelopes and both mode-specific payloads', async () => {
  const malformed = [
    { ...context(), evidence: [{ type: 'header', object: context().license }] },
    { ...context(), license: { body: { version: 1 }, signatures: [] } },
    { ...context(), purchaseEvidence: json({ version: 1 }) }
  ]
  for (const value of malformed)
    await expect(
      decodeUnverifiedLCHOverlayContext(
        encodeDeterministicCbor(value as unknown as LCHValue),
        'paid-lookup'
      )
    ).rejects.toThrow()
  const covenant = { ...context(), purchaseEvidence: json({ version: 1 }) }
  delete (covenant as Partial<UnverifiedLCHOverlayContext>).paymentEvidence
  await expect(encodeLCHOverlayContext(covenant, 'listing-covenant')).resolves.toBeInstanceOf(
    Uint8Array
  )
})
it('rejects a duplicate body ID even when signatures differ and does not sort received evidence', async () => {
  const first: SignedObject = { body: { version: 1 }, signatures: [Uint8Array.of(1)] },
    second: SignedObject = { body: { version: 1 }, signatures: [Uint8Array.of(2)] }
  await expect(
    encodeLCHOverlayContext(
      {
        ...context(),
        evidence: [
          { type: 'offer', object: first },
          { type: 'offer', object: second }
        ]
      },
      'paid-lookup'
    )
  ).rejects.toThrow('sorted and unique')
  await expect(
    encodeLCHOverlayContext(
      {
        ...context(),
        evidence: [
          { type: 'offer', object: first },
          { type: 'authority', object: first }
        ]
      },
      'paid-lookup'
    )
  ).rejects.toThrow('sorted and unique')
})
it('enforces byte, object and aggregate signature limits before authentication', async () => {
  const signed = {
      body: { version: 1 },
      signatures: Array.from({ length: 64 }, () => Uint8Array.of(1))
    },
    value: UnverifiedLCHOverlayContext = {
      ...context(),
      license: signed,
      evidence: [
        { type: 'authority', object: signed },
        { type: 'offer', object: signed },
        { type: 'payment-authorization', object: signed }
      ]
    }
  await expect(encodeLCHOverlayContext(value, 'paid-lookup')).resolves.toBeInstanceOf(Uint8Array)
  await expect(
    encodeLCHOverlayContext(
      { ...value, evidence: [...value.evidence, { type: 'payment-delivery-ack', object: signed }] },
      'paid-lookup'
    )
  ).rejects.toThrow('signature budget')
  await expect(
    decodeUnverifiedLCHOverlayContext(new Uint8Array(2097153), 'paid-lookup')
  ).rejects.toThrow('byte bound')
  await expect(
    encodeLCHOverlayContext(
      {
        ...context(),
        evidence: Array.from({ length: 129 }, () => ({ type: 'offer', object: context().license }))
      },
      'paid-lookup'
    )
  ).rejects.toThrow('oversized')
})

it('accepts the specified exact 2 MiB context boundary and rejects one extra encoded byte', async () => {
  const value = context(),
    name = 'urn:test:bounded-context-padding'
  value.license.body.extensions = { [name]: new Uint8Array(2096000) }
  const measured = encodeDeterministicCbor(value as unknown as LCHValue).length,
    exact = 2096000 + 2097152 - measured
  value.license.body.extensions[name] = new Uint8Array(exact)
  const wire = await encodeLCHOverlayContext(value, 'paid-lookup')
  expect(wire).toHaveLength(2097152)
  expect((await decodeUnverifiedLCHOverlayContext(wire, 'paid-lookup')).version).toBe(1)
  value.license.body.extensions[name] = new Uint8Array(exact + 1)
  await expect(encodeLCHOverlayContext(value, 'paid-lookup')).rejects.toThrow('byte bound')
})
