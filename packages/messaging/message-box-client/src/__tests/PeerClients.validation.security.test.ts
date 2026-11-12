import { PrivateKey, PublicKey, P2PKH, Transaction, type WalletInterface } from '@bsv/sdk'
import { jest } from '@jest/globals'
import { PeerPayClient } from '../PeerPayClient.js'
import { PeerTokenClient } from '../PeerTokenClient.js'
import type { TokenSettlementAdapter, TokenSourceRef } from '../TokenSettlementAdapter.js'
import type { PeerMessage } from '../types.js'

const identityA = PrivateKey.fromRandom().toPublicKey().toString()
const identityB = PrivateKey.fromRandom().toPublicKey().toString()
const invalidCurveIdentity = `02${'00'.repeat(32)}`
const requestProof = '01'.repeat(32)

function wallet(): jest.Mocked<WalletInterface> {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: identityA }),
    createHmac: jest.fn().mockResolvedValue({ hmac: Array<number>(32).fill(1) }),
    verifyHmac: jest.fn().mockResolvedValue({ valid: true })
  } as unknown as jest.Mocked<WalletInterface>
}

function message(body: PeerMessage['body'], overrides: Partial<PeerMessage> = {}): PeerMessage {
  return {
    messageId: 'message-1',
    sender: identityA,
    body,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides
  }
}

const paymentToken = {
  customInstructions: { derivationPrefix: 'cHJl', derivationSuffix: 'c3Vm' },
  transaction: [1, 2, 3],
  amount: 1,
  outputIndex: 0
}

const tokenArtifact = {
  customInstructions: { derivationPrefix: 'cHJl', derivationSuffix: 'c3Vm' },
  transaction: [1, 2, 3],
  protocol: 'stas',
  assetId: 'asset-1',
  amount: '1',
  outputIndex: 0
}

const tokenSource: TokenSourceRef = {
  txid: 'ab'.repeat(32),
  outputIndex: 0,
  lockingScriptHex: '51',
  satoshis: 1,
  protocol: 'stas',
  assetId: 'asset-1'
}

function adapter(): jest.Mocked<TokenSettlementAdapter> {
  return {
    protocol: 'stas',
    buildTokenSettlement: jest.fn().mockResolvedValue({
      action: 'settle',
      artifact: tokenArtifact
    }),
    acceptTokenSettlement: jest.fn().mockResolvedValue({ action: 'accept' })
  } as jest.Mocked<TokenSettlementAdapter>
}

describe('peer payment boundary validation', () => {
  let client: PeerPayClient
  let mockWallet: jest.Mocked<WalletInterface>

  beforeEach(() => {
    mockWallet = wallet()
    client = new PeerPayClient({
      messageBoxHost: 'https://message-box.example',
      walletClient: mockWallet
    })
  })

  afterEach(() => jest.restoreAllMocks())

  it.each([
    [null, 'Invalid payment details'],
    [{ recipient: identityA, amount: 1.5 }, 'valid amount'],
    [{ recipient: invalidCurveIdentity, amount: 1 }, 'sender is invalid']
  ])('rejects hostile payment parameters before wallet work %#', async (params, expected) => {
    await expect(client.createPaymentToken(params as never)).rejects.toThrow(expected)
    expect(mockWallet.getPublicKey).not.toHaveBeenCalled()
  })

  it('drops hostile payment envelopes without reading accessors or accepting spoofed authority', async () => {
    const accessor = Object.defineProperty({}, 'customInstructions', {
      enumerable: true,
      get: jest.fn(() => paymentToken.customInstructions)
    })
    const hostileMessages = [
      null,
      message(new Date() as never),
      message(accessor),
      message(paymentToken, { messageId: 'bad\nidentifier' }),
      message(paymentToken, { sender: invalidCurveIdentity }),
      message({ ...paymentToken, customInstructions: null }),
      message({ ...paymentToken, transaction: [] }),
      message({ ...paymentToken, outputIndex: -1 })
    ]
    jest.spyOn(client, 'listMessages').mockResolvedValue(hostileMessages as never)

    await expect(client.listIncomingPayments()).resolves.toEqual([])
    expect(
      Object.getOwnPropertyDescriptor(accessor, 'customInstructions')?.get
    ).not.toHaveBeenCalled()
  })

  it('does not synthesize omitted payment authority from Object.prototype', async () => {
    Object.defineProperty(Object.prototype, 'amount', {
      configurable: true,
      value: 1
    })
    try {
      const { amount: _omitted, ...tokenWithoutAmount } = paymentToken
      jest.spyOn(client, 'listMessages').mockResolvedValue([message(tokenWithoutAmount)])

      await expect(client.listIncomingPayments()).resolves.toEqual([])
    } finally {
      delete (Object.prototype as Record<string, unknown>).amount
    }
  })

  it('binds an indexed payment lookup to both the requested ID and a valid token', async () => {
    jest
      .spyOn(client, 'listMessagesLite')
      .mockResolvedValue([
        message(paymentToken, { messageId: 'other' }),
        message({ ...paymentToken, transaction: [] }, { messageId: 'wanted' }),
        message(paymentToken, { messageId: 'wanted' })
      ])

    await expect(client.findIncomingPaymentsByMessageId('wanted')).resolves.toEqual([
      expect.objectContaining({ messageId: 'wanted', sender: identityA })
    ])
    expect(client.listMessagesLite).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'wanted', limit: 2, pageSize: 2, maxPages: 1 })
    )
  })

  it('does not surface malformed live payments and preserves a canonical payment', async () => {
    const listen = jest.spyOn(client, 'listenForLiveMessages').mockResolvedValue()
    const onPayment = jest.fn()
    await client.listenForLivePayments({ onPayment })
    const onMessage = listen.mock.calls[0][0].onMessage

    onMessage(message('{'))
    onMessage(message(paymentToken, { messageId: 'live-payment' }))

    expect(onPayment).toHaveBeenCalledTimes(1)
    expect(onPayment).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'live-payment', sender: identityA })
    )
  })

  it.each(['AQID', [1, 2, 3], { 0: 1, 1: 2, 2: 3 }])(
    'normalizes BRC-29 and deployed byte representations across list and live paths %#',
    async transaction => {
      const incoming = message({ ...paymentToken, transaction })
      jest.spyOn(client, 'listMessages').mockResolvedValue([incoming])
      expect((await client.listIncomingPayments())[0].token.transaction).toEqual([1, 2, 3])
      const listen = jest.spyOn(client, 'listenForLiveMessages').mockResolvedValue()
      const onPayment = jest.fn()
      await client.listenForLivePayments({ onPayment })
      listen.mock.calls[0][0].onMessage(incoming)
      expect(onPayment).toHaveBeenCalledWith(
        expect.objectContaining({
          token: expect.objectContaining({ transaction: [1, 2, 3] })
        })
      )
    }
  )

  it('reloads a base64 Atomic BEEF and validates the actual payment before internalization', async () => {
    const tx = new Transaction()
    tx.addOutput({
      satoshis: 1,
      lockingScript: new P2PKH().lock(PublicKey.fromString(identityA).toHash())
    })
    const bytes = tx.toAtomicBEEF()
    jest
      .spyOn(client, 'listMessagesLite')
      .mockResolvedValue([
        message({ ...paymentToken, transaction: Buffer.from(bytes).toString('base64') })
      ])
    mockWallet.internalizeAction = jest.fn().mockResolvedValue({ accepted: true })
    const acknowledge = jest.spyOn(client, 'acknowledgeMessage').mockResolvedValue('ok')
    await client.acceptPayment({ messageId: 'message-1', sender: identityA, token: paymentToken })
    expect(mockWallet.internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({ tx: bytes }),
      undefined
    )
    expect(acknowledge).toHaveBeenCalledTimes(1)
  })

  it.each(['AR==', 'AQJ=', ' AQID', 'AQID\n', '-_8=', 'AQI', ''])(
    'retains invalid base64 %j without wallet or acknowledgement work',
    async transaction => {
      jest
        .spyOn(client, 'listMessagesLite')
        .mockResolvedValue([message({ ...paymentToken, transaction })])
      mockWallet.internalizeAction = jest.fn()
      const acknowledge = jest.spyOn(client, 'acknowledgeMessage')
      await expect(
        client.acceptPayment({ messageId: 'message-1', sender: identityA, token: paymentToken })
      ).rejects.toThrow('not present exactly once')
      expect(mockWallet.getPublicKey).not.toHaveBeenCalled()
      expect(mockWallet.internalizeAction).not.toHaveBeenCalled()
      expect(acknowledge).not.toHaveBeenCalled()
    }
  )

  it('bounds every payment collection before parsing attacker-controlled rows', async () => {
    const oversized = Array.from({ length: 1_001 }, () => message(paymentToken))
    const list = jest.spyOn(client, 'listMessages')
    list.mockResolvedValueOnce(oversized).mockResolvedValueOnce(oversized)

    await expect(client.listIncomingPayments()).rejects.toThrow('collection exceeds')
    await expect(client.listPaymentRequestResponses()).rejects.toThrow('collection exceeds')
  })

  it('normalizes both optional-note response branches and rejects malformed rows', async () => {
    jest
      .spyOn(client, 'listMessages')
      .mockResolvedValue([
        message({ requestId: 'declined', status: 'declined' }, { messageId: 'response-1' }),
        message(
          { requestId: 'paid', status: 'paid', amountPaid: 5, note: 'settled' },
          { messageId: 'response-2', sender: identityB }
        ),
        message({ requestId: 'invalid', status: 'paid', amountPaid: 0 }),
        message({ requestId: 'invalid', status: 'unknown' })
      ])

    await expect(client.listPaymentRequestResponses()).resolves.toEqual([
      expect.objectContaining({ requestId: 'declined', status: 'declined' }),
      expect.objectContaining({ requestId: 'paid', status: 'paid', note: 'settled' })
    ])
  })

  it('rejects structurally hostile payment-request mutations before transport work', async () => {
    const send = jest.spyOn(client, 'sendMessage')
    await expect(client.requestPayment([] as never)).rejects.toThrow('request is invalid')
    await expect(client.fulfillPaymentRequest([] as never)).rejects.toThrow(
      'fulfillment is invalid'
    )
    await expect(client.declinePaymentRequest([] as never)).rejects.toThrow('decline is invalid')
    await expect(client.cancelPaymentRequest([] as never)).rejects.toThrow(
      'cancellation is invalid'
    )
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects oversized authenticated request collections before HMAC verification', async () => {
    const oversized = Array.from({ length: 1_001 }, (_, index) =>
      message(
        {
          requestId: `request-${index}`,
          amount: 1,
          description: 'bounded',
          expiresAt: Date.now() + 60_000,
          senderIdentityKey: identityA,
          requestProof
        },
        { messageId: `message-${index}` }
      )
    )
    jest.spyOn(client, 'listMessages').mockResolvedValue(oversized)

    await expect(client.listIncomingPaymentRequests()).rejects.toThrow('collection exceeds')
    expect(mockWallet.verifyHmac).not.toHaveBeenCalled()
  })
})

describe('peer token boundary validation', () => {
  let client: PeerTokenClient
  let mockAdapter: jest.Mocked<TokenSettlementAdapter>
  let mockWallet: jest.Mocked<WalletInterface>

  beforeEach(() => {
    mockWallet = wallet()
    mockAdapter = adapter()
    client = new PeerTokenClient({
      messageBoxHost: 'https://message-box.example',
      walletClient: mockWallet,
      adapters: [mockAdapter]
    })
  })

  afterEach(() => jest.restoreAllMocks())

  it('rejects unbounded, duplicate, malformed, and accessor-bearing adapter registries', () => {
    expect(
      () => new PeerTokenClient({ walletClient: mockWallet, adapters: null as never })
    ).toThrow('bounded array')
    expect(
      () =>
        new PeerTokenClient({
          walletClient: mockWallet,
          adapters: Array.from({ length: 65 }, () => mockAdapter)
        })
    ).toThrow('bounded array')
    expect(
      () => new PeerTokenClient({ walletClient: mockWallet, adapters: [mockAdapter, mockAdapter] })
    ).toThrow('configuration is invalid')
    expect(
      () =>
        new PeerTokenClient({
          walletClient: mockWallet,
          adapters: [{ ...mockAdapter, acceptTokenSettlement: undefined } as never]
        })
    ).toThrow('configuration is invalid')

    const protocol = jest.fn(() => 'stas')
    const hostile = Object.defineProperty({}, 'protocol', { enumerable: true, get: protocol })
    expect(
      () => new PeerTokenClient({ walletClient: mockWallet, adapters: [hostile as never] })
    ).toThrow()
    expect(protocol).toHaveBeenCalledTimes(1)
  })

  it.each([
    [null, false, 'Invalid token transfer'],
    [{ recipient: identityA, protocol: 'stas', source: null, amount: '1' }, false, 'Invalid token'],
    [
      {
        recipient: identityA,
        protocol: 'stas',
        source: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`field${index}`, 1])),
        amount: '1'
      },
      false,
      'too many fields'
    ],
    [
      { recipient: identityA, protocol: 'dstas', source: tokenSource, amount: '1' },
      false,
      'does not match'
    ],
    [
      { recipient: identityA, protocol: 'stas', source: tokenSource, amount: '01' },
      false,
      'positive canonical integer'
    ],
    [
      { recipient: invalidCurveIdentity, protocol: 'stas', source: tokenSource, amount: '1' },
      false,
      'identity key is invalid'
    ],
    [{ recipient: identityA, protocol: 'stas', source: tokenSource, amount: '1' }, 'yes', 'boolean']
  ])(
    'rejects hostile transfer authority before adapter dispatch %#',
    async (params, dryRun, error) => {
      await expect(client.createTokenToken(params as never, dryRun as never)).rejects.toThrow(error)
      expect(mockAdapter.buildTokenSettlement).not.toHaveBeenCalled()
    }
  )

  it.each([
    [{ ...tokenArtifact, customInstructions: null }, 'settlement is invalid'],
    [{ ...tokenArtifact, transaction: [] }, 'transaction is invalid'],
    [{ ...tokenArtifact, outputIndex: -1 }, 'output index is invalid'],
    [{ ...tokenArtifact, amount: '0' }, 'positive canonical integer'],
    [{ ...tokenArtifact, protocol: 'stas\nspoof' }, 'protocol is invalid']
  ])('rejects malformed adapter artifacts %#', async (artifact, error) => {
    mockAdapter.buildTokenSettlement.mockResolvedValueOnce({
      action: 'settle',
      artifact
    } as never)

    await expect(
      client.createTokenToken({
        recipient: identityA,
        protocol: 'stas',
        source: tokenSource,
        amount: '1'
      })
    ).rejects.toThrow(error)
  })

  it('rejects an adapter termination with hostile text and a non-acceptance verdict', async () => {
    mockAdapter.buildTokenSettlement.mockResolvedValueOnce({
      action: 'terminate',
      termination: { code: 'denied', message: 'bad\nmessage' }
    })
    await expect(
      client.createTokenToken({
        recipient: identityA,
        protocol: 'stas',
        source: tokenSource,
        amount: '1'
      })
    ).rejects.toThrow('termination message is invalid')

    jest
      .spyOn(client, 'listIncomingTokens')
      .mockResolvedValue([{ messageId: 'token-message', sender: identityA, token: tokenArtifact }])
    mockAdapter.acceptTokenSettlement.mockResolvedValueOnce({
      action: 'terminate',
      termination: { code: 'frozen', message: 'token is frozen' }
    })
    await expect(
      client.acceptToken({ messageId: 'token-message', sender: identityB, token: tokenArtifact })
    ).rejects.toThrow('token is frozen')
  })

  it('does not synthesize an adapter settlement verdict from Object.prototype', async () => {
    Object.defineProperties(Object.prototype, {
      action: { configurable: true, value: 'settle' },
      artifact: { configurable: true, value: tokenArtifact }
    })
    try {
      mockAdapter.buildTokenSettlement.mockResolvedValueOnce({} as never)

      await expect(
        client.createTokenToken({
          recipient: identityA,
          protocol: 'stas',
          source: tokenSource,
          amount: '1'
        })
      ).rejects.toThrow('did not produce a settlement')
    } finally {
      delete (Object.prototype as Record<string, unknown>).action
      delete (Object.prototype as Record<string, unknown>).artifact
    }
  })

  it('does not synthesize a wallet verification verdict from Object.prototype', async () => {
    Object.defineProperty(Object.prototype, 'valid', {
      configurable: true,
      value: true
    })
    try {
      jest.spyOn(client, 'getIdentityKey').mockResolvedValue(identityA)
      mockWallet.verifyHmac.mockResolvedValueOnce({} as never)

      await expect(
        client.verifyTokenRequestProof({
          requestId: 'request-1',
          sender: identityA,
          requestProof
        })
      ).resolves.toBe(false)
    } finally {
      delete (Object.prototype as Record<string, unknown>).valid
    }
  })

  it('drops malformed token envelopes and never invokes an accessor payload', async () => {
    const accessor = Object.defineProperty({}, 'protocol', {
      enumerable: true,
      get: jest.fn(() => 'stas')
    })
    jest
      .spyOn(client, 'listMessagesLite')
      .mockResolvedValue([
        null,
        message(accessor),
        message(tokenArtifact, { messageId: 'bad\nidentifier' }),
        message(tokenArtifact, { sender: invalidCurveIdentity }),
        message({ ...tokenArtifact, transaction: [] }),
        message({ ...tokenArtifact, outputIndex: 0x1_0000_0000 })
      ] as never)

    await expect(client.listIncomingTokens()).resolves.toEqual([])
    expect(Object.getOwnPropertyDescriptor(accessor, 'protocol')?.get).not.toHaveBeenCalled()
  })

  it('bounds token, request, and response collections before parsing them', async () => {
    const oversized = Array.from({ length: 1_001 }, () => message(tokenArtifact))
    const list = jest.spyOn(client, 'listMessagesLite')
    list
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(oversized)
      .mockResolvedValueOnce(oversized)

    await expect(client.listIncomingTokens()).rejects.toThrow('collection exceeds')
    await expect(client.listIncomingTokenRequests()).rejects.toThrow('collection exceeds')
    await expect(client.listTokenRequestResponses()).rejects.toThrow('collection exceeds')
  })

  it('rejects malformed token request creation and cancellation before sending', async () => {
    const send = jest.spyOn(client, 'sendMessage')
    await expect(client.requestToken(null as never)).rejects.toThrow('request is invalid')
    await expect(
      client.requestToken({
        recipient: identityA,
        protocol: 'stas',
        assetId: 'asset-1',
        amount: '1',
        description: 'expired',
        expiresAt: Date.now() - 1
      })
    ).rejects.toThrow('future safe-integer')

    jest.spyOn(client, 'getIdentityKey').mockResolvedValue(identityA)
    mockWallet.createHmac
      .mockResolvedValueOnce({ hmac: Array<number>(32).fill(1) })
      .mockResolvedValueOnce({ hmac: [1] })
    await expect(
      client.requestToken({
        recipient: identityA,
        protocol: 'stas',
        assetId: 'asset-1',
        amount: '1',
        description: 'bad proof',
        expiresAt: Date.now() + 60_000
      })
    ).rejects.toThrow('invalid token request proof')
    await expect(client.cancelTokenRequest(null as never)).rejects.toThrow(
      'cancellation is invalid'
    )
    await expect(
      client.cancelTokenRequest({
        recipient: identityA,
        requestId: 'request-1',
        requestProof: 'not-a-proof'
      })
    ).rejects.toThrow('proof is invalid')
    expect(send).not.toHaveBeenCalled()
  })

  it('normalizes sent and declined token responses with their optional note branches', async () => {
    jest.spyOn(client, 'listMessagesLite').mockResolvedValue([
      message({
        requestId: 'request-sent',
        status: 'sent',
        protocol: 'stas',
        assetId: 'asset-1',
        amountSent: '1',
        note: 'settled'
      }),
      message({ requestId: 'request-declined', status: 'declined', note: 'unavailable' }),
      message({ requestId: 'request-invalid', status: 'sent', amountSent: '0' })
    ])

    await expect(client.listTokenRequestResponses()).resolves.toEqual([
      {
        requestId: 'request-sent',
        status: 'sent',
        protocol: 'stas',
        assetId: 'asset-1',
        amountSent: '1',
        note: 'settled'
      },
      { requestId: 'request-declined', status: 'declined', note: 'unavailable' }
    ])
  })

  it('drops token requests with spoofed senders, hostile expiry, proofs, and fields', async () => {
    const future = Date.now() + 60_000
    const valid = {
      requestId: 'request-1',
      protocol: 'stas',
      assetId: 'asset-1',
      amount: '1',
      description: 'send token',
      expiresAt: future,
      senderIdentityKey: identityA,
      requestProof
    }
    jest
      .spyOn(client, 'listMessagesLite')
      .mockResolvedValue([
        message({ ...valid, senderIdentityKey: identityB }),
        message({ ...valid, expiresAt: 1.5 }),
        message({ ...valid, requestProof: 'not-a-proof' }),
        message({ ...valid, amount: '01' }),
        message({ ...valid, description: 'bad\ndescription' })
      ])

    await expect(client.listIncomingTokenRequests()).resolves.toEqual([])
    expect(mockWallet.verifyHmac).not.toHaveBeenCalled()
  })
})
