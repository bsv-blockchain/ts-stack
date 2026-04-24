import { SocketServerTransport } from '../SocketServerTransport'

describe('SocketServerTransport', () => {
  function createMockSocket () {
    const listeners: Record<string, Function> = {}
    return {
      emit: jest.fn(),
      on: jest.fn((event: string, cb: Function) => {
        listeners[event] = cb
      }),
      _fire: (event: string, data: any) => listeners[event]?.(data),
      _listeners: listeners
    }
  }

  test('send() emits authMessage on the socket', async () => {
    const socket = createMockSocket()
    const transport = new SocketServerTransport(socket as any)
    const message = { type: 'test', payload: [1, 2, 3] }

    await transport.send(message as any)

    expect(socket.emit).toHaveBeenCalledWith('authMessage', message)
  })

  test('onData() registers callback that receives authMessage events', async () => {
    const socket = createMockSocket()
    const transport = new SocketServerTransport(socket as any)
    const callback = jest.fn()
    const message = { type: 'test', payload: [4, 5, 6] }

    await transport.onData(callback)

    expect(socket.on).toHaveBeenCalledWith('authMessage', expect.any(Function))

    // Simulate receiving a message
    await socket._fire('authMessage', message)

    expect(callback).toHaveBeenCalledWith(message)
  })
})
