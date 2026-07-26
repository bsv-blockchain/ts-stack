import { jest } from '@jest/globals'
import type { WalletInterface } from '@bsv/sdk'
import { MessageBoxClient } from '../MessageBoxClient.js'

const wallet = {
  getPublicKey: jest.fn().mockResolvedValue({
    publicKey: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'
  })
} as unknown as WalletInterface

function jsonResponse(body: unknown, init: Partial<Response> = {}): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    json: async () => body,
    ...init
  } as Response
}

describe('MessageBoxClient permission contract', () => {
  let client: MessageBoxClient
  let fetchMock: jest.SpiedFunction<MessageBoxClient['authFetch']['fetch']>

  beforeEach(() => {
    client = new MessageBoxClient({
      host: 'https://message-box.example/api',
      walletClient: wallet
    })
    fetchMock = jest.spyOn(client.authFetch, 'fetch')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('uses the server messageBox query key and maps camelCase records', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: 'success',
        permissions: [
          {
            sender: null,
            messageBox: 'notifications',
            recipientFee: 0,
            createdAt: '2026-07-26T00:00:00.000Z',
            updatedAt: '2026-07-26T00:00:00.000Z'
          }
        ]
      })
    )

    await expect(
      client.listMessageBoxPermissions({ messageBox: 'notifications', limit: 20, offset: 5 })
    ).resolves.toEqual([
      {
        sender: null,
        messageBox: 'notifications',
        recipientFee: 0,
        status: 'always_allow',
        createdAt: '2026-07-26T00:00:00.000Z',
        updatedAt: '2026-07-26T00:00:00.000Z'
      }
    ])

    expect(fetchMock).toHaveBeenCalledWith(
      'https://message-box.example/api/permissions/list?messageBox=notifications&limit=20&offset=5',
      { method: 'GET' }
    )
  })

  it('accepts legacy snake_case records during server rollouts', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: 'success',
        permissions: [
          {
            sender: 'sender-key',
            message_box: 'inbox',
            recipient_fee: -1,
            created_at: '2026-07-26T00:00:00.000Z',
            updated_at: '2026-07-26T00:00:00.000Z'
          }
        ]
      })
    )

    await expect(client.listMessageBoxPermissions()).resolves.toEqual([
      expect.objectContaining({
        sender: 'sender-key',
        messageBox: 'inbox',
        recipientFee: -1,
        status: 'blocked'
      })
    ])
  })

  it('rejects malformed permission responses', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: 'success',
        permissions: [{ recipientFee: 'free' }]
      })
    )

    await expect(client.listMessageBoxPermissions()).rejects.toThrow(
      'server returned an invalid permission record'
    )
  })

  it('does not send the unused recipient query parameter to the authenticated permission route', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        status: 'success',
        permission: null
      })
    )

    await client.getMessageBoxPermission(
      {
        recipient: '03recipient',
        sender: '02sender',
        messageBox: 'notifications'
      },
      'https://message-box.example/api'
    )

    expect(fetchMock).toHaveBeenCalledWith(
      'https://message-box.example/api/permissions/get?messageBox=notifications&sender=02sender',
      { method: 'GET' }
    )
  })

  it('requires explicit plaintext opt-in for a shared batch', async () => {
    await expect(
      client.sendMessageToRecipients({
        recipients: ['02recipient'],
        messageBox: 'inbox',
        body: 'hello'
      })
    ).rejects.toThrow('Set skipEncryption: true explicitly')
  })

  it('sends multi-recipient notifications as separately encrypted messages', async () => {
    const send = jest
      .spyOn(client, 'sendMessage')
      .mockResolvedValueOnce({ status: 'success', message: 'ok', messageId: 'one' })
      .mockResolvedValueOnce({ status: 'success', message: 'ok', messageId: 'two' })

    await expect(
      client.sendNotification(
        ['02recipient-a', '02recipient-b'],
        { title: 'Hello' },
        'https://message-box.example'
      )
    ).resolves.toMatchObject({
      status: 'success',
      sent: [
        { recipient: '02recipient-a', messageId: 'one' },
        { recipient: '02recipient-b', messageId: 'two' }
      ]
    })

    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenNthCalledWith(
      1,
      {
        recipient: '02recipient-a',
        messageBox: 'notifications',
        body: { title: 'Hello' },
        checkPermissions: true
      },
      'https://message-box.example'
    )
  })

  it('follows bounded message pages for compatibility with the hardened server', async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      messageId: `message-${index}`,
      sender: '02sender',
      body: 'plain'
    }))
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: 'success', messages: firstPage, hasMore: true })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'success',
          messages: [{ messageId: 'message-1000', sender: '02sender', body: 'plain' }],
          hasMore: false
        })
      )

    const messages = await client.listMessagesLite({
      messageBox: 'inbox',
      host: 'https://message-box.example/api'
    })

    expect(messages).toHaveLength(1_001)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
      messageBox: 'inbox',
      limit: 1_000,
      offset: 1_000
    })
  })

  it('does not repeat an exact-size response from a legacy unpaginated server', async () => {
    const legacyMessages = Array.from({ length: 1_000 }, (_, index) => ({
      messageId: `legacy-${index}`,
      sender: '02sender',
      body: 'plain'
    }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: 'success', messages: legacyMessages }))

    await expect(
      client.listMessagesLite({
        messageBox: 'inbox',
        host: 'https://message-box.example/api'
      })
    ).resolves.toHaveLength(1_000)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
