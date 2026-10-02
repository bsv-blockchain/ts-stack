/* eslint-env jest */
import { WalletClient, AuthFetch } from '@bsv/sdk'
import { jest } from '@jest/globals'

/**
 * Live-socket behaviour that three defects used to break: a room left
 * unjoinable after a disconnect, an orphaned socket acting on its successor,
 * and rooms lost on reconnect. Runs without a relay, a wallet or a network.
 *
 * Run just this file:
 *   pnpm --filter @bsv/message-box-client exec node --experimental-vm-modules \
 *     node_modules/jest/bin/jest.js --config=jest.config.ts --watchman=false \
 *     src/__tests/MessageBoxClient.liveSocketDefects.test.ts
 */

/**
 * One mock per construction, shaped like production's AuthSocketClientImpl:
 * `on`, `emit`, `disconnect` and `connected`, and no `off`. Handlers are kept
 * per event so listener accumulation is observable.
 */
interface MockSocket {
  handlers: Record<string, Array<(...args: any[]) => void>>
  on: jest.Mock
  emit: jest.Mock
  disconnect: jest.Mock
  connected: boolean
  serverIdentityKey: string
}
const sockets: MockSocket[] = []
const latest = (): MockSocket => sockets[sockets.length - 1]
const makeSocket = (): MockSocket => {
  const socket: MockSocket = {
    handlers: {},
    on: jest.fn((event: string, callback: (...args: any[]) => void) => {
      ;(socket.handlers[event] ??= []).push(callback)
    }),
    emit: jest.fn(),
    // Socket.IO reports an explicit close on the socket's own handlers.
    disconnect: jest.fn(() => {
      if (!socket.connected) return
      socket.connected = false
      fireOn(socket, 'disconnect', 'io client disconnect')
    }),
    connected: true,
    serverIdentityKey: '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
  }
  sockets.push(socket)
  return socket
}
const fireOn = (socket: MockSocket, event: string, ...args: any[]): void => {
  for (const handler of socket.handlers[event] ?? []) handler(...args)
}
const fire = (event: string, ...args: any[]): void => fireOn(latest(), event, ...args)
const handlerCount = (socket: MockSocket): number =>
  Object.values(socket.handlers).reduce((n, list) => n + list.length, 0)

jest.unstable_mockModule('@bsv/authsocket-client', () => ({
  AuthSocketClient: jest.fn(() => makeSocket())
}))

const { AuthSocketClient } = await import('@bsv/authsocket-client')
const { MessageBoxClient } = await import('../MessageBoxClient.js')

const IDENTITY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const BOX = 'test_inbox'
const ROOM = `${IDENTITY}-${BOX}`

jest.spyOn(WalletClient.prototype, 'getPublicKey').mockResolvedValue({ publicKey: IDENTITY })
jest.spyOn(WalletClient.prototype, 'createHmac').mockResolvedValue({
  hmac: Array<number>(32).fill(1)
})
jest.spyOn(WalletClient.prototype, 'createSignature').mockResolvedValue({ signature: [1, 2, 3] })
jest.spyOn(MessageBoxClient.prototype as any, 'anointHost').mockImplementation(async () => ({
  txid: 'mocked-anoint-txid'
}))
jest
  .spyOn(MessageBoxClient.prototype as any, 'queryAdvertisements')
  .mockResolvedValue([] as string[])
jest.spyOn(AuthFetch.prototype, 'fetch').mockResolvedValue({
  json: async () => ({ status: 'success', message: 'Mocked response' }),
  headers: new Headers({
    'x-bsv-auth-identity-key': '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
  }),
  ok: true,
  status: 200
} as unknown as Response)

/** Authenticates whichever socket exists once the client has built it. */
const authenticateSoon = (): void => {
  setTimeout(() => fire('authenticationSuccess'), 10)
}

const connected = async (
  socketOptions?: Record<string, unknown>
): Promise<InstanceType<typeof MessageBoxClient>> => {
  const client = new MessageBoxClient({
    walletClient: new WalletClient(),
    host: 'https://message-box-us-1.bsvb.tech',
    socketOptions: socketOptions as any
  })
  await client.init()
  const connecting = client.initializeConnection()
  authenticateSoon()
  await connecting
  return client
}

const joinRoomEmits = (socket: MockSocket): unknown[][] =>
  socket.emit.mock.calls.filter(call => call[0] === 'joinRoom')

const drop = (socket: MockSocket, reason = 'transport close'): void => {
  socket.connected = false
  fireOn(socket, 'disconnect', reason)
}

const reconnect = (socket: MockSocket): void => {
  socket.connected = true
  fireOn(socket, 'connect')
  fireOn(socket, 'authenticationSuccess')
}

describe('live-socket reconnection', () => {
  beforeEach(() => {
    sockets.length = 0
    ;(AuthSocketClient as jest.Mock).mockClear()
  })

  /** Membership is per socket, so a new one has to join for itself. */
  it('rejoins a room after disconnectWebSocket', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    expect(joinRoomEmits(latest())).toHaveLength(1)

    await client.disconnectWebSocket()
    expect(client.getJoinedRooms().has(ROOM)).toBe(false)

    authenticateSoon()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })

    expect(sockets).toHaveLength(2)
    expect(joinRoomEmits(latest())).toHaveLength(1)
  })

  /** A transient drop is Socket.IO's to retry; the client restores the subscription. */
  it('keeps a dropped socket and rejoins its rooms when connect fires again', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    const socket = latest()

    drop(socket)

    expect(client.testSocket).toBe(socket)
    expect(socket.disconnect).not.toHaveBeenCalled()
    expect(client.getJoinedRooms().size).toBe(0)

    socket.emit.mockClear()
    socket.connected = true
    fireOn(socket, 'connect')
    expect(joinRoomEmits(socket)).toHaveLength(0)
    fireOn(socket, 'authenticationSuccess')

    expect(joinRoomEmits(socket)).toEqual([['joinRoom', ROOM]])
    expect(client.getJoinedRooms().has(ROOM)).toBe(true)
    expect(client.testSocket).toBe(socket)
    expect(sockets).toHaveLength(1)
  })

  it('joins through the attempt in flight rather than building a second connection', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    const socket = latest()

    drop(socket)
    socket.emit.mockClear()

    let joined = false
    const joining = client.joinRoom('other_inbox').then(() => {
      joined = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(joined).toBe(false)
    expect(joinRoomEmits(socket)).toHaveLength(0)

    reconnect(socket)
    await joining

    expect(sockets).toHaveLength(1)
    expect(joinRoomEmits(socket).map(call => call[1])).toEqual([ROOM, `${IDENTITY}-other_inbox`])
  })

  it('does not accumulate listeners across reconnects', async () => {
    const client = await connected()
    const socket = latest()
    const before = handlerCount(socket)

    for (let i = 0; i < 3; i++) {
      drop(socket)
      reconnect(socket)
    }

    expect(handlerCount(socket)).toBe(before)
    expect(client.testSocket).toBe(socket)
  })

  it('treats a requested disconnect as terminal', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    const socket = latest()
    await client.disconnectWebSocket()

    expect(socket.disconnect).toHaveBeenCalledTimes(1)
    expect(client.testSocket).toBeUndefined()
    expect(sockets).toHaveLength(1)
    socket.emit.mockClear()
    fireOn(socket, 'connect')
    fireOn(socket, 'authenticationSuccess')
    expect(joinRoomEmits(socket)).toHaveLength(0)
  })

  /** Socket.IO does not retry a server-forced disconnect, and a listener makes no calls to trigger a rebuild. */
  it('rebuilds a listener on its own after a server disconnect', async () => {
    const client = await connected()
    const onMessage = jest.fn()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage })
    const dead = latest()

    authenticateSoon()
    drop(dead, 'io server disconnect')
    await new Promise(resolve => setTimeout(resolve, 50))

    const rebuilt = latest()
    expect(rebuilt).not.toBe(dead)
    expect(client.testSocket).toBe(rebuilt)
    expect(joinRoomEmits(rebuilt).map(call => call[1])).toEqual([ROOM])
    const handlers = rebuilt.handlers[`sendMessage-${ROOM}`] ?? []
    expect(handlers).toHaveLength(1)

    handlers[0]({ sender: IDENTITY, messageId: 'm1', body: 'hello' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  it('rebuilds only once when the server keeps dropping the new socket before it authenticates', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })

    drop(latest(), 'io server disconnect')
    expect(sockets).toHaveLength(2)
    drop(latest(), 'io server disconnect')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sockets).toHaveLength(2)
    expect(client.testSocket).toBeUndefined()
  })

  /** A client-side disconnect, including the wrapper's own after an error, is not retried. */
  it('does not rebuild on a client-initiated disconnect it did not request', async () => {
    const client = await connected()
    drop(latest(), 'io client disconnect')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(sockets).toHaveLength(1)
    expect(client.testSocket).toBeUndefined()
  })

  /** Socket.IO will never retry, so the drop is read as terminal rather than waited out. */
  it('disposes on a drop when reconnection is disabled, and rebuilds on the next listen', async () => {
    const client = await connected({ managerOptions: { reconnection: false } })
    const onMessage = jest.fn()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage })
    const dead = latest()

    drop(dead, 'io server disconnect')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(sockets).toHaveLength(1)
    expect(client.testSocket).toBeUndefined()
    expect(client.getJoinedRooms().size).toBe(0)

    authenticateSoon()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage })

    const rebuilt = latest()
    expect(rebuilt).not.toBe(dead)
    expect(joinRoomEmits(rebuilt).map(call => call[1])).toEqual([ROOM])
    const handlers = rebuilt.handlers[`sendMessage-${ROOM}`] ?? []
    expect(handlers).toHaveLength(1)
    handlers[0]({ sender: IDENTITY, messageId: 'm1', body: 'hello' })
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(onMessage).toHaveBeenCalledTimes(1)
  })

  /** Bounded attempts running out leave a non-null dead socket; a timed-out wait marks it. */
  it('rebuilds once a wait times out with the socket still down', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    const dead = latest()

    drop(dead)
    await expect(client.joinRoom('other_inbox')).rejects.toThrow(/timed out/)

    authenticateSoon()
    await client.joinRoom('other_inbox')

    expect(sockets).toHaveLength(2)
    expect(dead.disconnect).toHaveBeenCalledTimes(1)
    expect(joinRoomEmits(latest()).map(call => call[1])).toContain(ROOM)
  }, 15000)

  /**
   * A replaced socket keeps its handlers — there is no `off` to take them away.
   * Everything it reports afterwards belongs to a connection the client no
   * longer uses, and must not reach the one that took its place.
   */
  it('ignores a replaced socket that reports again', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    const orphan = latest()
    expect(joinRoomEmits(orphan)).toHaveLength(1)

    authenticateSoon()
    drop(orphan, 'io server disconnect')
    await new Promise(resolve => setTimeout(resolve, 50))

    const live = latest()
    expect(live).not.toBe(orphan)
    expect(client.testSocket).toBe(live)

    // The orphan comes back underneath and runs its own handlers.
    orphan.connected = true
    fireOn(orphan, 'connect')
    fireOn(orphan, 'authenticationSuccess')
    expect(joinRoomEmits(orphan)).toHaveLength(1)
    expect(client.testSocket).toBe(live)

    // And its next drop must not take the live socket with it.
    drop(orphan, 'io server disconnect')
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(client.testSocket).toBe(live)
    expect(sockets).toHaveLength(2)
  })

  /** A socket can stop carrying without ever reporting a disconnect. */
  it('does not report ready on a socket that is no longer connected', async () => {
    const client = await connected()
    const socket = latest()
    socket.connected = false

    let ready = false
    const connecting = client.initializeConnection().then(() => {
      ready = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(ready).toBe(false)

    socket.connected = true
    fireOn(socket, 'authenticationSuccess')
    await connecting
    expect(sockets).toHaveLength(1)
  })

  /** Leaving while down must not leave a claim that the next connect rejoins. */
  it('leaves a room while disconnected', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    const socket = latest()

    drop(socket)
    await client.leaveRoom(BOX)
    socket.emit.mockClear()

    reconnect(socket)
    expect(joinRoomEmits(socket)).toHaveLength(0)
    expect(client.getJoinedRooms().has(ROOM)).toBe(false)
  })

  it('rejects the wait when the server refuses authentication', async () => {
    const client = new MessageBoxClient({
      walletClient: new WalletClient(),
      host: 'https://message-box-us-1.bsvb.tech'
    })
    await client.init()
    const connecting = client.initializeConnection()
    setTimeout(() => fire('authenticationFailed'), 10)

    await expect(connecting).rejects.toThrow(/authentication failed/)
    expect(sockets).toHaveLength(1)
  })

  /** Socket.IO got it back on its own; nothing needs rebuilding. */
  it('reuses a socket that reconnects after its wait timed out', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    const socket = latest()

    drop(socket)
    await expect(client.initializeConnection()).rejects.toThrow(/timed out/)

    socket.emit.mockClear()
    reconnect(socket)
    await client.joinRoom(BOX)

    expect(sockets).toHaveLength(1)
    expect(client.testSocket).toBe(socket)
    expect(joinRoomEmits(socket).map(call => call[1])).toEqual([ROOM])
  }, 15000)
})
