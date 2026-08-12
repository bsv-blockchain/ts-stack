import type { AuthSocket } from '@bsv/authsocket'
import { WebSocketConnectionRegistry } from './webSocketConnections.js'

interface FakeSocket {
  socket: AuthSocket
  disconnect: (reason?: string) => void
}

function fakeSocket(id: string): FakeSocket {
  let disconnectHandler: ((reason: string) => void) | undefined
  const ioSocket = {
    once: jest.fn((eventName: string, handler: (reason: string) => void) => {
      if (eventName === 'disconnect') disconnectHandler = handler
    })
  }
  return {
    socket: { id, ioSocket } as unknown as AuthSocket,
    disconnect: (reason = 'transport close') => disconnectHandler?.(reason)
  }
}

describe('Message Box WebSocket connection registry', () => {
  it("routes bidirectionally only through each recipient's joined room", () => {
    const registry = new WebSocketConnectionRegistry()
    const alice = fakeSocket('alice-socket')
    const bob = fakeSocket('bob-socket')
    const bobOtherBox = fakeSocket('bob-other-box')

    registry.register(alice.socket)
    registry.register(bob.socket)
    registry.register(bobOtherBox.socket)
    registry.authenticate(alice.socket.id, 'alice')
    registry.authenticate(bob.socket.id, 'bob')
    registry.authenticate(bobOtherBox.socket.id, 'bob')
    expect(registry.identityKey(alice.socket.id)).toBe('alice')
    registry.join(alice.socket.id, 'alice-document')
    registry.join(bob.socket.id, 'bob-document')
    registry.join(bobOtherBox.socket.id, 'bob-unrelated')

    expect(registry.recipientSockets('bob', 'bob-document', 25)).toEqual([bob.socket])
    expect(registry.recipientSockets('alice', 'alice-document', 25)).toEqual([alice.socket])
    expect(registry.recipientSockets('bob', 'bob-missing', 25)).toEqual([])
  })

  it('removes identity, socket, and room state on the raw Socket.IO disconnect', () => {
    const registry = new WebSocketConnectionRegistry()
    const alice = fakeSocket('alice-socket')
    const onDisconnect = jest.fn()

    registry.register(alice.socket, onDisconnect)
    registry.authenticate(alice.socket.id, 'alice')
    registry.join(alice.socket.id, 'alice-document')
    expect(registry.recipientSockets('alice', 'alice-document', 25)).toEqual([alice.socket])

    alice.disconnect('client namespace disconnect')

    expect(registry.recipientSockets('alice', 'alice-document', 25)).toEqual([])
    expect(onDisconnect).toHaveBeenCalledWith('client namespace disconnect')
  })

  it('bounds exact-room delivery to the newest active recipient connections', () => {
    const registry = new WebSocketConnectionRegistry()
    const sockets = Array.from({ length: 30 }, (_, index) => fakeSocket(`bob-${index}`))
    for (const { socket } of sockets) {
      registry.register(socket)
      registry.authenticate(socket.id, 'bob')
      registry.join(socket.id, 'bob-document')
    }

    expect(registry.recipientSockets('bob', 'bob-document', 25).map(socket => socket.id)).toEqual(
      sockets.slice(5).map(({ socket }) => socket.id)
    )
    expect(registry.recipientSockets('bob', 'bob-document', -1)).toHaveLength(30)
  })

  it('stops delivery after a socket leaves its room', () => {
    const registry = new WebSocketConnectionRegistry()
    const bob = fakeSocket('bob-socket')
    registry.register(bob.socket)
    registry.authenticate(bob.socket.id, 'bob')
    registry.join(bob.socket.id, 'bob-document')

    registry.leave(bob.socket.id, 'bob-document')

    expect(registry.recipientSockets('bob', 'bob-document', 25)).toEqual([])
  })

  it('rejects unregistered state and clears every registered connection', () => {
    const registry = new WebSocketConnectionRegistry()
    const bob = fakeSocket('bob-socket')

    expect(registry.authenticate('missing-socket', 'bob')).toBe(false)
    expect(registry.join('missing-socket', 'bob-document')).toBe(false)
    registry.leave('missing-socket', 'bob-document')

    registry.register(bob.socket)
    registry.authenticate(bob.socket.id, 'bob')
    registry.join(bob.socket.id, 'bob-document')
    expect([...registry.sockets()]).toEqual([bob.socket])

    registry.clear()

    expect([...registry.sockets()]).toEqual([])
    expect(registry.identityKey(bob.socket.id)).toBeUndefined()
    expect(registry.recipientSockets('bob', 'bob-document', 25)).toEqual([])
  })
})
