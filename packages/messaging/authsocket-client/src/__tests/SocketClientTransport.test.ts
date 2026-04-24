import { SocketClientTransport } from '../SocketClientTransport'

describe('SocketClientTransport', () => {
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

  test('constructor subscribes to authMessage events', () => {
    const socket = createMockSocket()
    const transport = new SocketClientTransport(socket as any)

    expect(socket.on).toHaveBeenCalledWith('authMessage', expect.any(Function))
  })

  test('send() emits authMessage on the socket', async () => {
    const socket = createMockSocket()
    const transport = new SocketClientTransport(socket as any)
    const message = { type: 'test', payload: [1, 2, 3] }

    await transport.send(message as any)

    expect(socket.emit).toHaveBeenCalledWith('authMessage', message)
  })

  test('onData() registers callback that receives authMessage events', async () => {
    const socket = createMockSocket()
    const transport = new SocketClientTransport(socket as any)
    const callback = jest.fn()
    const message = { type: 'test', payload: [4, 5, 6] }

    await transport.onData(callback)

    // Simulate receiving a message from the server
    await socket._fire('authMessage', message)

    expect(callback).toHaveBeenCalledWith(message)
  })
})
