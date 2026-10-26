import { PrivateKey, type WalletInterface } from '@bsv/sdk'
import { jest } from '@jest/globals'
import { MessageBoxClient } from '../MessageBoxClient.js'
import type { SendMessageParams } from '../types.js'
import type { GetQuoteParams, SendListParams } from '../types/permissions.js'

const serverIdentity = PrivateKey.fromRandom().toPublicKey().toString()
const alternateServerIdentity = PrivateKey.fromRandom().toPublicKey().toString()
const recipientA = PrivateKey.fromRandom().toPublicKey().toString()
const recipientB = PrivateKey.fromRandom().toPublicKey().toString()
const host = 'https://message-box.example/api'

function wallet(): WalletInterface {
  return {
    getPublicKey: jest.fn().mockResolvedValue({ publicKey: recipientA }),
    createHmac: jest.fn().mockResolvedValue({ hmac: Array<number>(32).fill(1) })
  } as unknown as WalletInterface
}

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Unavailable',
    headers: new Headers({ 'x-bsv-auth-identity-key': serverIdentity }),
    bodyUsed: false,
    json: async () => body
  } as Response
}

function client(): MessageBoxClient {
  return new MessageBoxClient({ host, walletClient: wallet() })
}

function sendParams(overrides: Partial<SendMessageParams> = {}): SendMessageParams {
  return {
    recipient: recipientA,
    messageBox: 'inbox',
    body: 'hello',
    skipEncryption: true,
    ...overrides
  }
}

describe('MessageBoxClient boundary validation', () => {
  afterEach(() => jest.restoreAllMocks())

  it.each([
    [{ maximumPayment: -1 }, 'non-negative safe integer'],
    [{ maximumPayment: 1.5 }, 'non-negative safe integer'],
    [{ skipEncryption: 'yes' }, 'skipEncryption'],
    [{ checkPermissions: 1 }, 'checkPermissions'],
    [{ body: 1 }, 'non-empty string or plain data object'],
    [{ body: ' '.repeat(2) }, 'must have a body'],
    [{ messageBox: 'inbox\nspoof' }, 'exact non-empty string'],
    [{ messageId: 'id\u007fspoof' }, 'exact non-empty string']
  ])('rejects hostile single-message input %#', async (overrides, expected) => {
    await expect(
      client().sendMessage(sendParams(overrides as Partial<SendMessageParams>), host)
    ).rejects.toThrow(expected)
  })

  it('rejects non-plain, sparse, extended, accessor, and oversized body graphs', async () => {
    const cyclic: Record<string, unknown> = { safe: true }
    cyclic.self = cyclic
    await expect(client().sendMessage(sendParams({ body: cyclic }), host)).rejects.not.toThrow(
      /bounded plain own data/
    )

    const sparse: string[] = []
    sparse.length = 2
    sparse[0] = 'present'
    const extended = ['present'] as string[] & { extra?: string }
    extended.extra = 'unexpected'
    const accessor = Object.defineProperty({}, 'secret', { get: () => 'invoked' })
    const symbolKeyed = { safe: true } as Record<PropertyKey, unknown>
    symbolKeyed[Symbol('unsafe')] = true

    for (const body of [new Date(), sparse, extended, accessor, symbolKeyed]) {
      await expect(
        client().sendMessage(sendParams({ body: body as object }), host)
      ).rejects.toThrow()
    }

    await expect(
      client().sendMessage(sendParams({ body: new Uint8Array(1_000_001) }), host)
    ).rejects.toThrow('too large')
  })

  it('rejects invalid array indices, trap failures, and non-plain parameter records', async () => {
    const invalidIndex = Array(1) as unknown[] & Record<string, unknown>
    Object.defineProperty(invalidIndex, '01', {
      configurable: true,
      enumerable: true,
      value: 'ambiguous-index'
    })
    await expect(client().sendMessage(sendParams({ body: invalidIndex }), host)).rejects.toThrow(
      'invalid array property'
    )

    const trappedBody = new Proxy(
      {},
      {
        getPrototypeOf(): never {
          throw new Error('prototype trap')
        }
      }
    )
    await expect(client().sendMessage(sendParams({ body: trappedBody }), host)).rejects.toThrow(
      'bounded plain own data'
    )

    const nonPlainParams = Object.assign(new Date(), sendParams())
    await expect(
      client().sendMessage(nonPlainParams as unknown as SendMessageParams, host)
    ).rejects.toThrow('plain object prototype')
  })

  it('rejects duplicate batch and quote recipients and bounded quote cardinality', async () => {
    const batch = {
      recipients: [recipientA, recipientA],
      messageBox: 'inbox',
      body: 'hello',
      skipEncryption: true
    } satisfies SendListParams
    await expect(client().sendMessageToRecipients(batch, host)).rejects.toThrow('unique')

    await expect(
      client().getMessageBoxQuote({
        recipient: [recipientA, recipientA],
        messageBox: 'inbox'
      })
    ).rejects.toThrow('unique')
    await expect(
      client().getMessageBoxQuote({
        recipient: Array.from({ length: 101 }, () => recipientA),
        messageBox: 'inbox'
      })
    ).rejects.toThrow('at most 100')
  })

  it('rejects hostile server-identity pin containers without invoking accessors', () => {
    expect(
      () => new MessageBoxClient({ walletClient: wallet(), serverIdentityKeysByHost: [] as never })
    ).toThrow('plain own-data record')
    expect(
      () =>
        new MessageBoxClient({
          walletClient: wallet(),
          serverIdentityKeysByHost: Object.create({ inherited: serverIdentity })
        })
    ).toThrow('bounded plain own-data record')

    const getter = jest.fn(() => serverIdentity)
    const pins = Object.defineProperty({}, host, { enumerable: true, get: getter })
    expect(
      () =>
        new MessageBoxClient({
          walletClient: wallet(),
          serverIdentityKeysByHost: pins as Record<string, string>
        })
    ).toThrow('bounded plain own-data record')
    expect(getter).not.toHaveBeenCalled()

    const tooManyPins = Object.fromEntries(
      Array.from({ length: 33 }, (_, index) => [`https://host-${index}.example`, serverIdentity])
    )
    expect(
      () =>
        new MessageBoxClient({
          walletClient: wallet(),
          serverIdentityKeysByHost: tooManyPins
        })
    ).toThrow('bounded plain own-data record')

    expect(
      () =>
        new MessageBoxClient({
          walletClient: wallet(),
          serverIdentityKeysByHost: {
            'https://message-box.example': serverIdentity,
            'https://message-box.example/': alternateServerIdentity
          }
        })
    ).toThrow('Conflicting Message Box server identity pins')
  })

  it.each([
    [{ limit: 0 }, 'limit'],
    [{ limit: 1.5 }, 'limit'],
    [{ offset: -1 }, 'offset'],
    [{ offset: Number.MAX_SAFE_INTEGER + 1 }, 'offset']
  ])('bounds registered-device pagination %#', async (pagination, expected) => {
    await expect(client().listRegisteredDevices(host, pagination)).rejects.toThrow(expected)
  })

  it.each([
    [{ id: 0 }, 'positive safe integer'],
    [{ deviceId: '' }, 'exact non-empty string'],
    [{ platform: 'desktop' }, 'platform is invalid'],
    [{ active: 1 }, 'active flag is invalid'],
    [{ createdAt: 'yesterday' }, 'must be a timestamp']
  ])('rejects malformed registered-device fields %#', async (override, expected) => {
    const instance = client()
    jest.spyOn(instance.authFetch, 'fetch').mockResolvedValue(
      response({
        status: 'success',
        devices: [
          {
            id: 1,
            deviceId: null,
            platform: null,
            fcmToken: 'masked-token',
            active: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            lastUsed: '2026-01-01T00:00:00.000Z',
            ...override
          }
        ]
      })
    )
    await expect(instance.listRegisteredDevices(host)).rejects.toThrow(expected)
  })

  it('accepts a canonical registered device and binds pagination to the request URL', async () => {
    const instance = client()
    const fetch = jest.spyOn(instance.authFetch, 'fetch').mockResolvedValue(
      response({
        status: 'success',
        devices: [
          {
            id: 1,
            deviceId: 'browser-1',
            platform: 'web',
            fcmToken: 'masked-token',
            active: true,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
            lastUsed: '2026-01-03T00:00:00.000Z'
          }
        ]
      })
    )
    await expect(
      instance.listRegisteredDevices(host, { limit: 1, offset: 2 })
    ).resolves.toHaveLength(1)
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('limit=1&offset=2'), {
      method: 'GET'
    })
  })

  it('bounds acknowledgement and permission-list pagination before network work', async () => {
    const instance = client()
    await expect(
      instance.acknowledgeMessage({ messageIds: Array.from({ length: 1_001 }, () => 'id') })
    ).rejects.toThrow('at most 1000')
    await expect(instance.listMessageBoxPermissions({ limit: 0 }, host)).rejects.toThrow('limit')
    await expect(instance.listMessageBoxPermissions({ offset: -1 }, host)).rejects.toThrow('offset')
  })

  it('rejects malformed permission and device response envelopes', async () => {
    const instance = client()
    const fetch = jest.spyOn(instance.authFetch, 'fetch')
    fetch
      .mockResolvedValueOnce(response({ status: 'pending', permissions: [] }))
      .mockResolvedValueOnce(response({ status: 'success', devices: null }))
      .mockResolvedValueOnce(response({ status: 'success', message: 1, deviceId: 0 }))

    await expect(instance.listMessageBoxPermissions(undefined, host)).rejects.toThrow(
      'status is invalid'
    )
    await expect(instance.listRegisteredDevices(host)).rejects.toThrow('response is invalid')
    await expect(
      instance.registerDevice({ fcmToken: 'token', platform: 'web' }, host)
    ).rejects.toThrow('response is invalid')
  })

  it('rejects quote responses whose shape or row cardinality is not authoritative', async () => {
    const instance = client()
    jest
      .spyOn(instance.authFetch, 'fetch')
      .mockResolvedValue(response({ status: 'success', quotesByRecipient: [] }))
    const params: GetQuoteParams = {
      recipient: [recipientA, recipientB],
      messageBox: 'inbox'
    }
    await expect(instance.getMessageBoxQuote(params, host)).rejects.toThrow('exactly one row')
  })

  it('fails closed on hostile parameter containers and all non-plain array variants', async () => {
    const instance = client()
    const hostileParams = new Proxy(sendParams(), {
      ownKeys() {
        throw new Error('do not enumerate')
      }
    })
    await expect(instance.sendMessage(hostileParams, host)).rejects.toThrow('plain own-data record')

    const symbolParams = sendParams() as SendMessageParams & Record<PropertyKey, unknown>
    symbolParams[Symbol('hidden')] = true
    await expect(instance.sendMessage(symbolParams, host)).rejects.toThrow('unsafe property')

    class NonPlainArray extends Array<string> {}
    await expect(
      instance.sendMessage(sendParams({ body: new NonPlainArray('payload') }), host)
    ).rejects.toThrow('non-plain array')
    await expect(
      instance.sendMessage(sendParams({ body: 'x'.repeat(4 * 1024 * 1024 + 1) }), host)
    ).rejects.toThrow('at most 4194304')
  })

  it('accepts a bounded typed-array leaf without invoking object accessors', async () => {
    const instance = client()
    jest.spyOn(instance.authFetch, 'fetch').mockResolvedValue(
      response({
        status: 'success',
        results: [{ recipient: recipientA, messageId: 'typed-array-message' }]
      })
    )

    await expect(
      instance.sendMessage(
        sendParams({
          body: { bytes: new Uint8Array([1, 2, 3]) },
          messageId: 'typed-array-message'
        }),
        host
      )
    ).resolves.toEqual({ status: 'success', messageId: 'typed-array-message' })
  })

  it('rejects single-send result cardinality before accepting server success', async () => {
    const instance = client()
    jest
      .spyOn(instance.authFetch, 'fetch')
      .mockResolvedValue(response({ status: 'success', results: [] }))

    await expect(
      instance.sendMessage(sendParams({ messageId: 'single-message' }), host)
    ).rejects.toThrow('exactly one result')
  })

  it('requires a bounded delivery identity map for an otherwise valid batch quote', async () => {
    const instance = client()
    jest.spyOn(instance, 'getMessageBoxQuote').mockResolvedValue({
      quotesByRecipient: [recipientA, recipientB].map(recipient => ({
        recipient,
        messageBox: 'inbox',
        recipientFee: 0,
        deliveryFee: 0,
        status: 'always_allow' as const
      })),
      blockedRecipients: [],
      deliveryAgentIdentityKeyByHost: {},
      totals: { deliveryFees: 0, recipientFees: 0, totalForPayableRecipients: 0 }
    })

    await expect(
      instance.sendMessageToRecipients(
        {
          recipients: [recipientA, recipientB],
          messageBox: 'inbox',
          body: 'hello',
          skipEncryption: true
        },
        host
      )
    ).rejects.toThrow('must contain 1–100 hosts')
  })

  it('rejects malformed multi-quote arrays and blocked-recipient authority', async () => {
    const instance = client()
    const rows = [recipientA, recipientB].map(recipient => ({
      recipient,
      messageBox: 'inbox',
      recipientFee: 0,
      deliveryFee: 0,
      status: 'always_allow' as const
    }))
    const quote = jest.spyOn(instance, 'getMessageBoxQuote')
    const send = async () =>
      await instance.sendMessageToRecipients(
        {
          recipients: [recipientA, recipientB],
          messageBox: 'inbox',
          body: 'hello',
          skipEncryption: true
        },
        host
      )

    quote.mockResolvedValueOnce({ quotesByRecipient: null } as never)
    await expect(send()).rejects.toThrow('must contain quotesByRecipient')

    quote.mockResolvedValueOnce({ quotesByRecipient: rows.slice(0, 1) } as never)
    await expect(send()).rejects.toThrow('exactly one quote')

    quote.mockResolvedValueOnce({
      quotesByRecipient: rows,
      blockedRecipients: {},
      deliveryAgentIdentityKeyByHost: { [host]: serverIdentity }
    } as never)
    await expect(send()).rejects.toThrow('must be an array')

    quote.mockResolvedValueOnce({
      quotesByRecipient: [{ ...rows[0], recipientFee: -1, status: 'blocked' }, rows[1]],
      blockedRecipients: [],
      deliveryAgentIdentityKeyByHost: { [host]: serverIdentity }
    } as never)
    await expect(send()).rejects.toThrow('exactly match blocked quote rows')
  })

  it('validates single-quote transport status, authority, and fee fields', async () => {
    const instance = client()
    const fetch = jest.spyOn(instance.authFetch, 'fetch')
    fetch
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(response({ status: 'denied' }))
      .mockResolvedValueOnce({
        ...response({ status: 'success', quote: { deliveryFee: 1, recipientFee: 2 } }),
        headers: new Headers()
      })
      .mockResolvedValueOnce(
        response({ status: 'success', quote: { deliveryFee: 1, recipientFee: -1 } })
      )

    const params = { recipient: recipientA, messageBox: 'inbox' }
    await expect(instance.getMessageBoxQuote(params, host)).rejects.toThrow('HTTP 503')
    await expect(instance.getMessageBoxQuote(params, host)).rejects.toThrow('rejected')
    await expect(instance.getMessageBoxQuote(params, host)).rejects.toThrow(
      'did not return a mutually authenticated response'
    )
    await expect(instance.getMessageBoxQuote(params, host)).resolves.toEqual({
      deliveryFee: 1,
      recipientFee: -1,
      deliveryAgentIdentityKey: serverIdentity
    })
  })

  it('falls back from a legacy single quote to authoritative per-recipient quotes', async () => {
    const instance = client()
    jest
      .spyOn(instance.authFetch, 'fetch')
      .mockResolvedValueOnce(response({ quote: { deliveryFee: 7, recipientFee: 0 } }))
      .mockResolvedValueOnce(response({ quote: { deliveryFee: 7, recipientFee: 0 } }))
      .mockResolvedValueOnce(response({ quote: { deliveryFee: 7, recipientFee: -1 } }))

    await expect(
      instance.getMessageBoxQuote(
        { recipient: [recipientA, recipientB], messageBox: 'inbox' },
        host
      )
    ).resolves.toEqual({
      quotesByRecipient: [
        {
          recipient: recipientA,
          messageBox: 'inbox',
          deliveryFee: 7,
          recipientFee: 0,
          status: 'always_allow'
        },
        {
          recipient: recipientB,
          messageBox: 'inbox',
          deliveryFee: 7,
          recipientFee: -1,
          status: 'blocked'
        }
      ],
      totals: { deliveryFees: 14, recipientFees: 0, totalForPayableRecipients: 14 },
      blockedRecipients: [recipientB],
      deliveryAgentIdentityKeyByHost: { [host]: serverIdentity }
    })
  })

  it('rejects unauthoritative multi-quote envelopes and missing delivery identity', async () => {
    const params = { recipient: [recipientA, recipientB], messageBox: 'inbox' }
    const withoutIdentity = {
      ...response({ quotesByRecipient: [] }),
      headers: new Headers()
    }
    const instance = client()
    const fetch = jest.spyOn(instance.authFetch, 'fetch')
    fetch
      .mockResolvedValueOnce(response({}, 503))
      .mockResolvedValueOnce(withoutIdentity)
      .mockResolvedValueOnce(response({ status: 'denied', quotesByRecipient: [] }))
      .mockResolvedValueOnce(response({ status: 'success' }))

    await expect(instance.getMessageBoxQuote(params, host)).rejects.toThrow('HTTP 503')
    await expect(instance.getMessageBoxQuote(params, host)).rejects.toThrow(
      'did not return a mutually authenticated response'
    )
    await expect(instance.getMessageBoxQuote(params, host)).rejects.toThrow('rejected')
    await expect(instance.getMessageBoxQuote(params, host)).rejects.toThrow(
      'Unexpected quote response shape'
    )
  })

  it('sends a zero-fee batch without fabricating payment data and binds every result', async () => {
    const instance = client()
    jest.spyOn(instance, 'getMessageBoxQuote').mockResolvedValue({
      quotesByRecipient: [recipientA, recipientB].map(recipient => ({
        recipient,
        messageBox: 'inbox',
        recipientFee: 0,
        deliveryFee: 0,
        status: 'always_allow' as const
      })),
      blockedRecipients: [],
      deliveryAgentIdentityKeyByHost: { [host]: serverIdentity },
      totals: { deliveryFees: 0, recipientFees: 0, totalForPayableRecipients: 0 }
    })
    const messageId = '01'.repeat(32)
    const fetch = jest.spyOn(instance.authFetch, 'fetch').mockResolvedValue(
      response({
        status: 'success',
        results: [
          { recipient: recipientA, messageId },
          { recipient: recipientB, messageId }
        ]
      })
    )

    await expect(
      instance.sendMessageToRecipients(
        {
          recipients: [recipientA, recipientB],
          messageBox: 'inbox',
          body: 'hello',
          skipEncryption: true
        },
        host
      )
    ).resolves.toMatchObject({ status: 'success', blocked: [], failed: [] })
    const request = fetch.mock.calls[0][1]
    expect(request?.body).not.toContain('payment')
  })

  it.each([
    [{}, 'exceed the submitted recipient set'],
    [
      [
        { recipient: recipientA, messageId: 'wrong' },
        { recipient: recipientA, messageId: 'wrong' }
      ],
      'does not match the submitted message'
    ]
  ])('rejects unauthoritative batch result bindings %#', async (results, expected) => {
    const instance = client()
    jest.spyOn(instance, 'getMessageBoxQuote').mockResolvedValue({
      quotesByRecipient: [recipientA, recipientB].map(recipient => ({
        recipient,
        messageBox: 'inbox',
        recipientFee: 0,
        deliveryFee: 0,
        status: 'always_allow' as const
      })),
      blockedRecipients: [],
      deliveryAgentIdentityKeyByHost: { [host]: serverIdentity },
      totals: { deliveryFees: 0, recipientFees: 0, totalForPayableRecipients: 0 }
    })
    jest.spyOn(instance.authFetch, 'fetch').mockResolvedValue(
      response({
        status: 'success',
        results
      })
    )

    await expect(
      instance.sendMessageToRecipients(
        {
          recipients: [recipientA, recipientB],
          messageBox: 'inbox',
          body: 'hello',
          skipEncryption: true
        },
        host
      )
    ).rejects.toThrow(expected)
  })

  it('rejects malformed advertisement lookup envelopes and outputs without throwing', async () => {
    const instance = client()
    const query = jest.spyOn((instance as any).lookupResolver, 'query')

    await expect(
      instance.queryAdvertisements(recipientA, 'http://private.invalid')
    ).resolves.toEqual([])

    for (const result of [
      null,
      [],
      {},
      { type: 'output-list', outputs: [null] },
      {
        type: 'output-list',
        outputs: [Object.defineProperty({}, 'outputIndex', { get: () => 0 })]
      },
      { type: 'output-list', outputs: [{ outputIndex: -1, beef: [1] }] },
      { type: 'output-list', outputs: [{ outputIndex: 0, beef: [] }] }
    ]) {
      query.mockResolvedValueOnce(result)
      await expect(instance.queryAdvertisements(recipientA)).resolves.toEqual([])
    }
  })

  it('validates permission response status and nullable records', async () => {
    const instance = client()
    const fetch = jest.spyOn(instance.authFetch, 'fetch')
    fetch
      .mockResolvedValueOnce(response({ status: 'error' }))
      .mockResolvedValueOnce(response({ status: 'pending' }))
      .mockResolvedValueOnce(response({ status: 'success', permission: null }))

    const params = { recipient: recipientA, messageBox: 'inbox' }
    await expect(instance.getMessageBoxPermission(params, host)).rejects.toThrow(
      'Failed to get permission'
    )
    await expect(instance.getMessageBoxPermission(params, host)).rejects.toThrow(
      'status is invalid'
    )
    await expect(instance.getMessageBoxPermission(params, host)).resolves.toBeNull()
  })

  it('validates permission fees and batch-payment quote invariants before wallet work', async () => {
    const instance = client()
    await expect(
      instance.setMessageBoxPermission({ messageBox: 'inbox', recipientFee: 1.5 }, host)
    ).rejects.toThrow('recipientFee must be an integer')

    await expect(
      (instance as any).createMessagePaymentBatch([], new Map(), serverIdentity)
    ).rejects.toThrow('1–100 entries')
    await expect(
      (instance as any).createMessagePaymentBatch(
        [recipientA, recipientA],
        new Map([[recipientA, { deliveryFee: 0, recipientFee: 0 }]]),
        serverIdentity
      )
    ).rejects.toThrow('must be unique')
    await expect(
      (instance as any).createMessagePaymentBatch([recipientA], new Map(), serverIdentity)
    ).rejects.toThrow('Missing payment quote')
    await expect(
      (instance as any).createMessagePaymentBatch(
        [recipientA, recipientB],
        new Map([
          [recipientA, { deliveryFee: 1, recipientFee: 0 }],
          [recipientB, { deliveryFee: 2, recipientFee: 0 }]
        ]),
        serverIdentity
      )
    ).rejects.toThrow('consistent delivery fee')
  })

  it('rejects a wallet HMAC that is not exactly 32 bytes', async () => {
    const malformedWallet = wallet()
    ;(malformedWallet.createHmac as jest.Mock).mockResolvedValue({ hmac: Array(31).fill(1) })
    const instance = new MessageBoxClient({ host, walletClient: malformedWallet })

    await expect(instance.sendMessage(sendParams({ messageId: undefined }), host)).rejects.toThrow(
      'Failed to generate message identifier'
    )
  })
})
