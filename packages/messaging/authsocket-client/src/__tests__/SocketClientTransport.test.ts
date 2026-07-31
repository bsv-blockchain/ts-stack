import { SocketClientTransport } from '../SocketClientTransport.js'

describe('SocketClientTransport', () => {
  function createMockSocket() {
    const listeners: Record<string, (data: unknown) => unknown> = {}
    return {
      emit: jest.fn(),
      disconnect: jest.fn(),
      on: jest.fn((event: string, callback: (data: unknown) => unknown) => {
        listeners[event] = callback
      }),
      fire: (event: string, data: unknown) => listeners[event]?.(data)
    }
  }

  test('constructor subscribes to authMessage events', () => {
    const socket = createMockSocket()
    new SocketClientTransport(socket as never)

    expect(socket.on).toHaveBeenCalledWith('authMessage', expect.any(Function))
  })

  test('send() emits authMessage on the socket', async () => {
    const socket = createMockSocket()
    const transport = new SocketClientTransport(socket as never)
    const message = { type: 'test', payload: [1, 2, 3] }

    await transport.send(message as never)

    expect(socket.emit).toHaveBeenCalledWith('authMessage', message)
  })

  test('onData() registers callback that receives authMessage events', async () => {
    const socket = createMockSocket()
    const transport = new SocketClientTransport(socket as never)
    const callback = jest.fn()
    const message = { type: 'test', payload: [4, 5, 6] }

    await transport.onData(callback)

    await socket.fire('authMessage', message)

    expect(callback).toHaveBeenCalledWith(message)
  })

  test('ignores auth messages until a callback is registered', async () => {
    const socket = createMockSocket()
    new SocketClientTransport(socket as never)

    await expect(socket.fire('authMessage', { type: 'test' })).resolves.toBeUndefined()
  })

  test.each([
    [
      'a synchronous throw',
      () => {
        throw new Error('invalid auth message')
      }
    ],
    ['a rejected promise', async () => await Promise.reject(new Error('invalid signature'))]
  ])('contains %s from a malicious server and disconnects', async (_label, failure) => {
    const socket = createMockSocket()
    const onError = jest.fn().mockRejectedValue(new Error('observer failed'))
    const transport = new SocketClientTransport(socket as never, { onError })
    const callback = jest.fn(failure)

    await transport.onData(callback as never)
    await expect(
      socket.fire('authMessage', { messageType: 'initialResponse' })
    ).resolves.toBeUndefined()
    await Promise.resolve()

    expect(onError).toHaveBeenCalledWith(expect.any(Error))
    expect(socket.disconnect).toHaveBeenCalledTimes(1)

    await socket.fire('authMessage', { messageType: 'initialRequest' })
    expect(callback).toHaveBeenCalledTimes(1)
  })

  test('disconnects when a server exceeds the authentication concurrency limit', async () => {
    const socket = createMockSocket()
    const onError = jest.fn()
    const transport = new SocketClientTransport(socket as never, {
      maxPendingMessages: 1,
      onError
    })
    let release: (() => void) | undefined
    const pending = new Promise<void>(resolve => {
      release = resolve
    })

    await transport.onData(async () => await pending)
    const first = socket.fire('authMessage', { sequence: 1 })
    await socket.fire('authMessage', { sequence: 2 })

    expect(socket.disconnect).toHaveBeenCalledTimes(1)
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Authentication message concurrency limit exceeded' })
    )
    release?.()
    await first
  })

  test('releases authentication capacity after each successful message', async () => {
    const socket = createMockSocket()
    const transport = new SocketClientTransport(socket as never, { maxPendingMessages: 1 })
    const callback = jest.fn().mockResolvedValue(undefined)
    await transport.onData(callback)

    await socket.fire('authMessage', { sequence: 1 })
    await socket.fire('authMessage', { sequence: 2 })

    expect(callback).toHaveBeenCalledTimes(2)
    expect(socket.disconnect).not.toHaveBeenCalled()
  })

  test('reports and disconnects once when concurrent callbacks both fail', async () => {
    const socket = createMockSocket()
    const onError = jest.fn()
    const transport = new SocketClientTransport(socket as never, { onError })
    await transport.onData(async () => await Promise.reject(new Error('failed')))

    await Promise.all([
      socket.fire('authMessage', { sequence: 1 }),
      socket.fire('authMessage', { sequence: 2 })
    ])
    await Promise.resolve()

    expect(onError).toHaveBeenCalledTimes(1)
    expect(socket.disconnect).toHaveBeenCalledTimes(1)
  })

  test('rejects invalid concurrency limits', () => {
    const socket = createMockSocket()
    expect(() => new SocketClientTransport(socket as never, { maxPendingMessages: 0 })).toThrow(
      new RangeError('maxPendingMessages must be a positive safe integer')
    )
  })
})
