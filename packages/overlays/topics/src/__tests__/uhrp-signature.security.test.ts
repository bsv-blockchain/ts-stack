import { jest } from '@jest/globals'
import { PrivateKey, ProtoWallet, PublicKey, Utils } from '@bsv/sdk'
import { isTokenSignatureCorrectlyLinked } from '../uhrp/isTokenSignatureCorrectlyLinked.js'

const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
const identityBytes = Utils.toArray(identityKey, 'hex')
const lockingPublicKey = PublicKey.fromString(
  '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
)
const fields = [identityBytes, [1], [2], [3], [4], [5, 6, 7]]

describe('UHRP signature and locking-key binding', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it.each([null, [], fields.slice(0, 5), [...fields, [8]]])(
    'rejects an invalid field envelope before verification: %p',
    async malformed => {
      const verify = jest.spyOn(ProtoWallet.prototype, 'verifySignature')
      await expect(
        isTokenSignatureCorrectlyLinked(lockingPublicKey, malformed as never)
      ).resolves.toBe(false)
      expect(verify).not.toHaveBeenCalled()
    }
  )

  it('fails closed when signature verification throws', async () => {
    jest.spyOn(ProtoWallet.prototype, 'verifySignature').mockRejectedValue(new Error('malformed'))
    const derive = jest.spyOn(ProtoWallet.prototype, 'getPublicKey')

    await expect(isTokenSignatureCorrectlyLinked(lockingPublicKey, fields)).resolves.toBe(false)
    expect(derive).not.toHaveBeenCalled()
  })

  it.each([false, undefined, 1])('requires an exact true signature verdict: %p', async valid => {
    jest.spyOn(ProtoWallet.prototype, 'verifySignature').mockResolvedValue({ valid } as never)
    const derive = jest.spyOn(ProtoWallet.prototype, 'getPublicKey')

    await expect(isTokenSignatureCorrectlyLinked(lockingPublicKey, fields)).resolves.toBe(false)
    expect(derive).not.toHaveBeenCalled()
  })

  it('binds a valid signature to the derived locking public key', async () => {
    const verify = jest
      .spyOn(ProtoWallet.prototype, 'verifySignature')
      .mockResolvedValue({ valid: true })
    jest.spyOn(ProtoWallet.prototype, 'getPublicKey').mockResolvedValue({
      publicKey: lockingPublicKey.toString()
    })

    await expect(isTokenSignatureCorrectlyLinked(lockingPublicKey, fields)).resolves.toBe(true)
    expect(verify).toHaveBeenCalledWith({
      data: fields.slice(0, -1).flat(),
      signature: fields.at(-1),
      counterparty: identityKey,
      protocolID: [2, 'uhrp advertisement'],
      keyID: '1'
    })
  })

  it('rejects a valid signature derived for another locking key', async () => {
    jest.spyOn(ProtoWallet.prototype, 'verifySignature').mockResolvedValue({ valid: true })
    jest.spyOn(ProtoWallet.prototype, 'getPublicKey').mockResolvedValue({
      publicKey: PrivateKey.fromRandom().toPublicKey().toString()
    })

    await expect(isTokenSignatureCorrectlyLinked(lockingPublicKey, fields)).resolves.toBe(false)
  })
})
