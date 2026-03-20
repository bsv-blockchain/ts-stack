import { WalletCore } from '../WalletCore'
import { WalletInterface } from '@bsv/sdk'
import { PaymentRequest } from '../types'

// Concrete subclass for testing
class TestWallet extends WalletCore {
  private mockClient: any

  constructor (mockClient: any) {
    super('030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4')
    this.mockClient = mockClient
  }

  getClient (): WalletInterface {
    return this.mockClient as unknown as WalletInterface
  }
}

describe('WalletCore Direct Payment', () => {
  let mockClient: any

  beforeEach(() => {
    mockClient = {
      getPublicKey: jest.fn().mockResolvedValue({
        publicKey: '0230035191be460ab6438ed694899a04b9656637eef4330e39c45f0f504d415963'
      }),
      createAction: jest.fn().mockResolvedValue({
        txid: 'abc123',
        tx: [1, 2, 3]
      }),
      internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
    }
  })

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
  })

  describe('sendDirectPayment', () => {
    it('should create a BRC-29 derived P2PKH transaction', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd',
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
          outputs: expect.arrayContaining([
            expect.objectContaining({ satoshis: 3000 })
          ])
        })
      )

      // Should return remittance data
      expect(result.txid).toBe('abc123')
      expect(result.senderIdentityKey).toBe(wallet.getIdentityKey())
      expect(result.derivationPrefix).toBe(request.derivationPrefix)
      expect(result.derivationSuffix).toBe(request.derivationSuffix)
      expect(result.outputIndex).toBe(0)
    })

    it('should include memo as OP_RETURN output', async () => {
      const wallet = new TestWallet(mockClient)
      const request: PaymentRequest = {
        serverIdentityKey: '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd',
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
        serverIdentityKey: '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd',
        derivationPrefix: 'a',
        derivationSuffix: 'b',
        satoshis: 999999999
      }

      await expect(wallet.sendDirectPayment(request))
        .rejects.toThrow('Direct payment failed: Insufficient funds')
    })
  })

  describe('receiveDirectPayment', () => {
    it('should internalize with wallet payment protocol', async () => {
      const wallet = new TestWallet(mockClient)

      await wallet.receiveDirectPayment({
        tx: [1, 2, 3],
        senderIdentityKey: '02' + 'aa'.repeat(32),
        derivationPrefix: 'prefix',
        derivationSuffix: 'suffix',
        outputIndex: 0
      })

      expect(mockClient.internalizeAction).toHaveBeenCalledWith({
        tx: [1, 2, 3],
        outputs: [{
          outputIndex: 0,
          protocol: 'wallet payment',
          paymentRemittance: {
            senderIdentityKey: '02' + 'aa'.repeat(32),
            derivationPrefix: 'prefix',
            derivationSuffix: 'suffix'
          }
        }],
        description: expect.stringContaining('Payment from'),
        labels: ['direct_payment']
      })
    })

    it('should convert Uint8Array tx to number array', async () => {
      const wallet = new TestWallet(mockClient)
      const txBytes = new Uint8Array([10, 20, 30])

      await wallet.receiveDirectPayment({
        tx: txBytes,
        senderIdentityKey: '02' + 'bb'.repeat(32),
        derivationPrefix: 'p',
        derivationSuffix: 's',
        outputIndex: 1
      })

      const call = mockClient.internalizeAction.mock.calls[0][0]
      expect(call.tx).toEqual([10, 20, 30])
      expect(call.outputs[0].outputIndex).toBe(1)
    })

    it('should use custom description when provided', async () => {
      const wallet = new TestWallet(mockClient)

      await wallet.receiveDirectPayment({
        tx: [1],
        senderIdentityKey: '02' + 'cc'.repeat(32),
        derivationPrefix: 'p',
        derivationSuffix: 's',
        outputIndex: 0,
        description: 'Custom payment description'
      })

      const call = mockClient.internalizeAction.mock.calls[0][0]
      expect(call.description).toBe('Custom payment description')
    })

    it('should throw on internalization failure', async () => {
      mockClient.internalizeAction.mockRejectedValue(new Error('Invalid tx'))
      const wallet = new TestWallet(mockClient)

      await expect(wallet.receiveDirectPayment({
        tx: [1],
        senderIdentityKey: '02' + 'dd'.repeat(32),
        derivationPrefix: 'p',
        derivationSuffix: 's',
        outputIndex: 0
      })).rejects.toThrow('Failed to receive direct payment: Invalid tx')
    })
  })

  describe('end-to-end flow', () => {
    it('should round-trip: createPaymentRequest → sendDirectPayment → receiveDirectPayment', async () => {
      const receiverClient: any = {
        getPublicKey: jest.fn().mockResolvedValue({ publicKey: '0230035191be460ab6438ed694899a04b9656637eef4330e39c45f0f504d415963' }),
        createAction: jest.fn(),
        internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
      }
      const senderClient: any = {
        getPublicKey: jest.fn().mockResolvedValue({ publicKey: '03509d5a5d90f53ee5273f59e85292fd3e5bb90c6bd52ba2c5872037cd456536b4' }),
        createAction: jest.fn().mockResolvedValue({ txid: 'tx123', tx: [5, 6, 7] }),
        internalizeAction: jest.fn()
      }

      const receiver = new TestWallet(receiverClient)
      const sender = new TestWallet(senderClient)

      // Step 1: Receiver creates request
      const request = receiver.createPaymentRequest({ satoshis: 2000 })
      expect(request.serverIdentityKey).toBe(receiver.getIdentityKey())

      // Step 2: Sender creates payment
      const payment = await sender.sendDirectPayment(request)
      expect(payment.txid).toBe('tx123')
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
          outputs: [{
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: expect.objectContaining({
              senderIdentityKey: sender.getIdentityKey(),
              derivationPrefix: request.derivationPrefix,
              derivationSuffix: request.derivationSuffix
            })
          }]
        })
      )
    })
  })
})
