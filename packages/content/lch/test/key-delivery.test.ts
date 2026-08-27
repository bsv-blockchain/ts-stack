import { describe, expect, it } from '@jest/globals'
import { PrivateKey, ProtoWallet } from '@bsv/sdk'
import { WalletBRC78KeyDelivery, keyIdFor } from '../src/index.js'

describe('BRC-78 CEK delivery', () => {
  it('binds the recipient and the LCH Key ID', async () => {
    const senderWallet = new ProtoWallet(new PrivateKey(1))
    const recipientWallet = new ProtoWallet(new PrivateKey(2))
    const recipient = (await recipientWallet.getPublicKey({ identityKey: true })).publicKey
    const cek = new Uint8Array(32).fill(9)
    const keyId = await keyIdFor(cek)
    const sender = new WalletBRC78KeyDelivery(senderWallet, length =>
      new Uint8Array(length).fill(4)
    )
    const receiver = new WalletBRC78KeyDelivery(recipientWallet)
    const payload = await sender.deliver(recipient, keyId, cek)
    expect(payload.slice(0, 4)).toEqual(Uint8Array.of(0x42, 0x42, 0x10, 0x33))
    await expect(receiver.recover(payload)).resolves.toEqual({ keyId, cek })
  })
})
