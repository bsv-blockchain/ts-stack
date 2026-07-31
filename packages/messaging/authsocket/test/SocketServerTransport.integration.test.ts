import { createServer } from 'node:http'
import { AddressInfo } from 'node:net'
import { Server as IoServer } from 'socket.io'
import { io as createClient, Socket as ClientSocket } from 'socket.io-client'

import { SocketServerTransport } from '../src/SocketServerTransport.js'

function waitForEvent(socket: ClientSocket, eventName: string): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${eventName}`)), 5000)
    socket.once(eventName, (...args: unknown[]) => {
      clearTimeout(timeout)
      resolve(args)
    })
  })
}

describe('SocketServerTransport process survival', () => {
  test('isolates a malicious peer and continues serving a subsequent connection', async () => {
    const httpServer = createServer()
    const ioServer = new IoServer(httpServer, { transports: ['websocket'] })
    const containedErrors: unknown[] = []
    let connectionCount = 0
    let acceptSecondMessage: (() => void) | undefined
    const secondMessage = new Promise<void>(resolve => {
      acceptSecondMessage = resolve
    })

    ioServer.on('connection', socket => {
      connectionCount += 1
      const connectionNumber = connectionCount
      const transport = new SocketServerTransport(socket, {
        onError: error => {
          containedErrors.push(error)
        }
      })
      void transport.onData(async () => {
        if (connectionNumber === 1) throw new Error('invalid signature')
        acceptSecondMessage?.()
      })
    })

    await new Promise<void>(resolve => httpServer.listen(0, '127.0.0.1', resolve))
    const { port } = httpServer.address() as AddressInfo
    const url = `http://127.0.0.1:${port}`
    const firstClient = createClient(url, {
      transports: ['websocket'],
      forceNew: true,
      reconnection: false
    })
    let secondClient: ClientSocket | undefined

    try {
      await waitForEvent(firstClient, 'connect')
      const disconnected = waitForEvent(firstClient, 'disconnect')
      firstClient.emit('authMessage', { messageType: 'initialResponse' })
      await disconnected

      expect(containedErrors).toEqual([expect.objectContaining({ message: 'invalid signature' })])
      expect(httpServer.listening).toBe(true)

      secondClient = createClient(url, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: false
      })
      await waitForEvent(secondClient, 'connect')
      secondClient.emit('authMessage', { messageType: 'initialRequest' })
      await secondMessage

      expect(connectionCount).toBe(2)
      expect(httpServer.listening).toBe(true)
    } finally {
      firstClient.disconnect()
      secondClient?.disconnect()
      await new Promise<void>(resolve => ioServer.close(() => resolve()))
    }
  })
})
