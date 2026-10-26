import { createLibp2p, type Libp2p } from 'libp2p'
import { tcp } from '@libp2p/tcp'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { bootstrap } from '@libp2p/bootstrap'
import { kadDHT } from '@libp2p/kad-dht'
import { gossipsub } from '@chainsafe/libp2p-gossipsub'

import { preSharedKey } from '@libp2p/pnet'
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery'
import { identify } from '@libp2p/identify'
import { ping } from '@libp2p/ping'
import { multiaddr } from '@multiformats/multiaddr'
import { generateKeyPair } from '@libp2p/crypto/keys'
import type { PrivateKey } from '@libp2p/interface'

import { tryDecodeMessage, type DecodedMessage } from './messages.js'

// Re-export the wire-format message types and decoders for consumers.
export * from './messages.js'

// Type definitions
export type MessageCallback = (data: Uint8Array, topic: Topic, from: string) => void

/**
 * Callback that receives a fully decoded message instead of raw bytes.
 * Used when `decodeMessages: true` is set in the listener config.
 */
export type DecodedMessageCallback = (message: DecodedMessage, topic: Topic, from: string) => void

/**
 * Topic types for Teranode P2P messages
 *
 * 'bitcoin/mainnet-bestblock' is for the best block message
 * 'bitcoin/mainnet-block' is for when miners find a block solution
 * 'bitcoin/mainnet-subtree' is for when a subtree is created
 * 'bitcoin/mainnet-mining_on' is for when mining is enabled
 * 'bitcoin/mainnet-handshake' is for when a peer connects to the network
 * 'bitcoin/mainnet-rejected_tx' is for when a transaction is rejected
 */
export type Topic =
  | 'bitcoin/mainnet-bestblock'
  | 'bitcoin/mainnet-block'
  | 'bitcoin/mainnet-subtree'
  | 'bitcoin/mainnet-mining_on'
  | 'bitcoin/mainnet-handshake'
  | 'bitcoin/mainnet-rejected_tx'
  | 'bitcoin/testnet-bestblock'
  | 'bitcoin/testnet-block'
  | 'bitcoin/testnet-subtree'
  | 'bitcoin/testnet-mining_on'
  | 'bitcoin/testnet-handshake'
  | 'bitcoin/testnet-rejected_tx'

const VALID_TOPICS = new Set<Topic>([
  'bitcoin/mainnet-bestblock',
  'bitcoin/mainnet-block',
  'bitcoin/mainnet-subtree',
  'bitcoin/mainnet-mining_on',
  'bitcoin/mainnet-handshake',
  'bitcoin/mainnet-rejected_tx',
  'bitcoin/testnet-bestblock',
  'bitcoin/testnet-block',
  'bitcoin/testnet-subtree',
  'bitcoin/testnet-mining_on',
  'bitcoin/testnet-handshake',
  'bitcoin/testnet-rejected_tx'
])

export type TopicCallbacks = Partial<Record<Topic, MessageCallback | DecodedMessageCallback>>

export interface SubscriberConfig {
  bootstrapPeers?: string[] // Array of bootstrap peer multiaddrs
  staticPeers?: string[] // Optional array of static peer multiaddrs
  /**
   * 32-byte PNET key encoded as 64 hexadecimal characters. The default
   * Teranode mainnet value is a public compatibility key, not a secret or an
   * authentication credential.
   */
  sharedKey?: string
  dhtProtocolID?: string // DHT protocol prefix, default '/teranode'
  topics?: Topic[] // Array of topics to subscribe to
  listenAddresses?: string[] // Listening addresses
  /** Whether to enable the Kademlia DHT service. Defaults to true. */
  usePrivateDHT?: boolean
  /**
   * When true, raw GossipSub bytes are decoded from the two-layer JSON wire
   * format before being handed to callbacks. Callbacks then receive a
   * {@link DecodedMessage} (sender + typed payload) instead of a Uint8Array.
   * Frames that fail to decode (e.g. libp2p control frames) are skipped.
   * Defaults to false for backward compatibility.
   */
  decodeMessages?: boolean
}

export interface TeranodeListenerConfig extends Omit<SubscriberConfig, 'topics'> {
  // Inherits all SubscriberConfig options except topics
}

const CONFIG_KEYS = new Set<keyof TeranodeListenerConfig>([
  'bootstrapPeers',
  'staticPeers',
  'sharedKey',
  'dhtProtocolID',
  'listenAddresses',
  'usePrivateDHT',
  'decodeMessages'
])

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true
  }
  return false
}

function snapshotTopics(value: unknown): Topic[] {
  if (!Array.isArray(value) || value.length > VALID_TOPICS.size) {
    throw new TypeError('topics must contain only supported unique Teranode topics')
  }
  const topics: Topic[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor === undefined ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string' ||
      !VALID_TOPICS.has(descriptor.value as Topic)
    ) {
      throw new TypeError('topics must contain only supported unique Teranode topics')
    }
    topics.push(descriptor.value as Topic)
  }
  if (new Set(topics).size !== topics.length) {
    throw new TypeError('topics must contain only supported unique Teranode topics')
  }
  return topics
}

/**
 * TeranodeListener provides a callback-based API for subscribing to Teranode P2P topics.
 * Each topic can have its own callback function for handling messages.
 */
export class TeranodeListener {
  private node: Libp2p | null = null
  private readonly topicCallbacks: TopicCallbacks
  private readonly config: TeranodeListenerConfig
  private reconnectionInterval?: NodeJS.Timeout
  private readonly decodeMessages: boolean
  private startPromise?: Promise<void>
  private stopPromise?: Promise<void>
  private reconnectionPromise?: Promise<void>
  private readonly shutdownHandler = (): void => {
    void this.stop().catch(error => {
      console.error('Failed to stop TeranodeListener:', error)
    })
  }

  /**
   * Creates a new TeranodeListener instance.
   *
   * The listener does not start automatically. Call {@link start} after
   * construction to begin connecting and listening:
   *
   * ```ts
   * const listener = new TeranodeListener(topicCallbacks)
   * await listener.start()
   * ```
   *
   * @param topicCallbacks - Object mapping topic names to callback functions
   * @param config - Optional configuration (uses Teranode mainnet defaults)
   */
  constructor(topicCallbacks: TopicCallbacks, config: TeranodeListenerConfig = {}) {
    this.topicCallbacks = this.snapshotTopicCallbacks(topicCallbacks)
    this.config = this.snapshotConfig(config)
    this.decodeMessages = this.config.decodeMessages ?? false
  }

  /**
   * Start the P2P listener and subscribe to topics
   */
  async start(): Promise<void> {
    if (this.stopPromise) await this.stopPromise
    if (this.node) {
      console.warn('TeranodeListener is already started')
      return
    }

    if (this.startPromise) {
      await this.startPromise
      return
    }

    const operation = this.startOnce()
    this.startPromise = operation
    try {
      await operation
    } finally {
      if (this.startPromise === operation) this.startPromise = undefined
    }
  }

  private async startOnce(): Promise<void> {
    if (this.stopPromise) await this.stopPromise

    const topics = Object.keys(this.topicCallbacks) as Topic[]

    // Create the libp2p node using the same logic as startSubscriber
    const {
      bootstrapPeers = [
        '/dns4/teranode-bootstrap.bsvb.tech/tcp/9901/p2p/12D3KooWESmhNAN8s6NPdGNvJH3zJ4wMKDxapXKNUe2DzkAwKYqK'
      ],
      staticPeers = [
        '/dns4/teranode-mainnet-peer.taal.com/tcp/9905/p2p/12D3KooWJGPdPPw72GU6gFF4LqUjeFF7qmPCS2bZK8ywMvybYfXD',
        '/dns4/teranode-mainnet-us-01.bsvb.tech/tcp/9905/p2p/12D3KooWPJAHHaNy5BsViK1B5iTQmz5cLaUheAKEuNkHqMbwZ8jd',
        '/dns4/teranode-eks-mainnet-us-1-peer.bsvb.tech/tcp/9911/p2p/12D3KooWFjGChbwVteGsqH6NfHtKbtdW5XgnvmQRpem2kUAQjsGq',
        '/dns4/bsva-ovh-teranode-eu-1.bsvb.tech/tcp/9905/p2p/12D3KooWAdBeSVue71DTmfMEKyBG2s1hg91zJnze85rt2uKCZWbW',
        '/dns4/teranode-eks-mainnet-eu-1-peer.bsvb.tech/tcp/9911/p2p/12D3KooWRioUF2AYvC6ofiXhjE5V3MLiVrRKMAEyHiz5iYQgnB5f'
      ],
      sharedKey = '285b49e6d910726a70f205086c39cbac6d8dcc47839053a21b1f614773bbc137',
      dhtProtocolID = '/teranode',
      listenAddresses = ['/ip4/127.0.0.1/tcp/9901'],
      usePrivateDHT = true
    } = this.config

    if (!/^[0-9a-f]{64}$/iu.test(sharedKey)) {
      throw new TypeError('sharedKey must encode exactly 32 bytes as hexadecimal')
    }

    // Format the PSK
    const pskText = `/key/swarm/psk/1.0.0/\n/base16/\n${sharedKey.toLowerCase()}`
    const psk = new TextEncoder().encode(pskText)
    const connectionProtector = preSharedKey({ psk })
    const privateKey: PrivateKey = await generateKeyPair('Ed25519')

    const candidate = await createLibp2p({
      privateKey,
      addresses: {
        listen: listenAddresses
      },
      transports: [tcp()],
      connectionEncrypters: [noise()],
      streamMuxers: [yamux()],
      connectionProtector,
      peerDiscovery: [
        bootstrap({ list: bootstrapPeers }),
        pubsubPeerDiscovery({
          topics,
          interval: 5000
        })
      ],
      services: {
        ...(usePrivateDHT
          ? {
              dht: kadDHT({
                protocol: `${dhtProtocolID}/kad/1.0.0`,
                clientMode: false,
                validators: {},
                selectors: {}
              })
            }
          : {}),
        pubsub: gossipsub({
          allowPublishToZeroTopicPeers: true,
          emitSelf: false,
          fallbackToFloodsub: true,
          floodPublish: true,
          doPX: true
          // Cast: gossipsub's GossipSubComponents factory type drifted from the
          // createLibp2p service-factory component type after libp2p bumps (#222).
          // Runtime is unaffected; realign package types to remove this.
        }) as any,
        identify: identify(),
        ping: ping()
      }
    })

    try {
      await candidate.start()
      this.node = candidate
      console.log('TeranodeListener started with Peer ID:', candidate.peerId.toString())

      this.setupEventListeners()
      this.setupTopicSubscriptions()

      if (staticPeers.length > 0) {
        await this.connectToStaticPeers(staticPeers)
        this.reconnectionInterval = this.startStaticPeerMonitoring(staticPeers)
      }

      process.once('SIGINT', this.shutdownHandler)
    } catch (error) {
      if (this.reconnectionInterval) clearInterval(this.reconnectionInterval)
      this.reconnectionInterval = undefined
      this.node = null
      process.removeListener('SIGINT', this.shutdownHandler)
      try {
        await candidate.stop()
      } catch (stopError) {
        console.error('Failed to clean up a partially started TeranodeListener:', stopError)
      }
      throw error
    }
  }

  /**
   * Stop the P2P listener
   */
  async stop(): Promise<void> {
    if (this.stopPromise) return await this.stopPromise
    const operation = this.stopOnce()
    this.stopPromise = operation
    try {
      await operation
    } finally {
      if (this.stopPromise === operation) this.stopPromise = undefined
    }
  }

  private async stopOnce(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise
      } catch {
        return
      }
    }
    if (!this.node) return

    console.log('Stopping TeranodeListener...')

    if (this.reconnectionInterval) {
      clearInterval(this.reconnectionInterval)
      this.reconnectionInterval = undefined
    }
    if (this.reconnectionPromise) await this.reconnectionPromise

    process.removeListener('SIGINT', this.shutdownHandler)
    const candidate = this.node
    try {
      await candidate.stop()
    } finally {
      if (this.node === candidate) this.node = null
    }
    console.log('TeranodeListener stopped')
  }

  /**
   * Add a new topic callback
   */
  addTopicCallback(topic: Topic, callback: MessageCallback | DecodedMessageCallback): void {
    this.assertTopic(topic)
    if (typeof callback !== 'function') throw new TypeError('topic callback must be a function')
    this.topicCallbacks[topic] = callback

    if (this.node) {
      ;(this.node.services.pubsub as any).subscribe(topic)
      console.log(`Subscribed to new topic: ${topic}`)
    }
  }

  /**
   * Remove a topic callback
   */
  removeTopicCallback(topic: Topic): void {
    this.assertTopic(topic)
    delete this.topicCallbacks[topic]

    if (this.node) {
      ;(this.node.services.pubsub as any).unsubscribe(topic)
      console.log(`Unsubscribed from topic: ${topic}`)
    }
  }

  /**
   * Get the current libp2p node instance
   */
  getNode(): Libp2p | null {
    return this.node
  }

  /**
   * Get connected peer count
   */
  getConnectedPeerCount(): number {
    return this.node ? this.node.getPeers().length : 0
  }

  private setupEventListeners(): void {
    if (!this.node) return

    this.node.addEventListener('peer:discovery', (evt: any) => {
      console.log('Peer discovered:', evt.detail.id.toString())
    })

    this.node.addEventListener('peer:connect', (evt: any) => {
      console.log('✅ Peer connected:', evt.detail.toString())
      console.log('Total connected peers:', this.node!.getPeers().length)
    })

    this.node.addEventListener('peer:disconnect', (evt: any) => {
      console.log('❌ Peer disconnected:', evt.detail.toString())
      console.log('Remaining connected peers:', this.node!.getPeers().length)
    })
  }

  private setupTopicSubscriptions(): void {
    if (!this.node) return

    // Subscribe to topics and handle messages with callbacks
    const pubsub = this.node.services.pubsub as any
    pubsub.addEventListener('gossipsub:message', (evt: any) => {
      const msg = evt.detail.msg
      const topicKey = msg.topic as Topic
      const callback = this.topicCallbacks[topicKey]

      if (callback) {
        try {
          const from = evt.detail.propagationSource.toString()
          if (this.decodeMessages) {
            // Decode the two-layer JSON wire format before dispatch. Non-JSON
            // frames (e.g. libp2p discovery probes) decode to null and are skipped.
            const decoded = tryDecodeMessage(msg.data)
            if (decoded) {
              const decodedCallback = callback as DecodedMessageCallback
              decodedCallback(decoded, topicKey, from)
            }
          } else {
            const messageCallback = callback as MessageCallback
            messageCallback(msg.data, topicKey, from)
          }
        } catch (error) {
          console.error(`Error in callback for topic ${topicKey}:`, error)
        }
      } else {
        console.log('Received message on an unhandled topic')
      }
    })

    // Subscribe to all topics
    for (const topic of Object.keys(this.topicCallbacks) as Topic[]) {
      ;(this.node.services.pubsub as any).subscribe(topic)
      console.log(`Subscribed to topic: ${topic}`)
    }
  }

  private async connectToStaticPeers(staticPeers: string[]): Promise<void> {
    if (!this.node) return

    const connectionPromises = staticPeers.map(async peerAddr => {
      try {
        console.log(`Attempting to connect to static peer: ${peerAddr}`)
        await this.node!.dial(multiaddr(peerAddr))
        console.log(`✅ Successfully connected to static peer: ${peerAddr}`)
      } catch (error) {
        console.error(`❌ Failed to connect to static peer ${peerAddr}:`, error)
      }
    })

    await Promise.allSettled(connectionPromises)
    console.log(
      `Static peer connection complete. Total connected peers: ${this.node.getPeers().length}`
    )
  }

  private startStaticPeerMonitoring(staticPeers: string[]): NodeJS.Timeout {
    return setInterval(() => {
      if (!this.node || this.reconnectionPromise) return
      const activeNode = this.node
      const operation = (async () => {
        try {
          const connectedPeerIds = new Set(activeNode.getPeers().map(p => p.toString()))
          const disconnectedStaticPeers: string[] = []

          for (const staticPeer of staticPeers) {
            const peerIdMatch = /\/p2p\/([^/]+)$/.exec(staticPeer)
            if (peerIdMatch) {
              const peerId = peerIdMatch[1]
              if (!connectedPeerIds.has(peerId)) {
                disconnectedStaticPeers.push(staticPeer)
              }
            }
          }

          if (disconnectedStaticPeers.length > 0) {
            console.log(
              `Reconnecting to ${disconnectedStaticPeers.length} disconnected static peers...`
            )
            await this.connectToStaticPeers(disconnectedStaticPeers)
          }
        } catch (error) {
          console.error('Error monitoring static Teranode peers:', error)
        }
      })()
      this.reconnectionPromise = operation
      void operation.finally(() => {
        if (this.reconnectionPromise === operation) this.reconnectionPromise = undefined
      })
    }, 30000) // 30 seconds
  }

  private snapshotTopicCallbacks(callbacks: TopicCallbacks): TopicCallbacks {
    if (
      callbacks === null ||
      typeof callbacks !== 'object' ||
      Array.isArray(callbacks) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(callbacks))
    ) {
      throw new TypeError('topicCallbacks must be a plain object')
    }
    const snapshot = Object.create(null) as TopicCallbacks
    for (const key of Reflect.ownKeys(callbacks)) {
      if (typeof key !== 'string') throw new TypeError('topicCallbacks cannot contain symbols')
      this.assertTopic(key)
      const descriptor = Object.getOwnPropertyDescriptor(callbacks, key)!
      if (!('value' in descriptor) || typeof descriptor.value !== 'function') {
        throw new TypeError('topic callback must be an own data function')
      }
      Object.defineProperty(snapshot, key, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true
      })
    }
    return snapshot
  }

  private snapshotConfig(config: TeranodeListenerConfig): TeranodeListenerConfig {
    if (
      config === null ||
      typeof config !== 'object' ||
      Array.isArray(config) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(config))
    ) {
      throw new TypeError('listener config must be a plain object')
    }
    const values = Object.create(null) as Record<string, unknown>
    for (const key of Reflect.ownKeys(config)) {
      if (typeof key !== 'string' || !CONFIG_KEYS.has(key as keyof TeranodeListenerConfig)) {
        throw new TypeError('listener config contains an unsupported property')
      }
      const descriptor = Object.getOwnPropertyDescriptor(config, key)!
      if (!('value' in descriptor)) throw new TypeError('listener config cannot use accessors')
      values[key] = descriptor.value
    }

    const snapshot = {
      bootstrapPeers: this.snapshotStringArray(values.bootstrapPeers, 'bootstrapPeers', 32),
      staticPeers: this.snapshotStringArray(values.staticPeers, 'staticPeers', 64),
      listenAddresses: this.snapshotStringArray(values.listenAddresses, 'listenAddresses', 16),
      sharedKey: values.sharedKey,
      dhtProtocolID: values.dhtProtocolID,
      usePrivateDHT: values.usePrivateDHT,
      decodeMessages: values.decodeMessages
    } as TeranodeListenerConfig
    if (snapshot.sharedKey !== undefined && typeof snapshot.sharedKey !== 'string') {
      throw new TypeError('sharedKey must be a string')
    }
    if (snapshot.sharedKey !== undefined && !/^[0-9a-f]{64}$/iu.test(snapshot.sharedKey)) {
      throw new TypeError('sharedKey must encode exactly 32 bytes as hexadecimal')
    }
    if (
      snapshot.dhtProtocolID !== undefined &&
      (typeof snapshot.dhtProtocolID !== 'string' ||
        !/^\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(snapshot.dhtProtocolID) ||
        snapshot.dhtProtocolID.includes('//') ||
        snapshot.dhtProtocolID.includes('..') ||
        snapshot.dhtProtocolID.endsWith('/'))
    ) {
      throw new TypeError('dhtProtocolID must be a canonical protocol prefix')
    }
    for (const option of ['usePrivateDHT', 'decodeMessages'] as const) {
      if (snapshot[option] !== undefined && typeof snapshot[option] !== 'boolean') {
        throw new TypeError(`${option} must be a boolean`)
      }
    }
    return Object.freeze(snapshot)
  }

  private snapshotStringArray(
    value: unknown,
    label: string,
    maxItems: number
  ): string[] | undefined {
    if (value === undefined) return undefined
    if (!Array.isArray(value) || value.length > maxItems) {
      throw new TypeError(`${label} must contain at most ${maxItems} bounded strings`)
    }
    const snapshot: string[] = []
    for (let index = 0; index < value.length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (
        descriptor === undefined ||
        !('value' in descriptor) ||
        typeof descriptor.value !== 'string' ||
        descriptor.value.length === 0 ||
        descriptor.value.length > 2048 ||
        hasControlCharacter(descriptor.value)
      ) {
        throw new TypeError(`${label} must contain at most ${maxItems} bounded strings`)
      }
      snapshot.push(descriptor.value)
    }
    if (new Set(snapshot).size !== snapshot.length) {
      throw new TypeError(`${label} must not contain duplicates`)
    }
    for (const address of snapshot) multiaddr(address)
    return Object.freeze(snapshot) as unknown as string[]
  }

  private assertTopic(topic: string): asserts topic is Topic {
    if (!VALID_TOPICS.has(topic as Topic))
      throw new TypeError(`Unsupported Teranode topic: ${topic}`)
  }
}

export async function startSubscriber(config: SubscriberConfig = {}): Promise<void> {
  if (
    config === null ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(config))
  ) {
    throw new TypeError('subscriber config must be a plain object')
  }
  const descriptors = Object.getOwnPropertyDescriptors(config)
  const values = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string') throw new TypeError('subscriber config cannot contain symbols')
    const descriptor = descriptors[key]
    if (!('value' in descriptor)) throw new TypeError('subscriber config cannot use accessors')
    values[key] = descriptor.value
  }
  const topics =
    values.topics === undefined
      ? ([
          'bitcoin/mainnet-bestblock',
          'bitcoin/mainnet-block',
          'bitcoin/mainnet-subtree',
          'bitcoin/mainnet-mining_on',
          'bitcoin/mainnet-handshake',
          'bitcoin/mainnet-rejected_tx'
        ] satisfies Topic[])
      : snapshotTopics(values.topics)
  const listenerConfig = Object.fromEntries(
    Object.entries(values).filter(([key]) => key !== 'topics')
  ) as TeranodeListenerConfig
  const callbacks = Object.fromEntries(topics.map(topic => [topic, () => {}])) as TopicCallbacks
  const listener = new TeranodeListener(callbacks, listenerConfig)
  await listener.start()
}
