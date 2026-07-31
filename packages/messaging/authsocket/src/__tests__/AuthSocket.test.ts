import { AuthSocket } from '../AuthSocketServer.js'

describe('AuthSocket', () => {
  function createHarness(onError = jest.fn()) {
    let generalMessageListener:
      ((senderPublicKey: string, payload: number[]) => void | Promise<void>) | undefined
    const peer = {
      listenForGeneralMessages: jest.fn(
        (callback: (senderPublicKey: string, payload: number[]) => void | Promise<void>) => {
          generalMessageListener = callback
        }
      ),
      toPeer: jest.fn().mockResolvedValue(undefined)
    }
    const socket = {
      id: 'socket-2',
      disconnect: jest.fn()
    }
    const identityDiscovered = jest.fn()
    const authSocket = new AuthSocket(socket as never, peer as never, identityDiscovered, onError)
    return {
      authSocket,
      generalMessage(payload: unknown, sender = 'peer-key') {
        return generalMessageListener?.(
          sender,
          typeof payload === 'string'
            ? Array.from(Buffer.from(payload))
            : Array.from(Buffer.from(JSON.stringify(payload)))
        )
      },
      identityDiscovered,
      onError,
      peer,
      socket
    }
  }

  it('dispatches authenticated messages and reuses the discovered identity', async () => {
    const { authSocket, generalMessage, identityDiscovered, peer } = createHarness()
    const first = jest.fn()
    const second = jest.fn()
    authSocket.on('message', first)
    authSocket.on('message', second)

    generalMessage({ eventName: 'message', data: { value: 7 } })
    generalMessage({ eventName: 'message', data: { value: 8 } }, 'ignored-new-key')

    expect(authSocket.id).toBe('socket-2')
    expect(authSocket.identityKey).toBe('peer-key')
    expect(identityDiscovered).toHaveBeenCalledTimes(1)
    expect(identityDiscovered).toHaveBeenCalledWith('socket-2', 'peer-key')
    expect(first).toHaveBeenNthCalledWith(1, { value: 7 })
    expect(first).toHaveBeenNthCalledWith(2, { value: 8 })
    expect(second).toHaveBeenCalledTimes(2)

    await authSocket.emit('reply', { accepted: true })

    const [payload, identityKey] = peer.toPeer.mock.calls[0]
    expect(JSON.parse(Buffer.from(payload).toString('utf8'))).toEqual({
      eventName: 'reply',
      data: { accepted: true }
    })
    expect(identityKey).toBe('peer-key')
  })

  it('routes malformed payloads to the explicit unknown event', () => {
    const { authSocket, generalMessage } = createHarness()
    const unknown = jest.fn()
    authSocket.on('_unknown', unknown)

    generalMessage('{not-json')

    expect(unknown).toHaveBeenCalledWith(null)
  })

  it.each([null, [], 7, 'event', {}, { eventName: 7 }])(
    'routes a valid JSON non-envelope (%p) to the explicit unknown event',
    value => {
      const { authSocket, generalMessage } = createHarness()
      const unknown = jest.fn()
      authSocket.on('_unknown', unknown)

      generalMessage(value)

      expect(unknown).toHaveBeenCalledWith(null)
    }
  )

  it('contains rejected application handlers and disconnects the offending socket', async () => {
    const observerFailure = new Error('observer failed')
    const onError = jest.fn().mockRejectedValue(observerFailure)
    const { authSocket, generalMessage, socket } = createHarness(onError)
    const applicationFailure = new Error('application failed')
    authSocket.on('message', async () => await Promise.reject(applicationFailure))

    await expect(
      generalMessage({ eventName: 'message', data: { untrusted: true } })
    ).resolves.toBeUndefined()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith(applicationFailure, {
      phase: 'application',
      socketId: 'socket-2',
      eventName: 'message'
    })
    expect(socket.disconnect).toHaveBeenCalledWith(true)
  })

  it('ignores valid events without registered callbacks', () => {
    const { generalMessage } = createHarness()

    expect(() => generalMessage({ eventName: 'unhandled', data: true })).not.toThrow()
  })
})
