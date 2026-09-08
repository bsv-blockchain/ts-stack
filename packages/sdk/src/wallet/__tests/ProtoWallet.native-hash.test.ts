import { webcrypto } from 'node:crypto'
import { Hash, PrivateKey, ProtoWallet } from '../../../mod'

describe('ProtoWallet large signature payload hashing', () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const parameters = { protocolID: [0, 'native hash parity'] as [0, string], keyID: 'test', counterparty: 'self' }
  const wallet = new ProtoWallet(new PrivateKey(42))
  const data = Array.from({ length: 65536 }, (_, i) => i % 256)

  function install(digest?: jest.Mock): void {
    Object.defineProperty(globalThis, 'crypto', {
      configurable: true,
      value: digest === undefined ? undefined : { subtle: { digest } }
    })
  }

  afterEach(() => {
    if (originalCrypto === undefined) Reflect.deleteProperty(globalThis, 'crypto')
    else Object.defineProperty(globalThis, 'crypto', originalCrypto)
  })

  it('preserves deterministic signatures and verifies actual native SHA-256 results', async () => {
    const digest = jest.fn((algorithm, bytes) => webcrypto.subtle.digest(algorithm, bytes))
    install(digest)
    const expected = await wallet.createSignature({ ...parameters, hashToDirectlySign: Hash.sha256(data) })
    const actual = await wallet.createSignature({ ...parameters, data })
    expect(actual).toEqual(expected)
    await expect(wallet.verifySignature({ ...parameters, data, ...actual })).resolves.toEqual({ valid: true })
    expect(digest).toHaveBeenCalledTimes(2)
    expect(digest).toHaveBeenCalledWith('SHA-256', new Uint8Array(data))
    const changed = [...data]
    changed[0] ^= 1
    await expect(wallet.verifySignature({ ...parameters, data: changed, ...actual })).rejects.toMatchObject({ code: 'ERR_INVALID_SIGNATURE' })
  })

  it('keeps short payloads and explicit digests on their existing path', async () => {
    const digest = jest.fn()
    install(digest)
    const short = data.slice(1)
    const signature = await wallet.createSignature({ ...parameters, data: short })
    await expect(wallet.verifySignature({ ...parameters, data: short, ...signature })).resolves.toEqual({ valid: true })
    const hash = Hash.sha256(data)
    const direct = await wallet.createSignature({ ...parameters, data, hashToDirectlySign: hash })
    await expect(wallet.verifySignature({ ...parameters, data, hashToDirectlyVerify: hash, ...direct })).resolves.toEqual({ valid: true })
    expect(digest).not.toHaveBeenCalled()
  })

  it('preserves existing byte coercion without narrowing accepted arrays', async () => {
    const digest = jest.fn((algorithm, bytes) => webcrypto.subtle.digest(algorithm, bytes))
    install(digest)
    const unusual = [...data]
    unusual.splice(0, 4, -1, 256, 1.75, Number.NaN)
    const expected = await wallet.createSignature({ ...parameters, hashToDirectlySign: Hash.sha256(unusual) })
    expect(await wallet.createSignature({ ...parameters, data: unusual })).toEqual(expected)
  })

  it('works in hosts without Web Crypto', async () => {
    install()
    const signature = await wallet.createSignature({ ...parameters, data })
    await expect(wallet.verifySignature({ ...parameters, data, ...signature })).resolves.toEqual({ valid: true })
  })

  it.each(['reject', 'malformed'] as const)('falls back to the original byte snapshot after a %s native result', async failure => {
    let finish: () => void = () => { throw new Error('digest did not start') }
    const digest = jest.fn(() => new Promise<ArrayBuffer>((resolve, reject) => {
      finish = () => failure === 'reject' ? reject(new Error('unsupported host')) : resolve(new ArrayBuffer(31))
    }))
    install(digest)
    const expected = await wallet.createSignature({ ...parameters, hashToDirectlySign: Hash.sha256(data) })
    const mutable = [...data]
    const pending = wallet.createSignature({ ...parameters, data: mutable })
    expect(digest).toHaveBeenCalledTimes(1)
    mutable.fill(99)
    finish()
    expect(await pending).toEqual(expected)
    const verifyData = [...data]
    const verifying = wallet.verifySignature({ ...parameters, data: verifyData, ...expected })
    expect(digest).toHaveBeenCalledTimes(2)
    verifyData.fill(99)
    finish()
    await expect(verifying).resolves.toEqual({ valid: true })
  })
})
