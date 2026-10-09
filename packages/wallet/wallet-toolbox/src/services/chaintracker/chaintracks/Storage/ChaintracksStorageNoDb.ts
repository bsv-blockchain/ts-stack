import { ChaintracksStorageBaseOptions, InsertHeaderResult } from '../Api/ChaintracksStorageApi'
import { ChaintracksStorageBase } from '../Storage/ChaintracksStorageBase'
import { LiveBlockHeader } from '../Api/BlockHeaderApi'
import { addWork, convertBitsToWork, isMoreWork } from '../util/blockHeaderUtilities'

import { HeightRange } from '../util/HeightRange'
import { Chain } from '../../../../sdk/types'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../../sdk/WERR_errors'
import { BlockHeader } from '../../../../sdk/WalletServices.interfaces'

interface ChaintracksNoDbData {
  chain: Chain
  liveHeaders: Map<number, LiveBlockHeader>
  maxHeaderId: number
  tipHeaderId: number
  hashToHeaderId: Map<string, number>
}

export interface ChaintracksStorageNoDbOptions extends ChaintracksStorageBaseOptions {}

function createInsertHeaderResult(): InsertHeaderResult {
  return {
    added: false,
    dupe: false,
    noPrev: false,
    badPrev: false,
    noActiveAncestor: false,
    isActiveTip: false,
    reorgDepth: 0,
    priorTip: undefined,
    noTip: false,
    deactivatedHeaders: []
  }
}

function snapshotInsertHeaderResult(result: InsertHeaderResult): InsertHeaderResult {
  return {
    ...result,
    priorTip: result.priorTip == null ? undefined : { ...result.priorTip },
    deactivatedHeaders: result.deactivatedHeaders.map(header => ({ ...header }))
  }
}

export class ChaintracksStorageNoDb extends ChaintracksStorageBase {
  static readonly mainData: ChaintracksNoDbData = {
    chain: 'main',
    liveHeaders: new Map<number, LiveBlockHeader>(),
    maxHeaderId: 0,
    tipHeaderId: 0,
    hashToHeaderId: new Map<string, number>()
  }

  static readonly testData: ChaintracksNoDbData = {
    chain: 'test',
    liveHeaders: new Map<number, LiveBlockHeader>(),
    maxHeaderId: 0,
    tipHeaderId: 0,
    hashToHeaderId: new Map<string, number>()
  }

  static readonly stnData: ChaintracksNoDbData = {
    chain: 'stn',
    liveHeaders: new Map<number, LiveBlockHeader>(),
    maxHeaderId: 0,
    tipHeaderId: 0,
    hashToHeaderId: new Map<string, number>()
  }

  static readonly ttnData: ChaintracksNoDbData = {
    chain: 'ttn',
    liveHeaders: new Map<number, LiveBlockHeader>(),
    maxHeaderId: 0,
    tipHeaderId: 0,
    hashToHeaderId: new Map<string, number>()
  }

  static readonly tstnData: ChaintracksNoDbData = {
    chain: 'tstn',
    liveHeaders: new Map<number, LiveBlockHeader>(),
    maxHeaderId: 0,
    tipHeaderId: 0,
    hashToHeaderId: new Map<string, number>()
  }

  static readonly regtestData: ChaintracksNoDbData = {
    chain: 'regtest',
    liveHeaders: new Map<number, LiveBlockHeader>(),
    maxHeaderId: 0,
    tipHeaderId: 0,
    hashToHeaderId: new Map<string, number>()
  }

  private readonly instanceData: ChaintracksNoDbData

  constructor(options: ChaintracksStorageNoDbOptions) {
    super(options)
    this.instanceData = {
      chain: this.chain,
      liveHeaders: new Map<number, LiveBlockHeader>(),
      maxHeaderId: 0,
      tipHeaderId: 0,
      hashToHeaderId: new Map<string, number>()
    }
  }

  override async destroy(): Promise<void> {
    /* intentional no-op: in-memory storage has no cleanup */
  }

  private getMutableData(): ChaintracksNoDbData {
    switch (this.chain) {
      case 'main':
      case 'test':
      case 'stn':
      case 'ttn':
      case 'tstn':
      case 'regtest':
        return this.instanceData
      default:
        throw new WERR_INVALID_PARAMETER(
          'chain',
          `'main', 'test', 'stn', 'ttn', 'tstn', or 'regtest'. '${this.chain}' is unsupported.`
        )
    }
  }

  /** Returns an isolated diagnostic snapshot; mutating it never changes tracker state. */
  async getData(): Promise<ChaintracksNoDbData> {
    const data = this.getMutableData()
    return {
      chain: data.chain,
      liveHeaders: new Map(Array.from(data.liveHeaders, ([id, header]) => [id, { ...header }])),
      maxHeaderId: data.maxHeaderId,
      tipHeaderId: data.tipHeaderId,
      hashToHeaderId: new Map(data.hashToHeaderId)
    }
  }

  override async deleteLiveBlockHeaders(): Promise<void> {
    const data = this.getMutableData()
    data.liveHeaders.clear()
    data.maxHeaderId = 0
    data.tipHeaderId = 0
    data.hashToHeaderId.clear()
  }

  override async deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number> {
    this.validateHeight(maxHeight, 'maxHeight')
    const data = this.getMutableData()
    let deletedCount = 0

    // Clear previousHeaderId references
    for (const [headerId, header] of data.liveHeaders) {
      if (header.previousHeaderId) {
        const prevHeader = data.liveHeaders.get(header.previousHeaderId)
        if (prevHeader != null && prevHeader.height <= maxHeight) {
          data.liveHeaders.set(headerId, { ...header, previousHeaderId: null })
        }
      }
    }

    // Delete headers up to maxHeight
    const headersToDelete = new Set<number>()
    for (const [headerId, header] of data.liveHeaders) {
      if (header.height <= maxHeight) {
        headersToDelete.add(headerId)
        data.hashToHeaderId.delete(header.hash)
      }
    }
    deletedCount = headersToDelete.size
    for (const headerId of headersToDelete) {
      data.liveHeaders.delete(headerId)
    }

    // Update tipHeaderId if necessary
    if (data.liveHeaders.size > 0) {
      const tip = Array.from(data.liveHeaders.values()).find(h => h.isActive && h.isChainTip)
      data.tipHeaderId = tip?.headerId ?? 0
    } else {
      data.tipHeaderId = 0
    }

    return deletedCount
  }

  override async findChainTipHeader(): Promise<LiveBlockHeader> {
    const data = this.getMutableData()
    const tips = Array.from(data.liveHeaders.values()).filter(h => h.isActive && h.isChainTip)
    if (tips.length > 1) throw new WERR_INVALID_OPERATION('multiple active chain tips exist in memory')
    const [tip] = tips
    if (tip == null) throw new Error('Database contains no active chain tip header.')
    return { ...tip }
  }

  override async findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined> {
    const data = this.getMutableData()
    const tips = Array.from(data.liveHeaders.values()).filter(h => h.isActive && h.isChainTip)
    if (tips.length > 1) throw new WERR_INVALID_OPERATION('multiple active chain tips exist in memory')
    const [tip] = tips
    return tip == null ? undefined : { ...tip }
  }

  override async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null> {
    this.validateHash(hash)
    const data = this.getMutableData()
    const headerId = data.hashToHeaderId.get(hash)
    const header = headerId ? data.liveHeaders.get(headerId) : undefined
    return header == null ? null : { ...header }
  }

  override async findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader> {
    if (!Number.isSafeInteger(headerId) || headerId < 1) {
      throw new WERR_INVALID_PARAMETER('headerId', 'a positive safe integer')
    }
    const data = this.getMutableData()
    const header = data.liveHeaders.get(headerId)
    if (header == null) throw new Error(`HeaderId ${headerId} not found in live header database.`)
    return { ...header }
  }

  override async findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null> {
    this.validateHeight(height)
    const data = this.getMutableData()
    const headers = Array.from(data.liveHeaders.values()).filter(h => h.height === height && h.isActive)
    if (headers.length > 1) throw new WERR_INVALID_OPERATION(`multiple active headers exist at height ${height}`)
    const [header] = headers
    return header == null ? null : { ...header }
  }

  override async findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null> {
    this.validateHash(merkleRoot, 'merkleRoot')
    const data = this.getMutableData()
    const headers = Array.from(data.liveHeaders.values()).filter(h => h.merkleRoot === merkleRoot)
    const header = headers.find(h => h.isActive) ?? headers[0]
    return header == null ? null : { ...header }
  }

  override async findLiveHeightRange(): Promise<HeightRange> {
    const data = this.getMutableData()
    const activeHeaders = Array.from(data.liveHeaders.values()).filter(h => h.isActive)
    if (activeHeaders.length === 0) {
      return HeightRange.empty
    }
    const minHeight = Math.min(...activeHeaders.map(h => h.height))
    const maxHeight = Math.max(...activeHeaders.map(h => h.height))
    return new HeightRange(minHeight, maxHeight)
  }

  override async findMaxHeaderId(): Promise<number> {
    const data = this.getMutableData()
    return data.maxHeaderId
  }

  override async liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
      throw new WERR_INVALID_PARAMETER('count', 'an integer from 1 through 100000')
    }
    const data = this.getMutableData()
    return Array.from(data.liveHeaders.values())
      .filter(h => h.isActive)
      .sort((a, b) => a.height - b.height)
      .slice(0, count)
      .map(header => ({ ...header }))
  }

  override async getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]> {
    this.validateRange(range)
    if (range.isEmpty) return []
    const data = this.getMutableData()
    const headers = Array.from(data.liveHeaders.values())
      .filter(h => h.isActive && h.height >= range.minHeight && h.height <= range.maxHeight)
      .sort((a, b) => a.height - b.height)
    return headers.map(header => ({ ...header }))
  }

  private async insertFirstHeader(
    data: ChaintracksNoDbData,
    header: BlockHeader,
    result: InsertHeaderResult
  ): Promise<boolean> {
    if (data.liveHeaders.size !== 0) return false
    const lastBulkFile = await this.bulkManager.getLastFile()
    if (lastBulkFile == null) {
      throw new WERR_INVALID_OPERATION('bulk headers must exist before first live header can be added')
    }
    // getLastFile may yield. Recheck so concurrent first-header attempts cannot
    // both install independent active tips in one in-memory tracker.
    if (data.liveHeaders.size !== 0) return false
    if (
      header.previousHash !== lastBulkFile.lastHash ||
      header.height !== lastBulkFile.firstHeight + lastBulkFile.count
    ) {
      return false
    }
    const newHeader: LiveBlockHeader = {
      ...header,
      headerId: ++data.maxHeaderId,
      previousHeaderId: null,
      chainWork: addWork(lastBulkFile.lastChainWork, convertBitsToWork(header.bits, this.chain)),
      isChainTip: true,
      isActive: true
    }
    data.liveHeaders.set(newHeader.headerId, newHeader)
    data.hashToHeaderId.set(header.hash, newHeader.headerId)
    data.tipHeaderId = newHeader.headerId
    result.isActiveTip = true
    result.added = true
    return true
  }

  private findActiveAncestor(
    data: ChaintracksNoDbData,
    oneBack: LiveBlockHeader,
    result: InsertHeaderResult
  ): LiveBlockHeader | undefined {
    let activeAncestor = oneBack
    const visited = new Set<number>()
    while (!activeAncestor.isActive) {
      this.recordTraversalVisit(visited, activeAncestor, 'finding the active ancestor')
      if (activeAncestor.previousHeaderId == null) {
        result.noActiveAncestor = true
        return undefined
      }
      const previousHeader = data.liveHeaders.get(activeAncestor.previousHeaderId)
      if (previousHeader == null) {
        result.noActiveAncestor = true
        return undefined
      }
      this.validateStoredParentLink(activeAncestor, previousHeader)
      activeAncestor = previousHeader
    }
    return activeAncestor
  }

  private applyReorganization(
    data: ChaintracksNoDbData,
    oneBack: LiveBlockHeader,
    activeAncestor: LiveBlockHeader,
    result: InsertHeaderResult
  ): void {
    if (activeAncestor.headerId === oneBack.headerId) return
    let headerToDeactivate = Array.from(data.liveHeaders.values()).find(
      candidate => candidate.isChainTip && candidate.isActive
    )
    const deactivated = new Set<number>()
    while (headerToDeactivate != null && headerToDeactivate.headerId !== activeAncestor.headerId) {
      this.recordTraversalVisit(deactivated, headerToDeactivate, 'deactivating the prior active chain')
      result.deactivatedHeaders.push(headerToDeactivate)
      data.liveHeaders.set(headerToDeactivate.headerId, {
        ...headerToDeactivate,
        isActive: false
      })
      if (headerToDeactivate.previousHeaderId == null) {
        throw new WERR_INVALID_OPERATION('active chain does not reach the selected reorganization ancestor')
      }
      const previousHeader = data.liveHeaders.get(headerToDeactivate.previousHeaderId)
      if (previousHeader == null) throw new WERR_INVALID_OPERATION('active chain contains a missing parent header')
      this.validateStoredParentLink(headerToDeactivate, previousHeader)
      headerToDeactivate = previousHeader
    }
    if (headerToDeactivate == null) {
      throw new WERR_INVALID_OPERATION('active chain does not reach the selected reorganization ancestor')
    }
    let headerToActivate = oneBack
    const activated = new Set<number>()
    while (headerToActivate.headerId !== activeAncestor.headerId) {
      this.recordTraversalVisit(activated, headerToActivate, 'activating the replacement chain')
      data.liveHeaders.set(headerToActivate.headerId, {
        ...headerToActivate,
        isActive: true
      })
      if (headerToActivate.previousHeaderId == null) {
        throw new WERR_INVALID_OPERATION('replacement chain does not reach the selected reorganization ancestor')
      }
      const previousHeader = data.liveHeaders.get(headerToActivate.previousHeaderId)
      if (previousHeader == null) throw new WERR_INVALID_OPERATION('replacement chain contains a missing parent header')
      this.validateStoredParentLink(headerToActivate, previousHeader)
      headerToActivate = previousHeader
    }
  }

  private prepareActiveTip(
    data: ChaintracksNoDbData,
    header: BlockHeader,
    oneBack: LiveBlockHeader,
    result: InsertHeaderResult
  ): boolean {
    if (!result.isActiveTip) return true
    const activeAncestor = this.findActiveAncestor(data, oneBack, result)
    if (activeAncestor == null) return false
    if (!(oneBack.isActive && oneBack.isChainTip)) {
      result.reorgDepth = Math.min(result.priorTip!.height, header.height) - activeAncestor.height
    }
    this.applyReorganization(data, oneBack, activeAncestor, result)
    return true
  }

  override async insertHeader(header: BlockHeader): Promise<InsertHeaderResult> {
    header = this.validateIncomingHeader(header)
    const data = this.getMutableData()
    const r = createInsertHeaderResult()

    // Check for duplicate
    if (data.hashToHeaderId.has(header.hash)) {
      r.dupe = true
      return r
    }

    // Find previous header
    const oneBack = Array.from(data.liveHeaders.values()).find(h => h.hash === header.previousHash)

    if (oneBack == null) {
      if (await this.insertFirstHeader(data, header, r)) return r
      r.noPrev = true
      return r
    }

    // This header's previousHash matches an existing live header's hash, if height isn't +1, reject it.
    if (oneBack.height + 1 !== header.height) {
      r.badPrev = true
      return r
    }

    r.priorTip =
      oneBack.isActive && oneBack.isChainTip
        ? oneBack
        : (() => {
            const tips = Array.from(data.liveHeaders.values()).filter(h => h.isActive && h.isChainTip)
            if (tips.length > 1) throw new WERR_INVALID_OPERATION('multiple active chain tips exist in memory')
            return tips[0]
          })()

    if (r.priorTip == null) {
      // No active chain tip found. This is a logic error in state of live headers.
      r.noTip = true
      return snapshotInsertHeaderResult(r)
    }

    // We have an acceptable new live header...and live headers has an active chain tip.

    const chainWork = addWork(oneBack.chainWork, convertBitsToWork(header.bits, this.chain))

    r.isActiveTip = isMoreWork(chainWork, r.priorTip.chainWork)

    const newHeader = {
      ...header,
      headerId: ++data.maxHeaderId,
      previousHeaderId: oneBack.headerId,
      chainWork,
      isChainTip: r.isActiveTip,
      isActive: r.isActiveTip
    }

    if (!this.prepareActiveTip(data, header, oneBack, r)) return snapshotInsertHeaderResult(r)

    if (oneBack.isChainTip) {
      data.liveHeaders.set(oneBack.headerId, { ...oneBack, isChainTip: false })
    }

    data.liveHeaders.set(newHeader.headerId, newHeader)
    data.hashToHeaderId.set(newHeader.hash, newHeader.headerId)
    r.added = true

    if (r.added && r.isActiveTip) {
      data.tipHeaderId = newHeader.headerId
      await this.pruneLiveBlockHeaders(newHeader.height)
    }

    return snapshotInsertHeaderResult(r)
  }
}
