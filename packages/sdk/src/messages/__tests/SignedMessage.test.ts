import { sign, verify } from '../../messages/SignedMessage'
import {
  MAX_MESSAGE_PAYLOAD_BYTES,
  MAX_SIGNED_MESSAGE_BYTES
} from '../../messages/MessageValidation'
import PrivateKey from '../../primitives/PrivateKey'
import PublicKey from '../../primitives/PublicKey'

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
