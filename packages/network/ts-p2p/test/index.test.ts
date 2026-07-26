import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals'

const createLibp2p = jest.fn()
const generateKeyPair = jest.fn(async () => ({ type: 'Ed25519' }))
const multiaddr = jest.fn((address: string) => address)
const preSharedKey = jest.fn(() => 'connection-protector')
const tcp = jest.fn(() => 'tcp')
const noise = jest.fn(() => 'noise')
const yamux = jest.fn(() => 'yamux')
const bootstrap = jest.fn(() => 'bootstrap')
const pubsubPeerDiscovery = jest.fn(() => 'pubsub-discovery')
const kadDHT = jest.fn(() => 'dht')
const gossipsub = jest.fn(() => 'pubsub')
const identify = jest.fn(() => 'identify')
const ping = jest.fn(() => 'ping')

jest.unstable_mockModule('libp2p', () => ({ createLibp2p }))
jest.unstable_mockModule('@libp2p/crypto/keys', () => ({ generateKeyPair }))
jest.unstable_mockModule('@multiformats/multiaddr', () => ({ multiaddr }))
jest.unstable_mockModule('@libp2p/pnet', () => ({ preSharedKey }))
jest.unstable_mockModule('@libp2p/tcp', () => ({ tcp }))
jest.unstable_mockModule('@chainsafe/libp2p-noise', () => ({ noise }))
jest.unstable_mockModule('@chainsafe/libp2p-yamux', () => ({ yamux }))
jest.unstable_mockModule('@libp2p/bootstrap', () => ({ bootstrap }))
jest.unstable_mockModule('@libp2p/pubsub-peer-discovery', () => ({ pubsubPeerDiscovery }))
jest.unstable_mockModule('@libp2p/kad-dht', () => ({ kadDHT }))
jest.unstable_mockModule('@chainsafe/libp2p-gossipsub', () => ({ gossipsub }))
jest.unstable_mockModule('@libp2p/identify', () => ({ identify }))
jest.unstable_mockModule('@libp2p/ping', () => ({ ping }))

type IndexModule = typeof import('../src/index.js')
let TeranodeListener: IndexModule['TeranodeListener']
let startSubscriber: IndexModule['startSubscriber']

interface MockNode {
  addEventListener: jest.Mock
  dial: jest.Mock
  getPeers: jest.Mock
  peerId: { toString: () => string }
  services: {
    pubsub: {
      addEventListener: jest.Mock
      subscribe: jest.Mock
      unsubscribe: jest.Mock
    }
  }
  start: jest.Mock
  stop: jest.Mock
}

function mockNode(): {
  eventHandlers: Record<string, (event: any) => void>
  messageHandlers: Record<string, (event: any) => void>
  node: MockNode
} {
  const eventHandlers: Record<string, (event: any) => void> = {}
  const messageHandlers: Record<string, (event: any) => void> = {}
  const node: MockNode = {
    addEventListener: jest.fn((name: string, handler: (event: any) => void) => {
      eventHandlers[name] = handler
    }),
    dial: jest.fn().mockResolvedValue(undefined),
    getPeers: jest.fn(() => [{ toString: () => 'connected-peer' }]),
    peerId: { toString: () => 'local-peer' },
    services: {
      pubsub: {
        addEventListener: jest.fn((name: string, handler: (event: any) => void) => {
          messageHandlers[name] = handler
        }),
        subscribe: jest.fn(),
        unsubscribe: jest.fn()
      }
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined)
  }
  return { eventHandlers, messageHandlers, node }
}

const topic = 'bitcoin/mainnet-bestblock' as const
const frame = (payload: unknown): Uint8Array => {
  const data = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return new TextEncoder().encode(JSON.stringify({ name: 'sender', data }))
}

beforeAll(async () => {
  ;({ TeranodeListener, startSubscriber } = await import('../src/index.js'))
})

beforeEach(() => {
  jest.clearAllMocks()
})

describe('TeranodeListener', () => {
  it('starts, dispatches raw messages, manages subscriptions, and stops cleanly', async () => {
    const { eventHandlers, messageHandlers, node } = mockNode()
    createLibp2p.mockResolvedValue(node)
    const callback = jest.fn()
    const listener = new TeranodeListener(
      { [topic]: callback },
      {
        bootstrapPeers: ['/dns4/bootstrap.example/tcp/1'],
        staticPeers: [],
        sharedKey: 'abcd',
        dhtProtocolID: '/custom',
        listenAddresses: ['/ip4/127.0.0.1/tcp/1']
      }
    )
    const initialSigintListeners = process.listenerCount('SIGINT')

    await listener.start()

    expect(listener.getNode()).toBe(node)
    expect(listener.getConnectedPeerCount()).toBe(1)
    expect(node.start).toHaveBeenCalledTimes(1)
    expect(createLibp2p).toHaveBeenCalledWith(
      expect.objectContaining({
        addresses: { listen: ['/ip4/127.0.0.1/tcp/1'] }
      })
    )
    expect(kadDHT).toHaveBeenCalledWith(
      expect.objectContaining({
        protocol: '/custom/kad/1.0.0'
      })
    )
    expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners + 1)

    messageHandlers['gossipsub:message']({
      detail: {
        msg: { topic, data: Uint8Array.from([1, 2, 3]) },
        propagationSource: { toString: () => 'remote-peer' }
      }
    })
    expect(callback).toHaveBeenCalledWith(Uint8Array.from([1, 2, 3]), topic, 'remote-peer')

    eventHandlers['peer:discovery']({ detail: { id: { toString: () => 'found-peer' } } })
    eventHandlers['peer:connect']({ detail: { toString: () => 'joined-peer' } })
    eventHandlers['peer:disconnect']({ detail: { toString: () => 'left-peer' } })

    const secondTopic = 'bitcoin/mainnet-block'
    listener.addTopicCallback(secondTopic, jest.fn())
    expect(node.services.pubsub.subscribe).toHaveBeenCalledWith(secondTopic)
    listener.removeTopicCallback(secondTopic)
    expect(node.services.pubsub.unsubscribe).toHaveBeenCalledWith(secondTopic)

    await listener.start()
    expect(node.start).toHaveBeenCalledTimes(1)

    await listener.stop()
    expect(node.stop).toHaveBeenCalledTimes(1)
    expect(listener.getNode()).toBeNull()
    expect(listener.getConnectedPeerCount()).toBe(0)
    expect(process.listenerCount('SIGINT')).toBe(initialSigintListeners)
    await listener.stop()
  })

  it('decodes valid messages, skips invalid frames, and isolates callback errors', async () => {
    const { messageHandlers, node } = mockNode()
    createLibp2p.mockResolvedValue(node)
    const callback = jest.fn()
    const listener = new TeranodeListener(
      { [topic]: callback },
      { decodeMessages: true, staticPeers: [] }
    )
    await listener.start()
    const dispatch = messageHandlers['gossipsub:message']

    dispatch({
      detail: {
        msg: { topic, data: frame({ Height: 42 }) },
        propagationSource: { toString: () => 'remote-peer' }
      }
    })
    dispatch({
      detail: {
        msg: { topic, data: Uint8Array.from([0xff]) },
        propagationSource: { toString: () => 'remote-peer' }
      }
    })
    dispatch({
      detail: {
        msg: { topic: 'bitcoin/testnet-block', data: Uint8Array.from([1]) },
        propagationSource: { toString: () => 'remote-peer' }
      }
    })
    callback.mockImplementationOnce(() => {
      throw new Error('consumer failure')
    })
    dispatch({
      detail: {
        msg: { topic, data: frame({ Height: 43 }) },
        propagationSource: { toString: () => 'remote-peer' }
      }
    })

    expect(callback).toHaveBeenCalledTimes(2)
    expect(callback).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ sender: 'sender', payload: { Height: 42 } }),
      topic,
      'remote-peer'
    )
    await listener.stop()
  })

  it('connects static peers independently and retries disconnected peers', async () => {
    jest.useFakeTimers()
    const { node } = mockNode()
    node.dial.mockImplementation(async (address: string) => {
      if (address.includes('unreachable')) throw new Error('offline')
    })
    node.getPeers.mockReturnValue([])
    createLibp2p.mockResolvedValue(node)
    const listener = new TeranodeListener(
      { [topic]: jest.fn() },
      {
        staticPeers: [
          '/dns4/reachable.example/tcp/1/p2p/reachable',
          '/dns4/unreachable.example/tcp/1/p2p/unreachable',
          '/dns4/no-peer-id.example/tcp/1'
        ]
      }
    )

    await listener.start()
    expect(node.dial).toHaveBeenCalledTimes(3)

    await jest.advanceTimersByTimeAsync(30_000)
    expect(node.dial).toHaveBeenCalledTimes(5)

    await listener.stop()
    jest.useRealTimers()
  })
})

describe('startSubscriber', () => {
  it('adapts the legacy topic list to a listener lifecycle', async () => {
    const { node } = mockNode()
    createLibp2p.mockResolvedValue(node)
    const before = new Set(process.listeners('SIGINT'))

    await startSubscriber({ topics: [topic], staticPeers: [] })

    expect(node.services.pubsub.subscribe).toHaveBeenCalledWith(topic)
    const shutdown = process.listeners('SIGINT').find(listener => !before.has(listener))
    expect(shutdown).toBeDefined()
    shutdown?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(node.stop).toHaveBeenCalledTimes(1)
  })
})
