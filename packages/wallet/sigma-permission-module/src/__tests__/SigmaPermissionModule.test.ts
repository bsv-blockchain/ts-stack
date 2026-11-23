import { BigNumber, CachedKeyDeriver, Curve, Hash, KeyDeriver, PrivateKey, Utils } from '@bsv/sdk'
import { jest } from '@jest/globals'
import {
  createSigmaModule,
  parsePoint33,
  point64,
  SigmaPermissionModule,
  verifyDleq,
  verifyOr,
  verifySchnorr
} from '../index.js'
import type { SigmaAuthorizationHandler, SigmaKeyDeriver } from '../index.js'
import { call, next, observe } from './helpers.js'

const curve = new Curve()
const ctx = [1, 2, 3, 4, 5]
const H33 = curve.g.mul(new BigNumber(7)).encode(true) as number[]
const levelOne = (operation: string): Record<string, unknown> => ({
  protocolID: [1, `p sigma ${operation} example payout`]
})
const make = (seed = 2): SigmaPermissionModule =>
  new SigmaPermissionModule({ keyDeriver: new CachedKeyDeriver(new PrivateKey(seed)) })

describe('SigmaPermissionModule operations', () => {
  it('key returns the 33-byte statement point and proofs verify under it', async () => {
    const m = make()
    const result = (await call(m, 'key', [])).ciphertext
    expect(result).toHaveLength(33)
    const P = parsePoint33(result, 'P')
    expect(verifySchnorr(P, ctx, (await call(m, 'schnorr', ctx)).ciphertext)).toBe(true)
  })

  it('key with H returns x·H, the same point dleq leads with', async () => {
    const m = make()
    const viaKey = parsePoint33((await call(m, 'key', H33)).ciphertext, 'P2')
    const proof = (await call(m, 'dleq', [...H33, ...ctx])).ciphertext
    expect(proof.slice(0, 64)).toEqual(point64(viaKey))
    const P = parsePoint33((await call(m, 'key', [])).ciphertext, 'P')
    expect(verifyDleq(P, parsePoint33(H33, 'H'), ctx, proof)).toBe(true)
  })

  it('or inserts the wallet point at the requested position', async () => {
    const m = make()
    const P = parsePoint33((await call(m, 'key', [])).ciphertext, 'P')
    const other = parsePoint33(H33, 'o')
    expect(
      verifyOr([other, P], ctx, (await call(m, 'or', [2, 2, ...H33, ...ctx])).ciphertext)
    ).toBe(true)
    expect(
      verifyOr([P, other], ctx, (await call(m, 'or', [2, 1, ...H33, ...ctx])).ciphertext)
    ).toBe(true)
  })

  it('refuses a ring that already contains the wallet point', async () => {
    const m = make()
    const P33 = (await call(m, 'key', [])).ciphertext
    await expect(call(m, 'or', [2, 1, ...P33, ...ctx])).rejects.toThrow()
  })

  it('is deterministic', async () => {
    const m = make()
    expect(await call(m, 'schnorr', ctx)).toEqual(await call(m, 'schnorr', ctx))
  })

  it('keyID, counterparty and logical protocol each select a different key', async () => {
    const m = make()
    const base = (await call(m, 'key', [])).ciphertext
    for (const o of [
      { keyID: 'member 2' },
      { counterparty: 'anyone' },
      { protocolID: [0, 'p sigma key other payout'] }
    ]) {
      expect((await call(m, 'key', [], o)).ciphertext).not.toEqual(base)
    }
  })

  it('all four operations address the same key', async () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(3))
    const derive = jest.spyOn(keyDeriver, 'derivePrivateKey')
    const m = new SigmaPermissionModule({ keyDeriver })
    await call(m, 'key', [])
    await call(m, 'schnorr', ctx)
    await call(m, 'dleq', [...H33, ...ctx])
    await call(m, 'or', [2, 1, ...H33, ...ctx])
    for (const args of derive.mock.calls) {
      expect(args).toEqual([[0, 'p sigma example payout'], 'member 1', 'self'])
    }
    expect(derive).toHaveBeenCalledTimes(4)
  })

  it('scalar isolation: the statement point is not the public key of the derived child key', async () => {
    const m = make()
    const deriver = new KeyDeriver(new PrivateKey(2))
    for (const counterparty of ['self', 'anyone'] as const) {
      const P = parsePoint33((await call(m, 'key', [], { counterparty })).ciphertext, 'P')
      const child = deriver.derivePrivateKey(
        [0, 'p sigma example payout'],
        'member 1',
        counterparty
      )
      expect(P.eq(child.toPublicKey())).toBe(false)
    }
  })

  it('exports a factory', () => {
    expect(
      createSigmaModule({ keyDeriver: new CachedKeyDeriver(new PrivateKey(4)) })
    ).toBeInstanceOf(SigmaPermissionModule)
  })
})

describe('SigmaPermissionModule request validation', () => {
  it.each([
    'decrypt',
    'getPublicKey',
    'createSignature',
    'createHmac',
    'verifySignature',
    'revealSpecificKeyLinkage'
  ])('the module refuses %s when a request for it is routed to the module', async method => {
    await expect(
      make().handleRequest(
        {
          method,
          originator: 'app.example',
          args: { protocolID: [0, 'p sigma schnorr example payout'], keyID: 'member 1' }
        },
        next
      )
    ).rejects.toThrow(/not permitted/)
  })

  it.each([
    'p sigma sign example payout',
    'p sigma schnorr',
    'p sigma schnorr Example',
    'p sigma schnorr ab',
    'p sigma schnorr example  payout',
    'p sigma schnorr example protocol',
    `p sigma schnorr ${'a'.repeat(273)}`,
    `p sigma schnorr ${'a'.repeat(100_000)}`
  ])('refuses the protocol name %s', async name => {
    await expect(call(make(), 'schnorr', ctx, { protocolID: [0, name] })).rejects.toThrow()
  })

  it('accepts the logical protocol length boundaries', async () => {
    for (const name of ['abcde', 'a'.repeat(272)]) {
      await expect(
        call(make(), 'key', [], { protocolID: [0, `p sigma key ${name}`] })
      ).resolves.toHaveProperty('ciphertext')
    }
  })

  it.each([
    [{ keyID: '' }, /keyID/],
    [{ keyID: 42 }, /keyID/],
    [{ keyID: 'x'.repeat(801) }, /800 bytes/],
    [{ privileged: true }, /privilegedReason/],
    [{ privileged: true, privilegedReason: 'bad' }, /between 5 and 50/],
    [{ privileged: 'true', privilegedReason: 'Use protected key' }, /privileged must be a boolean/],
    [{ protocolID: [3, 'p sigma key example payout'] }, /invalid protocolID/],
    [{ protocolID: [0, 42] }, /invalid protocolID/],
    [{ protocolID: [0, 'p sigma key example payout', 'x'] }, /protocolID is required/],
    [{ counterparty: 42 }, /counterparty/],
    [{ counterparty: 'not a key' }, /33-byte/]
  ])('refuses invalid arguments %#', async (override, error) => {
    await expect(call(make(), 'key', [], override)).rejects.toThrow(error)
  })

  it('accepts a 800-byte keyID and a boundary privileged reason', async () => {
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(5)),
      authorize: async () => true,
      privilegedKeyDeriver: async () => new CachedKeyDeriver(new PrivateKey(6))
    })
    await expect(call(m, 'key', [], { keyID: 'x'.repeat(800) })).resolves.toBeDefined()
    for (const privilegedReason of ['abcde', 'x'.repeat(50)]) {
      await expect(
        call(m, 'key', [], { privileged: true, privilegedReason })
      ).resolves.toBeDefined()
    }
  })

  it.each([
    [[256], 'a non-byte element'],
    [[-1], 'a negative element'],
    [[1.5], 'a fractional element'],
    [['1'], 'a string element'],
    ['abc', 'a non-array'],
    [undefined, 'a missing plaintext'],
    [Array.from({ length: 9000 }, () => 1), 'an oversize plaintext']
  ])('refuses plaintext %j (%s) before asking or deriving', async (plaintext, _label) => {
    const authorize = jest.fn(async () => true)
    const derivePrivateKey = jest.fn<SigmaKeyDeriver['derivePrivateKey']>()
    const m = new SigmaPermissionModule({ keyDeriver: { derivePrivateKey }, authorize })
    await expect(call(m, 'schnorr', plaintext, levelOne('schnorr'))).rejects.toThrow()
    expect(authorize).not.toHaveBeenCalled()
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })

  it('refuses plaintext that does not parse for the operation', async () => {
    const authorize = jest.fn(async () => true)
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(7)),
      authorize
    })
    await expect(call(m, 'schnorr', [], levelOne('schnorr'))).rejects.toThrow()
    await expect(call(m, 'dleq', [1, 2], levelOne('dleq'))).rejects.toThrow()
    expect(authorize).not.toHaveBeenCalled()
  })

  it('refuses an invalid counterparty before deriving', async () => {
    const derivePrivateKey = jest.fn<SigmaKeyDeriver['derivePrivateKey']>()
    const m = new SigmaPermissionModule({ keyDeriver: { derivePrivateKey } })
    await expect(call(m, 'key', [], { counterparty: '04' + '00'.repeat(32) })).rejects.toThrow()
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })

  it('accepts a valid compressed counterparty', async () => {
    const counterparty = new PrivateKey(41).toPublicKey().toString()
    await expect(call(make(), 'key', [], { counterparty })).resolves.toBeDefined()
  })

  it('refuses malformed originators and request shapes', async () => {
    const m = make()
    await expect(call(m, 'key', [], {}, { originator: '' })).rejects.toThrow(/originator/)
    await expect(call(m, 'key', [], {}, { originator: 42 })).rejects.toThrow(/originator/)
    await expect(call(m, 'key', [], {}, { originator: 'bad\norigin' })).rejects.toThrow(
      /originator is invalid/
    )
    await expect(call(m, 'key', [], {}, { originator: 'a'.repeat(1025) })).rejects.toThrow(
      /originator is invalid/
    )
    await expect(
      m.handleRequest({ method: 'encrypt', originator: 'app.example', args: null as never }, next)
    ).rejects.toThrow(/must be an object/)
    await expect(
      m.handleRequest({ method: 'encrypt', originator: 'app.example', args: [] as never }, next)
    ).rejects.toThrow(/must be an object/)
  })

  it('rejects accessor-bearing and symbol-bearing requests without invoking accessors', async () => {
    const m = make()
    const getter = jest.fn(() => [0, 'p sigma key example payout'])
    const args = Object.defineProperty({ keyID: 'k', plaintext: [] }, 'protocolID', {
      enumerable: true,
      get: getter
    })
    await expect(
      m.handleRequest({ method: 'encrypt', originator: 'app.example', args }, next)
    ).rejects.toThrow('must not contain accessors')
    expect(getter).not.toHaveBeenCalled()
    const symbolArgs: Record<PropertyKey, unknown> = {
      protocolID: [0, 'p sigma key example payout'],
      keyID: 'k',
      plaintext: []
    }
    symbolArgs[Symbol('ambient')] = true
    await expect(
      m.handleRequest(
        { method: 'encrypt', originator: 'app.example', args: symbolArgs as object },
        next
      )
    ).rejects.toThrow('must not contain symbol properties')
    await expect(
      m.handleRequest(
        Object.create({ method: 'encrypt', originator: 'app.example', args: {} }),
        next
      )
    ).rejects.toThrow('must be a plain data object')
  })
})

describe('SigmaPermissionModule authorisation', () => {
  it('does not ask for level 0 requests', async () => {
    const authorize = jest.fn(async () => true)
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(8)),
      authorize
    })
    await call(m, 'schnorr', ctx)
    expect(authorize).not.toHaveBeenCalled()
  })

  it('the authorisation request carries the operation and the context digest, not the context', async () => {
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => true)
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(2)),
      authorize
    })
    await call(m, 'schnorr', ctx, levelOne('schnorr'))
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'schnorr',
        contextSha256: Utils.toHex(Hash.sha256(ctx))
      })
    )
    expect(JSON.stringify(authorize.mock.calls[0])).not.toContain('"ctx"')
    const lvl = (operation: string, name: string): Record<string, unknown> => ({
      protocolID: [1, `p sigma ${operation} ${name}`]
    })
    await call(m, 'key', [], lvl('key', 'example keyed'))
    expect(authorize.mock.calls[1]![0]).not.toHaveProperty('contextSha256')
    await call(m, 'dleq', [...H33, ...ctx], lvl('dleq', 'example proved'))
    expect(authorize.mock.calls[2]![0]).toEqual(
      expect.objectContaining({ operation: 'dleq', contextSha256: Utils.toHex(Hash.sha256(ctx)) })
    )
    await call(m, 'or', [2, 1, ...H33, ...ctx], lvl('or', 'example ringed'))
    expect(authorize.mock.calls[3]![0]).toEqual(
      expect.objectContaining({ operation: 'or', contextSha256: Utils.toHex(Hash.sha256(ctx)) })
    )
  })

  it("under 'grant' authorizes level 1 once per application and protocol, including concurrent calls", async () => {
    let resolveAuthorization!: (approved: boolean) => void
    const authorization = new Promise<boolean>(resolve => {
      resolveAuthorization = resolve
    })
    const authorize = jest.fn(async () => await authorization)
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(43)),
      authorize,
      proofAuthorization: 'grant'
    })
    const first = observe(call(m, 'schnorr', ctx, levelOne('schnorr')))
    const second = observe(call(m, 'schnorr', ctx, levelOne('schnorr')))
    resolveAuthorization(true)
    expect((await Promise.all([first, second])).every(o => o.ok)).toBe(true)
    await call(m, 'schnorr', [9, 9], { ...levelOne('schnorr'), keyID: 'another key' })
    expect(authorize).toHaveBeenCalledTimes(1)
    // operation and context do not change the grant scope
    await call(m, 'key', [], levelOne('key'))
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('expires a grant after the TTL', async () => {
    jest.useFakeTimers()
    try {
      const authorize = jest.fn(async () => true)
      const m = new SigmaPermissionModule({
        keyDeriver: new CachedKeyDeriver(new PrivateKey(44)),
        authorize,
        authorizationTTL: 1000
      })
      await call(m, 'key', [], levelOne('key'))
      jest.advanceTimersByTime(500)
      await call(m, 'key', [], levelOne('key'))
      expect(authorize).toHaveBeenCalledTimes(1)
      jest.advanceTimersByTime(600)
      await call(m, 'key', [], levelOne('key'))
      expect(authorize).toHaveBeenCalledTimes(2)
    } finally {
      jest.useRealTimers()
    }
  })

  it('scopes level 2 grants by counterparty and refuses every request after dispose', async () => {
    const authorize = jest.fn(async () => true)
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(47)),
      authorize
    })
    const first = new PrivateKey(53).toPublicKey().toString()
    const second = new PrivateKey(59).toPublicKey().toString()
    const levelTwo = (counterparty: string): Record<string, unknown> => ({
      protocolID: [2, 'p sigma key example payout'],
      counterparty
    })
    await call(m, 'key', [], levelTwo(first))
    await call(m, 'key', [], levelTwo(first))
    await call(m, 'key', [], levelTwo(second))
    expect(authorize).toHaveBeenCalledTimes(2)
    m.dispose()
    await expect(call(m, 'key', [], levelTwo(first))).rejects.toThrow(/disposed/)
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('does not scope level 1 grants by counterparty', async () => {
    const authorize = jest.fn(async () => true)
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(48)),
      authorize
    })
    await call(m, 'key', [], levelOne('key'))
    await call(m, 'key', [], { ...levelOne('key'), counterparty: 'anyone' })
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('seekPermission false at level 1 fails without asking or deriving', async () => {
    const authorize = jest.fn<SigmaAuthorizationHandler>()
    const derivePrivateKey = jest.fn<SigmaKeyDeriver['derivePrivateKey']>()
    const m = new SigmaPermissionModule({ keyDeriver: { derivePrivateKey }, authorize })
    await expect(
      call(m, 'schnorr', ctx, { ...levelOne('schnorr'), seekPermission: false })
    ).rejects.toThrow(/seekPermission/)
    expect(authorize).not.toHaveBeenCalled()
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })

  it('denial fails without deriving', async () => {
    const derivePrivateKey = jest.fn<SigmaKeyDeriver['derivePrivateKey']>()
    const authorize = jest.fn(async () => false)
    const m = new SigmaPermissionModule({ keyDeriver: { derivePrivateKey }, authorize })
    await expect(call(m, 'key', [], levelOne('key'))).rejects.toThrow(/denied/)
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })

  it('fails closed when no authorization handler is configured', async () => {
    const m = make()
    await expect(call(m, 'key', [], levelOne('key'))).rejects.toThrow(/authorization handler/)
    await expect(
      call(m, 'key', [], { privileged: true, privilegedReason: 'Use protected key' })
    ).rejects.toThrow(/authorization handler/)
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
      const m = make(9)
      await expect(call(m, 'key', [], levelOne('key'))).rejects.toThrow(/authorization handler/)
      expect(ambient).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) delete (Object.prototype as { authorize?: unknown }).authorize
      else Object.defineProperty(Object.prototype, 'authorize', previous)
    }
  })

  it('caps cached and pending authorization state', async () => {
    const authorize = jest.fn(async () => true)
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(103)),
      authorize
    })
    for (let i = 0; i < 1025; i++) {
      await call(m, 'key', [], levelOne('key'), { originator: `origin-${i}.example` })
    }
    expect(authorize).toHaveBeenCalledTimes(1025)
    await call(m, 'key', [], levelOne('key'), { originator: 'origin-0.example' })
    expect(authorize).toHaveBeenCalledTimes(1026)

    const never = new Promise<boolean>(() => {})
    const pendingModule = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(104)),
      authorize: async () => await never
    })
    for (let i = 0; i < 64; i++) {
      void observe(
        call(pendingModule, 'key', [], levelOne('key'), { originator: `pending-${i}.example` })
      )
    }
    await expect(
      call(pendingModule, 'key', [], levelOne('key'), { originator: 'pending-overflow.example' })
    ).rejects.toThrow('authorization queue is full')
  })
})

describe('SigmaPermissionModule privileged requests', () => {
  it('authorizes before fetching the privileged deriver and forwards the reason', async () => {
    const order: string[] = []
    const privileged = new CachedKeyDeriver(new PrivateKey(71))
    const authorize = jest.fn(async () => {
      order.push('authorize')
      return true
    })
    const privilegedKeyDeriver = jest.fn(async () => {
      order.push('fetch')
      return privileged
    })
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(67)),
      privilegedKeyDeriver,
      authorize
    })
    const regular = await call(m, 'key', [])
    const result = await call(m, 'key', [], {
      privileged: true,
      privilegedReason: 'Protect the private key'
    })
    expect(result).not.toEqual(regular)
    expect(order).toEqual(['authorize', 'fetch'])
    expect(privilegedKeyDeriver).toHaveBeenCalledWith('Protect the private key')
    expect(authorize).toHaveBeenCalledWith(
      expect.objectContaining({ privileged: true, privilegedReason: 'Protect the private key' })
    )
  })

  it('does not fetch the privileged deriver when authorization is denied', async () => {
    const privilegedKeyDeriver = jest.fn(async () => new CachedKeyDeriver(new PrivateKey(70)))
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(69)),
      privilegedKeyDeriver,
      authorize: async () => false
    })
    await expect(
      call(m, 'key', [], { privileged: true, privilegedReason: 'Protect the private key' })
    ).rejects.toThrow(/denied/)
    expect(privilegedKeyDeriver).not.toHaveBeenCalled()
  })

  it('scopes cached privileged grants to the exact approved reason', async () => {
    const authorize = jest.fn(async () => true)
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(73)),
      authorize,
      privilegedKeyDeriver: async () => new CachedKeyDeriver(new PrivateKey(72))
    })
    const priv = (privilegedReason: string): Record<string, unknown> => ({
      privileged: true,
      privilegedReason
    })
    await call(m, 'key', [], priv('Protect the private key'))
    await call(m, 'key', [], priv('Protect the private key'))
    await call(m, 'key', [], priv('Protect the shuffle nonce'))
    expect(authorize).toHaveBeenCalledTimes(2)
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
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(74)),
      authorize,
      privilegedKeyDeriver: async () => new CachedKeyDeriver(new PrivateKey(75))
    })
    const first = observe(
      call(m, 'key', [], { privileged: true, privilegedReason: 'Protect the private key' })
    )
    const second = observe(
      call(m, 'key', [], { privileged: true, privilegedReason: 'Protect the shuffle nonce' })
    )
    expect(authorize).toHaveBeenCalledTimes(2)
    resolvers[0]!(true)
    resolvers[1]!(true)
    expect((await Promise.all([first, second])).every(o => o.ok)).toBe(true)
  })

  it('does not pass a privilegedReason to the handler for a request that is not privileged', async () => {
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => true)
    const m = new SigmaPermissionModule({
      keyDeriver: new CachedKeyDeriver(new PrivateKey(76)),
      authorize
    })
    await call(m, 'key', [], { ...levelOne('key'), privilegedReason: 'Unchecked reason text' })
    await call(m, 'key', [], { ...levelOne('key'), privileged: false, privilegedReason: 42 })
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(authorize.mock.calls[0]![0].privileged).toBe(false)
    expect(authorize.mock.calls[0]![0].privilegedReason).toBeUndefined()
  })

  it('fails closed when a privileged key provider is missing or invalid', async () => {
    const ordinary = new CachedKeyDeriver(new PrivateKey(98))
    const args = { privileged: true, privilegedReason: 'Use protected key' }
    const without = new SigmaPermissionModule({ keyDeriver: ordinary, authorize: async () => true })
    const invalid = new SigmaPermissionModule({
      keyDeriver: ordinary,
      authorize: async () => true,
      privilegedKeyDeriver: async () => null as never
    })
    await expect(call(without, 'key', [], args)).rejects.toThrow(/unavailable/)
    await expect(call(invalid, 'key', [], args)).rejects.toThrow(/invalid deriver/)
  })
})

describe('SigmaPermissionModule options', () => {
  it('validates constructor options', () => {
    const keyDeriver = new CachedKeyDeriver(new PrivateKey(101))
    expect(() => new SigmaPermissionModule({ keyDeriver: {} as never })).toThrow(/keyDeriver/)
    expect(() => new SigmaPermissionModule({ keyDeriver, authorizationTTL: 0 })).toThrow(
      /authorizationTTL/
    )
    expect(
      () => new SigmaPermissionModule({ keyDeriver, authorizationTTL: 24 * 3600 * 1000 + 1 })
    ).toThrow(/authorizationTTL/)
    expect(() => new SigmaPermissionModule({ keyDeriver, authorize: false as never })).toThrow(
      /authorize must be a function/
    )
    expect(
      () => new SigmaPermissionModule({ keyDeriver, privilegedKeyDeriver: false as never })
    ).toThrow(/privilegedKeyDeriver must be a function/)
    expect(() => new SigmaPermissionModule(Object.create({ keyDeriver }) as never)).toThrow(
      /plain data object/
    )
    expect(
      () => new SigmaPermissionModule({ keyDeriver, authorizationTTL: 24 * 3600 * 1000 })
    ).not.toThrow()
  })
})

describe('SigmaPermissionModule boundaries', () => {
  const ringPoints = (count: number): number[] =>
    Array.from({ length: count }, (_, i) => point33(10 + i)).flat()
  const point33 = (k: number): number[] => curve.g.mul(new BigNumber(k)).encode(true) as number[]

  it('refuses an uppercase compressed counterparty without deriving', async () => {
    const derivePrivateKey = jest.fn<SigmaKeyDeriver['derivePrivateKey']>()
    const m = new SigmaPermissionModule({ keyDeriver: { derivePrivateKey } })
    const counterparty = new PrivateKey(41).toPublicKey().toString().toUpperCase()
    await expect(call(m, 'key', [], { counterparty })).rejects.toThrow(/lowercase/)
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })

  it('refuses an absent originator', async () => {
    await expect(
      make().handleRequest(
        {
          method: 'encrypt',
          originator: undefined as never,
          args: { protocolID: [0, 'p sigma key example payout'], keyID: 'k', plaintext: [] }
        },
        next
      )
    ).rejects.toThrow(/originator is required/)
  })

  it('reads the plaintext length once, so a growing Proxy array cannot extend the copy', async () => {
    let reads = 0
    const plaintext = new Proxy([] as number[], {
      get(target, prop) {
        if (prop === 'length') return ++reads === 1 ? 4 : 1_000_000_000
        if (typeof prop === 'string' && /^\d+$/.test(prop)) return 1
        return Reflect.get(target, prop)
      }
    })
    expect(Array.isArray(plaintext)).toBe(true)
    const result = await call(make(), 'schnorr', plaintext)
    expect(reads).toBe(1)
    expect(
      verifySchnorr(
        parsePoint33((await call(make(), 'key', [])).ciphertext, 'P'),
        [1, 1, 1, 1],
        result.ciphertext
      )
    ).toBe(true)
  })

  it('accepts the longest valid protocol name and refuses one more character', async () => {
    const name = (n: number): string => `p sigma schnorr ${'a'.repeat(n)}`
    expect(name(272)).toHaveLength(288)
    const result = await call(make(), 'schnorr', ctx, { protocolID: [0, name(272)] })
    expect(result.ciphertext).toHaveLength(96)
    await expect(call(make(), 'schnorr', ctx, { protocolID: [0, name(273)] })).rejects.toThrow()
  })

  it('accepts the longest valid or plaintext and refuses a 4,097-byte context', async () => {
    const m = make()
    const P = parsePoint33((await call(m, 'key', [])).ciphertext, 'P')
    const bigCtx = Array.from({ length: 4096 }, (_, i) => i % 256)
    const plaintext = [8, 1, ...ringPoints(7), ...bigCtx]
    expect(plaintext).toHaveLength(4329)
    const { ciphertext } = await call(m, 'or', plaintext)
    const ring = [P, ...Array.from({ length: 7 }, (_, i) => parsePoint33(point33(10 + i), 'o'))]
    expect(verifyOr(ring, bigCtx, ciphertext)).toBe(true)
    await expect(call(m, 'or', [...plaintext, 0])).rejects.toThrow()
  })
})

describe('proof authorization', () => {
  const keyDeriver = new CachedKeyDeriver(new PrivateKey(111))
  const H = H33
  const point33 = (k: number): number[] => curve.g.mul(new BigNumber(k)).encode(true) as number[]
  const ring = (k = 13, index = 1): number[] => [2, index, ...point33(k)]
  const ctxOf = (n: number): number[] => [n, n, n]
  const sha256Hex = (bytes: number[]): string => Utils.toHex(Hash.sha256(bytes))
  type Overrides = Record<string, unknown>
  const callKey = async (m: SigmaPermissionModule, base: number[] = []): Promise<unknown> =>
    await call(m, 'key', base, levelOne('key'))
  const callSchnorr = async (m: SigmaPermissionModule, context: number[]): Promise<unknown> =>
    await call(m, 'schnorr', context, levelOne('schnorr'))
  const callDleq = async (
    m: SigmaPermissionModule,
    base: number[],
    context: number[]
  ): Promise<unknown> => await call(m, 'dleq', [...base, ...context], levelOne('dleq'))
  const callOr = async (
    m: SigmaPermissionModule,
    context: number[],
    overrides: Overrides = {},
    members: number[] = ring()
  ): Promise<unknown> =>
    await call(m, 'or', [...members, ...context], { ...levelOne('or'), ...overrides })
  const deferred = (): { promise: Promise<boolean>; resolve: (approved: boolean) => void } => {
    let resolve!: (approved: boolean) => void
    const promise = new Promise<boolean>(r => {
      resolve = r
    })
    return { promise, resolve }
  }

  it('asks for every proof by default and remembers only the plain public key', async () => {
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => true)
    const m = new SigmaPermissionModule({ keyDeriver, authorize })
    await callKey(m)
    await callOr(m, ctxOf(1))
    await callOr(m, ctxOf(1))
    await callSchnorr(m, ctxOf(2))
    await callKey(m)
    expect(authorize.mock.calls.map(c => c[0].operation)).toEqual(['key', 'or', 'or', 'schnorr'])
  })

  it('remembers the plain public key across key IDs, as a grant does', async () => {
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => true)
    const m = new SigmaPermissionModule({ keyDeriver, authorize })
    await callKey(m)
    await call(m, 'key', [], { ...levelOne('key'), keyID: 'member 2' })
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it('asks every time for key with a base', async () => {
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => true)
    const m = new SigmaPermissionModule({ keyDeriver, authorize })
    await callKey(m, H)
    await callKey(m, H)
    await callKey(m)
    expect(authorize.mock.calls.map(c => [c[0].operation, c[0].applicationBase])).toEqual([
      ['key', true],
      ['key', true],
      ['key', false]
    ])
  })

  it('does not let a remembered public key cover a proof, or a pending one answer it', async () => {
    const decision = deferred()
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => await decision.promise)
    const m = new SigmaPermissionModule({ keyDeriver, authorize })
    const key = observe(callKey(m))
    const proof = observe(callOr(m, ctxOf(1)))
    decision.resolve(true)
    expect((await Promise.all([key, proof])).every(o => o.ok)).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(2)
    await callOr(m, ctxOf(1))
    expect(authorize).toHaveBeenCalledTimes(3)
  })

  it('shares one decision between identical concurrent proofs only', async () => {
    const decision = deferred()
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => await decision.promise)
    const m = new SigmaPermissionModule({ keyDeriver, authorize })
    const results = [
      observe(callOr(m, ctxOf(1), { keyID: 'member 1' })),
      observe(callOr(m, ctxOf(1), { keyID: 'member 1' })),
      observe(callOr(m, ctxOf(1), { keyID: 'member 2' })),
      observe(callOr(m, ctxOf(1), { keyID: 'member 1' }, ring(17)))
    ]
    decision.resolve(true)
    expect((await Promise.all(results)).every(o => o.ok)).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(3)
  })

  it('does not share a decision between proofs for different counterparties', async () => {
    const decision = deferred()
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => await decision.promise)
    const m = new SigmaPermissionModule({ keyDeriver, authorize })
    const counterparty = new PrivateKey(41).toPublicKey().toString()
    const results = [
      observe(callOr(m, ctxOf(1), { counterparty: 'self' })),
      observe(callOr(m, ctxOf(1), { counterparty }))
    ]
    decision.resolve(true)
    expect((await Promise.all(results)).every(o => o.ok)).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it('a denied proof is not remembered as a denial', async () => {
    const authorize = jest
      .fn<SigmaAuthorizationHandler>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
    const m = new SigmaPermissionModule({ keyDeriver, authorize })
    await expect(callSchnorr(m, ctxOf(2))).rejects.toThrow(/denied/)
    await expect(callSchnorr(m, ctxOf(2))).resolves.toBeDefined()
    expect(authorize).toHaveBeenCalledTimes(2)
  })

  it("under 'grant' one approval covers every operation", async () => {
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => true)
    const m = new SigmaPermissionModule({ keyDeriver, authorize, proofAuthorization: 'grant' })
    await callKey(m)
    await callOr(m, ctxOf(1))
    await callSchnorr(m, ctxOf(2))
    await callDleq(m, H, ctxOf(3))
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it("under 'grant' concurrent requests in one scope share one decision", async () => {
    const decision = deferred()
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => await decision.promise)
    const m = new SigmaPermissionModule({ keyDeriver, authorize, proofAuthorization: 'grant' })
    const results = [observe(callKey(m)), observe(callOr(m, ctxOf(1))), observe(callKey(m, H))]
    decision.resolve(true)
    expect((await Promise.all(results)).every(o => o.ok)).toBe(true)
    expect(authorize).toHaveBeenCalledTimes(1)
  })

  it("tells the host whether the base is the application's, and hashes the whole input", async () => {
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => true)
    const m = new SigmaPermissionModule({ keyDeriver, authorize })
    const plaintexts: Array<[string, number[]]> = [
      ['key', []],
      ['key', H],
      ['schnorr', ctxOf(2)],
      ['dleq', [...H, ...ctxOf(3)]],
      ['or', [...ring(), ...ctxOf(4)]]
    ]
    for (const [operation, plaintext] of plaintexts) {
      await call(m, operation as 'key', plaintext, levelOne(operation))
    }
    const requests = authorize.mock.calls.map(c => c[0])
    expect(requests.map(r => r.applicationBase)).toEqual([false, true, false, true, false])
    requests.forEach((r, i) => {
      expect(r.inputSha256).toBe(sha256Hex(plaintexts[i]![1]))
    })
    expect(requests[0]!.inputSha256).toBe(sha256Hex([]))
    expect(requests[0]!.inputSha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('fails a decision that was pending when the module was disposed, without deriving a key', async () => {
    const decision = deferred()
    const authorize = jest.fn<SigmaAuthorizationHandler>(async () => await decision.promise)
    const derivePrivateKey = jest.fn<SigmaKeyDeriver['derivePrivateKey']>()
    const m = new SigmaPermissionModule({ keyDeriver: { derivePrivateKey }, authorize })
    const pending = observe(callOr(m, ctxOf(1)))
    m.dispose()
    decision.resolve(true)
    const result = await pending
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ message: expect.stringMatching(/disposed/) })
    })
    expect(derivePrivateKey).not.toHaveBeenCalled()
    await expect(callKey(m)).rejects.toThrow(/disposed/)
    await expect(call(m, 'key', [])).rejects.toThrow(/disposed/)
    expect(authorize).toHaveBeenCalledTimes(1)
    expect(() => m.dispose()).not.toThrow()
  })

  it('fails a privileged request disposed while its deriver was being fetched', async () => {
    const derivePrivateKey = jest.fn<SigmaKeyDeriver['derivePrivateKey']>()
    let provide!: (deriver: SigmaKeyDeriver) => void
    const privilegedKeyDeriver = jest.fn(
      async () =>
        await new Promise<SigmaKeyDeriver>(resolve => {
          provide = resolve
        })
    )
    const m = new SigmaPermissionModule({
      keyDeriver,
      authorize: async () => true,
      privilegedKeyDeriver
    })
    const pending = observe(
      call(m, 'key', [], { privileged: true, privilegedReason: 'Protect the private key' })
    )
    while (privilegedKeyDeriver.mock.calls.length === 0) {
      await new Promise(resolve => setImmediate(resolve))
    }
    m.dispose()
    provide({ derivePrivateKey })
    expect(await pending).toEqual({
      ok: false,
      error: expect.objectContaining({ message: expect.stringMatching(/disposed/) })
    })
    expect(derivePrivateKey).not.toHaveBeenCalled()
  })

  it('rejects an unknown proofAuthorization value', () => {
    expect(
      () => new SigmaPermissionModule({ keyDeriver, proofAuthorization: 'always' as never })
    ).toThrow(TypeError)
    expect(
      () => new SigmaPermissionModule({ keyDeriver, proofAuthorization: null as never })
    ).toThrow(TypeError)
    expect(
      () => new SigmaPermissionModule({ keyDeriver, proofAuthorization: 'each' })
    ).not.toThrow()
  })
})
