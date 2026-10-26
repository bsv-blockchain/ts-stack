import {
  TopicBroadcaster,
  LookupResolver,
  OverlayAdminTokenTemplate,
  withDoubleSpendRetry,
  Transaction,
  isBroadcastResponse,
  normalizeBRC100ByteArray,
  snapshotWalletResultRequest,
  validateWalletArgs,
  validateWalletResult
} from '@bsv/sdk'
import type {
  SHIPBroadcasterConfig,
  LookupResolverConfig,
  LookupQuestion,
  LookupAnswer
} from '@bsv/sdk'
import { snapshotPlainDataRecord } from '../core/certificate-validation'
import { WalletCore } from '../core/WalletCore'
import {
  OverlayConfig,
  OverlayInfo,
  OverlayBroadcastResult,
  OverlayOutput,
  TransactionResult
} from '../core/types'

const MAX_OVERLAY_TOPICS = 64
const MAX_OVERLAY_TRACKERS = 32
const MAX_OVERLAY_HOST_MAP_ENTRIES = 64
const MAX_OVERLAY_HOSTS_PER_SERVICE = 32
const MAX_OVERLAY_URL_LENGTH = 2048
const OVERLAY_TOPIC_PATTERN = /^tm_[A-Za-z0-9_-]{1,124}$/
const OVERLAY_SERVICE_PATTERN = /^ls_[A-Za-z0-9_-]{1,124}$/

type AcknowledgmentRequirement = 'all' | 'any' | string[]

function snapshotActionOutputs(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 1_000) {
    throw new TypeError('Overlay action outputs must be a dense bounded array.')
  }
  const outputs: Array<Record<string, unknown>> = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    const output =
      descriptor == null || Object.getOwnPropertyDescriptor(descriptor, 'value') == null
        ? undefined
        : snapshotPlainDataRecord(descriptor.value)
    if (output == null) throw new TypeError('Overlay action outputs must contain own data records.')
    outputs.push(output)
  }
  return outputs
}

async function createValidatedAction(client: any, args: any): Promise<Record<string, unknown>> {
  validateWalletArgs('createAction', args)
  const request = snapshotWalletResultRequest('createAction', args)
  return validateWalletResult(
    'createAction',
    await client.createAction(args),
    request
  ) as unknown as Record<string, unknown>
}

function transactionResult(result: Record<string, unknown>): TransactionResult {
  const tx = result.tx == null ? undefined : normalizeBRC100ByteArray(result.tx)
  return {
    txid: result.txid as string,
    tx
  }
}

function cloneDenseStringArray(
  value: unknown,
  name: string,
  maximum: number,
  itemMaximum: number = MAX_OVERLAY_URL_LENGTH
): string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${name} must be a standard array.`)
  }
  if (value.length > maximum) throw new RangeError(`${name} contains too many entries.`)

  const copy: string[] = []
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (
      descriptor == null ||
      Object.getOwnPropertyDescriptor(descriptor, 'value') == null ||
      typeof descriptor.value !== 'string' ||
      descriptor.value.length === 0 ||
      descriptor.value.length > itemMaximum
    ) {
      throw new TypeError(`${name} must contain bounded strings in a dense array.`)
    }
    if (seen.has(descriptor.value)) throw new Error(`${name} must not contain duplicates.`)
    seen.add(descriptor.value)
    copy.push(descriptor.value)
  }
  return copy
}

function normalizeTopics(value: unknown, name: string, allowEmpty: boolean = false): string[] {
  const topics = cloneDenseStringArray(value, name, MAX_OVERLAY_TOPICS, 127)
  if (!allowEmpty && topics.length === 0) throw new Error('At least one topic is required')
  for (const topic of topics) {
    if (!OVERLAY_TOPIC_PATTERN.test(topic)) {
      throw new Error(`Topic "${topic}" must be a bounded "tm_" identifier`)
    }
  }
  return topics
}

function normalizeAcknowledgmentRequirement(
  value: unknown,
  name: string
): AcknowledgmentRequirement | undefined {
  if (value === undefined) return undefined
  if (value === 'all' || value === 'any') return value
  return normalizeTopics(value, name, true)
}

function normalizeHostMap(value: unknown, name: string): Record<string, string[]> | undefined {
  if (value === undefined) return undefined
  const record = snapshotPlainDataRecord(value)
  if (record == null) {
    throw new TypeError(`${name} must be a plain own-data record with data properties only.`)
  }

  const keys = Object.keys(record)
  if (keys.length > MAX_OVERLAY_HOST_MAP_ENTRIES) {
    throw new RangeError(`${name} contains too many services.`)
  }
  const copy: Record<string, string[]> = Object.create(null)
  for (const service of keys) {
    if (!OVERLAY_SERVICE_PATTERN.test(service)) {
      throw new Error(`${name} key "${service}" must be a bounded "ls_" identifier.`)
    }
    copy[service] = cloneDenseStringArray(
      record[service],
      `${name}.${service}`,
      MAX_OVERLAY_HOSTS_PER_SERVICE
    )
  }
  return copy
}

function normalizeOverlayConfig(config: OverlayConfig): OverlayConfig {
  const record = snapshotPlainDataRecord(config)
  if (record == null) {
    throw new TypeError('Overlay configuration must be an object.')
  }
  const network = record.network ?? 'mainnet'
  if (typeof network !== 'string') {
    throw new Error('Overlay network preset is invalid.')
  }
  if (!['mainnet', 'testnet', 'teratestnet', 'local'].includes(network)) {
    throw new Error('Overlay network preset is invalid.')
  }

  return Object.assign(Object.create(null) as OverlayConfig, {
    topics: normalizeTopics(record.topics, 'topics'),
    network,
    requireAckFromAllHosts: normalizeAcknowledgmentRequirement(
      record.requireAckFromAllHosts,
      'requireAckFromAllHosts'
    ),
    requireAckFromAnyHost: normalizeAcknowledgmentRequirement(
      record.requireAckFromAnyHost,
      'requireAckFromAnyHost'
    ),
    slapTrackers:
      record.slapTrackers === undefined
        ? undefined
        : cloneDenseStringArray(record.slapTrackers, 'slapTrackers', MAX_OVERLAY_TRACKERS),
    hostOverrides: normalizeHostMap(record.hostOverrides, 'hostOverrides'),
    additionalHosts: normalizeHostMap(record.additionalHosts, 'additionalHosts')
  })
}

// ============================================================================
// Overlay class — standalone TopicBroadcaster + LookupResolver wrapper
// ============================================================================

export class Overlay {
  private readonly topics: string[]
  private broadcaster: TopicBroadcaster
  private readonly resolver: LookupResolver
  private readonly config: OverlayConfig

  private constructor(
    config: OverlayConfig,
    broadcaster: TopicBroadcaster,
    resolver: LookupResolver
  ) {
    this.config = config
    this.topics = [...config.topics]
    this.broadcaster = broadcaster
    this.resolver = resolver
  }

  static async create(config: OverlayConfig): Promise<Overlay> {
    const normalizedConfig = normalizeOverlayConfig(config)

    const network = normalizedConfig.network ?? 'mainnet'

    // Build LookupResolver
    const resolverConfig = Object.assign(Object.create(null) as LookupResolverConfig, {
      networkPreset: network
    })
    if (normalizedConfig.slapTrackers != null) {
      resolverConfig.slapTrackers = normalizedConfig.slapTrackers
    }
    if (normalizedConfig.hostOverrides != null) {
      resolverConfig.hostOverrides = normalizedConfig.hostOverrides
    }
    if (normalizedConfig.additionalHosts != null) {
      resolverConfig.additionalHosts = normalizedConfig.additionalHosts
    }

    const resolver = new LookupResolver(resolverConfig)

    // Build TopicBroadcaster
    const broadcasterConfig = Object.assign(Object.create(null) as SHIPBroadcasterConfig, {
      networkPreset: network,
      resolver
    })
    if (normalizedConfig.requireAckFromAllHosts !== undefined) {
      broadcasterConfig.requireAcknowledgmentFromAllHostsForTopics =
        normalizedConfig.requireAckFromAllHosts
    }
    if (normalizedConfig.requireAckFromAnyHost !== undefined) {
      broadcasterConfig.requireAcknowledgmentFromAnyHostForTopics =
        normalizedConfig.requireAckFromAnyHost
    }

    const broadcaster = new TopicBroadcaster([...normalizedConfig.topics], broadcasterConfig)

    return new Overlay(normalizedConfig, broadcaster, resolver)
  }

  getInfo(): OverlayInfo {
    return {
      topics: [...this.topics],
      network: this.config.network ?? 'mainnet'
    }
  }

  addTopic(topic: string): void {
    if (!this.topics.includes(topic)) {
      const nextTopics = normalizeTopics([...this.topics, topic], 'topics')
      this.topics.splice(0, this.topics.length, ...nextTopics)
      this.rebuildBroadcaster()
    }
  }

  removeTopic(topic: string): void {
    const index = this.topics.indexOf(topic)
    if (index > -1) {
      if (this.topics.length === 1) {
        throw new Error('An overlay must retain at least one topic.')
      }
      this.topics.splice(index, 1)
      this.rebuildBroadcaster()
    }
  }

  private broadcasterConfig(): SHIPBroadcasterConfig {
    const network = this.config.network ?? 'mainnet'
    const broadcasterConfig = Object.assign(Object.create(null) as SHIPBroadcasterConfig, {
      networkPreset: network,
      resolver: this.resolver
    })
    if (this.config.requireAckFromAllHosts !== undefined) {
      broadcasterConfig.requireAcknowledgmentFromAllHostsForTopics = Array.isArray(
        this.config.requireAckFromAllHosts
      )
        ? [...this.config.requireAckFromAllHosts]
        : this.config.requireAckFromAllHosts
    }
    if (this.config.requireAckFromAnyHost !== undefined) {
      broadcasterConfig.requireAcknowledgmentFromAnyHostForTopics = Array.isArray(
        this.config.requireAckFromAnyHost
      )
        ? [...this.config.requireAckFromAnyHost]
        : this.config.requireAckFromAnyHost
    }
    return broadcasterConfig
  }

  private rebuildBroadcaster(): void {
    this.broadcaster = new TopicBroadcaster([...this.topics], this.broadcasterConfig())
  }

  // Submit a pre-built Transaction to overlay topics
  async broadcast(tx: Transaction, topics?: string[]): Promise<OverlayBroadcastResult> {
    let broadcaster = this.broadcaster

    // If per-call topics are provided, create a one-off broadcaster
    if (topics != null) {
      const normalizedTopics = normalizeTopics(topics, 'topics', true)
      if (normalizedTopics.length > 0) {
        broadcaster = new TopicBroadcaster(normalizedTopics, this.broadcasterConfig())
      }
    }

    const result = await broadcaster.broadcast(tx)

    if (isBroadcastResponse(result)) {
      return {
        success: true,
        txid: result.txid
      }
    } else {
      return {
        success: false,
        code: result.code,
        description: result.description
      }
    }
  }

  // Query a lookup service
  async query(service: string, query: unknown, timeout?: number): Promise<LookupAnswer> {
    const question: LookupQuestion = { service, query }
    return await this.resolver.query(question, timeout)
  }

  // Convenience: query + extract parsed outputs
  async lookupOutputs(service: string, query: unknown): Promise<OverlayOutput[]> {
    const answer = await this.query(service, query)
    if (answer.type !== 'output-list' || answer.outputs == null) {
      return []
    }
    return answer.outputs.map(o => ({
      beef: o.beef,
      outputIndex: o.outputIndex,
      context: o.context
    }))
  }

  // Access raw SDK objects for advanced use
  getBroadcaster(): TopicBroadcaster {
    return this.broadcaster
  }
  getResolver(): LookupResolver {
    return this.resolver
  }
}

// ============================================================================
// Wallet-integrated overlay methods
// ============================================================================

export function createOverlayMethods(core: WalletCore): {
  advertiseSHIP: (domain: string, topic: string, basket?: string) => Promise<TransactionResult>
  advertiseSLAP: (domain: string, service: string, basket?: string) => Promise<TransactionResult>
  broadcastAction: (
    overlay: Overlay,
    actionOptions: { outputs: any[]; description?: string },
    topics?: string[]
  ) => Promise<{ txid: string; broadcast: OverlayBroadcastResult }>
  withRetry: <T>(operation: () => Promise<T>, overlay: Overlay, maxRetries?: number) => Promise<T>
} {
  return {
    // Create a SHIP advertisement: "I host topic X at domain Y"
    async advertiseSHIP(
      domain: string,
      topic: string,
      basket?: string
    ): Promise<TransactionResult> {
      if (!topic.startsWith('tm_')) {
        throw new Error(`Topic "${topic}" must start with "tm_" prefix`)
      }
      const template = new OverlayAdminTokenTemplate(core.getClient())
      const lockingScript = await template.lock('SHIP', domain, topic)
      const result = await createValidatedAction(core.getClient(), {
        description: `SHIP advertisement: ${topic} at ${domain}`,
        outputs: [
          {
            lockingScript: lockingScript.toHex(),
            satoshis: 1,
            outputDescription: 'SHIP token',
            ...(basket == null ? {} : { basket })
          }
        ],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      return transactionResult(result)
    },

    // Create a SLAP advertisement: "I provide lookup service X at domain Y"
    async advertiseSLAP(
      domain: string,
      service: string,
      basket?: string
    ): Promise<TransactionResult> {
      if (!service.startsWith('ls_')) {
        throw new Error(`Service "${service}" must start with "ls_" prefix`)
      }
      const template = new OverlayAdminTokenTemplate(core.getClient())
      const lockingScript = await template.lock('SLAP', domain, service)
      const result = await createValidatedAction(core.getClient(), {
        description: `SLAP advertisement: ${service} at ${domain}`,
        outputs: [
          {
            lockingScript: lockingScript.toHex(),
            satoshis: 1,
            outputDescription: 'SLAP token',
            ...(basket == null ? {} : { basket })
          }
        ],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      return transactionResult(result)
    },

    // Create action + broadcast to overlay in one step
    async broadcastAction(
      overlay: Overlay,
      actionOptions: { outputs: any[]; description?: string },
      topics?: string[]
    ): Promise<{ txid: string; broadcast: OverlayBroadcastResult }> {
      const options = snapshotPlainDataRecord(actionOptions)
      if (options == null) throw new TypeError('Invalid overlay action options')
      const result = await createValidatedAction(core.getClient(), {
        description:
          options.description === undefined ? 'Overlay broadcast' : (options.description as string),
        outputs: snapshotActionOutputs(options.outputs),
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      if (result.tx == null) throw new Error('No tx from createAction')
      const beef = normalizeBRC100ByteArray(result.tx)
      if (beef == null) throw new Error('No tx from createAction')
      const tx = Transaction.fromAtomicBEEF(beef)
      const broadcastResult = await overlay.broadcast(tx, topics)
      return { txid: result.txid as string, broadcast: broadcastResult }
    },

    // Double-spend retry wrapper
    async withRetry<T>(
      operation: () => Promise<T>,
      overlay: Overlay,
      maxRetries?: number
    ): Promise<T> {
      return await withDoubleSpendRetry(operation, overlay.getBroadcaster(), maxRetries)
    }
  }
}
