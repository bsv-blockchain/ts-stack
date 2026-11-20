import {
  BigNumber,
  CachedKeyDeriver,
  Curve,
  Hash,
  Point,
  PrivateKey,
  Utils,
  type GetPublicKeyArgs,
  type PubKeyHex
} from '@bsv/sdk'
import { jest } from '@jest/globals'
import { hkdfSync } from 'node:crypto'
import { createEcpmModule, EcpmPermissionModule } from '../index.js'

const curve = new Curve()
const point = (scalar: number): PubKeyHex =>
  curve.g.mul(new BigNumber(scalar)).encode(true, 'hex') as PubKeyHex

const requestArgs = (
  input: PubKeyHex,
  operation: 'apply' | 'remove' = 'apply',
  overrides: Partial<GetPublicKeyArgs> = {}
): GetPublicKeyArgs => ({
  protocolID: [0, `p ecpm ${operation} ${input} mental poker deal`],
  keyID: 'deck mask',
  counterparty: 'self',
  ...overrides
})

const execute = async (
  module: EcpmPermissionModule,
  args: GetPublicKeyArgs,
  method = 'getPublicKey',
  originator = 'poker.example'
): Promise<{ publicKey: PubKeyHex }> =>
  await module.handleRequest!({ method, args, originator }, async () => {
    throw new Error('underlying wallet must not be called')
  })

const observe = <T>(
  promise: Promise<T>
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> =>
  promise.then(
    value => ({ ok: true, value }),
    error => ({ ok: false, error })
  )

describe('EcpmPermissionModule', () => {
  it('applies and removes the same derived scalar without exposing it', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(11))
    const module = new EcpmPermissionModule({ keyDeriver })
    const original = point(7)

    const applied = await execute(module, requestArgs(original))
    const removed = await execute(module, requestArgs(applied.publicKey, 'remove'))

    expect(applied.publicKey).not.toBe(original)
    expect(removed.publicKey).toBe(original)
  })

  it('exports a factory and harmless legacy transformation hooks', async () => {
    const module = createEcpmModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(12))
    })
    const request = {
      method: 'getPublicKey',
      args: requestArgs(point(3)),
      originator: 'poker.example'
    }

    expect(module).toBeInstanceOf(EcpmPermissionModule)
    await expect(module.onRequest(request)).resolves.toEqual({ args: request.args })
    await expect(module.onResponse({ publicKey: point(4) })).resolves.toEqual({
      publicKey: point(4)
    })
  })

  it('multiplies by the HKDF hash of the canonical key, never the key itself', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(19))
    const module = new EcpmPermissionModule({ keyDeriver })
    const original = point(13)
    const derived = keyDeriver.derivePrivateKey(
      [0, 'p ecpm mental poker deal'],
      'deck mask',
      'self'
    )

    // Node's independent RFC 5869 implementation avoids a shared HMAC error
    // between the module and this assertion.
    const okm = Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(derived.toArray('be', 32)),
        Buffer.from('BRC-229 p ecpm scalar v1'),
        Buffer.from('BRC-229 p ecpm scalar'),
        48
      )
    )
    const scalar = new BigNumber(Array.from(okm)).umod(curve.n.subn(1)).addn(1)
    const basePoint = curve.g.mul(new BigNumber(13))
    const expected = basePoint.mul(scalar).encode(true, 'hex')

    await expect(execute(module, requestArgs(original))).resolves.toEqual({
      publicKey: expected
    })

    // Regression guard (BRC-229 root-secret disclosure): the result MUST NOT be
    // the point multiplied by the raw BRC-42 child key. Returning a scalar
    // linear in the child key is exactly what let a counterparty strip the
    // offset and recover the wallet's root ECDH secret.
    const rawKeyProduct = basePoint.mul(new BigNumber(derived.toHex(), 16)).encode(true, 'hex')
    expect(expected).not.toBe(rawKeyProduct)
  })

  it('does not disclose the root ECDH secret through a counterparty-point apply', async () => {
    // Regression test for the BRC-229 root-secret disclosure. A caller sets the
    // ECPM point to a third party's identity key Q and tries to strip the
    // caller-computable BRC-42 offset `o` from the returned d·Q to recover
    // root·Q = ECDH(root, Q) — the secret revealCounterpartyKeyLinkage guards.
    // With the hashed scalar, the strip MUST fail.
    const curveLocal = new Curve()
    const root = new PrivateKey(123456789)
    const identityPub = root.toPublicKey()
    const keyDeriver = new CachedKeyDeriver(root)
    const module = new EcpmPermissionModule({ keyDeriver })

    const victim = new PrivateKey(987654321)
    const Q = victim.toPublicKey()
    const Qhex = Q.encode(true, 'hex') as PubKeyHex
    const logical = 'mental poker deal'
    const keyID = 'deck mask'

    // counterparty 'anyone': shared secret is the wallet's own identity key, so
    // the attacker can compute the offset from fully public data.
    const applied = await execute(
      module,
      requestArgs(Qhex, 'apply', {
        protocolID: [0, `p ecpm apply ${Qhex} ${logical}`],
        keyID,
        counterparty: 'anyone'
      })
    )
    const dQ = Point.fromString(applied.publicKey)
    const invoice = `0-p ecpm ${logical}-${keyID}`
    const offset = new BigNumber(
      Hash.sha256hmac(identityPub.encode(true), Utils.toArray(invoice, 'utf8'))
    ).umod(curveLocal.n)
    const stripped = dQ.add(Q.mul(offset).neg()).encode(true, 'hex')
    const rootSecret = root.deriveSharedSecret(Q).encode(true, 'hex')

    expect(stripped).not.toBe(rootSecret)
  })

  it('does not disclose the self ECDH secret through an identity-point apply', async () => {
    const root = new PrivateKey(123456789)
    const identityPub = root.toPublicKey()
    const module = new EcpmPermissionModule({ keyDeriver: new CachedKeyDeriver(root) })
    const invoice = '0-p ecpm mental poker deal-deck mask'
    const offset = new BigNumber(
      Hash.sha256hmac(identityPub.encode(true), Utils.toArray(invoice, 'utf8'))
    ).umod(curve.n)
    // The old linear scalar leaked root·identityPub, unlocking self-derived keys.
    const selfApplied = await execute(
      module,
      requestArgs(identityPub.encode(true, 'hex') as PubKeyHex, 'apply', {
        counterparty: 'anyone'
      })
    )
    const strippedSelf = Point.fromString(selfApplied.publicKey)
      .add(identityPub.mul(offset).neg())
      .encode(true, 'hex')
    expect(strippedSelf).not.toBe(root.deriveSharedSecret(identityPub).encode(true, 'hex'))
  })

  it('does not disclose a third-party ECDH secret through a caller-held counterparty', async () => {
    const root = new PrivateKey(123456789)
    const identityPub = root.toPublicKey()
    const module = new EcpmPermissionModule({ keyDeriver: new CachedKeyDeriver(root) })
    const Q = new PrivateKey(987654321).toPublicKey()
    const Qhex = Q.encode(true, 'hex') as PubKeyHex
    const invoice = '0-p ecpm mental poker deal-deck mask'
    const caller = new PrivateKey(55555555)
    const callerPub = caller.toPublicKey().encode(true, 'hex') as PubKeyHex
    const callerApplied = await execute(
      module,
      requestArgs(Qhex, 'apply', { counterparty: callerPub })
    )
    const callerOffset = new BigNumber(
      Hash.sha256hmac(
        caller.deriveSharedSecret(identityPub).encode(true),
        Utils.toArray(invoice, 'utf8')
      )
    ).umod(curve.n)
    const strippedCaller = Point.fromString(callerApplied.publicKey)
      .add(Q.mul(callerOffset).neg())
      .encode(true, 'hex')
    expect(strippedCaller).not.toBe(root.deriveSharedSecret(Q).encode(true, 'hex'))
  })

  it('confirms the leaked self secret would reproduce a BRC-2 symmetric key', () => {
    const root = new PrivateKey(123456789)
    const identity = root.toPublicKey()
    const rootSelfSecret = root.deriveSharedSecret(identity)
    const invoice = '2-private notes-thread 7'
    const offset = new BigNumber(
      Hash.sha256hmac(rootSelfSecret.encode(true), Utils.toArray(invoice, 'utf8'))
    ).umod(curve.n)
    // (root + offset)^2 · G = root^2 · G + 2·offset·root·G + offset^2 · G.
    // Every term on the right is known once root·identity leaks.
    const attackerPoint = rootSelfSecret
      .add(identity.mul(offset.muln(2).umod(curve.n)))
      .add(curve.g.mul(offset.mul(offset).umod(curve.n)))
    const actual = new CachedKeyDeriver(root).deriveSymmetricKey(
      [2, 'private notes'],
      'thread 7',
      'self'
    )
    expect(attackerPoint.isInfinity()).toBe(false)
    expect(attackerPoint.x?.toString(16)).toBe(actual.toString(16))
  })

  it('matches the fixed BRC-229 vectors for self and named counterparties', async () => {
    const rootA = new PrivateKey(2)
    const rootB = new PrivateKey(3)
    const moduleA = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(rootA),
      authorize: async () => true
    })
    const moduleB = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(rootB),
      authorize: async () => true
    })
    const p = point(5)
    const args = requestArgs(p, 'apply', {
      protocolID: [2, `p ecpm apply ${p} mental poker deal`],
      keyID: 'deck mask 1'
    })
    const a = await execute(moduleA, args)
    const b = await execute(moduleB, args)
    const named = await execute(moduleA, {
      ...args,
      counterparty: rootB.toPublicKey().encode(true, 'hex') as PubKeyHex
    })

    for (const [root, counterparty, childHex, scalarHex] of [
      [
        rootA,
        'self',
        '0d7da380de7459582c600748e94539c408742f9d4f21153473ba2c1cb812a984',
        '4b666fc0dbfb9f8dfc04f0e996fa412a7d5ca159fef7ad70fe1a02a20bdf371c'
      ],
      [
        rootB,
        'self',
        'd205df1fd5f36ed688c66dda212d1178b87e11cad37469a98c7b3edd690f2b3b',
        'e0bcd184befaa45976ba562bec0f2b7f23652babd7e6df48d2a1bbb89512838d'
      ],
      [
        rootA,
        rootB.toPublicKey().encode(true, 'hex') as PubKeyHex,
        'c3dd11d61386d969ff40e150e3039eeab9bda24ffa13936eac29d0347ec5104b',
        '00a16e916d8154a31be41c6ed274523928c1017cd3220d6fc87e219093f93f5d'
      ]
    ] as const) {
      const child = new CachedKeyDeriver(root).derivePrivateKey(
        [2, 'p ecpm mental poker deal'],
        'deck mask 1',
        counterparty
      )
      expect(child.toHex().padStart(64, '0')).toBe(childHex)
      const okm = Buffer.from(
        hkdfSync(
          'sha256',
          Buffer.from(childHex, 'hex'),
          Buffer.from('BRC-229 p ecpm scalar v1'),
          Buffer.from('BRC-229 p ecpm scalar'),
          48
        )
      )
      expect(
        new BigNumber(Array.from(okm)).umod(curve.n.subn(1)).addn(1).toString(16).padStart(64, '0')
      ).toBe(scalarHex)
    }

    expect(a.publicKey).toBe('0278097c25918218a40191a6601fade23b1e1ff048c8bec5f1b6290b037035a38d')
    expect(b.publicKey).toBe('0365203be12d49a64bfabc8ff5456149941e606c2ebb823e79b3778f177966bd7f')
    expect(named.publicKey).toBe(
      '030d76dcef1ef74ff55d4b90f7c1ddb86467731f62c8d82e9f3b4ad8753597beb7'
    )
    expect(
      (
        await execute(moduleB, {
          ...args,
          protocolID: [2, `p ecpm apply ${a.publicKey} mental poker deal`]
        })
      ).publicKey
    ).toBe('020df70d013bf54db58a7e88b1750febde4f1285d53846876c7f3a6d482db7148d')
    expect(
      (
        await execute(moduleA, {
          ...args,
          protocolID: [2, `p ecpm remove ${a.publicKey} mental poker deal`]
        })
      ).publicKey
    ).toBe(p)
  })

  it('accepts the inclusive protocol, key, reason, TTL, and counterparty boundaries', async () => {
    const privileged = new CachedKeyDeriver(new PrivateKey(21))
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(20)),
      authorizationTTL: 24 * 60 * 60 * 1000,
      authorize: async () => true,
      privilegedKeyDeriver: async () => privileged
    })
    const original = point(14)

    await expect(
      execute(
        module,
        requestArgs(original, 'apply', {
          protocolID: [0, `p ecpm apply ${original} abcde`],
          keyID: 'x',
          counterparty: 'anyone'
        })
      )
    ).resolves.toHaveProperty('publicKey')
    for (const [operation, outerLength] of [
      ['apply', 353],
      ['remove', 354]
    ] as const) {
      const protocolName = `p ecpm ${operation} ${original} ${'a'.repeat(273)}`
      expect(protocolName).toHaveLength(outerLength)
      await expect(
        execute(
          module,
          requestArgs(original, operation, {
            protocolID: [0, protocolName],
            keyID: 'x'.repeat(800)
          })
        )
      ).resolves.toHaveProperty('publicKey')
    }
    for (const privilegedReason of ['abcde', 'x'.repeat(50)]) {
      await expect(
        execute(
          module,
          requestArgs(original, 'apply', {
            privileged: true,
            privilegedReason
          })
        )
      ).resolves.toHaveProperty('publicKey')
    }
  })

  it('commutes across independent wallet modules', async () => {
    const alice = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(23))
    })
    const bob = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(29))
    })
    const original = point(5)

    const ab = await execute(
      bob,
      requestArgs((await execute(alice, requestArgs(original))).publicKey)
    )
    const ba = await execute(
      alice,
      requestArgs((await execute(bob, requestArgs(original))).publicKey)
    )

    expect(ab).toEqual(ba)
  })

  it('excludes the operation and input point from the derivation identity', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(31))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const module = new EcpmPermissionModule({ keyDeriver })

    const first = await execute(module, requestArgs(point(2)))
    await execute(module, requestArgs(first.publicKey, 'remove'))

    expect(derivePrivateKey).toHaveBeenNthCalledWith(
      1,
      [0, 'p ecpm mental poker deal'],
      'deck mask',
      'self'
    )
    expect(derivePrivateKey).toHaveBeenNthCalledWith(
      2,
      [0, 'p ecpm mental poker deal'],
      'deck mask',
      'self'
    )
  })

  it('separates scalars by logical protocol, key ID, and counterparty', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(37))
    const module = new EcpmPermissionModule({ keyDeriver })
    const original = point(17)
    const counterparty = new PrivateKey(41).toPublicKey().toString()

    const results = await Promise.all([
      execute(module, requestArgs(original)),
      execute(
        module,
        requestArgs(original, 'apply', {
          protocolID: [0, `p ecpm apply ${original} another poker game`]
        })
      ),
      execute(module, requestArgs(original, 'apply', { keyID: 'another key' })),
      execute(module, requestArgs(original, 'apply', { counterparty }))
    ])

    expect(new Set(results.map(result => result.publicKey)).size).toBe(4)
  })

  it('authorizes level 1 once per application and protocol, including concurrent calls', async () => {
    let resolveAuthorization!: (approved: boolean) => void
    const authorization = new Promise<boolean>(resolve => {
      resolveAuthorization = resolve
    })
    const authorize = jest.fn(async () => await authorization)
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(43)),
      authorize
    })
    const args = requestArgs(point(3), 'apply', {
      protocolID: [1, `p ecpm apply ${point(3)} mental poker deal`]
    })

    const first = observe(execute(module, args))
    const second = observe(execute(module, args))
    resolveAuthorization(true)
    const outcomes = await Promise.all([first, second])
    expect(outcomes.every(outcome => outcome.ok)).toBe(true)
    await execute(
      module,
      requestArgs(point(4), 'apply', {
        protocolID: [1, `p ecpm apply ${point(4)} mental poker deal`],
        keyID: 'another key'
      })
    )

    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('scopes level 2 grants by counterparty and clears them on dispose', async () => {
    const authorize = jest.fn(async () => true)
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(47)),
      authorize
    })
    const firstCounterparty = new PrivateKey(53).toPublicKey().toString()
    const secondCounterparty = new PrivateKey(59).toPublicKey().toString()
    const levelTwo = (counterparty: string): GetPublicKeyArgs =>
      requestArgs(point(6), 'apply', {
        protocolID: [2, `p ecpm apply ${point(6)} mental poker deal`],
        counterparty
      })

    await execute(module, levelTwo(firstCounterparty))
    await execute(module, levelTwo(firstCounterparty))
    await execute(module, levelTwo(secondCounterparty))
    module.dispose()
    await execute(module, levelTwo(firstCounterparty))

    expect(authorize).toHaveBeenCalledTimes(3)
  })

  it('honors seekPermission false and denial without calling the key deriver', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(61))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const authorize = jest.fn(async () => false)
    const module = new EcpmPermissionModule({ keyDeriver, authorize })
    const levelOne = requestArgs(point(8), 'apply', {
      protocolID: [1, `p ecpm apply ${point(8)} mental poker deal`]
    })

    await expect(execute(module, { ...levelOne, seekPermission: false })).rejects.toThrow(
      /seekPermission/
    )
    await expect(execute(module, levelOne)).rejects.toThrow(/denied/)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })

  it('uses the privileged deriver and forwards the existing privileged reason', async () => {
    const regular = new CachedKeyDeriver(new PrivateKey(67))
    const privileged = new CachedKeyDeriver(new PrivateKey(71))
    const authorize = jest.fn(async () => true)
    const privilegedKeyDeriver = jest.fn(async () => privileged)
    const module = new EcpmPermissionModule({
      keyDeriver: regular,
      privilegedKeyDeriver,
      authorize
    })
    const original = point(9)

    const regularResult = await execute(module, requestArgs(original))
    const privilegedResult = await execute(
      module,
      requestArgs(original, 'apply', {
        privileged: true,
        privilegedReason: 'Protect the private card mask'
      })
    )

    expect(privilegedResult).not.toEqual(regularResult)
    expect(privilegedKeyDeriver).toHaveBeenCalledWith('Protect the private card mask')
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        privileged: true,
        privilegedReason: 'Protect the private card mask'
      })
    )
  })

  it('scopes cached privileged grants to the exact approved reason', async () => {
    const privileged = new CachedKeyDeriver(new PrivateKey(72))
    const authorize = jest.fn(async () => true)
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(73)),
      authorize,
      privilegedKeyDeriver: async () => privileged
    })
    const privilegedArgs = (privilegedReason: string): GetPublicKeyArgs =>
      requestArgs(point(10), 'apply', { privileged: true, privilegedReason })

    await execute(module, privilegedArgs('Protect the private card mask'))
    await execute(module, privilegedArgs('Protect the private card mask'))
    await execute(module, privilegedArgs('Protect the shuffle nonce'))

    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ privilegedReason: 'Protect the private card mask' })
    )
    expect(authorize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ privilegedReason: 'Protect the shuffle nonce' })
    )
  })

  it('does not share pending privileged authorization across different reasons', async () => {
    const resolvers: Array<(approved: boolean) => void> = []
    const authorize = jest.fn(
      async () =>
        await new Promise<boolean>(resolve => {
          resolvers.push(resolve)
        })
    )
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(74)),
      authorize,
      privilegedKeyDeriver: async () => new CachedKeyDeriver(new PrivateKey(75))
    })
    const first = observe(
      execute(
        module,
        requestArgs(point(11), 'apply', {
          privileged: true,
          privilegedReason: 'Protect the private card mask'
        })
      )
    )
    const second = observe(
      execute(
        module,
        requestArgs(point(11), 'apply', {
          privileged: true,
          privilegedReason: 'Protect the shuffle nonce'
        })
      )
    )

    expect(authorize).toHaveBeenCalledTimes(2)
    expect(resolvers).toHaveLength(2)
    resolvers[0]!(true)
    resolvers[1]!(true)
    const outcomes = await Promise.all([first, second])
    expect(outcomes.every(outcome => outcome.ok)).toBe(true)
  })

  it.each<[string, RegExp]>([
    ['createSignature', /not permitted/],
    ['encrypt', /not permitted/]
  ])('rejects unrelated method %s in the ECPM key namespace', async (method, error) => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(73))
    })
    await expect(execute(module, requestArgs(point(2)), method)).rejects.toThrow(error)
  })

  it.each<[Partial<GetPublicKeyArgs>, RegExp]>([
    [{ identityKey: true }, /identityKey/],
    [{ forSelf: true }, /forSelf/],
    [{ keyID: '' }, /keyID/],
    [{ keyID: 'x'.repeat(801) }, /800 bytes/],
    [{ privileged: true }, /privilegedReason/],
    [{ privileged: true, privilegedReason: 'bad' }, /between 5 and 50/]
  ])('rejects conflicting or invalid existing getPublicKey arguments', async (override, error) => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(79))
    })
    await expect(execute(module, requestArgs(point(2), 'apply', override))).rejects.toThrow(error)
  })

  it.each([
    'p ecpm apply missing',
    `p ecpm change ${point(2)} mental poker deal`,
    `p ecpm apply ${point(2).toUpperCase()} mental poker deal`,
    `p ecpm apply ${point(2)} Bad Protocol`,
    `p ecpm apply ${point(2)} bad  spacing`,
    `p ecpm apply ${point(2)} poker protocol`,
    `p ecpm apply ${point(2)} abcd`,
    `p ecpm apply ${point(2)} ${'a'.repeat(274)}`
  ])('rejects malformed module protocol %s', async protocolName => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(83))
    })
    await expect(
      execute(module, requestArgs(point(2), 'apply', { protocolID: [0, protocolName] }))
    ).rejects.toThrow()
  })

  it('rejects an ECPM dispatch envelope above 354 bytes', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(84))
    })
    const protocolName = `p ecpm remove ${point(2)} ${'a'.repeat(274)}`

    expect(protocolName).toHaveLength(355)
    await expect(
      execute(module, requestArgs(point(2), 'remove', { protocolID: [0, protocolName] }))
    ).rejects.toThrow('ECPM: outer protocol ID exceeds 354 bytes')
  })

  it('rejects the non-canonical x coordinate before the SDK parser can reduce it', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(89))
    })
    const nonCanonical = `02${'ff'.repeat(32)}`
    await expect(execute(module, requestArgs(nonCanonical, 'apply'))).rejects.toThrow(
      /canonical field element/
    )
  })

  it('rejects compressed encodings that do not identify a curve point', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(91))
    })
    const undecodable = `02${'00'.repeat(32)}`
    await expect(execute(module, requestArgs(undecodable, 'apply'))).rejects.toThrow(
      'ECPM: point could not be decoded'
    )
  })

  it('rejects decoded points that are infinite or fail curve validation', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(911))
    })
    jest.spyOn(Point, 'fromString').mockReturnValueOnce({
      isInfinity: () => true,
      validate: () => true
    } as never)
    await expect(execute(module, requestArgs(point(2), 'apply'))).rejects.toThrow(
      'ECPM: point is not a finite secp256k1 point'
    )

    jest.spyOn(Point, 'fromString').mockReturnValueOnce({
      isInfinity: () => false,
      validate: () => false
    } as never)
    await expect(execute(module, requestArgs(point(2), 'apply'))).rejects.toThrow(
      'ECPM: point is not a finite secp256k1 point'
    )
  })

  it('rejects a malformed counterparty before key derivation', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(92))
    })
    await expect(
      execute(module, requestArgs(point(2), 'apply', { counterparty: 'not a key' }))
    ).rejects.toThrow('ECPM: expected a lowercase 33-byte compressed secp256k1 point')
  })

  it('rejects non-string originators and distinguishes malformed request fields', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(93))
    })
    await expect(
      module.handleRequest(
        { method: 'getPublicKey', args: requestArgs(point(2)), originator: 42 as never },
        async () => undefined
      )
    ).rejects.toThrow('ECPM: originator is required')
    await expect(
      module.handleRequest(
        { method: 'getPublicKey', args: 'invalid' as never, originator: 'poker.example' },
        async () => undefined
      )
    ).rejects.toThrow('ECPM: getPublicKey arguments must be an object')
    await expect(
      execute(
        module,
        requestArgs(point(2), 'apply', {
          protocolID: [0, 'valid protocol', 'extra'] as never
        })
      )
    ).rejects.toThrow('ECPM: protocolID is required')
    await expect(
      execute(module, requestArgs(point(2), 'apply', { protocolID: [0, 42 as never] }))
    ).rejects.toThrow('ECPM: invalid protocolID')
    await expect(
      execute(module, requestArgs(point(2), 'apply', { keyID: 42 as never }))
    ).rejects.toThrow('ECPM: keyID is required')
  })

  it('rejects the field-prime x boundary and uppercase counterparties', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(94))
    })
    const fieldPrime = curve.p.toString(16).padStart(64, '0')
    await expect(
      execute(module, requestArgs(`02${fieldPrime}` as PubKeyHex, 'apply'))
    ).rejects.toThrow('ECPM: x is not a canonical field element')
    await expect(
      execute(module, requestArgs(point(2), 'apply', { counterparty: point(3).toUpperCase() }))
    ).rejects.toThrow('ECPM: expected a lowercase 33-byte compressed secp256k1 point')
  })

  it('fails closed when authorization or privileged derivation is unavailable', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(97))
    })
    const levelOne = requestArgs(point(2), 'apply', {
      protocolID: [1, `p ecpm apply ${point(2)} mental poker deal`]
    })

    await expect(execute(module, levelOne)).rejects.toThrow(/authorization handler/)
    await expect(
      execute(
        module,
        requestArgs(point(2), 'apply', {
          privileged: true,
          privilegedReason: 'Use protected poker key'
        })
      )
    ).rejects.toThrow(/authorization handler/)
  })

  it('ignores an ambient authorization handler inherited by constructor options', async () => {
    const ambientAuthorize = jest.fn(async () => true)
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'authorize')
    Object.defineProperty(Object.prototype, 'authorize', {
      configurable: true,
      enumerable: true,
      value: ambientAuthorize
    })
    try {
      const module = new EcpmPermissionModule({
        keyDeriver: new CachedKeyDeriver(new PrivateKey(105))
      })
      const levelOne = requestArgs(point(2), 'apply', {
        protocolID: [1, `p ecpm apply ${point(2)} mental poker deal`]
      })

      await expect(execute(module, levelOne)).rejects.toThrow(/authorization handler/)
      expect(ambientAuthorize).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete (Object.prototype as { authorize?: unknown }).authorize
      else Object.defineProperty(Object.prototype, 'authorize', previous)
    }
  })

  it('fails closed when a privileged key provider is missing or invalid', async () => {
    const ordinary = new CachedKeyDeriver(new PrivateKey(98))
    const args = requestArgs(point(2), 'apply', {
      privileged: true,
      privilegedReason: 'Use protected poker key'
    })
    const withoutProvider = new EcpmPermissionModule({
      keyDeriver: ordinary,
      authorize: async () => true
    })
    const invalidProvider = new EcpmPermissionModule({
      keyDeriver: ordinary,
      authorize: async () => true,
      privilegedKeyDeriver: async () => null as never
    })

    await expect(execute(withoutProvider, args)).rejects.toThrow(/unavailable/)
    await expect(execute(invalidProvider, args)).rejects.toThrow(/invalid deriver/)
  })

  it.each([
    [null, /arguments must be an object/],
    [[], /arguments must be an object/],
    [{ keyID: 'key' }, /protocolID is required/],
    [{ protocolID: [3, 'p ecpm apply invalid value'], keyID: 'key' }, /invalid protocolID/]
  ])('rejects malformed argument structure %#', async (args, error) => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(99))
    })
    await expect(
      module.handleRequest(
        { method: 'getPublicKey', args: args as never, originator: 'poker.example' },
        async () => undefined
      )
    ).rejects.toThrow(error)
  })

  it('rejects an absent originator and an invalid counterparty type', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(100))
    })
    await expect(execute(module, requestArgs(point(2)), 'getPublicKey', '')).rejects.toThrow(
      /originator/
    )
    await expect(
      execute(module, requestArgs(point(2), 'apply', { counterparty: 42 as never }))
    ).rejects.toThrow(/counterparty/)
  })

  it('validates constructor options', () => {
    expect(() => new EcpmPermissionModule({ keyDeriver: {} as never })).toThrow(/keyDeriver/)
    expect(
      () =>
        new EcpmPermissionModule({
          keyDeriver: new CachedKeyDeriver(new PrivateKey(101)),
          authorizationTTL: 0
        })
    ).toThrow(/authorizationTTL/)
    expect(
      () =>
        new EcpmPermissionModule({
          keyDeriver: new CachedKeyDeriver(new PrivateKey(106)),
          authorize: false as never
        })
    ).toThrow(/authorize must be a function/)
    expect(
      () =>
        new EcpmPermissionModule({
          keyDeriver: new CachedKeyDeriver(new PrivateKey(107)),
          privilegedKeyDeriver: false as never
        })
    ).toThrow(/privilegedKeyDeriver must be a function/)
    expect(
      () =>
        new EcpmPermissionModule(
          Object.create({ keyDeriver: new CachedKeyDeriver(new PrivateKey(108)) }) as never
        )
    ).toThrow(/plain data object/)
  })

  it('rejects accessor-bearing requests and unsafe originator text without invoking accessors', async () => {
    const module = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(102))
    })
    const getter = jest.fn(() => [0, 'p ecpm apply invalid'])
    const args = Object.defineProperty({ keyID: 'key' }, 'protocolID', {
      enumerable: true,
      get: getter
    })

    await expect(execute(module, args as GetPublicKeyArgs)).rejects.toThrow(
      'must not contain accessors'
    )
    expect(getter).not.toHaveBeenCalled()
    await expect(
      execute(module, requestArgs(point(2)), 'getPublicKey', 'bad\norigin')
    ).rejects.toThrow('originator is invalid')

    const symbolArgs = requestArgs(point(2)) as GetPublicKeyArgs & { [key: symbol]: boolean }
    symbolArgs[Symbol('ambient')] = true
    await expect(execute(module, symbolArgs)).rejects.toThrow('must not contain symbol properties')

    await expect(
      module.handleRequest!(
        Object.create({
          method: 'getPublicKey',
          args: requestArgs(point(2)),
          originator: 'poker.example'
        }),
        async () => undefined
      )
    ).rejects.toThrow('ECPM request must be a plain data object')
  })

  it('caps cached and pending authorization state', async () => {
    const authorize = jest.fn(async () => true)
    const instance = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(103)),
      authorize
    })
    const authorizedArgs = requestArgs(point(2), 'apply', {
      protocolID: [1, `p ecpm apply ${point(2)} bounded poker game`]
    })
    for (let i = 0; i < 1025; i++) {
      await execute(instance, authorizedArgs, 'getPublicKey', `origin-${i}.example`)
    }
    expect(authorize).toHaveBeenCalledTimes(1025)
    await execute(instance, authorizedArgs, 'getPublicKey', 'origin-0.example')
    expect(authorize).toHaveBeenCalledTimes(1026)

    const never = new Promise<boolean>(() => {})
    const pendingModule = new EcpmPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(104)),
      authorize: async () => await never
    })
    for (let i = 0; i < 64; i++) {
      void observe(execute(pendingModule, authorizedArgs, 'getPublicKey', `pending-${i}.example`))
    }
    await expect(
      execute(pendingModule, authorizedArgs, 'getPublicKey', 'pending-overflow.example')
    ).rejects.toThrow('authorization queue is full')
  })
})
