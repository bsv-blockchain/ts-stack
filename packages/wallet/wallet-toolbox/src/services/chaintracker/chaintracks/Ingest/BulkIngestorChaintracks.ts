import { Chain } from '../../../../sdk'
import { asUint8Array } from '../../../../utility/utilityHelpers.noBuffer'
import { BulkIngestorBaseOptions } from '../Api/BulkIngestorApi'
import { BlockHeader } from '../Api/BlockHeaderApi'
import { ChaintracksClientApi } from '../Api/ChaintracksClientApi'
import { HeightRange, HeightRanges } from '../util/HeightRange'
import { deserializeBlockHeaders } from '../util/blockHeaderUtilities'
import { BulkIngestorBase } from './BulkIngestorBase'

export interface BulkIngestorChaintracksOptions extends BulkIngestorBaseOptions {
  chain: Chain
  chaintracks: ChaintracksClientApi
  /** Maximum headers requested from the upstream service at once. */
  maxHeadersPerRequest?: number
}

/**
 * Uses a go-chaintracks/Arcade-compatible service as a validated bulk source.
 * Retrieved bytes still pass through ChainTracks' local serialization, hash,
 * continuity, and genesis checks before storage.
 */
export class BulkIngestorChaintracks extends BulkIngestorBase {
  private readonly chaintracks: ChaintracksClientApi
  private readonly maxHeadersPerRequest: number
  private networkChecked = false

  constructor(options: BulkIngestorChaintracksOptions) {
    super(options)
    this.chaintracks = options.chaintracks
    this.maxHeadersPerRequest = options.maxHeadersPerRequest ?? 1000
    if (!Number.isInteger(this.maxHeadersPerRequest) || this.maxHeadersPerRequest < 1) {
      throw new Error('maxHeadersPerRequest must be a positive integer.')
    }
  }

  override async getPresentHeight(): Promise<number> {
    await this.ensureNetwork()
    return await this.chaintracks.getPresentHeight()
  }

  async fetchHeaders(
    _before: HeightRanges,
    fetchRange: HeightRange,
    bulkRange: HeightRange,
    priorLiveHeaders: BlockHeader[]
  ): Promise<BlockHeader[]> {
    if (fetchRange.isEmpty) return priorLiveHeaders
    await this.ensureNetwork()

    let liveHeaders = priorLiveHeaders
    let height = fetchRange.minHeight
    while (height <= fetchRange.maxHeight) {
      const requested = Math.min(this.maxHeadersPerRequest, fetchRange.maxHeight - height + 1)
      const hex = await this.chaintracks.getHeaders(height, requested)
      const bytes = asUint8Array(hex)
      if (bytes.length === 0) {
        throw new Error(`ChainTracks upstream returned no headers at height ${height}.`)
      }
      if (bytes.length % 80 !== 0 || bytes.length > requested * 80) {
        throw new Error(
          `ChainTracks upstream returned ${bytes.length} bytes for ${requested} headers at height ${height}.`
        )
      }
      const headers = deserializeBlockHeaders(height, bytes)
      liveHeaders = await this.storage().addBulkHeaders(headers, bulkRange, liveHeaders)
      height += headers.length
      if (headers.length < requested && height <= fetchRange.maxHeight) {
        throw new Error(
          `ChainTracks upstream returned ${headers.length} of ${requested} headers at height ${height - headers.length}.`
        )
      }
    }
    return liveHeaders
  }

  private async ensureNetwork(): Promise<void> {
    if (this.networkChecked) return
    const actual = await this.chaintracks.getChain()
    if (actual !== this.chain) {
      throw new Error(`ChainTracks upstream network '${actual}' does not match configured chain '${this.chain}'.`)
    }
    this.networkChecked = true
  }
}
