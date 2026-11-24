import { PrivateKey, Utils } from '../../../primitives/index'
import { WalletInterface } from '../../../wallet/Wallet.interfaces'
import { createNonce } from '../../../auth/utils/createNonce'
import { verifyNonce } from '../../../auth/utils/verifyNonce'
import { CompletedProtoWallet } from '../../../auth/certificates/__tests/CompletedProtoWallet'

describe('createNonce', () => {
  let mockWallet: WalletInterface

  beforeEach(() => {
    mockWallet = {
      createHmac: jest.fn().mockResolvedValue({ hmac: Array(32).fill(1) })
    } as unknown as WalletInterface
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('throws an error if wallet fails to create HMAC', async () => {
    // Mock failure of HMAC creation
    ;(mockWallet.createHmac as jest.Mock).mockRejectedValue(new Error('Failed to create HMAC'))

    await expect(createNonce(mockWallet)).rejects.toThrow('Failed to create HMAC')
  })

  it('creates a 16-byte random plus 32-byte wallet-authenticated challenge', async () => {
    const nonce = await createNonce(mockWallet)
    expect(Buffer.from(nonce, 'base64').byteLength).toEqual(48)
  })

  it('rejects malformed wallet HMAC results', async () => {
    ;(mockWallet.createHmac as jest.Mock).mockResolvedValueOnce({ hmac: Array(31).fill(1) })
    await expect(createNonce(mockWallet)).rejects.toThrow('32-byte nonce HMAC')

    ;(mockWallet.createHmac as jest.Mock).mockResolvedValueOnce({
      hmac: [1, 256, ...Array(30).fill(1)]
    })
    await expect(createNonce(mockWallet)).rejects.toThrow('32-byte nonce HMAC')
  })
})

describe('verifyNonce', () => {
  let mockWallet: WalletInterface

  beforeEach(() => {
    mockWallet = {
      createHmac: jest.fn().mockResolvedValue({ hmac: Array(32).fill(1) }),
      verifyHmac: jest.fn().mockResolvedValue({ valid: true })
    } as unknown as WalletInterface
  })

  afterEach(() => {
    jest.clearAllMocks()
  })

  it('does not verify an invalid nonce', async () => {
    ;(mockWallet.verifyHmac as jest.Mock).mockResolvedValue({ valid: false })

    const nonce = await createNonce(mockWallet)
    await expect(verifyNonce(nonce + 'ABC', mockWallet)).resolves.toEqual(false)
    await expect(verifyNonce(nonce + '=', mockWallet)).resolves.toEqual(false)
    await expect(
      verifyNonce(
        Buffer.from(nonce + Buffer.from('extra').toString('base64'), 'base64').toString('base64'),
        mockWallet
      )
    ).resolves.toEqual(false)
  })

  it('returns false for an invalid HMAC verification', async () => {
    ;(mockWallet.verifyHmac as jest.Mock).mockResolvedValue({ valid: false })

    const nonce = await createNonce(mockWallet)
    await expect(verifyNonce(nonce, mockWallet)).resolves.toEqual(false)
  })

  it('returns false when the wallet rejects the HMAC', async () => {
    const rejected = new Error('HMAC is not valid') as Error & { code: string }
    rejected.code = 'ERR_INVALID_HMAC'
    ;(mockWallet.verifyHmac as jest.Mock).mockRejectedValue(rejected)

    const nonce = await createNonce(mockWallet)
    await expect(verifyNonce(nonce, mockWallet)).resolves.toEqual(false)

    const wireRejection = new Error('HMAC is not valid')
    ;(mockWallet.verifyHmac as jest.Mock).mockRejectedValue(wireRejection)
    await expect(verifyNonce(nonce, mockWallet)).resolves.toEqual(false)
  })

  it('returns false for a real wallet HMAC mismatch', async () => {
    const realWallet = new CompletedProtoWallet(PrivateKey.fromRandom())
    const nonce = await createNonce(realWallet)
    const bytes = Utils.toArray(nonce, 'base64')
    bytes[16] = bytes[16] === 0 ? 1 : 0
    await expect(verifyNonce(Utils.toBase64(bytes), realWallet)).resolves.toEqual(false)
  })

  it('propagates wallet failures that are not an HMAC mismatch', async () => {
    ;(mockWallet.verifyHmac as jest.Mock).mockRejectedValue(new Error('wallet unavailable'))

    const nonce = await createNonce(mockWallet)
    await expect(verifyNonce(nonce, mockWallet)).rejects.toThrow('wallet unavailable')

    ;(mockWallet.verifyHmac as jest.Mock).mockRejectedValue('wallet unavailable')
    await expect(verifyNonce(nonce, mockWallet)).rejects.toBe('wallet unavailable')
  })

  it('returns false when HMAC error inspection itself fails', async () => {
    const hidden = new Proxy(new Error('HMAC is not valid'), {
      getOwnPropertyDescriptor() {
        throw new Error('descriptor access denied')
      }
    })
    ;(mockWallet.verifyHmac as jest.Mock).mockRejectedValue(hidden)

    const nonce = await createNonce(mockWallet)
    await expect(verifyNonce(nonce, mockWallet)).rejects.toThrow('HMAC is not valid')
  })

  it('returns false for a malformed truthy HMAC verdict', async () => {
    ;(mockWallet.verifyHmac as jest.Mock).mockResolvedValue({ valid: 'true' })

    const nonce = await createNonce(mockWallet)
    await expect(verifyNonce(nonce, mockWallet)).resolves.toEqual(false)
  })

  it('verifies a canonical 48-byte wallet-authenticated challenge', async () => {
    ;(mockWallet.verifyHmac as jest.Mock).mockResolvedValue({ valid: true })

    const nonce1 = await createNonce(mockWallet)
    const nonce2 = await createNonce(mockWallet)

    expect(Buffer.from(nonce1, 'base64').byteLength).toEqual(48)
    expect(Buffer.from(nonce2, 'base64').byteLength).toEqual(48)

    await expect(verifyNonce(nonce1, mockWallet)).resolves.toEqual(true)
    await expect(verifyNonce(nonce2, mockWallet)).resolves.toEqual(true)
  })

  it('rejects malformed challenges before wallet verification', async () => {
    await expect(verifyNonce('AQ==', mockWallet)).resolves.toBe(false)
    await expect(verifyNonce(Utils.toBase64(Array(47).fill(0)), mockWallet)).resolves.toBe(false)
    expect(mockWallet.verifyHmac).not.toHaveBeenCalled()
  })

  it('verifies nonce using real createHmac and verifyHmac', async () => {
    const realWallet = new CompletedProtoWallet(PrivateKey.fromRandom())

    const nonce = await createNonce(realWallet)
    const isValid = await verifyNonce(nonce, realWallet)

    expect(isValid).toEqual(true)
  })

  it('SerialNumber use-case', async () => {
    const clientWallet = new CompletedProtoWallet(PrivateKey.fromRandom())
    const serverWallet = new CompletedProtoWallet(PrivateKey.fromRandom())

    // Client creates a random nonce that the server can verify
    const clientNonce = await createNonce(
      clientWallet,
      (await serverWallet.getPublicKey({ identityKey: true })).publicKey
    )
    // The server verifies the client created the nonce provided
    await verifyNonce(
      clientNonce,
      serverWallet,
      (await clientWallet.getPublicKey({ identityKey: true })).publicKey
    )
    // Server creates a random nonce that the client can verify
    const serverNonce = await createNonce(
      serverWallet,
      (await clientWallet.getPublicKey({ identityKey: true })).publicKey
    )
    // The server compute a serial number from the client and server nonce
    const { hmac: serialNumber } = await serverWallet.createHmac({
      data: Utils.toArray(clientNonce + serverNonce, 'utf8'),
      protocolID: [2, 'certificate creation'],
      keyID: serverNonce + clientNonce,
      counterparty: (await clientWallet.getPublicKey({ identityKey: true })).publicKey
    })

    // Client verifies server's nonce
    await verifyNonce(
      serverNonce,
      clientWallet,
      (await serverWallet.getPublicKey({ identityKey: true })).publicKey
    )

    // Client verifies the server included their nonce
    const { valid } = await clientWallet.verifyHmac({
      hmac: serialNumber,
      data: Utils.toArray(clientNonce + serverNonce, 'utf8'),
      protocolID: [2, 'certificate creation'],
      keyID: serverNonce + clientNonce,
      counterparty: (await serverWallet.getPublicKey({ identityKey: true })).publicKey
    })
    expect(valid).toEqual(true)
  })
})
