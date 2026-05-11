import { Utils } from '@bsv/sdk'
import { Chain } from '../sdk/types'
import { BaseBlockHeader, BlockHeader } from '../sdk/WalletServices.interfaces'
import { toBinaryBaseBlockHeader } from '../services/Services'
import {
  ChaintracksClientApi,
  ChaintracksInfoApi,
  HeaderListener,
  ReorgListener
} from '../services/chaintracker/chaintracks/Api/ChaintracksClientApi'
import { MockChainStorage } from './MockChainStorage'
import { WERR_NOT_IMPLEMENTED } from '../sdk/WERR_errors'
export class MockChainTracker implements ChaintracksClientApi {
  constructor (
    public chain: Chain,
    public storage: MockChainStorage
  ) {}

  async currentHeight (): Promise<number> {
    const tip = await this.storage.getChainTip()
    return tip?.height ?? -1
  }

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    const header = await this.storage.getBlockHeaderByHeight(height)
    if (header == null) return false
    return header.merkleRoot === root
  }

  async getChain (): Promise<Chain> {
    return this.chain
  }

  async getInfo (): Promise<ChaintracksInfoApi> {
    const tip = await this.storage.getChainTip()
    return {
      chain: this.chain,
      heightBulk: tip?.height ?? -1,
      heightLive: tip?.height ?? -1,
      storage: 'mockchain',
      bulkIngestors: [],
      liveIngestors: [],
      packages: []
    }
  }

  async getPresentHeight (): Promise<number> {
    return await this.currentHeight()
  }

  async getHeaders (height: number, count: number): Promise<string> {
    let hex = ''
    for (let h = height; h < height + count; h++) {
      const header = await this.storage.getBlockHeaderByHeight(h)
      if (header == null) break
      const binary = toBinaryBaseBlockHeader(header)
      hex += Utils.toHex(binary)
    }
    return hex
  }

  async findChainTipHeader (): Promise<BlockHeader> {
    const tip = await this.storage.getChainTip()
    if (tip == null) throw new Error('Mock chain has no blocks')
    return tip
  }

  async findChainTipHash (): Promise<string> {
    const tip = await this.storage.getChainTip()
    if (tip == null) throw new Error('Mock chain has no blocks')
    return tip.hash
  }

  async findHeaderForHeight (height: number): Promise<BlockHeader | undefined> {
    return await this.storage.getBlockHeaderByHeight(height)
  }

  async findHeaderForBlockHash (hash: string): Promise<BlockHeader | undefined> {
    return await this.storage.getBlockHeaderByHash(hash)
  }

  async addHeader (_header: BaseBlockHeader): Promise<void> {
    // no-op for mock chain
  }

  async startListening (): Promise<void> {
    // no-op
  }

  async listening (): Promise<void> {
    // no-op
  }

  async isListening (): Promise<boolean> {
    return true
  }

  async isSynchronized (): Promise<boolean> {
    return true
  }

  async subscribeHeaders (_listener: HeaderListener): Promise<string> {
    throw new WERR_NOT_IMPLEMENTED('subscribeHeaders not supported on mock chain')
  }

  async subscribeReorgs (_listener: ReorgListener): Promise<string> {
    throw new WERR_NOT_IMPLEMENTED('subscribeReorgs not supported on mock chain')
  }

  async unsubscribe (_subscriptionId: string): Promise<boolean> {
    throw new WERR_NOT_IMPLEMENTED('unsubscribe not supported on mock chain')
  }
}
