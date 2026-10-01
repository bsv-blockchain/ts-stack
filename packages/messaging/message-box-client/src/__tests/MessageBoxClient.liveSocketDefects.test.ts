/* eslint-env jest */
import { WalletClient, AuthFetch } from '@bsv/sdk'
import { jest } from '@jest/globals'

/**
 * Live-socket behaviour that three defects used to break: a room left
 * unjoinable after a disconnect, and a dropped socket left reconnecting
 * unattended. Both ran without a relay, a wallet or a network, and both began
 * as characterisation tests asserting the broken behaviour.
 *
 * Run just this file:
 *   pnpm --filter @bsv/message-box-client exec node --experimental-vm-modules \
 *     node_modules/jest/bin/jest.js --config=jest.config.ts --watchman=false \
 *     src/__tests/MessageBoxClient.liveSocketDefects.test.ts
 */

/**
 * Every handler per event, not just the last. The client registers more than
 * one `disconnect` listener — an auth-phase one and the long-lived one that
 * drops `this.socket` — so keeping only the latest fires the wrong one.
 */
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
  // Really removes, so the harness follows the client's own lifecycle: it
  // detaches its auth-phase disconnect handler once authentication completes,
  // and a mock that ignored `off` would keep firing a listener the client has
  // already let go of.
  off: jest.fn((event: string, callback: (...args: any[]) => void) => {
    socketOnMap[event] = (socketOnMap[event] ?? []).filter(h => h !== callback)
  }),
  serverIdentityKey: '02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5'
}

jest.unstable_mockModule('@bsv/authsocket-client', () => ({
  AuthSocketClient: jest.fn(() => mockSocket)
}))

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
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })

    expect(joinRoomEmits()).toHaveLength(1)
  })

  /**
   * Socket.IO reconnects by default, and a dropped socket's handlers still read
   * `this.socket`, so one left running would authenticate on its replacement.
   */
  it('disposes a dropped socket instead of leaving it reconnecting', async () => {
    const client = await connected()
    await client.listenForLiveMessages({ messageBox: BOX, onMessage: () => {} })

    // Three `disconnect` listeners are attached by this point and none are
    // detached, which is why the harness fires every one: storing only the
    // latest ran an auth-phase handler that touches a flag and not the socket,
    // and the first version of this test "proved" the opposite by doing so.
    // The before/after pair below is the real proof — only the long-lived
    // handler can clear the reference.
    expect(client.testSocket).toBeDefined()
    fire('disconnect')

    // The client has let go of it, but never told it to stop.
    expect(client.testSocket).toBeUndefined()
    expect(mockSocket.disconnect).toHaveBeenCalled()
    expect(client.getJoinedRooms().size).toBe(0)
  })

  /**
   * Not covered here: `leaveRoom` now drops the room before its no-socket
   * guard, so leaving while disconnected clears the claim. Reaching it needs
   * `assertInitialized` to pass after a disconnect, and stubbing that far pulls
   * in a server-identity check this harness does not model.
   */
})
