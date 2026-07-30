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
  chaintracks: ChaintracksClientApi
  cache: Record<number, string>
  options: ChaintracksChainTrackerOptions
  readonly telemetry: Telemetry

  constructor(chain?: Chain, chaintracks?: ChaintracksClientApi, options?: ChaintracksChainTrackerOptions) {
    chain ||= 'main'
    this.chaintracks =
      chaintracks ?? new ChaintracksServiceClient(chain, `https://${chain}net-chaintracks.babbage.systems`)
    this.cache = {}
    this.options = options || {}
    this.telemetry = new Telemetry(this.options.telemetry)
  }

  async currentHeight(): Promise<number> {
    if (!this.telemetry.enabled) return await this.chaintracks.getPresentHeight()
    return await this.telemetry.withSpan(
      'wallet.chaintracks.current_height',
      {
        component: 'chaintracks-chain-tracker',
        kind: 'client'
      },
      async () => await this.chaintracks.getPresentHeight()
    )
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    if (!this.telemetry.enabled) return await this.isValidRootForHeightCore(root, height)
    return await this.telemetry.withSpan(
      'wallet.chaintracks.validate_root',
      {
        component: 'chaintracks-chain-tracker',
        kind: 'client'
      },
      async span => await this.isValidRootForHeightCore(root, height, span)
    )
  }

  private async isValidRootForHeightCore(root: string, height: number, parent?: TelemetrySpan): Promise<boolean> {
    const cachedRoot = this.cache[height]
    if (cachedRoot) {
      parent?.end({
        attributes: {
          'chaintracks.cache_hit': true,
          'chaintracks.valid': cachedRoot === root
        }
      })
      return cachedRoot === root
    }

    let header: BlockHeader | undefined

    const retries = Math.max(1, this.options.maxRetries ?? 6)
    const retryDelayMs = this.options.retryDelayMs ?? 250

    let error: WalletError | undefined

    for (let tryCount = 1; tryCount <= retries; tryCount++) {
      try {
        header =
          parent == null
            ? await this.chaintracks.findHeaderForHeight(height)
            : await this.telemetry.withSpan(
                'wallet.chaintracks.find_header',
                {
                  component: 'chaintracks-chain-tracker',
                  kind: 'client',
                  parent: parent.context,
                  attributes: {
                    'retry.attempt': tryCount
                  }
                },
                async () => await this.chaintracks.findHeaderForHeight(height)
              )

        if (header == null) {
          if (tryCount >= retries) return false
          await wait(retryDelayMs)
          continue
        }

        break
      } catch (error_: unknown) {
        error = WalletError.fromUnknown(error_)
        if (tryCount >= retries) {
          throw error
        }
        await wait(retryDelayMs)
      }
    }

    if (header == null) return false

    this.cache[height] = header.merkleRoot

    const valid = header.merkleRoot === root
    parent?.end({
      attributes: {
        'chaintracks.cache_hit': false,
        'chaintracks.valid': valid
      }
    })
    return valid
  }
}
