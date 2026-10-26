import type { AuthSocket } from '@bsv/authsocket'
import { WebSocketConnectionRegistry, WebSocketMinuteRateLimiter } from './webSocketConnections.js'

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

  it('bounds process connections, connections per identity, and rooms per socket', () => {
    const registry = new WebSocketConnectionRegistry()
    const first = fakeSocket('first')
    const second = fakeSocket('second')
    const third = fakeSocket('third')

    expect(registry.register(first.socket, undefined, 2)).toBe(true)
    expect(registry.register(second.socket, undefined, 2)).toBe(true)
    expect(registry.register(third.socket, undefined, 2)).toBe(false)
    expect(registry.connectionCount()).toBe(2)

    expect(registry.authenticate(first.socket.id, 'alice', 1)).toBe(true)
    expect(registry.authenticate(second.socket.id, 'alice', 1)).toBe(false)
    expect(registry.authenticate(second.socket.id, 'bob', 1)).toBe(true)
    expect(registry.authenticate(second.socket.id, 'mallory', 1)).toBe(false)

    expect(registry.join(first.socket.id, 'alice-one', 2)).toBe(true)
    expect(registry.join(first.socket.id, 'alice-two', 2)).toBe(true)
    expect(registry.join(first.socket.id, 'alice-two', 2)).toBe(true)
    expect(registry.join(first.socket.id, 'alice-three', 2)).toBe(false)
    expect(registry.roomCount(first.socket.id)).toBe(2)
  })
})

describe('Message Box WebSocket event limiter', () => {
  it('bounds every event and resets only after the complete window', () => {
    const limiter = new WebSocketMinuteRateLimiter(2, 1_000)

    expect(limiter.consume(1_000)).toBe(true)
    expect(limiter.consume(60_999)).toBe(true)
    expect(limiter.consume(60_999)).toBe(false)
    expect(limiter.consume(61_000)).toBe(true)
  })

  it('supports the explicit unlimited resource profile', () => {
    const limiter = new WebSocketMinuteRateLimiter(-1, 1_000)
    for (let index = 0; index < 10_000; index++) expect(limiter.consume(1_000)).toBe(true)
  })
})
