/* eslint-env jest */
import { jest } from '@jest/globals'
import { RemittanceAdapter } from '../RemittanceAdapter.js'
import type { MessageBoxClient } from '../MessageBoxClient.js'

describe('RemittanceAdapter', () => {
  const myIdentityKey = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'
  const senderKey = '03f5d7a10f8ac22f0785a54d7d30fd009a77da27812f4e2f4ac9327dfcb5f65f86'

  it('delegates sendMessage and returns the transport messageId', async () => {
    const messageBox = {
      sendMessage: jest.fn<() => Promise<{ status: string, messageId: string }>>().mockResolvedValue({
        status: 'success',
        messageId: 'http-mid'
      })
    } as unknown as MessageBoxClient

    const adapter = new RemittanceAdapter(messageBox)
    const result = await adapter.sendMessage({
      recipient: senderKey,
      messageBox: 'remittance_inbox',
      body: '{"v":1}'
    }, 'https://override-host')

    expect(result).toBe('http-mid')
    expect(messageBox.sendMessage).toHaveBeenCalledWith({
      recipient: senderKey,
      messageBox: 'remittance_inbox',
      body: '{"v":1}'
    }, 'https://override-host')
  })

  it('delegates sendLiveMessage (live path) and returns the transport messageId', async () => {
    const messageBox = {
      sendLiveMessage: jest.fn<() => Promise<{ status: string, messageId: string }>>().mockResolvedValue({
        status: 'success',
        messageId: 'ws-mid'
      })
    } as unknown as MessageBoxClient

    const adapter = new RemittanceAdapter(messageBox)
    const result = await adapter.sendLiveMessage({
      recipient: senderKey,
      messageBox: 'remittance_inbox',
      body: '{"v":1}'
    }, 'https://override-host')

    expect(result).toBe('ws-mid')
    expect(messageBox.sendLiveMessage).toHaveBeenCalledWith({
      recipient: senderKey,
      messageBox: 'remittance_inbox',
      body: '{"v":1}'
    }, 'https://override-host')
  })

  it('normalizes listMessages shape for remittance and forwards host', async () => {
    const messageBox = {
      getIdentityKey: jest.fn<() => Promise<string>>().mockResolvedValue(myIdentityKey),
      listMessages: jest.fn<() => Promise<any[]>>().mockResolvedValue([
        {
          messageId: 'm1',
          sender: senderKey,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          body: { kind: 'invoice', amount: 1 }
        },
        {
          messageId: 'm2',
          sender: senderKey,
          recipient: '020202020202020202020202020202020202020202020202020202020202020202',
          messageBox: 'custom_box',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          body: '{"kind":"receipt"}'
        }
      ])
    } as unknown as MessageBoxClient

    const adapter = new RemittanceAdapter(messageBox)
    const result = await adapter.listMessages({
      messageBox: 'remittance_inbox',
      host: 'https://remote-host'
    })

    expect(messageBox.listMessages).toHaveBeenCalledWith({
      messageBox: 'remittance_inbox',
      host: 'https://remote-host'
    })
    expect(result).toEqual([
      {
        messageId: 'm1',
        sender: senderKey,
        recipient: myIdentityKey,
        messageBox: 'remittance_inbox',
        body: '{"kind":"invoice","amount":1}'
      },
      {
        messageId: 'm2',
        sender: senderKey,
        recipient: '020202020202020202020202020202020202020202020202020202020202020202',
        messageBox: 'custom_box',
        body: '{"kind":"receipt"}'
      }
    ])
  })

  it('forwards live listener setup and normalizes inbound message shape', async () => {
    const onPaymentMessage = jest.fn()
    let forwardedListener: ((msg: {
      messageId: string
      sender: string
      body: unknown
      created_at: string
      updated_at: string
    }) => void) | undefined

    const messageBox = {
      getIdentityKey: jest.fn<() => Promise<string>>().mockResolvedValue(myIdentityKey),
      listenForLiveMessages: jest.fn().mockImplementation(async ({ onMessage }) => {
        forwardedListener = onMessage
      })
    } as unknown as MessageBoxClient

    const adapter = new RemittanceAdapter(messageBox)
    await adapter.listenForLiveMessages({
      messageBox: 'remittance_inbox',
      overrideHost: 'https://ws-host',
      onMessage: onPaymentMessage
    })

    expect(messageBox.listenForLiveMessages).toHaveBeenCalledWith({
      messageBox: 'remittance_inbox',
      overrideHost: 'https://ws-host',
      onMessage: expect.any(Function)
    })

    forwardedListener?.({
      messageId: 'live-1',
      sender: senderKey,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      body: { kind: 'settlement' }
    })

    expect(onPaymentMessage).toHaveBeenCalledWith({
      messageId: 'live-1',
      sender: senderKey,
      recipient: myIdentityKey,
      messageBox: 'remittance_inbox',
      body: '{"kind":"settlement"}'
    })
  })
})
