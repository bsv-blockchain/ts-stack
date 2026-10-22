import { CachedKeyDeriver, Point, PrivateKey, type WalletInterface } from '@bsv/sdk'
import { jest } from '@jest/globals'
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client'
import { decodeKeyResult, decodeSignResult } from '../encoding.js'
import { createRabinModule, RabinPermissionModule, verify } from '../index.js'
import type { RabinAuthorizationRequest } from '../types.js'
import {
  encryptArgs,
  execute,
  fromHex,
  keyVector,
  observe,
  ORIGINATOR,
  toHex,
  vectors
} from './helpers.js'

const ADMIN = 'admin.wallet.example'
const K1 = keyVector('K1 2048 self')
const S1 = vectors.signatures[0]
const walletAKey = () => PrivateKey.fromHex(vectors.parameters.walletA)

/** An underlying wallet whose every method fails the test if reached. */
const unreachableWallet = () => {
  const calls: string[] = []
  const wallet = new Proxy(
    {},
    {
      get: (_target, method) => {
        if (method === 'then') return undefined
        return async () => {
          calls.push(String(method))
          throw new Error(`underlying ${String(method)} must not be called`)
        }
      }
    }
  ) as WalletInterface
  return { wallet, calls }
}

const managerWith = (rabin: RabinPermissionModule) => {
  const { wallet, calls } = unreachableWallet()
  const manager = new WalletPermissionsManager(wallet, ADMIN, {
    encryptWalletMetadata: false,
    permissionModules: { rabin }
  } as never)
  return { manager, calls }
}

describe('RabinPermissionModule through WalletPermissionsManager', () => {
  it('returns the K1 key and S1 signature through the real manager and never calls next', async () => {
    const rabin = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(walletAKey()),
      authorize: async () => true
    })
    const handleRequest = jest.spyOn(rabin, 'handleRequest')
    const { manager, calls } = managerWith(rabin)

    const key = await manager.encrypt({ ...K1.request, plaintext: [] } as never, ORIGINATOR)
    const signed = await manager.encrypt(
      { ...S1.request, plaintext: fromHex(S1.request.plaintext) } as never,
      ORIGINATOR
    )

    expect(toHex(key.ciphertext)).toBe(K1.response.ciphertext)
    expect(toHex(signed.ciphertext)).toBe(S1.response.ciphertext)
    expect(handleRequest).toHaveBeenCalledTimes(2)
    expect(calls).toEqual([])
  }, 30_000)

  it.each([
    ['decrypt', { ciphertext: [1, 2, 3] }],
    ['getPublicKey', {}],
    ['createSignature', { data: [1, 2, 3] }],
    ['verifySignature', { data: [1, 2, 3], signature: [0x30, 0x06, 2, 1, 1, 2, 1, 1] }],
    ['createHmac', { data: [1, 2, 3] }],
    ['verifyHmac', { data: [1, 2, 3], hmac: Array.from({ length: 32 }, () => 0) }]
  ])('rejects %s under p rabin without deriving or reaching the wallet', async (method, extra) => {
    const keyDeriver = new CachedKeyDeriver(walletAKey())
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const { manager, calls } = managerWith(new RabinPermissionModule({ keyDeriver }))
    const args = {
      protocolID: [0, 'p rabin sign 2048 example oracle'],
      keyID: 'feed 1',
      counterparty: 'self',
      ...extra
    }
    const call = (
      manager as unknown as Record<string, (a: unknown, o: string) => Promise<unknown>>
    )[method]
    await expect(call.call(manager, args, ORIGINATOR)).rejects.toThrow(
      `RABIN: ${method} is not permitted in the p rabin namespace`
    )
    expect(derivePrivateKey).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})

describe('RabinPermissionModule requests', () => {
  const module = () => new RabinPermissionModule({ keyDeriver: new CachedKeyDeriver(walletAKey()) })

  it('exports a factory', () => {
    const instance = createRabinModule({ keyDeriver: new CachedKeyDeriver(new PrivateKey(5)) })
    expect(instance).toBeInstanceOf(RabinPermissionModule)
  })

  it('derives under exactly [level, "p rabin " + L] with the key ID and counterparty unchanged', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(7))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const instance = new RabinPermissionModule({ keyDeriver })
    const counterparty = vectors.parameters.walletBIdentity

    await execute(instance, encryptArgs('key', { counterparty }))
    await execute(instance, encryptArgs('sign', { counterparty }))

    expect(derivePrivateKey).toHaveBeenCalledTimes(1)
    expect(derivePrivateKey).toHaveBeenCalledWith(
      [0, 'p rabin example oracle'],
      'feed 1',
      counterparty
    )
  }, 30_000)

  it('treats an absent or null counterparty as self', async () => {
    const instance = module()
    const self = await execute(instance, encryptArgs('key'))
    expect(await execute(instance, encryptArgs('key', { counterparty: undefined }))).toEqual(self)
    expect(await execute(instance, encryptArgs('key', { counterparty: null as never }))).toEqual(
      self
    )
  })

  it('addresses one key with key and sign, and separates level, protocol, key ID and size', async () => {
    const instance = module()
    const n = decodeKeyResult((await execute(instance, encryptArgs('key'))).ciphertext)
    const signed = decodeSignResult((await execute(instance, encryptArgs('sign'))).ciphertext)
    expect(verify([0x61, 0x62, 0x63], signed.sig, signed.padding, n)).toBe(true)

    const variants = await Promise.all([
      execute(instance, encryptArgs('key', { protocolID: [0, 'p rabin key 2048 another oracle'] })),
      execute(instance, encryptArgs('key', { keyID: 'feed 2' })),
      execute(instance, encryptArgs('key', { counterparty: 'anyone' }))
    ])
    const moduli = new Set([n, ...variants.map(result => decodeKeyResult(result.ciphertext))])
    expect(moduli.size).toBe(4)
  }, 30_000)

  it('accepts the inclusive protocol, key ID, plaintext and reason boundaries', async () => {
    const instance = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(11)),
      authorize: async () => true,
      privilegedKeyDeriver: async () => new CachedKeyDeriver(new PrivateKey(12)),
      // Seven distinct keys from one app: lift the generation rate limit for this test.
      originatorGenerationBurst: 100
    })
    const longest = 'a'.repeat(272)
    for (const [operation, length] of [
      ['key', 289],
      ['sign', 290]
    ] as const) {
      const protocolName = `p rabin ${operation} 2048 ${longest}`
      expect(protocolName).toHaveLength(length)
      await expect(
        execute(
          instance,
          encryptArgs(operation, { protocolID: [0, protocolName], keyID: 'x'.repeat(800) })
        )
      ).resolves.toHaveProperty('ciphertext')
    }
    await expect(
      execute(
        instance,
        encryptArgs('sign', { protocolID: [0, 'p rabin sign 2048 abcde'], keyID: 'x' })
      )
    ).resolves.toHaveProperty('ciphertext')
    const mebibyte = encryptArgs('sign', {
      plaintext: Array.from({ length: 1024 * 1024 }, () => 7)
    })
    await expect(execute(instance, mebibyte)).resolves.toHaveProperty('ciphertext')
    await expect(
      execute(
        instance,
        encryptArgs('sign', { plaintext: new Uint8Array([0x61, 0x62, 0x63]) as never })
      )
    ).resolves.toEqual(await execute(instance, encryptArgs('sign')))
    await expect(execute(instance, encryptArgs('sign', { plaintext: [] }))).resolves.toHaveProperty(
      'ciphertext'
    )
    for (const privilegedReason of ['abcde', 'x'.repeat(50)]) {
      await expect(
        execute(instance, encryptArgs('key', { privileged: true, privilegedReason }))
      ).resolves.toHaveProperty('ciphertext')
    }
  }, 30_000)

  it.each([
    ['p rabin verify 2048 example oracle', /unknown operation/],
    ['p rabin sign 1024 example oracle', /unsupported key size/],
    ['p rabin sign 02048 example oracle', /unsupported key size/],
    ['p rabin sign 2048 Example Oracle', /invalid logical protocol ID/],
    ['p rabin sign 2048 bad  spacing', /invalid logical protocol ID/],
    ['p rabin sign 2048  leading', /invalid logical protocol ID/],
    ['p rabin sign 2048 trailing ', /invalid logical protocol ID/],
    ['p rabin sign 2048 oracle protocol', /invalid logical protocol ID/],
    ['p rabin sign 2048 oracle-feed', /invalid logical protocol ID/],
    ['p rabin sign 2048 abcd', /between 5 and 272 bytes/],
    [`p rabin key 2048 ${'a'.repeat(273)}`, /between 5 and 272 bytes/],
    [`p rabin sign 2048 ${'a'.repeat(273)}`, /exceeds 290 bytes/],
    ['p rabin sign 2048', /protocol must be/],
    ['p rabin', /protocol must be/],
    ['p rabinx sign 2048 example oracle', /protocol must be/]
  ])('rejects malformed protocol %s before deriving', async (protocolName, error) => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(13))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const instance = new RabinPermissionModule({ keyDeriver })
    const operation = protocolName.includes(' key ') ? 'key' : 'sign'
    await expect(
      execute(instance, encryptArgs(operation, { protocolID: [0, protocolName] }))
    ).rejects.toThrow(error)
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })

  it.each<[string, Record<string, unknown>, RegExp]>([
    ['non-empty key plaintext', { plaintext: [1] }, /plaintext must be empty for key/],
    ['missing plaintext', { plaintext: undefined }, /plaintext must be a byte array/],
    ['string plaintext', { plaintext: 'abc' }, /plaintext must be a byte array/],
    ['uncompressed counterparty', { counterparty: `04${'11'.repeat(64)}` }, /compressed secp256k1/],
    [
      'uppercase counterparty',
      { counterparty: vectors.parameters.walletBIdentity.toUpperCase() },
      /compressed/
    ],
    ['non-string counterparty', { counterparty: 42 }, /counterparty must be/],
    ['privileged without a reason', { privileged: true }, /privilegedReason is required/],
    ['short reason', { privileged: true, privilegedReason: 'bad' }, /between 5 and 50/],
    ['long reason', { privileged: true, privilegedReason: 'x'.repeat(51) }, /between 5 and 50/],
    ['non-boolean privileged', { privileged: 'true' }, /privileged must be a boolean/],
    ['non-boolean seekPermission', { seekPermission: 'no' }, /seekPermission must be a boolean/],
    ['empty key ID', { keyID: '' }, /keyID is required/],
    ['non-string key ID', { keyID: 42 }, /keyID is required/],
    ['oversized key ID', { keyID: 'x'.repeat(801) }, /keyID exceeds 800 bytes/],
    [
      'security level 3',
      { protocolID: [3, 'p rabin key 2048 example oracle'] },
      /invalid protocolID/
    ],
    ['numeric protocol', { protocolID: [0, 42] }, /invalid protocolID/],
    [
      'three-part protocol',
      { protocolID: [0, 'p rabin key 2048 example oracle', 1] },
      /protocolID is required/
    ],
    ['missing protocol', { protocolID: undefined }, /protocolID is required/]
  ])('rejects a key request with %s', async (_label, override, error) => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(14))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const instance = new RabinPermissionModule({ keyDeriver, authorize: async () => true })
    await expect(execute(instance, { ...encryptArgs('key'), ...override })).rejects.toThrow(error)
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })

  it.each<[string, unknown, RegExp]>([
    ['x at the field prime', `02${'ff'.repeat(24)}fffffffefffffc2f`, /canonical field element/],
    ['x above the field prime', `02${'ff'.repeat(32)}`, /canonical field element/],
    ['x off the curve', `02${'00'.repeat(32)}`, /could not be decoded/]
  ])('rejects a public-key counterparty with %s', async (_label, counterparty, error) => {
    await expect(
      execute(module(), encryptArgs('sign', { counterparty: counterparty as string }))
    ).rejects.toThrow(error)
  })

  it('rejects decoded counterparties that are infinite or fail curve validation', async () => {
    const counterparty = vectors.parameters.walletBIdentity
    for (const decoded of [
      { isInfinity: () => true, validate: () => true },
      { isInfinity: () => false, validate: () => false }
    ]) {
      jest.spyOn(Point, 'fromString').mockReturnValueOnce(decoded as never)
      await expect(execute(module(), encryptArgs('sign', { counterparty }))).rejects.toThrow(
        'RABIN: point is not a finite secp256k1 point'
      )
    }
  })

  it('rejects oversized and malformed sign plaintexts', async () => {
    const instance = module()
    await expect(
      execute(
        instance,
        encryptArgs('sign', { plaintext: Array.from({ length: 1024 * 1024 + 1 }, () => 0) })
      )
    ).rejects.toThrow('RABIN: plaintext exceeds 1048576 bytes')
    for (const bad of [[256], [-1], [1.5], ['1'], [undefined]]) {
      await expect(
        execute(instance, encryptArgs('sign', { plaintext: bad as never }))
      ).rejects.toThrow('RABIN: plaintext must be a byte array')
    }
    const larger = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(15)),
      maxMessageBytes: 2 * 1024 * 1024
    })
    await expect(
      execute(larger, encryptArgs('sign', { plaintext: new Uint8Array(1024 * 1024 + 1) as never }))
    ).resolves.toHaveProperty('ciphertext')
  })

  it('validates the originator and request shape without invoking accessors', async () => {
    const instance = module()
    await expect(execute(instance, encryptArgs('key'), 'encrypt', '')).rejects.toThrow(
      'originator is required'
    )
    await expect(execute(instance, encryptArgs('key'), 'encrypt', 42)).rejects.toThrow(
      'originator is required'
    )
    await expect(execute(instance, encryptArgs('key'), 'encrypt', 'bad\norigin')).rejects.toThrow(
      'originator is invalid'
    )
    await expect(
      execute(instance, encryptArgs('key'), 'encrypt', 'a'.repeat(1025))
    ).rejects.toThrow('originator is invalid or too long')
    await expect(execute(instance, 'invalid')).rejects.toThrow(
      'encrypt arguments must be an object'
    )
    await expect(execute(instance, [])).rejects.toThrow('encrypt arguments must be an object')
    await expect(execute(instance, Object.create({ keyID: 'k' }))).rejects.toThrow(
      'plain data object'
    )

    const getter = jest.fn(() => [0, 'p rabin key 2048 example oracle'])
    const accessor = Object.defineProperty({ keyID: 'k', plaintext: [] }, 'protocolID', {
      enumerable: true,
      get: getter
    })
    await expect(execute(instance, accessor)).rejects.toThrow('must not contain accessors')
    expect(getter).not.toHaveBeenCalled()

    const symbolArgs = { ...encryptArgs('key'), [Symbol('ambient')]: true }
    await expect(execute(instance, symbolArgs)).rejects.toThrow(
      'must not contain symbol properties'
    )
    await expect(
      instance.handleRequest(
        Object.create({ method: 'encrypt', args: encryptArgs('key'), originator: ORIGINATOR }),
        async () => undefined
      )
    ).rejects.toThrow('RABIN: request must be a plain data object')
  })

  it('prefixes every structural error with RABIN:', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(17))
    expect(() => new RabinPermissionModule(null as never)).toThrow(
      /^RABIN: options must be an object$/
    )
    expect(() => new RabinPermissionModule(Object.create({ keyDeriver }) as never)).toThrow(
      /^RABIN: options must be a plain data object$/
    )
    await expect(
      new RabinPermissionModule({ keyDeriver }).handleRequest([] as never, async () => undefined)
    ).rejects.toThrow(/^RABIN: request must be an object$/)
  })

  it('validates constructor options', () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(16))
    expect(() => new RabinPermissionModule({ keyDeriver: {} as never })).toThrow(/keyDeriver/)
    expect(() => new RabinPermissionModule({ keyDeriver, authorizationTTL: 0 })).toThrow(
      /authorizationTTL/
    )
    expect(
      () => new RabinPermissionModule({ keyDeriver, authorizationTTL: 24 * 60 * 60 * 1000 + 1 })
    ).toThrow(/authorizationTTL/)
    expect(() => new RabinPermissionModule({ keyDeriver, maxCachedKeys: 0 })).toThrow(
      /maxCachedKeys/
    )
    expect(() => new RabinPermissionModule({ keyDeriver, maxCachedKeys: 1.5 })).toThrow(
      /maxCachedKeys/
    )
    expect(() => new RabinPermissionModule({ keyDeriver, maxMessageBytes: 1024 })).toThrow(
      /maxMessageBytes/
    )
    expect(() => new RabinPermissionModule({ keyDeriver, maxMessageBytes: '1' as never })).toThrow(
      /maxMessageBytes/
    )
    expect(() => new RabinPermissionModule({ keyDeriver, authorize: false as never })).toThrow(
      /authorize must be a function/
    )
    expect(
      () => new RabinPermissionModule({ keyDeriver, privilegedKeyDeriver: false as never })
    ).toThrow(/privilegedKeyDeriver must be a function/)
    expect(() => new RabinPermissionModule(Object.create({ keyDeriver }) as never)).toThrow(
      /plain data object/
    )
  })
})

describe('RabinPermissionModule authorization', () => {
  const levelArgs = (level: 0 | 1 | 2, overrides = {}) =>
    encryptArgs('sign', { protocolID: [level, 'p rabin sign 2048 example oracle'], ...overrides })

  it('does not prompt for ordinary level 0 requests', async () => {
    const authorize = jest.fn(async () => true)
    const instance = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(21)),
      authorize
    })
    await execute(instance, levelArgs(0))
    await execute(instance, encryptArgs('key'))
    expect(authorize).not.toHaveBeenCalled()
  })

  it('shares one level 1 prompt across concurrent calls and scopes it to the protocol, not the key', async () => {
    let approve!: (approved: boolean) => void
    const decision = new Promise<boolean>(resolve => {
      approve = resolve
    })
    const authorize = jest.fn(async (_request: RabinAuthorizationRequest) => await decision)
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(22))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const instance = new RabinPermissionModule({ keyDeriver, authorize })

    const first = observe(execute(instance, levelArgs(1)))
    const second = observe(execute(instance, levelArgs(1, { keyID: 'feed 2' })))
    await Promise.resolve()
    expect(derivePrivateKey).not.toHaveBeenCalled()
    approve(true)
    expect((await Promise.all([first, second])).every(outcome => outcome.ok)).toBe(true)
    await execute(
      instance,
      encryptArgs('key', { protocolID: [1, 'p rabin key 3072 example oracle'] })
    )
    await execute(instance, levelArgs(1), 'encrypt', 'other.example')

    expect(authorize).toHaveBeenCalledTimes(2)
    expect(authorize.mock.calls[0][0]).toEqual({
      originator: ORIGINATOR,
      securityLevel: 1,
      logicalProtocolID: 'example oracle',
      keyID: 'feed 1',
      counterparty: 'self',
      privileged: false,
      privilegedReason: undefined,
      operation: 'sign',
      bits: 2048,
      messageLength: 3,
      messageSha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    })
    expect(authorize.mock.calls[1][0]).toMatchObject({ originator: 'other.example' })
  }, 30_000)

  it('reports key requests to the authorization handler without message fields', async () => {
    const authorize = jest.fn(async (_request: RabinAuthorizationRequest) => false)
    const instance = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(23)),
      authorize
    })
    // Denied, so no 4096-bit key is generated.
    await expect(
      execute(instance, encryptArgs('key', { protocolID: [2, 'p rabin key 4096 example oracle'] }))
    ).rejects.toThrow('denied')
    expect(authorize.mock.calls[0][0]).toMatchObject({
      operation: 'key',
      bits: 4096,
      securityLevel: 2
    })
    expect(authorize.mock.calls[0][0]).not.toHaveProperty('messageSha256')
  })

  it('scopes level 2 grants by counterparty and clears them on dispose', async () => {
    const authorize = jest.fn(async () => true)
    const instance = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(24)),
      authorize
    })
    const b = vectors.parameters.walletBIdentity
    const c = new PrivateKey(99).toPublicKey().toString()
    await execute(instance, levelArgs(2, { counterparty: b }))
    await execute(instance, levelArgs(2, { counterparty: b }))
    await execute(instance, levelArgs(2, { counterparty: c }))
    instance.dispose()
    await execute(instance, levelArgs(2, { counterparty: b }))
    expect(authorize).toHaveBeenCalledTimes(3)
  }, 30_000)

  it('expires grants after the TTL', async () => {
    let now = 1_000_000
    const clock = jest.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      const authorize = jest.fn(async () => true)
      const instance = new RabinPermissionModule({
        keyDeriver: new CachedKeyDeriver(new PrivateKey(25)),
        authorize,
        authorizationTTL: 1000
      })
      await execute(instance, levelArgs(1))
      now += 999
      await execute(instance, levelArgs(1))
      expect(authorize).toHaveBeenCalledTimes(1)
      now += 1
      await execute(instance, levelArgs(1))
      expect(authorize).toHaveBeenCalledTimes(2)
    } finally {
      clock.mockRestore()
    }
  }, 30_000)

  it('honors seekPermission false and denial without deriving', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(26))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const authorize = jest.fn(async () => false)
    const instance = new RabinPermissionModule({ keyDeriver, authorize })

    await expect(execute(instance, levelArgs(1, { seekPermission: false }))).rejects.toThrow(
      'RABIN: permission is required and seekPermission is false'
    )
    expect(authorize).not.toHaveBeenCalled()
    await expect(execute(instance, levelArgs(1))).rejects.toThrow('RABIN: user denied permission')
    authorize.mockResolvedValueOnce('yes' as never)
    await expect(execute(instance, levelArgs(1))).rejects.toThrow('RABIN: user denied permission')
    authorize.mockImplementationOnce(() => {
      throw new Error('prompt crashed')
    })
    await expect(execute(instance, levelArgs(1))).rejects.toThrow('prompt crashed')
    expect(derivePrivateKey).not.toHaveBeenCalled()

    authorize.mockResolvedValueOnce(true)
    await execute(instance, levelArgs(1))
    await expect(
      execute(instance, levelArgs(1, { seekPermission: false }))
    ).resolves.toHaveProperty('ciphertext')
  })

  it('fails closed without an authorization handler, including privileged level 0', async () => {
    const instance = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(27)),
      privilegedKeyDeriver: async () => new CachedKeyDeriver(new PrivateKey(28))
    })
    await expect(execute(instance, levelArgs(1))).rejects.toThrow('no authorization handler')
    await expect(
      execute(instance, levelArgs(0, { privileged: true, privilegedReason: 'Oracle signing' }))
    ).rejects.toThrow('no authorization handler')
  })

  it('ignores an ambient authorization handler inherited by constructor options', async () => {
    const ambient = jest.fn(async () => true)
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'authorize')
    Object.defineProperty(Object.prototype, 'authorize', {
      configurable: true,
      enumerable: true,
      value: ambient
    })
    try {
      const instance = new RabinPermissionModule({
        keyDeriver: new CachedKeyDeriver(new PrivateKey(28))
      })
      await expect(execute(instance, levelArgs(1))).rejects.toThrow('no authorization handler')
      expect(ambient).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete (Object.prototype as { authorize?: unknown }).authorize
      else Object.defineProperty(Object.prototype, 'authorize', previous)
    }
  })

  it('keeps ordinary and privileged grants and keys apart', async () => {
    const ordinary = new CachedKeyDeriver(new PrivateKey(29))
    const privileged = new CachedKeyDeriver(new PrivateKey(30))
    const derivePrivileged = jest.spyOn(privileged, 'derivePrivateKey')
    const authorize = jest.fn(async () => true)
    const privilegedKeyDeriver = jest.fn(async () => privileged)
    const instance = new RabinPermissionModule({
      keyDeriver: ordinary,
      authorize,
      privilegedKeyDeriver
    })
    const privilegedArgs = (privilegedReason: string) =>
      encryptArgs('key', {
        protocolID: [1, 'p rabin key 2048 example oracle'],
        privileged: true,
        privilegedReason
      })

    const plain = await execute(
      instance,
      encryptArgs('key', { protocolID: [1, 'p rabin key 2048 example oracle'] })
    )
    const first = await execute(instance, privilegedArgs('Oracle signing'))
    const second = await execute(instance, privilegedArgs('Oracle signing'))
    await execute(instance, privilegedArgs('Other reason'))

    expect(first.ciphertext).not.toEqual(plain.ciphertext)
    expect(second).toEqual(first)
    expect(authorize).toHaveBeenCalledTimes(3)
    expect(privilegedKeyDeriver).toHaveBeenCalledWith('Oracle signing')
    // Privileged keys are not cached: every request derives again.
    expect(derivePrivileged).toHaveBeenCalledTimes(3)
  }, 30_000)

  it('fails closed when privileged derivation is unavailable or invalid', async () => {
    const args = encryptArgs('key', { privileged: true, privilegedReason: 'Oracle signing' })
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(31))
    const authorize = jest.fn(async () => true)
    const without = new RabinPermissionModule({ keyDeriver, authorize })
    const invalid = new RabinPermissionModule({
      keyDeriver,
      authorize: async () => true,
      privilegedKeyDeriver: async () => null as never
    })
    await expect(execute(without, args)).rejects.toThrow('privileged key derivation is unavailable')
    // Without a provider the request fails before the user is asked to approve it.
    expect(authorize).not.toHaveBeenCalled()
    await expect(execute(invalid, args)).rejects.toThrow(
      'privileged key provider returned an invalid deriver'
    )
  })

  it('caps cached and pending authorization state', async () => {
    const authorize = jest.fn(async () => true)
    const instance = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(32)),
      authorize
    })
    const levelOneKey = encryptArgs('key', { protocolID: [1, 'p rabin key 2048 example oracle'] })
    for (let i = 0; i < 1025; i++)
      await execute(instance, levelOneKey, 'encrypt', `origin-${i}.example`)
    expect(authorize).toHaveBeenCalledTimes(1025)
    await execute(instance, levelOneKey, 'encrypt', 'origin-0.example')
    expect(authorize).toHaveBeenCalledTimes(1026)

    const pending = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(33)),
      authorize: async () => await new Promise<boolean>(() => {})
    })
    for (let i = 0; i < 64; i++)
      void observe(execute(pending, levelArgs(1), 'encrypt', `pending-${i}.example`))
    await expect(execute(pending, levelArgs(1), 'encrypt', 'overflow.example')).rejects.toThrow(
      'authorization queue is full'
    )
  }, 30_000)

  it('caps pending prompts per app so one app cannot block the others', async () => {
    const authorize = jest.fn(async () => await new Promise<boolean>(() => {}))
    const instance = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(35)),
      authorize
    })
    const protocol = (i: number) =>
      encryptArgs('key', { protocolID: [1, `p rabin key 2048 flood protocol ${i}`] })
    for (let i = 0; i < 4; i++)
      void observe(execute(instance, protocol(i), 'encrypt', 'flood.example'))
    await expect(execute(instance, protocol(4), 'encrypt', 'flood.example')).rejects.toThrow(
      'RABIN: too many pending authorizations for this app'
    )
    // A request that joins an existing pending prompt does not count again.
    void observe(execute(instance, protocol(0), 'encrypt', 'flood.example'))
    void observe(execute(instance, protocol(0), 'encrypt', 'other.example'))
    expect(authorize).toHaveBeenCalledTimes(5)
  })

  it('keeps counting pending prompts per app correctly across dispose', async () => {
    const resolvers: Array<(approved: boolean) => void> = []
    const authorize = jest.fn(
      async () => await new Promise<boolean>(resolve => resolvers.push(resolve))
    )
    const instance = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(36)),
      authorize
    })
    const pend = (i: number) =>
      observe(
        execute(
          instance,
          encryptArgs('key', { protocolID: [1, `p rabin key 2048 flood protocol ${i}`] }),
          'encrypt',
          'flood.example'
        )
      )
    const before = [0, 1, 2, 3].map(pend)
    instance.dispose()
    const after = [10, 11, 12, 13].map(pend)
    // The prompts from before dispose settle; that must not free places in the new count.
    resolvers.slice(0, 4).forEach(resolve => resolve(false))
    await Promise.all(before)
    await expect(
      execute(
        instance,
        encryptArgs('key', { protocolID: [1, 'p rabin key 2048 flood protocol 20'] }),
        'encrypt',
        'flood.example'
      )
    ).rejects.toThrow('RABIN: too many pending authorizations for this app')
    expect(authorize).toHaveBeenCalledTimes(8)
    resolvers.slice(4).forEach(resolve => resolve(false))
    await Promise.all(after)
  })

  it('does not honor an approval that settles after dispose', async () => {
    let approve!: (approved: boolean) => void
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(34))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const instance = new RabinPermissionModule({
      keyDeriver,
      authorize: async () =>
        await new Promise<boolean>(resolve => {
          approve = resolve
        })
    })
    const outcome = observe(execute(instance, levelArgs(1)))
    await Promise.resolve()
    instance.dispose()
    approve(true)
    const result = await outcome
    expect(result.ok).toBe(false)
    expect(String((result as { error: unknown }).error)).toContain('reset during authorization')
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })
})

describe('RabinPermissionModule key cache', () => {
  it('reuses a cached key, keys the cache by size, and empties it on dispose', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(41))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const instance = new RabinPermissionModule({ keyDeriver })

    const first = await execute(instance, encryptArgs('sign'))
    await execute(instance, encryptArgs('sign', { plaintext: [1, 2, 3] }))
    await execute(instance, encryptArgs('key'))
    expect(derivePrivateKey).toHaveBeenCalledTimes(1)
    await execute(instance, encryptArgs('key', {}, 3072))
    expect(derivePrivateKey).toHaveBeenCalledTimes(2)
    instance.dispose()
    expect(await execute(instance, encryptArgs('sign'))).toEqual(first)
    expect(derivePrivateKey).toHaveBeenCalledTimes(3)
  }, 30_000)

  it('generates once for concurrent first requests', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(42))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const instance = new RabinPermissionModule({ keyDeriver })
    const results = await Promise.all([
      execute(instance, encryptArgs('key')),
      execute(instance, encryptArgs('sign')),
      execute(instance, encryptArgs('key'))
    ])
    expect(derivePrivateKey).toHaveBeenCalledTimes(1)
    expect(results[0]).toEqual(results[2])
  }, 30_000)

  it('serves concurrent distinct keys even when each evicts the previous one', async () => {
    const instance = new RabinPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(45)),
      maxCachedKeys: 1
    })
    const outcomes = await Promise.all(
      ['key a', 'key b', 'key c'].map(keyID =>
        observe(execute(instance, encryptArgs('key', { keyID })))
      )
    )
    expect(outcomes.map(outcome => outcome.ok)).toEqual([true, true, true])
  }, 30_000)

  it('evicts the least recently used key at the bound', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(43))
    const derivePrivateKey = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const instance = new RabinPermissionModule({ keyDeriver, maxCachedKeys: 2 })
    const keyFor = (keyID: string) => execute(instance, encryptArgs('key', { keyID }))

    const a = await keyFor('key a')
    await keyFor('key b')
    await keyFor('key a')
    await keyFor('key c')
    expect(derivePrivateKey).toHaveBeenCalledTimes(3)
    expect(await keyFor('key a')).toEqual(a)
    expect(derivePrivateKey).toHaveBeenCalledTimes(3)
    await keyFor('key b')
    expect(derivePrivateKey).toHaveBeenCalledTimes(4)
  }, 30_000)

  it('fails requests whose generation was overtaken by dispose and shares deriver failures', async () => {
    const real = new CachedKeyDeriver(new PrivateKey(44))
    let instance!: RabinPermissionModule
    const disposingDeriver = {
      derivePrivateKey: jest.fn((...args: Parameters<CachedKeyDeriver['derivePrivateKey']>) => {
        // The wallet locks while this key is being generated.
        instance.dispose()
        return real.derivePrivateKey(...args)
      })
    }
    instance = new RabinPermissionModule({ keyDeriver: disposingDeriver })
    const outcome = await observe(execute(instance, encryptArgs('key')))
    expect(outcome.ok).toBe(false)
    expect(String((outcome as { error: unknown }).error)).toContain('reset during key generation')
    expect(disposingDeriver.derivePrivateKey).toHaveBeenCalledTimes(1)

    const failingDerive = jest.fn(() => {
      throw new Error('RABIN: key deriver unavailable')
    })
    const failing = new RabinPermissionModule({
      keyDeriver: { derivePrivateKey: failingDerive }
    })
    const outcomes = await Promise.all([
      observe(execute(failing, encryptArgs('key'))),
      observe(execute(failing, encryptArgs('sign')))
    ])
    expect(outcomes.map(o => o.ok)).toEqual([false, false])
    // The two concurrent requests shared one attempt; a failure is not cached.
    expect(failingDerive).toHaveBeenCalledTimes(1)
    await expect(execute(failing, encryptArgs('key'))).rejects.toThrow('key deriver unavailable')
    expect(failingDerive).toHaveBeenCalledTimes(2)
  }, 30_000)
})
