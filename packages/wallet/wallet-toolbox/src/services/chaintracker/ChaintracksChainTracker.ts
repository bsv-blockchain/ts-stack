import { ChainTracker, Telemetry, TelemetryConfig, TelemetrySpan } from '@bsv/sdk'
import { ChaintracksServiceClient } from './chaintracks/ChaintracksServiceClient'
import { Chain } from '../../sdk/types'
import { WalletError } from '../../sdk/WalletError'
import { wait } from '../../utility/utilityHelpers'
import { BlockHeader } from '../../sdk/WalletServices.interfaces'
import { ChaintracksClientApi } from './chaintracks/Api/ChaintracksClientApi'

export interface ChaintracksChainTrackerOptions {
  maxRetries?: number
  retryDelayMs?: number
  telemetry?: TelemetryConfig
}

export class ChaintracksChainTracker implements ChainTracker {
  private _chaintracks: ChaintracksClientApi
  private verificationContext = 0
  private reorgEpoch = 0
  private observerGeneration = 0
  private reorgSubscription?: string
  private reorgProvider?: ChaintracksClientApi
  private reorgSetup?: Promise<void>
  private readonly cacheUpdatedAt: Record<number, number> = {}
  cache: Record<number, string>
  options: ChaintracksChainTrackerOptions
  readonly telemetry: Telemetry

  constructor(chain?: Chain, chaintracks?: ChaintracksClientApi, options?: ChaintracksChainTrackerOptions) {
    chain ||= 'main'
    this._chaintracks =
      chaintracks ?? new ChaintracksServiceClient(chain, `https://${chain}net-chaintracks.babbage.systems`)
    this.cache = {}
    this.options = options || {}
    this.telemetry = new Telemetry(this.options.telemetry)
  }

  get chaintracks(): ChaintracksClientApi {
    return this._chaintracks
  }

  set chaintracks(value: ChaintracksClientApi) {
    if (value === this._chaintracks) return
    this._chaintracks = value
    this.verificationContext++
    this.observerGeneration++
    this.cache = {}
    for (const height of Object.keys(this.cacheUpdatedAt)) delete this.cacheUpdatedAt[Number(height)]
    void this.releaseReorgListener()
  }

  /** Local provider-generation marker for consumers that invalidate derived verdicts. */
  getVerificationContext(): string {
    return `chaintracks:${this.verificationContext}:${this.reorgEpoch}:${this.observerGeneration}`
  }

  /** Fresh provider-bound canonical tip token; unlike the stable context, normal tip advances change it. */
  async getVerificationContextToken(signal?: AbortSignal): Promise<string> {
    this.throwIfAborted(signal)
    const chaintracks = this.chaintracks
    const context = this.verificationContext
    const marker = this.getVerificationContext()
    await this.ensureReorgListener(chaintracks, context)
    this.throwIfAborted(signal)
    if (this.getVerificationContext() !== marker)
      throw new Error('Chaintracks provider changed during event registration')
    const tip = await chaintracks.findChainTipHash()
    this.throwIfAborted(signal)
    if (
      this.chaintracks !== chaintracks ||
      this.verificationContext !== context ||
      this.getVerificationContext() !== marker
    ) {
      throw new Error('Chaintracks provider changed during canonical token lookup')
    }
    return JSON.stringify([marker, tip])
  }

  async dispose(): Promise<void> {
    this.observerGeneration++
    await this.releaseReorgListener()
  }

  private reorgSubscribe(provider: ChaintracksClientApi): ((listener: unknown) => Promise<string>) | undefined {
    if (provider.supportsReorgEvents === false) return undefined
    const events = provider as ChaintracksClientApi & {
      subscribeReorgs?: (listener: unknown) => Promise<string>
    }
    if (typeof events.subscribeReorgs === 'function') return async listener => await events.subscribeReorgs!(listener)
    if (provider.supportsReorgEvents === true) {
      throw new Error('Chaintracks provider promised reorg events but subscribeReorgs is not implemented')
    }
    return undefined
  }

  private async ensureReorgListener(provider: ChaintracksClientApi, context: number): Promise<void> {
    const subscribe = this.reorgSubscribe(provider)
    if (subscribe == null) return
    if (this.reorgProvider === provider && this.reorgSubscription != null) return
    if (this.reorgSetup != null) {
      await this.reorgSetup
      if (this.chaintracks !== provider || this.verificationContext !== context)
        throw new Error('Chaintracks provider changed during event registration')
      if (this.reorgProvider === provider && this.reorgSubscription != null) return
    }
    const generation = this.observerGeneration
    this.reorgSetup = (async () => {
      const subscription = await subscribe(() => {
        if (
          this.chaintracks === provider &&
          this.verificationContext === context &&
          this.observerGeneration === generation
        )
          this.reorgEpoch++
      })
      if (
        this.chaintracks !== provider ||
        this.verificationContext !== context ||
        this.observerGeneration !== generation
      ) {
        await provider.unsubscribe(subscription).catch(() => undefined)
        return
      }
      this.reorgProvider = provider
      this.reorgSubscription = subscription
    })()
    try {
      await this.reorgSetup
    } finally {
      this.reorgSetup = undefined
    }
  }

  private async releaseReorgListener(): Promise<void> {
    const provider = this.reorgProvider
    const subscription = this.reorgSubscription
    this.reorgProvider = undefined
    this.reorgSubscription = undefined
    if (provider != null && subscription != null) await provider.unsubscribe(subscription).catch(() => undefined)
  }

  async currentHeight(signal?: AbortSignal): Promise<number> {
    this.throwIfAborted(signal)
    const chaintracks = this.chaintracks
    const context = this.verificationContext
    const currentHeight = async (): Promise<number> => {
      const height = await chaintracks.getPresentHeight()
      this.throwIfAborted(signal)
      if (this.chaintracks !== chaintracks || this.verificationContext !== context)
        throw new Error('Chaintracks provider changed during height lookup')
      return height
    }
    if (!this.telemetry.enabled) return await currentHeight()
    return await this.telemetry.withSpan(
      'wallet.chaintracks.current_height',
      {
        component: 'chaintracks-chain-tracker',
        kind: 'client'
      },
      async () => await currentHeight()
    )
  }

  async isValidRootForHeight(root: string, height: number, signal?: AbortSignal): Promise<boolean> {
    this.throwIfAborted(signal)
    if (!this.telemetry.enabled) return await this.isValidRootForHeightCore(root, height, undefined, signal)
    return await this.telemetry.withSpan(
      'wallet.chaintracks.validate_root',
      {
        component: 'chaintracks-chain-tracker',
        kind: 'client'
      },
      async span => await this.isValidRootForHeightCore(root, height, span, signal)
    )
  }

  private async isValidRootForHeightCore(
    root: string,
    height: number,
    parent?: TelemetrySpan,
    signal?: AbortSignal
  ): Promise<boolean> {
    const header = await this.fetchCanonicalHeader(
      this.chaintracks,
      this.verificationContext,
      height,
      parent,
      signal
    )
    if (header == null) return false

    // Diagnostic only: a root is always freshly read from the current canonical source above.
    this.cache[height] = header.merkleRoot
    this.cacheUpdatedAt[height] = Date.now()
    this.pruneDiagnosticCache()

    const valid = header.merkleRoot === root
    parent?.end({
      attributes: {
        'chaintracks.cache_hit': false,
        'chaintracks.valid': valid
      }
    })
    return valid
  }

  private assertProviderUnchanged(chaintracks: ChaintracksClientApi, context: number): void {
    if (this.chaintracks !== chaintracks || this.verificationContext !== context) {
      throw new Error('Chaintracks provider changed during header lookup')
    }
  }

  private async readHeaderForHeight(
    chaintracks: ChaintracksClientApi,
    height: number,
    tryCount: number,
    parent?: TelemetrySpan
  ): Promise<BlockHeader | undefined> {
    if (parent == null) return await chaintracks.findHeaderForHeight(height)
    return await this.telemetry.withSpan(
      'wallet.chaintracks.find_header',
      {
        component: 'chaintracks-chain-tracker',
        kind: 'client',
        parent: parent.context,
        attributes: {
          'retry.attempt': tryCount
        }
      },
      async () => await chaintracks.findHeaderForHeight(height)
    )
  }

  private async fetchCanonicalHeader(
    chaintracks: ChaintracksClientApi,
    context: number,
    height: number,
    parent: TelemetrySpan | undefined,
    signal: AbortSignal | undefined
  ): Promise<BlockHeader | undefined> {
    const retries = Math.max(1, this.options.maxRetries ?? 6)
    const retryDelayMs = this.options.retryDelayMs ?? 250
    for (let tryCount = 1; tryCount <= retries; tryCount++) {
      try {
        this.throwIfAborted(signal)
        this.assertProviderUnchanged(chaintracks, context)
        const header = await this.readHeaderForHeight(chaintracks, height, tryCount, parent)
        this.assertProviderUnchanged(chaintracks, context)
        if (header != null) return header
        if (tryCount >= retries) return undefined
        this.throwIfAborted(signal)
        await wait(retryDelayMs)
      } catch (error_: unknown) {
        this.throwIfAborted(signal)
        this.assertProviderUnchanged(chaintracks, context)
        const error = WalletError.fromUnknown(error_)
        if (tryCount >= retries) throw error
        this.throwIfAborted(signal)
        await wait(retryDelayMs)
      }
    }
    return undefined
  }

  private pruneDiagnosticCache(): void {
    const now = Date.now()
    const entries = Object.entries(this.cacheUpdatedAt).sort(([, a], [, b]) => a - b)
    for (const [index, [cachedHeight, updatedAt]] of entries.entries()) {
      if (index >= entries.length - 256 && now - updatedAt <= 5 * 60 * 1000) continue
      delete this.cache[Number(cachedHeight)]
      delete this.cacheUpdatedAt[Number(cachedHeight)]
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted === true) throw signal.reason ?? new Error('Chaintracks verification aborted')
  }
}
