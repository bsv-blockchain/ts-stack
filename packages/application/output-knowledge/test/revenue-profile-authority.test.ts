import { expect, it, jest } from '@jest/globals'
import {
  Curve,
  PrivateKey,
  ProtoWallet,
  PublicKey,
  TransactionSignature,
  Utils,
  verifyOutputPacket
} from '@bsv/sdk'
import { revenueListingChildPublicKey } from '@bsv/sdk/script/templates/RevenueListingKeys'
import { RevenueListingProfileAuthority } from '../src/revenue-listing/RevenueListingProfileAuthority.js'
import { fixture } from './revenue-profile.fixture.js'
import { profileAuthorityFixture } from './revenue-profile-authority.fixture.js'

type AlteredRequest = Record<string, unknown> & { data: number[]; preimage: number[] }

it('signs the exact current split with the protected child and uses a distinct BRC77 child for genesis', async () => {
  const f = await profileAuthorityFixture(),
    authority = await RevenueListingProfileAuthority.create(f.options)
  const signed = await authority.signTransaction(f.request),
    parsed = TransactionSignature.fromChecksigFormat(Utils.toArray(signed, 'hex'))
  expect(parsed.scope).toBe(65)
  expect(parsed.hasLowS()).toBe(true)
  expect(
    parsed.verify(
      f.request.data,
      PublicKey.fromString(revenueListingChildPublicKey(authority.identity))
    )
  ).toBe(true)
  expect(parsed.verify(f.request.data, PublicKey.fromString(authority.identity))).toBe(false)
  expect(f.prepared.complete({ seller: signed }).inputs[0].unlockingScript?.toHex()).toBe(
    f.funded.inputs[0].unlockingScript?.toHex()
  )
  expect(f.calls[1].args).toEqual({
    protocolID: [2, '3241645161d8'],
    keyID: 'brc197 authority',
    counterparty: 'anyone',
    data: f.request.data
  })
  expect(f.calls.map(call => call.originator)).toEqual([
    'current-authority.local',
    'current-authority.local'
  ])
  const genesis = await authority.signGenesis(fixture.descriptor, fixture.genesis.body.genesis)
  expect(verifyOutputPacket('sale-genesis', genesis, fixture.descriptor.seller)).toBe(true)
  expect(genesis.body).toEqual(fixture.genesis.body)
  expect(f.calls[2].args.protocolID).toEqual([2, 'message signing'])
  expect(f.calls[2].args.keyID).not.toBe('brc197 authority')
  expect(f.calls[2].args.counterparty).toBe('anyone')
})

it('rejects wrong identity or counterparty-derived key before returning an authority', async () => {
  const f = await profileAuthorityFixture()
  await expect(
    RevenueListingProfileAuthority.create({
      ...f.options,
      identity: new PrivateKey(99).toPublicKey().toString()
    })
  ).rejects.toThrow('identity changed')
  const getPublicKey = f.wallet.getPublicKey.bind(f.wallet)
  await expect(
    RevenueListingProfileAuthority.create({
      ...f.options,
      wallet: {
        ...f.options.wallet,
        getPublicKey: args => getPublicKey({ ...args, forSelf: false })
      }
    })
  ).rejects.toThrow('fixed listing child')
  expect(f.calls).toHaveLength(0)
})

it('refuses changed synchronous authority before any protected signing effect', async () => {
  const f = await profileAuthorityFixture(),
    authority = await RevenueListingProfileAuthority.create(f.options)
  f.deny()
  await expect(authority.signTransaction(f.request)).rejects.toThrow('Changed protected authority')
  await expect(
    authority.signGenesis(fixture.descriptor, fixture.genesis.body.genesis)
  ).rejects.toThrow('Changed protected authority')
  expect(f.calls).toHaveLength(1)
})

it('owns approved bytes across an asynchronous signer and verifies its returned signature', async () => {
  const f = await profileAuthorityFixture(),
    expected = structuredClone(f.request)
  const authority = await RevenueListingProfileAuthority.create(f.options)
  f.setSigner(async args => {
    f.request.preimage.fill(0)
    f.request.data.fill(0)
    return f.wallet.createSignature(args)
  })
  const signed = await authority.signTransaction(f.request)
  expect(
    TransactionSignature.fromChecksigFormat(Utils.toArray(signed, 'hex')).verify(
      expected.data,
      PublicKey.fromString(expected.publicKey)
    )
  ).toBe(true)
})

it('rejects a wrong protected signer or altered returned DER rather than returning unchecked signatures', async () => {
  const f = await profileAuthorityFixture(),
    other = new ProtoWallet(new PrivateKey(99))
  const authority = await RevenueListingProfileAuthority.create(f.options)
  f.setSigner(args => other.createSignature(args))
  await expect(authority.signTransaction(f.request)).rejects.toThrow()
  await expect(
    authority.signGenesis(fixture.descriptor, fixture.genesis.body.genesis)
  ).rejects.toThrow()
})

it.each([
  (r: AlteredRequest) => {
    r.inputIndex = 1
  },
  (r: AlteredRequest) => {
    r.role = 'recipient'
  },
  (r: AlteredRequest) => {
    r.publicKey = fixture.descriptor.seller
  },
  (r: AlteredRequest) => {
    r.scope = 193
  },
  (r: AlteredRequest) => {
    r.protocolID = [2, 'other']
  },
  (r: AlteredRequest) => {
    r.keyID = 'different'
  },
  (r: AlteredRequest) => {
    r.counterparty = 'self'
  },
  (r: AlteredRequest) => {
    r.extra = true
  },
  (r: AlteredRequest) => {
    r.data[0] ^= 1
  },
  (r: AlteredRequest) => {
    r.preimage.pop()
  },
  (r: AlteredRequest) => {
    r.preimage[104] = 0
  },
  (r: AlteredRequest) => {
    r.preimage[828] ^= 1
  },
  (r: AlteredRequest) => {
    delete r.data[0]
  }
])(
  'rejects altered fixed-profile signing input before the protected wallet is called %#',
  async change => {
    const f = await profileAuthorityFixture(),
      authority = await RevenueListingProfileAuthority.create(f.options)
    const request = { ...f.request }
    change(request)
    await expect(authority.signTransaction(request)).rejects.toThrow()
    expect(f.calls).toHaveLength(1)
  }
)

it('rejects byte accessors without invoking application-controlled getters', async () => {
  const f = await profileAuthorityFixture(),
    authority = await RevenueListingProfileAuthority.create(f.options),
    getter = jest.fn(() => 1)
  Object.defineProperty(f.request.preimage, '0', { enumerable: true, get: getter })
  await expect(authority.signTransaction(f.request)).rejects.toThrow()
  expect(getter).not.toHaveBeenCalled()
  expect(f.calls).toHaveLength(1)
})

it('rejects unsupported actual child signing during preflight, before an authority is usable', async () => {
  const f = await profileAuthorityFixture(),
    other = new ProtoWallet(new PrivateKey(99))
  f.setSigner(args => other.createSignature(args))
  await expect(RevenueListingProfileAuthority.create(f.options)).rejects.toThrow(
    'retained funded input'
  )
  expect(f.calls).toHaveLength(1)
})

it('refuses disclosure when the installed fence changes while protected signing awaits', async () => {
  const f = await profileAuthorityFixture(),
    authority = await RevenueListingProfileAuthority.create(f.options)
  f.setSigner(async args => {
    const result = await f.wallet.createSignature(args)
    f.deny()
    return result
  })
  await expect(authority.signTransaction(f.request)).rejects.toThrow('Changed protected authority')
})

it.each(
  [
    [] as number[],
    Array<number>(73).fill(0),
    [48, 6, 2, 1, 0, 2, 1, 0],
    Array<number>(8).fill(256)
  ].map(signature => ({ signature }))
)(
  'rejects malformed returned protected DER before signature disclosure %#',
  async ({ signature }) => {
    const f = await profileAuthorityFixture(),
      authority = await RevenueListingProfileAuthority.create(f.options)
    f.setSigner(() => Promise.resolve({ signature }))
    await expect(authority.signTransaction(f.request)).rejects.toThrow()
    await expect(
      authority.signGenesis(fixture.descriptor, fixture.genesis.body.genesis)
    ).rejects.toThrow()
    expect(f.calls).toHaveLength(3)
  }
)

it('requires an installed explicit originator and checks identity on every signing operation', async () => {
  const f = await profileAuthorityFixture()
  await expect(
    RevenueListingProfileAuthority.create({ ...f.options, originator: '' })
  ).rejects.toThrow()
  expect(f.calls).toHaveLength(0)
  const getPublicKey = f.wallet.getPublicKey.bind(f.wallet)
  let changed = false
  const authority = await RevenueListingProfileAuthority.create({
    ...f.options,
    wallet: {
      ...f.options.wallet,
      getPublicKey: args =>
        changed
          ? Promise.resolve({ publicKey: new PrivateKey(99).toPublicKey().toString() })
          : getPublicKey(args)
    }
  })
  changed = true
  await expect(authority.signTransaction(f.request)).rejects.toThrow('identity changed')
  await expect(
    authority.signGenesis(fixture.descriptor, fixture.genesis.body.genesis)
  ).rejects.toThrow('identity changed')
  expect(f.calls).toHaveLength(1)
})

it('rejects an asynchronous fence before protected signing starts', async () => {
  const f = await profileAuthorityFixture()
  await expect(
    RevenueListingProfileAuthority.create({ ...f.options, checkCurrent: () => Promise.resolve() })
  ).rejects.toThrow('fence must be synchronous')
  expect(f.calls).toHaveLength(0)
})

it('refuses a valid high-S child signature instead of normalizing a protected result', async () => {
  const f = await profileAuthorityFixture(),
    authority = await RevenueListingProfileAuthority.create(f.options)
  f.setSigner(async args => {
    const original = await f.wallet.createSignature(args),
      low = TransactionSignature.fromChecksigFormat([...original.signature, 65]),
      high = new TransactionSignature(low.r, new Curve().n.sub(low.s), 65)
    expect(high.hasLowS()).toBe(false)
    expect(high.verify(args.data!, PublicKey.fromString(f.request.publicKey))).toBe(true)
    const signature = high.toDER()
    if (!Array.isArray(signature)) throw new Error('Fixture DER encoding differs')
    return { signature }
  })
  await expect(authority.signTransaction(f.request)).rejects.toThrow('retained funded input')
  expect(f.calls).toHaveLength(2)
})
