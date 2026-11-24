import { describe, expect, it, jest } from '@jest/globals'
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk'
import { WalletBRC78KeyDelivery, keyIdFor } from '../src/index.js'
import { WalletBRC78KeyRecovery, walletBytes } from '../src/keyRecovery.js'

async function recoveryFixture(length = 103) {
  const sender = new PrivateKey(1).toPublicKey().toString(),
    recipient = new PrivateKey(2).toPublicKey().toString(),
    cek = new Uint8Array(32).fill(9)
  cek[1] = 0
  cek[31] = 255
  const keyId = await keyIdFor(cek),
    messageKeyId = Uint8Array.from({ length: 32 }, (_, index) => index),
    plaintext = [...keyId, ...cek],
    payload = new Uint8Array(length)
  payload.set([0x42, 0x42, 0x10, 0x33])
  payload.set(Utils.toArray(sender, 'hex'), 4)
  payload.set(Utils.toArray(recipient, 'hex'), 37)
  payload.set(messageKeyId, 70)
  payload.fill(255, 102)
  const wallet = {
    getPublicKey: jest.fn(async () => ({ publicKey: recipient })),
    decrypt: jest.fn(async () => ({ plaintext: [...plaintext] }))
  }
  return { sender, recipient, cek, keyId, messageKeyId, plaintext, payload, wallet }
}

describe('BRC-78 CEK delivery', () => {
  it('binds the recipient and the LCH Key ID', async () => {
    const senderWallet = new ProtoWallet(new PrivateKey(1))
    const recipientWallet = new ProtoWallet(new PrivateKey(2))
    const recipient = (await recipientWallet.getPublicKey({ identityKey: true })).publicKey
    const cek = new Uint8Array(32).fill(9)
    const keyId = await keyIdFor(cek)
    const sender = new WalletBRC78KeyDelivery(senderWallet)
    const receiver = new WalletBRC78KeyDelivery(recipientWallet)
    const payload = await sender.deliver(recipient, keyId, cek)
    expect(payload.slice(0, 4)).toEqual(Uint8Array.of(0x42, 0x42, 0x10, 0x33))
    await expect(receiver.recover(payload)).resolves.toEqual({ keyId, cek })
    const tampered = payload.slice()
    tampered[tampered.length - 1] ^= 1
    await expect(receiver.recover(tampered)).rejects.toMatchObject({ code: 'ERR_LCH_KEY' })
  })

  it('recovers recipient-only keys at both payload bounds with the exact wallet protocol fields', async () => {
    for (const length of [103, 65536]) {
      const f = await recoveryFixture(length),
        recovered = await new WalletBRC78KeyRecovery(f.wallet).recover(f.payload)
      expect(recovered).toEqual({ keyId: f.keyId, cek: f.cek })
      expect(f.wallet.getPublicKey).toHaveBeenCalledWith({ identityKey: true })
      expect(f.wallet.decrypt).toHaveBeenCalledWith({
        ciphertext: Array.from({ length: length - 102 }, () => 255),
        protocolID: [2, 'message encryption'],
        keyID: Utils.toBase64(Array.from(f.messageKeyId)),
        counterparty: f.sender
      })
      f.plaintext.fill(0)
      expect(recovered.cek).toEqual(f.cek)
      expect(recovered.keyId).toEqual(f.keyId)
    }
  })

  it('rejects wrong payload types, truncation, oversize and every version-byte substitution before wallet work', async () => {
    const f = await recoveryFixture(),
      recovery = new WalletBRC78KeyRecovery(f.wallet),
      invalid: unknown[] = [
        null,
        [],
        Array.from(f.payload),
        new Uint8Array(102),
        new Uint8Array(65537)
      ]
    for (let index = 0; index < 4; index++) {
      const changed = f.payload.slice()
      changed[index] ^= 1
      invalid.push(changed)
    }
    for (const value of invalid)
      await expect(recovery.recover(value as Uint8Array)).rejects.toMatchObject({
        code: 'ERR_LCH_KEY'
      })
    expect(f.wallet.getPublicKey).not.toHaveBeenCalled()
    expect(f.wallet.decrypt).not.toHaveBeenCalled()
  })

  it('requires valid compressed sender, recipient and wallet identities and refuses another recipient', async () => {
    const f = await recoveryFixture(),
      recovery = new WalletBRC78KeyRecovery(f.wallet)
    for (const offset of [4, 37]) {
      const changed = f.payload.slice()
      changed[offset] = 4
      await expect(recovery.recover(changed)).rejects.toThrow('identity binding')
    }
    for (const publicKey of [
      false,
      '',
      f.recipient.slice(2),
      '04' + f.recipient.slice(2),
      f.sender
    ]) {
      f.wallet.getPublicKey.mockResolvedValueOnce({ publicKey: publicKey as string })
      await expect(recovery.recover(f.payload)).rejects.toThrow()
    }
    expect(f.wallet.decrypt).not.toHaveBeenCalled()
  })

  it('owns the payload before an identity lookup yields and pins the original installed wallet methods', async () => {
    const f = await recoveryFixture()
    let release!: (value: { publicKey: string }) => void
    const originalIdentity = f.wallet.getPublicKey,
      originalDecrypt = f.wallet.decrypt
    originalIdentity.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve
        })
    )
    const recovery = new WalletBRC78KeyRecovery(f.wallet),
      pending = recovery.recover(f.payload)
    f.payload.fill(0)
    f.wallet.getPublicKey = jest.fn(async () => {
      throw new Error('Changed identity method')
    })
    f.wallet.decrypt = jest.fn(async () => {
      throw new Error('Changed decrypt method')
    })
    release({ publicKey: f.recipient })
    await expect(pending).resolves.toEqual({ keyId: f.keyId, cek: f.cek })
    expect(originalIdentity).toHaveBeenCalledTimes(1)
    expect(originalDecrypt).toHaveBeenCalledWith({
      ciphertext: [255],
      protocolID: [2, 'message encryption'],
      keyID: Utils.toBase64(Array.from(f.messageKeyId)),
      counterparty: f.sender
    })
    expect(f.wallet.getPublicKey).not.toHaveBeenCalled()
    expect(f.wallet.decrypt).not.toHaveBeenCalled()
  })

  it('does not invoke inherited or accessor-backed wallet result fields', async () => {
    const f = await recoveryFixture(),
      recovery = new WalletBRC78KeyRecovery(f.wallet)
    let reads = 0
    for (const value of [
      Object.create({ publicKey: f.recipient }),
      {
        get publicKey() {
          reads++
          return f.recipient
        }
      }
    ]) {
      f.wallet.getPublicKey.mockResolvedValueOnce(value)
      await expect(recovery.recover(f.payload)).rejects.toThrow('own data property')
    }
    for (const value of [
      Object.create({ plaintext: f.plaintext }),
      {
        get plaintext() {
          reads++
          return f.plaintext
        }
      }
    ]) {
      f.wallet.decrypt.mockResolvedValueOnce(value)
      await expect(recovery.recover(f.payload)).rejects.toThrow('key recovery failed')
    }
    expect(reads).toBe(0)
  })

  it('retains wallet-decryption failure causes and rejects malformed plaintext without granting a key', async () => {
    const f = await recoveryFixture(),
      recovery = new WalletBRC78KeyRecovery(f.wallet),
      cause = new Error('Synthetic wallet failure')
    f.wallet.decrypt.mockRejectedValueOnce(cause)
    await expect(recovery.recover(f.payload)).rejects.toMatchObject({ code: 'ERR_LCH_KEY', cause })
    for (const value of [
      null,
      {},
      [],
      new Uint8Array(64),
      f.plaintext.slice(1),
      [...f.plaintext, 0],
      [-1, ...f.plaintext.slice(1)],
      [256, ...f.plaintext.slice(1)],
      [0.5, ...f.plaintext.slice(1)]
    ]) {
      f.wallet.decrypt.mockResolvedValueOnce({ plaintext: value as number[] })
      await expect(recovery.recover(f.payload)).rejects.toThrow('invalid decrypted key payload')
    }
    const changed = [...f.plaintext]
    changed[0] ^= 1
    f.wallet.decrypt.mockResolvedValueOnce({ plaintext: changed })
    await expect(recovery.recover(f.payload)).rejects.toThrow('does not match Key ID')
  })

  it('validates byte values and exact or maximum lengths while retaining detached zero and 255 bytes', () => {
    const input = [0, 255],
      copied = walletBytes(input, 2, 'fixture', 2)
    input[0] = 1
    expect(copied).toEqual(Uint8Array.of(0, 255))
    expect(walletBytes([0], 2, 'fixture')).toEqual(Uint8Array.of(0))
    for (const value of [
      null,
      {},
      new Uint8Array(2),
      [],
      [0, 1, 2],
      [-1],
      [256],
      [0.5],
      [NaN],
      [Infinity],
      ['0'],
      [undefined]
    ])
      expect(() => walletBytes(value, 2, 'fixture')).toThrow('invalid fixture')
    expect(() => walletBytes([0], 2, 'fixture', 2)).toThrow('invalid fixture')
  })

  it('refuses a missing wallet plaintext byte even when zero-filling would produce a matching CEK', async () => {
    const f = await recoveryFixture(),
      sparse = [...f.plaintext]
    delete sparse[33]
    f.wallet.decrypt.mockResolvedValueOnce({ plaintext: sparse })
    await expect(new WalletBRC78KeyRecovery(f.wallet).recover(f.payload)).rejects.toMatchObject({
      code: 'ERR_LCH_KEY'
    })
  })

  it('copies only own byte values without executing array accessors or custom iteration', () => {
    let reads = 0
    const accessor = [0]
    Object.defineProperty(accessor, '0', {
      get() {
        reads++
        return 0
      }
    })
    const inherited = [0]
    delete inherited[0]
    Object.setPrototypeOf(inherited, { 0: 0 })
    for (const value of [accessor, inherited])
      expect(() => walletBytes(value, 1, 'fixture', 1)).toThrow('invalid fixture')
    const original = [0, 255]
    Object.defineProperty(original, Symbol.iterator, {
      value() {
        reads++
        throw new Error('Custom iteration must not run')
      }
    })
    expect(walletBytes(original, 2, 'fixture', 2)).toEqual(Uint8Array.of(0, 255))
    expect(reads).toBe(0)
  })
})
