import { jest } from '@jest/globals'
import { sign, signWithWallet, verify } from '../../messages/SignedMessage'
import {
  MAX_MESSAGE_PAYLOAD_BYTES,
  MAX_SIGNED_MESSAGE_BYTES
} from '../../messages/MessageValidation'
import PrivateKey from '../../primitives/PrivateKey'
import PublicKey from '../../primitives/PublicKey'
import ProtoWallet from '../../wallet/ProtoWallet'

describe('SignedMessage', () => {
  it('Signs a message for a recipient', () => {
    const sender = new PrivateKey(15)
    const recipient = new PrivateKey(21)
    const recipientPub = recipient.toPublicKey()
    const message = [1, 2, 4, 8, 16, 32]
    const signature = sign(message, sender, recipientPub)
    const verified = verify(message, signature, recipient)
    expect(verified).toEqual(true)
  })
  it('Signs a message for anyone', () => {
    const sender = new PrivateKey(15)
    const message = [1, 2, 4, 8, 16, 32]
    const signature = sign(message, sender)
    const verified = verify(message, signature)
    expect(verified).toEqual(true)
  })
  it('Fails to verify a message with a wrong version', () => {
    const sender = new PrivateKey(15)
    const recipient = new PrivateKey(21)
    const recipientPub = recipient.toPublicKey()
    const message = [1, 2, 4, 8, 16, 32]
    const signature = sign(message, sender, recipientPub)
    signature[0] = 1
    expect(() => verify(message, signature, recipient)).toThrow(
      new Error('Message version mismatch: Expected 42423301, received 01423301')
    )
  })
  it('Fails to verify a message with no verifier when required', () => {
    const sender = new PrivateKey(15)
    const recipient = new PrivateKey(21)
    const recipientPub = recipient.toPublicKey()
    const message = [1, 2, 4, 8, 16, 32]
    const signature = sign(message, sender, recipientPub)
    expect(() => verify(message, signature)).toThrow(
      new Error(
        'This signature can only be verified with knowledge of a specific private key. The associated public key is: 02352bbf4a4cdd12564f93fa332ce333301d9ad40271f8107181340aef25be59d5'
      )
    )
  })
  it('Fails to verify a message with a wrong verifier', () => {
    const sender = new PrivateKey(15)
    const recipient = new PrivateKey(21)
    const wrongRecipient = new PrivateKey(22)
    const recipientPub = recipient.toPublicKey()
    const message = [1, 2, 4, 8, 16, 32]
    const signature = sign(message, sender, recipientPub)
    expect(() => verify(message, signature, wrongRecipient)).toThrow(
      new Error(
        'The recipient public key is 03421f5fc9a21065445c96fdb91c0c1e2f2431741c72713b4b99ddcb316f31e9fc but the signature requres the recipient to have public key 02352bbf4a4cdd12564f93fa332ce333301d9ad40271f8107181340aef25be59d5'
      )
    )
  })

  it('never turns a malformed designated verifier into an anyone signature', () => {
    const sender = new PrivateKey(15)
    const message = [1, 2, 3]

    expect(() => sign(message, sender, null as any)).toThrow(TypeError)
    expect(() => sign(message, sender, 'anyone' as any)).toThrow(TypeError)
    expect(() => sign(message, sender, {} as PublicKey)).toThrow(TypeError)
    expect(() => sign(message, sender, new PublicKey(1, 1))).toThrow(TypeError)
  })

  it('rejects malformed or excessive signed-message byte arrays', () => {
    const sender = new PrivateKey(15)
    const message = [1, 2, 3]
    const signature = sign(message, sender)
    const sparse = signature.slice()
    delete sparse[10]
    const excessiveMessage: number[] = []
    excessiveMessage.length = MAX_MESSAGE_PAYLOAD_BYTES + 1
    const excessiveSignature: number[] = []
    excessiveSignature.length = MAX_SIGNED_MESSAGE_BYTES + 1

    expect(() => sign(excessiveMessage, sender)).toThrow(RangeError)
    expect(() => verify(message, signature.slice(0, 77))).toThrow(RangeError)
    expect(() => verify(message, sparse)).toThrow(TypeError)
    expect(() => verify(message, excessiveSignature)).toThrow(RangeError)
    signature[10] = 256
    expect(() => verify(message, signature)).toThrow(TypeError)
  })

  it('requires a valid recipient private key for a designated signature', () => {
    const sender = new PrivateKey(15)
    const recipient = new PrivateKey(21)
    const signature = sign([1, 2, 3], sender, recipient.toPublicKey())

    expect(() => verify([1, 2, 3], signature, {} as PrivateKey)).toThrow(TypeError)
    expect(() => verify([1, 2, 3], signature, new PrivateKey(0))).toThrow(TypeError)
  })
})

describe('SignedMessage through a wallet and with an expected signer', () => {
  const senderKey = new PrivateKey(15)
  const recipientKey = new PrivateKey(21)
  const senderHex = senderKey.toPublicKey().toString()
  const message = [1, 2, 4, 8, 16, 32]

  it('signs through a wallet for anyone, verifiable like a key-signed message', async () => {
    const signature = await signWithWallet(message, new ProtoWallet(senderKey))

    expect(verify(message, signature)).toBe(true)
    expect(signature.slice(0, 4)).toEqual([0x42, 0x42, 0x33, 0x01])
    expect(signature.slice(4, 37)).toEqual(senderKey.toPublicKey().encode(true))
    expect(signature[37]).toBe(0)
    expect(verify([...message, 0], signature)).toBe(false)
  })

  it('signs through a wallet for a specific recipient', async () => {
    const signature = await signWithWallet(
      message,
      new ProtoWallet(senderKey),
      recipientKey.toPublicKey()
    )

    expect(verify(message, signature, recipientKey)).toBe(true)
    expect(() => verify(message, signature)).toThrow(TypeError)
    expect(() => verify(message, signature, new PrivateKey(22))).toThrow(
      'but the signature requres the recipient'
    )
  })

  it('passes the originator to every wallet call', async () => {
    const wallet = new ProtoWallet(senderKey)
    const createSignature = jest.spyOn(wallet, 'createSignature')
    const getPublicKey = jest.spyOn(wallet, 'getPublicKey')

    await signWithWallet(message, wallet, undefined, 'app.example')

    expect(createSignature).toHaveBeenCalledWith(
      expect.objectContaining({ protocolID: [2, 'message signing'], counterparty: 'anyone' }),
      'app.example'
    )
    expect(getPublicKey).toHaveBeenCalledWith({ identityKey: true }, 'app.example')
  })

  it('reads the identity key before asking for the signature, one call at a time', async () => {
    const wallet = new ProtoWallet(senderKey)
    const calls: string[] = []
    let identityKeyPending = false
    jest.spyOn(wallet, 'getPublicKey').mockImplementation(async (args) => {
      calls.push('getPublicKey')
      identityKeyPending = true
      await Promise.resolve()
      identityKeyPending = false
      return await ProtoWallet.prototype.getPublicKey.call(wallet, args)
    })
    jest.spyOn(wallet, 'createSignature').mockImplementation(async (args) => {
      calls.push(identityKeyPending ? 'createSignature (while getPublicKey pending)' : 'createSignature')
      return await ProtoWallet.prototype.createSignature.call(wallet, args)
    })

    const signature = await signWithWallet(message, wallet)

    expect(calls).toEqual(['getPublicKey', 'createSignature'])
    expect(verify(message, signature)).toBe(true)
  })

  it('never asks for a signature when the identity key is refused', async () => {
    const wallet = new ProtoWallet(senderKey)
    jest.spyOn(wallet, 'getPublicKey').mockRejectedValue(new Error('Permission denied'))
    const createSignature = jest.spyOn(wallet, 'createSignature')

    await expect(signWithWallet(message, wallet)).rejects.toThrow('Permission denied')
    expect(createSignature).not.toHaveBeenCalled()
  })

  it('refuses an anyone signature that does not verify against the reported identity key', async () => {
    const wallet = new ProtoWallet(senderKey)
    const reported = new PrivateKey(16).toPublicKey().toString()
    jest.spyOn(wallet, 'getPublicKey').mockResolvedValue({ publicKey: reported })

    await expect(signWithWallet(message, wallet)).rejects.toThrow(
      `The wallet's signature does not verify against its identity key ${reported}`
    )
  })

  it('refuses a malformed signature from the wallet', async () => {
    const wallet = new ProtoWallet(senderKey)
    jest.spyOn(wallet, 'createSignature').mockResolvedValue({ signature: [0x30, 0x01, 0x00] })

    await expect(signWithWallet(message, wallet)).rejects.toThrow(
      "The wallet's signature does not verify against its identity key"
    )
  })

  it('cannot check a designated-verifier signature without the verifier key', async () => {
    const wallet = new ProtoWallet(senderKey)
    jest
      .spyOn(wallet, 'getPublicKey')
      .mockResolvedValue({ publicKey: new PrivateKey(16).toPublicKey().toString() })

    const signature = await signWithWallet(message, wallet, recipientKey.toPublicKey())

    expect(verify(message, signature, recipientKey)).toBe(false)
  })

  it('refuses a malformed message or verifier before calling the wallet', async () => {
    const wallet = new ProtoWallet(senderKey)
    const createSignature = jest.spyOn(wallet, 'createSignature')
    const sparse = [1, 2, 3]
    delete sparse[1]

    await expect(signWithWallet(sparse, wallet)).rejects.toThrow(TypeError)
    await expect(signWithWallet(message, wallet, {} as PublicKey)).rejects.toThrow(TypeError)
    expect(createSignature).not.toHaveBeenCalled()
  })

  it('accepts the expected signer as a public key or its hex', () => {
    const signature = sign(message, senderKey)

    expect(verify(message, signature, undefined, { expectedSigner: senderKey.toPublicKey() })).toBe(
      true
    )
    expect(verify(message, signature, undefined, { expectedSigner: senderHex })).toBe(true)
    expect(verify(message, signature, undefined, { expectedSigner: senderHex.toUpperCase() })).toBe(
      true
    )
  })

  it('answers false for a valid signature by someone else', () => {
    const other = new PrivateKey(16).toPublicKey()

    expect(verify(message, sign(message, senderKey), undefined, { expectedSigner: other })).toBe(
      false
    )
    const designated = sign(message, senderKey, recipientKey.toPublicKey())
    expect(verify(message, designated, recipientKey, { expectedSigner: other })).toBe(false)
    expect(verify(message, designated, recipientKey, { expectedSigner: senderHex })).toBe(true)
  })

  it('checks the expected signer before the recipient', () => {
    const other = new PrivateKey(16).toPublicKey()
    const designated = sign(message, senderKey, recipientKey.toPublicKey())

    expect(verify(message, designated, undefined, { expectedSigner: other })).toBe(false)
    expect(verify(message, designated, new PrivateKey(22), { expectedSigner: other })).toBe(false)
    expect(() => verify(message, designated, undefined, { expectedSigner: senderHex })).toThrow(
      TypeError
    )
  })

  it('refuses a malformed expected signer', () => {
    const signature = sign(message, senderKey)

    expect(() => verify(message, signature, undefined, { expectedSigner: 'not a key' })).toThrow()
    expect(() =>
      verify(message, signature, undefined, { expectedSigner: {} as PublicKey })
    ).toThrow(TypeError)
  })
})
