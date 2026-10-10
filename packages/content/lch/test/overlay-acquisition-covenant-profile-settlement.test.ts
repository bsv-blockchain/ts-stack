import { expect, it } from '@jest/globals'
import { outputPacketDigest, signOutputPacket } from '@bsv/sdk'
import {
  bindLCHOverlayCovenantProfileSettlement,
  decodeLCHOverlayCovenantProfilePurchaseEvidence
} from '../src/overlayAcquisitionCovenantProfileSettlement.js'
import { decodeLCHOverlayCovenantPurchaseEvidence } from '../src/overlayAcquisitionCovenantSettlement.js'
import { lchCovenantProfileSettlementFixture } from './overlay-acquisition-covenant-profile-settlement.fixture.js'
import { lchCovenantSettlementFixture } from './overlay-acquisition-covenant-settlement.fixture.js'

it('authenticates exact current consent and complete immutable descriptor without supplying a Bitcoin verdict', async () => {
  const f = await lchCovenantProfileSettlementFixture(),
    bound = bindLCHOverlayCovenantProfileSettlement(
      f.context,
      f.terms,
      f.prepared,
      f.delivered,
      f.txid
    )
  expect(bound.packet).toEqual(f.packet)
  expect(bound.evidence).toEqual(f.evidence)
  expect(bound.evidence.lineage.descriptor.expiryHeight).toBe(1000)
  expect(bound.evidence.lineage.descriptor.initialRevenue).not.toHaveProperty('revision')
  expect(bound.packet.body.listingId).toBe(outputPacketDigest('sale-listing', f.descriptor))
  expect(bound.packet.body.purchaseCommitment).toBe(f.purchaseCommitment)
  // Deliberately invalid Bitcoin is accepted only as bounded representation.
  expect(bound.evidence.purchase.beef).toBe('AA==')
  expect(bound).not.toHaveProperty('checkCurrent')
  const owned = decodeLCHOverlayCovenantProfilePurchaseEvidence(f.json(f.evidence))
  f.evidence.lineage.descriptor.initialRevenue.recipients[0].weight++
  expect(owned.lineage.descriptor.initialRevenue).not.toEqual(
    f.evidence.lineage.descriptor.initialRevenue
  )
})

it('refuses historical descriptors through current evidence and current descriptors through historical evidence', async () => {
  const current = await lchCovenantProfileSettlementFixture(),
    historical = await lchCovenantSettlementFixture()
  expect(() =>
    decodeLCHOverlayCovenantProfilePurchaseEvidence(historical.json(historical.evidence))
  ).toThrow()
  expect(() => decodeLCHOverlayCovenantPurchaseEvidence(current.json(current.evidence))).toThrow()
})

it('does not reuse a seller-authorized different immutable listing as the original accepted acquisition', async () => {
  const f = await lchCovenantProfileSettlementFixture(),
    descriptor = { ...f.descriptor, expiryHeight: f.descriptor.expiryHeight + 1 },
    listingId = outputPacketDigest('sale-listing', descriptor),
    lineage = {
      ...f.lineage,
      descriptor,
      genesis: signOutputPacket(
        'sale-genesis',
        { ...f.lineage.genesis.body, listingId },
        f.sellerKey
      )
    },
    evidence = { ...f.evidence, lineage },
    context = { ...f.context, purchaseEvidence: f.json(evidence) },
    delivered = await f.deliver(context)
  expect(
    decodeLCHOverlayCovenantProfilePurchaseEvidence(f.json(evidence)).lineage.descriptor
  ).toEqual(descriptor)
  expect(() =>
    bindLCHOverlayCovenantProfileSettlement(context, f.terms, f.prepared, delivered, f.txid)
  ).toThrow('exact prepared purchase')
  expect(() =>
    decodeLCHOverlayCovenantProfilePurchaseEvidence(
      f.json({
        ...f.evidence,
        lineage: { ...f.lineage, descriptor }
      })
    )
  ).toThrow('lineage representation')
})

it('retains original purchase, historical release and POTATOES commitments while refusing substituted current settlements', async () => {
  const f = await lchCovenantProfileSettlementFixture()
  await [
    { purchaseCommitment: '00'.repeat(32) },
    { listingId: '00'.repeat(32) },
    { releaseEvidenceDigest: '00'.repeat(32) },
    { recoveryUntil: '1' }
  ].reduce(async (previous, change) => {
    await previous
    const context = {
        ...f.context,
        settlement: f.json(
          signOutputPacket('lch-covenant-settlement', { ...f.body, ...change }, f.sellerKey)
        )
      },
      delivered = await f.deliver(context)
    expect(() =>
      bindLCHOverlayCovenantProfileSettlement(context, f.terms, f.prepared, delivered, f.txid)
    ).toThrow('exact prepared purchase')
  }, Promise.resolve())
  expect(() =>
    bindLCHOverlayCovenantProfileSettlement(
      f.context,
      f.terms,
      f.prepared,
      f.delivered,
      '55'.repeat(32)
    )
  ).toThrow('transaction mismatch')
  expect(() =>
    decodeLCHOverlayCovenantProfilePurchaseEvidence(f.json({ ...f.evidence, extra: true }))
  ).toThrow()
  expect(() =>
    decodeLCHOverlayCovenantProfilePurchaseEvidence(
      f.json({
        ...f.evidence,
        lineage: {
          ...f.lineage,
          transactions: [...f.lineage.transactions, f.lineage.transactions[0]]
        }
      })
    )
  ).toThrow('sorted and unique')
})
