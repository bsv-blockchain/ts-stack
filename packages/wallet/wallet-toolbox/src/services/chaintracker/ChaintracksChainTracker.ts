import { ChainTracker } from '@bsv/sdk'
import { ChaintracksServiceClient } from './chaintracks/ChaintracksServiceClient'
import { Chain } from '../../sdk/types'
import { WalletError } from '../../sdk/WalletError'
import { wait } from '../../utility/utilityHelpers'
import { BlockHeader } from '../../sdk/WalletServices.interfaces'
import { ChaintracksClientApi } from './chaintracks/Api/ChaintracksClientApi'

export interface ChaintracksChainTrackerOptions {
  maxRetries?: number
  retryDelayMs?: number
}

export class ChaintracksChainTracker implements ChainTracker {
  chaintracks: ChaintracksClientApi
  cache: Record<number, string>
  options: ChaintracksChainTrackerOptions

  constructor (chain?: Chain, chaintracks?: ChaintracksClientApi, options?: ChaintracksChainTrackerOptions) {
    chain ||= 'main'
    this.chaintracks =
      chaintracks ?? new ChaintracksServiceClient(chain, `https://${chain}net-chaintracks.babbage.systems`)
    this.cache = {}
    this.options = options || {}
  }

  async currentHeight (): Promise<number> {
    return await this.chaintracks.getPresentHeight()
  }

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    const cachedRoot = this.cache[height]
    if (cachedRoot) {
      return cachedRoot === root
    }

    let header: BlockHeader | undefined

    const retries = Math.max(1, this.options.maxRetries ?? 6)
    const retryDelayMs = this.options.retryDelayMs ?? 250

    let error: WalletError | undefined

    for (let tryCount = 1; tryCount <= retries; tryCount++) {
      try {
        header = await this.chaintracks.findHeaderForHeight(height)

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

    if (header.merkleRoot !== root) {
      return false
    }

    return true
  }
}
