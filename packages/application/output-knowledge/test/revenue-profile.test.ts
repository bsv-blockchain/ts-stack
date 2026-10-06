import { expect, it } from '@jest/globals'
import { Beef, Utils } from '@bsv/sdk'
import { BEEF_V2 } from '@bsv/sdk/transaction/Beef'
import { RevenueListingProfileLineageVerifier } from '../src/revenue-listing/RevenueListingProfileLineageVerifier.js'
import { RevenueListingProfilePurchaseVerifier } from '../src/revenue-listing/RevenueListingProfilePurchaseVerifier.js'
import { parseRevenueListingProfileLineagePackage } from '../src/revenue-listing/ProfileLineagePackage.js'
import { assembleLineage, lineageLimits } from '../src/revenue-listing/LineagePackage.js'
import {
  inspectProfileLineage,
  inspectProfileTransition,
  executeProfileInputs
} from '../src/revenue-listing/ProfileLineageGraph.js'
import {
  atGenesis,
  chains,
  context,
  fixture,
  fixtureDigest,
  profile,
  purchased,
  purchaseTransaction,
  construct,
  extend
} from './revenue-profile.fixture.js'

it('owns the exact immutable descriptor and signed reserve-stage genesis', () => {
  expect(fixtureDigest).toBe('00b456faa8eac95124fbe6fde9ec5d70604fd503d7e486385662e6b1494f26ee')
  const parsed = parseRevenueListingProfileLineagePackage(fixture.acquisitions[0].lineage)
  expect(parsed.descriptor).toEqual(fixture.descriptor)
  parsed.descriptor.initialRevenue.recipients[0].weight = 999
  expect(fixture.descriptor.initialRevenue.recipients[0].weight).toBe(7)
  expect(() =>
    parseRevenueListingProfileLineagePackage({
      ...atGenesis(),
      descriptor: { ...fixture.descriptor, expiryHeight: 0 }
    })
  ).toThrow('expiry')
  expect(() =>
    parseRevenueListingProfileLineagePackage({
      ...atGenesis(),
      descriptor: { ...fixture.descriptor, administration: 'seller-v1' }
    })
  ).toThrow()
})

it('verifies reserve genesis, activation and both successive buyer histories with actual input Scripts', async () => {
  const verifier = new RevenueListingProfileLineageVerifier(profile, chains)
  for (const [packet, stage] of [
    [atGenesis(), 'activation'],
    [fixture.acquisitions[0].lineage, 'active'],
    [purchased(0), 'active'],
    [purchased(1), 'active']
  ] as const) {
    const result = await verifier.verify(packet, context())
    expect(result.status).toBe('verified')
    if (result.status !== 'verified') throw new Error(JSON.stringify(result))
    expect(result.stage).toBe(stage)
    expect(result.genesis).toEqual(packet.genesis)
    expect(result.descriptor).toEqual(fixture.descriptor)
    expect(result.target).toEqual(packet.target)
    expect(result.transactions).toEqual(packet.transactions.map(entry => entry.txid))
  }
}, 60000)

it('returns the independent full purchase commitment only after exact terms and complete lineage verification', async () => {
  const verifier = new RevenueListingProfilePurchaseVerifier(profile, chains)
  for (const acquisition of fixture.acquisitions) {
    const result = await verifier.verify(
      { txid: acquisition.submit.txid, outputIndex: 0, beef: acquisition.submit.beef },
      { request: acquisition.prepare, terms: acquisition.terms, seller: fixture.descriptor.seller },
      context()
    )
    expect(result.status).toBe('verified')
    if (result.status !== 'verified') throw new Error(JSON.stringify(result))
    expect(result.purchaseCommitment).toBe(acquisition.purchaseCommitment)
    expect(result.increment).toBe(fixture.descriptor.purchasePrice)
    expect(result.predecessor).toEqual(acquisition.prepare.listing)
    expect(result.successor.txid).toBe(acquisition.submit.txid)
    expect(result.lineage.stage).toBe('active')
  }
}, 60000)

it('distinguishes absent declared activation ancestry from raw bytes present in another BEEF', async () => {
  const packet = purchased()
  packet.transactions = packet.transactions.filter(
    entry => entry.txid !== packet.genesis.body.genesis.txid
  )
  expect(
    await new RevenueListingProfileLineageVerifier(profile, chains).verify(packet, context())
  ).toEqual({ status: 'unresolved', dependencies: [packet.genesis.body.genesis] })
})

it('requires complete actual funding sources independently of pruned Bitcoin proofs', async () => {
  const packet = purchased()
  packet.transactions = packet.transactions.map(entry => {
    const beef = Beef.fromBinaryStrict(Utils.toArray(entry.beef, 'base64'))
    beef.version = BEEF_V2
    beef.makeTxidOnly(packet.descriptor.lineageAnchor.txid)
    return { txid: entry.txid, beef: Utils.toBase64(beef.toBinaryAtomic(entry.txid)) }
  })
  const result = await new RevenueListingProfileLineageVerifier(profile, chains).verify(
    packet,
    context()
  )
  expect(result.status).toBe('unresolved')
  if (result.status === 'verified') throw new Error('Unexpected verification')
  expect(result.dependencies).toContainEqual(packet.descriptor.lineageAnchor)
})

it('inspects the current family without a canonical fourteen-push ABI dependency', () => {
  const packet = parseRevenueListingProfileLineagePackage(purchased())
  const graph = inspectProfileLineage(assembleLineage(packet, lineageLimits({})), profile)
  expect(graph.complete).toBe(true)
  if (!graph.complete) throw new Error('Incomplete graph')
  expect(graph.transitions.map(item => item.plan?.operation ?? 'genesis')).toEqual([
    'purchase',
    'activate',
    'genesis'
  ])
  expect(graph.stage).toBe('active')
})

it('retains cancellation, deadline, bounded intake and installed-profile fences', async () => {
  const controller = new AbortController()
  controller.abort()
  const verifier = new RevenueListingProfileLineageVerifier(profile, chains)
  expect((await verifier.verify(atGenesis(), context(), controller.signal)).status).toBe(
    'cancelled'
  )
  expect(
    (
      await new RevenueListingProfileLineageVerifier(profile, chains, {
        listingTransactions: 1
      }).verify(purchased(), context())
    ).status
  ).toBe('limited')
  const expired = context()
  expired.now = '1'
  expired.limits.deadline = '2'
  expect((await verifier.verify(atGenesis(), expired)).status).toBe('limited')
  const owned = { lock: profile.lock.bind(profile), decode: profile.decode.bind(profile) }
  const guarded = new RevenueListingProfileLineageVerifier(owned as typeof profile, chains)
  owned.decode = profile.decode.bind(profile)
  expect((await guarded.verify(atGenesis(), context())).status).toBe('context-changed')
})

it('verifies a seller-child split and permissionless payout with both split successors preserved', async () => {
  const split = await construct(
    purchaseTransaction(),
    0,
    { operation: 'split', firstAmount: '501' },
    10,
    3
  )
  const packet = extend(purchased(), split)
  const verifier = new RevenueListingProfileLineageVerifier(profile, chains)
  for (const outputIndex of [0, 1]) {
    const result = await verifier.verify(
      { ...packet, target: { ...packet.target, outputIndex } },
      context()
    )
    expect(result.status).toBe('verified')
    if (result.status !== 'verified') throw new Error(JSON.stringify(result))
    expect(result.satoshis).toBe('501')
    expect(result.stage).toBe('active')
  }
  const payout = await construct(split, 0, { operation: 'payout', units: '49' })
  const result = await verifier.verify(extend(packet, payout), context())
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error(JSON.stringify(result))
  expect(result.satoshis).toBe('11')
}, 60000)

it('executes early-child and unsigned height retirement with exact externally funded top-up', async () => {
  for (const authority of ['seller', 'expiry'] as const) {
    const selected =
      authority === 'seller'
        ? { operation: 'retire' as const, authority }
        : { operation: 'retire' as const, authority, lockHeight: fixture.descriptor.expiryHeight }
    const retired = await construct(purchaseTransaction(), 0, selected)
    const packet = extend(purchased(), retired)
    const assembly = assembleLineage(packet, lineageLimits({}))
    const inspected = inspectProfileTransition(
      assembly.transactions.get(packet.target.txid)!,
      assembly,
      profile
    )
    expect(inspected.plan?.payout).toBe('1010')
    expect(inspected.plan?.retirementTopUp).toBe('8')
    expect(inspected.plan?.receiptIndex).toBe(0)
    expect(() => executeProfileInputs(assembly, inspected.transaction, 134217728)).not.toThrow()
    // This proves Script and economic layout only. The supplied height101
    // view does not claim the unsigned retirement is yet mineable.
    expect(() => inspectProfileLineage(assembly, profile)).toThrow('Not a listing successor')
  }
}, 60000)

it('refuses cancelled, substituted and stale purchase contexts without a verified commitment', async () => {
  const acquisition = fixture.acquisitions[0]
  const evidence = { txid: acquisition.submit.txid, outputIndex: 0, beef: acquisition.submit.beef }
  const original = {
    request: acquisition.prepare,
    terms: acquisition.terms,
    seller: fixture.descriptor.seller
  }
  const verifier = new RevenueListingProfilePurchaseVerifier(profile, chains)
  const stopped = new AbortController()
  stopped.abort()
  expect(await verifier.verify(evidence, original, context(), stopped.signal)).toEqual({
    status: 'cancelled',
    dependencies: []
  })
  for (const changed of [undefined, { ...evidence, outputIndex: 1 }]) {
    const result = await verifier.verify(changed, original, context())
    expect(result.status).toBe('invalid')
    expect(Object.hasOwn(result, 'purchaseCommitment')).toBe(false)
  }
  const alternate = fixture.acquisitions[1]
  expect(
    (
      await verifier.verify(
        evidence,
        { request: alternate.prepare, terms: alternate.terms, seller: original.seller },
        context()
      )
    ).status
  ).toBe('invalid')
  const owned = { lock: profile.lock.bind(profile), decode: profile.decode.bind(profile) }
  const guarded = new RevenueListingProfilePurchaseVerifier(owned as typeof profile, chains)
  owned.decode = profile.decode.bind(profile)
  expect((await guarded.verify(evidence, original, context())).status).toBe('context-changed')
  const unavailable = new RevenueListingProfilePurchaseVerifier(profile, {
    resolve: async () => {
      throw new Error('Unavailable immutable view')
    }
  })
  expect((await unavailable.verify(evidence, original, context())).status).toBe('limited')
  const failing = {
    lock: profile.lock.bind(profile),
    decode: () => {
      throw new Error('Installed decoder unavailable')
    }
  }
  const unclassified = await new RevenueListingProfilePurchaseVerifier(
    failing as unknown as typeof profile,
    chains
  ).verify(evidence, original, context())
  expect(unclassified).toEqual({
    status: 'invalid',
    dependencies: [],
    reason: 'Purchase representation is invalid'
  })
})
