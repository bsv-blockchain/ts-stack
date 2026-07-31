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
      disconnect: jest.fn(),
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

  it('contains connection construction and asynchronous application failures', async () => {
    const onError = jest.fn()
    const server = new AuthSocketServer({} as never, { wallet: {} as never, onError })
    const connectionListener = mockIoServer.on.mock.calls.find(
      ([eventName]) => eventName === 'connection'
    )?.[1]
    const constructionFailure = new Error('construction failed')
    const firstSocket = {
      id: 'broken-construction',
      disconnect: jest.fn(() => {
        throw new Error('disconnect failed')
      }),
      emit: jest.fn(),
      on: jest.fn()
    }
    mockPeerConstructor.mockImplementationOnce(() => {
      throw constructionFailure
    })

    expect(() => connectionListener(firstSocket)).not.toThrow()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(constructionFailure, {
      phase: 'connection',
      socketId: 'broken-construction'
    })
    expect(firstSocket.disconnect).toHaveBeenCalledWith(true)

    const callbackFailure = new Error('connection callback failed')
    server.on('connection', async () => await Promise.reject(callbackFailure))
    const secondSocket = {
      id: 'broken-callback',
      disconnect: jest.fn(),
      emit: jest.fn(),
      on: jest.fn()
    }
    connectionListener(secondSocket)
    await new Promise(resolve => setImmediate(resolve))

    expect(onError).toHaveBeenCalledWith(callbackFailure, {
      phase: 'connection',
      socketId: 'broken-callback'
    })
    expect(secondSocket.disconnect).toHaveBeenCalledWith(true)
  })

  it('contains server-side serialization failures before any peer send', async () => {
    const onError = jest.fn()
    const server = new AuthSocketServer({} as never, { wallet: {} as never, onError })

    expect(() => server.emit('circular', 1n)).not.toThrow()
    expect(server.emitToIdentity('identity', 'circular', 1n)).toBe(0)
    await Promise.resolve()

    expect(mockPeer.toPeer).not.toHaveBeenCalled()
    expect(onError).toHaveBeenNthCalledWith(1, expect.any(TypeError), {
      phase: 'send',
      eventName: 'circular'
    })
    expect(onError).toHaveBeenNthCalledWith(2, expect.any(TypeError), {
      phase: 'send',
      eventName: 'circular'
    })
  })

  it('routes authenticated application failures through the server observer', async () => {
    const applicationFailure = new Error('application failed')
    const onError = jest.fn()
    const server = new AuthSocketServer({} as never, { wallet: {} as never, onError })
    const connectionListener = mockIoServer.on.mock.calls.find(
      ([eventName]) => eventName === 'connection'
    )?.[1]
    const rawSocket = {
      id: 'socket-application',
      disconnect: jest.fn(),
      emit: jest.fn(),
      on: jest.fn()
    }
    const connectionCallback = jest.fn()
    server.on('connection', connectionCallback)
    connectionListener(rawSocket)
    await new Promise(resolve => setImmediate(resolve))
    const authenticatedSocket = connectionCallback.mock.calls[0][0]
    authenticatedSocket.on('message', async () => await Promise.reject(applicationFailure))
    const generalMessageListener = mockPeer.listenForGeneralMessages.mock.calls.at(-1)[0]

    await generalMessageListener(
      'identity-key',
      Array.from(Buffer.from(JSON.stringify({ eventName: 'message', data: true })))
    )
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith(applicationFailure, {
      phase: 'application',
      socketId: 'socket-application',
      eventName: 'message'
    })
    expect(rawSocket.disconnect).toHaveBeenCalledWith(true)
  })

  it('reports contained authentication failures through the server observer', async () => {
    const authenticationFailure = new Error('authentication failed')
    const onError = jest.fn()
    new AuthSocketServer({} as never, { wallet: {} as never, onError })
    const connectionListener = mockIoServer.on.mock.calls.find(
      ([eventName]) => eventName === 'connection'
    )?.[1]
    const rawListeners = new Map<string, (...arguments_: any[]) => any>()
    const rawSocket = {
      id: 'socket-authentication',
      disconnect: jest.fn(),
      emit: jest.fn(),
      on: jest.fn((eventName: string, callback: (...arguments_: any[]) => any) => {
        rawListeners.set(eventName, callback)
      })
    }
    connectionListener(rawSocket)
    const transport = (mockPeerConstructor as jest.Mock).mock.calls.at(
      -1
    )?.[1] as SocketServerTransport
    await transport.onData(async () => await Promise.reject(authenticationFailure))

    await rawListeners.get('authMessage')?.({ messageType: 'general' })
    await new Promise(resolve => setImmediate(resolve))

    expect(onError).toHaveBeenCalledWith(authenticationFailure, {
      phase: 'authentication',
      socketId: 'socket-authentication'
    })
    expect(rawSocket.disconnect).toHaveBeenCalledWith(true)
  })

  it('closes Socket.IO once when shutdown is requested repeatedly', async () => {
    const server = new AuthSocketServer({} as never, { wallet: {} as never })

    await Promise.all([server.close(), server.close()])

    expect(mockIoServer.close).toHaveBeenCalledTimes(1)
  })
})
