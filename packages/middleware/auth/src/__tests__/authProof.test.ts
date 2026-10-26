import {
  AuthProofClient,
  AuthProofServer,
  serializeAuthSigData,
  serializeSignablePayload,
  normalizeBody,
  createAuthSigData,
  createAuthProof,
  verifyAuthProof
} from '../index.js'
import type { AuthProof, AuthSigData } from '../index.js'
import { Utils, ProtoWallet, PrivateKey, type WalletProtocol } from '@bsv/sdk'

const NOW = 1_700_000_000_000
const WINDOW = 2 * 60 * 1000
const IDENTITY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const NONCE = Utils.toBase64(Array(32).fill(1))
const OPTIONS = { protocol: [2, 'test auth'] as WalletProtocol }

const client = new AuthProofClient(OPTIONS)
const server = new AuthProofServer(OPTIONS)

const sigData = (over: Partial<AuthSigData> = {}): AuthSigData => ({
  action: 'login',
  identityKey: IDENTITY,
  expiresAt: NOW + WINDOW,
  nonce: NONCE,
  ...over
})

const proof = (over: Partial<AuthSigData> = {}): AuthProof => ({
  data: sigData(over),
  signature: [1, 2, 3]
})

describe('standalone serializeAuthSigData / createAuthSigData', () => {
  it('serialization is deterministic and changes with any field', () => {
    const base = JSON.stringify(serializeAuthSigData(sigData()))
    expect(JSON.stringify(serializeAuthSigData(sigData()))).toBe(base)
    expect(new TextDecoder().decode(new Uint8Array(serializeAuthSigData(sigData())))).toBe(
      `login\n${IDENTITY}\n${String(NOW + WINDOW)}\n${NONCE}`
    )
    expect(JSON.stringify(serializeAuthSigData(sigData({ action: 'delete' })))).not.toBe(base)
    expect(
      JSON.stringify(serializeAuthSigData(sigData({ nonce: Utils.toBase64(Array(32).fill(2)) })))
    ).not.toBe(base)
  })

  it('createAuthSigData honors the window from options and makes a 32-byte nonce', () => {
    const d = createAuthSigData('login', IDENTITY, { windowMs: 5000 }, NOW)
    expect(d.expiresAt).toBe(NOW + 5000)
    expect(Utils.toArray(d.nonce, 'base64')).toHaveLength(32)
  })

  it('rejects unsafe option values and malformed locally supplied fields', () => {
    for (const options of [
      { windowMs: 0 },
      { clockSkewMs: -1 },
      { maxBodyBytes: 0 },
      { protocol: [3, 'test auth'] as unknown as WalletProtocol }
    ]) {
      expect(() => createAuthSigData('login', IDENTITY, options, NOW)).toThrow()
    }
    expect(() => createAuthSigData('login\ndelete', IDENTITY, undefined, NOW)).toThrow()
    expect(() => createAuthSigData('login', '02abc', undefined, NOW)).toThrow()
  })

  it('preserves all wallet consent levels while validating the exact protocol tuple', () => {
    for (const level of [0, 1, 2] as const) {
      expect(() =>
        createAuthSigData('login', IDENTITY, { protocol: [level, 'test auth'] }, NOW)
      ).not.toThrow()
    }
  })

  it('rejects inherited and accessor-backed signature fields without invoking accessors', () => {
    const inherited = Object.create(sigData()) as AuthSigData
    const getter = jest.fn(() => 'login')
    const accessorBacked = Object.defineProperty({ ...sigData(), action: undefined }, 'action', {
      get: getter
    }) as unknown as AuthSigData

    expect(() => serializeAuthSigData(inherited)).toThrow('own data fields')
    expect(() => serializeAuthSigData(accessorBacked)).toThrow('own data fields')
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('AuthProofClient', () => {
  it('sets expiry to now + default window', () => {
    expect(client.createAuthSigData('login', IDENTITY, NOW).expiresAt).toBe(NOW + WINDOW)
  })

  it('produces a unique 32-byte (base64) nonce per call', () => {
    const a = client.createAuthSigData('login', IDENTITY, NOW)
    const b = client.createAuthSigData('login', IDENTITY, NOW)
    expect(a.nonce).not.toBe(b.nonce)
    expect(Utils.toArray(a.nonce, 'base64')).toHaveLength(32)
  })

  it('serializes proof data through both class wrappers', () => {
    const expected = serializeAuthSigData(sigData())
    expect(client.serializeAuthSigData(sigData())).toEqual(expected)
    expect(server.serializeAuthSigData(sigData())).toEqual(expected)
  })
})

describe('AuthProofServer.checkAuthSigData', () => {
  it('accepts a fresh, well-formed proof', () => {
    expect(server.checkAuthSigData(sigData(), 'login', NOW)).toEqual({ valid: true })
  })

  it('rejects garbage, action mismatch, expiry, and far-future', () => {
    expect(server.checkAuthSigData(null, 'login', NOW).error).toBe('Malformed proof')
    expect(server.checkAuthSigData(sigData({ action: 'delete' }), 'login', NOW).error).toBe(
      'Action mismatch'
    )
    expect(server.checkAuthSigData(sigData({ expiresAt: NOW - 1 }), 'login', NOW).error).toBe(
      'Proof expired'
    )
    expect(
      server.checkAuthSigData(sigData({ expiresAt: NOW + WINDOW + 60_000 }), 'login', NOW).error
    ).toBe('Proof expiry too far in the future')
  })

  it('accepts right up to the expiry boundary; rejects empty fields', () => {
    expect(server.checkAuthSigData(sigData({ expiresAt: NOW + 1 }), 'login', NOW).valid).toBe(true)
    expect(server.checkAuthSigData(sigData({ expiresAt: NOW }), 'login', NOW)).toEqual({
      valid: false,
      error: 'Proof expired'
    })
    expect(server.checkAuthSigData(sigData({ identityKey: '' }), 'login', NOW).error).toBe(
      'Malformed proof'
    )
    expect(server.checkAuthSigData(sigData({ nonce: '' }), 'login', NOW).error).toBe(
      'Malformed proof'
    )
    expect(server.checkAuthSigData(sigData({ expiresAt: Number.NaN }), 'login', NOW).error).toBe(
      'Malformed proof'
    )
  })

  it('rejects every malformed field shape independently', () => {
    for (const malformed of [
      sigData({ action: undefined as unknown as string }),
      sigData({ identityKey: undefined as unknown as string }),
      sigData({ nonce: undefined as unknown as string }),
      sigData({ expiresAt: 'tomorrow' as unknown as number }),
      sigData({ expiresAt: Number.POSITIVE_INFINITY })
    ]) {
      expect(server.checkAuthSigData(malformed, 'login', NOW)).toEqual({
        valid: false,
        error: 'Malformed proof'
      })
    }
  })

  it('rejects delimiter injection, non-curve identities, and non-canonical nonces', () => {
    for (const malformed of [
      sigData({ action: 'login\ndelete' }),
      sigData({ identityKey: '02abc' }),
      sigData({ nonce: 'cmFuZG9tbm9uY2U=' })
    ]) {
      expect(server.checkAuthSigData(malformed, malformed.action, NOW)).toEqual({
        valid: false,
        error: 'Malformed proof'
      })
    }
  })

  it('rejects inherited and accessor-backed proof data without invoking accessors', () => {
    const inherited = Object.create(sigData()) as AuthSigData
    const getter = jest.fn(() => 'login')
    const accessorBacked = Object.defineProperty({ ...sigData(), action: undefined }, 'action', {
      get: getter
    }) as unknown as AuthSigData

    expect(server.checkAuthSigData(inherited, 'login', NOW).error).toBe('Malformed proof')
    expect(server.checkAuthSigData(accessorBacked, 'login', NOW).error).toBe('Malformed proof')
    expect(getter).not.toHaveBeenCalled()
  })
})

describe('AuthProofServer.verifyAuthProof', () => {
  const okWallet = () => ({ verifySignature: jest.fn(async () => ({ valid: true })) })
  const consumeOk = () => true

  it('accepts a valid, fresh, unused proof and returns the identity key', async () => {
    const wallet = okWallet()
    const result = await server.verifyAuthProof({
      wallet,
      proof: proof(),
      action: 'login',
      now: NOW,
      consumeNonce: consumeOk
    })
    expect(result).toEqual({ valid: true, identityKey: IDENTITY })
    expect(wallet.verifySignature).toHaveBeenCalledTimes(1)
  })

  it('rejects malformed / action mismatch / expired before the signature check', async () => {
    const wallet = okWallet()
    expect(
      (
        await server.verifyAuthProof({
          wallet,
          proof: { data: undefined, signature: [] } as unknown as AuthProof,
          action: 'login',
          now: NOW,
          consumeNonce: consumeOk
        })
      ).error
    ).toBe('Malformed proof')
    expect(
      (
        await server.verifyAuthProof({
          wallet,
          proof: proof(),
          action: 'delete',
          now: NOW,
          consumeNonce: consumeOk
        })
      ).error
    ).toBe('Action mismatch')
    expect(
      (
        await server.verifyAuthProof({
          wallet,
          proof: proof({ expiresAt: NOW - 1 }),
          action: 'login',
          now: NOW,
          consumeNonce: consumeOk
        })
      ).error
    ).toBe('Proof expired')
    expect(wallet.verifySignature).not.toHaveBeenCalled()
  })

  it('rejects an invalid signature without consuming the nonce', async () => {
    const wallet = { verifySignature: jest.fn(async () => ({ valid: false })) }
    const consume = jest.fn(async () => true)
    const result = await server.verifyAuthProof({
      wallet,
      proof: proof(),
      action: 'login',
      now: NOW,
      consumeNonce: consume
    })
    expect(result).toEqual({ valid: false, error: 'Invalid signature' })
    expect(consume).not.toHaveBeenCalled()
  })

  it('rejects a malformed truthy signature verdict without consuming the nonce', async () => {
    const wallet = {
      verifySignature: jest.fn(async () => ({ valid: 'true' as unknown as true }))
    }
    const consume = jest.fn(async () => true)
    const result = await server.verifyAuthProof({
      wallet,
      proof: proof(),
      action: 'login',
      now: NOW,
      consumeNonce: consume
    })
    expect(result).toEqual({ valid: false, error: 'Invalid signature' })
    expect(consume).not.toHaveBeenCalled()
  })

  it('rejects inherited and accessor-backed wallet verdicts without invoking accessors', async () => {
    const getter = jest.fn(() => true)
    const verdicts = [
      Object.create({ valid: true }),
      Object.defineProperty({}, 'valid', { get: getter })
    ]
    for (const verdict of verdicts) {
      const consume = jest.fn(async () => true)
      const result = await server.verifyAuthProof({
        wallet: { verifySignature: jest.fn(async () => verdict) } as never,
        proof: proof(),
        action: 'login',
        now: NOW,
        consumeNonce: consume
      })
      expect(result).toEqual({ valid: false, error: 'Invalid signature' })
      expect(consume).not.toHaveBeenCalled()
    }
    expect(getter).not.toHaveBeenCalled()
  })

  it('treats a throwing verifySignature as invalid (e.g. malformed identityKey) and does not consume', async () => {
    const wallet = {
      verifySignature: jest.fn(async () => {
        throw new Error('bad public key')
      })
    }
    const consume = jest.fn(async () => true)
    const result = await server.verifyAuthProof({
      wallet,
      proof: proof(),
      action: 'login',
      now: NOW,
      consumeNonce: consume
    })
    expect(result).toEqual({ valid: false, error: 'Invalid signature' })
    expect(consume).not.toHaveBeenCalled()
  })

  it('rejects a replayed proof (nonce already consumed)', async () => {
    const result = await server.verifyAuthProof({
      wallet: okWallet(),
      proof: proof(),
      action: 'login',
      now: NOW,
      consumeNonce: () => false
    })
    expect(result).toEqual({ valid: false, error: 'Proof already used' })
  })

  it('verifies the signature against the proof identity key and nonce', async () => {
    const wallet = okWallet()
    await server.verifyAuthProof({
      wallet,
      proof: proof(),
      action: 'login',
      now: NOW,
      consumeNonce: consumeOk
    })
    expect(wallet.verifySignature).toHaveBeenCalledWith(
      expect.objectContaining({ counterparty: IDENTITY, keyID: NONCE })
    )
  })

  it('passes a custom protocol directly to wallet signature operations', async () => {
    const wallet = {
      getPublicKey: jest.fn(async () => ({ publicKey: IDENTITY })),
      createSignature: jest.fn(async () => ({ signature: [1, 2, 3] }))
    }
    await createAuthProof({
      wallet: wallet as never,
      counterparty: IDENTITY,
      action: 'login',
      ...OPTIONS
    })
    expect(wallet.createSignature).toHaveBeenCalledWith(
      expect.objectContaining({ protocolID: OPTIONS.protocol })
    )
  })

  it('snapshots protocol and body before asynchronous wallet work', async () => {
    const protocol: WalletProtocol = [2, 'test auth']
    const body = { amount: 1 }
    const wallet = {
      getPublicKey: jest.fn(async () => {
        protocol[0] = 0
        body.amount = 2
        return { publicKey: IDENTITY }
      }),
      createSignature: jest.fn(async () => ({ signature: [1, 2, 3] }))
    }

    const created = await createAuthProof({
      wallet,
      counterparty: IDENTITY,
      action: 'login',
      protocol,
      body
    })

    expect(wallet.createSignature).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolID: [2, 'test auth'],
        data: serializeSignablePayload(created.data, { amount: 1 })
      })
    )
  })

  it('copies exact dense wallet signatures and rejects sparse results', async () => {
    const returnedSignature = [1, 2, 3]
    const wallet = {
      getPublicKey: jest.fn(async () => ({ publicKey: IDENTITY })),
      createSignature: jest.fn(async () => ({ signature: returnedSignature }))
    }
    const created = await createAuthProof({
      wallet,
      counterparty: IDENTITY,
      action: 'login',
      ...OPTIONS
    })
    returnedSignature[0] = 9
    expect(created.signature).toEqual([1, 2, 3])

    const sparse: number[] = []
    sparse.length = 3
    wallet.createSignature.mockResolvedValueOnce({ signature: sparse })
    await expect(
      createAuthProof({ wallet, counterparty: IDENTITY, action: 'login', ...OPTIONS })
    ).rejects.toThrow('malformed authentication signature')
  })

  it('requires an exact boolean nonce-consumption result', async () => {
    const result = await server.verifyAuthProof({
      wallet: okWallet(),
      proof: proof(),
      action: 'login',
      now: NOW,
      consumeNonce: () => 'true' as unknown as true
    })
    expect(result).toEqual({ valid: false, error: 'Proof already used' })
  })

  it('rejects malformed and oversized signature arrays before wallet verification', async () => {
    const wallet = okWallet()
    const sparse: number[] = []
    sparse.length = 64
    for (const signature of [[-1], [256], [1.5], Array(1_025).fill(1), sparse]) {
      const result = await server.verifyAuthProof({
        wallet,
        proof: { ...proof(), signature },
        action: 'login',
        now: NOW,
        consumeNonce: consumeOk
      })
      expect(result).toEqual({ valid: false, error: 'Malformed proof' })
    }
    expect(wallet.verifySignature).not.toHaveBeenCalled()
  })

  it('uses one owned proof snapshot across asynchronous verification and replay consumption', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    const mutableProof = proof()
    const consume = jest.fn(async () => true)
    const wallet = {
      verifySignature: jest.fn(async () => {
        await gate
        return { valid: true }
      })
    }

    const pending = server.verifyAuthProof({
      wallet,
      proof: mutableProof,
      action: 'login',
      now: NOW,
      consumeNonce: consume
    })
    mutableProof.data.action = 'delete'
    mutableProof.data.identityKey = new PrivateKey(2).toPublicKey().toString()
    mutableProof.data.nonce = Utils.toBase64(Array(32).fill(2))
    mutableProof.signature[0] = 9
    release()

    await expect(pending).resolves.toEqual({ valid: true, identityKey: IDENTITY })
    expect(consume).toHaveBeenCalledWith(NONCE, new Date(NOW + WINDOW))
    expect(wallet.verifySignature).toHaveBeenCalledWith(
      expect.objectContaining({
        counterparty: IDENTITY,
        keyID: NONCE,
        signature: [1, 2, 3]
      })
    )
  })
})

describe('normalizeBody', () => {
  it('UTF-8 encodes strings', () => {
    expect(normalizeBody('hi')).toEqual(Utils.toArray('hi', 'utf8'))
  })

  it('reads ArrayBuffer and typed arrays as raw bytes', () => {
    const u8 = new Uint8Array([9, 8, 7])
    expect(normalizeBody(u8)).toEqual([9, 8, 7])
    expect(normalizeBody(u8.buffer)).toEqual([9, 8, 7])
  })

  it('respects a typed-array view offset and length', () => {
    const view = new Uint8Array(new Uint8Array([1, 2, 3, 4, 5]).buffer, 1, 3)
    expect(normalizeBody(view)).toEqual([2, 3, 4])
  })

  it('JSON-encodes plain objects', () => {
    expect(normalizeBody({ a: 1 })).toEqual(Utils.toArray('{"a":1}', 'utf8'))
  })

  it('JSON-encodes arrays (params, objects, numbers) rather than treating them as bytes', () => {
    expect(normalizeBody(['a=1', 'b=2'])).toEqual(Utils.toArray('["a=1","b=2"]', 'utf8'))
    expect(normalizeBody([{ id: 1 }])).toEqual(Utils.toArray('[{"id":1}]', 'utf8'))
    expect(normalizeBody([1, 2, 3])).toEqual(Utils.toArray('[1,2,3]', 'utf8'))
  })

  it('rejects a body beyond the configured proof budget', () => {
    expect(() => normalizeBody('12345', 4)).toThrow('maxBodyBytes')
  })

  it('rejects deep, cyclic, accessor-bearing, and non-plain JSON bodies before stringify', () => {
    const deep: Record<string, unknown> = {}
    let cursor = deep
    for (let index = 0; index < 70; index += 1) {
      const child: Record<string, unknown> = {}
      cursor.child = child
      cursor = child
    }
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const accessor = Object.defineProperty({}, 'secret', { get: () => 'value', enumerable: true })

    expect(() => normalizeBody(deep)).toThrow('structural')
    expect(() => normalizeBody(cyclic)).toThrow('cycles')
    expect(() => normalizeBody(accessor)).toThrow('accessors')
    expect(() => normalizeBody(new Date() as never)).toThrow('plain data')
  })

  it('rejects non-canonical JSON numbers that stringify ambiguously', () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0]) {
      expect(() => normalizeBody({ value })).toThrow('canonical JSON numbers')
    }
  })
})

describe('serializeSignablePayload (body binding)', () => {
  it('with no body equals serializeAuthSigData, so login proofs are unchanged', () => {
    expect(serializeSignablePayload(sigData())).toEqual(serializeAuthSigData(sigData()))
  })

  it('binding a body changes the signed bytes and is body-sensitive', () => {
    const base = JSON.stringify(serializeSignablePayload(sigData(), { user: 'alice' }))
    expect(base).not.toBe(JSON.stringify(serializeAuthSigData(sigData())))
    expect(JSON.stringify(serializeSignablePayload(sigData(), { user: 'alice' }))).toBe(base)
    expect(JSON.stringify(serializeSignablePayload(sigData(), { user: 'bob' }))).not.toBe(base)
  })

  it('distinguishes an empty body from no body', () => {
    expect(serializeSignablePayload(sigData(), '')).not.toEqual(serializeSignablePayload(sigData()))
  })

  it('treats a JSON string and the equivalent object identically', () => {
    expect(serializeSignablePayload(sigData(), '{"user":"a"}')).toEqual(
      serializeSignablePayload(sigData(), { user: 'a' })
    )
  })
})

describe('additional trust-boundary coverage', () => {
  it('rejects malformed protocol containers and unsafe combined timing windows', () => {
    expect(() =>
      createAuthSigData('login', IDENTITY, { protocol: 'invalid' as never }, NOW)
    ).toThrow('protocol must be a valid wallet protocol tuple')

    const trappedProtocol = new Proxy([2, 'test auth'] as WalletProtocol, {
      getOwnPropertyDescriptor(): never {
        throw new Error('descriptor trap')
      }
    })
    expect(() => createAuthSigData('login', IDENTITY, { protocol: trappedProtocol }, NOW)).toThrow(
      'protocol must be a valid wallet protocol tuple'
    )
    expect(() =>
      createAuthSigData('login', IDENTITY, { windowMs: Number.MAX_SAFE_INTEGER, clockSkewMs: 1 }, 0)
    ).toThrow('windowMs plus clockSkewMs must be a safe integer')
  })

  it('counts every UTF-8 width and bounds JSON strings, keys, and array cardinality', () => {
    expect(normalizeBody({ text: `ascii-é-😀-${String.fromCharCode(0xd800)}` })).toEqual(
      Utils.toArray(JSON.stringify({ text: `ascii-é-😀-${String.fromCharCode(0xd800)}` }), 'utf8')
    )
    expect(() => normalizeBody({ text: 'ééé' }, 5)).toThrow('maxBodyBytes')
    expect(() => normalizeBody({ value: 1n } as never)).toThrow('JSON-compatible plain data')
    expect(() => normalizeBody(Array(100_001))).toThrow('structural limits')
    expect(() => normalizeBody({ ['x'.repeat(16)]: true }, 8)).toThrow('maxBodyBytes')
  })

  it('rejects non-canonical signature-data containers and invalid verification arguments', () => {
    for (const value of [null, [], new Date()]) {
      expect(() => serializeAuthSigData(value as never)).toThrow('canonical own data fields')
    }
    const trapped = new Proxy(sigData(), {
      getPrototypeOf(): never {
        throw new Error('prototype trap')
      }
    })
    expect(() => serializeAuthSigData(trapped)).toThrow('canonical own data fields')

    expect(server.checkAuthSigData(sigData(), '', NOW)).toEqual({
      valid: false,
      error: 'Malformed proof'
    })
    expect(server.checkAuthSigData(sigData(), 'login', -1)).toEqual({
      valid: false,
      error: 'Malformed proof'
    })
    expect(() =>
      createAuthSigData('login', IDENTITY, { windowMs: 2 }, Number.MAX_SAFE_INTEGER - 1)
    ).toThrow('expiry exceeds the safe integer range')
  })

  it('validates wallet identity and signature response envelopes before returning a proof', async () => {
    await expect(
      createAuthProof({
        wallet: {} as never,
        counterparty: 'not-a-key',
        action: 'login'
      })
    ).rejects.toThrow('counterparty and action')

    for (const identityResult of [null, 'identity', { publicKey: 'not-a-key' }]) {
      const wallet = {
        getPublicKey: jest.fn(async () => identityResult),
        createSignature: jest.fn()
      }
      await expect(
        createAuthProof({ wallet: wallet as never, counterparty: IDENTITY, action: 'login' })
      ).rejects.toThrow('malformed identity key')
      expect(wallet.createSignature).not.toHaveBeenCalled()
    }

    for (const signatureResult of [null, 'signature']) {
      const wallet = {
        getPublicKey: jest.fn(async () => ({ publicKey: IDENTITY })),
        createSignature: jest.fn(async () => signatureResult)
      }
      await expect(
        createAuthProof({ wallet: wallet as never, counterparty: IDENTITY, action: 'login' })
      ).rejects.toThrow('malformed authentication signature')
    }
  })
})

describe('round-trip with real wallets (createAuthProof → verifyAuthProof)', () => {
  const OPTS = OPTIONS
  const consumeOk = () => true
  let clientWallet: ProtoWallet
  let serverWallet: ProtoWallet
  let serverKey: string
  let clientKey: string

  beforeAll(async () => {
    clientWallet = new ProtoWallet(PrivateKey.fromRandom())
    serverWallet = new ProtoWallet(PrivateKey.fromRandom())
    serverKey = (await serverWallet.getPublicKey({ identityKey: true })).publicKey
    clientKey = (await clientWallet.getPublicKey({ identityKey: true })).publicKey
  })

  it('verifies a bodyless (login) proof', async () => {
    const p = await client.createAuthProof({
      wallet: clientWallet,
      counterparty: serverKey,
      action: 'login'
    })
    const r = await verifyAuthProof({
      wallet: serverWallet,
      proof: p,
      action: 'login',
      consumeNonce: consumeOk,
      ...OPTS
    })
    expect(r).toEqual({ valid: true, identityKey: clientKey })
  })

  it('verifies a body-bound request when given the same body', async () => {
    const body = { newUsername: 'alice' }
    const p = await createAuthProof({
      wallet: clientWallet,
      counterparty: serverKey,
      action: 'changeUsername',
      body,
      ...OPTS
    })
    const r = await verifyAuthProof({
      wallet: serverWallet,
      proof: p,
      action: 'changeUsername',
      consumeNonce: consumeOk,
      body,
      ...OPTS
    })
    expect(r).toEqual({ valid: true, identityKey: clientKey })
  })

  it('rejects a tampered body', async () => {
    const p = await createAuthProof({
      wallet: clientWallet,
      counterparty: serverKey,
      action: 'changeUsername',
      body: { newUsername: 'alice' },
      ...OPTS
    })
    const r = await verifyAuthProof({
      wallet: serverWallet,
      proof: p,
      action: 'changeUsername',
      consumeNonce: consumeOk,
      body: { newUsername: 'bob' },
      ...OPTS
    })
    expect(r.valid).toBe(false)
    expect(r.error).toBe('Invalid signature')
  })

  it('rejects a body-bound proof verified without the body', async () => {
    const p = await createAuthProof({
      wallet: clientWallet,
      counterparty: serverKey,
      action: 'changeUsername',
      body: { newUsername: 'alice' },
      ...OPTS
    })
    const r = await verifyAuthProof({
      wallet: serverWallet,
      proof: p,
      action: 'changeUsername',
      consumeNonce: consumeOk,
      ...OPTS
    })
    expect(r.valid).toBe(false)
  })

  it('rejects a bodyless proof verified with an injected body', async () => {
    const p = await createAuthProof({
      wallet: clientWallet,
      counterparty: serverKey,
      action: 'login',
      ...OPTS
    })
    const r = await verifyAuthProof({
      wallet: serverWallet,
      proof: p,
      action: 'login',
      consumeNonce: consumeOk,
      body: { x: 1 },
      ...OPTS
    })
    expect(r.valid).toBe(false)
  })

  it('binds a binary body (typed array) without corruption', async () => {
    const p = await createAuthProof({
      wallet: clientWallet,
      counterparty: serverKey,
      action: 'upload',
      body: new Uint8Array([0, 255, 10, 13, 200, 1]),
      ...OPTS
    })
    const ok = await verifyAuthProof({
      wallet: serverWallet,
      proof: p,
      action: 'upload',
      consumeNonce: consumeOk,
      body: new Uint8Array([0, 255, 10, 13, 200, 1]),
      ...OPTS
    })
    expect(ok.valid).toBe(true)
    const bad = await verifyAuthProof({
      wallet: serverWallet,
      proof: p,
      action: 'upload',
      consumeNonce: consumeOk,
      body: new Uint8Array([0, 255, 10, 13, 200, 2]),
      ...OPTS
    })
    expect(bad.valid).toBe(false)
  })
})
