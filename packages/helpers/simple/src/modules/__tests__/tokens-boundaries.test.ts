import { PeerPayClient } from '@bsv/message-box-client'
import {
  LockingScript,
  PushDrop,
  Transaction,
  completeBoundAction,
  type WalletOutput
} from '@bsv/sdk'
import { WalletCore } from '../../core/WalletCore'
import { createTokenMethods } from '../tokens'

jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual<typeof import('@bsv/sdk')>('@bsv/sdk')
  return { ...actual, completeBoundAction: jest.fn(actual.completeBoundAction) }
})

jest.mock('@bsv/message-box-client', () => ({ PeerPayClient: jest.fn() }))

const SENDER = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const RECIPIENT = '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd'

function tokenFixture(overrides: Partial<WalletOutput> = {}): {
  source: Transaction
  outpoint: string
  output: WalletOutput
} {
  const source = new Transaction(
    1,
    [],
    [{ satoshis: 42, lockingScript: LockingScript.fromASM('OP_TRUE') }],
    0
  )
  const outpoint = `${source.id('hex')}.0`
  return {
    source,
    outpoint,
    output: {
      outpoint,
      satoshis: 42,
      spendable: true,
      lockingScript: source.outputs[0].lockingScript.toHex(),
      customInstructions: JSON.stringify({
        protocolID: [2, 'tokens'],
        keyID: 'token-key',
        counterparty: 'self'
      }),
      ...overrides
    }
  }
}

function coreWithClient(client: Record<string, jest.Mock>): WalletCore {
  return {
    defaults: {
      tokenBasket: 'tokens',
      tokenProtocolID: [2, 'tokens'],
      tokenKeyID: 'token-key',
      messageBoxHost: 'https://messagebox.example'
    },
    getClient: jest.fn(() => client),
    getIdentityKey: jest.fn(() => SENDER)
  } as unknown as WalletCore
}

describe('token transaction and inventory boundaries', () => {
  beforeEach(() => {
    jest.mocked(PeerPayClient).mockReset()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    jest.clearAllMocks()
  })

  it('binds a direct send to the selected outpoint and preserves its value and fields', async () => {
    const { source, outpoint, output } = tokenFixture()
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        totalOutputs: 1,
        outputs: [output],
        BEEF: source.toBEEF()
      })
    }
    const destination = LockingScript.fromASM('OP_TRUE OP_TRUE')
    jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields: [[1, 2, 3], [4]] } as any)
    const lock = jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(destination)
    const signed = {
      id: jest.fn(() => 'b'.repeat(64)),
      toAtomicBEEF: jest.fn(() => [9, 8, 7])
    } as unknown as Transaction
    jest.mocked(completeBoundAction).mockResolvedValueOnce(signed)

    await expect(
      createTokenMethods(coreWithClient(client)).sendToken({
        basket: 'tokens',
        outpoint,
        to: RECIPIENT
      })
    ).resolves.toEqual({ txid: 'b'.repeat(64), tx: [9, 8, 7] })

    const [, args, options] = jest.mocked(completeBoundAction).mock.calls[0]
    expect(args.inputs).toEqual([expect.objectContaining({ outpoint })])
    expect(args.outputs).toEqual([
      expect.objectContaining({ satoshis: 42, lockingScript: destination.toHex() })
    ])
    expect(Object.keys(options?.inputSigners ?? {})).toEqual([outpoint])
    expect(lock).toHaveBeenCalledWith(
      [[1, 2, 3], [4]],
      [2, 'tokens'],
      expect.any(String),
      RECIPIENT,
      false,
      false
    )
  })

  it('binds redemption to one spendable output and creates no replacement output', async () => {
    const { source, outpoint, output } = tokenFixture()
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        totalOutputs: 1,
        outputs: [output],
        BEEF: source.toBEEF()
      })
    }
    const signed = {
      id: jest.fn(() => 'c'.repeat(64)),
      toAtomicBEEF: jest.fn(() => [1, 2, 3])
    } as unknown as Transaction
    jest.mocked(completeBoundAction).mockResolvedValueOnce(signed)

    await expect(
      createTokenMethods(coreWithClient(client)).redeemToken({ basket: 'tokens', outpoint })
    ).resolves.toEqual({ txid: 'c'.repeat(64), tx: [1, 2, 3] })

    const [, args, options] = jest.mocked(completeBoundAction).mock.calls[0]
    expect(args).toMatchObject({ inputs: [{ outpoint }], outputs: [] })
    expect(Object.keys(options?.inputSigners ?? {})).toEqual([outpoint])
  })

  it.each([
    {
      name: 'excessive declared total',
      replies: [{ totalOutputs: 10_001, outputs: [] }],
      error: '10000-output safety limit'
    },
    {
      name: 'changing total',
      replies: [
        { totalOutputs: 2, outputs: [tokenFixture().output] },
        { totalOutputs: 1, outputs: [tokenFixture().output] }
      ],
      error: 'changed while it was being read'
    },
    {
      name: 'incomplete page',
      replies: [{ totalOutputs: 1, outputs: [] }],
      error: 'incomplete token page'
    },
    {
      name: 'more records than declared',
      replies: [{ totalOutputs: 1, outputs: [tokenFixture().output, tokenFixture().output] }],
      error: 'expected at least 2'
    },
    {
      name: 'duplicate outpoint across pages',
      replies: [
        { totalOutputs: 2, outputs: [tokenFixture().output] },
        { totalOutputs: 2, outputs: [tokenFixture().output] }
      ],
      error: 'duplicate token output'
    }
  ])('rejects a $name wallet inventory', async ({ replies, error }) => {
    const client = { listOutputs: jest.fn() }
    for (const reply of replies) client.listOutputs.mockResolvedValueOnce(reply)

    await expect(createTokenMethods(coreWithClient(client)).listTokenDetails()).rejects.toThrow(
      error
    )
  })

  it('uses validated defaults and falls back from self to anyone decryption', async () => {
    const { output } = tokenFixture({ customInstructions: undefined })
    const client = {
      listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 1, outputs: [output] }),
      decrypt: jest
        .fn()
        .mockRejectedValueOnce(new Error('not self encrypted'))
        .mockResolvedValueOnce({
          plaintext: Array.from(new TextEncoder().encode('{"role":"member"}'))
        })
    }
    jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields: [[1, 2, 3]] } as any)

    await expect(createTokenMethods(coreWithClient(client)).listTokenDetails()).resolves.toEqual([
      expect.objectContaining({ data: { role: 'member' }, counterparty: 'self' })
    ])
    expect(client.decrypt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ counterparty: 'anyone' })
    )
  })

  it.each([
    ['non-JSON instructions', '{'],
    ['non-record instructions', '[]'],
    ['oversized instructions', 'x'.repeat(4097)]
  ])('skips outputs with %s', async (_name, customInstructions) => {
    const { output } = tokenFixture({ customInstructions })
    const client = {
      listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 1, outputs: [output] }),
      decrypt: jest.fn()
    }
    jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields: [[1]] } as any)

    await expect(createTokenMethods(coreWithClient(client)).listTokenDetails()).resolves.toEqual([])
    expect(client.decrypt).not.toHaveBeenCalled()
  })

  it.each([
    ['no fields', []],
    ['too many fields', Array.from({ length: 257 }, () => [1])],
    ['empty first field', [[]]],
    ['invalid byte field', [[256]]]
  ])('skips a decoded token with %s', async (_name, fields) => {
    const { output } = tokenFixture()
    const client = {
      listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 1, outputs: [output] }),
      decrypt: jest.fn()
    }
    jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields } as any)

    await expect(createTokenMethods(coreWithClient(client)).listTokenDetails()).resolves.toEqual([])
    expect(client.decrypt).not.toHaveBeenCalled()
  })

  it('requires the signed MessageBox transaction to contain exactly one destination token', async () => {
    const { source, outpoint, output } = tokenFixture()
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        totalOutputs: 1,
        outputs: [output],
        BEEF: source.toBEEF()
      })
    }
    const destination = LockingScript.fromASM('OP_TRUE OP_TRUE')
    jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields: [[1]] } as any)
    jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(destination)
    const signed = {
      id: jest.fn(() => 'd'.repeat(64)),
      toAtomicBEEF: jest.fn(() => [1]),
      outputs: [
        { satoshis: 42, lockingScript: destination },
        { satoshis: 42, lockingScript: destination }
      ]
    } as unknown as Transaction
    jest.mocked(completeBoundAction).mockResolvedValueOnce(signed)
    jest.mocked(PeerPayClient).mockImplementation(() => ({ sendMessage: jest.fn() }) as any)

    await expect(
      createTokenMethods(coreWithClient(client)).sendTokenViaMessageBox({
        basket: 'tokens',
        outpoint,
        to: RECIPIENT
      })
    ).rejects.toThrow('does not uniquely contain the recipient token')
  })

  it('bounds the authenticated inbox collection before parsing messages', async () => {
    const listMessages = jest.fn().mockResolvedValue(Array.from({ length: 1001 }, () => null))
    jest.mocked(PeerPayClient).mockImplementation(() => ({ listMessages }) as any)

    await expect(createTokenMethods(coreWithClient({})).listIncomingTokens()).rejects.toThrow(
      'exceeds the configured limit'
    )
  })

  it('filters malformed inbox envelopes without invoking accessors or wallet mutation', async () => {
    const getter = jest.fn(() => SENDER)
    const accessorEnvelope: Record<string, unknown> = {}
    Object.defineProperty(accessorEnvelope, 'sender', { enumerable: true, get: getter })
    const invalidCurveKey = `02${'f'.repeat(64)}`
    const otherwiseValid = {
      messageId: 'valid-id',
      sender: SENDER,
      created_at: '2026-09-21T00:00:00.000Z',
      body: JSON.stringify({
        transaction: [1],
        protocolID: [2, 'tokens'],
        keyID: 'token-key'
      })
    }
    const listMessages = jest.fn().mockResolvedValue([
      null,
      accessorEnvelope,
      { ...otherwiseValid, body: '{' },
      { ...otherwiseValid, body: [] },
      { ...otherwiseValid, messageId: '' },
      { ...otherwiseValid, sender: invalidCurveKey },
      {
        ...otherwiseValid,
        body: JSON.stringify({ transaction: [], protocolID: [2, 'tokens'], keyID: 'token-key' })
      },
      {
        ...otherwiseValid,
        body: JSON.stringify({
          transaction: [1],
          protocolID: [2, 'tokens'],
          keyID: 'token-key',
          outputIndex: -1
        })
      },
      { ...otherwiseValid, created_at: 'x'.repeat(65) }
    ])
    jest.mocked(PeerPayClient).mockImplementation(() => ({ listMessages }) as any)

    await expect(createTokenMethods(coreWithClient({})).listIncomingTokens()).resolves.toEqual([])
    expect(getter).not.toHaveBeenCalled()
  })

  it('rejects hostile accept arguments before consulting the authenticated inbox', async () => {
    const getter = jest.fn(() => 'message-id')
    const accessorToken: Record<string, unknown> = {}
    Object.defineProperty(accessorToken, 'messageId', { enumerable: true, get: getter })
    const inherited = Object.create({ messageId: 'message-id' })
    const listMessages = jest.fn()
    jest.mocked(PeerPayClient).mockImplementation(() => ({ listMessages }) as any)
    const methods = createTokenMethods(coreWithClient({}))

    await expect(methods.acceptIncomingToken(accessorToken)).rejects.toThrow(
      'Incoming token is invalid'
    )
    await expect(methods.acceptIncomingToken(inherited)).rejects.toThrow(
      'Incoming token is invalid'
    )

    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'messageId')
    let pollutedError: unknown
    try {
      Object.defineProperty(Object.prototype, 'messageId', {
        value: 'message-id',
        configurable: true,
        enumerable: false,
        writable: true
      })
      try {
        await methods.acceptIncomingToken({})
      } catch (error) {
        pollutedError = error
      }
    } finally {
      if (previous == null) Reflect.deleteProperty(Object.prototype, 'messageId')
      else Object.defineProperty(Object.prototype, 'messageId', previous)
    }

    expect(pollutedError).toBeInstanceOf(Error)
    expect((pollutedError as Error).message).toContain('message ID is invalid')
    expect(getter).not.toHaveBeenCalled()
    expect(listMessages).not.toHaveBeenCalled()
  })

  it('rejects unserializable token data and malformed creation options before encryption', async () => {
    const client = { encrypt: jest.fn(), createAction: jest.fn() }
    const methods = createTokenMethods(coreWithClient(client))
    const circular: Record<string, unknown> = {}
    circular.self = circular

    await expect(methods.createToken(null as any)).rejects.toThrow('options must be an object')
    await expect(methods.createToken([] as any)).rejects.toThrow('options must be an object')
    await expect(methods.createToken({ data: circular })).rejects.toThrow('JSON serializable')
    await expect(methods.createToken({ data: 'ok', to: 'not-a-public-key' })).rejects.toThrow(
      'Token recipient is invalid'
    )
    expect(client.encrypt).not.toHaveBeenCalled()
  })

  it.each(['sendToken', 'redeemToken', 'sendTokenViaMessageBox'] as const)(
    'does not source %s transfer fields from Object.prototype',
    async method => {
      const { outpoint } = tokenFixture()
      const inherited = { basket: 'tokens', outpoint, to: RECIPIENT }
      const previous = new Map(
        Object.keys(inherited).map(key => [
          key,
          Object.getOwnPropertyDescriptor(Object.prototype, key)
        ])
      )
      const client = { listOutputs: jest.fn() }
      let error: unknown

      try {
        for (const [key, value] of Object.entries(inherited)) {
          Object.defineProperty(Object.prototype, key, {
            value,
            configurable: true,
            enumerable: false,
            writable: true
          })
        }
        try {
          await (createTokenMethods(coreWithClient(client))[method] as any)({})
        } catch (caught) {
          error = caught
        }
      } finally {
        for (const [key, descriptor] of previous) {
          if (descriptor == null) Reflect.deleteProperty(Object.prototype, key)
          else Object.defineProperty(Object.prototype, key, descriptor)
        }
      }

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('Token basket is invalid')
      expect(client.listOutputs).not.toHaveBeenCalled()
    }
  )

  it.each(['sendToken', 'sendTokenViaMessageBox'] as const)(
    'does not source the %s recipient from Object.prototype',
    async method => {
      const { outpoint } = tokenFixture()
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'to')
      const client = { listOutputs: jest.fn() }
      let error: unknown
      try {
        Object.defineProperty(Object.prototype, 'to', {
          value: RECIPIENT,
          configurable: true,
          enumerable: false,
          writable: true
        })
        try {
          await (createTokenMethods(coreWithClient(client))[method] as any)({
            basket: 'tokens',
            outpoint
          })
        } catch (caught) {
          error = caught
        }
      } finally {
        if (previous == null) Reflect.deleteProperty(Object.prototype, 'to')
        else Object.defineProperty(Object.prototype, 'to', previous)
      }

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('Token recipient is invalid')
      expect(client.listOutputs).not.toHaveBeenCalled()
    }
  )

  it.each(['sendToken', 'redeemToken', 'sendTokenViaMessageBox'] as const)(
    'does not source the %s outpoint from Object.prototype',
    async method => {
      const { outpoint } = tokenFixture()
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'outpoint')
      const client = { listOutputs: jest.fn() }
      let error: unknown
      try {
        Object.defineProperty(Object.prototype, 'outpoint', {
          value: outpoint,
          configurable: true,
          enumerable: false,
          writable: true
        })
        try {
          await (createTokenMethods(coreWithClient(client))[method] as any)({
            basket: 'tokens',
            ...(method === 'redeemToken' ? {} : { to: RECIPIENT })
          })
        } catch (caught) {
          error = caught
        }
      } finally {
        if (previous == null) Reflect.deleteProperty(Object.prototype, 'outpoint')
        else Object.defineProperty(Object.prototype, 'outpoint', previous)
      }

      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('Token outpoint is invalid')
      expect(client.listOutputs).not.toHaveBeenCalled()
    }
  )

  it('returns null without a legacy retry when recipient-bound decryption fails', async () => {
    const { output } = tokenFixture({
      customInstructions: JSON.stringify({
        protocolID: [2, 'tokens'],
        keyID: 'token-key',
        counterparty: RECIPIENT
      })
    })
    const client = {
      listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 1, outputs: [output] }),
      decrypt: jest.fn().mockRejectedValue(new Error('wrong recipient'))
    }
    jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields: [[1]] } as any)

    await expect(createTokenMethods(coreWithClient(client)).listTokenDetails()).resolves.toEqual([
      expect.objectContaining({ data: null, counterparty: RECIPIENT })
    ])
    expect(client.decrypt).toHaveBeenCalledTimes(1)
  })

  it('returns null when both self and legacy-anyone decryption fail', async () => {
    const { output } = tokenFixture()
    const client = {
      listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 1, outputs: [output] }),
      decrypt: jest.fn().mockRejectedValue(new Error('not decryptable'))
    }
    jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields: [[1]] } as any)

    await expect(createTokenMethods(coreWithClient(client)).listTokenDetails()).resolves.toEqual([
      expect.objectContaining({ data: null })
    ])
    expect(client.decrypt).toHaveBeenCalledTimes(2)
  })

  it('bounds the aggregate decoded field bytes before attempting decryption', async () => {
    const { output } = tokenFixture()
    const client = {
      listOutputs: jest.fn().mockResolvedValue({ totalOutputs: 1, outputs: [output] }),
      decrypt: jest.fn()
    }
    jest
      .spyOn(PushDrop, 'decode')
      .mockReturnValue({ fields: [new Uint8Array(1024 * 1024), [1]] } as any)

    await expect(createTokenMethods(coreWithClient(client)).listTokenDetails()).resolves.toEqual([])
    expect(client.decrypt).not.toHaveBeenCalled()
  })

  it.each(['sendToken', 'redeemToken', 'sendTokenViaMessageBox'] as const)(
    'rejects missing, evidence-free, and spent outputs in %s',
    async method => {
      const { source, outpoint, output } = tokenFixture()
      const options = { basket: 'tokens', outpoint, to: RECIPIENT }

      for (const [reply, error] of [
        [{ totalOutputs: 0, outputs: [] }, 'not found exactly once'],
        [
          { totalOutputs: 1, outputs: [output] },
          'expected the requested complete output transactions'
        ],
        [
          {
            totalOutputs: 1,
            outputs: [{ ...output, spendable: false }],
            BEEF: source.toBEEF()
          },
          'not spendable'
        ]
      ] as const) {
        const client = { listOutputs: jest.fn().mockResolvedValue(reply) }
        await expect(
          (createTokenMethods(coreWithClient(client))[method] as any)(options)
        ).rejects.toThrow(error)
      }
    }
  )

  it('uses self encryption semantics when sending a token back to the same wallet', async () => {
    const { source, outpoint, output } = tokenFixture({ tags: ['owned'], labels: ['token'] })
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        totalOutputs: 1,
        outputs: [output],
        BEEF: source.toBEEF()
      })
    }
    const destination = LockingScript.fromASM('OP_TRUE OP_TRUE')
    jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields: [[1]] } as any)
    const lock = jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(destination)
    jest.mocked(completeBoundAction).mockResolvedValueOnce({
      id: jest.fn(() => 'e'.repeat(64)),
      toAtomicBEEF: jest.fn(() => [1])
    } as unknown as Transaction)

    await createTokenMethods(coreWithClient(client)).sendToken({
      basket: 'tokens',
      outpoint,
      to: SENDER
    })

    expect(lock).toHaveBeenCalledWith([[1]], [2, 'tokens'], expect.any(String), 'self', true, false)
    expect(jest.mocked(completeBoundAction).mock.calls[0][1].outputs).toEqual([
      expect.objectContaining({
        customInstructions: expect.stringContaining('"counterparty":"self"')
      })
    ])
  })
})
