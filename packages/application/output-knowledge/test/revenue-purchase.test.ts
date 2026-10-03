import { expect, it } from '@jest/globals'
import {
  Beef,
  canonicalOutputJSON,
  MerklePath,
  outputPacketDigest,
  OutputProtocolError,
  PrivateKey,
  signOutputPacket,
  Utils
} from '@bsv/sdk'
import { RevenueListingPurchaseVerifier } from '../src/revenue-listing/RevenueListingPurchaseVerifier.js'
import { RevenueListing } from '@bsv/sdk/script/templates/RevenueListing'
import {
  atListing,
  chains,
  context,
  family,
  minedChain,
  plainProvedEvidence,
  purchaseProof
} from './revenue-lineage-fixture.js'
import { purchaseBEEF, purchaseFixture, transactionEvidence } from './revenue-purchase.fixture.js'

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
    await new RevenueListingPurchaseVerifier(family, chains).verify(
      f.purchase,
      f.original,
      context(),
      cancelled.signal
    )
  ).toEqual({ status: 'cancelled', dependencies: [] })
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
    await new RevenueListingPurchaseVerifier(family, chains).verify(f.purchase, f.original, small)
  ).toEqual({ status: 'limited', dependencies: [], reason: 'Decoded byte limit' })
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

function resign(original: Awaited<ReturnType<typeof purchaseFixture>>['original'], key = 41) {
  const request = original.request
  const body = {
    ...original.terms.body,
    seller: original.seller,
    recipient: request.recipient,
    listing: request.listing,
    assetId: request.assetId,
    termsDigest: request.termsDigest,
    requestDigest: outputPacketDigest('purchase-request', request),
    acquisitionId: outputPacketDigest('purchase', {
      chain: request.listing.chain,
      seller: original.seller,
      recipient: request.recipient,
      topic: request.topic,
      requestId: request.requestId
    })
  }
  original.terms = signOutputPacket('purchase-terms', body, new PrivateKey(key))
}

it('cancels before reading any untrusted purchase or preparation representation', async () => {
  const stop = new AbortController()
  stop.abort()
  const inaccessible = new Proxy(
    {},
    {
      ownKeys() {
        throw new Error('Cancelled input was read')
      }
    }
  )
  expect(
    await new RevenueListingPurchaseVerifier(family, chains).verify(
      inaccessible,
      inaccessible as never,
      context(),
      stop.signal
    )
  ).toEqual({ status: 'cancelled', dependencies: [] })
})

it.each(['listing', 'index', 'chain-view', 'seller', 'asset', 'terms'])(
  'identifies a signed %s mismatch before inspecting purchase ancestry',
  async field => {
    const f = await purchaseFixture(),
      original = structuredClone(f.original),
      snapshot = context()
    if (field === 'listing') original.request.listing.txid = '01'.repeat(32)
    if (field === 'index') original.request.listing.outputIndex = 1
    if (field === 'chain-view') snapshot.view.chain.network = 'another-valid-network'
    if (field === 'seller') original.seller = new PrivateKey(45).toPublicKey().toString()
    if (field === 'asset') original.request.assetId = '46'.repeat(32)
    if (field === 'terms') original.request.termsDigest = '47'.repeat(32)
    resign(original, field === 'seller' ? 45 : 41)
    let calls = 0
    const verifier = new RevenueListingPurchaseVerifier(family, {
      async resolve() {
        calls++
        throw new Error('Prepared mismatch must precede ancestry work')
      }
    })
    expect(await verifier.verify(f.purchase, original, snapshot)).toEqual({
      status: 'invalid',
      dependencies: [],
      reason: 'Prepared listing, chain, seller, asset or terms differ'
    })
    expect(calls).toBe(0)
  }
)

it.each(['domainProfile', 'schema', 'jcs', 'index', 'binary'])(
  'preserves a bounded local diagnostic for %s without exposing a wire decision',
  async field => {
    const f = await purchaseFixture(),
      original = structuredClone(f.original)
    let purchase = f.purchase
    if (field === 'domainProfile') original.terms.body.domainProfile = 'urn:unsupported:domain'
    if (field === 'schema') original.terms.body.domainEvidence.schema = 'urn:unsupported:schema'
    if (field === 'jcs')
      original.terms.body.domainEvidence.bytes = Utils.toBase64(
        new TextEncoder().encode(' ' + canonicalOutputJSON(f.prepared))
      )
    if (field === 'index') purchase = { ...purchase, outputIndex: 1 }
    if (field === 'binary') purchase = { ...purchase, beef: 'AA==' }
    resign(original)
    expect(
      await new RevenueListingPurchaseVerifier(family, chains).verify(purchase, original, context())
    ).toEqual({
      status: 'invalid',
      dependencies: [],
      reason: {
        domainProfile: 'Prepared purchase domain differs',
        schema: 'Prepared purchase domain differs',
        jcs: 'Prepared lineage must use exact JCS bytes',
        index: 'Purchase evidence must select successor zero',
        binary: 'Purchase representation is invalid'
      }[field]
    })
  }
)

it('supports complete classic BEEF and refuses empty, txid-only and mislabeled atomic targets', async () => {
  const f = await purchaseFixture(),
    classic = purchaseBEEF(f.purchase).toBinary()
  expect(Beef.fromBinaryStrict(classic).atomicTxid).toBeUndefined()
  expect(Beef.fromBinaryStrict(classic).txs.at(-1)!.txid).toBe(f.purchase.txid)
  const verifier = new RevenueListingPurchaseVerifier(family, chains)
  expect(
    (await verifier.verify({ ...f.purchase, beef: Utils.toBase64(classic) }, f.original, context()))
      .status
  ).toBe('verified')
  const only = new Beef()
  only.mergeTxidOnly(f.purchase.txid)
  const atomic = Utils.toArray(f.purchase.beef, 'base64')
  atomic.splice(4, 32, ...Utils.toArray(f.prepared.target.txid, 'hex').reverse())
  for (const bytes of [new Beef().toBinary(), only.toBinary(), atomic])
    expect(
      await verifier.verify({ ...f.purchase, beef: Utils.toBase64(bytes) }, f.original, context())
    ).toEqual({ status: 'invalid', dependencies: [], reason: 'Purchase BEEF target differs' })
}, 30000)

it('selects a proved purchase by its explicit txid in complete plain BEEF regardless of record order', async () => {
  const f = await purchaseFixture(),
    part = purchaseBEEF(f.purchase),
    tx = part.findTransactionForSigning(f.purchase.txid)!,
    raw = tx.toHex(),
    selected = minedChain(purchaseProof(f.purchase.txid).computeRoot(), 101)
  const bytes = plainProvedEvidence(part, f.purchase.txid),
    parsed = Beef.fromBinaryStrict(bytes)
  expect(parsed.atomicTxid).toBeUndefined()
  expect(parsed.txs.at(-1)!.txid).not.toBe(f.purchase.txid)
  expect(parsed.findTransactionForSigning(f.purchase.txid)!.toHex()).toBe(raw)
  const verifier = new RevenueListingPurchaseVerifier(family, selected.chains)
  expect(
    (
      await verifier.verify(
        { ...f.purchase, beef: Utils.toBase64(bytes) },
        f.original,
        selected.context
      )
    ).status
  ).toBe('verified')
  expect(
    await verifier.verify(
      { ...f.purchase, txid: 'aa'.repeat(32), beef: Utils.toBase64(bytes) },
      f.original,
      selected.context
    )
  ).toEqual({ status: 'invalid', dependencies: [], reason: 'Purchase BEEF target differs' })
}, 30000)

it('refuses a purchase already included in the signed predecessor package', async () => {
  const f = await purchaseFixture(),
    original = structuredClone(f.original)
  const prepared = {
    ...f.prepared,
    transactions: [
      ...f.prepared.transactions,
      { txid: f.purchase.txid, beef: f.purchase.beef }
    ].sort((a, b) => a.txid.localeCompare(b.txid, 'en'))
  }
  original.terms.body.domainEvidence.bytes = Utils.toBase64(
    new TextEncoder().encode(canonicalOutputJSON(prepared))
  )
  resign(original)
  expect(
    await new RevenueListingPurchaseVerifier(family, chains).verify(f.purchase, original, context())
  ).toEqual({
    status: 'invalid',
    dependencies: [],
    reason: 'Purchase already appears in predecessor history'
  })
})

it.each(['transactions', 'dependencies'] as const)(
  'enforces the caller %s ceiling before chain verification',
  async field => {
    const f = await purchaseFixture(),
      snapshot = context()
    snapshot.limits[field] = 1
    let calls = 0
    const verifier = new RevenueListingPurchaseVerifier(family, {
      async resolve() {
        calls++
        throw new Error('Dependency budget must precede chain work')
      }
    })
    expect(await verifier.verify(f.purchase, f.original, snapshot)).toEqual({
      status: 'limited',
      dependencies: [],
      reason: 'Lineage dependency limit'
    })
    expect(calls).toBe(0)
  }
)

it.each(['one-input', 'admin-route', 'predecessor-index', 'amount', 'script'])(
  'identifies an invalid purchase %s before Bitcoin/chain work',
  async field => {
    const f = await purchaseFixture()
    if (field === 'one-input') f.completed.inputs.splice(1)
    if (field === 'admin-route') f.completed.inputs[0].unlockingScript!.chunks[2].op = 0x52
    if (field === 'predecessor-index') f.completed.inputs[0].sourceOutputIndex = 1
    if (field === 'amount') f.completed.outputs[0].satoshis!--
    if (field === 'script')
      f.completed.outputs[1].lockingScript = f.completed.outputs[0].lockingScript
    const result = await new RevenueListingPurchaseVerifier(family, chains).verify(
      transactionEvidence(f),
      f.original,
      context()
    )
    expect(result).toEqual({
      status: 'invalid',
      dependencies: [],
      reason: {
        'one-input': 'Listing dimensions exceed profile',
        'admin-route': 'Administrative transition is not a purchase',
        'predecessor-index': 'Purchase consumed another prepared listing',
        amount: 'Purchase successor increment/state or recipient-bound receipt differs',
        script: 'Purchase successor increment/state or recipient-bound receipt differs'
      }[field]
    })
  }
)

it('refuses unavailable raw predecessor evidence before constructing a purchase plan', async () => {
  const f = await purchaseFixture(),
    original = structuredClone(f.original)
  const prepared = { ...f.prepared, target: { ...f.prepared.target, txid: '01'.repeat(32) } }
  original.request.listing = prepared.target
  original.terms.body.domainEvidence.bytes = Utils.toBase64(
    new TextEncoder().encode(canonicalOutputJSON(prepared))
  )
  resign(original)
  expect(
    await new RevenueListingPurchaseVerifier(family, chains).verify(f.purchase, original, context())
  ).toEqual({
    status: 'invalid',
    dependencies: [],
    reason: 'Purchase/predecessor raw evidence is unavailable'
  })
})

it('preserves installed-decoder cancellation as a qualified negative outcome', async () => {
  const f = await purchaseFixture(),
    local = new RevenueListing(family.lock(f.prepared.descriptor).toBinary().slice(428))
  local.decode = () => {
    throw new OutputProtocolError('cancelled', 'Installed family operation cancelled')
  }
  expect(
    await new RevenueListingPurchaseVerifier(local, chains).verify(
      f.purchase,
      f.original,
      context()
    )
  ).toEqual({
    status: 'cancelled',
    dependencies: [],
    reason: 'Installed family operation cancelled'
  })
})
