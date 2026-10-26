/* eslint-env jest */
import { PeerPayClient } from '../PeerPayClient.js'
import {
  CreateHmacResult,
  PrivateKey,
  Script,
  Transaction,
  type CreateActionArgs,
  type SignActionArgs,
  type WalletInterface
} from '@bsv/sdk'
import { jest } from '@jest/globals'

const PAYMENT_SENDER = PrivateKey.fromRandom().toPublicKey().toString()
const PAYMENT_RECIPIENT = PrivateKey.fromRandom().toPublicKey().toString()
const REQUEST_SENDER_1 = PrivateKey.fromRandom().toPublicKey().toString()
const REQUEST_SENDER_2 = PrivateKey.fromRandom().toPublicKey().toString()
const REQUEST_SENDER_3 = PrivateKey.fromRandom().toPublicKey().toString()
const VALID_REQUEST_PROOF = '01'.repeat(32)

const toArray = (msg: any, enc?: 'hex' | 'utf8' | 'base64'): any[] => {
  if (Array.isArray(msg)) return msg.slice()
  if (msg === undefined) return []

  if (typeof msg !== 'string') {
    return Array.from(msg, (item: any) => Math.trunc(item))
  }

  switch (enc) {
    case 'hex': {
      const matches = msg.match(/.{1,2}/g)
      return matches != null ? matches.map(byte => Number.parseInt(byte, 16)) : []
    }
    case 'base64':
      return Array.from(Buffer.from(msg, 'base64'))
    default:
      return Array.from(Buffer.from(msg, 'utf8'))
  }
}

const createMockWalletClient = (): jest.Mocked<WalletInterface> => {
  let pending: Transaction | undefined
  const wallet = {
    getPublicKey: jest.fn(),
    createAction: jest.fn(async (args: CreateActionArgs) => {
      const source = new Transaction()
      source.addOutput({ satoshis: 1_000_000, lockingScript: Script.fromASM('OP_1') })
      pending = new Transaction(args.version ?? 1, [], [], args.lockTime ?? 0)
      pending.addInput({
        sourceTransaction: source,
        sourceOutputIndex: 0,
        unlockingScript: Script.fromASM('OP_1')
      })
      for (const output of args.outputs ?? []) {
        pending.addOutput({
          satoshis: output.satoshis,
          lockingScript: Script.fromHex(output.lockingScript)
        })
      }
      return {
        signableTransaction: {
          reference: 'cGVlcnBheS11bml0',
          tx: pending.toAtomicBEEF(true)
        }
      }
    }),
    signAction: jest.fn(async (_args: SignActionArgs) => ({
      tx: pending!.toAtomicBEEF(true),
      txid: pending!.id('hex')
    })),
    abortAction: jest.fn(async () => ({ aborted: true as const })),
    internalizeAction: jest.fn(),
    createHmac: jest.fn<() => Promise<CreateHmacResult>>().mockResolvedValue({
      hmac: Array<number>(32).fill(1)
    }),
    verifyHmac: jest
      .fn<() => Promise<{ valid: true }>>()
      .mockResolvedValue({ valid: true as const })
  }
  return wallet as unknown as jest.Mocked<WalletInterface>
}

describe('PeerPayClient Unit Tests', () => {
  let peerPayClient: PeerPayClient
  let mockWalletClient: jest.Mocked<WalletInterface>

  beforeEach(() => {
    jest.clearAllMocks()

    mockWalletClient = createMockWalletClient()

    // Ensure a valid compressed public key (33 bytes, hex format)
    mockWalletClient.getPublicKey.mockResolvedValue({
      publicKey: PrivateKey.fromRandom().toPublicKey().toString()
    })

    peerPayClient = new PeerPayClient({
      messageBoxHost: 'https://message-box-us-1.bsvb.tech',
      walletClient: mockWalletClient
    })
    ;(peerPayClient as any).settlementModule.acceptSettlement = jest.fn(
      async (args: any, context: any) => {
        const request = {
          tx: args.settlement.transaction,
          outputs: [
            {
              paymentRemittance: {
                derivationPrefix: args.settlement.customInstructions.derivationPrefix,
                derivationSuffix: args.settlement.customInstructions.derivationSuffix,
                senderIdentityKey: args.sender
              },
              outputIndex: args.settlement.outputIndex ?? 0,
              protocol: 'wallet payment'
            }
          ],
          labels: ['peerpay'],
          description: 'BRC-29 payment received'
        }
        const result = await context.wallet.internalizeAction(request, context.originator)
        if (result?.accepted !== true) {
          return {
            action: 'terminate',
            termination: {
              code: 'brc29.internalize_failed',
              message:
                'BRC-29 settlement failed recipient, amount, transaction, or wallet validation.'
            }
          }
        }
        return { action: 'accept', receiptData: { internalizeResult: result } }
      }
    )
  })

  const bindIncomingPayment = <T>(payment: T): T => {
    jest.spyOn(peerPayClient, 'findIncomingPaymentsByMessageId').mockResolvedValue([payment] as any)
    return payment
  }

  const bindIncomingPaymentRequest = <T>(request: T): T => {
    jest.spyOn(peerPayClient, 'listIncomingPaymentRequests').mockResolvedValue([request] as any)
    return request
  }

  describe('createPaymentToken', () => {
    it('should create a valid payment token', async () => {
      mockWalletClient.getPublicKey.mockResolvedValue({
        publicKey: PrivateKey.fromRandom().toPublicKey().toString()
      })
      const payment = { recipient: PrivateKey.fromRandom().toPublicKey().toString(), amount: 5 }
      const token = await peerPayClient.createPaymentToken(payment)

      expect(token).toHaveProperty('amount', 5)
      expect(mockWalletClient.getPublicKey).toHaveBeenCalledWith(expect.any(Object), undefined)
      expect(mockWalletClient.createAction).toHaveBeenCalledWith(expect.any(Object), undefined)
    })

    it('should throw an error if recipient public key cannot be derived', async () => {
      mockWalletClient.getPublicKey.mockResolvedValue({ publicKey: '' }) // Empty key

      await expect(
        peerPayClient.createPaymentToken({ recipient: PAYMENT_RECIPIENT, amount: 5 })
      ).rejects.toThrow('Failed to derive recipient’s public key')
    })

    it('should throw an error if amount is <= 0', async () => {
      ;(
        mockWalletClient.getPublicKey as jest.MockedFunction<typeof mockWalletClient.getPublicKey>
      ).mockResolvedValue({
        publicKey: PrivateKey.fromRandom().toPublicKey().toString()
      })

      await expect(
        peerPayClient.createPaymentToken({
          recipient: PrivateKey.fromRandom().toPublicKey().toString(),
          amount: 0
        })
      ).rejects.toThrow('Invalid payment details: recipient and valid amount are required')
    })
  })

  // Test: sendPayment
  describe('sendPayment', () => {
    it('should call sendMessage with valid payment', async () => {
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'mockedMessageId'
      })

      const payment = { recipient: PAYMENT_RECIPIENT, amount: 3 }

      console.log('[TEST] Calling sendPayment...')
      await peerPayClient.sendPayment(payment)
      console.log('[TEST] sendPayment finished.')

      expect(sendMessageSpy).toHaveBeenCalledWith(
        {
          recipient: PAYMENT_RECIPIENT,
          messageBox: 'payment_inbox',
          body: expect.any(String)
        },
        undefined
      )
    }, 10000)
  })

  // Test: sendLivePayment
  describe('sendLivePayment', () => {
    it('should call createPaymentToken and sendLiveMessage with correct parameters', async () => {
      jest.spyOn(peerPayClient, 'createPaymentToken').mockResolvedValue({
        customInstructions: {
          derivationPrefix: 'prefix',
          derivationSuffix: 'suffix'
        },
        transaction: Array.from(new Uint8Array([1, 2, 3, 4, 5])),
        amount: 2
      })

      jest.spyOn(peerPayClient, 'sendLiveMessage').mockResolvedValue({
        status: 'success',
        messageId: 'mockedMessageId'
      })

      const payment = { recipient: PAYMENT_RECIPIENT, amount: 2 }
      await peerPayClient.sendLivePayment(payment)

      expect(peerPayClient.createPaymentToken).toHaveBeenCalledWith(payment)
      expect(peerPayClient.sendLiveMessage).toHaveBeenCalledWith(
        {
          recipient: PAYMENT_RECIPIENT,
          messageBox: 'payment_inbox',
          body: '{"customInstructions":{"derivationPrefix":"prefix","derivationSuffix":"suffix"},"transaction":[1,2,3,4,5],"amount":2}'
        },
        undefined
      )
    })

    it('falls back to HTTP when live delivery fails', async () => {
      jest.spyOn(peerPayClient, 'createPaymentToken').mockResolvedValue({
        customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
        transaction: [1, 2, 3],
        amount: 2
      })
      jest.spyOn(peerPayClient, 'sendLiveMessage').mockRejectedValue(new Error('socket failed'))
      const send = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'http-message'
      })

      await peerPayClient.sendLivePayment(
        { recipient: PAYMENT_RECIPIENT, amount: 2 },
        'https://override.example'
      )

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ recipient: PAYMENT_RECIPIENT, messageBox: 'payment_inbox' }),
        'https://override.example'
      )
    })
  })

  // Test: acceptPayment
  describe('acceptPayment', () => {
    it('should call internalizeAction and acknowledgeMessage', async () => {
      mockWalletClient.internalizeAction.mockResolvedValue({ accepted: true })
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('acknowledged')

      const payment = bindIncomingPayment({
        messageId: '123',
        sender: PAYMENT_SENDER,
        token: {
          customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
          transaction: toArray('mockedTransaction', 'utf8'),
          amount: 6
        }
      })

      await peerPayClient.acceptPayment(payment)

      expect(mockWalletClient.internalizeAction).toHaveBeenCalled()
      expect(peerPayClient.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['123'] })
    })

    it('recovers a Uint8Array transaction after JSON message transport', async () => {
      mockWalletClient.internalizeAction.mockResolvedValue({ accepted: true })
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('acknowledged')
      const transaction = JSON.parse(JSON.stringify(new Uint8Array([1, 2, 3])))

      await peerPayClient.acceptPayment(
        bindIncomingPayment({
          messageId: 'json-typed-array',
          sender: PAYMENT_SENDER,
          token: {
            customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
            transaction,
            amount: 6
          }
        })
      )

      expect(mockWalletClient.internalizeAction).toHaveBeenCalledWith(
        expect.objectContaining({ tx: [1, 2, 3] }),
        undefined
      )
      expect(peerPayClient.acknowledgeMessage).toHaveBeenCalledWith({
        messageIds: ['json-typed-array']
      })
    })

    it('rejects a non-contiguous transaction object without internalizing it', async () => {
      const acknowledge = jest.spyOn(peerPayClient, 'acknowledgeMessage')

      await expect(
        peerPayClient.acceptPayment(
          bindIncomingPayment({
            messageId: 'malformed-object',
            sender: PAYMENT_SENDER,
            token: {
              customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
              transaction: { 1: 2 } as any,
              amount: 6
            }
          })
        )
      ).rejects.toThrow('Payment transaction must be a non-empty BRC-100 byte array')

      expect(mockWalletClient.internalizeAction).not.toHaveBeenCalled()
      expect(acknowledge).not.toHaveBeenCalled()
    })

    it('uses only fresh authenticated inbox metadata and contains a post-custody ack failure', async () => {
      mockWalletClient.internalizeAction.mockResolvedValue({ accepted: true })
      const authentic = bindIncomingPayment({
        messageId: 'fresh',
        sender: PAYMENT_SENDER,
        token: {
          customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
          transaction: [1, 2, 3],
          amount: 7
        }
      })
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockRejectedValue(new Error('offline'))

      await expect(
        peerPayClient.acceptPayment({
          ...authentic,
          sender: PrivateKey.fromRandom().toPublicKey().toString(),
          token: { ...authentic.token, transaction: [9], amount: 999 }
        })
      ).resolves.toEqual(expect.objectContaining({ payment: authentic }))
      expect(mockWalletClient.internalizeAction).toHaveBeenCalledWith(
        expect.objectContaining({ tx: [1, 2, 3] }),
        undefined
      )
    })

    it('refuses absent and duplicate inbox matches before wallet mutation', async () => {
      const payment = {
        messageId: 'ambiguous',
        sender: PAYMENT_SENDER,
        token: {
          customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
          transaction: [1],
          amount: 1
        }
      }
      const list = jest
        .spyOn(peerPayClient, 'findIncomingPaymentsByMessageId')
        .mockResolvedValue([])
      await expect(peerPayClient.acceptPayment(payment)).rejects.toThrow('not present exactly once')
      list.mockResolvedValue([payment, payment])
      await expect(peerPayClient.acceptPayment(payment)).rejects.toThrow('not present exactly once')
      expect(mockWalletClient.internalizeAction).not.toHaveBeenCalled()
    })
  })

  // Test: rejectPayment
  describe('rejectPayment', () => {
    it('should refund payment minus fee', async () => {
      mockWalletClient.internalizeAction.mockResolvedValue({ accepted: true })
      jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('acknowledged')

      const payment = bindIncomingPayment({
        messageId: '123',
        sender: PAYMENT_SENDER,
        token: {
          customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
          transaction: toArray('mockedTransaction', 'utf8'),
          amount: 2000
        }
      })

      await peerPayClient.rejectPayment(payment)

      expect(mockWalletClient.internalizeAction).toHaveBeenCalled()
      expect(peerPayClient.sendPayment).toHaveBeenCalledWith({
        recipient: PAYMENT_SENDER,
        amount: 1000 // Deduct satoshi fee
      })
      expect(peerPayClient.acknowledgeMessage).toHaveBeenCalledWith({
        messageIds: ['123']
      })
    })

    it('acknowledges a payment that is too small to refund', async () => {
      const acknowledge = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')
      ;(peerPayClient as any).authFetch = undefined
      await peerPayClient.rejectPayment(
        bindIncomingPayment({
          messageId: 'small',
          sender: PAYMENT_SENDER,
          token: {
            customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
            transaction: [1, 2, 3],
            amount: 1500
          }
        })
      )
      expect(acknowledge).toHaveBeenCalledWith({ messageIds: ['small'] })
    })

    it('tolerates a 401 while acknowledging a payment that is too small to refund', async () => {
      jest
        .spyOn(peerPayClient, 'acknowledgeMessage')
        .mockRejectedValue(new Error('HTTP 401 unauthorized'))

      await expect(
        peerPayClient.rejectPayment(
          bindIncomingPayment({
            messageId: 'small',
            sender: PAYMENT_SENDER,
            token: {
              customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
              transaction: [1, 2, 3],
              amount: 1500
            }
          })
        )
      ).resolves.toBeUndefined()
    })

    it('rethrows a non-authentication acknowledgement failure for a small payment', async () => {
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockRejectedValue(new Error('network failed'))

      await expect(
        peerPayClient.rejectPayment(
          bindIncomingPayment({
            messageId: 'small',
            sender: PAYMENT_SENDER,
            token: {
              customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
              transaction: [1, 2, 3],
              amount: 1500
            }
          })
        )
      ).rejects.toThrow('network failed')
    })

    it('does not fail a completed refund when the final acknowledgement fails', async () => {
      mockWalletClient.internalizeAction.mockResolvedValue({ accepted: true })
      jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockRejectedValue(new Error('offline'))

      await expect(
        peerPayClient.rejectPayment(
          bindIncomingPayment({
            messageId: 'large',
            sender: PAYMENT_SENDER,
            token: {
              customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
              transaction: [1, 2, 3],
              amount: 3000
            }
          })
        )
      ).resolves.toBeUndefined()
    })
  })

  describe('payment acknowledgment ordering', () => {
    const payment = {
      messageId: 'ordered',
      sender: PAYMENT_SENDER,
      token: {
        customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
        transaction: [1, 2, 3],
        amount: 3000
      }
    }

    it('orders internalization, refund, and acknowledgment and retains the message on a failed refund', async () => {
      bindIncomingPayment(payment)
      const order: string[] = []
      mockWalletClient.internalizeAction.mockImplementation(async () => {
        order.push('internalize')
        return { accepted: true }
      })
      const send = jest.spyOn(peerPayClient, 'sendPayment').mockImplementation(async () => {
        order.push('refund')
        return undefined
      })
      const acknowledge = jest
        .spyOn(peerPayClient, 'acknowledgeMessage')
        .mockImplementation(async () => {
          order.push('ack')
          return 'ok'
        })
      await peerPayClient.rejectPayment(payment)
      expect(order).toEqual(['internalize', 'refund', 'ack'])
      acknowledge.mockClear()
      send.mockRejectedValueOnce(new Error('refund unavailable'))
      await expect(peerPayClient.rejectPayment(payment)).rejects.toThrow('refund unavailable')
      expect(acknowledge).not.toHaveBeenCalled()
    })

    it.each([{ accepted: false }, {}])(
      'does not acknowledge or refund an unaccepted payment: %j',
      async result => {
        bindIncomingPayment(payment)
        mockWalletClient.internalizeAction.mockResolvedValue(result)
        const send = jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
        const acknowledge = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')
        await expect(peerPayClient.acceptPayment(payment)).rejects.toThrow(
          'BRC-29 settlement failed recipient, amount, transaction, or wallet validation.'
        )
        await expect(peerPayClient.rejectPayment(payment)).rejects.toThrow()
        expect(send).not.toHaveBeenCalled()
        expect(acknowledge).not.toHaveBeenCalled()
      }
    )
  })

  // Test: listIncomingPayments
  describe('listIncomingPayments', () => {
    it('should return parsed payment messages', async () => {
      const sender1 = PrivateKey.fromRandom().toPublicKey().toString()
      const sender2 = PrivateKey.fromRandom().toPublicKey().toString()
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: '1',
          sender: sender1,
          created_at: '2025-03-05T12:00:00Z',
          updated_at: '2025-03-05T12:05:00Z',
          body: JSON.stringify({
            customInstructions: {
              derivationPrefix: 'cHJlZml4MQ==',
              derivationSuffix: 'c3VmZml4MQ=='
            },
            transaction: toArray('mockedTransaction1', 'utf8'),
            amount: 3
          })
        },
        {
          messageId: '2',
          sender: sender2,
          created_at: '2025-03-05T12:10:00Z',
          updated_at: '2025-03-05T12:15:00Z',
          body: JSON.stringify({
            customInstructions: {
              derivationPrefix: 'cHJlZml4Mg==',
              derivationSuffix: 'c3VmZml4Mg=='
            },
            transaction: toArray('mockedTransaction2', 'utf8'),
            amount: 9
          })
        },
        {
          messageId: 'invalid',
          sender: PAYMENT_SENDER,
          created_at: '2025-03-05T12:20:00Z',
          updated_at: '2025-03-05T12:25:00Z',
          body: '{'
        }
      ])

      const payments = await peerPayClient.listIncomingPayments()

      expect(payments).toHaveLength(2)
      expect(payments[0]).toHaveProperty('sender', sender1)
      expect(payments[0].token.amount).toBe(3)
      expect(payments[1]).toHaveProperty('sender', sender2)
      expect(payments[1].token.amount).toBe(9)
      expect(peerPayClient.listMessages).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1000, pageSize: 100, maxPages: 10 })
      )
    })

    it('drops spoofed senders and malformed payment fields', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'spoofed',
          sender: PAYMENT_SENDER,
          created_at: '2025-03-05T12:00:00Z',
          updated_at: '2025-03-05T12:05:00Z',
          body: {
            sender: PrivateKey.fromRandom().toPublicKey().toString(),
            customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
            transaction: [1],
            amount: 1
          }
        },
        {
          messageId: 'negative',
          sender: PAYMENT_SENDER,
          created_at: '2025-03-05T12:00:00Z',
          updated_at: '2025-03-05T12:05:00Z',
          body: {
            customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
            transaction: [1],
            amount: -1
          }
        }
      ])

      await expect(peerPayClient.listIncomingPayments()).resolves.toEqual([])
    })
  })

  // Test: listIncomingPaymentRequests
  describe('listIncomingPaymentRequests', () => {
    const futureExpiry = Date.now() + 60000
    const pastExpiry = Date.now() - 60000

    it('returns parsed request messages from payment_requests box', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'msg1',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req1',
            amount: 5000,
            description: 'Test request',
            expiresAt: futureExpiry,
            senderIdentityKey: REQUEST_SENDER_1,
            requestProof: VALID_REQUEST_PROOF
          })
        }
      ])
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        messageId: 'msg1',
        sender: REQUEST_SENDER_1,
        requestId: 'req1',
        amount: 5000,
        description: 'Test request'
      })
    })

    it('filters expired requests and acknowledges them', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'expired-msg',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-expired',
            amount: 5000,
            description: 'Expired request',
            expiresAt: pastExpiry,
            senderIdentityKey: REQUEST_SENDER_1,
            requestProof: VALID_REQUEST_PROOF
          })
        },
        {
          messageId: 'active-msg',
          sender: REQUEST_SENDER_2,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-active',
            amount: 3000,
            description: 'Active request',
            expiresAt: futureExpiry,
            senderIdentityKey: REQUEST_SENDER_2,
            requestProof: VALID_REQUEST_PROOF
          })
        }
      ])
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      expect(requests).toHaveLength(1)
      expect(requests[0].requestId).toBe('req-active')
      expect(ackSpy).toHaveBeenCalledWith({ messageIds: ['expired-msg'] })
    })

    it('filters cancelled requests and acknowledges both original and cancel messages', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'original-msg',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-cancel',
            amount: 5000,
            description: 'To be cancelled',
            expiresAt: futureExpiry,
            senderIdentityKey: REQUEST_SENDER_1,
            requestProof: VALID_REQUEST_PROOF
          })
        },
        {
          messageId: 'cancel-msg',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:01:00Z',
          updated_at: '2025-01-01T00:01:00Z',
          body: JSON.stringify({
            requestId: 'req-cancel',
            senderIdentityKey: REQUEST_SENDER_1,
            cancelled: true,
            requestProof: VALID_REQUEST_PROOF
          })
        },
        {
          messageId: 'other-msg',
          sender: REQUEST_SENDER_2,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-other',
            amount: 2000,
            description: 'Other request',
            expiresAt: futureExpiry,
            senderIdentityKey: REQUEST_SENDER_2,
            requestProof: VALID_REQUEST_PROOF
          })
        }
      ])
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      expect(requests).toHaveLength(1)
      expect(requests[0].requestId).toBe('req-other')
      expect(ackSpy).toHaveBeenCalledWith({
        messageIds: expect.arrayContaining(['original-msg', 'cancel-msg'])
      })
    })

    it('discards malformed messages (invalid JSON) and acknowledges them', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'bad-msg',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: 'NOT VALID JSON {{{}'
        },
        {
          messageId: 'good-msg',
          sender: REQUEST_SENDER_2,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-good',
            amount: 5000,
            description: 'Valid request',
            expiresAt: Date.now() + 60000,
            senderIdentityKey: REQUEST_SENDER_2,
            requestProof: VALID_REQUEST_PROOF
          })
        }
      ])
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      expect(requests).toHaveLength(1)
      expect(requests[0].requestId).toBe('req-good')
      expect(ackSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          messageIds: expect.arrayContaining(['bad-msg'])
        })
      )
    })

    it('discards messages with missing required fields and acknowledges them', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'incomplete-msg',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({ requestId: 'req-incomplete' })
        }
      ])
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      expect(requests).toHaveLength(0)
      expect(ackSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          messageIds: expect.arrayContaining(['incomplete-msg'])
        })
      )
    })

    it('only cancels requests from the same sender', async () => {
      const futureExpiry = Date.now() + 60000
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'original-msg',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-1',
            amount: 5000,
            description: 'Real request',
            expiresAt: futureExpiry,
            senderIdentityKey: REQUEST_SENDER_1,
            requestProof: VALID_REQUEST_PROOF
          })
        },
        {
          messageId: 'spoofed-cancel',
          sender: PAYMENT_RECIPIENT,
          created_at: '2025-01-01T00:01:00Z',
          updated_at: '2025-01-01T00:01:00Z',
          body: JSON.stringify({
            requestId: 'req-1',
            senderIdentityKey: PAYMENT_RECIPIENT,
            cancelled: true,
            requestProof: VALID_REQUEST_PROOF
          })
        }
      ])
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      // The request should NOT be cancelled because the cancel came from a different sender
      expect(requests).toHaveLength(1)
      expect(requests[0].requestId).toBe('req-1')
    })

    it('discards a cancellation whose HMAC proof is invalid', async () => {
      mockWalletClient.verifyHmac.mockRejectedValueOnce(new Error('invalid proof'))
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'invalid-cancel',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-1',
            senderIdentityKey: REQUEST_SENDER_1,
            cancelled: true,
            requestProof: VALID_REQUEST_PROOF
          })
        }
      ])
      const acknowledge = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await expect(peerPayClient.listIncomingPaymentRequests()).resolves.toEqual([])
      expect(acknowledge).toHaveBeenCalledWith({ messageIds: ['invalid-cancel'] })
    })

    it('discards a cancellation when the wallet returns valid false without throwing', async () => {
      mockWalletClient.verifyHmac.mockResolvedValueOnce({ valid: false } as never)
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'false-verdict-cancel',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-1',
            senderIdentityKey: REQUEST_SENDER_1,
            cancelled: true,
            requestProof: VALID_REQUEST_PROOF
          })
        }
      ])
      const acknowledge = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await expect(peerPayClient.listIncomingPaymentRequests()).resolves.toEqual([])
      expect(acknowledge).toHaveBeenCalledWith({ messageIds: ['false-verdict-cancel'] })
    })

    it('filters out requests below minAmount and above maxAmount, acknowledges them', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'too-small',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-small',
            amount: 100,
            description: 'Too small',
            expiresAt: futureExpiry,
            senderIdentityKey: REQUEST_SENDER_1,
            requestProof: VALID_REQUEST_PROOF
          })
        },
        {
          messageId: 'too-large',
          sender: REQUEST_SENDER_2,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-large',
            amount: 99999,
            description: 'Too large',
            expiresAt: futureExpiry,
            senderIdentityKey: REQUEST_SENDER_2,
            requestProof: VALID_REQUEST_PROOF
          })
        },
        {
          messageId: 'just-right',
          sender: REQUEST_SENDER_3,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-ok',
            amount: 5000,
            description: 'Just right',
            expiresAt: futureExpiry,
            senderIdentityKey: REQUEST_SENDER_3,
            requestProof: VALID_REQUEST_PROOF
          })
        }
      ])
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests(undefined, {
        minAmount: 1000,
        maxAmount: 10000
      })

      expect(requests).toHaveLength(1)
      expect(requests[0].requestId).toBe('req-ok')
      expect(ackSpy).toHaveBeenCalledWith({
        messageIds: expect.arrayContaining(['too-small', 'too-large'])
      })
    })

    it('binds the body identity to the authenticated envelope and bounds pagination', async () => {
      const list = jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'spoofed-body-sender',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: {
            requestId: 'spoofed-request',
            amount: 5000,
            description: 'Spoofed',
            expiresAt: futureExpiry,
            senderIdentityKey: REQUEST_SENDER_2,
            requestProof: VALID_REQUEST_PROOF
          }
        }
      ])
      const acknowledge = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await expect(peerPayClient.listIncomingPaymentRequests()).resolves.toEqual([])
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1000, pageSize: 100, maxPages: 10 })
      )
      expect(acknowledge).toHaveBeenCalledWith({
        messageIds: ['spoofed-body-sender'],
        host: undefined
      })
    })

    it('fails closed on replayed request identifiers from the same sender', async () => {
      const makeRequest = (messageId: string) => ({
        messageId,
        sender: REQUEST_SENDER_1,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        body: {
          requestId: 'replayed-request',
          amount: 5000,
          description: 'Pay once',
          expiresAt: futureExpiry,
          senderIdentityKey: REQUEST_SENDER_1,
          requestProof: VALID_REQUEST_PROOF
        }
      })
      jest
        .spyOn(peerPayClient, 'listMessages')
        .mockResolvedValue([makeRequest('replay-1'), makeRequest('replay-2')])
      const acknowledge = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await expect(peerPayClient.listIncomingPaymentRequests()).resolves.toEqual([])
      expect(acknowledge).toHaveBeenCalledWith({
        messageIds: ['replay-1', 'replay-2'],
        host: undefined
      })
    })

    it('rejects invalid financial limit policies', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([])

      await expect(
        peerPayClient.listIncomingPaymentRequests(undefined, {
          minAmount: Number.NaN,
          maxAmount: 10_000
        })
      ).rejects.toThrow('limits are invalid')
      await expect(
        peerPayClient.listIncomingPaymentRequests(undefined, {
          minAmount: 10_000,
          maxAmount: 1_000
        })
      ).rejects.toThrow('limits are invalid')
    })
  })

  // Test: fulfillPaymentRequest
  describe('fulfillPaymentRequest', () => {
    const mockRequest = {
      messageId: 'req-msg-1',
      sender: REQUEST_SENDER_1,
      requestId: 'req-id-1',
      amount: 5000,
      description: 'Pay for goods',
      expiresAt: Date.now() + 60000
    }

    it('sends payment for request.amount, sends paid response, acknowledges', async () => {
      bindIncomingPaymentRequest(mockRequest)
      const sendPaymentSpy = jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'resp-msg-id'
      })
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await peerPayClient.fulfillPaymentRequest({ request: mockRequest })

      expect(sendPaymentSpy).toHaveBeenCalledWith(
        { recipient: REQUEST_SENDER_1, amount: 5000 },
        undefined
      )

      const responseBody = JSON.parse((sendMessageSpy.mock.calls[0][0] as any).body)
      expect(responseBody).toMatchObject({
        requestId: 'req-id-1',
        status: 'paid',
        amountPaid: 5000
      })

      expect(ackSpy).toHaveBeenCalledWith({ messageIds: ['req-msg-1'] })
    })

    it('includes note when provided', async () => {
      bindIncomingPaymentRequest(mockRequest)
      jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'resp-msg-id'
      })
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await peerPayClient.fulfillPaymentRequest({ request: mockRequest, note: 'Here you go' })

      const responseBody = JSON.parse((sendMessageSpy.mock.calls[0][0] as any).body)
      expect(responseBody).toMatchObject({ note: 'Here you go' })
    })

    it('uses only the selected message ID and reloads every payment field', async () => {
      bindIncomingPaymentRequest(mockRequest)
      const sendPayment = jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
      jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'response'
      })
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await peerPayClient.fulfillPaymentRequest({
        request: {
          ...mockRequest,
          sender: PAYMENT_RECIPIENT,
          requestId: 'substituted-request',
          amount: 9_999_999
        }
      })

      expect(sendPayment).toHaveBeenCalledWith(
        { recipient: REQUEST_SENDER_1, amount: 5000 },
        undefined
      )
    })

    it('rejects concurrent processing of the same request by one client', async () => {
      bindIncomingPaymentRequest(mockRequest)
      let releasePayment!: () => void
      const paymentPending = new Promise<void>(resolve => {
        releasePayment = resolve
      })
      const sendPayment = jest
        .spyOn(peerPayClient, 'sendPayment')
        .mockImplementation(async () => await paymentPending)
      jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'response'
      })
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const first = peerPayClient.fulfillPaymentRequest({ request: mockRequest })
      while (sendPayment.mock.calls.length === 0) await Promise.resolve()
      await expect(peerPayClient.fulfillPaymentRequest({ request: mockRequest })).rejects.toThrow(
        'already being processed'
      )
      releasePayment()
      await first
      expect(sendPayment).toHaveBeenCalledTimes(1)
    })

    it('does not misreport completed fulfillment when acknowledgement fails', async () => {
      bindIncomingPaymentRequest(mockRequest)
      jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
      jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'response'
      })
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockRejectedValue(new Error('offline'))

      await expect(peerPayClient.fulfillPaymentRequest({ request: mockRequest })).resolves.toBe(
        undefined
      )
    })
  })

  // Test: declinePaymentRequest
  describe('declinePaymentRequest', () => {
    const mockRequest = {
      messageId: 'req-msg-2',
      sender: REQUEST_SENDER_2,
      requestId: 'req-id-2',
      amount: 3000,
      description: 'Pay for service',
      expiresAt: Date.now() + 60000
    }

    it('sends declined response to payment_request_responses and acknowledges request', async () => {
      bindIncomingPaymentRequest(mockRequest)
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'resp-msg-id'
      })
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await peerPayClient.declinePaymentRequest({ request: mockRequest, note: 'Not today' })

      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: REQUEST_SENDER_2,
          messageBox: 'payment_request_responses'
        }),
        undefined
      )

      const responseBody = JSON.parse((sendMessageSpy.mock.calls[0][0] as any).body)
      expect(responseBody).toMatchObject({
        requestId: 'req-id-2',
        status: 'declined',
        note: 'Not today'
      })

      expect(ackSpy).toHaveBeenCalledWith({ messageIds: ['req-msg-2'] })
    })
  })

  // Test: listPaymentRequestResponses
  describe('listPaymentRequestResponses', () => {
    it('returns parsed responses from payment_request_responses box', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'resp-1',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({ requestId: 'req-1', status: 'paid', amountPaid: 5000 })
        },
        {
          messageId: 'resp-2',
          sender: REQUEST_SENDER_2,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({ requestId: 'req-2', status: 'declined', note: 'No funds' })
        }
      ])

      const responses = await peerPayClient.listPaymentRequestResponses()

      expect(responses).toHaveLength(2)
      expect(responses[0]).toMatchObject({
        messageId: 'resp-1',
        sender: REQUEST_SENDER_1,
        requestId: 'req-1',
        status: 'paid',
        amountPaid: 5000
      })
      expect(responses[1]).toMatchObject({
        requestId: 'req-2',
        status: 'declined',
        note: 'No funds'
      })
    })

    it('rejects malformed response authority and bounds retrieval', async () => {
      const list = jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'bad-sender',
          sender: 'not-a-key',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: { requestId: 'req-1', status: 'paid', amountPaid: 5000 }
        },
        {
          messageId: 'bad-amount',
          sender: REQUEST_SENDER_1,
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: { requestId: 'req-1', status: 'paid', amountPaid: '5000' }
        }
      ])

      await expect(peerPayClient.listPaymentRequestResponses()).resolves.toEqual([])
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1000, pageSize: 100, maxPages: 10 })
      )
    })
  })

  // Test: listenForLivePaymentRequests
  describe('listenForLivePaymentRequests', () => {
    it('calls listenForLiveMessages on payment_requests box and converts messages to IncomingPaymentRequest', async () => {
      const listenSpy = jest
        .spyOn(peerPayClient, 'listenForLiveMessages')
        .mockResolvedValue(undefined)
      const onRequest = jest.fn()

      await peerPayClient.listenForLivePaymentRequests({ onRequest })

      expect(listenSpy).toHaveBeenCalledWith(
        expect.objectContaining({ messageBox: 'payment_requests' })
      )

      // Simulate a message arriving by calling the onMessage callback
      const { onMessage } = listenSpy.mock.calls[0][0] as any
      await onMessage({
        messageId: 'live-msg-1',
        sender: REQUEST_SENDER_1,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        body: JSON.stringify({
          requestId: 'req-live-1',
          amount: 3000,
          description: 'Live request',
          expiresAt: Date.now() + 60000,
          senderIdentityKey: REQUEST_SENDER_1,
          requestProof: VALID_REQUEST_PROOF
        })
      })

      expect(onRequest).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'live-msg-1', requestId: 'req-live-1', amount: 3000 })
      )
    })

    it('does not expose a live request unless the wallet affirms its HMAC proof', async () => {
      mockWalletClient.verifyHmac.mockResolvedValueOnce({ valid: false } as never)
      const listen = jest.spyOn(peerPayClient, 'listenForLiveMessages').mockResolvedValue(undefined)
      const onRequest = jest.fn()
      await peerPayClient.listenForLivePaymentRequests({ onRequest })
      const { onMessage } = listen.mock.calls[0][0] as any

      await onMessage({
        messageId: 'unauthenticated-live-request',
        sender: REQUEST_SENDER_1,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        body: {
          requestId: 'unauthenticated-request',
          amount: 3000,
          description: 'Do not expose',
          expiresAt: Date.now() + 60_000,
          senderIdentityKey: REQUEST_SENDER_1,
          requestProof: VALID_REQUEST_PROOF
        }
      })

      expect(onRequest).not.toHaveBeenCalled()
    })
  })

  // Test: listenForLivePaymentRequestResponses
  describe('listenForLivePaymentRequestResponses', () => {
    it('calls listenForLiveMessages on payment_request_responses box and parses responses', async () => {
      const listenSpy = jest
        .spyOn(peerPayClient, 'listenForLiveMessages')
        .mockResolvedValue(undefined)
      const onResponse = jest.fn()

      await peerPayClient.listenForLivePaymentRequestResponses({ onResponse })

      expect(listenSpy).toHaveBeenCalledWith(
        expect.objectContaining({ messageBox: 'payment_request_responses' })
      )

      // Simulate a message arriving
      const { onMessage } = listenSpy.mock.calls[0][0] as any
      await onMessage({
        messageId: 'live-resp-1',
        sender: REQUEST_SENDER_1,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        body: JSON.stringify({ requestId: 'req-1', status: 'paid', amountPaid: 5000 })
      })

      expect(onResponse).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'live-resp-1',
          sender: REQUEST_SENDER_1,
          requestId: 'req-1',
          status: 'paid',
          amountPaid: 5000
        })
      )
    })
  })

  // Test: allowPaymentRequestsFrom
  describe('allowPaymentRequestsFrom', () => {
    it('calls setMessageBoxPermission with messageBox=payment_requests and recipientFee=0', async () => {
      const setPermSpy = jest
        .spyOn(peerPayClient, 'setMessageBoxPermission')
        .mockResolvedValue(undefined)

      await peerPayClient.allowPaymentRequestsFrom({ identityKey: 'trustedKey' })

      expect(setPermSpy).toHaveBeenCalledWith({
        messageBox: 'payment_requests',
        sender: 'trustedKey',
        recipientFee: 0
      })
    })
  })

  // Test: blockPaymentRequestsFrom
  describe('blockPaymentRequestsFrom', () => {
    it('calls setMessageBoxPermission with recipientFee=-1', async () => {
      const setPermSpy = jest
        .spyOn(peerPayClient, 'setMessageBoxPermission')
        .mockResolvedValue(undefined)

      await peerPayClient.blockPaymentRequestsFrom({ identityKey: 'blockedKey' })

      expect(setPermSpy).toHaveBeenCalledWith({
        messageBox: 'payment_requests',
        sender: 'blockedKey',
        recipientFee: -1
      })
    })
  })

  // Test: listPaymentRequestPermissions
  describe('listPaymentRequestPermissions', () => {
    it('calls listMessageBoxPermissions and maps to { identityKey, allowed } array', async () => {
      jest.spyOn(peerPayClient, 'listMessageBoxPermissions').mockResolvedValue([
        {
          sender: 'key1',
          messageBox: 'payment_requests',
          recipientFee: 0,
          status: 'always_allow',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z'
        },
        {
          sender: 'key2',
          messageBox: 'payment_requests',
          recipientFee: -1,
          status: 'blocked',
          createdAt: '2025-01-01T00:00:00Z',
          updatedAt: '2025-01-01T00:00:00Z'
        }
      ])

      const permissions = await peerPayClient.listPaymentRequestPermissions()

      expect(permissions).toHaveLength(2)
      expect(permissions[0]).toEqual({ identityKey: 'key1', allowed: true })
      expect(permissions[1]).toEqual({ identityKey: 'key2', allowed: false })
    })
  })

  // Test: requestPayment
  describe('requestPayment', () => {
    it('sends payment request message to payment_requests box with correct body fields', async () => {
      jest.spyOn(peerPayClient, 'getIdentityKey').mockResolvedValue(PAYMENT_SENDER)
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'mockedMessageId'
      })

      const result = await peerPayClient.requestPayment({
        recipient: PAYMENT_RECIPIENT,
        amount: 1000,
        description: 'Please pay me',
        expiresAt: Date.now() + 60000
      })

      expect(result).toHaveProperty('requestId')
      expect(typeof result.requestId).toBe('string')
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: PAYMENT_RECIPIENT,
          messageBox: 'payment_requests',
          body: expect.stringContaining('"amount":1000')
        }),
        undefined
      )

      const sentBody = JSON.parse((sendMessageSpy.mock.calls[0][0] as any).body)
      expect(sentBody).toHaveProperty('requestId')
      expect(sentBody).toHaveProperty('amount', 1000)
      expect(sentBody).toHaveProperty('description', 'Please pay me')
      expect(sentBody).toHaveProperty('senderIdentityKey', PAYMENT_SENDER)
      expect(sentBody).toHaveProperty('requestProof')
      expect(typeof sentBody.requestProof).toBe('string')
      expect(sentBody.requestProof.length).toBeGreaterThan(0)

      expect(result).toHaveProperty('requestProof')
    })

    it('throws if amount <= 0', async () => {
      await expect(
        peerPayClient.requestPayment({
          recipient: PAYMENT_RECIPIENT,
          amount: 0,
          description: 'Bad request',
          expiresAt: Date.now() + 60000
        })
      ).rejects.toThrow()
    })

    it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5, Number.MAX_SAFE_INTEGER + 1])(
      'rejects non-canonical amount %p',
      async amount => {
        await expect(
          peerPayClient.requestPayment({
            recipient: PAYMENT_RECIPIENT,
            amount,
            description: 'Bad request',
            expiresAt: Date.now() + 60_000
          })
        ).rejects.toThrow('positive safe integer')
      }
    )

    it('rejects stale expiry and malformed wallet proof results before sending', async () => {
      const send = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'should-not-send'
      })
      await expect(
        peerPayClient.requestPayment({
          recipient: PAYMENT_RECIPIENT,
          amount: 1000,
          description: 'Expired',
          expiresAt: Date.now() - 1
        })
      ).rejects.toThrow('future safe-integer')

      jest.spyOn(peerPayClient, 'getIdentityKey').mockResolvedValue(PAYMENT_SENDER)
      mockWalletClient.createHmac
        .mockResolvedValueOnce({ hmac: Array<number>(32).fill(1) })
        .mockResolvedValueOnce({ hmac: [1] } as never)
      await expect(
        peerPayClient.requestPayment({
          recipient: PAYMENT_RECIPIENT,
          amount: 1000,
          description: 'Bad proof',
          expiresAt: Date.now() + 60_000
        })
      ).rejects.toThrow('invalid payment request proof')
      expect(send).not.toHaveBeenCalled()
    })

    it('translates a permission-denied response into a whitelist error', async () => {
      jest.spyOn(peerPayClient, 'getIdentityKey').mockResolvedValue(PAYMENT_SENDER)
      jest.spyOn(peerPayClient, 'sendMessage').mockRejectedValue(new Error('HTTP 403 Forbidden'))

      await expect(
        peerPayClient.requestPayment({
          recipient: PAYMENT_RECIPIENT,
          amount: 1000,
          description: 'Please pay me',
          expiresAt: Date.now() + 60_000
        })
      ).rejects.toThrow("not on the recipient's whitelist")
    })
  })

  // Test: cancelPaymentRequest
  describe('cancelPaymentRequest', () => {
    it('sends cancellation message with requestId, real senderIdentityKey, and cancelled: true', async () => {
      jest.spyOn(peerPayClient, 'getIdentityKey').mockResolvedValue(PAYMENT_SENDER)
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'mockedMessageId'
      })

      await peerPayClient.cancelPaymentRequest({
        recipient: PAYMENT_RECIPIENT,
        requestId: 'existing-request-id',
        requestProof: VALID_REQUEST_PROOF
      })

      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: PAYMENT_RECIPIENT,
          messageBox: 'payment_requests'
        }),
        undefined
      )

      const sentBody = JSON.parse((sendMessageSpy.mock.calls[0][0] as any).body)
      expect(sentBody).toEqual({
        requestId: 'existing-request-id',
        senderIdentityKey: PAYMENT_SENDER,
        requestProof: VALID_REQUEST_PROOF,
        cancelled: true
      })
    })

    it('rejects a non-canonical cancellation proof', async () => {
      await expect(
        peerPayClient.cancelPaymentRequest({
          recipient: PAYMENT_RECIPIENT,
          requestId: 'existing-request-id',
          requestProof: 'not-a-proof'
        })
      ).rejects.toThrow('proof is invalid')
    })
  })

  it('lazily creates and then reuses its dedicated AuthFetch instance', () => {
    const defaultHostClient = new PeerPayClient({ walletClient: mockWalletClient })
    const first = (peerPayClient as any).authFetchInstance
    const second = (peerPayClient as any).authFetchInstance
    expect(first).toBe(second)
    expect(defaultHostClient).toBeInstanceOf(PeerPayClient)
  })
})
