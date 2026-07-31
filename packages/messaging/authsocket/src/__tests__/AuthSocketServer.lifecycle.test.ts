const mockIoServer = {
  on: jest.fn(),
  close: jest.fn()
}

const mockPeer = {
  listenForGeneralMessages: jest.fn(),
  toPeer: jest.fn()
}

const mockIoServerConstructor = jest.fn(() => mockIoServer)
const mockPeerConstructor = jest.fn(() => mockPeer)

jest.mock('socket.io', () => ({
  Server: mockIoServerConstructor
}))

jest.mock('@bsv/sdk', () => ({
  Peer: mockPeerConstructor
}))

import { AuthSocketServer } from '../AuthSocketServer.js'
import { SocketServerTransport } from '../SocketServerTransport.js'

describe('AuthSocketServer lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPeer.toPeer.mockResolvedValue(undefined)
    mockIoServer.close.mockResolvedValue(undefined)
  })

  it('wraps new connections, discovers identity, and removes disconnected peers', async () => {
    const wallet = { id: 'wallet' }
    const requestedCertificates = { certifiers: [], types: {} }
    const sessionManager = { id: 'sessions' }
    const server = new AuthSocketServer({} as never, {
      wallet: wallet as never,
      requestedCertificates,
      sessionManager: sessionManager as never,
      cors: { origin: '*' }
    })
    const connectionCallback = jest.fn()
    server.on('connection', connectionCallback)

    expect(mockIoServerConstructor).toHaveBeenCalledWith(expect.anything(), {
      cors: { origin: '*' }
    })

    const rawListeners = new Map<string, (...arguments_: any[]) => any>()
    const rawSocket = {
      id: 'socket-1',
      emit: jest.fn(),
      on: jest.fn((eventName: string, callback: (...arguments_: any[]) => any) => {
        rawListeners.set(eventName, callback)
      })
    }
    const connectionListener = mockIoServer.on.mock.calls.find(
      ([eventName]) => eventName === 'connection'
    )?.[1]

    expect(connectionListener).toEqual(expect.any(Function))
    await connectionListener(rawSocket)

    expect(mockPeerConstructor).toHaveBeenCalledWith(
      wallet,
      expect.any(SocketServerTransport),
      requestedCertificates,
      sessionManager
    )
    expect(connectionCallback).toHaveBeenCalledTimes(1)
    const authenticatedSocket = connectionCallback.mock.calls[0][0]
    expect(authenticatedSocket.id).toBe('socket-1')
    expect(authenticatedSocket.identityKey).toBeUndefined()

    const generalMessageListener = mockPeer.listenForGeneralMessages.mock.calls[0][0]
    generalMessageListener(
      'identity-key',
      Array.from(Buffer.from(JSON.stringify({ eventName: 'ready', data: 1 })))
    )

    expect(authenticatedSocket.identityKey).toBe('identity-key')
    expect(server.emitToIdentity('identity-key', 'private', { ok: true })).toBe(1)
    expect(mockPeer.toPeer).toHaveBeenLastCalledWith(expect.any(Array), 'identity-key')

    rawListeners.get('disconnect')?.()
    expect(server.emitToIdentity('identity-key', 'private', { ok: false })).toBe(0)

    await connectionListener(rawSocket)
    rawListeners.get('disconnect')?.()
    const disconnectedGeneralMessageListener = mockPeer.listenForGeneralMessages.mock.calls[1][0]

    expect(() => {
      disconnectedGeneralMessageListener(
        'late-identity',
        Array.from(Buffer.from(JSON.stringify({ eventName: 'late', data: null })))
      )
    }).not.toThrow()
    expect(server.emitToIdentity('late-identity', 'private', null)).toBe(0)
  })

  it('passes non-connection events through to Socket.IO', () => {
    const server = new AuthSocketServer({} as never, { wallet: {} as never })
    const callback = jest.fn()

    server.on('maintenance', callback)

    expect(mockIoServer.on).toHaveBeenCalledWith('maintenance', callback)
  })

  it('closes Socket.IO once when shutdown is requested repeatedly', async () => {
    const server = new AuthSocketServer({} as never, { wallet: {} as never })

    await Promise.all([server.close(), server.close()])

    expect(mockIoServer.close).toHaveBeenCalledTimes(1)
  })
})
