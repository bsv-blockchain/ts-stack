import { expect, it } from '@jest/globals'
import { canonicalOutputJSON, PrivateKey, signOutputPacket, Utils } from '@bsv/sdk'
import {
  bindLCHOverlayCovenantSettlement,
  decodeLCHCovenantSettlement,
  decodeLCHOverlayCovenantPurchaseEvidence,
  type LCHCovenantSettlementBody
} from '../src/overlayAcquisitionCovenantSettlement.js'
import { lchCovenantSettlementFixture } from './overlay-acquisition-covenant-settlement.fixture.js'

it('authenticates all frozen commitments without treating signature success as Bitcoin truth', async () => {
  const f = await lchCovenantSettlementFixture(),
    bound = bindLCHOverlayCovenantSettlement(f.context, f.terms, f.prepared, f.delivered, f.txid)
  expect(bound.packet).toEqual(f.packet)
  expect(bound.evidence).toEqual(f.evidence)
  expect(bound.delivered).toEqual(f.delivered)
  expect(bound.id).toHaveLength(64)
  // These bytes are intentionally invalid Bitcoin. This binding stage returns
  // evidence, never a Script/release/License verdict or a plaintext capability.
  expect(bound.evidence.purchase.beef).toBe('AA==')
})

it('refuses every substituted signed settlement commitment', async () => {
  const f = await lchCovenantSettlementFixture(),
    changes: Partial<LCHCovenantSettlementBody>[] = [
      { buyer: f.descriptor.seller },
      { requestId: '00'.repeat(32) },
      { offerId: '00'.repeat(32) },
      { assetId: '00'.repeat(32) },
      { dutyUid: 'urn:other' },
      { acquisitionId: '00'.repeat(32) },
      { listingId: '00'.repeat(32) },
      { previous: f.body.successor },
      { successor: { ...f.body.successor, outputIndex: 1 } },
      { txid: '00'.repeat(32) },
      { satoshis: '101' },
      { releasePolicy: { kind: 'mined', confirmations: 1 } },
      { releaseEvidenceDigest: '00'.repeat(32) },
      { issuedAt: '19' },
      { issuedAt: '23' },
      { recoveryUntil: '172901' }
    ]
  for (const change of changes) {
    const packet = signOutputPacket(
        'lch-covenant-settlement',
        { ...f.body, ...change },
        f.sellerKey
      ),
      context = { ...f.context, settlement: f.json(packet) },
      delivered = await f.deliver(context)
    expect(() =>
      bindLCHOverlayCovenantSettlement(context, f.terms, f.prepared, delivered, f.txid)
    ).toThrow('exact prepared purchase')
  }
})

it('requires the exact outer context, POTATOES signature and selected transaction', async () => {
  const f = await lchCovenantSettlementFixture(),
    changed = {
      ...f.context,
      settlement: f.json(
        signOutputPacket('lch-covenant-settlement', { ...f.body, issuedAt: '20' }, f.sellerKey)
      )
    }
  expect(() =>
    bindLCHOverlayCovenantSettlement(changed, f.terms, f.prepared, f.delivered, f.txid)
  ).toThrow('signed POTATOES')
  expect(() =>
    bindLCHOverlayCovenantSettlement(f.context, f.terms, f.prepared, f.delivered, '55'.repeat(32))
  ).toThrow('transaction mismatch')
  const delivered = JSON.parse(canonicalOutputJSON(f.delivered))
  delivered.result.potatoes.signature = f.packet.signature
  expect(() =>
    bindLCHOverlayCovenantSettlement(f.context, f.terms, f.prepared, delivered, f.txid)
  ).toThrow('signature failed')
  expect(() =>
    bindLCHOverlayCovenantSettlement(
      f.context,
      f.terms,
      f.prepared,
      {
        result: {
          version: 1,
          status: 'prepared',
          acquisitionId: f.prepared.body.acquisitionId,
          recoveryUntil: f.prepared.body.recoveryUntil
        }
      },
      f.txid
    )
  ).toThrow('Complete covenant')
})

it('requires matching complete prepared evidence, successor zero and historical release', async () => {
  const f = await lchCovenantSettlementFixture()
  for (const evidence of [
    { ...f.evidence, terms: f.signedTerms() },
    { ...f.evidence, purchase: { ...f.evidence.purchase, txid: '55'.repeat(32) } },
    { ...f.evidence, purchase: { ...f.evidence.purchase, outputIndex: 1 } },
    { ...f.evidence, release: { ...f.release, acceptedAt: '19' } },
    { ...f.evidence, lineage: { ...f.lineage, target: f.lineage.genesis.body.genesis } }
  ]) {
    const context = { ...f.context, purchaseEvidence: f.json(evidence) }
    expect(() =>
      bindLCHOverlayCovenantSettlement(context, f.terms, f.prepared, f.delivered, f.txid)
    ).toThrow('signed POTATOES')
    const delivered = await f.deliver(context)
    expect(() =>
      bindLCHOverlayCovenantSettlement(context, f.terms, f.prepared, delivered, f.txid)
    ).toThrow('exact prepared purchase')
  }
  const alien = { ...f.terms, descriptor: { ...f.descriptor, metadataDigest: '00'.repeat(32) } }
  alien.descriptor.metadataDigest = '55'.repeat(32)
  expect(() =>
    bindLCHOverlayCovenantSettlement(f.context, alien, f.prepared, f.delivered, f.txid)
  ).toThrow('exact prepared purchase')
})

it('rejects noncanonical, open, wrongly signed and malformed representations', async () => {
  const f = await lchCovenantSettlementFixture()
  for (const value of [
    { ...f.packet, extra: true },
    { ...f.packet, body: { ...f.body, extra: true } },
    { ...f.packet, body: { ...f.body, version: 2 } },
    { ...f.packet, signature: 1 },
    signOutputPacket('lch-covenant-settlement', f.body, new PrivateKey(99)),
    signOutputPacket('lch-lookup-settlement', f.body, f.sellerKey),
    signOutputPacket(
      'lch-covenant-settlement',
      { ...f.body, seller: f.prepare.recipient },
      f.sellerKey
    )
  ])
    expect(() => decodeLCHCovenantSettlement(f.json(value), f.descriptor.seller)).toThrow()
  expect(() =>
    decodeLCHCovenantSettlement(
      new TextEncoder().encode(JSON.stringify(f.packet, null, 2)),
      f.descriptor.seller
    )
  ).toThrow('JCS')
  for (const evidence of [
    { ...f.evidence, version: 2 },
    { ...f.evidence, extra: true },
    { ...f.evidence, lineage: { ...f.lineage, version: 2 } },
    { ...f.evidence, lineage: { ...f.lineage, transactions: [] } },
    {
      ...f.evidence,
      lineage: {
        ...f.lineage,
        transactions: [f.lineage.transactions[0], f.lineage.transactions[0]]
      }
    },
    {
      ...f.evidence,
      lineage: { ...f.lineage, transactions: Array(257).fill(f.lineage.transactions[0]) }
    },
    {
      ...f.evidence,
      lineage: { ...f.lineage, genesis: { ...f.lineage.genesis, signature: 'AA==' } }
    },
    {
      ...f.evidence,
      lineage: {
        ...f.lineage,
        target: {
          ...f.lineage.target,
          chain: { ...f.lineage.target.chain, genesisHash: '55'.repeat(32) }
        }
      }
    }
  ])
    expect(() => decodeLCHOverlayCovenantPurchaseEvidence(f.json(evidence))).toThrow()
  const value = decodeLCHOverlayCovenantPurchaseEvidence(f.context.purchaseEvidence!)
  expect(Utils.toBase64(f.json(value))).toBe(Utils.toBase64(f.context.purchaseEvidence!))
})
