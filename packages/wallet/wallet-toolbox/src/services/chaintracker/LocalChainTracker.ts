import type { ChainTracker } from '@bsv/sdk'
import type { ChaintracksClientApi } from './chaintracks/Api/ChaintracksClientApi'

/** @public */
export type LocalChainTrackerMode = 'local-primary' | 'remote-only'

/** @public */
export type LocalChainTrackerConsistency =
  'unchecked' | 'agreed' | 'lagging' | 'diverged' | 'insufficient-references' | 'error'

/** @public */
export interface LocalChainTrackerRecoveryEvidence {
  reason: 'lagging' | 'diverged'
  localHeight: number
  referenceHeight: number
  heightLag: number
  comparisonHeight: number
  expectedHash: string
  referenceAgreement: number
}

/** @public */
export interface LocalChainTrackerStatus {
  mode: LocalChainTrackerMode
  activeSource: string
  consistency: LocalChainTrackerConsistency
  localHeight?: number
  localTipHash?: string
  referenceHeight?: number
  heightLag?: number
  comparisonHeight?: number
  expectedHash?: string
  referenceAgreement?: number
  checkedAt?: string
  recoveredAt?: string
  lastFallbackAt?: string
  lastError?: string
}

/** @public */
export interface LocalChainTrackerOptions {
  /** Locally persisted, proof-of-work-validating ChainTracks client. */
  local: ChaintracksClientApi
  /** Independent references used for diagnostics and exceptional fallback. */
  fallbacks?: ChaintracksClientApi[]
  mode?: LocalChainTrackerMode
  fallbackOnLocalError?: boolean
  /** Number of matching references needed for a fallback validation result. */
  requiredFallbackAgreement?: number
  /** Number of matching references needed to declare local divergence. */
  requiredConsistencyAgreement?: number
  /** Quorum-backed height lag tolerated before local state is considered stuck. */
  maxHeightLag?: number
  autoRecover?: boolean
  /** Clears/reseeds local state and returns the replacement local client. */
  recoverLocal?: (evidence: LocalChainTrackerRecoveryEvidence) => Promise<ChaintracksClientApi>
  /** Clears local state and returns a fresh local client. */
  clearLocal?: () => Promise<ChaintracksClientApi>
  now?: () => Date
}

/**
 * Local-first SDK ChainTracker with explicit management and fallback state.
 *
 * A definitive local `false` validation is never overridden by a remote
 * source. Fallback is reserved for local exceptions or explicit remote-only
 * mode, and applications can require agreement across multiple independent
 * references before accepting a fallback result.
 *
 * @public
 */
export class LocalChainTracker implements ChainTracker {
  private local: ChaintracksClientApi
  private readonly fallbacks: ChaintracksClientApi[]
  private readonly fallbackOnLocalError: boolean
  private readonly requiredFallbackAgreement: number
  private readonly requiredConsistencyAgreement: number
  private readonly maxHeightLag: number
  private readonly autoRecover: boolean
  private readonly recoverLocal: LocalChainTrackerOptions['recoverLocal']
  private readonly clearLocal: LocalChainTrackerOptions['clearLocal']
  private readonly now: () => Date
  private status: LocalChainTrackerStatus

  constructor(options: LocalChainTrackerOptions) {
    this.local = options.local
    this.fallbacks = [...(options.fallbacks ?? [])]
    this.fallbackOnLocalError = options.fallbackOnLocalError ?? true
    this.requiredFallbackAgreement = this.validateAgreement(
      options.requiredFallbackAgreement ?? 1,
      'requiredFallbackAgreement'
    )
    this.requiredConsistencyAgreement = this.validateAgreement(
      options.requiredConsistencyAgreement ?? 2,
      'requiredConsistencyAgreement'
    )
    this.maxHeightLag = this.validateHeightLag(options.maxHeightLag ?? 6)
    this.autoRecover = options.autoRecover ?? false
    this.recoverLocal = options.recoverLocal
    this.clearLocal = options.clearLocal
    this.now = options.now ?? (() => new Date())
    this.status = {
      mode: options.mode ?? 'local-primary',
      activeSource: options.mode === 'remote-only' ? 'fallback' : 'local',
      consistency: 'unchecked'
    }
  }

  getMode(): LocalChainTrackerMode {
    return this.status.mode
  }

  setMode(mode: LocalChainTrackerMode): void {
    this.status = {
      ...this.status,
      mode,
      activeSource: mode === 'remote-only' ? 'fallback' : 'local'
    }
  }

  getStatus(): LocalChainTrackerStatus {
    return { ...this.status }
  }

  getLocalClient(): ChaintracksClientApi {
    return this.local
  }

  async currentHeight(): Promise<number> {
    if (this.status.mode === 'remote-only') {
      return await this.fallbackHeight()
    }
    try {
      const height = await this.local.getPresentHeight()
      this.status = { ...this.status, activeSource: 'local', localHeight: height, lastError: undefined }
      return height
    } catch (error) {
      this.recordError(error)
      if (!this.fallbackOnLocalError) throw error
      return await this.fallbackHeight()
    }
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    if (this.status.mode !== 'remote-only') {
      try {
        const valid = await this.local.isValidRootForHeight(root, height)
        this.status = { ...this.status, activeSource: 'local', lastError: undefined }
        return valid
      } catch (error) {
        this.recordError(error)
        if (!this.fallbackOnLocalError) throw error
      }
    }
    return await this.fallbackValidation(root, height)
  }

  async synchronize(): Promise<LocalChainTrackerStatus> {
    await this.local.startListening()
    await this.local.listening()
    return await this.checkConsistency()
  }

  async clearLocalData(): Promise<LocalChainTrackerStatus> {
    if (this.clearLocal == null) throw new Error('Local ChainTracks clearing is not configured.')
    this.local = await this.clearLocal()
    this.status = {
      mode: this.status.mode,
      activeSource: this.status.mode === 'remote-only' ? 'fallback' : 'local',
      consistency: 'unchecked'
    }
    return this.getStatus()
  }

  async checkConsistency(): Promise<LocalChainTrackerStatus> {
    return await this.checkConsistencyInternal(true)
  }

  private async checkConsistencyInternal(allowRecovery: boolean): Promise<LocalChainTrackerStatus> {
    const checkedAt = this.now().toISOString()
    try {
      const localHeight = await this.local.getPresentHeight()
      const localTipHash = await this.local.findChainTipHash()
      const references = await Promise.all(
        this.fallbacks.map(async (client, index) => {
          try {
            return { client, index, height: await client.getPresentHeight() }
          } catch {
            return undefined
          }
        })
      )
      const available = references.filter(
        (value): value is { client: ChaintracksClientApi; index: number; height: number } => value != null
      )
      if (available.length === 0) {
        this.status = {
          ...this.status,
          activeSource: 'local',
          consistency: 'insufficient-references',
          localHeight,
          localTipHash,
          checkedAt,
          lastError: undefined
        }
        return this.getStatus()
      }

      if (available.length < this.requiredConsistencyAgreement) {
        this.status = {
          ...this.status,
          activeSource: 'local',
          consistency: 'insufficient-references',
          localHeight,
          localTipHash,
          checkedAt,
          lastError: undefined
        }
        return this.getStatus()
      }

      // The Nth highest reference height is the greatest height reached by at
      // least N references. A stale or inflated minority cannot move it.
      const referenceHeight = [...available].map(reference => reference.height).sort((a, b) => b - a)[
        this.requiredConsistencyAgreement - 1
      ]
      const comparisonHeight = Math.min(localHeight, referenceHeight)
      const heightLag = Math.max(0, referenceHeight - localHeight)
      const localHeader = await this.local.findHeaderForHeight(comparisonHeight)
      const referenceHeaders = await Promise.all(
        available
          .filter(reference => reference.height >= comparisonHeight)
          .map(async reference => {
            try {
              return await reference.client.findHeaderForHeight(comparisonHeight)
            } catch {
              return undefined
            }
          })
      )
      const agreements = new Map<string, number>()
      for (const header of referenceHeaders) {
        if (header != null) agreements.set(header.hash, (agreements.get(header.hash) ?? 0) + 1)
      }
      const [expectedHash, referenceAgreement] = [...agreements.entries()].sort(
        ([hashA, countA], [hashB, countB]) => countB - countA || hashA.localeCompare(hashB)
      )[0] ?? [undefined, 0]

      const enoughReferences = referenceAgreement >= this.requiredConsistencyAgreement
      let consistency: LocalChainTrackerConsistency
      if (!enoughReferences) consistency = 'insufficient-references'
      else if (localHeader?.hash !== expectedHash) consistency = 'diverged'
      else if (heightLag > this.maxHeightLag) consistency = 'lagging'
      else consistency = 'agreed'
      this.status = {
        ...this.status,
        activeSource: 'local',
        consistency,
        localHeight,
        localTipHash,
        referenceHeight,
        heightLag,
        comparisonHeight,
        expectedHash,
        referenceAgreement,
        checkedAt,
        lastError: undefined
      }

      if (
        (consistency === 'diverged' || consistency === 'lagging') &&
        allowRecovery &&
        this.autoRecover &&
        this.recoverLocal != null &&
        expectedHash != null
      ) {
        this.local = await this.recoverLocal({
          reason: consistency,
          localHeight,
          referenceHeight,
          heightLag,
          comparisonHeight,
          expectedHash,
          referenceAgreement
        })
        const recoveredAt = this.now().toISOString()
        const recovered = await this.checkConsistencyInternal(false)
        this.status = { ...recovered, recoveredAt }
      }
      return this.getStatus()
    } catch (error) {
      this.status = {
        ...this.status,
        consistency: 'error',
        checkedAt,
        lastError: this.errorMessage(error)
      }
      return this.getStatus()
    }
  }

  private async fallbackHeight(): Promise<number> {
    let lastError: unknown
    for (const [index, fallback] of this.fallbacks.entries()) {
      try {
        const height = await fallback.getPresentHeight()
        this.recordFallback(index)
        return height
      } catch (error) {
        lastError = error
      }
    }
    const error = lastError ?? new Error('No fallback ChainTracks source is configured.')
    this.recordError(error)
    throw error
  }

  private async fallbackValidation(root: string, height: number): Promise<boolean> {
    let valid = 0
    let invalid = 0
    let lastError: unknown
    for (const [index, fallback] of this.fallbacks.entries()) {
      try {
        if (await fallback.isValidRootForHeight(root, height)) valid++
        else invalid++
        if (valid >= this.requiredFallbackAgreement) {
          this.recordFallback(index)
          return true
        }
        if (invalid >= this.requiredFallbackAgreement) {
          this.recordFallback(index)
          return false
        }
      } catch (error) {
        lastError = error
      }
    }
    const error =
      lastError ??
      new Error(
        `Fallback agreement unavailable: ${valid} valid and ${invalid} invalid responses, ` +
          `${this.requiredFallbackAgreement} required.`
      )
    this.recordError(error)
    throw error
  }

  private recordFallback(index: number): void {
    this.status = {
      ...this.status,
      activeSource: `fallback-${index + 1}`,
      lastFallbackAt: this.now().toISOString(),
      lastError: undefined
    }
  }

  private recordError(error: unknown): void {
    this.status = { ...this.status, activeSource: 'unavailable', lastError: this.errorMessage(error) }
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  private validateAgreement(value: number, name: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
    return value
  }

  private validateHeightLag(value: number): number {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error('maxHeightLag must be a non-negative safe integer')
    }
    return value
  }
}
