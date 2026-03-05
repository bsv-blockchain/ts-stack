import {
  TopicBroadcaster,
  LookupResolver,
  OverlayAdminTokenTemplate,
  withDoubleSpendRetry,
  Transaction,
  isBroadcastResponse
} from '@bsv/sdk'
import type {
  SHIPBroadcasterConfig,
  LookupResolverConfig,
  LookupQuestion,
  LookupAnswer
} from '@bsv/sdk'
import { WalletCore } from '../core/WalletCore'
import {
  OverlayConfig,
  OverlayInfo,
  OverlayBroadcastResult,
  OverlayOutput,
  TransactionResult
} from '../core/types'

// ============================================================================
// Overlay class — standalone TopicBroadcaster + LookupResolver wrapper
// ============================================================================

export class Overlay {
  private readonly topics: string[]
  private broadcaster: TopicBroadcaster
  private readonly resolver: LookupResolver
  private readonly config: OverlayConfig

  private constructor (
    config: OverlayConfig,
    broadcaster: TopicBroadcaster,
    resolver: LookupResolver
  ) {
    this.config = config
    this.topics = [...config.topics]
    this.broadcaster = broadcaster
    this.resolver = resolver
  }

  static async create (config: OverlayConfig): Promise<Overlay> {
    if (config.topics.length === 0) {
      throw new Error('At least one topic is required')
    }
    for (const t of config.topics) {
      if (!t.startsWith('tm_')) {
        throw new Error(`Topic "${t}" must start with "tm_" prefix`)
      }
    }

    const network = config.network ?? 'mainnet'

    // Build LookupResolver
    const resolverConfig: LookupResolverConfig = {
      networkPreset: network
    }
    if (config.slapTrackers != null) resolverConfig.slapTrackers = config.slapTrackers
    if (config.hostOverrides != null) resolverConfig.hostOverrides = config.hostOverrides
    if (config.additionalHosts != null) resolverConfig.additionalHosts = config.additionalHosts

    const resolver = new LookupResolver(resolverConfig)

    // Build TopicBroadcaster
    const broadcasterConfig: SHIPBroadcasterConfig = {
      networkPreset: network,
      resolver
    }
    if (config.requireAckFromAllHosts !== undefined) {
      broadcasterConfig.requireAcknowledgmentFromAllHostsForTopics = config.requireAckFromAllHosts
    }
    if (config.requireAckFromAnyHost !== undefined) {
      broadcasterConfig.requireAcknowledgmentFromAnyHostForTopics = config.requireAckFromAnyHost
    }

    const broadcaster = new TopicBroadcaster(config.topics, broadcasterConfig)

    return new Overlay(config, broadcaster, resolver)
  }

  getInfo (): OverlayInfo {
    return {
      topics: [...this.topics],
      network: this.config.network ?? 'mainnet'
    }
  }

  addTopic (topic: string): void {
    if (!topic.startsWith('tm_')) {
      throw new Error(`Topic "${topic}" must start with "tm_" prefix`)
    }
    if (!this.topics.includes(topic)) {
      this.topics.push(topic)
      this.rebuildBroadcaster()
    }
  }

  removeTopic (topic: string): void {
    const index = this.topics.indexOf(topic)
    if (index > -1) {
      this.topics.splice(index, 1)
      if (this.topics.length > 0) {
        this.rebuildBroadcaster()
      }
    }
  }

  private rebuildBroadcaster (): void {
    const network = this.config.network ?? 'mainnet'
    const broadcasterConfig: SHIPBroadcasterConfig = {
      networkPreset: network,
      resolver: this.resolver
    }
    if (this.config.requireAckFromAllHosts !== undefined) {
      broadcasterConfig.requireAcknowledgmentFromAllHostsForTopics = this.config.requireAckFromAllHosts
    }
    if (this.config.requireAckFromAnyHost !== undefined) {
      broadcasterConfig.requireAcknowledgmentFromAnyHostForTopics = this.config.requireAckFromAnyHost
    }
    this.broadcaster = new TopicBroadcaster(this.topics, broadcasterConfig)
  }

  // Submit a pre-built Transaction to overlay topics
  async broadcast (tx: Transaction, topics?: string[]): Promise<OverlayBroadcastResult> {
    let broadcaster = this.broadcaster

    // If per-call topics are provided, create a one-off broadcaster
    if ((topics != null) && topics.length > 0) {
      for (const t of topics) {
        if (!t.startsWith('tm_')) {
          throw new Error(`Topic "${t}" must start with "tm_" prefix`)
        }
      }
      const network = this.config.network ?? 'mainnet'
      broadcaster = new TopicBroadcaster(topics, {
        networkPreset: network,
        resolver: this.resolver
      })
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
  async query (service: string, query: unknown, timeout?: number): Promise<LookupAnswer> {
    const question: LookupQuestion = { service, query }
    return await this.resolver.query(question, timeout)
  }

  // Convenience: query + extract parsed outputs
  async lookupOutputs (service: string, query: unknown): Promise<OverlayOutput[]> {
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
  getBroadcaster (): TopicBroadcaster { return this.broadcaster }
  getResolver (): LookupResolver { return this.resolver }
}

// ============================================================================
// Wallet-integrated overlay methods
// ============================================================================

export function createOverlayMethods (core: WalletCore): {
  advertiseSHIP: (domain: string, topic: string, basket?: string) => Promise<TransactionResult>
  advertiseSLAP: (domain: string, service: string, basket?: string) => Promise<TransactionResult>
  broadcastAction: (overlay: Overlay, actionOptions: { outputs: any[], description?: string }, topics?: string[]) => Promise<{ txid: string, broadcast: OverlayBroadcastResult }>
  withRetry: <T>(operation: () => Promise<T>, overlay: Overlay, maxRetries?: number) => Promise<T>
} {
  return {
    // Create a SHIP advertisement: "I host topic X at domain Y"
    async advertiseSHIP (domain: string, topic: string, basket?: string): Promise<TransactionResult> {
      if (!topic.startsWith('tm_')) {
        throw new Error(`Topic "${topic}" must start with "tm_" prefix`)
      }
      const template = new OverlayAdminTokenTemplate(core.getClient())
      const lockingScript = await template.lock('SHIP', domain, topic)
      const result = await core.getClient().createAction({
        description: `SHIP advertisement: ${topic} at ${domain}`,
        outputs: [{
          lockingScript: lockingScript.toHex(),
          satoshis: 1,
          outputDescription: 'SHIP token',
          ...(basket != null ? { basket } : {})
        }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      return {
        txid: result.txid ?? '',
        tx: result.tx
      }
    },

    // Create a SLAP advertisement: "I provide lookup service X at domain Y"
    async advertiseSLAP (domain: string, service: string, basket?: string): Promise<TransactionResult> {
      if (!service.startsWith('ls_')) {
        throw new Error(`Service "${service}" must start with "ls_" prefix`)
      }
      const template = new OverlayAdminTokenTemplate(core.getClient())
      const lockingScript = await template.lock('SLAP', domain, service)
      const result = await core.getClient().createAction({
        description: `SLAP advertisement: ${service} at ${domain}`,
        outputs: [{
          lockingScript: lockingScript.toHex(),
          satoshis: 1,
          outputDescription: 'SLAP token',
          ...(basket != null ? { basket } : {})
        }],
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      return {
        txid: result.txid ?? '',
        tx: result.tx
      }
    },

    // Create action + broadcast to overlay in one step
    async broadcastAction (
      overlay: Overlay,
      actionOptions: { outputs: any[], description?: string },
      topics?: string[]
    ): Promise<{ txid: string, broadcast: OverlayBroadcastResult }> {
      const result = await core.getClient().createAction({
        description: actionOptions.description ?? 'Overlay broadcast',
        outputs: actionOptions.outputs,
        options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
      })
      if (result.tx == null) throw new Error('No tx from createAction')
      const tx = Transaction.fromAtomicBEEF(result.tx)
      const broadcastResult = await overlay.broadcast(tx, topics)
      return { txid: result.txid ?? '', broadcast: broadcastResult }
    },

    // Double-spend retry wrapper
    async withRetry<T>(operation: () => Promise<T>, overlay: Overlay, maxRetries?: number): Promise<T> {
      return await withDoubleSpendRetry(operation, overlay.getBroadcaster(), maxRetries)
    }
  }
}
