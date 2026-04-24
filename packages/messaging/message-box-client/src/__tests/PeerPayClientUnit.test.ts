/* eslint-env jest */
import { PeerPayClient } from '../PeerPayClient.js'
import { WalletClient, CreateHmacResult, PrivateKey } from '@bsv/sdk'
import { jest } from '@jest/globals'

const toArray = (msg: any, enc?: 'hex' | 'utf8' | 'base64'): any[] => {
  if (Array.isArray(msg)) return msg.slice()
  if (msg === undefined) return []

  if (typeof msg !== 'string') {
    return Array.from(msg, (item: any) => item | 0)
  }

  switch (enc) {
    case 'hex': {
      const matches = msg.match(/.{1,2}/g)
      return matches != null ? matches.map(byte => parseInt(byte, 16)) : []
    }
    case 'base64':
      return Array.from(Buffer.from(msg, 'base64'))
    default:
      return Array.from(Buffer.from(msg, 'utf8'))
  }
}

// Mock dependencies
jest.mock('@bsv/sdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
  const actualSDK = jest.requireActual('@bsv/sdk') as any

  return {
    ...actualSDK,
    WalletClient: jest.fn().mockImplementation(() => ({
      getPublicKey: jest.fn(),
      createAction: jest.fn(),
      internalizeAction: jest.fn(),
      createHmac: jest.fn<() => Promise<CreateHmacResult>>().mockResolvedValue({
        hmac: [1, 2, 3, 4, 5]
      }),
      verifyHmac: jest.fn<() => Promise<{ valid: true }>>().mockResolvedValue({ valid: true as const })
    }))
  }
})

describe('PeerPayClient Unit Tests', () => {
  let peerPayClient: PeerPayClient
  let mockWalletClient: jest.Mocked<WalletClient>

  beforeEach(() => {
    jest.clearAllMocks()

    mockWalletClient = new WalletClient() as jest.Mocked<WalletClient>

    // Ensure a valid compressed public key (33 bytes, hex format)
    mockWalletClient.getPublicKey.mockResolvedValue({
      publicKey: PrivateKey.fromRandom().toPublicKey().toString()
    })

    mockWalletClient.createAction.mockResolvedValue({
      tx: toArray('mockedTransaction', 'utf8')
    })

    peerPayClient = new PeerPayClient({
      messageBoxHost: 'https://message-box-us-1.bsvb.tech',
      walletClient: mockWalletClient
    })
  })

  describe('createPaymentToken', () => {
    it('should create a valid payment token', async () => {
      mockWalletClient.getPublicKey.mockResolvedValue({
        publicKey: PrivateKey.fromRandom().toPublicKey().toString()
      })
      mockWalletClient.createAction.mockResolvedValue({ tx: toArray('mockedTransaction', 'utf8') })

      const payment = { recipient: PrivateKey.fromRandom().toPublicKey().toString(), amount: 5 }
      const token = await peerPayClient.createPaymentToken(payment)

      expect(token).toHaveProperty('amount', 5)
      expect(mockWalletClient.getPublicKey).toHaveBeenCalledWith(expect.any(Object), undefined)
      expect(mockWalletClient.createAction).toHaveBeenCalledWith(expect.any(Object), undefined)
    })

    it('should throw an error if recipient public key cannot be derived', async () => {
      mockWalletClient.getPublicKey.mockResolvedValue({ publicKey: '' }) // Empty key

      await expect(peerPayClient.createPaymentToken({ recipient: 'invalid', amount: 5 }))
        .rejects.toThrow('Failed to derive recipient’s public key')
    })

    it('should throw an error if amount is <= 0', async () => {
      (mockWalletClient.getPublicKey as jest.MockedFunction<typeof mockWalletClient.getPublicKey>)
        .mockResolvedValue({
          publicKey: PrivateKey.fromRandom().toPublicKey().toString()
        })

      await expect(peerPayClient.createPaymentToken({
        recipient: PrivateKey.fromRandom().toPublicKey().toString(),
        amount: 0
      }))
        .rejects.toThrow('Invalid payment details: recipient and valid amount are required')
    })
  })

  // Test: sendPayment
  describe('sendPayment', () => {
    it('should call sendMessage with valid payment', async () => {
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'mockedMessageId'
      })

      const payment = { recipient: 'recipientKey', amount: 3 }

      console.log('[TEST] Calling sendPayment...')
      await peerPayClient.sendPayment(payment)
      console.log('[TEST] sendPayment finished.')

      expect(sendMessageSpy).toHaveBeenCalledWith({
        recipient: 'recipientKey',
        messageBox: 'payment_inbox',
        body: expect.any(String)
      }, undefined)
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

      const payment = { recipient: 'recipientKey', amount: 2 }
      await peerPayClient.sendLivePayment(payment)

      expect(peerPayClient.createPaymentToken).toHaveBeenCalledWith(payment)
      expect(peerPayClient.sendLiveMessage).toHaveBeenCalledWith({
        recipient: 'recipientKey',
        messageBox: 'payment_inbox',
        body: '{"customInstructions":{"derivationPrefix":"prefix","derivationSuffix":"suffix"},"transaction":[1,2,3,4,5],"amount":2}'
      }, undefined)
    })
  })

  // Test: acceptPayment
  describe('acceptPayment', () => {
    it('should call internalizeAction and acknowledgeMessage', async () => {
      mockWalletClient.internalizeAction.mockResolvedValue({ accepted: true })
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('acknowledged')

      const payment = {
        messageId: '123',
        sender: 'senderKey',
        token: {
          customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
          transaction: toArray('mockedTransaction', 'utf8'),
          amount: 6
        }
      }

      await peerPayClient.acceptPayment(payment)

      expect(mockWalletClient.internalizeAction).toHaveBeenCalled()
      expect(peerPayClient.acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['123'] })
    })
  })

  // Test: rejectPayment
  describe('rejectPayment', () => {
    it('should refund payment minus fee', async () => {
      jest.spyOn(peerPayClient, 'acceptPayment').mockResolvedValue(undefined)
      jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('acknowledged')

      const payment = {
        messageId: '123',
        sender: 'senderKey',
        token: {
          customInstructions: { derivationPrefix: 'prefix', derivationSuffix: 'suffix' },
          transaction: toArray('mockedTransaction', 'utf8'),
          amount: 2000
        }
      }

      await peerPayClient.rejectPayment(payment)

      expect(peerPayClient.acceptPayment).toHaveBeenCalledWith(payment)
      expect(peerPayClient.sendPayment).toHaveBeenCalledWith({
        recipient: 'senderKey',
        amount: 1000 // Deduct satoshi fee
      })
      expect(peerPayClient.acknowledgeMessage).toHaveBeenCalledWith({
        messageIds: ['123']
      })
    })
  })

  // Test: listIncomingPayments
  describe('listIncomingPayments', () => {
    it('should return parsed payment messages', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: '1',
          sender: 'sender1',
          created_at: '2025-03-05T12:00:00Z',
          updated_at: '2025-03-05T12:05:00Z',
          body: JSON.stringify({
            customInstructions: { derivationPrefix: 'prefix1', derivationSuffix: 'suffix1' },
            transaction: toArray('mockedTransaction1', 'utf8'),
            amount: 3
          })
        },
        {
          messageId: '2',
          sender: 'sender2',
          created_at: '2025-03-05T12:10:00Z',
          updated_at: '2025-03-05T12:15:00Z',
          body: JSON.stringify({
            customInstructions: { derivationPrefix: 'prefix2', derivationSuffix: 'suffix2' },
            transaction: toArray('mockedTransaction2', 'utf8'),
            amount: 9
          })
        }
      ])

      const payments = await peerPayClient.listIncomingPayments()

      expect(payments).toHaveLength(2)
      expect(payments[0]).toHaveProperty('sender', 'sender1')
      expect(payments[0].token.amount).toBe(3)
      expect(payments[1]).toHaveProperty('sender', 'sender2')
      expect(payments[1].token.amount).toBe(9)
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
          sender: 'sender1',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req1',
            amount: 5000,
            description: 'Test request',
            expiresAt: futureExpiry,
            senderIdentityKey: 'sender1',
            requestProof: 'abcd1234'
          })
        }
      ])
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      expect(requests).toHaveLength(1)
      expect(requests[0]).toMatchObject({
        messageId: 'msg1',
        sender: 'sender1',
        requestId: 'req1',
        amount: 5000,
        description: 'Test request'
      })
    })

    it('filters expired requests and acknowledges them', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'expired-msg',
          sender: 'sender1',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-expired',
            amount: 5000,
            description: 'Expired request',
            expiresAt: pastExpiry,
            senderIdentityKey: 'sender1',
            requestProof: 'abcd1234'
          })
        },
        {
          messageId: 'active-msg',
          sender: 'sender2',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-active',
            amount: 3000,
            description: 'Active request',
            expiresAt: futureExpiry,
            senderIdentityKey: 'sender2',
            requestProof: 'abcd1234'
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
          sender: 'sender1',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-cancel',
            amount: 5000,
            description: 'To be cancelled',
            expiresAt: futureExpiry,
            senderIdentityKey: 'sender1',
            requestProof: 'abcd1234'
          })
        },
        {
          messageId: 'cancel-msg',
          sender: 'sender1',
          created_at: '2025-01-01T00:01:00Z',
          updated_at: '2025-01-01T00:01:00Z',
          body: JSON.stringify({
            requestId: 'req-cancel',
            senderIdentityKey: 'sender1',
            cancelled: true,
            requestProof: 'abcd1234'
          })
        },
        {
          messageId: 'other-msg',
          sender: 'sender2',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-other',
            amount: 2000,
            description: 'Other request',
            expiresAt: futureExpiry,
            senderIdentityKey: 'sender2',
            requestProof: 'abcd1234'
          })
        }
      ])
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      expect(requests).toHaveLength(1)
      expect(requests[0].requestId).toBe('req-other')
      expect(ackSpy).toHaveBeenCalledWith({ messageIds: expect.arrayContaining(['original-msg', 'cancel-msg']) })
    })

    it('discards malformed messages (invalid JSON) and acknowledges them', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'bad-msg',
          sender: 'sender1',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: 'NOT VALID JSON {{{}'
        },
        {
          messageId: 'good-msg',
          sender: 'sender2',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-good',
            amount: 5000,
            description: 'Valid request',
            expiresAt: Date.now() + 60000,
            senderIdentityKey: 'sender2',
            requestProof: 'abcd1234'
          })
        }
      ])
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      expect(requests).toHaveLength(1)
      expect(requests[0].requestId).toBe('req-good')
      expect(ackSpy).toHaveBeenCalledWith(expect.objectContaining({
        messageIds: expect.arrayContaining(['bad-msg'])
      }))
    })

    it('discards messages with missing required fields and acknowledges them', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'incomplete-msg',
          sender: 'sender1',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({ requestId: 'req-incomplete' })
        }
      ])
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      expect(requests).toHaveLength(0)
      expect(ackSpy).toHaveBeenCalledWith(expect.objectContaining({
        messageIds: expect.arrayContaining(['incomplete-msg'])
      }))
    })

    it('only cancels requests from the same sender', async () => {
      const futureExpiry = Date.now() + 60000
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'original-msg',
          sender: 'sender1',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-1',
            amount: 5000,
            description: 'Real request',
            expiresAt: futureExpiry,
            senderIdentityKey: 'sender1',
            requestProof: 'abcd1234'
          })
        },
        {
          messageId: 'spoofed-cancel',
          sender: 'attacker',
          created_at: '2025-01-01T00:01:00Z',
          updated_at: '2025-01-01T00:01:00Z',
          body: JSON.stringify({
            requestId: 'req-1',
            senderIdentityKey: 'attacker',
            cancelled: true,
            requestProof: 'abcd1234'
          })
        }
      ])
      jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests()

      // The request should NOT be cancelled because the cancel came from a different sender
      expect(requests).toHaveLength(1)
      expect(requests[0].requestId).toBe('req-1')
    })

    it('filters out requests below minAmount and above maxAmount, acknowledges them', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'too-small',
          sender: 'sender1',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-small',
            amount: 100,
            description: 'Too small',
            expiresAt: futureExpiry,
            senderIdentityKey: 'sender1',
            requestProof: 'abcd1234'
          })
        },
        {
          messageId: 'too-large',
          sender: 'sender2',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-large',
            amount: 99999,
            description: 'Too large',
            expiresAt: futureExpiry,
            senderIdentityKey: 'sender2',
            requestProof: 'abcd1234'
          })
        },
        {
          messageId: 'just-right',
          sender: 'sender3',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({
            requestId: 'req-ok',
            amount: 5000,
            description: 'Just right',
            expiresAt: futureExpiry,
            senderIdentityKey: 'sender3',
            requestProof: 'abcd1234'
          })
        }
      ])
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      const requests = await peerPayClient.listIncomingPaymentRequests(undefined, { minAmount: 1000, maxAmount: 10000 })

      expect(requests).toHaveLength(1)
      expect(requests[0].requestId).toBe('req-ok')
      expect(ackSpy).toHaveBeenCalledWith({ messageIds: expect.arrayContaining(['too-small', 'too-large']) })
    })
  })

  // Test: fulfillPaymentRequest
  describe('fulfillPaymentRequest', () => {
    const mockRequest = {
      messageId: 'req-msg-1',
      sender: 'senderKey',
      requestId: 'req-id-1',
      amount: 5000,
      description: 'Pay for goods',
      expiresAt: Date.now() + 60000
    }

    it('sends payment for request.amount, sends paid response, acknowledges', async () => {
      const sendPaymentSpy = jest.spyOn(peerPayClient, 'sendPayment').mockResolvedValue(undefined)
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'resp-msg-id'
      })
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await peerPayClient.fulfillPaymentRequest({ request: mockRequest })

      expect(sendPaymentSpy).toHaveBeenCalledWith(
        { recipient: 'senderKey', amount: 5000 },
        undefined
      )

      const responseBody = JSON.parse((sendMessageSpy.mock.calls[0][0] as any).body)
      expect(responseBody).toMatchObject({ requestId: 'req-id-1', status: 'paid', amountPaid: 5000 })

      expect(ackSpy).toHaveBeenCalledWith({ messageIds: ['req-msg-1'] })
    })

    it('includes note when provided', async () => {
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
  })

  // Test: declinePaymentRequest
  describe('declinePaymentRequest', () => {
    const mockRequest = {
      messageId: 'req-msg-2',
      sender: 'senderKey2',
      requestId: 'req-id-2',
      amount: 3000,
      description: 'Pay for service',
      expiresAt: Date.now() + 60000
    }

    it('sends declined response to payment_request_responses and acknowledges request', async () => {
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'resp-msg-id'
      })
      const ackSpy = jest.spyOn(peerPayClient, 'acknowledgeMessage').mockResolvedValue('ok')

      await peerPayClient.declinePaymentRequest({ request: mockRequest, note: 'Not today' })

      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: 'senderKey2',
          messageBox: 'payment_request_responses'
        }),
        undefined
      )

      const responseBody = JSON.parse((sendMessageSpy.mock.calls[0][0] as any).body)
      expect(responseBody).toMatchObject({ requestId: 'req-id-2', status: 'declined', note: 'Not today' })

      expect(ackSpy).toHaveBeenCalledWith({ messageIds: ['req-msg-2'] })
    })
  })

  // Test: listPaymentRequestResponses
  describe('listPaymentRequestResponses', () => {
    it('returns parsed responses from payment_request_responses box', async () => {
      jest.spyOn(peerPayClient, 'listMessages').mockResolvedValue([
        {
          messageId: 'resp-1',
          sender: 'payer1',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({ requestId: 'req-1', status: 'paid', amountPaid: 5000 })
        },
        {
          messageId: 'resp-2',
          sender: 'payer2',
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          body: JSON.stringify({ requestId: 'req-2', status: 'declined', note: 'No funds' })
        }
      ])

      const responses = await peerPayClient.listPaymentRequestResponses()

      expect(responses).toHaveLength(2)
      expect(responses[0]).toMatchObject({ requestId: 'req-1', status: 'paid', amountPaid: 5000 })
      expect(responses[1]).toMatchObject({ requestId: 'req-2', status: 'declined', note: 'No funds' })
    })
  })

  // Test: listenForLivePaymentRequests
  describe('listenForLivePaymentRequests', () => {
    it('calls listenForLiveMessages on payment_requests box and converts messages to IncomingPaymentRequest', async () => {
      const listenSpy = jest.spyOn(peerPayClient, 'listenForLiveMessages').mockResolvedValue(undefined)
      const onRequest = jest.fn()

      await peerPayClient.listenForLivePaymentRequests({ onRequest })

      expect(listenSpy).toHaveBeenCalledWith(
        expect.objectContaining({ messageBox: 'payment_requests' })
      )

      // Simulate a message arriving by calling the onMessage callback
      const { onMessage } = (listenSpy.mock.calls[0][0] as any)
      onMessage({
        messageId: 'live-msg-1',
        sender: 'sender1',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        body: JSON.stringify({
          requestId: 'req-live-1',
          amount: 3000,
          description: 'Live request',
          expiresAt: Date.now() + 60000,
          senderIdentityKey: 'sender1',
          requestProof: 'abcd1234'
        })
      })

      expect(onRequest).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'live-msg-1', requestId: 'req-live-1', amount: 3000 })
      )
    })
  })

  // Test: listenForLivePaymentRequestResponses
  describe('listenForLivePaymentRequestResponses', () => {
    it('calls listenForLiveMessages on payment_request_responses box and parses responses', async () => {
      const listenSpy = jest.spyOn(peerPayClient, 'listenForLiveMessages').mockResolvedValue(undefined)
      const onResponse = jest.fn()

      await peerPayClient.listenForLivePaymentRequestResponses({ onResponse })

      expect(listenSpy).toHaveBeenCalledWith(
        expect.objectContaining({ messageBox: 'payment_request_responses' })
      )

      // Simulate a message arriving
      const { onMessage } = (listenSpy.mock.calls[0][0] as any)
      onMessage({
        messageId: 'live-resp-1',
        sender: 'payer1',
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
        body: JSON.stringify({ requestId: 'req-1', status: 'paid', amountPaid: 5000 })
      })

      expect(onResponse).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'req-1', status: 'paid', amountPaid: 5000 })
      )
    })
  })

  // Test: allowPaymentRequestsFrom
  describe('allowPaymentRequestsFrom', () => {
    it('calls setMessageBoxPermission with messageBox=payment_requests and recipientFee=0', async () => {
      const setPermSpy = jest.spyOn(peerPayClient, 'setMessageBoxPermission').mockResolvedValue(undefined)

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
      const setPermSpy = jest.spyOn(peerPayClient, 'setMessageBoxPermission').mockResolvedValue(undefined)

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
      jest.spyOn(peerPayClient, 'getIdentityKey').mockResolvedValue('myIdentityKey')
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'mockedMessageId'
      })

      const result = await peerPayClient.requestPayment({
        recipient: 'recipientKey',
        amount: 1000,
        description: 'Please pay me',
        expiresAt: Date.now() + 60000
      })

      expect(result).toHaveProperty('requestId')
      expect(typeof result.requestId).toBe('string')
      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: 'recipientKey',
          messageBox: 'payment_requests',
          body: expect.stringContaining('"amount":1000')
        }),
        undefined
      )

      const sentBody = JSON.parse((sendMessageSpy.mock.calls[0][0] as any).body)
      expect(sentBody).toHaveProperty('requestId')
      expect(sentBody).toHaveProperty('amount', 1000)
      expect(sentBody).toHaveProperty('description', 'Please pay me')
      expect(sentBody).toHaveProperty('senderIdentityKey', 'myIdentityKey')
      expect(sentBody).toHaveProperty('requestProof')
      expect(typeof sentBody.requestProof).toBe('string')
      expect(sentBody.requestProof.length).toBeGreaterThan(0)

      expect(result).toHaveProperty('requestProof')
    })

    it('throws if amount <= 0', async () => {
      await expect(peerPayClient.requestPayment({
        recipient: 'recipientKey',
        amount: 0,
        description: 'Bad request',
        expiresAt: Date.now() + 60000
      })).rejects.toThrow()
    })
  })

  // Test: cancelPaymentRequest
  describe('cancelPaymentRequest', () => {
    it('sends cancellation message with requestId, real senderIdentityKey, and cancelled: true', async () => {
      jest.spyOn(peerPayClient, 'getIdentityKey').mockResolvedValue('myIdentityKey')
      const sendMessageSpy = jest.spyOn(peerPayClient, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'mockedMessageId'
      })

      await peerPayClient.cancelPaymentRequest({
        recipient: 'recipientKey',
        requestId: 'existing-request-id',
        requestProof: 'original-proof-hex'
      })

      expect(sendMessageSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient: 'recipientKey',
          messageBox: 'payment_requests'
        }),
        undefined
      )

      const sentBody = JSON.parse((sendMessageSpy.mock.calls[0][0] as any).body)
      expect(sentBody).toEqual({
        requestId: 'existing-request-id',
        senderIdentityKey: 'myIdentityKey',
        requestProof: 'original-proof-hex',
        cancelled: true
      })
    })
  })
})
