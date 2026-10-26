import { AuthSocket } from '../AuthSocketServer.js'

describe('AuthSocket', () => {
  function createHarness(
    onError = jest.fn(),
    useDefaultObserver = false,
    identityDiscovered: jest.Mock = jest.fn()
  ) {
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
    const socketListeners = new Map<string, (...arguments_: any[]) => unknown>()
    const socket = {
      id: 'socket-2',
      disconnect: jest.fn(),
      on: jest.fn((eventName: string, callback: (...arguments_: any[]) => unknown) => {
        socketListeners.set(eventName, callback)
      })
    }
    const authSocket = useDefaultObserver
      ? new AuthSocket(socket as never, peer as never, identityDiscovered)
      : new AuthSocket(socket as never, peer as never, identityDiscovered, onError)
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
      socket,
      socketListeners
    }
  }

  it('gates every concurrent first-session message on one completed activation', async () => {
    let resolveActivation!: (approved: boolean) => void
    const activation = new Promise<boolean>(resolve => {
      resolveActivation = resolve
    })
    const identityDiscovered = jest.fn(async () => await activation)
    const { authSocket, generalMessage } = createHarness(jest.fn(), false, identityDiscovered)
    const received = jest.fn()
    authSocket.on('message', received)

    const first = Promise.resolve(generalMessage({ eventName: 'message', data: 1 }))
    const second = Promise.resolve(generalMessage({ eventName: 'message', data: 2 }))
    await Promise.resolve()

    expect(identityDiscovered).toHaveBeenCalledTimes(1)
    expect(received).not.toHaveBeenCalled()

    resolveActivation(false)
    await Promise.all([first, second])

    expect(received).not.toHaveBeenCalled()
  })

  it('dispatches authenticated messages and reuses the discovered identity', async () => {
    const { authSocket, generalMessage, identityDiscovered, peer, socket } = createHarness()
    const first = jest.fn()
    const second = jest.fn()
    authSocket.on('message', first)
    authSocket.on('message', second)

    await generalMessage({ eventName: 'message', data: { value: 7 } })
    await expect(
      generalMessage({ eventName: 'message', data: { value: 8 } }, 'ignored-new-key')
    ).resolves.toBeUndefined()

    expect(authSocket.id).toBe('socket-2')
    expect(authSocket.identityKey).toBe('peer-key')
    expect(identityDiscovered).toHaveBeenCalledTimes(1)
    expect(identityDiscovered).toHaveBeenCalledWith('socket-2', 'peer-key')
    expect(first).toHaveBeenNthCalledWith(1, { value: 7 })
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    expect(socket.disconnect).toHaveBeenCalledWith(true)

    await authSocket.emit('reply', { accepted: true })

    const [payload, identityKey] = peer.toPeer.mock.calls[0]
    expect(JSON.parse(Buffer.from(payload).toString('utf8'))).toEqual({
      eventName: 'reply',
      data: { accepted: true }
    })
    expect(identityKey).toBe('peer-key')
  })

  it('serializes real typed arrays without rewriting byte-like application objects', async () => {
    const { authSocket, generalMessage, peer } = createHarness()
    const received = jest.fn()
    const historicalTx = JSON.parse(JSON.stringify(new Uint8Array([4, 5, 6])))
    authSocket.on('payment', received)

    await generalMessage({ eventName: 'payment', data: { transaction: historicalTx } })
    await authSocket.emit('payment', { transaction: new Uint8Array([1, 2, 3]) })

    expect(received).toHaveBeenCalledWith({ transaction: historicalTx })
    const [payload] = peer.toPeer.mock.calls[0]
    expect(JSON.parse(Buffer.from(payload).toString('utf8'))).toEqual({
      eventName: 'payment',
      data: { transaction: [1, 2, 3] }
    })
  })

  it('round-trips numeric-key application event data without silent corruption', async () => {
    const { authSocket, generalMessage, peer } = createHarness()
    const received = jest.fn()
    const applicationData = { 0: 1, 1: 2 }
    authSocket.on('applicationEvent', received)

    await generalMessage({ eventName: 'applicationEvent', data: applicationData })
    await authSocket.emit('applicationEvent', applicationData)

    expect(received).toHaveBeenCalledWith(applicationData)
    const [payload] = peer.toPeer.mock.calls[0]
    expect(Buffer.from(payload).toString('utf8')).toBe(
      '{"eventName":"applicationEvent","data":{"0":1,"1":2}}'
    )
  })

  it('rejects malformed payloads without routing an attacker-controlled sentinel event', async () => {
    const { authSocket, generalMessage, socket } = createHarness()
    const unknown = jest.fn()
    authSocket.on('_unknown', unknown)

    await generalMessage('{not-json')

    expect(unknown).not.toHaveBeenCalled()
    expect(socket.disconnect).toHaveBeenCalledWith(true)
  })

  it.each([null, [], 7, 'event', {}, { eventName: 7 }])(
    'routes a valid JSON non-envelope (%p) to the explicit unknown event',
    async value => {
      const { authSocket, generalMessage, socket } = createHarness()
      const unknown = jest.fn()
      authSocket.on('_unknown', unknown)

      await generalMessage(value)

      expect(unknown).not.toHaveBeenCalled()
      expect(socket.disconnect).toHaveBeenCalledWith(true)
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

  it('contains application failures when no error observer is configured', async () => {
    const { authSocket, generalMessage, socket } = createHarness(jest.fn(), true)
    authSocket.on('message', () => {
      throw new Error('application failed')
    })

    await expect(
      generalMessage({ eventName: 'message', data: { untrusted: true } })
    ).resolves.toBeUndefined()

    expect(socket.disconnect).toHaveBeenCalledWith(true)
  })

  it('ignores valid events without registered callbacks', async () => {
    const { generalMessage } = createHarness()

    await expect(generalMessage({ eventName: 'unhandled', data: true })).resolves.toBeUndefined()
  })

  it('delivers disconnect only from the real socket lifecycle', async () => {
    const { authSocket, generalMessage, socketListeners } = createHarness()
    const disconnected = jest.fn()
    authSocket.on('disconnect', disconnected)

    await generalMessage({ eventName: 'ready', data: true })
    await generalMessage({ eventName: 'disconnect', data: 'spoofed' })
    expect(disconnected).not.toHaveBeenCalled()

    await socketListeners.get('disconnect')?.('transport close')
    expect(disconnected).toHaveBeenCalledWith('transport close')
  })
})
