import { expect, it, jest } from '@jest/globals'
import {
  LCHOverlayCovenantProfileDomain,
  type LCHOverlayCovenantProfileDomainOptions,
  type LCHOverlayCovenantProfilePreparation
} from '../src/overlayAcquisitionCovenantProfile.js'
import { LCHOverlayCovenantDomain } from '../src/overlayAcquisitionCovenant.js'
import { lchNativeCovenantProfileFixture } from './overlay-acquisition-covenant-profile-native.fixture.js'
import { LCHError } from '../src/errors.js'

const inaccessible = new LCHError(
  'ERR_LCH_LICENSE',
  'LCH domain cancelled, changed or inaccessible'
)

/** Check the public error contract as well as rejection: a native caller must
 * distinguish unavailable content, stale authority and invalid payment. */
function rejection(code: LCHError['code'], message: string) {
  return { name: 'LCHError', code, message }
}

it('executes reserve-stage genesis, activation, original funded purchase and released purchase before retaining playable current rights', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    funding = await f.domain.fundingPreflight(f.prepare, f.prepared, signal)
  expect(f.family.decode(f.genesis.outputs[0].lockingScript.toBinary(), f.descriptor).stage).toBe(
    'activation'
  )
  expect(f.family.decode(f.active.outputs[0].lockingScript.toBinary(), f.descriptor).stage).toBe(
    'active'
  )
  expect(f.family.decode(f.purchased.outputs[0].lockingScript.toBinary(), f.descriptor).stage).toBe(
    'active'
  )
  expect(funding.checkCurrent()).toBeUndefined()
  expect(f.counts).toEqual({ preparation: 1, purchase: 0, release: 0 })
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  expect(f.counts).toEqual({ preparation: 1, purchase: 1, release: 1 })
  expect(await f.domain.playback(f.delivered, signal)).toEqual(f.plaintext)
}, 60000)

it('retains precise request, wallet, custody and signed-funding failures without granting any purchase rights', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    uninitialized = await LCHOverlayCovenantProfileDomain.create(f.options)
  await expect(uninitialized.preflight(f.prepare, null, signal)).rejects.toMatchObject(
    rejection('ERR_LCH_LICENSE', 'Original LCH custody is not initialized')
  )
  await expect(
    f.domain.preflight({ ...f.prepare, assetId: 'ab'.repeat(32) }, null, signal)
  ).rejects.toMatchObject(rejection('ERR_LCH_LICENSE', 'Original LCH request changed'))
  await expect(
    f.domain.verify(
      { ...f.prepare, assetId: 'ab'.repeat(32) },
      f.prepared,
      f.submission,
      f.delivered,
      signal
    )
  ).rejects.toMatchObject(rejection('ERR_LCH_LICENSE', 'Original LCH request changed'))
  await expect(
    LCHOverlayCovenantProfileDomain.create({ ...f.options, wallet: f.sellerWallet })
  ).rejects.toMatchObject(
    rejection('ERR_LCH_KEY', 'Installed buyer wallet differs from signed LCH consent')
  )
  for (const challenge of [null, undefined])
    await expect(
      f.domain.fundingPreflight(f.prepare, challenge as never, signal)
    ).rejects.toMatchObject(
      rejection('ERR_LCH_QUOTE', 'Signed preparation is required before funding')
    )
  await expect(f.domain.usable(f.delivered, signal)).rejects.toMatchObject(
    rejection(
      'ERR_LCH_LICENSE',
      'Delivered LCH entitlement has not been locally verified and retained'
    )
  )
  await expect(
    LCHOverlayCovenantProfileDomain.open(
      f.options,
      { id: f.domain.id + 'changed', original: f.domain.original() },
      f.objects
    )
  ).rejects.toMatchObject(rejection('ERR_LCH_LICENSE', 'Retained LCH domain installation differs'))
  const invalid = {
    ...f.options,
    verification: { ...f.options.verification, candidate: 'missing' }
  }
  await expect(LCHOverlayCovenantProfileDomain.create(invalid as never)).rejects.toMatchObject(
    rejection(
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Complete candidate verifier must be installed explicitly'
    )
  )
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
}, 60000)

it('rechecks the accepted funding cutoff without revoking an already purchased obligation or retained offline playback', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    funding = await f.domain.fundingPreflight(f.prepare, f.prepared, signal)
  f.setNow('99')
  expect(funding.checkCurrent()).toBeUndefined()
  f.setNow('100')
  expect(() => funding.checkCurrent()).toThrow('new-purchase window')
  f.setNow('200')
  await f.domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  const reopened = await LCHOverlayCovenantProfileDomain.open(
    f.options,
    { id: f.domain.id, original: f.domain.original() },
    f.reopen()
  )
  expect(await reopened.playback(f.delivered, signal)).toEqual(f.plaintext)
  expect(f.counts).toEqual({ preparation: 1, purchase: 1, release: 1 })
}, 60000)

it('requires owned active-stage and installed-height assessments and pins their fields through funding', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    original = f.options.verification.preparation
  let returned: LCHOverlayCovenantProfilePreparation | undefined
  const options = {
      ...f.options,
      verification: {
        ...f.options.verification,
        preparation: async (...args: Parameters<typeof original>) => {
          returned = await original(...args)
          return returned
        }
      }
    },
    domain = await LCHOverlayCovenantProfileDomain.create(options)
  await domain.initializeCustody(f.objects)
  const funding = await domain.fundingPreflight(f.prepare, f.prepared, signal)
  returned!.currentHeight = '1000'
  expect(() => funding.checkCurrent()).toThrow('assessment changed')
  await [
    { stage: 'activation', currentHeight: '101' },
    { stage: 'active', currentHeight: '1000' },
    { stage: 'active', currentHeight: '0101' },
    { stage: 'active', currentHeight: 101 },
    {
      currentHeight: '101',
      get stage() {
        return 'active'
      }
    }
  ].reduce(async (previous, fields) => {
    await previous
    const selected = {
        ...f.options,
        verification: {
          ...f.options.verification,
          preparation: async (...args: Parameters<typeof original>) => {
            const verified = await original(...args)
            Object.defineProperties(verified, Object.getOwnPropertyDescriptors(fields))
            return verified
          }
        }
      },
      fresh = await LCHOverlayCovenantProfileDomain.create(selected)
    await fresh.initializeCustody(f.objects)
    await expect(fresh.fundingPreflight(f.prepare, f.prepared, signal)).rejects.toThrow()
  }, Promise.resolve())
}, 60000)

it('keeps historical descriptor/custody selection explicit and refuses the wrong wallet or unsigned funding preparation', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal
  await expect(LCHOverlayCovenantDomain.create(f.options as never)).rejects.toThrow()
  await expect(
    LCHOverlayCovenantProfileDomain.create({ ...f.options, wallet: f.sellerWallet })
  ).rejects.toThrow('Installed buyer wallet')
  await expect(f.domain.fundingPreflight(f.prepare, null as never, signal)).rejects.toThrow(
    'Signed preparation'
  )
  await expect(
    LCHOverlayCovenantProfileDomain.open(
      f.options,
      { id: f.domain.id + 'changed', original: f.domain.original() },
      f.objects
    )
  ).rejects.toThrow('installation differs')
}, 60000)

it('requires the independently verified original wallet subject and the exact complete commitment before accepting current delivery', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    domain = await LCHOverlayCovenantProfileDomain.create(f.options)
  await expect(domain.fundingPreflight(f.prepare, f.prepared, signal)).rejects.toThrow(
    'not initialized'
  )
  await expect(
    f.domain.verify(
      f.prepare,
      f.prepared,
      { ...f.submission, acquisitionId: 'ab'.repeat(32) },
      f.delivered,
      signal
    )
  ).rejects.toThrow('Original wallet transaction')
  await expect(
    f.domain.verify(f.prepare, f.prepared, { ...f.submission, beef: 'AA==' }, f.delivered, signal)
  ).rejects.toThrow()
  await expect(f.domain.playback(f.delivered, signal)).rejects.toThrow('not been locally verified')
  expect(f.counts.purchase).toBe(0)
}, 60000)

it('rejects invalid content and proof installations before invoking their ports, including the exact upper bound', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    create = (changes: Partial<LCHOverlayCovenantProfileDomainOptions>) =>
      LCHOverlayCovenantProfileDomain.create({ ...f.options, ...changes }),
    invalid = rejection(
      'ERR_LCH_PROFILE_UNSUPPORTED',
      'Finite content/proof installation is required'
    )
  for (const maximumCiphertextBytes of [0, -1, 1.5, NaN, Infinity, 536870913])
    await expect(create({ maximumCiphertextBytes })).rejects.toMatchObject(invalid)
  for (const id of ['', 1]) {
    await expect(
      create({ source: { ...f.options.source, id: id as string } })
    ).rejects.toMatchObject(invalid)
    await expect(
      create({ verification: { ...f.options.verification, id: id as string } })
    ).rejects.toMatchObject(invalid)
  }
  await expect(create({ current: async () => true } as never)).rejects.toMatchObject(
    rejection('ERR_LCH_LICENSE', 'Current access must be synchronous')
  )
  const upper = await create({ maximumCiphertextBytes: 536870912 })
  expect(upper.id).toMatch(/^urn:bsv:lch-overlay-covenant:[0-9a-f]{64}$/)
  expect(upper.id).not.toBe(f.domain.id)
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
}, 60000)

it('reuses the same protected custody reservation and refuses a different owner even when it opens the same database', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    domain = await LCHOverlayCovenantProfileDomain.create(f.options),
    objects = {
      durability: f.objects.durability,
      configuration: f.objects.configuration,
      reserve: jest.fn(f.objects.reserve.bind(f.objects)),
      read: f.objects.read.bind(f.objects),
      put: jest.fn(f.objects.put.bind(f.objects))
    }
  // Observe the actual encrypted store through ports installed before custody.
  await domain.initializeCustody(objects)
  await domain.initializeCustody(objects)
  await LCHOverlayCovenantProfileDomain.open(
    f.options,
    { id: domain.id, original: domain.original() },
    objects
  )
  expect(objects.reserve).toHaveBeenCalledTimes(2)
  expect(objects.put).toHaveBeenCalledTimes(1)
  await expect(domain.initializeCustody(f.reopen())).rejects.toMatchObject(
    rejection('ERR_LCH_LICENSE', 'Original LCH custody owner changed')
  )
  await domain.preflight(f.prepare, null, new AbortController().signal)
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
}, 60000)

it('pins every installed domain port and authority context before unsigned work, and rejects cancellation and loss of access', async () => {
  const revocations = {
      id: 'current-role-observations',
      at: (time: string) => ({
        status: async () => ({
          status: 'unspent' as const,
          network: 'testnet' as const,
          observedAt: BigInt(time)
        })
      })
    },
    f = await lchNativeCovenantProfileFixture({ revocations }),
    signal = new AbortController().signal,
    changes: [object, string, unknown][] = [
      [f.options.source, 'read', async () => new Uint8Array()],
      [f.options.source, 'id', 'different-content'],
      [f.options.verification, 'preparation', async () => undefined],
      [f.options.verification, 'purchase', async () => undefined],
      [f.options.verification, 'release', async () => undefined],
      [f.options.verification, 'id', 'different-proof'],
      [f.options.wallet, 'getPublicKey', async () => ({ publicKey: f.prepare.recipient })],
      [f.options.wallet, 'decrypt', async () => ({ plaintext: [] })],
      [f.options, 'clock', () => '22'],
      [f.options, 'current', () => true],
      [f.options, 'source', { ...f.options.source }],
      [f.options, 'wallet', { ...f.options.wallet }],
      [f.options, 'verification', { ...f.options.verification }],
      [f.options, 'revocations', { ...revocations }],
      [f.options, 'authorityNetwork', 'mainnet'],
      [revocations, 'at', () => undefined],
      [revocations, 'id', 'different-observations']
    ]
  for (const [owner, name, value] of changes) {
    const original = Object.getOwnPropertyDescriptor(owner, name)
    Object.defineProperty(owner, name, { configurable: true, writable: true, value })
    try {
      await expect(f.domain.preflight(f.prepare, null, signal)).rejects.toMatchObject(inaccessible)
    } finally {
      if (original) Object.defineProperty(owner, name, original)
      else Reflect.deleteProperty(owner, name)
    }
  }
  const aborted = new AbortController()
  aborted.abort()
  await expect(f.domain.preflight(f.prepare, null, aborted.signal)).rejects.toMatchObject(
    inaccessible
  )
  f.setAccess(false)
  await expect(f.domain.preflight(f.prepare, null, signal)).rejects.toMatchObject(inaccessible)
  f.setAccess(true)
  await f.domain.preflight(f.prepare, null, signal)
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
}, 60000)

it('requires owned synchronous preparation guards and checks their results and identity again immediately before funding', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    original = f.options.verification.preparation,
    invalidGuard = rejection('ERR_LCH_LICENSE', 'Purchase verification guard must be synchronous'),
    unfinished = rejection(
      'ERR_LCH_LICENSE',
      'Purchase verification guard changed or did not finish'
    )
  const cases = [
    { checkCurrent: 1, expected: invalidGuard },
    { checkCurrent: async () => undefined, expected: invalidGuard },
    { checkCurrent: () => true, expected: unfinished },
    { checkCurrent: () => Promise.resolve(), expected: unfinished }
  ]
  for (const value of cases) {
    const options = {
        ...f.options,
        verification: {
          ...f.options.verification,
          preparation: async (...args: Parameters<typeof original>) => ({
            ...(await original(...args)),
            checkCurrent: value.checkCurrent
          })
        }
      },
      domain = await LCHOverlayCovenantProfileDomain.create(options as never)
    await domain.initializeCustody(f.objects)
    await expect(domain.fundingPreflight(f.prepare, f.prepared, signal)).rejects.toMatchObject(
      value.expected
    )
  }
  let assessment: LCHOverlayCovenantProfilePreparation | undefined
  const options = {
      ...f.options,
      verification: {
        ...f.options.verification,
        preparation: async (...args: Parameters<typeof original>) => {
          assessment = await original(...args)
          return assessment
        }
      }
    },
    domain = await LCHOverlayCovenantProfileDomain.create(options)
  await domain.initializeCustody(f.objects)
  const funding = await domain.fundingPreflight(f.prepare, f.prepared, signal)
  const check = assessment!.checkCurrent
  assessment!.checkCurrent = () => undefined
  expect(() => funding.checkCurrent()).toThrow(unfinished.message)
  assessment!.checkCurrent = check
  for (const name of ['stage', 'currentHeight'] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(assessment!, name)!
    Reflect.deleteProperty(assessment!, name)
    expect(() => funding.checkCurrent()).toThrow('Current preparation assessment changed')
    Object.defineProperty(assessment!, name, descriptor)
  }
  expect(funding.checkCurrent()).toBeUndefined()
}, 60000)

it('distinguishes malformed owned preparation fields from a valid activation assessment that cannot authorize new funding', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    original = f.options.verification.preparation
  for (const [fields, expected] of [
    [
      { stage: 'missing', currentHeight: '101' },
      rejection(
        'ERR_LCH_LICENSE',
        'Current preparation requires owned stage and installed chain height'
      )
    ],
    [
      { stage: 'active', currentHeight: 101 },
      rejection(
        'ERR_LCH_LICENSE',
        'Current preparation requires owned stage and installed chain height'
      )
    ],
    [
      { stage: 'activation', currentHeight: '101' },
      rejection('ERR_LCH_QUOTE', 'New preparation requires an active listing below expiry height')
    ]
  ] as const) {
    const options = {
        ...f.options,
        verification: {
          ...f.options.verification,
          preparation: async (...args: Parameters<typeof original>) => ({
            ...(await original(...args)),
            ...fields
          })
        }
      },
      domain = await LCHOverlayCovenantProfileDomain.create(options as never)
    await domain.initializeCustody(f.objects)
    await expect(domain.fundingPreflight(f.prepare, f.prepared, signal)).rejects.toMatchObject(
      expected
    )
  }
}, 60000)

it('bounds detached content and rechecks access across the real source await before releasing authenticated plaintext', async () => {
  const f = await lchNativeCovenantProfileFixture({ detached: true }),
    signal = new AbortController().signal
  let mode: 'valid' | 'at-bound' | 'oversized' | 'invalid' | 'revoked' = 'valid'
  const options = {
      ...f.options,
      source: {
        id: f.options.source.id,
        read: async (...args: Parameters<typeof f.options.source.read>) => {
          const actual = await f.options.source.read(...args)
          if (mode === 'at-bound') return new Uint8Array(f.options.maximumCiphertextBytes)
          if (mode === 'oversized') return new Uint8Array(f.options.maximumCiphertextBytes + 1)
          if (mode === 'invalid') return { length: actual.length } as unknown as Uint8Array
          if (mode === 'revoked') f.setAccess(false)
          return actual
        }
      }
    },
    domain = await LCHOverlayCovenantProfileDomain.create(options)
  await domain.initializeCustody(f.objects)
  await domain.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  mode = 'at-bound'
  // The inclusive resource bound accepts these bytes; content authentication
  // must then reject their different committed length, never grant plaintext.
  await expect(domain.playback(f.delivered, signal)).rejects.toMatchObject({
    message: 'No valid ciphertext source was available',
    cause: rejection('ERR_LCH_CONTENT_DIGEST', 'Ciphertext length mismatch')
  })
  for (const value of ['oversized', 'invalid'] as const) {
    mode = value
    await expect(domain.playback(f.delivered, signal)).rejects.toMatchObject({
      message: 'No valid ciphertext source was available',
      cause: rejection('ERR_LCH_CONTENT_UNAVAILABLE', 'Ciphertext source exceeded its local bound')
    })
  }
  mode = 'revoked'
  await expect(domain.playback(f.delivered, signal)).rejects.toMatchObject({
    message: 'No valid ciphertext source was available',
    cause: inaccessible
  })
  mode = 'valid'
  f.setAccess(true)
  expect(await domain.playback(f.delivered, signal)).toEqual(f.plaintext)
  expect(await domain.usable(f.delivered, signal)).toBe(true)
  expect(f.counts).toEqual({ preparation: 0, purchase: 1, release: 1 })
}, 60000)

it('requires the independently verified complete purchase commitment and a finished release guard before recording rights', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal,
    purchase = f.options.verification.purchase,
    release = f.options.verification.release
  const mismatched = await LCHOverlayCovenantProfileDomain.create({
    ...f.options,
    verification: {
      ...f.options.verification,
      purchase: async (...args: Parameters<typeof purchase>) => {
        const actual = await purchase(...args)
        return { ...actual, purchaseCommitment: '00'.repeat(32) }
      }
    }
  })
  await mismatched.initializeCustody(f.objects)
  await expect(
    mismatched.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  ).rejects.toMatchObject(
    rejection(
      'ERR_LCH_PAYMENT',
      'Settlement differs from independently verified purchase commitment'
    )
  )
  expect(f.counts).toEqual({ preparation: 0, purchase: 1, release: 0 })
  const unfinished = await LCHOverlayCovenantProfileDomain.create({
    ...f.options,
    verification: {
      ...f.options.verification,
      release: async (...args: Parameters<typeof release>) => {
        const actual = await release(...args)
        return {
          checkCurrent: () => {
            actual.checkCurrent()
            return Promise.resolve()
          }
        }
      }
    }
  })
  await unfinished.initializeCustody(f.objects)
  await expect(
    unfinished.verify(f.prepare, f.prepared, f.submission, f.delivered, signal)
  ).rejects.toMatchObject(
    rejection('ERR_LCH_LICENSE', 'Purchase verification guard changed or did not finish')
  )
  await expect(f.domain.playback(f.delivered, signal)).rejects.toMatchObject(
    rejection(
      'ERR_LCH_LICENSE',
      'Delivered LCH entitlement has not been locally verified and retained'
    )
  )
  expect(f.counts).toEqual({ preparation: 0, purchase: 2, release: 1 })
}, 60000)

it('rejects missing private material and wrong original transaction association before accepting an entitlement', async () => {
  const f = await lchNativeCovenantProfileFixture(),
    signal = new AbortController().signal
  await expect(
    f.domain.verify(
      f.prepare,
      f.prepared,
      f.submission,
      {
        ...f.delivered,
        result: { ...f.delivered.result, status: 'pending' }
      } as never,
      signal
    )
  ).rejects.toMatchObject(rejection('ERR_LCH_LICENSE', 'Delivered context is missing'))
  await expect(
    f.domain.verify(
      f.prepare,
      f.prepared,
      { ...f.submission, txid: 'ab'.repeat(32) },
      f.delivered,
      signal
    )
  ).rejects.toMatchObject(
    rejection('ERR_LCH_PAYMENT', 'Original wallet transaction differs from the purchased subject')
  )
  await expect(
    f.domain.verify(
      f.prepare,
      f.prepared,
      {
        ...f.submission,
        acquisitionId: 'ab'.repeat(32)
      },
      f.delivered,
      signal
    )
  ).rejects.toMatchObject(
    rejection('ERR_LCH_PAYMENT', 'Original wallet transaction differs from the purchased subject')
  )
  expect(f.counts).toEqual({ preparation: 0, purchase: 0, release: 0 })
}, 60000)
