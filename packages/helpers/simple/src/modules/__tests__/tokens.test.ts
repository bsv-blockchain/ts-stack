import { PeerPayClient } from '@bsv/message-box-client'
import {
  LockingScript,
  PushDrop,
  Transaction,
  UnlockingScript,
  completeBoundAction
} from '@bsv/sdk'
import { WalletCore } from '../../core/WalletCore'
import { createTokenMethods } from '../tokens'

jest.mock('@bsv/sdk', () => {
  const actual = jest.requireActual<typeof import('@bsv/sdk')>('@bsv/sdk')
  return { ...actual, completeBoundAction: jest.fn(actual.completeBoundAction) }
})

jest.mock('@bsv/message-box-client', () => ({
  PeerPayClient: jest.fn()
}))

const listMessages = jest.fn()
const acknowledgeMessage = jest.fn()
const sendMessage = jest.fn()
const internalizeAction = jest.fn()
const SENDER = '030dbed53c3613c887ad36e8bde365c2e58f6196735a589cd09d6bc316fa550df4'
const RECIPIENT = '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd'

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

function inboxMessage(
  messageId: string,
  transaction: unknown,
  outputIndex = 0
): Record<string, unknown> {
  return {
    messageId,
    sender: SENDER,
    created_at: '2026-08-14T00:00:00.000Z',
    body: JSON.stringify({
      sender: SENDER,
      transaction,
      protocolID: [2, 'tokens'],
      keyID: messageId === 'message-2' ? 'key-2' : 'token-key',
      outputIndex
    })
  }
}

function createCore(): WalletCore {
  return {
    defaults: {
      messageBoxHost: 'https://messagebox.example',
      tokenBasket: 'received-tokens'
    },
    getClient: jest.fn().mockReturnValue({ internalizeAction }),
    getIdentityKey: jest.fn().mockReturnValue('02'.repeat(33))
  } as unknown as WalletCore
}

describe('MessageBox token byte compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    listMessages.mockReset()
    acknowledgeMessage.mockReset()
    sendMessage.mockReset()
    internalizeAction.mockReset()
    listMessages.mockResolvedValue([])
    acknowledgeMessage.mockResolvedValue(undefined)
    sendMessage.mockResolvedValue(undefined)
    jest.mocked(PeerPayClient).mockImplementation(
      () =>
        ({
          listMessages,
          acknowledgeMessage,
          sendMessage
        }) as any
    )
  })

  it('repairs historical numeric-key transaction objects when listing tokens', async () => {
    listMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        sender: SENDER,
        created_at: '2026-08-14T00:00:00.000Z',
        body: JSON.stringify({
          sender: SENDER,
          transaction: { 0: 1, 1: 2, 2: 3 },
          protocolID: [2, 'tokens'],
          keyID: 'key-1',
          outputIndex: 4
        })
      }
    ])

    const tokens = await createTokenMethods(createCore()).listIncomingTokens()

    expect(tokens).toEqual([
      {
        messageId: 'message-1',
        sender: SENDER,
        transaction: [1, 2, 3],
        protocolID: [2, 'tokens'],
        keyID: 'key-1',
        outputIndex: 4,
        createdAt: '2026-08-14T00:00:00.000Z'
      }
    ])
    expect(listMessages).toHaveBeenCalledWith({
      messageBox: 'simple_token_inbox',
      limit: 1000,
      pageSize: 100,
      maxPages: 10
    })
  })

  it('does not let a message body replace its authenticated envelope sender', async () => {
    listMessages.mockResolvedValue([
      {
        messageId: 'message-spoofed',
        sender: SENDER,
        created_at: '2026-08-14T00:00:00.000Z',
        body: JSON.stringify({
          sender: '02ca066fa6b7557188b0a4013ad44e7b4a32e2f5e32fbd8d460b9f49caa0b275bd',
          transaction: [1, 2, 3],
          protocolID: [2, 'tokens'],
          keyID: 'token-key'
        })
      }
    ])

    await expect(createTokenMethods(createCore()).listIncomingTokens()).resolves.toEqual([])
    expect(acknowledgeMessage).not.toHaveBeenCalled()
  })

  it('internalizes valid historical bytes before acknowledging the message', async () => {
    listMessages.mockResolvedValue([inboxMessage('message-2', { 0: 7, 1: 8, 2: 9 }, 1)])
    internalizeAction.mockResolvedValue({ accepted: true })
    acknowledgeMessage.mockResolvedValue(undefined)
    const methods = createTokenMethods(createCore())

    await expect(
      methods.acceptIncomingToken({
        messageId: 'message-2',
        sender: SENDER,
        transaction: { 0: 7, 1: 8, 2: 9 },
        protocolID: [2, 'tokens'],
        keyID: 'key-2',
        outputIndex: 1
      })
    ).resolves.toEqual({
      accepted: true,
      basket: 'received-tokens',
      sender: SENDER
    })

    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: [7, 8, 9],
        outputs: [
          expect.objectContaining({
            outputIndex: 1,
            insertionRemittance: expect.objectContaining({
              basket: 'received-tokens',
              customInstructions: JSON.stringify({
                protocolID: [2, 'tokens'],
                keyID: 'key-2',
                counterparty: SENDER
              })
            })
          })
        ]
      })
    )
    expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['message-2'] })
    expect(internalizeAction.mock.invocationCallOrder[0]).toBeLessThan(
      acknowledgeMessage.mock.invocationCallOrder[0]
    )
  })

  it('preserves the message when the wallet returns a negative internalization verdict', async () => {
    listMessages.mockResolvedValue([inboxMessage('message-rejected', [1, 2, 3])])
    internalizeAction.mockResolvedValue({ accepted: false })
    const methods = createTokenMethods(createCore())

    await expect(
      methods.acceptIncomingToken({
        messageId: 'message-rejected',
        sender: SENDER,
        transaction: [1, 2, 3],
        protocolID: [2, 'tokens'],
        keyID: 'token-key'
      })
    ).rejects.toThrow('Receiving wallet did not accept the token')
    expect(acknowledgeMessage).not.toHaveBeenCalled()
  })

  it('uses the fresh authenticated inbox record and contains a post-internalization ack failure', async () => {
    listMessages.mockResolvedValue([inboxMessage('message-fresh', [9, 8, 7], 2)])
    internalizeAction.mockResolvedValue({ accepted: true })
    acknowledgeMessage.mockRejectedValue(new Error('temporary ack failure'))

    await expect(
      createTokenMethods(createCore()).acceptIncomingToken({
        messageId: 'message-fresh',
        sender: 'attacker-selected',
        transaction: [1],
        outputIndex: 0
      })
    ).resolves.toMatchObject({ accepted: true, sender: SENDER })
    expect(internalizeAction).toHaveBeenCalledWith(
      expect.objectContaining({
        tx: [9, 8, 7],
        outputs: [expect.objectContaining({ outputIndex: 2 })]
      })
    )
    expect(acknowledgeMessage).toHaveBeenCalledWith({ messageIds: ['message-fresh'] })
  })

  it.each([
    [{}, 'empty'],
    [{ 0: 1, 2: 3 }, 'sparse'],
    [{ 0: 256 }, 'out-of-range']
  ])('rejects %s transaction bytes before wallet mutation (%s)', async (transaction, _label) => {
    listMessages.mockResolvedValue([inboxMessage('message-invalid', transaction)])
    const methods = createTokenMethods(createCore())

    await expect(
      methods.acceptIncomingToken({
        messageId: 'message-invalid',
        sender: SENDER,
        transaction,
        protocolID: [2, 'tokens'],
        keyID: 'token-key'
      })
    ).rejects.toThrow('not present exactly once in the authenticated inbox')
    expect(internalizeAction).not.toHaveBeenCalled()
    expect(acknowledgeMessage).not.toHaveBeenCalled()
  })

  it('binds token signing to the requested outpoint and reports the actual recipient output', async () => {
    const sourceScript = LockingScript.fromHex('51')
    const sourceTx = new Transaction(1, [], [{ satoshis: 42, lockingScript: sourceScript }], 0)
    const outpoint = `${sourceTx.id('hex')}.0`
    const tokenScript = LockingScript.fromHex('52')
    const client = {
      listOutputs: jest.fn().mockResolvedValue({
        totalOutputs: 1,
        outputs: [
          {
            outpoint,
            satoshis: 42,
            spendable: true,
            customInstructions: JSON.stringify({
              protocolID: [2, 'tokens'],
              keyID: 'token-key',
              counterparty: 'self'
            })
          }
        ],
        BEEF: sourceTx.toBEEF()
      })
    }
    const core = {
      defaults: {
        messageBoxHost: 'https://messagebox.example',
        tokenBasket: 'tokens',
        tokenProtocolID: [2, 'tokens'],
        tokenKeyID: 'default-token-key'
      },
      getClient: jest.fn(() => client),
      getIdentityKey: jest.fn(() => SENDER)
    } as unknown as WalletCore
    jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields: [[1, 2, 3]] } as any)
    jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(tokenScript)
    const signed = {
      id: jest.fn(() => 'b'.repeat(64)),
      toAtomicBEEF: jest.fn(() => [4, 5, 6]),
      outputs: [
        { satoshis: 100, lockingScript: LockingScript.fromHex('53') },
        { satoshis: 42, lockingScript: tokenScript }
      ]
    } as unknown as Transaction
    jest.mocked(completeBoundAction).mockResolvedValueOnce(signed)

    await createTokenMethods(core).sendTokenViaMessageBox({
      basket: 'tokens',
      outpoint,
      to: SENDER
    })

    const [, createArgs, options] = jest.mocked(completeBoundAction).mock.calls[0]
    expect(createArgs.inputs).toEqual([expect.objectContaining({ outpoint })])
    expect(Object.keys(options?.inputSigners ?? {})).toEqual([outpoint])
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining('"outputIndex":1')
      })
    )
    expect(createArgs.outputs).toEqual([expect.objectContaining({ satoshis: 42 })])

    sendMessage.mockRejectedValueOnce(new Error('offline'))
    jest.mocked(completeBoundAction).mockResolvedValueOnce(signed)
    await expect(
      createTokenMethods(core).sendTokenViaMessageBox({
        basket: 'tokens',
        outpoint,
        to: SENDER
      })
    ).rejects.toThrow(
      `Token transaction ${'b'.repeat(64)} completed but MessageBox delivery failed; do not retry`
    )
  })

  it('uses the requested recipient for token encryption and locking', async () => {
    const tokenScript = LockingScript.fromHex('51')
    const client = {
      encrypt: jest.fn().mockResolvedValue({ ciphertext: [7, 8, 9] }),
      createAction: jest.fn().mockImplementation(async args => completedAction(args))
    }
    const core = {
      defaults: {
        tokenBasket: 'tokens',
        tokenProtocolID: [2, 'tokens'],
        tokenKeyID: 'token-key'
      },
      getClient: jest.fn(() => client),
      getIdentityKey: jest.fn(() => SENDER)
    } as unknown as WalletCore
    const lock = jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(tokenScript)

    await expect(
      createTokenMethods(core).createToken({ data: { role: 'member' }, to: RECIPIENT })
    ).resolves.toMatchObject({ txid: expect.stringMatching(/^[0-9a-f]{64}$/) })

    expect(client.encrypt).toHaveBeenCalledWith(
      expect.objectContaining({ counterparty: RECIPIENT })
    )
    expect(lock).toHaveBeenCalledWith(
      [[7, 8, 9]],
      [2, 'tokens'],
      'token-key',
      RECIPIENT,
      false,
      false
    )
    expect(client.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [
          expect.objectContaining({
            customInstructions: expect.stringContaining(`"counterparty":"${RECIPIENT}"`)
          })
        ]
      })
    )
  })

  it('ignores inherited recipient, satoshi, and basket token options', async () => {
    const tokenScript = LockingScript.fromHex('51')
    const client = {
      encrypt: jest.fn().mockResolvedValue({ ciphertext: [7, 8, 9] }),
      createAction: jest.fn().mockImplementation(async args => completedAction(args))
    }
    const core = {
      defaults: {
        tokenBasket: 'tokens',
        tokenProtocolID: [2, 'tokens'],
        tokenKeyID: 'token-key'
      },
      getClient: jest.fn(() => client),
      getIdentityKey: jest.fn(() => SENDER)
    } as unknown as WalletCore
    const lock = jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue(tokenScript)
    const inherited = {
      to: RECIPIENT,
      satoshis: 42,
      basket: 'ambient-basket'
    }
    const previous = new Map(
      Object.keys(inherited).map(key => [
        key,
        Object.getOwnPropertyDescriptor(Object.prototype, key)
      ])
    )

    let result:
      Awaited<ReturnType<ReturnType<typeof createTokenMethods>['createToken']>> | undefined
    try {
      for (const [key, value] of Object.entries(inherited)) {
        Object.defineProperty(Object.prototype, key, {
          value,
          configurable: true,
          enumerable: false,
          writable: true
        })
      }
      result = await createTokenMethods(core).createToken({ data: 'owned-data' })
    } finally {
      for (const [key, descriptor] of previous) {
        if (descriptor == null) Reflect.deleteProperty(Object.prototype, key)
        else Object.defineProperty(Object.prototype, key, descriptor)
      }
    }

    expect(result).toMatchObject({ basket: 'tokens' })
    expect(client.encrypt).toHaveBeenCalledWith(expect.objectContaining({ counterparty: 'self' }))
    expect(lock).toHaveBeenCalledWith([[7, 8, 9]], [2, 'tokens'], 'token-key', 'self', true, false)
    expect(client.createAction).toHaveBeenCalledWith(
      expect.objectContaining({
        outputs: [expect.objectContaining({ basket: 'tokens', satoshis: 1 })]
      })
    )
  })

  it('rejects inherited or accessor-backed token protocol tuples without invoking accessors', async () => {
    const client = {
      encrypt: jest.fn(),
      createAction: jest.fn()
    }
    const core = {
      defaults: {
        tokenBasket: 'tokens',
        tokenProtocolID: [2, 'tokens'],
        tokenKeyID: 'token-key'
      },
      getClient: jest.fn(() => client),
      getIdentityKey: jest.fn(() => SENDER)
    } as unknown as WalletCore
    const methods = createTokenMethods(core)

    const inheritedProtocol = [] as unknown as [number, string]
    inheritedProtocol.length = 2
    inheritedProtocol[1] = 'tokens'
    Object.setPrototypeOf(
      inheritedProtocol,
      Object.assign(Object.create(Array.prototype), { 0: 2 })
    )
    await expect(
      methods.createToken({ data: 'owned-data', protocolID: inheritedProtocol })
    ).rejects.toThrow('Token protocol ID is invalid')

    const getter = jest.fn(() => 2)
    const accessorProtocol = [] as unknown as [number, string]
    accessorProtocol.length = 2
    Object.defineProperty(accessorProtocol, '0', { enumerable: true, get: getter })
    accessorProtocol[1] = 'tokens'
    await expect(
      methods.createToken({ data: 'owned-data', protocolID: accessorProtocol })
    ).rejects.toThrow('Token protocol ID is invalid')

    expect(getter).not.toHaveBeenCalled()
    expect(client.encrypt).not.toHaveBeenCalled()
    expect(client.createAction).not.toHaveBeenCalled()
  })

  it('paginates and validates the complete token inventory', async () => {
    const client = {
      listOutputs: jest
        .fn()
        .mockResolvedValueOnce({
          totalOutputs: 2,
          outputs: [
            { outpoint: `${'1'.repeat(64)}.0`, satoshis: 1, spendable: true, lockingScript: '51' }
          ]
        })
        .mockResolvedValueOnce({
          totalOutputs: 2,
          outputs: [
            { outpoint: `${'2'.repeat(64)}.0`, satoshis: 2, spendable: true, lockingScript: '51' }
          ]
        }),
      decrypt: jest.fn().mockResolvedValue({ plaintext: [123, 125] })
    }
    const core = {
      defaults: {
        tokenBasket: 'tokens',
        tokenProtocolID: [2, 'tokens'],
        tokenKeyID: 'token-key'
      },
      getClient: jest.fn(() => client)
    } as unknown as WalletCore
    const decode = jest.spyOn(PushDrop, 'decode').mockReturnValue({ fields: [[1, 2, 3]] } as any)

    await expect(createTokenMethods(core).listTokenDetails()).resolves.toHaveLength(2)
    expect(client.listOutputs).toHaveBeenNthCalledWith(2, {
      basket: 'tokens',
      include: 'locking scripts',
      includeCustomInstructions: true,
      limit: 1000,
      offset: 1
    })
    expect(decode).toHaveBeenCalledTimes(2)
  })

  it('rejects missing, invalid, or excessive token data before wallet mutation', async () => {
    const client = {
      encrypt: jest.fn(),
      createAction: jest.fn()
    }
    const core = {
      defaults: {
        tokenBasket: 'tokens',
        tokenProtocolID: [2, 'tokens'],
        tokenKeyID: 'token-key'
      },
      getClient: jest.fn(() => client),
      getIdentityKey: jest.fn(() => SENDER)
    } as unknown as WalletCore
    const methods = createTokenMethods(core)

    await expect(methods.createToken({ data: undefined })).rejects.toThrow('data is required')
    await expect(methods.createToken({ data: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow(
      '1 MiB safety limit'
    )
    await expect(methods.createToken({ data: 'ok', satoshis: Number.NaN })).rejects.toThrow(
      'valid number of satoshis'
    )
    expect(client.encrypt).not.toHaveBeenCalled()
    expect(client.createAction).not.toHaveBeenCalled()
  })
})
