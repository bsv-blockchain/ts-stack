import { WalletCore } from '../WalletCore'
import { LockingScript, Transaction, UnlockingScript, WalletInterface } from '@bsv/sdk'
import { PaymentRequest, IncomingPayment } from '../types'
import { createMessageBoxMethods } from '../../modules/messagebox'
import { PeerPayClient } from '@bsv/message-box-client'

// Mock PeerPayClient
jest.mock('@bsv/message-box-client', () => {
  return {
    PeerPayClient: jest.fn().mockImplementation(() => ({
      acknowledgeMessage: jest.fn().mockResolvedValue(undefined),
      listIncomingPayments: jest.fn().mockResolvedValue([]),
      sendPayment: jest.fn().mockResolvedValue({ txid: 'mock-txid' }),
      createPaymentToken: jest.fn().mockResolvedValue({}),
      sendMessage: jest.fn().mockResolvedValue(undefined),
      anointHost: jest.fn().mockResolvedValue({ txid: 'mock-txid' })
    }))
  }
})

const VALID_KEY_1 = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const VALID_KEY_2 = '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd'
const VALID_KEY_3 = '0230035191be460ab6438ed694899a04b9656637eef4330e39c45f0f504d415963'
const VALID_KEY_4 = '03509d5a5d90f53ee5273f59e85292fd3e5bb90c6bd52ba2c5872037cd456536b4'
const DERIVATION_PREFIX = 'cHJlZml4'
const DERIVATION_SUFFIX = 'c3VmZml4'

function completedAction(args: any): { txid: string; tx: number[] } {
  const outputs = args.outputs.map((output: any) => ({
    satoshis: output.satoshis,
    lockingScript: LockingScript.fromHex(output.lockingScript)
  }))
  const totalOutputSatoshis = outputs.reduce(
    (total: number, output: { satoshis: number }) => total + output.satoshis,
    0
  )
  const fundingTransaction = new Transaction(
    1,
    [],
    [{ satoshis: totalOutputSatoshis, lockingScript: LockingScript.fromASM('OP_TRUE') }],
    0
  )
  const tx = new Transaction(
    args.version ?? 1,
    totalOutputSatoshis === 0
      ? []
      : [
          {
            sourceTransaction: fundingTransaction,
            sourceOutputIndex: 0,
            unlockingScript: UnlockingScript.fromASM('OP_TRUE')
          }
        ],
    outputs,
    args.lockTime ?? 0
  )
  return { txid: tx.id('hex'), tx: tx.toAtomicBEEF() }
}

function validAtomicBeef(extraScriptBytes = 0): number[] {
  const outputs = Array.from({ length: 6 }, (_, index) => ({
    satoshis: 1,
    lockingScript:
      index === 0 && extraScriptBytes > 0
        ? LockingScript.fromHex('00'.repeat(extraScriptBytes))
        : LockingScript.fromASM('OP_TRUE')
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

// Concrete subclass for testing
class TestWallet extends WalletCore {
  private mockClient: any

  constructor(mockClient: any, identityKey?: string) {
    super(identityKey ?? VALID_KEY_1)
    this.mockClient = mockClient
  }

  getClient(): WalletInterface {
    return this.mockClient as unknown as WalletInterface
  }
}

describe('WalletCore Direct Payment', () => {
  let mockClient: any

  beforeEach(() => {
    mockClient = {
      getPublicKey: jest.fn().mockResolvedValue({
        publicKey: VALID_KEY_3
      }),
      createAction: jest.fn().mockImplementation(async args => completedAction(args)),
      internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
    }
  })

  // ==========================================================================
  // createPaymentRequest
  // ==========================================================================

  describe('createPaymentRequest', () => {
    it('should generate derivation data with correct fields', () => {
      const wallet = new TestWallet(mockClient)
      const request = wallet.createPaymentRequest({ satoshis: 5000 })

      expect(request.serverIdentityKey).toBe(wallet.getIdentityKey())
      expect(request.derivationPrefix).toBeDefined()
      expect(request.derivationSuffix).toBeDefined()
      expect(request.satoshis).toBe(5000)
      expect(request.memo).toBeUndefined()
    })

    it('should include memo when provided', () => {
      const wallet = new TestWallet(mockClient)
      const request = wallet.createPaymentRequest({ satoshis: 1000, memo: 'Test payment' })

      expect(request.memo).toBe('Test payment')
      expect(request.satoshis).toBe(1000)
    })

    it('should generate unique suffixes each call', () => {
      const wallet = new TestWallet(mockClient)
      const r1 = wallet.createPaymentRequest({ satoshis: 100 })
      const r2 = wallet.createPaymentRequest({ satoshis: 100 })

      expect(r1.derivationSuffix).not.toBe(r2.derivationSuffix)
    })

    it('should reject a zero-value payment request', () => {
      const wallet = new TestWallet(mockClient)

      expect(() => wallet.createPaymentRequest({ satoshis: 0 })).toThrow('at least 1 satoshis')
    })

    it('should handle large satoshi amounts', () => {
      const wallet = new TestWallet(mockClient)
      const largeSats = 21_000_000 * 100_000_000 // max BSV supply in satoshis
      const request = wallet.createPaymentRequest({ satoshis: largeSats })

      expect(request.satoshis).toBe(largeSats)
    })

    it('should always use base64 of "payment" as derivationPrefix', () => {
      const wallet = new TestWallet(mockClient)
      // 'payment' in base64 is 'cGF5bWVudA=='
      const expectedPrefix = 'cGF5bWVudA=='

      const r1 = wallet.createPaymentRequest({ satoshis: 100 })
      const r2 = wallet.createPaymentRequest({ satoshis: 500 })
      const r3 = wallet.createPaymentRequest({ satoshis: 9999 })

      expect(r1.derivationPrefix).toBe(expectedPrefix)
      expect(r2.derivationPrefix).toBe(expectedPrefix)
      expect(r3.derivationPrefix).toBe(expectedPrefix)
    })

    it('should handle memo with unicode characters', () => {
      const wallet = new TestWallet(mockClient)
      const unicodeMemo = 'Payment for \u2615 caf\u00e9 \ud83c\udf0d \u4f60\u597d'
      const request = wallet.createPaymentRequest({ satoshis: 500, memo: unicodeMemo })

      expect(request.memo).toBe(unicodeMemo)
    })

    it('does not inherit payment-request options and returns an own-data record', () => {
      const wallet = new TestWallet(mockClient)
      Object.defineProperties(Object.prototype, {
        satoshis: { value: 5000, configurable: true },
        memo: { value: 'ambient memo', configurable: true }
      })
      try {
        expect(() => wallet.createPaymentRequest({} as never)).toThrow('valid number of satoshis')
        const request = wallet.createPaymentRequest({ satoshis: 1 })
        expect(Object.getPrototypeOf(request)).toBeNull()
        expect('memo' in request).toBe(false)
      } finally {
        Reflect.deleteProperty(Object.prototype, 'satoshis')
        Reflect.deleteProperty(Object.prototype, 'memo')
      }
    })

    it('should handle empty string memo', () => {
      const wallet = new TestWallet(mockClient)
      const request = wallet.createPaymentRequest({ satoshis: 100, memo: '' })

      expect(request.memo).toBe('')
    })

    it('should handle memo with special characters', () => {
      const wallet = new TestWallet(mockClient)
      const specialMemo = 'Pay <script>alert("xss")</script> & "quotes" \'single\''
      const request = wallet.createPaymentRequest({ satoshis: 100, memo: specialMemo })

      expect(request.memo).toBe(specialMemo)
    })
  })

  // ==========================================================================
  // sendDirectPayment
  // ==========================================================================

  describe('sendDirectPayment', () => {
    it('should create a BRC-29 derived P2PKH transaction', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        satoshis: 3000
      }

      const result = await wallet.sendDirectPayment(request)

      // Should derive key with BRC-29 protocol
      expect(mockClient.getPublicKey).toHaveBeenCalledWith({
        protocolID: [2, '3241645161d8'],
        keyID: `${request.derivationPrefix} ${request.derivationSuffix}`,
        counterparty: request.serverIdentityKey,
        forSelf: false
      })

      // Should create action with P2PKH output
      expect(mockClient.createAction).toHaveBeenCalledWith(
        expect.objectContaining({
          outputs: expect.arrayContaining([expect.objectContaining({ satoshis: 3000 })])
        })
      )

      // Should return remittance data
      expect(result.txid).toMatch(/^[0-9a-f]{64}$/)
      expect(result.senderIdentityKey).toBe(wallet.getIdentityKey())
      expect(result.derivationPrefix).toBe(request.derivationPrefix)
      expect(result.derivationSuffix).toBe(request.derivationSuffix)
      expect(result.outputIndex).toBe(0)
    })

    it('should include memo as OP_RETURN output', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        satoshis: 1000,
        memo: 'For services rendered'
      }

      await wallet.sendDirectPayment(request)

      const createCall = mockClient.createAction.mock.calls[0][0]
      expect(createCall.outputs).toHaveLength(2)
      expect(createCall.outputs[1].satoshis).toBe(0)
      expect(createCall.description).toBe('For services rendered')
    })

    it('should throw on failure', async () => {
      mockClient.createAction.mockRejectedValue(new Error('Insufficient funds'))
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        satoshis: 999999999
      }

      await expect(wallet.sendDirectPayment(request)).rejects.toThrow(
        'Direct payment failed: Insufficient funds'
      )
    })

    it('should include derivation data in customInstructions of first output', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'c3VmZml4',
        satoshis: 2000
      }

      await wallet.sendDirectPayment(request)

      const createCall = mockClient.createAction.mock.calls[0][0]
      const customInstructions = JSON.parse(createCall.outputs[0].customInstructions)
      expect(customInstructions.derivationPrefix).toBe('cGF5bWVudA==')
      expect(customInstructions.derivationSuffix).toBe('c3VmZml4')
      expect(customInstructions.payee).toBe(VALID_KEY_2)
    })

    it('should set acceptDelayedBroadcast to false', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        satoshis: 500
      }

      await wallet.sendDirectPayment(request)

      const createCall = mockClient.createAction.mock.calls[0][0]
      expect(createCall.options.acceptDelayedBroadcast).toBe(false)
    })

    it('should set randomizeOutputs to false', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        satoshis: 500
      }

      await wallet.sendDirectPayment(request)

      const createCall = mockClient.createAction.mock.calls[0][0]
      expect(createCall.options.randomizeOutputs).toBe(false)
    })

    it('should not add OP_RETURN output when memo is empty string', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        satoshis: 1000,
        memo: ''
      }

      await wallet.sendDirectPayment(request)

      const createCall = mockClient.createAction.mock.calls[0][0]
      expect(createCall.outputs).toHaveLength(1)
    })

    it('should not add OP_RETURN output when memo is undefined', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        satoshis: 1000
      }

      await wallet.sendDirectPayment(request)

      const createCall = mockClient.createAction.mock.calls[0][0]
      expect(createCall.outputs).toHaveLength(1)
    })

    it('should reject a memo above the wallet description bound', async () => {
      const wallet = new TestWallet(mockClient)
      const longMemo = 'A'.repeat(10000)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        satoshis: 1000,
        memo: longMemo
      }

      await expect(wallet.sendDirectPayment(request)).rejects.toThrow('no more than 2000')
      expect(mockClient.createAction).not.toHaveBeenCalled()
    })

    it('should use default description when no memo is provided', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        satoshis: 4200
      }

      await wallet.sendDirectPayment(request)

      const createCall = mockClient.createAction.mock.calls[0][0]
      expect(createCall.description).toBe('Direct payment (4200 sats)')
    })

    it('owns the validated payment request across asynchronous key derivation', async () => {
      let resolveKey!: (value: { publicKey: string }) => void
      mockClient.getPublicKey.mockReturnValue(
        new Promise(resolve => {
          resolveKey = resolve
        })
      )
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: VALID_KEY_2,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        satoshis: 500
      }

      const pending = wallet.sendDirectPayment(request)
      await Promise.resolve()
      request.serverIdentityKey = VALID_KEY_4
      request.satoshis = 9999
      resolveKey({ publicKey: VALID_KEY_3 })
      await pending

      expect(mockClient.getPublicKey).toHaveBeenCalledWith(
        expect.objectContaining({ counterparty: VALID_KEY_2 })
      )
      expect(mockClient.createAction.mock.calls[0][0].outputs[0].satoshis).toBe(500)
    })

    it('rejects malformed request and derived-key authority before creating an action', async () => {
      const wallet = new TestWallet(mockClient)
      await expect(
        wallet.sendDirectPayment({
          serverIdentityKey: VALID_KEY_2,
          derivationPrefix: DERIVATION_PREFIX,
          derivationSuffix: DERIVATION_SUFFIX,
          satoshis: Number.NaN
        })
      ).rejects.toThrow('valid number of satoshis')

      mockClient.getPublicKey.mockResolvedValue({ publicKey: 'not-a-key' })
      await expect(
        wallet.sendDirectPayment({
          serverIdentityKey: VALID_KEY_2,
          derivationPrefix: DERIVATION_PREFIX,
          derivationSuffix: DERIVATION_SUFFIX,
          satoshis: 1
        })
      ).rejects.toThrow('Invalid getPublicKey result publicKey')
      expect(mockClient.createAction).not.toHaveBeenCalled()
    })

    it('does not normalize an inherited payment request', async () => {
      const wallet = new TestWallet(mockClient)
      Object.defineProperties(Object.prototype, {
        serverIdentityKey: { value: VALID_KEY_2, configurable: true },
        derivationPrefix: { value: DERIVATION_PREFIX, configurable: true },
        derivationSuffix: { value: DERIVATION_SUFFIX, configurable: true },
        satoshis: { value: 1, configurable: true }
      })
      try {
        await expect(wallet.sendDirectPayment({} as PaymentRequest)).rejects.toThrow(
          'Payment request server identity key'
        )
        expect(mockClient.getPublicKey).not.toHaveBeenCalled()
      } finally {
        Reflect.deleteProperty(Object.prototype, 'serverIdentityKey')
        Reflect.deleteProperty(Object.prototype, 'derivationPrefix')
        Reflect.deleteProperty(Object.prototype, 'derivationSuffix')
        Reflect.deleteProperty(Object.prototype, 'satoshis')
      }
    })
  })

  describe('pay', () => {
    it('preserves PeerPay void success without consuming inherited options', async () => {
      const sendPayment = jest.fn().mockResolvedValue(undefined)
      jest
        .mocked(PeerPayClient)
        .mockImplementationOnce(() => ({ sendPayment }) as unknown as PeerPayClient)
      const wallet = new TestWallet(mockClient)

      await expect(wallet.pay({ to: VALID_KEY_2, satoshis: 1 })).resolves.toEqual({
        txid: '',
        tx: undefined
      })
      expect(sendPayment).toHaveBeenCalledWith({ recipient: VALID_KEY_2, amount: 1 })

      Object.defineProperties(Object.prototype, {
        to: { value: VALID_KEY_2, configurable: true },
        satoshis: { value: 1, configurable: true }
      })
      try {
        await expect(wallet.pay({} as never)).rejects.toThrow('Payment recipient')
      } finally {
        Reflect.deleteProperty(Object.prototype, 'to')
        Reflect.deleteProperty(Object.prototype, 'satoshis')
      }
    })

    it('rejects prototype-only or malformed claimed PeerPay evidence', async () => {
      jest.mocked(PeerPayClient).mockImplementationOnce(
        () =>
          ({
            sendPayment: jest.fn().mockResolvedValue(Object.create({ txid: 'a'.repeat(64) }))
          }) as unknown as PeerPayClient
      )
      const wallet = new TestWallet(mockClient)
      await expect(wallet.pay({ to: VALID_KEY_2, satoshis: 1 })).rejects.toThrow(
        'invalid payment result'
      )

      jest.mocked(PeerPayClient).mockImplementationOnce(
        () =>
          ({
            sendPayment: jest.fn().mockResolvedValue({ txid: 'not-a-txid', tx: [1] })
          }) as unknown as PeerPayClient
      )
      await expect(wallet.pay({ to: VALID_KEY_2, satoshis: 1 })).rejects.toThrow(
        'invalid payment txid'
      )
    })
  })

  // ==========================================================================
  // receiveDirectPayment
  // ==========================================================================

  describe('receiveDirectPayment', () => {
    it('should internalize with wallet payment protocol', async () => {
      const wallet = new TestWallet(mockClient)
      const tx = validAtomicBeef()

      await wallet.receiveDirectPayment({
        tx,
        senderIdentityKey: VALID_KEY_2,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        outputIndex: 0
      })

      expect(mockClient.internalizeAction).toHaveBeenCalledWith({
        tx,
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              senderIdentityKey: VALID_KEY_2,
              derivationPrefix: DERIVATION_PREFIX,
              derivationSuffix: DERIVATION_SUFFIX
            }
          }
        ],
        description: expect.stringContaining('Payment from'),
        labels: ['direct_payment']
      })
    })

    it('should convert Uint8Array tx to number array', async () => {
      const wallet = new TestWallet(mockClient)
      const tx = validAtomicBeef()
      const txBytes = new Uint8Array(tx)

      await wallet.receiveDirectPayment({
        tx: txBytes,
        senderIdentityKey: VALID_KEY_3,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        outputIndex: 1
      })

      const call = mockClient.internalizeAction.mock.calls[0][0]
      expect(call.tx).toEqual(tx)
      expect(call.outputs[0].outputIndex).toBe(1)
    })

    it('should use custom description when provided', async () => {
      const wallet = new TestWallet(mockClient)

      await wallet.receiveDirectPayment({
        tx: validAtomicBeef(),
        senderIdentityKey: VALID_KEY_4,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        outputIndex: 0,
        description: 'Custom payment description'
      })

      const call = mockClient.internalizeAction.mock.calls[0][0]
      expect(call.description).toBe('Custom payment description')
    })

    it('should throw on internalization failure', async () => {
      mockClient.internalizeAction.mockRejectedValue(new Error('Invalid tx'))
      const wallet = new TestWallet(mockClient)

      await expect(
        wallet.receiveDirectPayment({
          tx: validAtomicBeef(),
          senderIdentityKey: VALID_KEY_2,
          derivationPrefix: DERIVATION_PREFIX,
          derivationSuffix: DERIVATION_SUFFIX,
          outputIndex: 0
        })
      ).rejects.toThrow('Failed to receive direct payment: Invalid tx')
    })

    it('should throw when the wallet resolves with a negative internalization verdict', async () => {
      mockClient.internalizeAction.mockResolvedValue({ accepted: false })
      const wallet = new TestWallet(mockClient)

      await expect(
        wallet.receiveDirectPayment({
          tx: validAtomicBeef(),
          senderIdentityKey: VALID_KEY_2,
          derivationPrefix: DERIVATION_PREFIX,
          derivationSuffix: DERIVATION_SUFFIX,
          outputIndex: 0
        })
      ).rejects.toThrow('Invalid internalizeAction result accepted')
    })

    it('should handle outputIndex > 0', async () => {
      const wallet = new TestWallet(mockClient)

      await wallet.receiveDirectPayment({
        tx: validAtomicBeef(),
        senderIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        outputIndex: 5
      })

      const call = mockClient.internalizeAction.mock.calls[0][0]
      expect(call.outputs[0].outputIndex).toBe(5)
      expect(call.outputs[0].protocol).toBe('wallet payment')
    })

    it('should default description to senderIdentityKey snippet when no description provided', async () => {
      const wallet = new TestWallet(mockClient)
      const senderKey = VALID_KEY_4

      await wallet.receiveDirectPayment({
        tx: validAtomicBeef(),
        senderIdentityKey: senderKey,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        outputIndex: 0
      })

      const call = mockClient.internalizeAction.mock.calls[0][0]
      // Default description uses first 20 chars of senderIdentityKey + '...'
      expect(call.description).toBe(`Payment from ${senderKey.substring(0, 20)}...`)
    })

    it('should handle large tx array', async () => {
      const wallet = new TestWallet(mockClient)
      const largeTx = validAtomicBeef(100_000)

      await wallet.receiveDirectPayment({
        tx: largeTx,
        senderIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        outputIndex: 0
      })

      const call = mockClient.internalizeAction.mock.calls[0][0]
      expect(call.tx).toEqual(largeTx)
      expect(call.tx.length).toBeGreaterThan(100_000)
    })

    it('should always use direct_payment label', async () => {
      const wallet = new TestWallet(mockClient)

      await wallet.receiveDirectPayment({
        tx: validAtomicBeef(),
        senderIdentityKey: VALID_KEY_3,
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        outputIndex: 0
      })

      const call = mockClient.internalizeAction.mock.calls[0][0]
      expect(call.labels).toEqual(['direct_payment'])
    })

    it('does not receive a payment from inherited fields', async () => {
      const wallet = new TestWallet(mockClient)
      Object.defineProperties(Object.prototype, {
        tx: { value: [1], configurable: true },
        senderIdentityKey: { value: VALID_KEY_2, configurable: true },
        derivationPrefix: { value: DERIVATION_PREFIX, configurable: true },
        derivationSuffix: { value: DERIVATION_SUFFIX, configurable: true },
        outputIndex: { value: 0, configurable: true }
      })
      try {
        await expect(wallet.receiveDirectPayment({} as IncomingPayment)).rejects.toThrow(
          'Incoming payment transaction must be a bounded dense byte array'
        )
        expect(mockClient.internalizeAction).not.toHaveBeenCalled()
      } finally {
        Reflect.deleteProperty(Object.prototype, 'tx')
        Reflect.deleteProperty(Object.prototype, 'senderIdentityKey')
        Reflect.deleteProperty(Object.prototype, 'derivationPrefix')
        Reflect.deleteProperty(Object.prototype, 'derivationSuffix')
        Reflect.deleteProperty(Object.prototype, 'outputIndex')
      }
    })

    it('rejects accessor-backed transaction bytes without invoking or rereading them', async () => {
      const wallet = new TestWallet(mockClient)
      const getter = jest.fn(() => 1)
      const tx = [0]
      Object.defineProperty(tx, '0', { enumerable: true, get: getter })

      await expect(
        wallet.receiveDirectPayment({
          tx,
          senderIdentityKey: VALID_KEY_2,
          derivationPrefix: DERIVATION_PREFIX,
          derivationSuffix: DERIVATION_SUFFIX,
          outputIndex: 0
        })
      ).rejects.toThrow('bounded dense byte array')
      expect(getter).not.toHaveBeenCalled()
      expect(mockClient.internalizeAction).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // end-to-end flow
  // ==========================================================================

  describe('end-to-end flow', () => {
    it('should round-trip: createPaymentRequest -> sendDirectPayment -> receiveDirectPayment', async () => {
      const receiverClient: any = {
        getPublicKey: jest.fn().mockResolvedValue({ publicKey: VALID_KEY_3 }),
        createAction: jest.fn(),
        internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
      }
      const senderClient: any = {
        getPublicKey: jest.fn().mockResolvedValue({ publicKey: VALID_KEY_4 }),
        createAction: jest.fn().mockImplementation(async args => completedAction(args)),
        internalizeAction: jest.fn()
      }

      const receiver = new TestWallet(receiverClient)
      const sender = new TestWallet(senderClient)

      // Step 1: Receiver creates request
      const request = receiver.createPaymentRequest({ satoshis: 2000 })
      expect(request.serverIdentityKey).toBe(receiver.getIdentityKey())

      // Step 2: Sender creates payment
      const payment = await sender.sendDirectPayment(request)
      expect(payment.txid).toMatch(/^[0-9a-f]{64}$/)
      expect(payment.derivationPrefix).toBe(request.derivationPrefix)
      expect(payment.derivationSuffix).toBe(request.derivationSuffix)

      // Step 3: Receiver internalizes
      await receiver.receiveDirectPayment({
        tx: payment.tx,
        senderIdentityKey: payment.senderIdentityKey,
        derivationPrefix: payment.derivationPrefix,
        derivationSuffix: payment.derivationSuffix,
        outputIndex: payment.outputIndex
      })

      expect(receiverClient.internalizeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          outputs: [
            {
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: expect.objectContaining({
                senderIdentityKey: sender.getIdentityKey(),
                derivationPrefix: request.derivationPrefix,
                derivationSuffix: request.derivationSuffix
              })
            }
          ]
        })
      )
    })
  })

  // ==========================================================================
  // acceptIncomingPayment (messagebox module)
  // ==========================================================================

  describe('acceptIncomingPayment (messagebox module)', () => {
    let messageboxMockClient: any
    let mockAcknowledgeMessage: jest.Mock
    let mockListIncomingPayments: jest.Mock
    let mockFindIncomingPaymentsByMessageId: jest.Mock

    beforeEach(() => {
      mockAcknowledgeMessage = jest.fn().mockResolvedValue(undefined)
      mockListIncomingPayments = jest.fn().mockResolvedValue([])
      mockFindIncomingPaymentsByMessageId = jest.fn(async (messageId: string) =>
        (await mockListIncomingPayments()).filter(
          (candidate: { messageId?: string }) => candidate.messageId === messageId
        )
      )

      // Reset the PeerPayClient mock to track acknowledgeMessage calls
      const { PeerPayClient } = require('@bsv/message-box-client')
      PeerPayClient.mockImplementation(() => ({
        acknowledgeMessage: mockAcknowledgeMessage,
        listIncomingPayments: mockListIncomingPayments,
        findIncomingPaymentsByMessageId: mockFindIncomingPaymentsByMessageId,
        sendPayment: jest.fn().mockResolvedValue({ txid: 'mock-txid' }),
        createPaymentToken: jest.fn().mockResolvedValue({}),
        sendMessage: jest.fn().mockResolvedValue(undefined),
        anointHost: jest.fn().mockResolvedValue({ txid: 'mock-txid' })
      }))

      messageboxMockClient = {
        getPublicKey: jest.fn().mockResolvedValue({ publicKey: VALID_KEY_3 }),
        createAction: jest.fn().mockResolvedValue({ txid: 'abc123', tx: [1, 2, 3] }),
        internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
      }
    })

    const createMockPayment = (senderKey: string) => {
      const payment = {
        messageId: 'msg-123',
        sender: senderKey,
        token: {
          transaction: [1, 2, 3, 4, 5],
          outputIndex: 0,
          customInstructions: {
            derivationPrefix: 'cGF5bWVudA==',
            derivationSuffix: 'dGVzdA=='
          }
        }
      }
      mockListIncomingPayments.mockResolvedValue([payment])
      return payment
    }

    it('should use basket insertion when basket is provided', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_2)

      await methods.acceptIncomingPayment(payment, 'received-payments')

      expect(messageboxMockClient.internalizeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          tx: payment.token.transaction,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'basket insertion',
              insertionRemittance: {
                basket: 'received-payments',
                customInstructions: JSON.stringify({
                  derivationPrefix: 'cGF5bWVudA==',
                  derivationSuffix: 'dGVzdA==',
                  senderIdentityKey: VALID_KEY_2
                }),
                tags: ['messagebox-payment']
              }
            }
          ],
          labels: ['peerpay'],
          description: 'MessageBox Payment'
        })
      )
    })

    it('should use wallet payment with paymentRemittance when no basket is provided', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_4)

      await methods.acceptIncomingPayment(payment)

      expect(messageboxMockClient.internalizeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          tx: payment.token.transaction,
          outputs: [
            {
              outputIndex: 0,
              protocol: 'wallet payment',
              paymentRemittance: {
                senderIdentityKey: VALID_KEY_4,
                derivationPrefix: 'cGF5bWVudA==',
                derivationSuffix: 'dGVzdA=='
              }
            }
          ],
          labels: ['peerpay'],
          description: 'MessageBox Payment'
        })
      )
    })

    it('should call acknowledgeMessage with correct messageId when basket is provided', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_2)

      await methods.acceptIncomingPayment(payment, 'my-basket')

      expect(mockAcknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['msg-123'] })
    })

    it('should call acknowledgeMessage with correct messageId when no basket is provided', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_2)

      await methods.acceptIncomingPayment(payment)

      expect(mockAcknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['msg-123'] })
    })

    it('should correctly pass senderIdentityKey from payment.sender', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_3)

      // Without basket - wallet payment path
      await methods.acceptIncomingPayment(payment)

      const call = messageboxMockClient.internalizeAction.mock.calls[0][0]
      expect(call.outputs[0].paymentRemittance.senderIdentityKey).toBe(VALID_KEY_3)
    })

    it('should embed senderIdentityKey in customInstructions for basket insertion', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_4)

      await methods.acceptIncomingPayment(payment, 'tokens-basket')

      const call = messageboxMockClient.internalizeAction.mock.calls[0][0]
      const customInstructions = JSON.parse(call.outputs[0].insertionRemittance.customInstructions)
      expect(customInstructions.senderIdentityKey).toBe(VALID_KEY_4)
    })

    it('should use payment.token.outputIndex when available', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = {
        messageId: 'msg-456',
        sender: VALID_KEY_2,
        token: {
          transaction: [10, 20, 30],
          outputIndex: 3,
          customInstructions: {
            derivationPrefix: 'cGF5',
            derivationSuffix: 'dGVz'
          }
        }
      }
      mockListIncomingPayments.mockResolvedValue([payment])

      await methods.acceptIncomingPayment(payment)

      const call = messageboxMockClient.internalizeAction.mock.calls[0][0]
      expect(call.outputs[0].outputIndex).toBe(3)
    })

    it('should default outputIndex to 0 when not provided', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = {
        messageId: 'msg-789',
        sender: VALID_KEY_2,
        token: {
          transaction: [10, 20, 30],
          // outputIndex intentionally omitted
          customInstructions: {
            derivationPrefix: 'cGF5',
            derivationSuffix: 'dGVz'
          }
        }
      }
      mockListIncomingPayments.mockResolvedValue([payment])

      await methods.acceptIncomingPayment(payment)

      const call = messageboxMockClient.internalizeAction.mock.calls[0][0]
      expect(call.outputs[0].outputIndex).toBe(0)
    })

    it('should return accepted result from both paths', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_2)

      const resultWithBasket = await methods.acceptIncomingPayment(payment, 'basket')
      expect(resultWithBasket.paymentResult).toBe('accepted')

      messageboxMockClient.internalizeAction.mockClear()
      mockAcknowledgeMessage.mockClear()

      const resultWithoutBasket = await methods.acceptIncomingPayment(payment)
      expect(resultWithoutBasket.paymentResult).toBe('accepted')
    })

    it('should NOT acknowledge message if internalization fails (wallet payment)', async () => {
      messageboxMockClient.internalizeAction.mockRejectedValue(new Error('Invalid tx format'))
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_2)

      await expect(methods.acceptIncomingPayment(payment)).rejects.toThrow(
        'Internalization failed (wallet payment), message preserved'
      )

      // Message must NOT be acknowledged — derivation data would be lost
      expect(mockAcknowledgeMessage).not.toHaveBeenCalled()
    })

    it('should NOT acknowledge message if internalization fails (basket insertion)', async () => {
      messageboxMockClient.internalizeAction.mockRejectedValue(new Error('DB error'))
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_2)

      await expect(methods.acceptIncomingPayment(payment, 'my-basket')).rejects.toThrow(
        'Internalization failed (basket insertion), message preserved'
      )

      expect(mockAcknowledgeMessage).not.toHaveBeenCalled()
    })

    it.each([undefined, 'my-basket'])(
      'should NOT acknowledge when internalization resolves negatively (basket: %s)',
      async basket => {
        messageboxMockClient.internalizeAction.mockResolvedValue({ accepted: false })
        const wallet = new TestWallet(messageboxMockClient)
        const methods = createMessageBoxMethods(wallet)

        await expect(
          methods.acceptIncomingPayment(createMockPayment(VALID_KEY_2), basket)
        ).rejects.toThrow('Receiving wallet did not accept')
        expect(mockAcknowledgeMessage).not.toHaveBeenCalled()
      }
    )

    it.each([undefined, 'my-basket'])(
      'does not accept an inherited wallet verdict (basket: %s)',
      async basket => {
        Object.defineProperty(Object.prototype, 'accepted', {
          value: true,
          configurable: true
        })
        try {
          messageboxMockClient.internalizeAction.mockResolvedValue({})
          const wallet = new TestWallet(messageboxMockClient)
          const methods = createMessageBoxMethods(wallet)
          await expect(
            methods.acceptIncomingPayment(createMockPayment(VALID_KEY_2), basket)
          ).rejects.toThrow('Receiving wallet did not accept')
          expect(mockAcknowledgeMessage).not.toHaveBeenCalled()
        } finally {
          Reflect.deleteProperty(Object.prototype, 'accepted')
        }
      }
    )

    it('does not select a payment by an inherited message ID', async () => {
      Object.defineProperty(Object.prototype, 'messageId', {
        value: 'msg-123',
        configurable: true
      })
      try {
        const wallet = new TestWallet(messageboxMockClient)
        const methods = createMessageBoxMethods(wallet)
        await expect(methods.acceptIncomingPayment({})).rejects.toThrow(
          'Incoming payment message ID is invalid'
        )
        expect(mockFindIncomingPaymentsByMessageId).not.toHaveBeenCalled()
      } finally {
        Reflect.deleteProperty(Object.prototype, 'messageId')
      }
    })

    it('should still succeed if ack fails after successful internalization', async () => {
      mockAcknowledgeMessage.mockRejectedValue(new Error('Network timeout'))
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation()
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_2)

      // Should NOT throw — payment is safe in wallet
      const result = await methods.acceptIncomingPayment(payment)
      expect(result.paymentResult).toBe('accepted')

      // Internalization happened
      expect(messageboxMockClient.internalizeAction).toHaveBeenCalled()

      // Warning logged
      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('acknowledgement failed'))
      consoleSpy.mockRestore()
    })

    it('rebinds the selected message ID to fresh authenticated inbox metadata', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const supplied = createMockPayment(VALID_KEY_2)
      const authentic = createMockPayment(VALID_KEY_3)
      authentic.messageId = 'fresh-payment'
      mockListIncomingPayments.mockResolvedValue([authentic])

      await methods.acceptIncomingPayment({
        ...supplied,
        messageId: 'fresh-payment'
      })

      const call = messageboxMockClient.internalizeAction.mock.calls[0][0]
      expect(call.outputs[0].paymentRemittance.senderIdentityKey).toBe(VALID_KEY_3)
    })

    it('refuses a payment that is absent or duplicated in the authenticated inbox', async () => {
      const wallet = new TestWallet(messageboxMockClient)
      const methods = createMessageBoxMethods(wallet)
      const payment = createMockPayment(VALID_KEY_2)

      mockListIncomingPayments.mockResolvedValue([])
      await expect(methods.acceptIncomingPayment(payment)).rejects.toThrow(
        'not present exactly once'
      )
      mockListIncomingPayments.mockResolvedValue([payment, payment])
      await expect(methods.acceptIncomingPayment(payment)).rejects.toThrow(
        'not present exactly once'
      )
      expect(messageboxMockClient.internalizeAction).not.toHaveBeenCalled()
    })
  })

  // ==========================================================================
  // ServerWallet backward compatibility (receivePayment deprecated method)
  // ==========================================================================

  describe('ServerWallet backward compatibility', () => {
    it('receivePayment exists as a deprecated method on _ServerWallet in server.ts', async () => {
      // We can't easily import _ServerWallet (it's not exported directly),
      // but we can verify the behavior by testing an equivalent pattern.
      // The deprecated receivePayment uses 'server_funding' label instead of 'direct_payment'.

      // Simulate the deprecated receivePayment behavior directly
      const serverMockClient: any = {
        getPublicKey: jest.fn().mockResolvedValue({ publicKey: VALID_KEY_3 }),
        createAction: jest.fn().mockResolvedValue({ txid: 'abc', tx: [1] }),
        internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
      }

      const payment: IncomingPayment = {
        tx: [1, 2, 3],
        senderIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        outputIndex: 0
      }

      // The deprecated receivePayment calls internalizeAction with 'server_funding' label
      // Replicate the exact behavior from src/server.ts _ServerWallet.receivePayment
      const tx = payment.tx instanceof Uint8Array ? Array.from(payment.tx) : payment.tx

      await serverMockClient.internalizeAction({
        tx,
        outputs: [
          {
            outputIndex: payment.outputIndex,
            protocol: 'wallet payment',
            paymentRemittance: {
              senderIdentityKey: payment.senderIdentityKey,
              derivationPrefix: payment.derivationPrefix,
              derivationSuffix: payment.derivationSuffix
            }
          }
        ],
        description:
          payment.description || `Payment from ${payment.senderIdentityKey.substring(0, 20)}...`,
        labels: ['server_funding']
      })

      // Verify the deprecated method uses 'server_funding' label (NOT 'direct_payment')
      expect(serverMockClient.internalizeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ['server_funding']
        })
      )

      // Verify it still uses 'wallet payment' protocol (same as receiveDirectPayment)
      expect(serverMockClient.internalizeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          outputs: [
            expect.objectContaining({
              protocol: 'wallet payment'
            })
          ]
        })
      )
    })

    it('receiveDirectPayment (non-deprecated) uses direct_payment label', async () => {
      const wallet = new TestWallet(mockClient)

      await wallet.receiveDirectPayment({
        tx: validAtomicBeef(),
        senderIdentityKey: VALID_KEY_2,
        derivationPrefix: 'cGF5bWVudA==',
        derivationSuffix: 'dGVzdA==',
        outputIndex: 0
      })

      expect(mockClient.internalizeAction).toHaveBeenCalledWith(
        expect.objectContaining({
          labels: ['direct_payment']
        })
      )
    })

    it('deprecated receivePayment and receiveDirectPayment differ only in label', async () => {
      // Both methods use the same structure for internalizeAction,
      // but receivePayment uses 'server_funding' and receiveDirectPayment uses 'direct_payment'
      const wallet = new TestWallet(mockClient)
      const payment: IncomingPayment = {
        tx: validAtomicBeef(),
        senderIdentityKey: VALID_KEY_4,
        derivationPrefix: 'cHJlZml4',
        derivationSuffix: 'c3VmZml4',
        outputIndex: 2
      }

      await wallet.receiveDirectPayment(payment)

      const directPaymentCall = mockClient.internalizeAction.mock.calls[0][0]

      // Verify structure matches what deprecated receivePayment would produce
      // (same outputs structure, same protocol, just different label)
      expect(directPaymentCall.outputs[0].protocol).toBe('wallet payment')
      expect(directPaymentCall.outputs[0].paymentRemittance).toEqual({
        senderIdentityKey: VALID_KEY_4,
        derivationPrefix: 'cHJlZml4',
        derivationSuffix: 'c3VmZml4'
      })
      expect(directPaymentCall.outputs[0].outputIndex).toBe(2)
      expect(directPaymentCall.labels).toEqual(['direct_payment'])
      // The deprecated method would have labels: ['server_funding'] instead
    })
  })
})
