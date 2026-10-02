import { expect, it } from '@jest/globals'
import {
  canonicalOutputJSON,
  MerklePath,
  outputPacketDigest,
  PrivateKey,
  signOutputPacket,
  Utils
} from '@bsv/sdk'
import { RevenueListingPurchaseVerifier } from '../src/revenue-listing/RevenueListingPurchaseVerifier.js'
import { RevenueListing } from '@bsv/sdk/script/templates/RevenueListing'
import { atListing, chains, context, family, minedChain } from './revenue-lineage-fixture.js'
import { purchaseFixture, transactionEvidence } from './revenue-purchase.fixture.js'

it('verifies a real funded BRC-196 receipt and every covenant back to the authorized genesis', async () => {
  const f = await purchaseFixture(),
    result = await new RevenueListingPurchaseVerifier(family, chains).verify(
      f.purchase,
      f.original,
      context()
    )
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error(result.status)
  expect(result.predecessor).toEqual(f.prepared.target)
  expect(result.successor).toEqual({ ...f.prepared.target, txid: f.purchase.txid })
  expect(result.previousSatoshis).toBe(f.prepared.descriptor.reserve)
  expect(result.increment).toBe(f.prepared.descriptor.purchasePrice)
  expect(BigInt(result.lineage.satoshis)).toBe(
    BigInt(result.previousSatoshis) + BigInt(result.increment)
  )
  expect(result.lineage.state).toEqual(f.prepared.descriptor.initialRevenue)
  expect(result.terms).toEqual(f.original.terms)
  f.original.request.requestId = 'caller-mutated'
  expect(result.request.requestId).toBe('fixture-purchase-196')
}, 30000)

it.each(['recipient', 'acquisitionId', 'requestDigest'] as const)(
  'refuses a Script-valid purchase with another prepared %s',
  async field => {
    const f = await purchaseFixture(),
      original = structuredClone(f.original)
    if (field === 'recipient')
      original.request.recipient = new PrivateKey(45).toPublicKey().toString()
    else if (field === 'acquisitionId') original.request.requestId = 'another-valid-purchase'
    else original.request.request = 'AQ=='
    const body = { ...original.terms.body }
    // Recreate completely valid seller terms for the new request. The actual
    // purchased receipt belongs to the first preparation and remains Script-valid.
    body.recipient = original.request.recipient
    body.acquisitionId = outputPacketDigest('purchase', {
      chain: original.request.listing.chain,
      seller: original.seller,
      recipient: original.request.recipient,
      topic: original.request.topic,
      requestId: original.request.requestId
    })
    body.requestDigest = outputPacketDigest('purchase-request', original.request)
    original.terms = signOutputPacket('purchase-terms', body, new PrivateKey(41))
    expect(
      (
        await new RevenueListingPurchaseVerifier(family, chains).verify(
          f.purchase,
          original,
          context()
        )
      ).status
    ).toBe('invalid')
    expect(
      (
        await new RevenueListingPurchaseVerifier(family, chains).verify(
          f.purchase,
          f.original,
          context()
        )
      ).status
    ).toBe('verified')
  },
  30000
)

it.each(['domainProfile', 'schema', 'seller', 'lineage', 'chain'])(
  'refuses altered prepared %s before chain I/O',
  async field => {
    const f = await purchaseFixture(),
      original = structuredClone(f.original)
    if (field === 'domainProfile') original.terms.body.domainProfile = 'urn:unsupported:domain'
    if (field === 'schema') original.terms.body.domainEvidence.schema = 'urn:unsupported:schema'
    if (field === 'seller') original.seller = new PrivateKey(45).toPublicKey().toString()
    if (field === 'lineage') {
      const changed = structuredClone(f.prepared)
      changed.target.txid = '01'.repeat(32)
      original.terms.body.domainEvidence.bytes = Utils.toBase64(
        new TextEncoder().encode(canonicalOutputJSON(changed))
      )
    }
    if (field === 'chain') original.terms.body.listing.chain.network = 'different'
    original.terms = signOutputPacket('purchase-terms', original.terms.body, new PrivateKey(41))
    let calls = 0
    const verifier = new RevenueListingPurchaseVerifier(family, {
      async resolve() {
        calls++
        throw new Error('Unexpected chain I/O')
      }
    })
    expect((await verifier.verify(f.purchase, original, context())).status).toBe('invalid')
    expect(calls).toBe(0)
  }
)

it('executes the actual covenant even when a mining proof hides an invalid unlocking preimage', async () => {
  const f = await purchaseFixture()
  f.completed.inputs[0].unlockingScript!.chunks[0].data![0] ^= 1
  const txid = f.completed.id('hex')
  f.completed.merklePath = new MerklePath(1, [[{ offset: 0, hash: txid, txid: true }]])
  const mined = minedChain(txid)
  expect(
    (
      await new RevenueListingPurchaseVerifier(family, mined.chains).verify(
        transactionEvidence(f),
        f.original,
        mined.context
      )
    ).status
  ).toBe('invalid')
}, 30000)

it('retains missing declared ancestry even when complete purchase BEEF contains its incidental raw bytes', async () => {
  const f = await purchaseFixture(atListing('amend-all-consent')),
    incomplete = structuredClone(f.prepared)
  incomplete.transactions = incomplete.transactions.filter(
    entry => entry.txid !== incomplete.genesis.body.genesis.txid
  )
  const original = structuredClone(f.original)
  original.terms.body.domainEvidence.bytes = Utils.toBase64(
    new TextEncoder().encode(canonicalOutputJSON(incomplete))
  )
  original.terms = signOutputPacket('purchase-terms', original.terms.body, new PrivateKey(41))
  const result = await new RevenueListingPurchaseVerifier(family, chains).verify(
    f.purchase,
    original,
    context()
  )
  expect(result.status).toBe('unresolved')
  if (result.status === 'verified') throw new Error('Unexpected ancestry verdict')
  expect(result.dependencies).toContainEqual(incomplete.genesis.body.genesis)
  expect(
    (
      await new RevenueListingPurchaseVerifier(family, chains).verify(
        f.purchase,
        f.original,
        context()
      )
    ).status
  ).toBe('verified')
}, 60000)

it('preserves cancellation and caller/installed work limits', async () => {
  const f = await purchaseFixture(),
    cancelled = new AbortController()
  cancelled.abort()
  expect(
    (
      await new RevenueListingPurchaseVerifier(family, chains).verify(
        f.purchase,
        f.original,
        context(),
        cancelled.signal
      )
    ).status
  ).toBe('cancelled')
  expect(
    (
      await new RevenueListingPurchaseVerifier(family, chains, { listingTransactions: 1 }).verify(
        f.purchase,
        f.original,
        context()
      )
    ).status
  ).toBe('limited')
  const small = context()
  small.limits.bytes = 1024
  expect(
    (await new RevenueListingPurchaseVerifier(family, chains).verify(f.purchase, f.original, small))
      .status
  ).toBe('limited')
})

it('refuses a successor evidence index or alternate BEEF target without adopting it', async () => {
  const f = await purchaseFixture(),
    verifier = new RevenueListingPurchaseVerifier(family, chains)
  expect(
    (await verifier.verify({ ...f.purchase, outputIndex: 1 }, f.original, context())).status
  ).toBe('invalid')
  expect(
    (await verifier.verify({ ...f.purchase, txid: f.prepared.target.txid }, f.original, context()))
      .status
  ).toBe('invalid')
})

it('requires exact JCS prepared-history bytes rather than silently normalizing another signed representation', async () => {
  const f = await purchaseFixture(),
    original = structuredClone(f.original)
  original.terms.body.domainEvidence.bytes = Utils.toBase64(
    new TextEncoder().encode(' ' + canonicalOutputJSON(f.prepared))
  )
  original.terms = signOutputPacket('purchase-terms', original.terms.body, new PrivateKey(41))
  let calls = 0
  const verifier = new RevenueListingPurchaseVerifier(family, {
    async resolve() {
      calls++
      throw new Error('Unexpected chain I/O')
    }
  })
  expect((await verifier.verify(f.purchase, original, context())).status).toBe('invalid')
  expect(calls).toBe(0)
})

it('reports a replaced installed resolver as context-changed after its original physical call drains', async () => {
  const f = await purchaseFixture()
  let entered = () => {},
    release = () => {}
  const entry = new Promise<void>(resolve => {
      entered = resolve
    }),
    gate = new Promise<void>(resolve => {
      release = resolve
    }),
    resolver = {
      async resolve(...args: Parameters<typeof chains.resolve>) {
        entered()
        await gate
        return await chains.resolve(...args)
      }
    },
    verifier = new RevenueListingPurchaseVerifier(family, resolver),
    work = verifier.verify(f.purchase, f.original, context())
  await entry
  resolver.resolve = chains.resolve.bind(chains)
  release()
  expect((await work).status).toBe('context-changed')
}, 30000)

it.each(['lock', 'decode'] as const)(
  'refuses a replaced installed family %s before chain I/O',
  async field => {
    const f = await purchaseFixture(),
      local = new RevenueListing(family.lock(f.prepared.descriptor).toBinary().slice(428))
    let calls = 0
    const verifier = new RevenueListingPurchaseVerifier(local, {
      async resolve() {
        calls++
        throw new Error('Unexpected chain I/O')
      }
    })
    if (field === 'lock') local.lock = local.lock.bind(local)
    else local.decode = local.decode.bind(local)
    expect((await verifier.verify(f.purchase, f.original, context())).status).toBe(
      'context-changed'
    )
    expect(calls).toBe(0)
  }
)

it('refuses malformed binary evidence without replacing the original acquisition', async () => {
  const f = await purchaseFixture(),
    verifier = new RevenueListingPurchaseVerifier(family, chains)
  expect(
    (await verifier.verify({ ...f.purchase, beef: 'AA==' }, f.original, context())).status
  ).toBe('invalid')
  expect((await verifier.verify(f.purchase, f.original, context())).status).toBe('verified')
}, 30000)
