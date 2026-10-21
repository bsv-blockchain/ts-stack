import { afterEach, expect, jest, test } from '@jest/globals'
import {
  PrivateKey,
  OutputProtocolError,
  type WalletInterface,
  type OutputJSONObject
} from '@bsv/sdk'
import { WalletProtectedOperationPayload } from '../src/operations/WalletProtectedOperationPayload.js'

const identity = new PrivateKey(84).toPublicKey().toString()
const otherIdentity = new PrivateKey(85).toPublicKey().toString()
const binding = { r: '1' }
const bindingDigest = '9911a9ee0accd554926b74ce9164de3b70067ac89a4a9c585bb7fc3bbebe7629'
const unavailable = (message: string) => ({ code: 'unavailable', message, retryable: true })
function fixture(maximum = 256) {
  const wallet = {
    getPublicKey: jest
      .fn<WalletInterface['getPublicKey']>()
      .mockResolvedValue({ publicKey: identity }),
    encrypt: jest.fn<WalletInterface['encrypt']>().mockImplementation(async args => ({
      ciphertext: [...args.plaintext, ...Array<number>(28).fill(255)]
    })),
    decrypt: jest.fn<WalletInterface['decrypt']>().mockResolvedValue({ plaintext: [0, 255] })
  }
  const codec = new WalletProtectedOperationPayload(wallet, identity, maximum)
  return { wallet, codec }
}
afterEach(() => {
  jest.restoreAllMocks()
})

test('pins the published local envelope and BRC-100 derivation to an independent digest vector', async () => {
  const { wallet, codec } = fixture()
  const envelope = await codec.seal(binding, new Uint8Array([0, 255]))
  expect(envelope).toMatchObject({
    format: 'output-wallet-protected-payload/1',
    identity,
    bindingDigest
  })
  expect(envelope.salt).toMatch(/^[0-9a-f]{64}$/)
  expect(wallet.encrypt.mock.calls[0][0]).toEqual({
    protocolID: [2, 'output protected workflow'],
    keyID: bindingDigest + ' ' + String(envelope.salt),
    counterparty: 'self',
    plaintext: [0, 0]
  })
  expect(await codec.open(binding, envelope)).toEqual(new Uint8Array([0, 255]))
  expect(wallet.decrypt.mock.calls[0][0]).toEqual({
    protocolID: [2, 'output protected workflow'],
    keyID: bindingDigest + ' ' + String(envelope.salt),
    counterparty: 'self',
    ciphertext: Array<number>(30).fill(0)
  })
  expect(wallet.getPublicKey.mock.calls).toEqual(
    Array.from({ length: 4 }, () => [{ identityKey: true }])
  )
})

test.each([256, 257, 2097152])(
  'retains exact accepted plaintext and complete ciphertext capacities at %i bytes',
  maximum => {
    const { codec } = fixture(maximum)
    expect(codec.maximumPlaintextBytes).toBe(maximum)
    expect(codec.maximumSealedBytes).toBe(Math.ceil((maximum + 64) / 3) * 4 + 1024)
  }
)
test.each([0, 255, 256.5, 2097153, Number.NaN, Number.POSITIVE_INFINITY])(
  'rejects invalid configured custody capacity %s',
  maximum => {
    expect(() => fixture(maximum)).toThrow('Invalid protected operation plaintext capacity')
  }
)
test.each(['getPublicKey', 'encrypt', 'decrypt'] as const)(
  'requires callable %s when installing custody',
  method => {
    const { wallet } = fixture()
    Object.defineProperty(wallet, method, { value: null })
    expect(() => new WalletProtectedOperationPayload(wallet, identity)).toThrow(
      'Protected operation wallet capability changed'
    )
  }
)
test.each(['getPublicKey', 'encrypt', 'decrypt'] as const)(
  'refuses replaced %s before starting encryption',
  async method => {
    const { wallet, codec } = fixture()
    Object.defineProperty(wallet, method, { value: jest.fn() })
    await expect(codec.seal(binding, new Uint8Array([3]))).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Protected operation wallet capability changed'
    })
  }
)
test('accepts exact plaintext and full allowed encryption framing, refusing one additional byte', async () => {
  const { wallet, codec } = fixture()
  wallet.encrypt.mockResolvedValue({ ciphertext: Array<number>(320).fill(0) })
  const envelope = await codec.seal(binding, new Uint8Array(256))
  wallet.decrypt.mockResolvedValue({ plaintext: Array<number>(256).fill(255) })
  expect(await codec.open(binding, envelope)).toEqual(new Uint8Array(256).fill(255))
  await expect(codec.seal(binding, new Uint8Array(257))).rejects.toMatchObject({
    code: 'limited',
    message: 'Protected operation plaintext capacity exceeded'
  })
  await expect(codec.seal(binding, [1] as unknown as Uint8Array)).rejects.toMatchObject({
    code: 'limited',
    message: 'Protected operation plaintext capacity exceeded'
  })
  expect(wallet.encrypt).toHaveBeenCalledTimes(1)
})
test('enforces the complete UTF-8 binding budget independently of the payload budget', async () => {
  const { codec } = fixture()
  const maximum = { x: 'a'.repeat(65528) }
  const envelope = await codec.seal(maximum, new Uint8Array([1]))
  expect(await codec.open(maximum, envelope)).toEqual(new Uint8Array([0, 255]))
  await expect(codec.seal({ x: 'a'.repeat(65529) }, new Uint8Array([1]))).rejects.toMatchObject({
    code: 'limited'
  })
})
test.each(['seal', 'open'] as const)(
  '%s classifies identity lookup failure without disclosing provider errors',
  async operation => {
    const { wallet, codec } = fixture(),
      envelope = await codec.seal(binding, new Uint8Array([1]))
    wallet.getPublicKey.mockRejectedValue(new Error('provider-private-detail'))
    await expect(
      operation === 'seal'
        ? codec.seal(binding, new Uint8Array([1]))
        : codec.open(binding, envelope)
    ).rejects.toMatchObject(unavailable('Protected operation wallet is unavailable'))
  }
)
test.each(['seal', 'open'] as const)(
  '%s refuses identity drift before cryptographic work',
  async operation => {
    const { wallet, codec } = fixture(),
      envelope = await codec.seal(binding, new Uint8Array([1]))
    wallet.getPublicKey.mockResolvedValue({ publicKey: otherIdentity })
    await expect(
      operation === 'seal'
        ? codec.seal(binding, new Uint8Array([1]))
        : codec.open(binding, envelope)
    ).rejects.toMatchObject({
      code: 'context-changed',
      message: 'Protected operation wallet identity changed'
    })
  }
)
test.each(['encrypt', 'decrypt'] as const)(
  'rechecks identity and method stability after awaiting %s',
  async method => {
    const { wallet, codec } = fixture(),
      envelope = await codec.seal(binding, new Uint8Array([1]))
    if (method === 'encrypt')
      wallet.encrypt.mockImplementationOnce(async () => {
        wallet.getPublicKey.mockResolvedValue({ publicKey: otherIdentity })
        return { ciphertext: [0, 1] }
      })
    else
      wallet.decrypt.mockImplementationOnce(async () => {
        wallet.getPublicKey.mockResolvedValue({ publicKey: otherIdentity })
        return { plaintext: [0, 1] }
      })
    await expect(
      method === 'encrypt'
        ? codec.seal(binding, new Uint8Array([1]))
        : codec.open(binding, envelope)
    ).rejects.toMatchObject({ code: 'context-changed' })
  }
)
test.each(['encrypt', 'decrypt'] as const)(
  'refuses replaced methods during the asynchronous %s call',
  async method => {
    const { wallet, codec } = fixture(),
      envelope = await codec.seal(binding, new Uint8Array([1]))
    if (method === 'encrypt')
      wallet.encrypt.mockImplementationOnce(async () => {
        wallet.encrypt = jest.fn()
        return { ciphertext: [1, 2] }
      })
    else
      wallet.decrypt.mockImplementationOnce(async () => {
        wallet.decrypt = jest.fn()
        return { plaintext: [1] }
      })
    await expect(
      method === 'encrypt'
        ? codec.seal(binding, new Uint8Array([1]))
        : codec.open(binding, envelope)
    ).rejects.toMatchObject({ code: 'context-changed' })
  }
)
test.each(['encrypt', 'decrypt'] as const)(
  'preserves classified %s errors and bounds unclassified provider failures',
  async method => {
    const { wallet, codec } = fixture(),
      envelope = await codec.seal(binding, new Uint8Array([1]))
    const classified = new OutputProtocolError('cancelled', 'User denied custody')
    wallet[method].mockRejectedValueOnce(classified)
    await expect(
      method === 'encrypt'
        ? codec.seal(binding, new Uint8Array([1]))
        : codec.open(binding, envelope)
    ).rejects.toBe(classified)
    wallet[method].mockRejectedValueOnce(new Error('provider-private-detail'))
    await expect(
      method === 'encrypt'
        ? codec.seal(binding, new Uint8Array([1]))
        : codec.open(binding, envelope)
    ).rejects.toMatchObject(
      unavailable(
        method === 'encrypt'
          ? 'Protected operation encryption is unavailable'
          : 'Protected operation decryption is unavailable'
      )
    )
  }
)
test.each([[], [1], [1, 2]].map(ciphertext => [ciphertext]))(
  'requires encryption framing longer than plaintext: %j',
  async ciphertext => {
    const { wallet, codec } = fixture()
    wallet.encrypt.mockResolvedValue({ ciphertext })
    await expect(codec.seal(binding, new Uint8Array([1, 2]))).rejects.toMatchObject({
      code: 'unavailable',
      message: 'Protected operation wallet returned invalid encryption framing'
    })
  }
)
test.each(['encrypt', 'decrypt'] as const)(
  '%s result arrays must contain only owned integral bytes',
  async method => {
    const sparse: number[] = []
    sparse.length = 1
    const invalid: unknown[] = [
      [-1],
      [256],
      [0.5],
      [Number.NaN],
      ['0'],
      sparse,
      Object.defineProperty([], '0', { get: () => 0, enumerable: true })
    ]
    for (const bytes of invalid) {
      const { wallet, codec } = fixture(),
        envelope = await codec.seal(binding, new Uint8Array())
      if (method === 'encrypt') wallet.encrypt.mockResolvedValue({ ciphertext: bytes as number[] })
      else wallet.decrypt.mockResolvedValue({ plaintext: bytes as number[] })
      await expect(
        method === 'encrypt' ? codec.seal(binding, new Uint8Array()) : codec.open(binding, envelope)
      ).rejects.toMatchObject({
        code: 'unavailable',
        message: 'Invalid protected operation wallet bytes'
      })
    }
  }
)
test.each(['encrypt', 'decrypt'] as const)(
  '%s rejects non-arrays and oversized wallet responses',
  async method => {
    const maximum = method === 'encrypt' ? 320 : 256
    for (const bytes of [null, {}, new Uint8Array(1), Array<number>(maximum + 1).fill(0)]) {
      const { wallet, codec } = fixture(),
        envelope = await codec.seal(binding, new Uint8Array())
      if (method === 'encrypt') wallet.encrypt.mockResolvedValue({ ciphertext: bytes as number[] })
      else wallet.decrypt.mockResolvedValue({ plaintext: bytes as number[] })
      await expect(
        method === 'encrypt' ? codec.seal(binding, new Uint8Array()) : codec.open(binding, envelope)
      ).rejects.toMatchObject({
        code: 'limited',
        message: 'Protected operation wallet byte capacity exceeded'
      })
    }
  }
)
test.each([null, [], 1, 'text'])(
  'refuses non-object envelope %j before consulting wallet custody',
  async envelope => {
    const { wallet, codec } = fixture()
    await expect(codec.open(binding, envelope)).rejects.toThrow(
      'Expected protected operation payload object'
    )
    expect(wallet.getPublicKey).not.toHaveBeenCalled()
  }
)
test.each([
  [{ format: 'unknown' }, 'unsupported', 'Unsupported protected operation payload'],
  [{ identity: otherIdentity }, 'context-changed', 'Protected operation payload binding changed'],
  [
    { bindingDigest: '00'.repeat(32) },
    'context-changed',
    'Protected operation payload binding changed'
  ],
  [{ ciphertext: 7 }, 'invalid', 'Invalid protected operation ciphertext']
] as const)('refuses altered envelope fields %j', async (change, code, message) => {
  const { wallet, codec } = fixture(),
    envelope = await codec.seal(binding, new Uint8Array([1]))
  wallet.getPublicKey.mockClear()
  await expect(codec.open(binding, { ...envelope, ...change })).rejects.toMatchObject({
    code,
    message
  })
  expect(wallet.getPublicKey).not.toHaveBeenCalled()
})
test('refuses oversized envelopes before requesting plaintext and keeps caller envelopes independent', async () => {
  const { wallet, codec } = fixture(),
    envelope = await codec.seal(binding, new Uint8Array([1]))
  const copy: OutputJSONObject = { ...envelope }
  await codec.open(binding, envelope)
  expect(envelope).toEqual(copy)
  wallet.decrypt.mockClear()
  await expect(
    codec.open(binding, { ...envelope, extra: 'a'.repeat(codec.maximumSealedBytes) })
  ).rejects.toMatchObject({ code: 'limited' })
  expect(wallet.decrypt).not.toHaveBeenCalled()
})
