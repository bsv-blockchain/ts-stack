/* eslint-env jest */
import { PeerTokenClient, STANDARD_TOKEN_MESSAGEBOX } from '../PeerTokenClient.js'
import { TokenSettlementAdapter } from '../TokenSettlementAdapter.js'
import { PrivateKey, type WalletInterface } from '@bsv/sdk'
import { jest } from '@jest/globals'

const createMockWalletClient = (): jest.Mocked<WalletInterface> =>
  ({
    getPublicKey: jest.fn(),
    createAction: jest.fn(),
    internalizeAction: jest.fn(),
    createHmac: jest
      .fn<() => Promise<{ hmac: number[] }>>()
      .mockResolvedValue({ hmac: Array<number>(32).fill(1) }),
    verifyHmac: jest
      .fn<() => Promise<{ valid: true }>>()
      .mockResolvedValue({ valid: true as const })
  }) as unknown as jest.Mocked<WalletInterface>

const ARTIFACT = {
  customInstructions: { derivationPrefix: 'cHJl', derivationSuffix: 'c3Vm' },
  transaction: [1, 2, 3],
  protocol: 'stas',
  assetId: 'TEST',
  amount: '1000',
  outputIndex: 0
}

const makeStubAdapter = (): TokenSettlementAdapter => ({
  protocol: 'stas',
  buildTokenSettlement: jest
    .fn<TokenSettlementAdapter['buildTokenSettlement']>()
    .mockResolvedValue({ action: 'settle', artifact: ARTIFACT }),
  acceptTokenSettlement: jest
    .fn<TokenSettlementAdapter['acceptTokenSettlement']>()
    .mockResolvedValue({ action: 'accept', receiptData: { internalizeResult: 'ok' } })
})

const SOURCE = {
  txid: 'aa'.repeat(32),
  outputIndex: 0,
  lockingScriptHex: '76a914' + 'ab'.repeat(20) + '88ac69ac',
  satoshis: 1000,
  protocol: 'stas',
  assetId: 'TEST',
  brc42KeyId: 'recv 1'
}

describe('PeerTokenClient Unit Tests', () => {
  let client: PeerTokenClient
  let adapter: TokenSettlementAdapter
  let recipient: string
  let wallet: jest.Mocked<WalletInterface>

  beforeEach(() => {
    jest.clearAllMocks()
    adapter = makeStubAdapter()
    recipient = PrivateKey.fromRandom().toPublicKey().toString()
    wallet = createMockWalletClient()
    client = new PeerTokenClient({ walletClient: wallet, adapters: [adapter] })
  })

  const bindIncomingToken = <T>(incoming: T): T => {
    jest.spyOn(client, 'listIncomingTokens').mockResolvedValue([incoming] as any)
    return incoming
  }

  describe('createTokenToken', () => {
    it('delegates to the adapter and returns the artifact fields', async () => {
      const token = await client.createTokenToken({
        recipient,
        protocol: 'stas',
        source: SOURCE,
        amount: '1000'
      })
      expect(token).toMatchObject({
        protocol: 'stas',
        assetId: 'TEST',
        amount: '1000',
        outputIndex: 0
      })
      expect(token.transaction).toEqual([1, 2, 3])
      expect(adapter.buildTokenSettlement).toHaveBeenCalledTimes(1)
    })

    it('throws when no adapter is registered for the protocol', async () => {
      await expect(
        client.createTokenToken({
          recipient,
          protocol: 'dstas',
          source: { ...SOURCE, protocol: 'dstas' },
          amount: '1'
        })
      ).rejects.toThrow(/No token settlement adapter/)
    })

    it('throws when the adapter terminates', async () => {
      ;(adapter.buildTokenSettlement as jest.Mock).mockResolvedValue({
        action: 'terminate',
        termination: { code: 'stas.frozen', message: 'frozen UTXO' }
      } as never)
      await expect(
        client.createTokenToken({ recipient, protocol: 'stas', source: SOURCE, amount: '1000' })
      ).rejects.toThrow(/frozen UTXO/)
    })

    it('surfaces the broadcast txid from the artifact', async () => {
      ;(adapter.buildTokenSettlement as jest.Mock).mockResolvedValue({
        action: 'settle',
        artifact: { ...ARTIFACT, txid: 'cd'.repeat(32) }
      } as never)
      const token = await client.createTokenToken({
        recipient,
        protocol: 'stas',
        source: SOURCE,
        amount: '1000'
      })
      expect(token.txid).toBe('cd'.repeat(32))
    })

    it('passes dryRun through to the adapter context', async () => {
      await client.createTokenToken(
        { recipient, protocol: 'stas', source: SOURCE, amount: '1000' },
        true
      )
      const ctx = (adapter.buildTokenSettlement as jest.Mock).mock.calls[0][1] as {
        dryRun?: boolean
      }
      expect(ctx.dryRun).toBe(true)
    })

    it('normalizes a current-wallet Uint8Array artifact for transport', async () => {
      ;(adapter.buildTokenSettlement as jest.Mock).mockResolvedValue({
        action: 'settle',
        artifact: { ...ARTIFACT, transaction: new Uint8Array([4, 5, 6]) }
      } as never)

      const token = await client.createTokenToken({
        recipient,
        protocol: 'stas',
        source: SOURCE,
        amount: '1000'
      })

      expect(token.transaction).toEqual([4, 5, 6])
    })

    it('requires an exact settlement action from the adapter', async () => {
      ;(adapter.buildTokenSettlement as jest.Mock).mockResolvedValue({
        action: 'success',
        artifact: ARTIFACT
      })

      await expect(
        client.createTokenToken({ recipient, protocol: 'stas', source: SOURCE, amount: '1000' })
      ).rejects.toThrow('did not produce a settlement')
    })

    it('rejects an adapter artifact that changes requested token authority', async () => {
      ;(adapter.buildTokenSettlement as jest.Mock).mockResolvedValue({
        action: 'settle',
        artifact: { ...ARTIFACT, assetId: 'SUBSTITUTED' }
      })

      await expect(
        client.createTokenToken({ recipient, protocol: 'stas', source: SOURCE, amount: '1000' })
      ).rejects.toThrow('changed the requested token authority')
    })
  })

  describe('sendToken', () => {
    it('sends the serialized token to the token message box', async () => {
      const sendSpy = jest.spyOn(client, 'sendMessage' as any).mockResolvedValue(undefined as never)
      await client.sendToken({ recipient, protocol: 'stas', source: SOURCE, amount: '1000' })
      expect(sendSpy).toHaveBeenCalledTimes(1)
      const arg = (sendSpy.mock.calls[0] as any)[0]
      expect(arg.messageBox).toBe(STANDARD_TOKEN_MESSAGEBOX)
      expect(arg.recipient).toBe(recipient)
      expect(JSON.parse(arg.body)).toMatchObject({
        protocol: 'stas',
        assetId: 'TEST',
        amount: '1000'
      })
    })

    it('returns the sent token', async () => {
      jest.spyOn(client, 'sendMessage' as any).mockResolvedValue(undefined as never)
      const token = await client.sendToken({
        recipient,
        protocol: 'stas',
        source: SOURCE,
        amount: '1000'
      })
      expect(token).toMatchObject({ protocol: 'stas', assetId: 'TEST', amount: '1000' })
    })

    it('throws on a missing recipient', async () => {
      await expect(
        client.sendToken({ recipient: '  ', protocol: 'stas', source: SOURCE, amount: '1000' })
      ).rejects.toThrow(/identity key is invalid/)
    })
  })

  describe('acceptToken', () => {
    it('delegates to the adapter and acknowledges the message', async () => {
      const ackSpy = jest
        .spyOn(client, 'acknowledgeMessage' as any)
        .mockResolvedValue(undefined as never)
      const incoming = bindIncomingToken({
        messageId: 'msg-1',
        sender: PrivateKey.fromRandom().toPublicKey().toString(),
        token: { ...ARTIFACT }
      })
      const result = await client.acceptToken(incoming)
      expect(adapter.acceptTokenSettlement).toHaveBeenCalledTimes(1)
      expect(ackSpy).toHaveBeenCalledWith(expect.objectContaining({ messageIds: ['msg-1'] }))
      expect(result).toMatchObject({ receiptData: { internalizeResult: 'ok' } })
    })

    it('recovers a historical numeric-key transaction before adapter dispatch', async () => {
      const ackSpy = jest
        .spyOn(client, 'acknowledgeMessage' as any)
        .mockResolvedValue(undefined as never)
      const transaction = JSON.parse(JSON.stringify(new Uint8Array([7, 8, 9])))

      await client.acceptToken(
        bindIncomingToken({
          messageId: 'msg-json-bytes',
          sender: recipient,
          token: { ...ARTIFACT, transaction }
        })
      )

      expect(adapter.acceptTokenSettlement).toHaveBeenCalledWith(
        expect.objectContaining({
          settlement: expect.objectContaining({ transaction: [7, 8, 9] })
        }),
        expect.any(Object)
      )
      expect(ackSpy).toHaveBeenCalled()
    })

    it('does not dispatch or acknowledge malformed transaction records', async () => {
      const ackSpy = jest.spyOn(client, 'acknowledgeMessage' as any)

      await expect(
        client.acceptToken(
          bindIncomingToken({
            messageId: 'msg-bad-bytes',
            sender: recipient,
            token: { ...ARTIFACT, transaction: { 1: 2 } as never }
          })
        )
      ).rejects.toThrow('Token settlement transaction is invalid')

      expect(adapter.acceptTokenSettlement).not.toHaveBeenCalled()
      expect(ackSpy).not.toHaveBeenCalled()
    })

    it('rebinds to fresh inbox metadata and contains post-custody acknowledgement failure', async () => {
      const fresh = bindIncomingToken({
        messageId: 'fresh-token',
        sender: recipient,
        token: { ...ARTIFACT }
      })
      jest.spyOn(client, 'acknowledgeMessage' as any).mockRejectedValue(new Error('offline'))

      await expect(
        client.acceptToken({
          ...fresh,
          sender: PrivateKey.fromRandom().toPublicKey().toString(),
          token: { ...fresh.token, assetId: 'SUBSTITUTED', amount: '9999' }
        })
      ).resolves.toEqual(expect.objectContaining({ incoming: fresh }))
      expect(adapter.acceptTokenSettlement).toHaveBeenCalledWith(
        expect.objectContaining({
          sender: recipient,
          settlement: expect.objectContaining({ assetId: 'TEST', amount: '1000' })
        }),
        expect.any(Object)
      )
    })

    it('requires an exact adapter acceptance verdict before acknowledging', async () => {
      const incoming = bindIncomingToken({
        messageId: 'invalid-verdict',
        sender: recipient,
        token: { ...ARTIFACT }
      })
      ;(adapter.acceptTokenSettlement as jest.Mock).mockResolvedValue({ action: 'accepted' })
      const ackSpy = jest.spyOn(client, 'acknowledgeMessage' as any)

      await expect(client.acceptToken(incoming)).rejects.toThrow('did not accept')
      expect(ackSpy).not.toHaveBeenCalled()
    })

    it('refuses absent and duplicate inbox matches before adapter mutation', async () => {
      const incoming = {
        messageId: 'ambiguous-token',
        sender: recipient,
        token: { ...ARTIFACT }
      }
      const list = jest.spyOn(client, 'listIncomingTokens').mockResolvedValue([])
      await expect(client.acceptToken(incoming)).rejects.toThrow('not present exactly once')
      list.mockResolvedValue([incoming, incoming])
      await expect(client.acceptToken(incoming)).rejects.toThrow('not present exactly once')
      expect(adapter.acceptTokenSettlement).not.toHaveBeenCalled()
    })
  })

  describe('listIncomingTokens', () => {
    it('reads via listMessagesLite (mainnet bypass) with the configured host', async () => {
      const liteSpy = jest.spyOn(client, 'listMessagesLite' as any).mockResolvedValue([] as never)
      await client.listIncomingTokens()
      expect(liteSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          messageBox: STANDARD_TOKEN_MESSAGEBOX,
          host: 'https://message-box-us-1.bsvb.tech',
          limit: 1000,
          pageSize: 100,
          maxPages: 10
        })
      )
    })
  })

  describe('request proof validation', () => {
    it.each(['', '0', 'zz', '123x'])(
      'rejects malformed hexadecimal proofs without calling the wallet (%s)',
      async requestProof => {
        const wallet = createMockWalletClient()
        wallet.getPublicKey.mockResolvedValue({ publicKey: recipient })
        const proofClient = new PeerTokenClient({ walletClient: wallet, adapters: [adapter] })

        await expect(
          proofClient.verifyTokenRequestProof({
            requestId: 'request-1',
            sender: recipient,
            requestProof
          })
        ).resolves.toBe(false)
        expect(wallet.verifyHmac).not.toHaveBeenCalled()
      }
    )

    it('decodes a valid hexadecimal proof and verifies it with the wallet', async () => {
      wallet.getPublicKey.mockResolvedValue({ publicKey: recipient })

      await expect(
        client.verifyTokenRequestProof({
          requestId: 'request-1',
          sender: recipient,
          requestProof: '01'.repeat(32)
        })
      ).resolves.toBe(true)

      expect(wallet.verifyHmac).toHaveBeenCalledWith(
        expect.objectContaining({ hmac: Array<number>(32).fill(1), counterparty: recipient }),
        undefined
      )
    })

    it('rejects a wallet false verdict that does not throw', async () => {
      wallet.getPublicKey.mockResolvedValue({ publicKey: recipient })
      wallet.verifyHmac.mockResolvedValueOnce({ valid: false } as never)

      await expect(
        client.verifyTokenRequestProof({
          requestId: 'request-1',
          sender: recipient,
          requestProof: '0102ff'
        })
      ).resolves.toBe(false)
    })
  })

  describe('live token transport', () => {
    it('sends a token through the live transport using an explicit host', async () => {
      const live = jest.spyOn(client, 'sendLiveMessage').mockResolvedValue({
        status: 'success',
        messageId: 'live-1'
      })

      await expect(
        client.sendLiveToken(
          { recipient, protocol: 'stas', source: SOURCE, amount: '1000' },
          'https://override.example'
        )
      ).resolves.toMatchObject({ protocol: 'stas', amount: '1000' })

      expect(live).toHaveBeenCalledWith(
        expect.objectContaining({ recipient, messageBox: STANDARD_TOKEN_MESSAGEBOX }),
        'https://override.example'
      )
    })

    it('falls back to HTTP when live delivery fails', async () => {
      jest.spyOn(client, 'sendLiveMessage').mockRejectedValue(new Error('socket unavailable'))
      const send = jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'http-1'
      })

      await client.sendLiveToken({ recipient, protocol: 'stas', source: SOURCE, amount: '1000' })

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ recipient, messageBox: STANDARD_TOKEN_MESSAGEBOX }),
        'https://message-box-us-1.bsvb.tech'
      )
    })

    it('parses valid live tokens and ignores malformed payloads', async () => {
      const listen = jest.spyOn(client, 'listenForLiveMessages').mockResolvedValue()
      const onToken = jest.fn()
      await client.listenForLiveTokens({ onToken, overrideHost: 'https://override.example' })

      const { onMessage } = listen.mock.calls[0][0]
      onMessage({
        messageId: 'bad',
        sender: recipient,
        body: '{',
        created_at: '',
        updated_at: ''
      })
      onMessage({
        messageId: 'good',
        sender: recipient,
        body: JSON.stringify(ARTIFACT),
        created_at: '',
        updated_at: ''
      })

      expect(onToken).toHaveBeenCalledTimes(1)
      expect(onToken).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'good', sender: recipient })
      )
    })
  })

  describe('token request lifecycle', () => {
    let request: {
      messageId: string
      sender: string
      requestId: string
      protocol: string
      assetId: string
      amount: string
      description: string
      expiresAt: number
      requestProof: string
    }

    beforeEach(() => {
      request = {
        messageId: 'request-message',
        sender: recipient,
        requestId: 'request-1',
        protocol: 'stas',
        assetId: 'TEST',
        amount: '1000',
        description: 'Send token',
        expiresAt: Date.now() + 60_000,
        requestProof: '01'.repeat(32)
      }
    })

    it('parses valid incoming tokens and filters malformed tokens', async () => {
      jest.spyOn(client, 'listMessagesLite').mockResolvedValue([
        {
          messageId: 'valid',
          sender: recipient,
          body: JSON.stringify(ARTIFACT),
          created_at: '',
          updated_at: ''
        },
        {
          messageId: 'invalid',
          sender: recipient,
          body: '{',
          created_at: '',
          updated_at: ''
        }
      ])

      await expect(client.listIncomingTokens('https://override.example')).resolves.toEqual([
        expect.objectContaining({ messageId: 'valid', sender: recipient })
      ])
    })

    it('drops a token whose body sender conflicts with the authenticated envelope', async () => {
      jest.spyOn(client, 'listMessagesLite').mockResolvedValue([
        {
          messageId: 'spoofed',
          sender: recipient,
          body: {
            ...ARTIFACT,
            sender: PrivateKey.fromRandom().toPublicKey().toString()
          },
          created_at: '',
          updated_at: ''
        }
      ])

      await expect(client.listIncomingTokens()).resolves.toEqual([])
    })

    it('creates and sends an authenticated token request', async () => {
      jest.spyOn(client, 'getIdentityKey').mockResolvedValue(recipient)
      const send = jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'request-message'
      })

      const result = await client.requestToken(
        {
          recipient,
          protocol: 'stas',
          assetId: 'TEST',
          amount: '1000',
          description: 'Send token',
          expiresAt: Date.now() + 60_000
        },
        'https://override.example'
      )

      expect(result.requestProof).toBe('01'.repeat(32))
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          recipient,
          messageBox: 'token_requests',
          body: expect.stringContaining(`"requestProof":"${'01'.repeat(32)}"`)
        }),
        'https://override.example'
      )
    })

    it('uses the configured token host when a request has no override', async () => {
      jest.spyOn(client, 'getIdentityKey').mockResolvedValue(recipient)
      const send = jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'request-message'
      })

      await client.requestToken({
        recipient,
        protocol: 'stas',
        assetId: 'TEST',
        amount: '1000',
        description: 'Send token',
        expiresAt: Date.now() + 60_000
      })

      expect(send).toHaveBeenCalledWith(expect.any(Object), 'https://message-box-us-1.bsvb.tech')
    })

    it('converts valid live requests while ignoring cancelled and malformed payloads', async () => {
      const listen = jest.spyOn(client, 'listenForLiveMessages').mockResolvedValue()
      const onRequest = jest.fn()
      jest.spyOn(client, 'getIdentityKey').mockResolvedValue(recipient)
      await client.listenForLiveTokenRequests({ onRequest })

      const { onMessage } = listen.mock.calls[0][0]
      const baseMessage = {
        sender: request.sender,
        created_at: '',
        updated_at: ''
      }
      await onMessage({ ...baseMessage, messageId: 'bad', body: '{' })
      await onMessage({
        ...baseMessage,
        messageId: 'cancelled',
        body: JSON.stringify({ requestId: request.requestId, cancelled: true })
      })
      await onMessage({
        ...baseMessage,
        messageId: request.messageId,
        body: JSON.stringify({ ...request, senderIdentityKey: request.sender })
      })

      expect(onRequest).toHaveBeenCalledTimes(1)
      expect(onRequest).toHaveBeenCalledWith(expect.objectContaining(request))
    })

    it('requires a valid request proof before exposing a live request', async () => {
      const listen = jest.spyOn(client, 'listenForLiveMessages').mockResolvedValue()
      const onRequest = jest.fn()
      jest.spyOn(client, 'getIdentityKey').mockResolvedValue(recipient)
      wallet.verifyHmac.mockResolvedValue({ valid: false } as never)
      await client.listenForLiveTokenRequests({ onRequest })

      await listen.mock.calls[0][0].onMessage({
        messageId: request.messageId,
        sender: request.sender,
        body: { ...request, senderIdentityKey: request.sender },
        created_at: '',
        updated_at: ''
      })

      expect(onRequest).not.toHaveBeenCalled()
    })

    it('lists only bounded, authenticated, unexpired token requests', async () => {
      jest.spyOn(client, 'getIdentityKey').mockResolvedValue(recipient)
      const list = jest.spyOn(client, 'listMessagesLite').mockResolvedValue([
        {
          messageId: request.messageId,
          sender: request.sender,
          body: { ...request, senderIdentityKey: request.sender },
          created_at: '',
          updated_at: ''
        }
      ])

      await expect(client.listIncomingTokenRequests()).resolves.toEqual([
        expect.objectContaining(request)
      ])
      expect(list).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 1000, pageSize: 100, maxPages: 10 })
      )
    })

    it('fulfills a request, responds, and acknowledges the request message', async () => {
      const sendToken = jest.spyOn(client, 'sendToken').mockResolvedValue(ARTIFACT)
      const sendMessage = jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'response-message'
      })
      const acknowledge = jest.spyOn(client, 'acknowledgeMessage').mockResolvedValue('ok')
      jest.spyOn(client, 'listIncomingTokenRequests').mockResolvedValue([request])

      await client.fulfillTokenRequest(
        { request, source: SOURCE, note: 'settled' },
        'https://override.example'
      )

      expect(sendToken).toHaveBeenCalledWith(
        {
          recipient: request.sender,
          protocol: request.protocol,
          source: SOURCE,
          amount: request.amount
        },
        'https://override.example'
      )
      expect(JSON.parse(String(sendMessage.mock.calls[0][0].body))).toMatchObject({
        requestId: request.requestId,
        status: 'sent',
        note: 'settled'
      })
      expect(acknowledge).toHaveBeenCalledWith({
        messageIds: [request.messageId],
        host: 'https://override.example'
      })
    })

    it('uses the configured token host throughout fulfillment without an override', async () => {
      const sendToken = jest.spyOn(client, 'sendToken').mockResolvedValue(ARTIFACT)
      const sendMessage = jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'response-message'
      })
      const acknowledge = jest.spyOn(client, 'acknowledgeMessage').mockResolvedValue('ok')
      jest.spyOn(client, 'listIncomingTokenRequests').mockResolvedValue([request])

      await client.fulfillTokenRequest({ request, source: SOURCE })

      expect(sendToken).toHaveBeenCalledWith(
        expect.any(Object),
        'https://message-box-us-1.bsvb.tech'
      )
      expect(sendMessage).toHaveBeenCalledWith(
        expect.any(Object),
        'https://message-box-us-1.bsvb.tech'
      )
      expect(acknowledge).toHaveBeenCalledWith({
        messageIds: [request.messageId],
        host: 'https://message-box-us-1.bsvb.tech'
      })
    })

    it('uses fresh authenticated request fields instead of caller substitutions', async () => {
      const sendToken = jest.spyOn(client, 'sendToken').mockResolvedValue(ARTIFACT)
      jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'response-message'
      })
      jest.spyOn(client, 'acknowledgeMessage').mockResolvedValue('ok')
      jest.spyOn(client, 'listIncomingTokenRequests').mockResolvedValue([request])

      await client.fulfillTokenRequest({
        request: {
          ...request,
          sender: PrivateKey.fromRandom().toPublicKey().toString(),
          amount: '9999',
          assetId: 'SUBSTITUTED'
        },
        source: SOURCE
      })

      expect(sendToken).toHaveBeenCalledWith(
        expect.objectContaining({ recipient: request.sender, amount: '1000' }),
        'https://message-box-us-1.bsvb.tech'
      )
    })

    it('rejects concurrent processing of the same token request by one client', async () => {
      jest.spyOn(client, 'listIncomingTokenRequests').mockResolvedValue([request])
      let releaseToken!: () => void
      const tokenPending = new Promise<typeof ARTIFACT>(resolve => {
        releaseToken = () => resolve(ARTIFACT)
      })
      const sendToken = jest
        .spyOn(client, 'sendToken')
        .mockImplementation(async () => await tokenPending)
      jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'response-message'
      })
      jest.spyOn(client, 'acknowledgeMessage').mockResolvedValue('ok')

      const first = client.fulfillTokenRequest({ request, source: SOURCE })
      while (sendToken.mock.calls.length === 0) await Promise.resolve()
      await expect(client.fulfillTokenRequest({ request, source: SOURCE })).rejects.toThrow(
        'already being processed'
      )
      releaseToken()
      await first
      expect(sendToken).toHaveBeenCalledTimes(1)
    })

    it('does not misreport completed token fulfillment when acknowledgement fails', async () => {
      jest.spyOn(client, 'listIncomingTokenRequests').mockResolvedValue([request])
      jest.spyOn(client, 'sendToken').mockResolvedValue(ARTIFACT)
      jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'response-message'
      })
      jest.spyOn(client, 'acknowledgeMessage').mockRejectedValue(new Error('offline'))

      await expect(client.fulfillTokenRequest({ request, source: SOURCE })).resolves.toBe(undefined)
    })

    it('refuses a source for a different asset than the authenticated request', async () => {
      jest.spyOn(client, 'listIncomingTokenRequests').mockResolvedValue([request])
      const sendToken = jest.spyOn(client, 'sendToken')

      await expect(
        client.fulfillTokenRequest({
          request,
          source: { ...SOURCE, assetId: 'DIFFERENT' }
        })
      ).rejects.toThrow('does not satisfy the authenticated request')
      expect(sendToken).not.toHaveBeenCalled()
    })

    it('declines and acknowledges a request', async () => {
      const send = jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'response-message'
      })
      const acknowledge = jest.spyOn(client, 'acknowledgeMessage').mockResolvedValue('ok')
      jest.spyOn(client, 'listIncomingTokenRequests').mockResolvedValue([request])

      await client.declineTokenRequest({ request, note: 'not available' })

      expect(JSON.parse(String(send.mock.calls[0][0].body))).toEqual({
        requestId: request.requestId,
        status: 'declined',
        note: 'not available'
      })
      expect(acknowledge).toHaveBeenCalledWith({
        messageIds: [request.messageId],
        host: 'https://message-box-us-1.bsvb.tech'
      })
    })

    it('sends a cancellation bound to the current identity key', async () => {
      jest.spyOn(client, 'getIdentityKey').mockResolvedValue(recipient)
      const send = jest.spyOn(client, 'sendMessage').mockResolvedValue({
        status: 'success',
        messageId: 'cancel-message'
      })

      await client.cancelTokenRequest({
        recipient,
        requestId: request.requestId,
        requestProof: '01'.repeat(32)
      })

      expect(JSON.parse(String(send.mock.calls[0][0].body))).toEqual({
        requestId: request.requestId,
        senderIdentityKey: recipient,
        requestProof: '01'.repeat(32),
        cancelled: true
      })
    })

    it('lists valid request responses and drops malformed ones', async () => {
      jest.spyOn(client, 'listMessagesLite').mockResolvedValue([
        {
          messageId: 'valid',
          sender: recipient,
          body: { requestId: request.requestId, status: 'declined' },
          created_at: '',
          updated_at: ''
        },
        {
          messageId: 'invalid',
          sender: recipient,
          body: '{',
          created_at: '',
          updated_at: ''
        }
      ])

      await expect(client.listTokenRequestResponses()).resolves.toEqual([
        { requestId: request.requestId, status: 'declined' }
      ])
    })
  })
})
