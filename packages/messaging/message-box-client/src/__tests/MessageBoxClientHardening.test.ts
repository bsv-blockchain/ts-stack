import { PrivateKey, type WalletInterface } from '@bsv/sdk'
import { jest } from '@jest/globals'
import { MessageBoxClient } from '../MessageBoxClient.js'
import type { SendListParams } from '../types/permissions.js'

const identityKey = PrivateKey.fromRandom().toPublicKey().toString()
const recipientA = PrivateKey.fromRandom().toPublicKey().toString()
const recipientB = PrivateKey.fromRandom().toPublicKey().toString()

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'x-bsv-auth-identity-key': identityKey }),
    bodyUsed: false,
    json: async () => body,
    ...init
  } as Response
}

function createWallet(): jest.Mocked<WalletInterface> {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: identityKey }),
    createHmac: jest.fn().mockResolvedValue({ hmac: [1, 2, 3] }),
    encrypt: jest.fn().mockResolvedValue({ ciphertext: [1, 2, 3] }),
    decrypt: jest.fn().mockResolvedValue({
      plaintext: Array.from(Buffer.from('{"secret":true}', 'utf8'))
    }),
    createAction: jest.fn().mockResolvedValue({ tx: [1, 2, 3] }),
    internalizeAction: jest.fn().mockResolvedValue({ accepted: true })
  } as unknown as jest.Mocked<WalletInterface>
}

describe('MessageBoxClient hardening branches', () => {
  let client: MessageBoxClient
  let wallet: jest.Mocked<WalletInterface>
  let fetchMock: jest.SpiedFunction<MessageBoxClient['authFetch']['fetch']>

  beforeEach(() => {
    wallet = createWallet()
    client = new MessageBoxClient({
      host: 'https://message-box.example/api',
      walletClient: wallet
    })
    fetchMock = jest.spyOn(client.authFetch, 'fetch')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('batch sends', () => {
    it.each([
      [
        { recipients: [], messageBox: 'inbox', body: 'hello', skipEncryption: true },
        'at least one recipient'
      ],
      [
        {
          recipients: Array.from({ length: 101 }, () => recipientA),
          messageBox: 'inbox',
          body: 'hello',
          skipEncryption: true
        },
        'at most 100 recipients'
      ],
      [
        { recipients: [recipientA], messageBox: ' ', body: 'hello', skipEncryption: true },
        'provide a messageBox'
      ],
      [
        { recipients: [recipientA], messageBox: 'inbox', body: ' ', skipEncryption: true },
        'must have a body'
      ],
      [
        { recipients: [recipientA], messageBox: 'inbox', body: null, skipEncryption: true },
        'must have a body'
      ],
      [{ recipients: [recipientA], messageBox: 'inbox', body: 'hello' }, 'Set skipEncryption: true']
    ])('rejects invalid batch input %#', async (params, error) => {
      await expect(
        client.sendMessageToRecipients(params as unknown as SendListParams)
      ).rejects.toThrow(error)
    })

    it('returns a structured result when every recipient is blocked', async () => {
      jest.spyOn(client, 'getMessageBoxQuote').mockResolvedValue({
        quotesByRecipient: [],
        blockedRecipients: [recipientA, recipientB],
        deliveryAgentIdentityKeyByHost: undefined as never,
        totals: { deliveryFees: 0, recipientFees: 0, totalForPayableRecipients: 0 }
      })

      await expect(
        client.sendMessageToRecipients({
          recipients: [recipientA, recipientB],
          messageBox: 'inbox',
          body: 'hello',
          skipEncryption: true
        })
      ).resolves.toMatchObject({
        status: 'error',
        sent: [],
        blocked: [recipientA, recipientB],
        failed: [
          { recipient: recipientA, error: 'blocked' },
          { recipient: recipientB, error: 'blocked' }
        ]
      })
    })

    it('rejects missing delivery identities and ambiguous multi-host quotes', async () => {
      const quote = jest.spyOn(client, 'getMessageBoxQuote')
      quote.mockResolvedValueOnce({
        quotesByRecipient: [
          {
            recipient: recipientA,
            messageBox: 'inbox',
            recipientFee: 0,
            deliveryFee: 0,
            status: 'always_allow'
          }
        ],
        blockedRecipients: undefined as never,
        deliveryAgentIdentityKeyByHost: undefined as never,
        totals: { deliveryFees: 0, recipientFees: 0, totalForPayableRecipients: 0 }
      })

      const params: SendListParams = {
        recipients: [recipientA],
        messageBox: 'inbox',
        body: 'hello',
        skipEncryption: true
      }
      await expect(
        client.sendMessageToRecipients(params, 'https://message-box.example/api')
      ).rejects.toThrow('Missing delivery agent identity keys')

      quote.mockResolvedValueOnce({
        quotesByRecipient: [
          {
            recipient: recipientA,
            messageBox: 'inbox',
            recipientFee: 0,
            deliveryFee: 0,
            status: 'always_allow'
          }
        ],
        blockedRecipients: [],
        deliveryAgentIdentityKeyByHost: {
          'https://one.example': identityKey,
          'https://two.example': identityKey
        },
        totals: { deliveryFees: 0, recipientFees: 0, totalForPayableRecipients: 0 }
      })
      jest.spyOn(client, 'resolveHostForRecipient').mockResolvedValue('https://one.example')

      await expect(client.sendMessageToRecipients(params)).rejects.toThrow(
        'Recipients resolve to multiple hosts'
      )

      quote.mockResolvedValueOnce({
        quotesByRecipient: [
          {
            recipient: recipientA,
            messageBox: 'inbox',
            recipientFee: 0,
            deliveryFee: 0,
            status: 'always_allow'
          }
        ],
        blockedRecipients: [],
        deliveryAgentIdentityKeyByHost: {
          'https://message-box.example/api': ''
        },
        totals: { deliveryFees: 0, recipientFees: 0, totalForPayableRecipients: 0 }
      })
      await expect(
        client.sendMessageToRecipients(params, 'https://message-box.example/api')
      ).rejects.toThrow('Could not determine server delivery agent identity key')
    })

    it('reports success, partial success, and zero-result server responses', async () => {
      jest.spyOn(client, 'getMessageBoxQuote').mockResolvedValue({
        quotesByRecipient: [recipientA, recipientB].map(recipient => ({
          recipient,
          messageBox: 'inbox',
          recipientFee: 0,
          deliveryFee: 1,
          status: 'always_allow' as const
        })),
        blockedRecipients: [],
        deliveryAgentIdentityKeyByHost: {
          'https://different.example': identityKey
        },
        totals: { deliveryFees: 2, recipientFees: 0, totalForPayableRecipients: 2 }
      })
      jest.spyOn(client as any, 'createMessagePaymentBatch').mockResolvedValue({
        tx: [1, 2, 3],
        outputs: [],
        description: 'batch'
      })
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ status: 'success', results: [{ recipientA }, { recipientB }] })
        )
        .mockResolvedValueOnce(jsonResponse({ status: 'success', results: [{ recipientA }] }))
        .mockResolvedValueOnce(jsonResponse({ status: 'success', results: [] }))

      const params: SendListParams = {
        recipients: [recipientA, recipientB],
        messageBox: 'inbox',
        body: { hello: 'world' },
        skipEncryption: true
      }
      const overrideHost = 'https://message-box.example/api'

      await expect(client.sendMessageToRecipients(params, overrideHost)).resolves.toMatchObject({
        status: 'success'
      })
      await expect(client.sendMessageToRecipients(params, overrideHost)).resolves.toMatchObject({
        status: 'partial'
      })
      await expect(client.sendMessageToRecipients(params, overrideHost)).resolves.toMatchObject({
        status: 'error'
      })

      const sentBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
      expect(sentBody.message).toMatchObject({
        recipients: [recipientA, recipientB],
        messageId: ['010203', '010203'],
        body: '{"hello":"world"}'
      })
    })

    it('returns recipient failures when the batch endpoint rejects the request', async () => {
      jest.spyOn(client, 'getMessageBoxQuote').mockResolvedValue({
        quotesByRecipient: [
          {
            recipient: recipientA,
            messageBox: 'inbox',
            recipientFee: 0,
            deliveryFee: 1,
            status: 'always_allow'
          }
        ],
        blockedRecipients: [],
        deliveryAgentIdentityKeyByHost: {
          'https://message-box.example/api': identityKey
        },
        totals: { deliveryFees: 1, recipientFees: 0, totalForPayableRecipients: 1 }
      })
      jest.spyOn(client as any, 'createMessagePaymentBatch').mockResolvedValue({
        tx: [1],
        outputs: [],
        description: 'batch'
      })
      fetchMock.mockResolvedValue(
        jsonResponse(
          { status: 'error', description: 'blocked by server' },
          { ok: true, status: 200 }
        )
      )

      await expect(
        client.sendMessageToRecipients(
          {
            recipients: [recipientA],
            messageBox: 'inbox',
            body: 'hello',
            skipEncryption: true
          },
          'https://message-box.example/api'
        )
      ).resolves.toMatchObject({
        status: 'error',
        failed: [{ recipient: recipientA, error: 'blocked by server' }]
      })

      fetchMock.mockResolvedValueOnce(
        jsonResponse({}, { ok: false, status: 503, statusText: 'Unavailable' })
      )
      await expect(
        client.sendMessageToRecipients(
          {
            recipients: [recipientA],
            messageBox: 'inbox',
            body: 'hello',
            skipEncryption: true
          },
          'https://message-box.example/api'
        )
      ).resolves.toMatchObject({
        status: 'error',
        failed: [{ recipient: recipientA, error: 'HTTP 503 - Unavailable' }]
      })
    })

    it('keeps the deprecated batch spelling as a forwarding alias', async () => {
      const send = jest.spyOn(client, 'sendMessageToRecipients').mockResolvedValue({
        status: 'success',
        description: 'ok',
        sent: [],
        blocked: [],
        failed: []
      })
      const params = {
        recipients: [recipientA],
        messageBox: 'inbox',
        body: 'hello',
        skipEncryption: true
      }

      await client.sendMesagetoRecepients(params, 'https://override.example')
      expect(send).toHaveBeenCalledWith(params, 'https://override.example')
    })
  })

  describe('message payment construction', () => {
    it('constructs delivery and recipient outputs for a paid message', async () => {
      const payment = await (client as any).createMessagePayment(recipientA, {
        recipientFee: 2,
        deliveryFee: 3,
        deliveryAgentIdentityKey: identityKey
      })

      expect(payment.tx).toEqual([1, 2, 3])
      expect(payment.outputs).toHaveLength(2)
      expect(wallet.createAction).toHaveBeenCalledWith(
        expect.objectContaining({ outputs: expect.arrayContaining([expect.any(Object)]) }),
        undefined
      )
    })

    it('rejects a zero-fee payment and a wallet action without a transaction', async () => {
      await expect(
        (client as any).createMessagePayment(recipientA, {
          recipientFee: 0,
          deliveryFee: 0,
          deliveryAgentIdentityKey: identityKey
        })
      ).rejects.toThrow('No payment required')

      wallet.createAction.mockResolvedValueOnce({} as never)
      await expect(
        (client as any).createMessagePayment(recipientA, {
          recipientFee: 1,
          deliveryFee: 0,
          deliveryAgentIdentityKey: identityKey
        })
      ).rejects.toThrow('Failed to create payment transaction')
    })

    it('constructs a batch payment and skips missing or zero-fee recipient quotes', async () => {
      const payment = await (client as any).createMessagePaymentBatch(
        [recipientA, recipientB, identityKey],
        new Map([
          [recipientA, { recipientFee: 2, deliveryFee: 3 }],
          [recipientB, { recipientFee: 0, deliveryFee: 3 }]
        ]),
        identityKey
      )

      expect(payment.tx).toEqual([1, 2, 3])
      expect(payment.outputs).toHaveLength(2)
    })
  })

  describe('message listing', () => {
    it('queries the overlay with explicit and current identity keys', async () => {
      const query = jest
        .spyOn((client as any).lookupResolver, 'query')
        .mockResolvedValue({ type: 'output-list', outputs: [] })

      await expect(client.queryAdvertisements()).resolves.toEqual([])
      await expect(
        client.queryAdvertisements(identityKey, 'https://filter.example')
      ).resolves.toEqual([])
      expect(query).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          query: { identityKey, host: 'https://filter.example' }
        })
      )
    })

    it('internalizes payments, decrypts envelopes, and sorts messages newest first', async () => {
      const payment = {
        tx: [1, 2, 3],
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: 'prefix',
              derivationSuffix: 'suffix',
              senderIdentityKey: identityKey
            }
          }
        ],
        description: 'recipient payment'
      }
      fetchMock.mockResolvedValue(
        jsonResponse({
          status: 'success',
          hasMore: false,
          messages: [
            {
              messageId: 'older',
              sender: recipientA,
              timestamp: 1,
              body: JSON.stringify({
                message: JSON.stringify({
                  encryptedMessage: Buffer.from([1, 2, 3]).toString('base64')
                }),
                payment
              })
            },
            {
              messageId: 'newer',
              sender: recipientB,
              timestamp: 2,
              body: JSON.stringify({ message: { plain: true } })
            }
          ]
        })
      )

      const messages = await client.listMessages({
        messageBox: 'inbox',
        host: 'https://message-box.example/api'
      })

      expect(messages.map(message => message.messageId)).toEqual(['newer', 'older'])
      expect(messages[0].body).toEqual({ plain: true })
      expect(messages[1].body).toEqual({ secret: true })
      expect(wallet.internalizeAction).toHaveBeenCalled()
      expect(wallet.decrypt).toHaveBeenCalled()
    })

    it('uses advertised hosts, tolerates a failed host, and deduplicates messages', async () => {
      jest
        .spyOn(client, 'queryAdvertisements')
        .mockResolvedValue([{ host: 'https://advertised.example', txid: 'tx', outputIndex: 0 }])
      fetchMock.mockRejectedValueOnce(new Error('default host unavailable')).mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          messages: [
            { messageId: 'one', sender: recipientA, body: 'plain', timestamp: 1 },
            { messageId: 'one', sender: recipientA, body: 'duplicate', timestamp: 1 }
          ]
        })
      )

      await expect(
        client.listMessages({ messageBox: 'inbox', acceptPayments: false })
      ).resolves.toEqual([expect.objectContaining({ messageId: 'one', body: 'plain' })])
    })

    it('rejects empty boxes and complete host failure while allowing an empty successful inbox', async () => {
      await expect(client.listMessages({ messageBox: ' ' })).rejects.toThrow(
        'MessageBox cannot be empty'
      )

      fetchMock.mockRejectedValueOnce(new Error('offline'))
      await expect(
        client.listMessages({ messageBox: 'inbox', host: 'https://message-box.example/api' })
      ).rejects.toThrow('Failed to retrieve messages from any host')

      fetchMock.mockResolvedValueOnce(
        jsonResponse({ status: 'success', messages: [], hasMore: false })
      )
      await expect(
        client.listMessages({ messageBox: 'inbox', host: 'https://message-box.example/api' })
      ).resolves.toEqual([])
    })

    it.each([
      [
        jsonResponse({}, { ok: false, status: 503, statusText: 'Unavailable' }),
        'HTTP 503 Unavailable'
      ],
      [jsonResponse({ status: 'error', description: 'server error' }), 'server error'],
      [jsonResponse({ status: 'error' }), 'Unknown server error'],
      [jsonResponse({ status: 'success', messages: 'invalid' }), 'invalid messages payload']
    ])('rejects malformed list response %#', async (response, error) => {
      fetchMock.mockResolvedValue(response)
      await expect(
        client.listMessagesLite({
          messageBox: 'inbox',
          host: 'https://message-box.example/api'
        })
      ).rejects.toThrow(error)
    })

    it('allows callers to bound pagination when a server continually claims another page', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ status: 'success', messages: [], hasMore: true }))

      await expect(
        client.listMessagesLite({
          messageBox: 'inbox',
          host: 'https://message-box.example/api',
          maxPages: 100
        })
      ).rejects.toThrow('pagination exceeded 100 pages')
      expect(fetchMock).toHaveBeenCalledTimes(100)
    })

    it('uses server-default pages while honoring client skip and total limits', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({
            status: 'success',
            messages: [{ messageId: 'one', sender: recipientA, body: 'one' }],
            hasMore: true,
            nextOffset: 6
          })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            status: 'success',
            messages: [
              { messageId: 'two', sender: recipientA, body: 'two' },
              { messageId: 'ignored', sender: recipientA, body: 'ignored' }
            ],
            hasMore: true,
            nextOffset: 8
          })
        )

      await expect(
        client.listMessagesLite({
          messageBox: 'inbox',
          host: 'https://message-box.example/api',
          skip: 5,
          limit: 2
        })
      ).resolves.toEqual([
        expect.objectContaining({ messageId: 'one' }),
        expect.objectContaining({ messageId: 'two' })
      ])

      expect(JSON.parse(fetchMock.mock.calls[0][1]?.body as string)).toEqual({
        messageBox: 'inbox',
        offset: 5,
        limit: 2
      })
      expect(JSON.parse(fetchMock.mock.calls[1][1]?.body as string)).toEqual({
        messageBox: 'inbox',
        offset: 6,
        limit: 1
      })
    })

    it('rejects ambiguous or unsafe pagination controls before network work', async () => {
      await expect(
        client.listMessagesLite({ messageBox: 'inbox', offset: 1, skip: 2 })
      ).rejects.toThrow('offset and skip must match')
      await expect(client.listMessagesLite({ messageBox: 'inbox', limit: 0 })).rejects.toThrow(
        'limit must be'
      )
      expect(fetchMock).not.toHaveBeenCalled()
    })

    it('marks an individual message when decryption fails', async () => {
      wallet.decrypt.mockRejectedValue(new Error('cannot decrypt'))
      fetchMock.mockResolvedValue(
        jsonResponse({
          status: 'success',
          messages: [
            {
              messageId: 'bad-encryption',
              sender: recipientA,
              body: JSON.stringify({ encryptedMessage: 'AQID' })
            }
          ]
        })
      )

      const messages = await client.listMessagesLite({
        messageBox: 'inbox',
        host: 'https://message-box.example/api'
      })
      expect(messages[0].body).toBe('[Error: Failed to decrypt or parse message]')
    })

    it('unwraps a string envelope while using the configured default host', async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          status: 'success',
          messages: [
            {
              messageId: 'wrapped',
              sender: recipientA,
              body: JSON.stringify({ message: JSON.stringify({ plain: true }) })
            },
            {
              messageId: 'wrapped-object',
              sender: recipientB,
              body: JSON.stringify({ message: { plain: 'object' } })
            }
          ]
        })
      )

      await expect(client.listMessagesLite({ messageBox: 'inbox' })).resolves.toEqual([
        expect.objectContaining({ messageId: 'wrapped', body: { plain: true } }),
        expect.objectContaining({ messageId: 'wrapped-object', body: { plain: 'object' } })
      ])
      await expect(client.listMessagesLite({ messageBox: ' ' })).rejects.toThrow(
        'MessageBox cannot be empty'
      )
    })
  })

  describe('permissions, notifications, and devices', () => {
    it('sets a permission and surfaces both HTTP and application failures', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ status: 'success' }))
        .mockResolvedValueOnce(
          jsonResponse(
            { description: 'forbidden' },
            { ok: false, status: 403, statusText: 'Forbidden' }
          )
        )
        .mockResolvedValueOnce(jsonResponse({ status: 'error', description: 'invalid fee' }))

      await expect(
        client.setMessageBoxPermission(
          { messageBox: 'notifications', sender: recipientA, recipientFee: 0 },
          'https://message-box.example/api'
        )
      ).resolves.toBeUndefined()
      await expect(
        client.setMessageBoxPermission(
          { messageBox: 'notifications', recipientFee: 0 },
          'https://message-box.example/api'
        )
      ).rejects.toThrow('forbidden')
      await expect(
        client.setMessageBoxPermission(
          { messageBox: 'notifications', recipientFee: 0 },
          'https://message-box.example/api'
        )
      ).rejects.toThrow('invalid fee')
    })

    it('surfaces get-permission and quote response failures', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({}, { ok: false, status: 500, statusText: 'Unavailable' })
        )
        .mockResolvedValueOnce(jsonResponse({ status: 'error', description: 'not available' }))
        .mockResolvedValueOnce(
          jsonResponse({}, { ok: false, status: 503, statusText: 'Unavailable' })
        )
        .mockResolvedValueOnce(jsonResponse({ status: 'error', description: 'bad quote' }))
        .mockResolvedValueOnce(
          jsonResponse(
            { status: 'success', quote: { recipientFee: 0, deliveryFee: 0 } },
            { headers: new Headers() }
          )
        )

      const permissionParams = {
        recipient: recipientA,
        messageBox: 'notifications'
      }
      await expect(
        client.getMessageBoxPermission(permissionParams, 'https://message-box.example/api')
      ).rejects.toThrow('HTTP 500')
      await expect(
        client.getMessageBoxPermission(permissionParams, 'https://message-box.example/api')
      ).rejects.toThrow('not available')

      const quoteParams = { recipient: recipientA, messageBox: 'notifications' }
      await expect(
        client.getMessageBoxQuote(quoteParams, 'https://message-box.example/api')
      ).rejects.toThrow('HTTP 503')
      await expect(
        client.getMessageBoxQuote(quoteParams, 'https://message-box.example/api')
      ).rejects.toThrow('bad quote')
      await expect(
        client.getMessageBoxQuote(quoteParams, 'https://message-box.example/api')
      ).rejects.toThrow('did not provide their identity key')
    })

    it('rejects malformed list-permission payloads and maps paid permissions', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            { description: 'permission listing denied' },
            { ok: false, status: 403, statusText: 'Forbidden' }
          )
        )
        .mockResolvedValueOnce(
          jsonResponse({ status: 'error', description: 'permission query failed' })
        )
        .mockResolvedValueOnce(jsonResponse({ status: 'success', permissions: {} }))
        .mockResolvedValueOnce(jsonResponse({ status: 'success', permissions: [null] }))
        .mockResolvedValueOnce(
          jsonResponse({
            status: 'success',
            permissions: [
              {
                sender: recipientA,
                messageBox: 'notifications',
                recipientFee: 2,
                createdAt: 'created',
                updatedAt: 'updated'
              }
            ]
          })
        )

      await expect(client.listMessageBoxPermissions()).rejects.toThrow('permission listing denied')
      await expect(client.listMessageBoxPermissions()).rejects.toThrow('permission query failed')
      await expect(client.listMessageBoxPermissions()).rejects.toThrow(
        'invalid permissions payload'
      )
      await expect(client.listMessageBoxPermissions()).rejects.toThrow('invalid permission record')
      await expect(client.listMessageBoxPermissions()).resolves.toEqual([
        expect.objectContaining({ recipientFee: 2, status: 'payment_required' })
      ])
    })

    it('forwards notification permission convenience methods', async () => {
      const set = jest.spyOn(client, 'setMessageBoxPermission').mockResolvedValue()
      const get = jest.spyOn(client, 'getMessageBoxPermission').mockResolvedValue(null)
      const list = jest.spyOn(client, 'listMessageBoxPermissions').mockResolvedValue([])
      jest.spyOn(client, 'getIdentityKey').mockResolvedValue(identityKey)

      await client.allowNotificationsFromPeer(recipientA, 2, 'https://override.example')
      await client.allowNotificationsFromPeer(recipientA)
      await client.denyNotificationsFromPeer(recipientB, 'https://override.example')
      await client.checkPeerNotificationStatus(recipientA, 'https://override.example')
      await client.listPeerNotifications('https://override.example')

      expect(set).toHaveBeenNthCalledWith(
        1,
        { messageBox: 'notifications', sender: recipientA, recipientFee: 2 },
        'https://override.example'
      )
      expect(set).toHaveBeenNthCalledWith(
        2,
        { messageBox: 'notifications', sender: recipientA, recipientFee: 0 },
        undefined
      )
      expect(set).toHaveBeenNthCalledWith(
        3,
        { messageBox: 'notifications', sender: recipientB, recipientFee: -1 },
        'https://override.example'
      )
      expect(get).toHaveBeenCalledWith(
        { recipient: identityKey, messageBox: 'notifications', sender: recipientA },
        'https://override.example'
      )
      expect(list).toHaveBeenCalledWith({ messageBox: 'notifications' }, 'https://override.example')
    })

    it('reports partial and failed encrypted notification batches', async () => {
      const send = jest
        .spyOn(client, 'sendMessage')
        .mockResolvedValueOnce({ status: 'success', messageId: 'one' })
        .mockRejectedValueOnce(new Error('blocked'))

      await expect(
        client.sendNotification([recipientA, recipientB], 'hello')
      ).resolves.toMatchObject({
        status: 'partial',
        sent: [{ recipient: recipientA, messageId: 'one' }],
        failed: [{ recipient: recipientB, error: 'blocked' }]
      })

      send.mockReset()
      send.mockRejectedValue('unknown failure')
      await expect(
        client.sendNotification([recipientA, recipientB], 'hello')
      ).resolves.toMatchObject({
        status: 'error',
        sent: [],
        failed: [
          { recipient: recipientA, error: 'Unknown error' },
          { recipient: recipientB, error: 'Unknown error' }
        ]
      })
    })

    it('forwards a single notification through the standard message sender', async () => {
      const send = jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'notification'
      })

      await client.sendNotification(recipientA, { title: 'Hello' }, 'https://override.example')
      expect(send).toHaveBeenCalledWith(
        {
          recipient: recipientA,
          messageBox: 'notifications',
          body: { title: 'Hello' },
          checkPermissions: true
        },
        'https://override.example'
      )
    })

    it('acknowledges notifications across every recipient-payment outcome', async () => {
      jest.spyOn(client, 'acknowledgeMessage').mockResolvedValue('success')
      const payment = {
        tx: [1, 2, 3],
        outputs: [
          {
            outputIndex: 0,
            protocol: 'wallet payment',
            paymentRemittance: {
              derivationPrefix: 'prefix',
              derivationSuffix: 'suffix',
              senderIdentityKey: identityKey
            }
          }
        ]
      }
      const message = (body: unknown) => ({
        messageId: 'message',
        sender: recipientA,
        body,
        created_at: '',
        updated_at: ''
      })

      await expect(client.acknowledgeNotification(message('plain'))).resolves.toBe(false)
      await expect(
        client.acknowledgeNotification(
          message(JSON.stringify({ message: 'hello', payment: { ...payment, outputs: [] } }))
        )
      ).resolves.toBe(false)
      await expect(
        client.acknowledgeNotification(message(JSON.stringify({ message: 'hello', payment })))
      ).resolves.toBe(true)

      wallet.internalizeAction.mockResolvedValueOnce({ accepted: false })
      await expect(
        client.acknowledgeNotification(message(JSON.stringify({ message: 'hello', payment })))
      ).resolves.toBe(false)

      wallet.internalizeAction.mockRejectedValueOnce(new Error('wallet unavailable'))
      await expect(
        client.acknowledgeNotification(message(JSON.stringify({ message: 'hello', payment })))
      ).resolves.toBe(false)
    })

    it.each([
      [{ fcmToken: '' }, 'fcmToken is required'],
      [{ fcmToken: 'x'.repeat(501) }, 'must not exceed 500'],
      [{ fcmToken: 'token', deviceId: 'x'.repeat(256) }, 'deviceId must not exceed 255'],
      [{ fcmToken: 'token', platform: 'desktop' }, 'platform must be one of']
    ])('rejects invalid device registration %#', async (params, error) => {
      await expect(client.registerDevice(params as never)).rejects.toThrow(error)
    })

    it('registers and lists bounded device pages', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse({ status: 'success', message: 'registered', deviceId: 'device-1' })
        )
        .mockResolvedValueOnce(
          jsonResponse({
            status: 'success',
            devices: [{ fcmToken: 'token', platform: 'web', deviceId: 'device-1' }]
          })
        )

      await expect(
        client.registerDevice(
          { fcmToken: ' token ', platform: 'web', deviceId: ' device-1 ' },
          'https://message-box.example/api'
        )
      ).resolves.toEqual({
        status: 'success',
        message: 'registered',
        deviceId: 'device-1'
      })
      await expect(
        client.listRegisteredDevices('https://message-box.example/api', {
          limit: 10,
          offset: 20
        })
      ).resolves.toHaveLength(1)

      expect(fetchMock.mock.calls[1][0]).toContain('/devices?limit=10&offset=20')
    })

    it('surfaces HTTP and application errors from device routes', async () => {
      fetchMock
        .mockResolvedValueOnce(
          jsonResponse(
            { description: 'registration denied' },
            { ok: false, status: 403, statusText: 'Forbidden' }
          )
        )
        .mockResolvedValueOnce(jsonResponse({ status: 'error', description: 'bad token' }))
        .mockResolvedValueOnce(
          jsonResponse(
            { description: 'listing denied' },
            { ok: false, status: 403, statusText: 'Forbidden' }
          )
        )
        .mockResolvedValueOnce(
          jsonResponse({ status: 'error', description: 'device query failed', devices: [] })
        )

      await expect(client.registerDevice({ fcmToken: 'token' })).rejects.toThrow(
        'registration denied'
      )
      await expect(client.registerDevice({ fcmToken: 'token' })).rejects.toThrow('bad token')
      await expect(client.listRegisteredDevices()).rejects.toThrow('listing denied')
      await expect(client.listRegisteredDevices()).rejects.toThrow('device query failed')
    })
  })

  describe('transport failure boundaries', () => {
    it('wraps invalid initialization hosts and exercises the testnet default', async () => {
      const testnetClient = new MessageBoxClient({
        networkPreset: 'testnet',
        walletClient: wallet
      })
      await expect(testnetClient.init('not a URL')).rejects.toThrow('Cannot initialize')
    })

    it('surfaces consumed, HTTP-error, and application-error send responses', async () => {
      fetchMock
        .mockResolvedValueOnce(jsonResponse({ status: 'success' }, { bodyUsed: true }))
        .mockResolvedValueOnce(
          jsonResponse({}, { ok: false, status: 503, statusText: 'Unavailable' })
        )
        .mockResolvedValueOnce(
          jsonResponse({ status: 'error', description: 'server rejected message' })
        )

      const send = () =>
        client.sendMessage(
          {
            recipient: recipientA,
            messageBox: 'inbox',
            body: 'hello',
            skipEncryption: true
          },
          'https://message-box.example/api'
        )

      await expect(send()).rejects.toThrow('Response body has already been used')
      await expect(send()).rejects.toThrow('HTTP 503')
      await expect(send()).rejects.toThrow('server rejected message')
    })

    it('wraps a non-Error permission lookup rejection', async () => {
      jest
        .spyOn(client, 'getMessageBoxQuote')
        .mockRejectedValueOnce('lookup failed')
        .mockRejectedValueOnce(new Error('lookup failed'))
      await expect(
        client.sendMessage(
          {
            recipient: recipientA,
            messageBox: 'inbox',
            body: 'hello',
            checkPermissions: true
          },
          'https://message-box.example/api'
        )
      ).rejects.toThrow('Permission check failed: Unknown error')
      await expect(
        client.sendMessage(
          {
            recipient: recipientA,
            messageBox: 'inbox',
            body: 'hello',
            checkPermissions: true
          },
          'https://message-box.example/api'
        )
      ).rejects.toThrow('Permission check failed: lookup failed')
    })

    it('handles successful and failed WebSocket acknowledgements', async () => {
      const listeners = new Map<string, (response?: unknown) => void>()
      const socket = {
        connected: true,
        on: jest.fn((event: string, handler: (response?: unknown) => void) => {
          listeners.set(event, handler)
        }),
        off: jest.fn(),
        emit: jest.fn(),
        disconnect: jest.fn()
      }
      ;(client as any).socket = socket
      ;(client as any).myIdentityKey = identityKey
      jest.spyOn(client, 'joinRoom').mockResolvedValue()
      const fallback = jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'fallback'
      })
      const waitForAckHandler = async (
        previous?: (response?: unknown) => void
      ): Promise<(response?: unknown) => void> => {
        for (let attempt = 0; attempt < 20; attempt++) {
          const handler = listeners.get(`sendMessageAck-${recipientA}-inbox`)
          if (handler != null && handler !== previous) return handler
          await new Promise(resolve => setImmediate(resolve))
        }
        throw new Error('WebSocket acknowledgement handler was not registered')
      }

      const successfulSend = client.sendLiveMessage(
        {
          recipient: recipientA,
          messageBox: 'inbox',
          body: { hello: 'world' }
        },
        'https://override.example'
      )
      const successfulAck = await waitForAckHandler()
      successfulAck({
        status: 'success',
        messageId: 'live'
      })
      await expect(successfulSend).resolves.toMatchObject({ status: 'success', messageId: 'live' })

      const fallbackSend = client.sendLiveMessage({
        recipient: recipientA,
        messageBox: 'inbox',
        body: 'hello',
        skipEncryption: true
      })
      const failedAck = await waitForAckHandler(successfulAck)
      failedAck({ status: 'error' })
      await expect(fallbackSend).resolves.toMatchObject({ messageId: 'fallback' })
      expect(fallback).toHaveBeenCalled()
    })

    it('rejects live delivery when HMAC generation fails', async () => {
      ;(client as any).socket = {
        connected: true,
        on: jest.fn(),
        off: jest.fn(),
        emit: jest.fn(),
        disconnect: jest.fn()
      }
      jest.spyOn(client, 'joinRoom').mockResolvedValue()
      wallet.createHmac.mockRejectedValueOnce(new Error('wallet failed'))

      await expect(
        client.sendLiveMessage({
          recipient: recipientA,
          messageBox: 'inbox',
          body: 'hello'
        })
      ).rejects.toThrow('Failed to generate message identifier')
    })

    it('decrypts live messages and protects callbacks from unstringifiable payloads', async () => {
      const listeners = new Map<string, (message: any) => void>()
      ;(client as any).socket = {
        connected: true,
        on: jest.fn((event: string, handler: (message: any) => void) => {
          listeners.set(event, handler)
        }),
        off: jest.fn(),
        emit: jest.fn(),
        disconnect: jest.fn()
      }
      ;(client as any).myIdentityKey = identityKey
      jest.spyOn(client, 'joinRoom').mockResolvedValue()
      const onMessage = jest.fn()
      await client.listenForLiveMessages({ messageBox: 'inbox', onMessage })

      const listener = listeners.get(`sendMessage-${identityKey}-inbox`)
      listener?.({
        messageId: 'encrypted',
        sender: recipientA,
        body: JSON.stringify({ encryptedMessage: 'AQID' })
      })
      const circular: Record<string, unknown> = {}
      circular.self = circular
      listener?.({
        messageId: 'circular',
        sender: recipientA,
        body: circular
      })
      listener?.({
        messageId: 'plain',
        sender: recipientA,
        body: 'plain text'
      })
      await new Promise(resolve => setImmediate(resolve))

      expect(onMessage).toHaveBeenCalledTimes(3)
      const delivered = onMessage.mock.calls.map(([message]) => message)
      expect(delivered.find(message => message.messageId === 'encrypted')?.body).toBe(
        '{"secret":true}'
      )
      expect(delivered.find(message => message.messageId === 'circular')?.body).toBe(
        '[Error: Unstringifiable message]'
      )
      expect(delivered.find(message => message.messageId === 'plain')?.body).toBe('plain text')
    })
  })
})
