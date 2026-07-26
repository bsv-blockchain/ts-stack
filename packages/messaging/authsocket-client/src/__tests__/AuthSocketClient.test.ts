import { Buffer } from 'node:buffer'

const mockSocket = {
  disconnect: jest.fn(),
  id: 'socket-id' as string | undefined,
  on: jest.fn()
}

const mockPeer = {
  listenForGeneralMessages: jest.fn(),
  toPeer: jest.fn()
}

const mockIo = jest.fn(() => mockSocket)
const mockPeerConstructor = jest.fn(() => mockPeer)

jest.mock('socket.io-client', () => ({
  io: mockIo
}))

jest.mock('@bsv/sdk', () => ({
  Peer: mockPeerConstructor,
  Utils: {
    toArray: (value: string) => Array.from(Buffer.from(value, 'utf8')),
    toUTF8: (value: number[]) => Buffer.from(value).toString('utf8')
  }
}))

import { AuthSocketClient } from '../AuthSocketClient.js'
import { SocketClientTransport } from '../SocketClientTransport.js'

describe('AuthSocketClient', () => {
  let socketListeners: Map<string, (...arguments_: any[]) => any>
  let generalMessageListener: ((senderPublicKey: string, payload: number[]) => void) | undefined

  beforeEach(() => {
    jest.clearAllMocks()
    socketListeners = new Map()
    generalMessageListener = undefined
    mockSocket.on.mockImplementation(
      (eventName: string, callback: (...arguments_: any[]) => any) => {
        socketListeners.set(eventName, callback)
      }
    )
    mockPeer.listenForGeneralMessages.mockImplementation(
      (callback: (senderPublicKey: string, payload: number[]) => void) => {
        generalMessageListener = callback
      }
    )
    mockPeer.toPeer.mockResolvedValue(undefined)
  })

  function createClient() {
    const wallet = { id: 'wallet' }
    const requestedCertificates = { certifiers: [], types: {} }
    const sessionManager = { id: 'sessions' }
    const managerOptions = { transports: ['websocket'] }
    const client = AuthSocketClient('https://example.test', {
      wallet: wallet as never,
      requestedCertificates,
      sessionManager: sessionManager as never,
      managerOptions,
      originator: 'example.test' as never
    })
    return {
      client,
      managerOptions,
      requestedCertificates,
      sessionManager,
      wallet
    }
  }

  it('constructs the authenticated transport and redispatches socket lifecycle events', () => {
    const { client, managerOptions, requestedCertificates, sessionManager, wallet } = createClient()
    const connected = jest.fn()
    const disconnected = jest.fn()

    expect(client.on('connect', connected)).toBe(client)
    expect(client.on('disconnect', disconnected)).toBe(client)
    expect(mockIo).toHaveBeenCalledWith('https://example.test', managerOptions)
    expect(mockPeerConstructor).toHaveBeenCalledWith(
      wallet,
      expect.any(SocketClientTransport),
      requestedCertificates,
      sessionManager,
      undefined,
      'example.test'
    )

    socketListeners.get('connect')?.()
    expect(client.connected).toBe(true)
    expect(client.id).toBe('socket-id')
    expect(connected).toHaveBeenCalledWith(undefined)

    socketListeners.get('disconnect')?.('transport close')
    expect(client.connected).toBe(false)
    expect(disconnected).toHaveBeenCalledWith('transport close')
  })

  it('handles missing socket IDs and invokes every callback for an event', () => {
    const { client } = createClient()
    const first = jest.fn()
    const second = jest.fn()
    client.on('message', first).on('message', second)
    mockSocket.id = undefined

    socketListeners.get('connect')?.()
    generalMessageListener?.(
      'server-key',
      Array.from(Buffer.from(JSON.stringify({ eventName: 'message', data: 7 })))
    )

    expect(client.id).toBe('')
    expect(first).toHaveBeenCalledWith(7)
    expect(second).toHaveBeenCalledWith(7)
    mockSocket.id = 'socket-id'
  })

  it('dispatches authenticated messages and signs replies for the discovered server', () => {
    const { client } = createClient()
    const received = jest.fn()
    client.on('message', received)

    generalMessageListener?.(
      'server-key',
      Array.from(Buffer.from(JSON.stringify({ eventName: 'message', data: { value: 1 } })))
    )

    expect(client.serverIdentityKey).toBe('server-key')
    expect(received).toHaveBeenCalledWith({ value: 1 })
    expect(client.emit('reply', { value: 2 })).toBe(client)

    const [payload, identityKey] = mockPeer.toPeer.mock.calls[0]
    expect(JSON.parse(Buffer.from(payload).toString('utf8'))).toEqual({
      eventName: 'reply',
      data: { value: 2 }
    })
    expect(identityKey).toBe('server-key')
  })

  it('reports asynchronous send failures with the event name', async () => {
    const error = new Error('send failed')
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {})
    mockPeer.toPeer.mockRejectedValue(error)
    const { client } = createClient()

    client.emit('failing-event', true)
    await Promise.resolve()

    expect(consoleError).toHaveBeenCalledWith(
      'BRC103IoClientSocket emit error for event "failing-event":',
      error
    )
    consoleError.mockRestore()
  })

  it('handles malformed general messages and clears identity on disconnect', () => {
    const { client } = createClient()
    const unknown = jest.fn()
    client.on('_unknown', unknown)

    generalMessageListener?.('server-key', Array.from(Buffer.from('{not-json')))
    expect(unknown).toHaveBeenCalledWith(undefined)
    expect(client.serverIdentityKey).toBe('server-key')

    client.disconnect()

    expect(client.serverIdentityKey).toBeUndefined()
    expect(mockSocket.disconnect).toHaveBeenCalledTimes(1)
  })

  it('ignores events without callbacks', () => {
    const { client } = createClient()

    expect(() => {
      generalMessageListener?.(
        'server-key',
        Array.from(Buffer.from(JSON.stringify({ eventName: 'unused', data: null })))
      )
    }).not.toThrow()
    expect(client.serverIdentityKey).toBe('server-key')
  })
})
