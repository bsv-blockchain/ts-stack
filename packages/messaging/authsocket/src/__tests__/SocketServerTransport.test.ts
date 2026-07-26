import { SocketServerTransport } from '../SocketServerTransport.js'

describe('SocketServerTransport', () => {
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

  test('send() emits authMessage on the socket', async () => {
    const socket = createMockSocket()
    const transport = new SocketServerTransport(socket as never)
    const message = { type: 'test', payload: [1, 2, 3] }

    await transport.send(message as never)

    expect(socket.emit).toHaveBeenCalledWith('authMessage', message)
  })

  test('onData() registers callback that receives authMessage events', async () => {
    const socket = createMockSocket()
    const transport = new SocketServerTransport(socket as never)
    const callback = jest.fn()
    const message = { type: 'test', payload: [4, 5, 6] }

    await transport.onData(callback)

    expect(socket.on).toHaveBeenCalledWith('authMessage', expect.any(Function))

    await socket.fire('authMessage', message)

    expect(callback).toHaveBeenCalledWith(message)
  })
})
