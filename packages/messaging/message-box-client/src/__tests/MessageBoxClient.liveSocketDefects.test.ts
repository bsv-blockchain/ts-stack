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

/** Every handler per event, so listener accumulation is observable. */
const socketOnMap: Record<string, Array<(...args: any[]) => void>> = {}
const fire = (event: string, ...args: any[]): void => {
  for (const handler of socketOnMap[event] ?? []) handler(...args)
}

const mockSocket = {
  on: jest.fn((event: string, callback: (...args: any[]) => void) => {
    ;(socketOnMap[event] ??= []).push(callback)
  }),
  emit: jest.fn(),
  disconnect: jest.fn(),
  connected: true,
  // Really removes, as Socket.IO's does.
  off: jest.fn((event: string, callback: (...args: any[]) => void) => {
    socketOnMap[event] = (socketOnMap[event] ?? []).filter(h => h !== callback)
  }),
  serverIdentityKey: '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
}

jest.unstable_mockModule('@bsv/authsocket-client', () => ({
  AuthSocketClient: jest.fn(() => mockSocket)
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

const connected = async (): Promise<InstanceType<typeof MessageBoxClient>> => {
  const client = new MessageBoxClient({
    walletClient: new WalletClient(),
    host: 'https://message-box-us-1.bsvb.tech'
  })
  await client.init()
  const connecting = client.initializeConnection()
  setTimeout(() => fire('authenticationSuccess', { status: 'ok' }), 0)
  await connecting
  return client
}

const joinRoomEmits = (): unknown[][] =>
  mockSocket.emit.mock.calls.filter(call => call[0] === 'joinRoom')

describe('live-socket defects, as the client behaves today', () => {
  beforeEach(() => {
    for (const event of Object.keys(socketOnMap)) delete socketOnMap[event]
    mockSocket.emit.mockClear()
    mockSocket.disconnect.mockClear()
    mockSocket.connected = true
  })

  /** Membership is per socket, so a new one has to join for itself. */
  it('rejoins a room after disconnectWebSocket', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    expect(joinRoomEmits()).toHaveLength(1)

    await client.disconnectWebSocket()
    expect(client.getJoinedRooms().has(ROOM)).toBe(false)

    mockSocket.emit.mockClear()
    setTimeout(() => fire('authenticationSuccess'), 0)
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })

    expect(joinRoomEmits()).toHaveLength(1)
  })

  /** A transient drop is Socket.IO's to retry; the client restores the subscription. */
  it('keeps a dropped socket and rejoins its rooms when connect fires again', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    const socket = client.testSocket

    mockSocket.connected = false
    fire('disconnect', 'transport close')

    expect(client.testSocket).toBe(socket)
    expect(mockSocket.disconnect).not.toHaveBeenCalled()
    expect(client.getJoinedRooms().size).toBe(0)

    mockSocket.emit.mockClear()
    mockSocket.connected = true
    fire('connect')
    expect(joinRoomEmits()).toHaveLength(0)
    fire('authenticationSuccess')

    expect(joinRoomEmits()).toEqual([['joinRoom', ROOM]])
    expect(client.getJoinedRooms().has(ROOM)).toBe(true)
    expect(client.testSocket).toBe(socket)
  })

  it('joins through the attempt in flight rather than building a second connection', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    const constructed = (AuthSocketClient as jest.Mock).mock.calls.length

    mockSocket.connected = false
    fire('disconnect', 'transport close')
    mockSocket.emit.mockClear()

    let joined = false
    const joining = client.joinRoom('other_inbox').then(() => {
      joined = true
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(joined).toBe(false)
    expect(joinRoomEmits()).toHaveLength(0)

    mockSocket.connected = true
    fire('connect')
    fire('authenticationSuccess')
    await joining

    expect((AuthSocketClient as jest.Mock).mock.calls).toHaveLength(constructed)
    expect(joinRoomEmits().map(call => call[1])).toEqual([ROOM, `${IDENTITY}-other_inbox`])
  })

  it('does not accumulate listeners across reconnects', async () => {
    const client = await connected()
    const counts = (): number[] => Object.values(socketOnMap).map(handlers => handlers.length)
    const before = counts()

    for (let i = 0; i < 3; i++) {
      mockSocket.connected = false
      fire('disconnect', 'transport close')
      mockSocket.connected = true
      fire('connect')
      fire('authenticationSuccess')
    }

    expect(counts()).toEqual(before)
    expect(client.testSocket).toBeDefined()
  })

  it('treats a requested disconnect as terminal', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })
    await client.disconnectWebSocket()

    expect(mockSocket.disconnect).toHaveBeenCalledTimes(1)
    expect(client.testSocket).toBeUndefined()
    mockSocket.emit.mockClear()
    fire('connect')
    fire('authenticationSuccess')
    expect(joinRoomEmits()).toHaveLength(0)
  })

  /**
   * Not covered here: `leaveRoom` now drops the room before its no-socket
   * guard, so leaving while disconnected clears the claim. Reaching it needs
   * `assertInitialized` to pass after a disconnect, and stubbing that far pulls
   * in a server-identity check this harness does not model.
   */
})
