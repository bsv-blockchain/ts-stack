/* eslint-env jest */
import { MessageBoxClient } from '../MessageBoxClient.js'
import { WalletClient, AuthFetch, Transaction, LockingScript, PushDrop, TopicBroadcaster, Beef } from '@bsv/sdk'

// MOCK: WalletClient methods globally
jest.spyOn(WalletClient.prototype, 'createHmac').mockResolvedValue({
  hmac: Array.from(new Uint8Array([1, 2, 3]))
})

jest.spyOn(WalletClient.prototype, 'getPublicKey').mockResolvedValue({
  publicKey: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'
})

jest.spyOn(WalletClient.prototype, 'encrypt').mockResolvedValue({
  ciphertext: [9, 9, 9, 9]
})

jest.spyOn(WalletClient.prototype, 'decrypt').mockResolvedValue({
  plaintext: [1, 2, 3, 4, 5]
})

jest.spyOn(WalletClient.prototype, 'createSignature').mockResolvedValue({
  signature: [1, 2, 3, 4, 5] // <-- any dummy byte array
})

jest.spyOn(WalletClient.prototype, 'connectToSubstrate').mockImplementation(async function () {
  this.substrate = {
    createSignature: async (message: Uint8Array) => {
      return Array.from(new Uint8Array([1, 2, 3])) // Return mock signature
    }
  }
})

const minimalTx = new Transaction()
minimalTx.addOutput({
  satoshis: 1,
  lockingScript: new LockingScript([]) // ✅ must wrap in LockingScript class
})

const realAtomicBEEF = minimalTx.toAtomicBEEF()

jest.spyOn(WalletClient.prototype, 'createAction').mockResolvedValue({
  txid: 'mocked-txid',
  tx: realAtomicBEEF
})

// MOCK: AuthFetch responses
const defaultMockResponse: Partial<Response> = {
  json: async () => ({ status: 'success', message: 'Mocked response' }),
  headers: new Headers(),
  ok: true,
  status: 200
}

jest.spyOn(MessageBoxClient.prototype as any, 'anointHost').mockImplementation(async () => {
  return { txid: 'mocked-anoint-txid' }
})

jest.spyOn(MessageBoxClient.prototype as any, 'queryAdvertisements')
  .mockResolvedValue([] as string[])

jest.spyOn(AuthFetch.prototype, 'fetch')
  .mockResolvedValue(defaultMockResponse as Response)

// MOCK: WebSocket behavior
const socketOnMap: Record<string, (...args: any[]) => void> = {}

const mockSocket = {
  on: jest.fn((event, callback) => {
    socketOnMap[event] = callback
  }),
  emit: jest.fn(),
  disconnect: jest.fn(),
  connected: true,
  off: jest.fn()
}

jest.mock('@bsv/authsocket-client', () => ({
  AuthSocketClient: jest.fn(() => mockSocket)
}))

// Optional: Global WebSocket override (not strictly needed with AuthSocketClient)
class MockWebSocket {
  static CONNECTING = 0
  static OPEN = 1
  static CLOSING = 2
  static CLOSED = 3

  readyState = MockWebSocket.OPEN
  on = jest.fn()
  send = jest.fn()
  close = jest.fn()
}
global.WebSocket = MockWebSocket as unknown as typeof WebSocket

describe('MessageBoxClient', () => {
  let mockWalletClient: WalletClient

  beforeEach(() => {
    mockWalletClient = new WalletClient()

    jest.clearAllMocks()
    // (Optional, but if you want per-test control, you could move mocks here instead of globally.)
  })

  const VALID_LIST_AND_READ_RESULT = {
    body: JSON.stringify({
      status: 200,
      messages: [
        { sender: 'mockSender', messageId: 42, body: {} },
        { sender: 'mockSender', messageId: 43, body: {} }
      ]
    })
  }

  const VALID_ACK_RESULT = {
    body: JSON.stringify({
      status: 200,
      message: 'Messages marked as acknowledged!'
    })
  }

  it('Creates an instance of the MessageBoxClient class', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })

    await messageBoxClient.init()

    expect(messageBoxClient).toHaveProperty('host', 'https://message-box-us-1.bsvb.tech')

    // Ensure the socket is initialized as undefined before connecting
    expect(messageBoxClient.testSocket).toBeUndefined()
  })

  it('Initializes WebSocket connection', async () => {
    await new Promise(resolve => setTimeout(resolve, 100))

    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })

    await messageBoxClient.init()

    const connection = messageBoxClient.initializeConnection()

    // Simulate server response
    setTimeout(() => {
      socketOnMap.authenticationSuccess?.({ status: 'ok' })
    }, 100)

    await expect(connection).resolves.toBeUndefined()
  }, 10000)

  it('Falls back to HTTP when WebSocket is not initialized', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })

    await messageBoxClient.init()

    // Bypass the real connection logic
    jest.spyOn(messageBoxClient, 'initializeConnection').mockImplementation(async () => { })

      // Manually set identity key
      ; (messageBoxClient as any).myIdentityKey = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'

      // Simulate WebSocket not initialized
      ; (messageBoxClient as any).socket = null

    // Expect it to fall back to HTTP and succeed
    const result = await messageBoxClient.sendLiveMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: 'test_inbox',
      body: 'Test message'
    })

    expect(result).toEqual({
      status: 'success',
      message: 'Mocked response',
      messageId: '010203'
    })
  })

  it('Listens for live messages', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })

    await messageBoxClient.init()

    const connection = messageBoxClient.initializeConnection()

    setTimeout(() => {
      socketOnMap.authenticationSuccess?.({ status: 'ok' })
    }, 100)

    await connection

    const mockOnMessage = jest.fn()

    await messageBoxClient.listenForLiveMessages({
      messageBox: 'test_inbox',
      onMessage: mockOnMessage
    })

    expect(messageBoxClient.testSocket?.emit).toHaveBeenCalledWith(
      'joinRoom',
      '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4-test_inbox'
    )
  }, 10000)

  it('Sends a live message', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })

    await messageBoxClient.init()

    const connection = messageBoxClient.initializeConnection()

    // Simulate WebSocket auth success
    setTimeout(() => {
      socketOnMap.authenticationSuccess?.({ status: 'ok' })
    }, 100)

    await connection

    const emitSpy = jest.spyOn(messageBoxClient.testSocket as any, 'emit')

    // Kick off sending a message (this sets up the ack listener)
    const sendPromise = messageBoxClient.sendLiveMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: 'test_inbox',
      body: 'Test message'
    })

    // Simulate WebSocket acknowledgment
    setTimeout(() => {
      socketOnMap['sendMessageAck-02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4-test_inbox']?.({
        status: 'success',
        messageId: 'mocked123'
      })
    }, 100)

    const result = await sendPromise

    // Check that WebSocket emit happened correctly
    expect(emitSpy).toHaveBeenCalledWith(
      'sendMessage',
      expect.objectContaining({
        roomId: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4-test_inbox',
        message: expect.objectContaining({
          messageId: '010203',
          recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
          body: expect.stringMatching(/encrypted/)
        })
      })
    )

    // Check the resolved result
    expect(result).toEqual({
      status: 'success',
      messageId: 'mocked123'
    })
  }, 15000)

  it('Sends a message', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()
      ; (messageBoxClient as any).myIdentityKey = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'
    jest.spyOn(messageBoxClient.authFetch, 'fetch').mockResolvedValue({
      json: async () => ({
        status: 'success',
        message: 'Your message has been sent!'
      }),
      headers: new Headers(),
      ok: true,
      status: 200
    } as unknown as Response)

    const result = await messageBoxClient.sendMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: 'test_inbox',
      body: { data: 'test' }
    })

    expect(result).toHaveProperty('message', 'Your message has been sent!')
  })

  it('Lists available messages', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()
      ; (messageBoxClient as any).myIdentityKey = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'

    jest.spyOn(messageBoxClient.authFetch, 'fetch').mockResolvedValue({
      json: async () => JSON.parse(VALID_LIST_AND_READ_RESULT.body),
      headers: new Headers(),
      ok: true,
      status: 200
    } as unknown as Response)

    const result = await messageBoxClient.listMessages({ messageBox: 'test_inbox' })

    expect(result).toEqual(JSON.parse(VALID_LIST_AND_READ_RESULT.body).messages)
  })

  it('Acknowledges a message', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()
      ; (messageBoxClient as any).myIdentityKey = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'

    jest.spyOn(messageBoxClient.authFetch, 'fetch').mockResolvedValue({
      json: async () => JSON.parse(VALID_ACK_RESULT.body),
      headers: new Headers(),
      ok: true,
      status: 200
    } as unknown as Response)

    const result = await messageBoxClient.acknowledgeMessage({ messageIds: ['42'] })

    expect(result).toEqual(200)
  })

  it('Throws an error when sendMessage() API fails', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()

      ; (messageBoxClient as any).myIdentityKey = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'

    jest.spyOn(messageBoxClient.authFetch, 'fetch')
      .mockResolvedValue({
        status: 500,
        statusText: 'Internal Server Error',
        ok: false,
        json: async () => ({ status: 'error', description: 'Internal Server Error' }),
        headers: new Headers()
      } as unknown as Response)

    await expect(messageBoxClient.sendMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: 'test_inbox',
      body: 'Test Message'
    })).rejects.toThrow('Message sending failed: HTTP 500 - Internal Server Error')
  })

  it('throws when every host fails', async () => {
    const client = new MessageBoxClient({ walletClient: mockWalletClient, host: 'https://primary', enableLogging: false })
    await client.init()

    // Pretend there are no advertised replicas
    jest.spyOn(client as any, 'queryAdvertisements').mockResolvedValue([])

    // Primary host responds with 500
    jest.spyOn(client.authFetch, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ status: 'error', description: 'DB down' })
    } as unknown as Response)

    await expect(client.listMessages({ messageBox: 'inbox' }))
      .rejects.toThrow('Failed to retrieve messages from any host')
  })

  it('returns [] when at least one host succeeds but has no messages', async () => {
    const client = new MessageBoxClient({ walletClient: mockWalletClient, host: 'https://primary', enableLogging: false })
    await client.init()

    // One failing replica, one healthy replica
    jest.spyOn(client as any, 'queryAdvertisements').mockResolvedValue([{
      host: 'https://replica'
    }])

    jest.spyOn(client.authFetch, 'fetch')
      .mockImplementation(async url =>
        // eslint-disable-next-line @typescript-eslint/strict-boolean-expressions
        url.startsWith('https://primary')
          ? await Promise.resolve({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => ({ status: 'error', description: 'DB down' })
          } as unknown as Response)
          : await Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ status: 'success', messages: [] })
          } as unknown as Response)
      )

    await expect(client.listMessages({ messageBox: 'inbox' })).resolves.toEqual([])
  })

  it('Throws an error when acknowledgeMessage() API fails', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()
      ; (messageBoxClient as any).myIdentityKey = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'

    jest.spyOn(messageBoxClient.authFetch, 'fetch')
      .mockResolvedValue({
        status: 500,
        json: async () => ({ status: 'error', description: 'Failed to acknowledge messages' })
      } as unknown as Response)

    await expect(messageBoxClient.acknowledgeMessage({ messageIds: ['42'] }))
      .rejects.toThrow('Failed to acknowledge messages')
  })

  it('Emits joinRoom event and listens for incoming messages', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()

    // Mock identity key properly
    jest.spyOn(mockWalletClient, 'getPublicKey').mockResolvedValue({ publicKey: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4' })

    // Mock socket with `on` method capturing event handlers
    const mockSocket = {
      emit: jest.fn(),
      on: jest.fn()
    } as any

    // Mock `initializeConnection` so it assigns `socket` & identity key
    jest.spyOn(messageBoxClient, 'initializeConnection').mockImplementation(async () => {
      Object.defineProperty(messageBoxClient, 'testIdentityKey', { get: () => '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4' })
      Object.defineProperty(messageBoxClient, 'testSocket', { get: () => mockSocket });
      (messageBoxClient as any).socket = mockSocket; // Ensures internal socket is set
      (messageBoxClient as any).myIdentityKey = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4' // Ensures identity key is set
    })

    const onMessageMock = jest.fn()

    await messageBoxClient.listenForLiveMessages({
      onMessage: onMessageMock,
      messageBox: 'test_inbox'
    })

    // Ensure `joinRoom` event was emitted with the correct identity key
    expect(mockSocket.emit).toHaveBeenCalledWith('joinRoom', '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4-test_inbox')

    // Simulate receiving a message
    const receivedMessage = { text: 'Hello, world!' }

    // Extract & invoke the callback function stored in `on`
    const sendMessageCallback = mockSocket.on.mock.calls.find(
      ([eventName]) => eventName === 'sendMessage-02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4-test_inbox'
    )?.[1] // Extract the callback function

    if (typeof sendMessageCallback === 'function') {
      sendMessageCallback(receivedMessage)
    }

    // Ensure `onMessage` was called with the received message
    expect(onMessageMock).toHaveBeenCalledWith(receivedMessage)
  })

  it('Handles WebSocket connection and disconnection events', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()

    // Simulate identity key
    jest.spyOn(mockWalletClient, 'getPublicKey').mockResolvedValue({ publicKey: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4' })

    // Simulate connection + disconnection + auth success
    setTimeout(() => {
      socketOnMap.connect?.()
      socketOnMap.disconnect?.()
      socketOnMap.authenticationSuccess?.({ status: 'ok' })
    }, 100)

    await messageBoxClient.initializeConnection()

    // Verify event listeners were registered
    expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function))
    expect(mockSocket.on).toHaveBeenCalledWith('disconnect', expect.any(Function))
  }, 10000)

  it('throws an error when recipient is empty in sendLiveMessage', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()

    // Mock `initializeConnection` so it assigns `socket` & identity key
    jest.spyOn(messageBoxClient, 'initializeConnection').mockImplementation(async () => {
      Object.defineProperty(messageBoxClient, 'testIdentityKey', { get: () => '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4' })
      Object.defineProperty(messageBoxClient, 'testSocket', { get: () => mockSocket });
      (messageBoxClient as any).socket = mockSocket; // Ensures internal socket is set
      (messageBoxClient as any).myIdentityKey = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4' // Ensures identity key is set
    })

    // Mock socket to ensure WebSocket validation does not fail
    const mockSocket = {
      emit: jest.fn()
    } as any
    jest.spyOn(messageBoxClient, 'testSocket', 'get').mockReturnValue(mockSocket)

    await expect(messageBoxClient.sendLiveMessage({
      recipient: '  ',
      messageBox: 'test_inbox',
      body: 'Test message'
    })).rejects.toThrow('[MB CLIENT ERROR] Recipient identity key is required')
  })

  it('throws an error when recipient is missing in sendMessage', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()

    await expect(messageBoxClient.sendMessage({
      recipient: '', // Empty recipient
      messageBox: 'test_inbox',
      body: 'Test message'
    })).rejects.toThrow('You must provide a message recipient!')

    await expect(messageBoxClient.sendMessage({
      recipient: '   ', // Whitespace recipient
      messageBox: 'test_inbox',
      body: 'Test message'
    })).rejects.toThrow('You must provide a message recipient!')

    await expect(messageBoxClient.sendMessage({
      recipient: null as any, // Null recipient
      messageBox: 'test_inbox',
      body: 'Test message'
    })).rejects.toThrow('You must provide a message recipient!')
  })

  it('throws an error when messageBox is missing in sendMessage', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()

    await expect(messageBoxClient.sendMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: '', // Empty messageBox
      body: 'Test message'
    })).rejects.toThrow('You must provide a messageBox to send this message into!')

    await expect(messageBoxClient.sendMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: '   ', // Whitespace messageBox
      body: 'Test message'
    })).rejects.toThrow('You must provide a messageBox to send this message into!')

    await expect(messageBoxClient.sendMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: null as any, // Null messageBox
      body: 'Test message'
    })).rejects.toThrow('You must provide a messageBox to send this message into!')
  })

  it('throws an error when message body is missing in sendMessage', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()

    await expect(messageBoxClient.sendMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: 'test_inbox',
      body: '' // Empty body
    })).rejects.toThrow('Every message must have a body!')

    await expect(messageBoxClient.sendMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: 'test_inbox',
      body: '   ' // Whitespace body
    })).rejects.toThrow('Every message must have a body!')

    await expect(messageBoxClient.sendMessage({
      recipient: '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4',
      messageBox: 'test_inbox',
      body: null as any // Null body
    })).rejects.toThrow('Every message must have a body!')
  })

  it('throws an error when messageBox is empty in listMessages', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()

    await expect(messageBoxClient.listMessages({
      messageBox: '' // Empty messageBox
    })).rejects.toThrow('MessageBox cannot be empty')

    await expect(messageBoxClient.listMessages({
      messageBox: '   ' // Whitespace messageBox
    })).rejects.toThrow('MessageBox cannot be empty')
  })

  it('throws an error when messageIds is empty in acknowledgeMessage', async () => {
    const messageBoxClient = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://message-box-us-1.bsvb.tech',
      enableLogging: true
    })
    await messageBoxClient.init()

    await expect(messageBoxClient.acknowledgeMessage({
      messageIds: [] // Empty array
    })).rejects.toThrow('Message IDs array cannot be empty')

    await expect(messageBoxClient.acknowledgeMessage({
      messageIds: undefined as any // Undefined value
    })).rejects.toThrow('Message IDs array cannot be empty')

    await expect(messageBoxClient.acknowledgeMessage({
      messageIds: null as any // Null value
    })).rejects.toThrow('Message IDs array cannot be empty')

    await expect(messageBoxClient.acknowledgeMessage({
      messageIds: 'invalid' as any // Not an array
    })).rejects.toThrow('Message IDs array cannot be empty')
  })

  it('Uses default host if none is provided', () => {
    const client = new MessageBoxClient({ walletClient: mockWalletClient })

    expect((client as any).initialized).toBe(false)
    expect((client as any).host).toBe('https://message-box-us-1.bsvb.tech')
  })

  it('Calls init() to set up a default host when missing', async () => {
    const client = new MessageBoxClient({ walletClient: mockWalletClient })

    expect((client as any).initialized).toBe(false)

    await client.init()

    expect((client as any).initialized).toBe(true)
    expect(typeof (client as any).host).toBe('string')
    expect((client as any).host.length).toBeGreaterThan(0)
  })

  it('init() overrides host if passed with override=true', async () => {
    const client = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://original-host.example'
    })

    expect((client as any).initialized).toBe(false)
    expect((client as any).host).toBe('https://original-host.example')

    await client.init('https://new-host.example')

    expect((client as any).initialized).toBe(true)
    expect((client as any).host).toBe('https://new-host.example')
  })

  it('init() never calls anointHost automatically', async () => {
    const spy = jest.spyOn(MessageBoxClient.prototype as any, 'anointHost')
    await new MessageBoxClient({ walletClient: mockWalletClient }).init()
    expect(spy).not.toHaveBeenCalled()
  })


  it('resolveHostForRecipient returns the first advertised host', async () => {
    const client = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://default.box'
    })
    await client.init()

      // For this ONE call return two adverts – the first is selected
      ; (MessageBoxClient.prototype as any).queryAdvertisements
        .mockResolvedValueOnce([
          { host: 'https://peer.box' }, { host: 'https://second.box' }])

    const result = await client.resolveHostForRecipient('02aa…deadbeef')
    expect(result).toBe('https://peer.box')
  })

  it('resolveHostForRecipient falls back to this.host when no adverts exist', async () => {
    const client = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://default.box'
    })
    await client.init()
      ; (MessageBoxClient.prototype as any).queryAdvertisements
        .mockResolvedValueOnce([])

    const result = await client.resolveHostForRecipient('03bb…cafef00d')

    expect(result).toBe('https://default.box')
  })

  it('anointHost queries advertisements for existing host records', async () => {
    const anointMock = MessageBoxClient.prototype.anointHost as unknown as jest.Mock
    anointMock.mockRestore()

    const client = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://default.box'
    })

    const querySpy = jest.spyOn(client as any, 'queryAdvertisements').mockResolvedValue([])
    jest.spyOn(mockWalletClient, 'listOutputs').mockResolvedValue({ outputs: [] } as any)
    jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue({
      toHex: () => '00',
      toASM: () => 'OP_FALSE'
    } as any)
    jest.spyOn(Transaction, 'fromAtomicBEEF').mockReturnValue({} as any)
    jest.spyOn(TopicBroadcaster.prototype as any, 'broadcast').mockResolvedValue({ txid: 'broadcasted-txid' })

    await client.anointHost('https://fresh.host')

    expect(querySpy).toHaveBeenCalledWith(
      '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'
    )
  })

  it('anointHost signs all revoke inputs when multiple spendable advertisements exist', async () => {
    const client = new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://default.box'
    })

    const tokenA = {
      host: 'http://localhost:8080',
      txid: 'tx-a',
      outputIndex: 0,
      lockingScript: {} as any,
      beef: [1, 2, 3]
    }
    const tokenB = {
      host: 'https://valid.host',
      txid: 'tx-b',
      outputIndex: 1,
      lockingScript: {} as any,
      beef: [4, 5, 6]
    }

    jest.spyOn(client as any, 'queryAdvertisements').mockResolvedValue([tokenA, tokenB])
    jest.spyOn(mockWalletClient, 'listOutputs').mockResolvedValue({
      outputs: [
        { spendable: true, outpoint: 'tx-a.0' },
        { spendable: true, outpoint: 'tx-b.1' }
      ]
    } as any)

    jest.spyOn(PushDrop.prototype, 'lock').mockResolvedValue({
      toHex: () => '00',
      toASM: () => 'OP_FALSE'
    } as any)

    const unlockSignMock = jest
      .fn()
      .mockImplementation(async (_tx: unknown, inputIndex: number) => ({ toHex: () => `unlock-${inputIndex}` }))
    jest.spyOn(PushDrop.prototype, 'unlock').mockReturnValue({ sign: unlockSignMock } as any)

    const mergedBeef = {
      mergeBeef: jest.fn(),
      toBinary: jest.fn().mockReturnValue([9, 9, 9])
    }
    jest.spyOn(Beef, 'fromBinary').mockImplementation(() => mergedBeef as any)

    const fromAtomicSpy = jest.spyOn(Transaction, 'fromAtomicBEEF')
    fromAtomicSpy
      .mockReturnValueOnce({} as any)
      .mockReturnValueOnce({} as any)
    jest.spyOn(Transaction, 'fromBEEF').mockReturnValue({ outputs: [{ satoshis: 1 }, { satoshis: 1 }] } as any)

    const createActionSpy = jest.spyOn(mockWalletClient, 'createAction').mockResolvedValue({
      signableTransaction: {
        tx: [7, 7, 7],
        reference: 'sign-ref'
      }
    } as any)
    const signActionSpy = jest.spyOn(mockWalletClient, 'signAction').mockResolvedValue({
      tx: [8, 8, 8],
      txid: 'signed-txid'
    } as any)
    jest.spyOn(TopicBroadcaster.prototype as any, 'broadcast').mockResolvedValue({ txid: 'broadcasted-txid' })

    const result = await client.anointHost('https://new.host')

    expect(createActionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        inputBEEF: [9, 9, 9],
        inputs: [
          expect.objectContaining({ outpoint: 'tx-a.0' }),
          expect.objectContaining({ outpoint: 'tx-b.1' })
        ]
      }),
      undefined
    )
    expect(signActionSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        reference: 'sign-ref',
        spends: {
          0: { unlockingScript: 'unlock-0' },
          1: { unlockingScript: 'unlock-1' }
        }
      }),
      undefined
    )
    expect(result).toEqual({ txid: 'broadcasted-txid' })
  })

  describe('message box quotes', () => {
    const recipientA = '02b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'
    const recipientB = '03b463b8ef7f03c47fba2679c7334d13e4939b8ca30dbb6bbd22e34ea3e9b1b0e4'

    const makeClient = (): MessageBoxClient => new MessageBoxClient({
      walletClient: mockWalletClient,
      host: 'https://default.box'
    })

    const makeQuoteResponse = (
      body: unknown,
      headers: Record<string, string> = { 'x-bsv-auth-identity-key': 'delivery-agent' }
    ): Response => new Response(JSON.stringify(body), { status: 200, headers })

    it('gets a single-recipient quote from the override host', async () => {
      const client = makeClient()
      const fetchSpy = jest.spyOn(client.authFetch, 'fetch').mockResolvedValue(
        makeQuoteResponse({
          status: 'success',
          quote: {
            recipientFee: 12,
            deliveryFee: 3
          }
        })
      )

      await expect(client.getMessageBoxQuote({
        recipient: recipientA,
        messageBox: 'inbox'
      }, 'https://quote.box')).resolves.toEqual({
        recipientFee: 12,
        deliveryFee: 3,
        deliveryAgentIdentityKey: 'delivery-agent'
      })

      expect(fetchSpy).toHaveBeenCalledWith(
        `https://quote.box/permissions/quote?recipient=${recipientA}&messageBox=inbox`,
        { method: 'GET' }
      )
    })

    it('throws when a single-recipient quote response has no delivery-agent key', async () => {
      const client = makeClient()
      jest.spyOn(client.authFetch, 'fetch').mockResolvedValue(
        makeQuoteResponse({
          status: 'success',
          quote: { recipientFee: 0, deliveryFee: 0 }
        }, {})
      )

      await expect(client.getMessageBoxQuote({
        recipient: recipientA,
        messageBox: 'inbox'
      }, 'https://quote.box')).rejects.toThrow('Delivery agent did not provide their identity key')
    })

    it('aggregates a multi-recipient quote payload', async () => {
      const client = makeClient()
      jest.spyOn(client.authFetch, 'fetch').mockResolvedValue(
        makeQuoteResponse({
          quotesByRecipient: [
            {
              recipient: recipientA,
              messageBox: 'inbox',
              deliveryFee: 2,
              recipientFee: 0,
              status: 'always_allow'
            },
            {
              recipient: recipientB,
              messageBox: 'inbox',
              deliveryFee: 2,
              recipientFee: -1,
              status: 'blocked'
            }
          ],
          blockedRecipients: [recipientB]
        })
      )

      await expect(client.getMessageBoxQuote({
        recipient: [recipientA, recipientB],
        messageBox: 'inbox'
      }, 'https://quote.box')).resolves.toEqual({
        quotesByRecipient: [
          {
            recipient: recipientA,
            messageBox: 'inbox',
            deliveryFee: 2,
            recipientFee: 0,
            status: 'always_allow'
          },
          {
            recipient: recipientB,
            messageBox: 'inbox',
            deliveryFee: 2,
            recipientFee: -1,
            status: 'blocked'
          }
        ],
        totals: {
          deliveryFees: 4,
          recipientFees: 0,
          totalForPayableRecipients: 4
        },
        blockedRecipients: [recipientB],
        deliveryAgentIdentityKeyByHost: {
          'https://quote.box': 'delivery-agent'
        }
      })
    })

    it('expands a single quote payload across all recipients in a host group', async () => {
      const client = makeClient()
      jest.spyOn(client.authFetch, 'fetch').mockResolvedValue(
        makeQuoteResponse({
          quote: {
            deliveryFee: 5,
            recipientFee: 7
          }
        })
      )

      await expect(client.getMessageBoxQuote({
        recipient: [recipientA, recipientB],
        messageBox: 'inbox'
      }, 'https://quote.box')).resolves.toMatchObject({
        quotesByRecipient: [
          {
            recipient: recipientA,
            messageBox: 'inbox',
            deliveryFee: 5,
            recipientFee: 7,
            status: 'payment_required'
          },
          {
            recipient: recipientB,
            messageBox: 'inbox',
            deliveryFee: 5,
            recipientFee: 7,
            status: 'payment_required'
          }
        ],
        totals: {
          deliveryFees: 10,
          recipientFees: 14,
          totalForPayableRecipients: 24
        }
      })
    })

    it('rejects empty multi-recipient quote requests', async () => {
      const client = makeClient()

      await expect(client.getMessageBoxQuote({
        recipient: [],
        messageBox: 'inbox'
      })).rejects.toThrow('At least one recipient is required.')
    })

    it('groups multi-recipient quote requests by resolved host', async () => {
      const client = makeClient()
      jest.spyOn(client, 'resolveHostForRecipient')
        .mockResolvedValueOnce('https://one.box')
        .mockResolvedValueOnce('https://two.box')
        .mockResolvedValueOnce('https://one.box')

      const groups = await (client as any).groupQuoteRecipientsByHost([
        recipientA,
        recipientB,
        recipientA
      ])

      expect(Array.from(groups.entries())).toEqual([
        ['https://one.box', [recipientA, recipientA]],
        ['https://two.box', [recipientB]]
      ])
    })

    it('rejects unexpected quote payload shapes', () => {
      const client = makeClient()
      const accumulator = (client as any).createMultiQuoteAccumulator()

      expect(() => (client as any).mergeQuotePayload(
        { unexpected: true },
        'https://quote.box',
        [recipientA],
        'inbox',
        accumulator
      )).toThrow('Unexpected quote response shape from host https://quote.box')
    })
  })
})
