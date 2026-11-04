import { afterEach, expect, it, jest } from '@jest/globals'
import {
  Beef,
  canonicalOutputJSON,
  outputPacketDigest,
  OutputProtocolError,
  PrivateKey,
  signOutputPacket,
  Transaction,
  Utils
} from '@bsv/sdk'
import { RevenueListingProfilePurchaseVerifier } from '../src/revenue-listing/RevenueListingProfilePurchaseVerifier.js'
import { RevenueListingProfileLineageVerifier } from '../src/revenue-listing/RevenueListingProfileLineageVerifier.js'
import { chains, context, fixture, profile, purchased } from './revenue-profile.fixture.js'

function preparation() {
  const acquisition = structuredClone(fixture.acquisitions[0])
  return {
    purchase: { txid: acquisition.submit.txid, outputIndex: 0, beef: acquisition.submit.beef },
    original: {
      request: acquisition.prepare,
      terms: acquisition.terms,
      seller: fixture.descriptor.seller
    },
    prepared: acquisition.lineage
  }
}
type Original = ReturnType<typeof preparation>['original']
function resign(original: Original, scalar = fixture.testActors.seller.scalar) {
  const { request } = original
  const body = {
    ...original.terms.body,
    listing: request.listing,
    seller: original.seller,
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
  original.terms = signOutputPacket('purchase-terms', body, new PrivateKey(scalar))
}
afterEach(() => {
  jest.restoreAllMocks()
})

it('refuses a signed preparation whose predecessor history already contains the submitted purchase', async () => {
  const f = preparation(),
    retained = purchased()
  f.original.request.listing = retained.target
  f.original.terms.body.domainEvidence.bytes = Utils.toBase64(
    new TextEncoder().encode(canonicalOutputJSON(retained))
  )
  resign(f.original)
  expect(
    await new RevenueListingProfilePurchaseVerifier(profile, chains).verify(
      f.purchase,
      f.original,
      context()
    )
  ).toEqual({
    status: 'invalid',
    dependencies: [],
    reason: 'Purchase already appears in predecessor history'
  })
})

it.each(['predecessor', 'index', 'value', 'program', 'absent-output'] as const)(
  'binds actual purchase bytes to the prepared listing and mandatory outputs: %s',
  field => {
    const f = preparation(),
      part = Beef.fromBinaryStrict(Utils.toArray(f.purchase.beef, 'base64')),
      original = part.findTxid(f.purchase.txid)!.tx!,
      transaction = Transaction.fromHex(original.toHex())
    if (field === 'predecessor') transaction.inputs[0].sourceTXID = transaction.inputs[1].sourceTXID
    else if (field === 'index') transaction.inputs[0].sourceOutputIndex++
    else if (field === 'value') transaction.outputs[0].satoshis!++
    else if (field === 'program')
      transaction.outputs[0].lockingScript = transaction.outputs[2].lockingScript
    else transaction.outputs.splice(0)
    const txid = part.mergeRawTx(transaction.toBinary()).txid
    f.purchase.txid = txid
    f.purchase.beef = Utils.toBase64(part.toBinaryAtomic(txid))
    // These are complete, independently re-identified raw negative inputs.
    // No altered transaction is asserted to have valid Script or chain evidence.
    return expect(
      new RevenueListingProfilePurchaseVerifier(profile, chains).verify(
        f.purchase,
        f.original,
        context()
      )
    ).resolves.toEqual({
      status: 'invalid',
      dependencies: [],
      reason:
        field === 'predecessor' || field === 'index'
          ? 'Purchase consumed another prepared listing'
          : 'Purchase successor increment/state or recipient-bound receipt differs'
    })
  }
)

it('cancels before reading untrusted preparation or purchase objects', async () => {
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
    await new RevenueListingProfilePurchaseVerifier(profile, chains).verify(
      inaccessible,
      inaccessible as never,
      context(),
      stop.signal
    )
  ).toEqual({ status: 'cancelled', dependencies: [] })
})

it.each(['listing', 'index', 'chain-view', 'seller', 'asset', 'terms'] as const)(
  'binds signed preparation %s before chain I/O',
  async field => {
    const f = preparation(),
      snapshot = context()
    if (field === 'listing') f.original.request.listing.txid = '01'.repeat(32)
    if (field === 'index') f.original.request.listing.outputIndex = 1
    if (field === 'chain-view') snapshot.view.chain.network = 'another-network'
    if (field === 'seller') f.original.seller = new PrivateKey(47950).toPublicKey().toString()
    if (field === 'asset') f.original.request.assetId = '46'.repeat(32)
    if (field === 'terms') f.original.request.termsDigest = '47'.repeat(32)
    resign(f.original, field === 'seller' ? 47950 : fixture.testActors.seller.scalar)
    const resolve = jest
      .fn<typeof chains.resolve>()
      .mockRejectedValue(new Error('Unexpected chain I/O'))
    expect(
      await new RevenueListingProfilePurchaseVerifier(profile, { resolve }).verify(
        f.purchase,
        f.original,
        snapshot
      )
    ).toEqual({
      status: 'invalid',
      dependencies: [],
      reason: 'Prepared listing, chain, seller, asset or terms differ'
    })
    expect(resolve).not.toHaveBeenCalled()
  }
)

it.each(['domainProfile', 'schema', 'jcs', 'index', 'binary'] as const)(
  'preserves bounded diagnostics for altered %s',
  async field => {
    const f = preparation()
    if (field === 'domainProfile') f.original.terms.body.domainProfile = 'urn:unsupported:profile'
    if (field === 'schema') f.original.terms.body.domainEvidence.schema = 'urn:unsupported:schema'
    if (field === 'jcs')
      f.original.terms.body.domainEvidence.bytes = Utils.toBase64(
        new TextEncoder().encode(' ' + canonicalOutputJSON(f.prepared))
      )
    if (field === 'index') f.purchase.outputIndex = 1
    if (field === 'binary') f.purchase.beef = 'AA=='
    resign(f.original)
    const resolve = jest
      .fn<typeof chains.resolve>()
      .mockRejectedValue(new Error('Unexpected chain I/O'))
    expect(
      await new RevenueListingProfilePurchaseVerifier(profile, { resolve }).verify(
        f.purchase,
        f.original,
        context()
      )
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
    expect(resolve).not.toHaveBeenCalled()
  }
)

it.each(['bytes', 'transactions', 'dependencies'] as const)(
  'retains the smaller caller %s budget',
  async key => {
    const f = preparation(),
      snapshot = context()
    snapshot.limits[key] = 1
    const resolve = jest
      .fn<typeof chains.resolve>()
      .mockRejectedValue(new Error('Unexpected chain I/O'))
    const result = await new RevenueListingProfilePurchaseVerifier(profile, { resolve }).verify(
      f.purchase,
      f.original,
      snapshot
    )
    expect(result.status).toBe('limited')
    if (result.status === 'verified') throw new Error('Unexpected purchase verification')
    expect(result.dependencies).toEqual([])
    expect(resolve).not.toHaveBeenCalled()
  }
)

it.each(['lock', 'decode', 'resolve'] as const)(
  'refuses replaced installed %s before purchase work',
  async field => {
    const f = preparation(),
      family = { lock: profile.lock.bind(profile), decode: profile.decode.bind(profile) },
      resolver = { resolve: chains.resolve.bind(chains) }
    const verifier = new RevenueListingProfilePurchaseVerifier(family as typeof profile, resolver)
    if (field === 'resolve') resolver.resolve = chains.resolve.bind(chains)
    else if (field === 'lock') family.lock = profile.lock.bind(profile)
    else family.decode = profile.decode.bind(profile)
    expect(await verifier.verify(f.purchase, f.original, context())).toEqual({
      status: 'context-changed',
      dependencies: [],
      reason: 'Installed listing family changed'
    })
  }
)

it.each(['empty', 'txid-only', 'other-atomic-target'] as const)(
  'refuses %s purchase BEEF before adopting it',
  async kind => {
    const f = preparation()
    let bytes: number[]
    if (kind === 'other-atomic-target') {
      bytes = Utils.toArray(f.purchase.beef, 'base64')
      bytes.splice(4, 32, ...Utils.toArray(f.prepared.target.txid, 'hex').reverse())
    } else {
      const part = new Beef()
      if (kind === 'txid-only') part.mergeTxidOnly(f.purchase.txid)
      bytes = part.toBinary()
    }
    f.purchase.beef = Utils.toBase64(bytes)
    expect(
      await new RevenueListingProfilePurchaseVerifier(profile, chains).verify(
        f.purchase,
        f.original,
        context()
      )
    ).toEqual({ status: 'invalid', dependencies: [], reason: 'Purchase BEEF target differs' })
  }
)

it('accepts complete plain purchase BEEF selected by explicit transaction identity', async () => {
  const f = preparation(),
    bytes = Beef.fromBinaryStrict(Utils.toArray(f.purchase.beef, 'base64')).toBinary()
  expect(Beef.fromBinaryStrict(bytes).atomicTxid).toBeUndefined()
  f.purchase.beef = Utils.toBase64(bytes)
  const result = await new RevenueListingProfilePurchaseVerifier(profile, chains).verify(
    f.purchase,
    f.original,
    context()
  )
  expect(result.status).toBe('verified')
  if (result.status !== 'verified') throw new Error(result.status)
  expect(result.successor).toEqual({ ...f.prepared.target, txid: f.purchase.txid, outputIndex: 0 })
  expect(result.previousSatoshis).toBe('1')
  expect(result.increment).toBe(f.prepared.descriptor.purchasePrice)
})

it.each([
  ['cancelled', 'cancelled'],
  ['context-changed', 'context-changed'],
  ['limited', 'limited'],
  ['invalid', 'invalid'],
  ['unavailable', 'invalid']
] as const)(
  'keeps dependency failure %s distinct and bounds its diagnostic',
  async (code, status) => {
    const message = 'Synthetic dependency failure. '.repeat(40)
    jest
      .spyOn(RevenueListingProfileLineageVerifier.prototype, 'verify')
      .mockRejectedValue(new OutputProtocolError(code, message))
    const f = preparation()
    expect(
      await new RevenueListingProfilePurchaseVerifier(profile, chains).verify(
        f.purchase,
        f.original,
        context()
      )
    ).toEqual({ status, dependencies: [], reason: message.slice(0, 512) })
  }
)

it('does not adopt a foreign error code as a purchase verdict', async () => {
  jest
    .spyOn(RevenueListingProfileLineageVerifier.prototype, 'verify')
    .mockRejectedValue(Object.assign(new Error('Synthetic failure'), { code: 'limited' }))
  const f = preparation()
  expect(
    await new RevenueListingProfilePurchaseVerifier(profile, chains).verify(
      f.purchase,
      f.original,
      context()
    )
  ).toEqual({ status: 'invalid', dependencies: [], reason: 'Purchase representation is invalid' })
})
