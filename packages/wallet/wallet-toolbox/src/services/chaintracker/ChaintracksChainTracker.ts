import { ChainTracker } from '@bsv/sdk'
import { ChaintracksServiceClient } from './chaintracks/ChaintracksServiceClient'
import { Chain } from '../../sdk/types'
import { WalletError } from '../../sdk/WalletError'
import { wait } from '../../utility/utilityHelpers'
import { WERR_INTERNAL } from '../../sdk/WERR_errors'
import { BlockHeader } from '../../sdk/WalletServices.interfaces'
import { ChaintracksClientApi } from './chaintracks/Api/ChaintracksClientApi'

export interface ChaintracksChainTrackerOptions {
  maxRetries?: number
}

export class ChaintracksChainTracker implements ChainTracker {
  chaintracks: ChaintracksClientApi
  cache: Record<number, string>
  options: ChaintracksChainTrackerOptions

  constructor(chain?: Chain, chaintracks?: ChaintracksClientApi, options?: ChaintracksChainTrackerOptions) {
    chain ||= 'main'
    this.chaintracks =
      chaintracks ?? new ChaintracksServiceClient(chain, `https://${chain}net-chaintracks.babbage.systems`)
    this.cache = {}
    this.options = options || {}
  }

  async currentHeight(): Promise<number> {
    return await this.chaintracks.getPresentHeight()
  }

  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    const cachedRoot = this.cache[height]
    if (cachedRoot) {
      return cachedRoot === root
    }

    let header: BlockHeader | undefined

    const retries = this.options.maxRetries || 3

    let error: WalletError | undefined = undefined

    for (let tryCount = 1; tryCount <= retries; tryCount++) {
      try {
        header = await this.chaintracks.findHeaderForHeight(height)

        if (!header) {
          return false
        }

        break
      } catch (eu: unknown) {
        error = WalletError.fromUnknown(eu)
        if (tryCount > retries) {
          throw error
        }
        await wait(1000)
      }
    }

    if (!header) throw new WERR_INTERNAL('no header should have returned false or thrown an error.')

    this.cache[height] = header.merkleRoot

    if (header.merkleRoot !== root) {
      return false
    }

    return true
  }
}
