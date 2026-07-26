import { SocketClientTransport } from '../SocketClientTransport.js'

describe('SocketClientTransport', () => {
  function createMockSocket() {
    const listeners: Record<string, (data: unknown) => unknown> = {}
    return {
      emit: jest.fn(),
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
})
