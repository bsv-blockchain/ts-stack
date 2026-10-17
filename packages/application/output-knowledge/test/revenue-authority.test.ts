import { expect, it, jest } from '@jest/globals'
import {
  Curve,
  Hash,
  PrivateKey,
  TransactionSignature,
  Utils,
  signOutputPacket,
  verifyOutputPacket
} from '@bsv/sdk'
import type { RevenueListingSigningRequest } from '@bsv/sdk/script/templates/RevenueListingSpend'
import {
  RevenueListingAuthority,
  createSoftwareRevenueListingAuthority,
  type RevenueListingAuthorityPort
} from '../src/revenue-listing/RevenueListingAuthority.js'
import { executeListingInput } from '../src/revenue-listing/LineageGraph.js'
import { parseRevenueListingLineagePackage } from '../src/revenue-listing/LineagePackage.js'
import { completeGenesis, lineage } from './revenue-lineage-fixture.js'
import { authorityFixture, changedAuthorityRequest } from './revenue-authority-fixture.js'

const keys = [41, 42, 43].map(value => new PrivateKey(value))
function transactionSignature(request: RevenueListingSigningRequest, key = keys[0]): string {
  const raw = key.sign(request.data)
  return Utils.toHex(new TransactionSignature(raw.r, raw.s, 65).toChecksigFormat())
}
function port(overrides: Partial<RevenueListingAuthorityPort> = {}): RevenueListingAuthorityPort {
  return {
    identity: keys[0].toPublicKey().toString(),
    signTransaction: request => Promise.resolve(transactionSignature(request)),
    signGenesis: body => Promise.resolve(signOutputPacket('sale-genesis', body, keys[0]).signature),
    ...overrides
  }
}

it.each(['purchase', 'split', 'merge', 'payout', 'amend-all-consent', 'retire'])(
  'uses dedicated authorities with one seller identity for genesis and %s',
  async name => {
    const authorities = keys.map(createSoftwareRevenueListingAuthority)
    const packet = completeGenesis()
    packet.genesis = await authorities[0].signGenesis(
      packet.descriptor,
      packet.genesis.body.genesis
    )
    expect(verifyOutputPacket('sale-genesis', packet.genesis, packet.descriptor.seller)).toBe(true)
    expect(parseRevenueListingLineagePackage(packet)).toEqual(packet)
    const { transaction, spend, prepared, assembly } = authorityFixture(name)
    const signatures: { seller?: string; recipients: string[] }[] = spend
      .plan()
      .inputs.map(() => ({ recipients: [] }))
    for (const request of prepared.signingRequests()) {
      const signer = authorities.find(authority => authority.identity === request.identity)!
      const signed = await signer.signTransaction(request)
      if (request.role === 'seller') signatures[request.inputIndex].seller = signed
      else signatures[request.inputIndex].recipients.push(signed)
    }
    const complete = prepared.complete(signatures)
    expect(complete.toHex()).toBe(transaction.toHex())
    const inputs = spend.plan().inputs.map((_, index) => index)
    for (const index of inputs)
      expect(() =>
        executeListingInput(assembly, { transaction: complete, inputs }, index, 134217728)
      ).not.toThrow()
    if (name === 'amend-all-consent') expect(prepared.signingRequests()).toHaveLength(3)
    if (name === 'merge') expect(prepared.signingRequests()).toHaveLength(2)
  },
  30000
)

it('owns the software key and rejects invalid key and port identities', async () => {
  const key = new PrivateKey(41),
    authority = createSoftwareRevenueListingAuthority(key)
  key.iaddn(1)
  expect(authority.identity).toBe(lineage.descriptor.seller)
  expect(await authority.signTransaction(authorityFixture().prepared.signingRequests()[0])).toBe(
    transactionSignature(authorityFixture().prepared.signingRequests()[0])
  )
  for (const key of [undefined, 41, new PrivateKey(0)])
    expect(() => createSoftwareRevenueListingAuthority(key as PrivateKey)).toThrow()
  expect(() => new RevenueListingAuthority(port({ identity: 'wrong' }))).toThrow()
})

it.each([
  (request: any) => {
    request.extra = true
  },
  (request: any) => {
    request.inputIndex = -1
  },
  (request: any) => {
    request.inputIndex = 2
  },
  (request: any) => {
    request.identity = keys[1].toPublicKey().toString()
  },
  (request: any) => {
    request.role = 'buyer'
  },
  (request: any) => {
    request.scope = 193
  },
  (request: any) => {
    request.preimage.pop()
  },
  (request: any) => {
    request.preimage.push(0)
  },
  (request: any) => {
    request.data.pop()
  },
  (request: any) => {
    request.data = new Uint8Array(request.data)
  },
  (request: any) => {
    request.preimage[0] = 256
  },
  (request: any) => {
    request.preimage[0] = -1
  },
  (request: any) => {
    request.preimage[0] = '1'
  },
  (request: any) => {
    request.preimage[0] = 1.5
  },
  (request: any) => {
    delete request.preimage[0]
  },
  (request: any) => {
    Object.defineProperty(request.preimage, '0', { value: 1, enumerable: false })
  },
  (request: any) => {
    request.data[0] ^= 1
  },
  (request: any) => {
    request.preimage[request.preimage.length - 1] = 1
    request.data = Hash.sha256(request.preimage)
  }
])('rejects malformed signing requests before invoking the authority %#', async change => {
  const sign = jest.fn(port().signTransaction)
  const authority = new RevenueListingAuthority(port({ signTransaction: sign }))
  const request = authorityFixture().prepared.signingRequests()[0]
  change(request)
  await expect(authority.signTransaction(request)).rejects.toThrow()
  expect(sign).not.toHaveBeenCalled()
})

it('rejects byte accessors without invoking them', async () => {
  const getter = jest.fn(() => 1),
    request = authorityFixture().prepared.signingRequests()[0]
  Object.defineProperty(request.preimage, '0', { get: getter })
  await expect(new RevenueListingAuthority(port()).signTransaction(request)).rejects.toThrow()
  expect(getter).not.toHaveBeenCalled()
})

it('reports malformed authority fields at their boundary and supplies the complete approved request', async () => {
  const original = authorityFixture().prepared.signingRequests()[0]
  const sign = jest.fn(port().signTransaction)
  await new RevenueListingAuthority(port({ signTransaction: sign })).signTransaction(original)
  expect(sign).toHaveBeenCalledWith(original)
  const cases: [Partial<RevenueListingSigningRequest>, string][] = [
    [{ inputIndex: 2 }, 'Invalid listing authority input index'],
    [{ identity: keys[1].toPublicKey().toString() }, 'Listing authority identity mismatch'],
    [{ role: 'unknown' as 'seller' }, 'Invalid authority role'],
    [{ scope: 193 as 65 }, 'Listing authority requires ALL|FORKID'],
    [{ data: [] }, 'Invalid authority bytes'],
    [{ data: Array.from({ length: 32 }, () => 0) }, 'Listing authority preimage mismatch']
  ]
  for (const [change, reason] of cases)
    await expect(
      new RevenueListingAuthority(port()).signTransaction({ ...original, ...change })
    ).rejects.toThrow(reason)
  for (const byte of [-1, 256, 0.5, null, '1']) {
    const changed = structuredClone(original)
    changed.preimage[0] = byte as number
    await expect(new RevenueListingAuthority(port()).signTransaction(changed)).rejects.toThrow(
      'Invalid authority byte'
    )
  }
  const hole = structuredClone(original)
  delete hole.preimage[0]
  await expect(new RevenueListingAuthority(port()).signTransaction(hole)).rejects.toThrow(
    'Invalid authority byte field'
  )
  for (const invalid of [undefined, 41])
    expect(() => createSoftwareRevenueListingAuthority(invalid as unknown as PrivateKey)).toThrow(
      'Expected a dedicated authority private key'
    )
  expect(() => createSoftwareRevenueListingAuthority(new PrivateKey(0))).toThrow(
    'Authority private key must be nonzero'
  )
  const outOfRange = new PrivateKey(1)
  outOfRange.iadd(new Curve().n)
  expect(() => createSoftwareRevenueListingAuthority(outOfRange)).toThrow()
})

it('distinguishes malformed signature encoding from a well-formed unauthorized signature', async () => {
  const request = authorityFixture().prepared.signingRequests()[0],
    valid = transactionSignature(request)
  for (const signature of [
    undefined,
    '',
    '00'.repeat(73),
    '00'.repeat(8),
    valid.slice(1),
    valid.toUpperCase(),
    'z' + valid.slice(1),
    valid.slice(0, -1) + 'z'
  ]) {
    const authority = new RevenueListingAuthority(
      port({ signTransaction: () => Promise.resolve(signature as string) })
    )
    await expect(authority.signTransaction(request)).rejects.toThrow(
      'Invalid authority transaction signature'
    )
  }
  // Shortest strict-DER positive scalars are syntactically valid but unauthorized.
  const shortest = '300602010102010141'
  await expect(
    new RevenueListingAuthority(
      port({ signTransaction: () => Promise.resolve(shortest) })
    ).signTransaction(request)
  ).rejects.toThrow('retained input')
})

it('checks exact retained requests after an asynchronous signer mutates its arguments', async () => {
  const original = authorityFixture().prepared.signingRequests()[0]
  const expected = transactionSignature(original)
  const authority = new RevenueListingAuthority(
    port({
      signTransaction: async request => {
        await Promise.resolve()
        request.data.fill(0)
        request.preimage.fill(0)
        original.data.fill(0)
        original.preimage.fill(0)
        return expected
      }
    })
  )
  expect(await authority.signTransaction(original)).toBe(expected)
  const changed = new RevenueListingAuthority(
    port({
      signTransaction: async request => {
        await Promise.resolve()
        request.data.fill(0)
        return transactionSignature(request)
      }
    })
  )
  await expect(
    changed.signTransaction(authorityFixture().prepared.signingRequests()[0])
  ).rejects.toThrow('retained input')
})

it('rejects malformed, wrong-scope, high-S and unrelated transaction signatures', async () => {
  const request = authorityFixture().prepared.signingRequests()[0]
  const valid = transactionSignature(request)
  const raw = keys[0].sign(request.data)
  const high = Utils.toHex(
    new TransactionSignature(raw.r, new Curve().n.sub(raw.s), 65).toChecksigFormat()
  )
  for (const signature of [
    undefined,
    '',
    '00'.repeat(73),
    '00'.repeat(8),
    valid.slice(1),
    valid.toUpperCase(),
    valid.slice(0, -2) + 'c1',
    high,
    transactionSignature(request, keys[1]),
    transactionSignature(changedAuthorityRequest()),
    '00'.repeat(71)
  ]) {
    const authority = new RevenueListingAuthority(
      port({ signTransaction: () => Promise.resolve(signature as string) })
    )
    await expect(authority.signTransaction(request)).rejects.toThrow()
  }
})

it('binds genesis to the selected seller, chain, descriptor and output zero before signing', async () => {
  const sign = jest.fn(port().signGenesis),
    authority = new RevenueListingAuthority(port({ signGenesis: sign }))
  const genesis = lineage.genesis.body.genesis
  await expect(
    authority.signGenesis(
      { ...lineage.descriptor, seller: keys[1].toPublicKey().toString() },
      genesis
    )
  ).rejects.toThrow('seller authority')
  await expect(
    authority.signGenesis(lineage.descriptor, { ...genesis, outputIndex: 1 })
  ).rejects.toThrow('listing profile')
  await expect(
    authority.signGenesis(lineage.descriptor, {
      ...genesis,
      chain: { ...genesis.chain, network: 'elsewhere' }
    })
  ).rejects.toThrow('listing profile')
  expect(sign).not.toHaveBeenCalled()
})

it('owns both sides of asynchronous genesis signing and rejects altered or unrelated envelopes', async () => {
  const descriptor = structuredClone(lineage.descriptor),
    genesis = structuredClone(lineage.genesis.body.genesis)
  const authority = new RevenueListingAuthority(
    port({
      signGenesis: async body => {
        const signature = signOutputPacket('sale-genesis', body, keys[0]).signature
        await Promise.resolve()
        body.genesis.chain.network = 'changed'
        body.genesis.txid = 'ff'.repeat(32)
        descriptor.metadataDigest = 'ee'.repeat(32)
        genesis.chain.network = 'changed'
        return signature
      }
    })
  )
  const result = await authority.signGenesis(descriptor, genesis)
  expect(result.body).toEqual(lineage.genesis.body)
  for (const signGenesis of [
    (body: typeof result.body) =>
      Promise.resolve(signOutputPacket('sale-genesis', body, keys[1]).signature),
    (body: typeof result.body) =>
      Promise.resolve(
        signOutputPacket('sale-genesis', { ...body, listingId: 'ff'.repeat(32) }, keys[0]).signature
      ),
    () => Promise.resolve('AA==')
  ])
    await expect(
      new RevenueListingAuthority(port({ signGenesis })).signGenesis(
        lineage.descriptor,
        lineage.genesis.body.genesis
      )
    ).rejects.toThrow()
})
