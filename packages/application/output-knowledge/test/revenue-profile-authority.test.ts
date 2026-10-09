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

import { Hash } from '@bsv/sdk'

it.each([
  {
    label: 'wrong identity',
    change: (r: AlteredRequest) => {
      r.identity = new PrivateKey(91).toPublicKey().toString()
    }
  },
  {
    label: 'wrong child',
    change: (r: AlteredRequest) => {
      r.publicKey = fixture.descriptor.seller
    }
  },
  {
    label: 'wrong scope',
    change: (r: AlteredRequest) => {
      r.scope = 193
    }
  }
])(
  'retains the fixed-child selection refusal and no signing effect for $label',
  async ({ change }) => {
    const f = await profileAuthorityFixture(),
      authority = await RevenueListingProfileAuthority.create(f.options)
    const request = { ...structuredClone(f.request) }
    change(request)
    await expect(authority.signTransaction(request)).rejects.toThrow(
      'Profile authority selection differs from the fixed seller child'
    )
    expect(f.calls).toHaveLength(1)
  }
)

it.each([
  {
    label: 'missing byte',
    change: (a: number[]) => {
      delete a[0]
    },
    message: 'Invalid profile authority byte field'
  },
  {
    label: 'hidden byte',
    change: (a: number[]) => {
      Object.defineProperty(a, '0', { value: a[0], enumerable: false })
    },
    message: 'Invalid profile authority byte field'
  },
  {
    label: 'negative byte',
    change: (a: number[]) => {
      a[0] = -1
    },
    message: 'Invalid profile authority byte'
  },
  {
    label: 'large byte',
    change: (a: number[]) => {
      a[0] = 256
    },
    message: 'Invalid profile authority byte'
  },
  {
    label: 'fractional byte',
    change: (a: number[]) => {
      a[0] = 0.5
    },
    message: 'Invalid profile authority byte'
  },
  {
    label: 'NaN byte',
    change: (a: number[]) => {
      a[0] = Number.NaN
    },
    message: 'Invalid profile authority byte'
  }
])(
  'refuses $label in retained signing bytes before the protected signer',
  async ({ change, message }) => {
    const f = await profileAuthorityFixture(),
      authority = await RevenueListingProfileAuthority.create(f.options)
    const request = { ...structuredClone(f.request) }
    change(request.preimage)
    await expect(authority.signTransaction(request)).rejects.toThrow(message)
    expect(f.calls).toHaveLength(1)
  }
)

it.each([
  {
    label: 'preimage length',
    change: (r: AlteredRequest) => {
      r.preimage.pop()
    },
    message: 'Invalid profile authority bytes'
  },
  {
    label: 'digest length',
    change: (r: AlteredRequest) => {
      r.data.pop()
    },
    message: 'Invalid profile authority bytes'
  },
  {
    label: 'compact-size prefix',
    change: (r: AlteredRequest) => {
      r.preimage[104] ^= 1
      r.data = Hash.sha256(r.preimage)
    },
    message: 'Profile authority preimage does not match the active family'
  },
  {
    label: 'literal program',
    change: (r: AlteredRequest) => {
      r.preimage[828] ^= 1
      r.data = Hash.sha256(r.preimage)
    },
    message: 'Profile authority preimage does not match the active family'
  },
  {
    label: 'signature scope tail',
    change: (r: AlteredRequest) => {
      r.preimage[r.preimage.length - 4] = 193
      r.data = Hash.sha256(r.preimage)
    },
    message: 'Profile authority preimage does not match the active family'
  },
  {
    label: 'different digest',
    change: (r: AlteredRequest) => {
      r.data[0] ^= 1
    },
    message: 'Profile authority preimage does not match the active family'
  }
])(
  'retains the refusal for $label independently of the other checks',
  async ({ change, message }) => {
    const f = await profileAuthorityFixture(),
      authority = await RevenueListingProfileAuthority.create(f.options)
    const request = { ...structuredClone(f.request) }
    change(request)
    await expect(authority.signTransaction(request)).rejects.toThrow(message)
    expect(f.calls).toHaveLength(1)
  }
)

it.each([0, 7, 73])(
  'refuses returned DER length %i before decoding or disclosure',
  async length => {
    const f = await profileAuthorityFixture(),
      authority = await RevenueListingProfileAuthority.create(f.options)
    f.setSigner(() => Promise.resolve({ signature: Array<number>(length).fill(0) }))
    await expect(authority.signTransaction(f.request)).rejects.toThrow(
      'Invalid protected DER signature length'
    )
    await expect(
      authority.signGenesis(fixture.descriptor, fixture.genesis.body.genesis)
    ).rejects.toThrow('Invalid protected DER signature length')
    expect(f.calls).toHaveLength(3)
  }
)

it('rejects an accessor in returned DER without evaluating it', async () => {
  const f = await profileAuthorityFixture(),
    authority = await RevenueListingProfileAuthority.create(f.options)
  const getter = jest.fn(() => 1),
    signature = Array<number>(8).fill(0)
  Object.defineProperty(signature, '0', { enumerable: true, get: getter })
  f.setSigner(() => Promise.resolve({ signature }))
  await expect(authority.signTransaction(f.request)).rejects.toThrow(
    'Invalid profile authority byte field'
  )
  expect(getter).not.toHaveBeenCalled()
})

it.each([false, true])(
  'rechecks installation authority after %s child-key lookup',
  async childLookup => {
    const f = await profileAuthorityFixture(),
      getKey = f.options.wallet.getPublicKey
    const options = {
      ...f.options,
      wallet: {
        ...f.options.wallet,
        getPublicKey: async (...args: Parameters<typeof getKey>) => {
          const result = await getKey(...args)
          if ((args[0].identityKey !== true) === childLookup) f.deny()
          return result
        }
      }
    }
    await expect(RevenueListingProfileAuthority.create(options)).rejects.toThrow(
      'Changed protected authority'
    )
    expect(f.calls).toHaveLength(0)
  }
)

it('does not accept a non-void synchronous installation fence', async () => {
  const f = await profileAuthorityFixture()
  await expect(
    RevenueListingProfileAuthority.create({ ...f.options, checkCurrent: () => false })
  ).rejects.toThrow('Profile signing fence must be synchronous')
  expect(f.calls).toHaveLength(0)
})

it('domain-separates the fresh preflight and keeps BRC77 randomness in the genesis child identifier', async () => {
  const f = await profileAuthorityFixture()
  const random = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
    if (array instanceof Uint8Array) array.fill(17)
    return array
  })
  try {
    const authority = await RevenueListingProfileAuthority.create(f.options)
    expect(f.calls[0].args.data).toEqual(
      Hash.sha256([
        ...Utils.toArray('BRC-197/fixed-child-preflight/1\0', 'utf8'),
        ...Utils.toArray(authority.identity, 'hex'),
        ...Array<number>(32).fill(17)
      ])
    )
    expect(f.calls[0].originator).toBe(f.options.originator)
    const genesis = await authority.signGenesis(fixture.descriptor, fixture.genesis.body.genesis)
    expect(f.calls[1].args).toMatchObject({
      protocolID: [2, 'message signing'],
      keyID: Utils.toBase64(Array<number>(32).fill(17)),
      counterparty: 'anyone'
    })
    expect(verifyOutputPacket('sale-genesis', genesis, authority.identity)).toBe(true)
    expect(random).toHaveBeenCalledTimes(2)
  } finally {
    random.mockRestore()
  }
})

it.each(['seller', 'index', 'chain'] as const)(
  'rejects a genesis %s mismatch before protected signing',
  async field => {
    const f = await profileAuthorityFixture(),
      authority = await RevenueListingProfileAuthority.create(f.options)
    const descriptor = structuredClone(fixture.descriptor),
      genesis = structuredClone(fixture.genesis.body.genesis)
    if (field === 'seller') descriptor.seller = new PrivateKey(91).toPublicKey().toString()
    if (field === 'index') genesis.outputIndex = 1
    if (field === 'chain') genesis.chain.genesisHash = '01'.repeat(32)
    await expect(authority.signGenesis(descriptor, genesis)).rejects.toThrow(
      'Profile genesis differs from the selected seller or chain'
    )
    expect(f.calls).toHaveLength(1)
  }
)

it('retains the explicit originator refusal before any protected operation', async () => {
  const f = await profileAuthorityFixture()
  await expect(
    RevenueListingProfileAuthority.create({ ...f.options, originator: '' })
  ).rejects.toThrow('Profile authority requires an explicit originator')
  expect(f.calls).toHaveLength(0)
})

it('binds protected operations and the currentness fence to their installed owners', async () => {
  const f = await profileAuthorityFixture()
  const wallet = {
    getPublicKey(...args: Parameters<typeof f.options.wallet.getPublicKey>) {
      expect(this).toBe(wallet)
      return f.options.wallet.getPublicKey(...args)
    },
    createSignature(...args: Parameters<typeof f.options.wallet.createSignature>) {
      expect(this).toBe(wallet)
      return f.options.wallet.createSignature(...args)
    }
  }
  const options = {
    ...f.options,
    wallet,
    checkCurrent(): void {
      expect(this).toBe(options)
      f.options.checkCurrent()
    }
  }
  const authority = await RevenueListingProfileAuthority.create(options)
  await authority.signTransaction(f.request)
  const genesis = await authority.signGenesis(fixture.descriptor, fixture.genesis.body.genesis)
  expect(verifyOutputPacket('sale-genesis', genesis, authority.identity)).toBe(true)
})
