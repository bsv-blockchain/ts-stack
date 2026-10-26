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
        sharedKey: 'ab'.repeat(32),
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

  it('rejects malformed PNET key material before constructing a node', async () => {
    expect(() => new TeranodeListener({ [topic]: jest.fn() }, { sharedKey: 'abcd' })).toThrow(
      'sharedKey must encode exactly 32 bytes'
    )
    expect(createLibp2p).not.toHaveBeenCalled()
  })

  it('requires exact own runtime configuration without invoking accessors', () => {
    expect(
      () =>
        new TeranodeListener(
          { [topic]: jest.fn() },
          { decodeMessages: 'false' as unknown as boolean }
        )
    ).toThrow('decodeMessages must be a boolean')
    expect(
      () =>
        new TeranodeListener(
          { [topic]: jest.fn() },
          { usePrivateDHT: 'false' as unknown as boolean }
        )
    ).toThrow('usePrivateDHT must be a boolean')
    expect(
      () => new TeranodeListener({ [topic]: jest.fn() }, { dhtProtocolID: '/../unsafe' })
    ).toThrow('canonical protocol prefix')
    expect(() => new TeranodeListener({ ['__proto__' as typeof topic]: jest.fn() })).toThrow(
      'Unsupported Teranode topic'
    )

    const getter = jest.fn(() => false)
    const config = Object.defineProperty({}, 'decodeMessages', { get: getter })
    expect(
      () => new TeranodeListener({ [topic]: jest.fn() }, config as { decodeMessages: boolean })
    ).toThrow('listener config cannot use accessors')
    expect(getter).not.toHaveBeenCalled()

    const addressGetter = jest.fn(() => '/dns4/attacker.example/tcp/1')
    const accessorAddresses = [] as string[]
    Object.defineProperty(accessorAddresses, '0', { get: addressGetter })
    accessorAddresses.length = 1
    expect(
      () => new TeranodeListener({ [topic]: jest.fn() }, { staticPeers: accessorAddresses })
    ).toThrow('bounded strings')
    expect(addressGetter).not.toHaveBeenCalled()
  })

  it('rejects hostile callback and listener configuration containers', () => {
    class NonPlainConfig {}

    for (const callbacks of [null, [], new NonPlainConfig()]) {
      expect(() => new TeranodeListener(callbacks as never)).toThrow(
        'topicCallbacks must be a plain object'
      )
    }
    const symbolCallbacks = { [Symbol('topic')]: jest.fn() }
    expect(() => new TeranodeListener(symbolCallbacks as never)).toThrow(
      'topicCallbacks cannot contain symbols'
    )
    const callbackGetter = jest.fn(() => jest.fn())
    const accessorCallbacks = Object.defineProperty({}, topic, { get: callbackGetter })
    expect(() => new TeranodeListener(accessorCallbacks)).toThrow(
      'topic callback must be an own data function'
    )
    expect(callbackGetter).not.toHaveBeenCalled()

    for (const config of [null, [], new NonPlainConfig()]) {
      expect(() => new TeranodeListener({ [topic]: jest.fn() }, config as never)).toThrow(
        'listener config must be a plain object'
      )
    }
    expect(
      () => new TeranodeListener({ [topic]: jest.fn() }, { unsupported: true } as never)
    ).toThrow('unsupported property')
    expect(
      () => new TeranodeListener({ [topic]: jest.fn() }, { [Symbol('option')]: true } as never)
    ).toThrow('unsupported property')
    expect(() => new TeranodeListener({ [topic]: jest.fn() }, { sharedKey: 1 as never })).toThrow(
      'sharedKey must be a string'
    )
  })

  it('rejects unbounded, duplicate, and control-bearing address arrays', () => {
    expect(
      () => new TeranodeListener({ [topic]: jest.fn() }, { staticPeers: 'peer' as never })
    ).toThrow('at most 64 bounded strings')
    expect(
      () =>
        new TeranodeListener(
          { [topic]: jest.fn() },
          { staticPeers: Array.from({ length: 65 }, () => '/ip4/127.0.0.1/tcp/1') }
        )
    ).toThrow('at most 64 bounded strings')
    expect(
      () =>
        new TeranodeListener(
          { [topic]: jest.fn() },
          { staticPeers: ['/ip4/127.0.0.1/tcp/1', '/ip4/127.0.0.1/tcp/1'] }
        )
    ).toThrow('must not contain duplicates')
    expect(
      () =>
        new TeranodeListener(
          { [topic]: jest.fn() },
          { staticPeers: ['/dns4/peer.example/tcp/1\u0000'] }
        )
    ).toThrow('bounded strings')
  })

  it('rejects a non-callable callback added after construction', () => {
    const listener = new TeranodeListener({ [topic]: jest.fn() })
    expect(() => listener.addTopicCallback(topic, 'callback' as never)).toThrow(
      'topic callback must be a function'
    )
  })

  it('snapshots caller-owned callbacks and address arrays before start', async () => {
    const { messageHandlers, node } = mockNode()
    createLibp2p.mockResolvedValue(node)
    const originalCallback = jest.fn()
    const replacementCallback = jest.fn()
    const callbacks = { [topic]: originalCallback }
    const bootstrapPeers = ['/dns4/original.example/tcp/1']
    const listenAddresses = ['/ip4/127.0.0.1/tcp/1']
    const listener = new TeranodeListener(callbacks, {
      bootstrapPeers,
      listenAddresses,
      staticPeers: []
    })

    callbacks[topic] = replacementCallback
    bootstrapPeers[0] = '/dns4/attacker.example/tcp/1'
    listenAddresses[0] = '/ip4/0.0.0.0/tcp/1'
    await listener.start()
    messageHandlers['gossipsub:message']({
      detail: {
        msg: { topic, data: Uint8Array.from([1]) },
        propagationSource: { toString: () => 'remote-peer' }
      }
    })

    expect(bootstrap).toHaveBeenCalledWith({ list: ['/dns4/original.example/tcp/1'] })
    expect(createLibp2p).toHaveBeenCalledWith(
      expect.objectContaining({ addresses: { listen: ['/ip4/127.0.0.1/tcp/1'] } })
    )
    expect(originalCallback).toHaveBeenCalledTimes(1)
    expect(replacementCallback).not.toHaveBeenCalled()
    await listener.stop()
  })

  it('coalesces concurrent starts and stops', async () => {
    const { node } = mockNode()
    let releaseStart: (() => void) | undefined
    node.start.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          releaseStart = resolve
        })
    )
    createLibp2p.mockResolvedValue(node)
    const listener = new TeranodeListener({ [topic]: jest.fn() }, { staticPeers: [] })

    const firstStart = listener.start()
    const secondStart = listener.start()
    while (releaseStart === undefined) await Promise.resolve()
    releaseStart()
    await Promise.all([firstStart, secondStart])
    await Promise.all([listener.stop(), listener.stop()])

    expect(createLibp2p).toHaveBeenCalledTimes(1)
    expect(node.start).toHaveBeenCalledTimes(1)
    expect(node.stop).toHaveBeenCalledTimes(1)
  })

  it('cleans up failed starts and permits a safe retry', async () => {
    const failed = mockNode().node
    failed.start.mockRejectedValueOnce(new Error('start failed'))
    const recovered = mockNode().node
    createLibp2p.mockResolvedValueOnce(failed).mockResolvedValueOnce(recovered)
    const listener = new TeranodeListener({ [topic]: jest.fn() }, { staticPeers: [] })

    await expect(listener.start()).rejects.toThrow('start failed')
    expect(failed.stop).toHaveBeenCalledTimes(1)
    expect(listener.getNode()).toBeNull()

    await listener.start()
    expect(listener.getNode()).toBe(recovered)
    await listener.stop()
  })

  it('contains cleanup failures from a partially started node', async () => {
    const failed = mockNode().node
    failed.start.mockRejectedValueOnce(new Error('start failed'))
    failed.stop.mockRejectedValueOnce(new Error('cleanup failed'))
    createLibp2p.mockResolvedValue(failed)
    const listener = new TeranodeListener({ [topic]: jest.fn() }, { staticPeers: [] })
    const error = jest.spyOn(console, 'error').mockImplementation(() => {})

    await expect(listener.start()).rejects.toThrow('start failed')

    expect(error).toHaveBeenCalledWith(
      'Failed to clean up a partially started TeranodeListener:',
      expect.objectContaining({ message: 'cleanup failed' })
    )
    error.mockRestore()
  })

  it('waits for an in-flight start before stopping the resulting node', async () => {
    const { node } = mockNode()
    let releaseStart: (() => void) | undefined
    node.start.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          releaseStart = resolve
        })
    )
    createLibp2p.mockResolvedValue(node)
    const listener = new TeranodeListener({ [topic]: jest.fn() }, { staticPeers: [] })

    const starting = listener.start()
    while (releaseStart === undefined) await Promise.resolve()
    const stopping = listener.stop()
    releaseStart()
    await Promise.all([starting, stopping])

    expect(node.stop).toHaveBeenCalledTimes(1)
    expect(listener.getNode()).toBeNull()
  })

  it('does not start the DHT service when usePrivateDHT is false', async () => {
    const { node } = mockNode()
    createLibp2p.mockResolvedValue(node)
    const listener = new TeranodeListener(
      { [topic]: jest.fn() },
      { usePrivateDHT: false, staticPeers: [] }
    )
    await listener.start()
    expect(kadDHT).not.toHaveBeenCalled()
    expect(createLibp2p).toHaveBeenCalledWith(
      expect.objectContaining({ services: expect.not.objectContaining({ dht: expect.anything() }) })
    )
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

  it('rejects accessor-backed, duplicate, sparse, and unsupported topics', async () => {
    const getter = jest.fn(() => [topic])
    const accessorConfig = Object.defineProperty({}, 'topics', { get: getter })
    await expect(startSubscriber(accessorConfig as { topics: [typeof topic] })).rejects.toThrow(
      'subscriber config cannot use accessors'
    )
    expect(getter).not.toHaveBeenCalled()
    await expect(startSubscriber({ topics: [topic, topic] })).rejects.toThrow('unique')
    await expect(
      startSubscriber({ topics: ['bitcoin/mainnet-unknown' as typeof topic] })
    ).rejects.toThrow('supported')
    const sparse = Array(1) as (typeof topic)[]
    await expect(startSubscriber({ topics: sparse })).rejects.toThrow('supported')
    const topicGetter = jest.fn(() => topic)
    const accessorTopics = [] as (typeof topic)[]
    Object.defineProperty(accessorTopics, '0', { get: topicGetter })
    accessorTopics.length = 1
    await expect(startSubscriber({ topics: accessorTopics })).rejects.toThrow('supported')
    expect(topicGetter).not.toHaveBeenCalled()
  })

  it('rejects hostile subscriber containers and oversized topic lists', async () => {
    class NonPlainSubscriberConfig {}
    for (const config of [null, [], new NonPlainSubscriberConfig()]) {
      await expect(startSubscriber(config as never)).rejects.toThrow(
        'subscriber config must be a plain object'
      )
    }
    await expect(startSubscriber({ [Symbol('option')]: true } as never)).rejects.toThrow(
      'subscriber config cannot contain symbols'
    )
    await expect(startSubscriber({ topics: 'topic' as never })).rejects.toThrow(
      'topics must contain only supported unique Teranode topics'
    )
    await expect(
      startSubscriber({ topics: Array.from({ length: 13 }, () => topic) })
    ).rejects.toThrow('topics must contain only supported unique Teranode topics')
  })
})
