import { PeerPayClient } from '@bsv/message-box-client'
import { WalletCore } from '../../core/WalletCore'
import { createTokenMethods } from '../tokens'

jest.mock('@bsv/message-box-client', () => ({
  PeerPayClient: jest.fn()
}))

const listMessages = jest.fn()
const acknowledgeMessage = jest.fn()
const internalizeAction = jest.fn()

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
    jest.mocked(PeerPayClient).mockImplementation(
      () =>
        ({
          listMessages,
          acknowledgeMessage
        }) as any
    )
  })

  it('repairs historical numeric-key transaction objects when listing tokens', async () => {
    listMessages.mockResolvedValue([
      {
        messageId: 'message-1',
        sender: 'fallback-sender',
        created_at: '2026-08-14T00:00:00.000Z',
        body: JSON.stringify({
          sender: 'sender-1',
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
        sender: 'sender-1',
        transaction: [1, 2, 3],
        protocolID: [2, 'tokens'],
        keyID: 'key-1',
        outputIndex: 4,
        createdAt: '2026-08-14T00:00:00.000Z'
      }
    ])
  })

  it('internalizes valid historical bytes before acknowledging the message', async () => {
    internalizeAction.mockResolvedValue({ accepted: true })
    acknowledgeMessage.mockResolvedValue(undefined)
    const methods = createTokenMethods(createCore())

    await expect(
      methods.acceptIncomingToken({
        messageId: 'message-2',
        sender: 'sender-2',
        transaction: { 0: 7, 1: 8, 2: 9 },
        protocolID: [2, 'tokens'],
        keyID: 'key-2',
        outputIndex: 1
      })
    ).resolves.toEqual({
      accepted: true,
      basket: 'received-tokens',
      sender: 'sender-2'
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
                counterparty: 'sender-2'
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

  it.each([
    [{}, 'empty'],
    [{ 0: 1, 2: 3 }, 'sparse'],
    [{ 0: 256 }, 'out-of-range']
  ])('rejects %s transaction bytes before wallet mutation (%s)', async (transaction, _label) => {
    const methods = createTokenMethods(createCore())

    await expect(
      methods.acceptIncomingToken({
        messageId: 'message-invalid',
        sender: 'sender-invalid',
        transaction
      })
    ).rejects.toThrow('Incoming token contains an invalid transaction byte payload')
    expect(internalizeAction).not.toHaveBeenCalled()
    expect(acknowledgeMessage).not.toHaveBeenCalled()
  })
})
