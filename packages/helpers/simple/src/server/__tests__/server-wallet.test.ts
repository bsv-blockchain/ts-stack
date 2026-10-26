/**
 * Tests for `server/server-wallet.ts` — the extracted home of the
 * `_ServerWallet` class and the `ServerWallet.create` factory.
 *
 * `@bsv/wallet-toolbox` is heavily mocked: the goal here is to exercise the
 * factory wiring + the deprecated `receivePayment` method, not the toolbox
 * internals.
 */

import { LockingScript, Transaction, UnlockingScript } from '@bsv/sdk'
import { IncomingPayment, ServerWalletConfig } from '../../core/types'

// Module factories must avoid out-of-scope variables — Jest enforces this.
jest.mock('@bsv/wallet-toolbox', () => ({
  Wallet: jest.fn().mockImplementation(() => ({
    internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
  })),
  WalletStorageManager: jest.fn().mockImplementation(() => ({
    addWalletStorageProvider: jest.fn().mockResolvedValue(undefined)
  })),
  WalletSigner: jest.fn().mockImplementation(() => ({})),
  Services: jest.fn().mockImplementation(() => ({})),
  StorageClient: jest.fn().mockImplementation(() => ({
    makeAvailable: jest.fn().mockResolvedValue(undefined)
  }))
}))

// Mock the per-method modules so we don't have to ship full implementations.
const noopMethods = (): Record<string, unknown> => ({})
jest.mock('../../modules/tokens', () => ({ createTokenMethods: jest.fn(noopMethods) }))
jest.mock('../../modules/inscriptions', () => ({ createInscriptionMethods: jest.fn(noopMethods) }))
jest.mock('../../modules/messagebox', () => ({ createMessageBoxMethods: jest.fn(noopMethods) }))
jest.mock('../../modules/certification', () => ({
  createCertificationMethods: jest.fn(noopMethods)
}))
jest.mock('../../modules/overlay', () => ({ createOverlayMethods: jest.fn(noopMethods) }))
jest.mock('../../modules/did', () => ({ createDIDMethods: jest.fn(noopMethods) }))
jest.mock('../../modules/credentials', () => ({ createCredentialMethods: jest.fn(noopMethods) }))

// A real, deterministic private key (32 zero bytes is a valid scalar in secp256k1
// for our purposes here — we only need PrivateKey.fromHex to succeed).
const VALID_PRIVATE_KEY = '0000000000000000000000000000000000000000000000000000000000000001'
const DERIVATION_PREFIX = 'cA=='
const DERIVATION_SUFFIX = 'cw=='

function validAtomicBeef(): number[] {
  const outputs = Array.from({ length: 3 }, () => ({
    satoshis: 1,
    lockingScript: LockingScript.fromASM('OP_TRUE')
  }))
  const funding = new Transaction(
    1,
    [],
    [{ satoshis: outputs.length, lockingScript: LockingScript.fromASM('OP_TRUE') }],
    0
  )
  return new Transaction(
    1,
    [
      {
        sourceTransaction: funding,
        sourceOutputIndex: 0,
        unlockingScript: UnlockingScript.fromASM('OP_TRUE')
      }
    ],
    outputs,
    0
  ).toAtomicBEEF()
}

describe('ServerWallet.create', () => {
  // We re-require the module after mocks are in place.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ServerWallet } = require('../server-wallet')

  it('returns an object that exposes a wallet client', async () => {
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })

    expect(wallet).toBeDefined()
    expect(typeof wallet.getClient).toBe('function')
    expect(wallet.getClient()).toBeDefined()
  })

  it('defaults the network to "main" when not provided', async () => {
    const { Services } = require('@bsv/wallet-toolbox')
    Services.mockClear()
    await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    // Services is constructed with the resolved network string.
    expect(Services).toHaveBeenCalledWith('main')
  })

  it('uses the supplied network when provided', async () => {
    const { Services } = require('@bsv/wallet-toolbox')
    Services.mockClear()
    await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY, network: 'testnet' })
    expect(Services).toHaveBeenCalledWith('test')
  })

  it('uses the default storage URL when not provided', async () => {
    const { StorageClient } = require('@bsv/wallet-toolbox')
    StorageClient.mockClear()
    await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    expect(StorageClient).toHaveBeenCalledWith(expect.anything(), 'https://storage.babbage.systems')
  })

  it('forwards a custom storage URL to the StorageClient', async () => {
    const { StorageClient } = require('@bsv/wallet-toolbox')
    StorageClient.mockClear()
    await ServerWallet.create({
      privateKey: VALID_PRIVATE_KEY,
      storageUrl: 'https://example.test/storage'
    })
    expect(StorageClient).toHaveBeenCalledWith(expect.anything(), 'https://example.test/storage')
  })

  it('ignores inherited private-key, network, and storage configuration', async () => {
    const { Services, StorageClient } = require('@bsv/wallet-toolbox')
    Object.defineProperties(Object.prototype, {
      privateKey: { value: VALID_PRIVATE_KEY, configurable: true },
      network: { value: 'testnet', configurable: true },
      storageUrl: { value: 'https://ambient.invalid', configurable: true }
    })
    try {
      await expect(ServerWallet.create({} as ServerWalletConfig)).rejects.toThrow(
        'Invalid server wallet configuration'
      )
      Services.mockClear()
      StorageClient.mockClear()
      await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
      expect(Services).toHaveBeenCalledWith('main')
      expect(StorageClient).toHaveBeenCalledWith(
        expect.anything(),
        'https://storage.babbage.systems'
      )
    } finally {
      Reflect.deleteProperty(Object.prototype, 'privateKey')
      Reflect.deleteProperty(Object.prototype, 'network')
      Reflect.deleteProperty(Object.prototype, 'storageUrl')
    }
  })
})

describe('_ServerWallet (via ServerWallet.create) — deprecated receivePayment', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { ServerWallet } = require('../server-wallet')
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const toolbox = require('@bsv/wallet-toolbox')

  let internalizeAction: jest.Mock

  beforeEach(() => {
    internalizeAction = jest.fn().mockResolvedValue({ accepted: true })
    toolbox.Wallet.mockImplementation(() => ({ internalizeAction }))
  })

  const SENDER = '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd'

  it('forwards the supplied tx as-is when it is a number array', async () => {
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    const tx = validAtomicBeef()
    const payment: IncomingPayment = {
      tx,
      senderIdentityKey: SENDER,
      derivationPrefix: 'cGF5bWVudA==',
      derivationSuffix: 'dGVzdA==',
      outputIndex: 0
    }

    await wallet.receivePayment(payment)

    expect(internalizeAction).toHaveBeenCalledTimes(1)
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tx,
        labels: ['server_funding']
      })
    )
  })

  it('converts a Uint8Array tx to a number[] before forwarding', async () => {
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    const tx = validAtomicBeef()
    const payment: IncomingPayment = {
      tx: new Uint8Array(tx),
      senderIdentityKey: SENDER,
      derivationPrefix: DERIVATION_PREFIX,
      derivationSuffix: DERIVATION_SUFFIX,
      outputIndex: 1
    }

    await wallet.receivePayment(payment)

    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tx
      })
    )
  })

  it('uses the supplied description when provided', async () => {
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    await wallet.receivePayment({
      tx: validAtomicBeef(),
      senderIdentityKey: SENDER,
      derivationPrefix: DERIVATION_PREFIX,
      derivationSuffix: DERIVATION_SUFFIX,
      outputIndex: 0,
      description: 'custom description'
    })

    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'custom description'
      })
    )
  })

  it('falls back to a synthesized description when none is supplied', async () => {
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    await wallet.receivePayment({
      tx: validAtomicBeef(),
      senderIdentityKey: SENDER,
      derivationPrefix: DERIVATION_PREFIX,
      derivationSuffix: DERIVATION_SUFFIX,
      outputIndex: 0
    })

    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining(SENDER.substring(0, 20))
      })
    )
  })

  it('falls back to a synthesized description when description is empty', async () => {
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    await wallet.receivePayment({
      tx: validAtomicBeef(),
      senderIdentityKey: SENDER,
      derivationPrefix: DERIVATION_PREFIX,
      derivationSuffix: DERIVATION_SUFFIX,
      outputIndex: 0,
      description: ''
    })

    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        description: expect.stringContaining(SENDER.substring(0, 20))
      })
    )
  })

  it('emits the legacy "server_funding" label and "wallet payment" protocol', async () => {
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    await wallet.receivePayment({
      tx: validAtomicBeef(),
      senderIdentityKey: SENDER,
      derivationPrefix: DERIVATION_PREFIX,
      derivationSuffix: DERIVATION_SUFFIX,
      outputIndex: 2
    })

    const call = internalizeAction.mock.calls[0][0]
    expect(call.labels).toEqual(['server_funding'])
    expect(call.outputs).toEqual([
      {
        outputIndex: 2,
        protocol: 'wallet payment',
        paymentRemittance: {
          senderIdentityKey: SENDER,
          derivationPrefix: DERIVATION_PREFIX,
          derivationSuffix: DERIVATION_SUFFIX
        }
      }
    ])
  })

  it('rejects a negative wallet internalization verdict', async () => {
    internalizeAction.mockResolvedValue({ accepted: false })
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })

    await expect(
      wallet.receivePayment({
        tx: validAtomicBeef(),
        senderIdentityKey: SENDER,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        outputIndex: 0
      })
    ).rejects.toThrow('Receiving wallet did not accept the payment')
  })

  it('rejects inherited payment data and inherited wallet acceptance', async () => {
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    Object.defineProperties(Object.prototype, {
      tx: { value: validAtomicBeef(), configurable: true, writable: true },
      accepted: { value: true, configurable: true, writable: true }
    })
    try {
      await expect(
        wallet.receivePayment({
          senderIdentityKey: SENDER,
          derivationPrefix: DERIVATION_PREFIX,
          derivationSuffix: DERIVATION_SUFFIX,
          outputIndex: 0
        } as IncomingPayment)
      ).rejects.toThrow('Incoming payment transaction must be a bounded dense byte array')

      internalizeAction.mockResolvedValue({})
      await expect(
        wallet.receivePayment({
          tx: validAtomicBeef(),
          senderIdentityKey: SENDER,
          derivationPrefix: DERIVATION_PREFIX,
          derivationSuffix: DERIVATION_SUFFIX,
          outputIndex: 0
        })
      ).rejects.toThrow('Receiving wallet did not accept the payment')
    } finally {
      Reflect.deleteProperty(Object.prototype, 'tx')
      Reflect.deleteProperty(Object.prototype, 'accepted')
    }
  })

  it('rejects accessor bytes and coercive identity objects without invoking attacker code', async () => {
    const wallet = await ServerWallet.create({ privateKey: VALID_PRIVATE_KEY })
    const byteGetter = jest.fn(() => 1)
    const tx = [0]
    Object.defineProperty(tx, '0', { enumerable: true, get: byteGetter })
    await expect(
      wallet.receivePayment({
        tx,
        senderIdentityKey: SENDER,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        outputIndex: 0
      })
    ).rejects.toThrow('bounded dense byte array')
    expect(byteGetter).not.toHaveBeenCalled()

    const coercion = jest.fn(() => SENDER)
    await expect(
      wallet.receivePayment({
        tx: validAtomicBeef(),
        senderIdentityKey: { toString: coercion } as unknown as string,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        outputIndex: 0
      })
    ).rejects.toThrow('identity key')
    expect(coercion).not.toHaveBeenCalled()
    expect(internalizeAction).not.toHaveBeenCalled()
  })
})
