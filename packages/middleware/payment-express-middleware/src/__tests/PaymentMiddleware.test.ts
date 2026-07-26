import { Beef, P2PKH, PrivateKey, Script, Transaction, Utils, type WalletInterface } from '@bsv/sdk'
import { InMemoryPaymentReplayStore, createPaymentMiddleware } from '../index.js'
import type { PaymentLogger, PaymentReplayStore, PaymentRequest } from '../types.js'

const IDENTITY_KEY = new PrivateKey(1).toPublicKey().toString()
const DERIVATION_PREFIX = Utils.toBase64(Array.from({ length: 48 }, () => 1))
const DERIVATION_SUFFIX = Utils.toBase64(Array.from({ length: 48 }, () => 2))

interface TestResponse {
  statusCode: number
  headers: Record<string, string>
  body?: Record<string, unknown>
  status: jest.Mock
  set: jest.Mock
  json: jest.Mock
}

function makeWallet(
  overrides: Partial<WalletInterface> & Record<string, unknown> = {}
): WalletInterface {
  return {
    createHmac: jest.fn().mockResolvedValue({
      hmac: Array.from({ length: 32 }, () => 3)
    }),
    verifyHmac: jest.fn().mockResolvedValue({ valid: true }),
    internalizeAction: jest.fn().mockResolvedValue({ accepted: true, isMerge: false }),
    ...overrides
  } as unknown as WalletInterface
}

function makeResponse(): TestResponse {
  const response = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status: jest.fn(),
    set: jest.fn(),
    json: jest.fn()
  } as TestResponse
  response.status.mockImplementation((statusCode: number) => {
    response.statusCode = statusCode
    return response
  })
  response.set.mockImplementation((headers: Record<string, string>) => {
    Object.assign(response.headers, headers)
    return response
  })
  response.json.mockImplementation((body: Record<string, unknown>) => {
    response.body = body
    return response
  })
  return response
}

function makeRequest(paymentHeader?: string | string[]): PaymentRequest {
  return {
    auth: { identityKey: IDENTITY_KEY },
    headers: paymentHeader === undefined ? {} : { 'x-bsv-payment': paymentHeader }
  } as unknown as PaymentRequest
}

function makeAtomicPayment(satoshis = 100): {
  header: string
  transaction: string
  transactionId: string
} {
  const transaction = new Transaction()
  transaction.addInput({
    sourceTXID: '0'.repeat(64),
    sourceOutputIndex: 0xffffffff,
    unlockingScript: Script.fromHex('00'),
    sequence: 0xffffffff
  })
  transaction.addOutput({
    lockingScript: new P2PKH().lock(new PrivateKey(2).toPublicKey().toAddress()),
    satoshis
  })
  const transactionId = transaction.id('hex')
  const beef = new Beef()
  beef.mergeTransaction(transaction)
  const encoded = Utils.toBase64(beef.toBinaryAtomic(transactionId))
  return {
    transaction: encoded,
    transactionId,
    header: JSON.stringify({
      derivationPrefix: DERIVATION_PREFIX,
      derivationSuffix: DERIVATION_SUFFIX,
      transaction: encoded
    })
  }
}

async function invoke(
  options: Parameters<typeof createPaymentMiddleware>[0],
  request: PaymentRequest = makeRequest()
): Promise<{ response: TestResponse; next: jest.Mock }> {
  const response = makeResponse()
  const next = jest.fn()
  await createPaymentMiddleware(options)(request, response as never, next)
  return { response, next }
}

describe('InMemoryPaymentReplayStore', () => {
  it('claims a transaction ID exactly once', () => {
    const store = new InMemoryPaymentReplayStore(1)
    expect(store.claim('txid')).toBe(true)
    expect(store.claim('txid')).toBe(false)
  })

  it('fails closed at capacity and validates its limit', () => {
    expect(() => new InMemoryPaymentReplayStore(0)).toThrow(RangeError)
    const store = new InMemoryPaymentReplayStore(1)
    store.claim('first')
    expect(() => store.claim('second')).toThrow('capacity')
  })
})

describe('createPaymentMiddleware configuration', () => {
  it('validates required options and collaborators', () => {
    expect(() => createPaymentMiddleware(undefined as never)).toThrow(TypeError)
    expect(() =>
      createPaymentMiddleware({
        wallet: makeWallet(),
        calculateRequestPrice: 1 as never
      })
    ).toThrow('must be a function')
    expect(() => createPaymentMiddleware({ wallet: {} as never })).toThrow('valid wallet')
    expect(() =>
      createPaymentMiddleware({
        wallet: makeWallet(),
        replayStore: {} as never
      })
    ).toThrow('replay store')
    expect(() =>
      createPaymentMiddleware({
        wallet: makeWallet(),
        logger: { error: 'not-a-function' } as never
      })
    ).toThrow('logger')
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid maximum header size %s',
    maxPaymentHeaderBytes => {
      expect(() =>
        createPaymentMiddleware({
          wallet: makeWallet(),
          maxPaymentHeaderBytes
        })
      ).toThrow(RangeError)
    }
  )
})

describe('createPaymentMiddleware request handling', () => {
  it.each([undefined, 'unknown', 'not-a-public-key'])(
    'fails closed without an authenticated compressed identity key (%s)',
    async identityKey => {
      const request = makeRequest()
      request.auth = identityKey === undefined ? undefined : { identityKey }
      const { response, next } = await invoke({ wallet: makeWallet() }, request)
      expect(response.statusCode).toBe(500)
      expect(response.body?.code).toBe('ERR_SERVER_MISCONFIGURED')
      expect(next).not.toHaveBeenCalled()
    }
  )

  it('allows an explicitly free request and records a zero payment', async () => {
    const request = makeRequest()
    const { response, next } = await invoke(
      {
        wallet: makeWallet(),
        calculateRequestPrice: () => 0
      },
      request
    )
    expect(response.status).not.toHaveBeenCalled()
    expect(request.payment).toEqual({
      satoshisPaid: 0,
      accepted: true,
      tx: '',
      txid: ''
    })
    expect(next).toHaveBeenCalledTimes(1)
  })

  it.each([-1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid calculated price %s',
    async requestPrice => {
      const logger: PaymentLogger = { error: jest.fn() }
      const { response, next } = await invoke({
        wallet: makeWallet(),
        calculateRequestPrice: () => requestPrice,
        logger
      })
      expect(response.statusCode).toBe(500)
      expect(response.body?.code).toBe('ERR_PAYMENT_INTERNAL')
      expect(logger.error).toHaveBeenCalled()
      expect(next).not.toHaveBeenCalled()
    }
  )

  it('sanitizes pricing failures while retaining opt-in diagnostic logging', async () => {
    const logger: PaymentLogger = { error: jest.fn() }
    const { response } = await invoke({
      wallet: makeWallet(),
      calculateRequestPrice: () => {
        throw new Error('database password is secret')
      },
      logger
    })
    expect(response.statusCode).toBe(500)
    expect(JSON.stringify(response.body)).not.toContain('password')
    expect(logger.error).toHaveBeenCalledWith(
      'Payment pricing failed.',
      expect.objectContaining({ errorName: 'Error' })
    )
    expect(JSON.stringify((logger.error as jest.Mock).mock.calls)).not.toContain('password')
  })

  it('issues a complete 402 challenge without a payment header', async () => {
    const { response, next } = await invoke({ wallet: makeWallet() })
    expect(response.statusCode).toBe(402)
    expect(response.headers).toMatchObject({
      'x-bsv-payment-version': '1.0',
      'x-bsv-payment-satoshis-required': '100'
    })
    expect(response.headers['x-bsv-payment-derivation-prefix']).toBeTruthy()
    expect(response.body).toMatchObject({
      code: 'ERR_PAYMENT_REQUIRED',
      satoshisRequired: 100
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('returns a stable 503 if challenge generation fails', async () => {
    const logger: PaymentLogger = { error: jest.fn() }
    const wallet = makeWallet({
      createHmac: jest.fn().mockRejectedValue(new Error('HSM unavailable'))
    })
    const { response } = await invoke({ wallet, logger })
    expect(response.statusCode).toBe(503)
    expect(response.body?.code).toBe('ERR_PAYMENT_UNAVAILABLE')
    expect(JSON.stringify(response.body)).not.toContain('HSM')
    expect(logger.error).toHaveBeenCalled()
  })

  it.each([
    ['duplicate header', [makeAtomicPayment().header, makeAtomicPayment().header]],
    ['invalid JSON', '{'],
    ['non-object JSON', '[]'],
    ['missing fields', '{}'],
    [
      'non-string field',
      JSON.stringify({
        derivationPrefix: 1,
        derivationSuffix: DERIVATION_SUFFIX,
        transaction: makeAtomicPayment().transaction
      })
    ],
    [
      'non-canonical prefix',
      JSON.stringify({
        derivationPrefix: 'not base64',
        derivationSuffix: DERIVATION_SUFFIX,
        transaction: makeAtomicPayment().transaction
      })
    ],
    [
      'non-canonical suffix',
      JSON.stringify({
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: '***',
        transaction: makeAtomicPayment().transaction
      })
    ],
    [
      'non-canonical transaction',
      JSON.stringify({
        derivationPrefix: DERIVATION_PREFIX,
        derivationSuffix: DERIVATION_SUFFIX,
        transaction: 'not base64'
      })
    ]
  ])('rejects a malformed %s', async (_case, header) => {
    const { response } = await invoke({ wallet: makeWallet() }, makeRequest(header))
    expect(response.statusCode).toBe(400)
    expect(response.body?.code).toBe('ERR_MALFORMED_PAYMENT')
  })

  it('rejects oversized payment headers before parsing', async () => {
    const { response } = await invoke(
      {
        wallet: makeWallet(),
        maxPaymentHeaderBytes: 8
      },
      makeRequest(makeAtomicPayment().header)
    )
    expect(response.body?.code).toBe('ERR_MALFORMED_PAYMENT')
  })

  it('rejects false and failed nonce verification without exposing errors', async () => {
    for (const verifyHmac of [
      jest.fn().mockResolvedValue({ valid: false }),
      jest.fn().mockRejectedValue(new Error('secret verifier detail'))
    ]) {
      const logger: PaymentLogger = { warn: jest.fn() }
      const { response } = await invoke(
        {
          wallet: makeWallet({ verifyHmac }),
          logger
        },
        makeRequest(makeAtomicPayment().header)
      )
      expect(response.body?.code).toBe('ERR_INVALID_DERIVATION_PREFIX')
      expect(JSON.stringify(response.body)).not.toContain('secret')
    }
  })

  it.each([
    ['invalid BEEF', Utils.toBase64([1, 2, 3])],
    [
      'non-atomic BEEF',
      (() => {
        const transaction = new Transaction()
        transaction.addInput({
          sourceTXID: '0'.repeat(64),
          sourceOutputIndex: 0xffffffff,
          unlockingScript: Script.fromHex('00'),
          sequence: 0xffffffff
        })
        transaction.addOutput({
          lockingScript: Script.fromHex('51'),
          satoshis: 100
        })
        const beef = new Beef()
        beef.mergeTransaction(transaction)
        return Utils.toBase64(beef.toBinary())
      })()
    ],
    ['underpayment', makeAtomicPayment(99).transaction]
  ])('rejects %s without calling the wallet', async (_case, transaction) => {
    const wallet = makeWallet()
    const header = JSON.stringify({
      derivationPrefix: DERIVATION_PREFIX,
      derivationSuffix: DERIVATION_SUFFIX,
      transaction
    })
    const { response } = await invoke({ wallet }, makeRequest(header))
    expect(response.body?.code).toBe('ERR_INVALID_PAYMENT')
    expect(wallet.internalizeAction).not.toHaveBeenCalled()
  })

  it('fails closed when a replay claim is rejected or unavailable', async () => {
    for (const claim of [
      jest.fn().mockResolvedValue(false),
      jest.fn().mockResolvedValue('not-a-boolean'),
      jest.fn().mockRejectedValue(new Error('store unavailable'))
    ]) {
      const logger: PaymentLogger = { error: jest.fn() }
      const replayStore: PaymentReplayStore = { claim }
      const { response, next } = await invoke(
        {
          wallet: makeWallet(),
          replayStore,
          logger
        },
        makeRequest(makeAtomicPayment().header)
      )
      expect([409, 503]).toContain(response.statusCode)
      expect(next).not.toHaveBeenCalled()
    }
  })

  it.each([
    { accepted: false, isMerge: false },
    { accepted: true, isMerge: true }
  ])('does not authorize a wallet result of %j', async result => {
    const wallet = makeWallet({
      internalizeAction: jest.fn().mockResolvedValue(result)
    })
    const { response, next } = await invoke({ wallet }, makeRequest(makeAtomicPayment().header))
    expect(response.statusCode).toBe(409)
    expect(response.body?.code).toBe('ERR_PAYMENT_REPLAYED')
    expect(next).not.toHaveBeenCalled()
  })

  it('retains the replay claim after an ambiguous internalization error', async () => {
    const replayStore: PaymentReplayStore = {
      claim: jest.fn().mockResolvedValue(true)
    }
    const logger: PaymentLogger = { warn: jest.fn() }
    const wallet = makeWallet({
      internalizeAction: jest.fn().mockRejectedValue(new Error('wallet secret'))
    })
    const { response, next } = await invoke(
      {
        wallet,
        replayStore,
        logger
      },
      makeRequest(makeAtomicPayment().header)
    )
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(JSON.stringify((logger.warn as jest.Mock).mock.calls)).not.toContain('wallet secret')
    expect(response.body).toEqual({
      status: 'error',
      code: 'ERR_PAYMENT_FAILED',
      description: 'The payment could not be accepted.'
    })
    expect(next).not.toHaveBeenCalled()
  })

  it('accepts a sufficiently funded atomic payment and records actual value', async () => {
    const payment = makeAtomicPayment(125)
    const request = makeRequest(payment.header)
    const wallet = makeWallet()
    const { response, next } = await invoke(
      {
        wallet,
        calculateRequestPrice: () => 100
      },
      request
    )
    expect(next).toHaveBeenCalledTimes(1)
    expect(response.headers['x-bsv-payment-satoshis-paid']).toBe('125')
    expect(request.payment).toEqual({
      satoshisPaid: 125,
      accepted: true,
      tx: payment.transaction,
      txid: payment.transactionId
    })
    expect(wallet.internalizeAction).toHaveBeenCalledWith({
      tx: expect.any(Array),
      outputs: [
        {
          paymentRemittance: {
            derivationPrefix: DERIVATION_PREFIX,
            derivationSuffix: DERIVATION_SUFFIX,
            senderIdentityKey: IDENTITY_KEY
          },
          outputIndex: 0,
          protocol: 'wallet payment'
        }
      ],
      description: 'Payment for request'
    })
  })

  it('rejects the same transaction on its second request by default', async () => {
    const payment = makeAtomicPayment()
    const middleware = createPaymentMiddleware({ wallet: makeWallet() })
    const first = makeResponse()
    const second = makeResponse()
    await middleware(makeRequest(payment.header), first as never, jest.fn())
    const next = jest.fn()
    await middleware(makeRequest(payment.header), second as never, next)
    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(409)
    expect(second.body?.code).toBe('ERR_PAYMENT_REPLAYED')
    expect(next).not.toHaveBeenCalled()
  })
})
