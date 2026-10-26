import { WERR_INTERNAL, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER, Chain } from '../../../../sdk'
import {
  InsertHeaderResult,
  ChaintracksStorageBaseOptions,
  ChaintracksStorageIngestApi,
  ChaintracksStorageQueryApi
} from '../Api/ChaintracksStorageApi'
import { BaseBlockHeader, BlockHeader, LiveBlockHeader } from '../Api/BlockHeaderApi'
import { HeightRange } from '../util/HeightRange'
import {
  addWork,
  convertBitsToWork,
  deserializeBaseBlockHeaders,
  isMoreWork,
  serializeBaseBlockHeaders,
  subWork,
  validateHeaderFormat,
  validateHeaderProofOfWork
} from '../util/blockHeaderUtilities'
import { BulkFileDataManager } from '../util/BulkFileDataManager'
import { validateAgainstDirtyHashes } from '../util/dirtyHashes'

const MAX_BULK_HEADER_CANDIDATES = 100000
const MAX_PUBLIC_HEADER_RANGE = 100000
const MAX_STORAGE_LIMIT = 100000
const MAX_STORAGE_TRAVERSAL = 100000
const SUPPORTED_CHAINS = new Set<Chain>(['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'])

/**
 * Required interface methods of a Chaintracks Storage Engine implementation.
 */
export abstract class ChaintracksStorageBase implements ChaintracksStorageQueryApi, ChaintracksStorageIngestApi {
  static createStorageBaseOptions(chain: Chain): ChaintracksStorageBaseOptions {
    const options: ChaintracksStorageBaseOptions = {
      chain,
      liveHeightThreshold: 2000,
      reorgHeightThreshold: 400,
      bulkMigrationChunkSize: 500,
      batchInsertLimit: 400,
      bulkFileDataManager: undefined
    }
    return options
  }

  log: (...args: any[]) => void = () => {}

  chain: Chain
  liveHeightThreshold: number
  reorgHeightThreshold: number
  bulkMigrationChunkSize: number
  batchInsertLimit: number

  isAvailable: boolean = false
  hasMigrated: boolean = false
  bulkManager: BulkFileDataManager

  constructor(options: ChaintracksStorageBaseOptions) {
    this.chain = options.chain
    this.liveHeightThreshold = options.liveHeightThreshold
    this.reorgHeightThreshold = options.reorgHeightThreshold
    this.bulkMigrationChunkSize = options.bulkMigrationChunkSize
    this.batchInsertLimit = options.batchInsertLimit
    this.bulkManager =
      options.bulkFileDataManager || new BulkFileDataManager(BulkFileDataManager.createDefaultOptions(this.chain))
    if (!SUPPORTED_CHAINS.has(this.chain)) {
      throw new WERR_INVALID_PARAMETER('chain', 'a supported Chaintracks network')
    }
    if (!Number.isSafeInteger(this.liveHeightThreshold) || this.liveHeightThreshold < 1) {
      throw new WERR_INVALID_PARAMETER('liveHeightThreshold', 'a positive safe integer')
    }
    if (
      !Number.isSafeInteger(this.reorgHeightThreshold) ||
      this.reorgHeightThreshold < 0 ||
      this.reorgHeightThreshold > this.liveHeightThreshold
    ) {
      throw new WERR_INVALID_PARAMETER(
        'reorgHeightThreshold',
        'a non-negative safe integer no greater than liveHeightThreshold'
      )
    }
    for (const [name, value] of [
      ['bulkMigrationChunkSize', this.bulkMigrationChunkSize],
      ['batchInsertLimit', this.batchInsertLimit]
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1 || value > MAX_STORAGE_LIMIT) {
        throw new WERR_INVALID_PARAMETER(name, `an integer from 1 through ${MAX_STORAGE_LIMIT}`)
      }
    }
    if (this.bulkManager.chain !== this.chain) {
      throw new WERR_INVALID_PARAMETER('bulkFileDataManager', `configured for chain ${this.chain}`)
    }
  }

  protected validateIncomingHeader(header: BlockHeader): BlockHeader {
    validateHeaderFormat(header)
    validateHeaderProofOfWork(header, this.chain)
    validateAgainstDirtyHashes(header.hash)
    return {
      version: header.version,
      previousHash: header.previousHash,
      merkleRoot: header.merkleRoot,
      time: header.time,
      bits: header.bits,
      nonce: header.nonce,
      height: header.height,
      hash: header.hash
    }
  }

  protected validateLiveHeaderRecord(header: LiveBlockHeader, allowUnassignedHeaderId = false): LiveBlockHeader {
    if (header == null || typeof header !== 'object' || Array.isArray(header)) {
      throw new WERR_INVALID_PARAMETER('live header', 'a plain data object')
    }
    const canonical = this.validateIncomingHeader({
      version: header.version,
      previousHash: header.previousHash,
      merkleRoot: header.merkleRoot,
      time: header.time,
      bits: header.bits,
      nonce: header.nonce,
      height: header.height,
      hash: header.hash
    })
    if (!Number.isSafeInteger(header.headerId) || header.headerId < (allowUnassignedHeaderId ? 0 : 1)) {
      throw new WERR_INVALID_PARAMETER(
        'live header headerId',
        allowUnassignedHeaderId ? 'a non-negative safe integer' : 'a positive safe integer'
      )
    }
    if (
      header.previousHeaderId !== null &&
      (!Number.isSafeInteger(header.previousHeaderId) || header.previousHeaderId < 1)
    ) {
      throw new WERR_INVALID_PARAMETER('live header previousHeaderId', 'null or a positive safe integer')
    }
    if (typeof header.chainWork !== 'string' || !/^[0-9a-f]{64}$/.test(header.chainWork)) {
      throw new WERR_INVALID_PARAMETER('live header chainWork', 'exactly 32 lowercase hexadecimal bytes')
    }
    if (typeof header.isActive !== 'boolean' || typeof header.isChainTip !== 'boolean') {
      throw new WERR_INVALID_PARAMETER('live header active/tip state', 'booleans')
    }
    return {
      ...canonical,
      headerId: header.headerId,
      previousHeaderId: header.previousHeaderId,
      chainWork: header.chainWork,
      isActive: header.isActive,
      isChainTip: header.isChainTip
    }
  }

  protected validateHeight(height: number, name = 'height'): void {
    if (!Number.isSafeInteger(height) || height < 0 || height > 0x7fffffff) {
      throw new WERR_INVALID_PARAMETER(name, 'an integer from 0 through 2147483647')
    }
  }

  protected validateHeaderId(headerId: number, name = 'headerId'): void {
    if (!Number.isSafeInteger(headerId) || headerId < 1) {
      throw new WERR_INVALID_PARAMETER(name, 'a positive safe integer')
    }
  }

  protected validateHash(hash: string, name = 'hash'): void {
    if (typeof hash !== 'string' || !/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new WERR_INVALID_PARAMETER(name, 'exactly 32 hexadecimal bytes')
    }
  }

  protected validateRange(range: HeightRange, maximumLength = MAX_PUBLIC_HEADER_RANGE): void {
    if (range == null || typeof range !== 'object') {
      throw new WERR_INVALID_PARAMETER('range', 'a HeightRange')
    }
    this.validateHeight(range.minHeight, 'range.minHeight')
    if (range.maxHeight === -1 || range.maxHeight < range.minHeight) {
      if (!Number.isSafeInteger(range.maxHeight) || range.maxHeight < -1 || range.maxHeight > 0x7fffffff) {
        throw new WERR_INVALID_PARAMETER('range.maxHeight', 'an integer from -1 through 2147483647')
      }
      return
    }
    this.validateHeight(range.maxHeight, 'range.maxHeight')
    if (range.length > maximumLength) {
      throw new WERR_INVALID_PARAMETER('range', `no longer than ${maximumLength} heights`)
    }
  }

  protected recordTraversalVisit(seen: Set<number>, header: LiveBlockHeader, operation: string): void {
    this.validateHeaderId(header.headerId, 'stored headerId')
    this.validateHeight(header.height, 'stored header height')
    if (seen.has(header.headerId)) {
      throw new WERR_INVALID_OPERATION(`cycle detected while ${operation}`)
    }
    if (seen.size >= MAX_STORAGE_TRAVERSAL) {
      throw new WERR_INVALID_OPERATION(`storage traversal exceeded ${MAX_STORAGE_TRAVERSAL} headers`)
    }
    seen.add(header.headerId)
  }

  protected validateStoredParentLink(child: LiveBlockHeader, parent: LiveBlockHeader): void {
    this.validateHeaderId(child.headerId, 'stored child headerId')
    this.validateHeaderId(parent.headerId, 'stored parent headerId')
    if (
      child.previousHeaderId !== parent.headerId ||
      child.previousHash !== parent.hash ||
      child.height !== parent.height + 1
    ) {
      throw new WERR_INVALID_OPERATION('live-header storage contains an invalid parent link')
    }
  }

  async shutdown(): Promise<void> {
    /* base class does notning */
  }

  async makeAvailable(): Promise<void> {
    if (this.isAvailable) return
    this.isAvailable = true
  }

  async migrateLatest(): Promise<void> {
    this.hasMigrated = true
  }

  async dropAllData(): Promise<void> {
    await this.bulkManager.deleteBulkFiles()
    await this.makeAvailable()
  }

  // Abstract functions to be defined by implementation classes

  abstract deleteLiveBlockHeaders(): Promise<void>
  abstract deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number>
  abstract findChainTipHeader(): Promise<LiveBlockHeader>
  abstract findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined>
  abstract findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null>
  abstract findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader>
  abstract findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null>
  abstract findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null>
  abstract findLiveHeightRange(): Promise<HeightRange>
  abstract findMaxHeaderId(): Promise<number>
  abstract liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]>
  abstract getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]>

  /**
   * @param header Header to attempt to add to live storage.
   * @returns details of conditions found attempting to insert header
   */
  abstract insertHeader(header: BlockHeader): Promise<InsertHeaderResult>
  abstract destroy(): Promise<void>

  // BASE CLASS IMPLEMENTATIONS - MAY BE OVERRIDEN

  async getBulkHeaders(range: HeightRange): Promise<Uint8Array> {
    this.validateRange(range)
    if (range.isEmpty) return new Uint8Array()

    // All historical reads must stay behind BulkFileDataManager. The legacy
    // storage reader can fetch an evicted source object directly, bypassing
    // persistent cache lookup, concurrent-miss coalescing, and byte budgets.
    const reader = await this.bulkManager.createReader(range, range.length * 80)
    const data = await reader.read()
    if (data == null) return new Uint8Array()
    return data
  }

  async getHeadersUint8Array(height: number, count: number): Promise<Uint8Array> {
    this.validateHeight(height)
    if (
      !Number.isSafeInteger(count) ||
      count < 1 ||
      count > MAX_PUBLIC_HEADER_RANGE ||
      height + count - 1 > 0x7fffffff
    ) {
      throw new WERR_INVALID_PARAMETER(
        'count',
        `an integer from 1 through ${MAX_PUBLIC_HEADER_RANGE} within the supported height range`
      )
    }
    const ranges = await this.getAvailableHeightRanges()
    const range = new HeightRange(height, height + count - 1)
    const bulkRange = ranges.bulk.intersect(range)
    const liveRange = ranges.live.intersect(range)

    if (liveRange.isEmpty && bulkRange.isEmpty) return new Uint8Array()

    const liveHeaders = await this.getLiveHeaders(liveRange)
    const liveData = serializeBaseBlockHeaders(liveHeaders)
    const bulkData = await this.getBulkHeaders(bulkRange)

    const data = new Uint8Array(liveData.length + bulkData.length)

    if (bulkData.length > 0) data.set(bulkData, 0)

    if (liveData.length > 0) data.set(liveData, bulkData.length)

    return data
  }

  async getHeaders(height: number, count: number): Promise<BaseBlockHeader[]> {
    const data = await this.getHeadersUint8Array(height, count)
    const headers = deserializeBaseBlockHeaders(data)
    return headers
  }

  async deleteBulkBlockHeaders(): Promise<void> {
    await this.bulkManager.deleteBulkFiles()
  }

  async getAvailableHeightRanges(): Promise<{ bulk: HeightRange; live: HeightRange }> {
    await this.makeAvailable()
    const bulk = await this.bulkManager.getHeightRange()
    const live = await this.findLiveHeightRange()
    if (bulk.isEmpty) {
      if (!live.isEmpty && live.minHeight !== 0) {
        throw new Error('With empty bulk storage, live storage must start with genesis header.')
      }
    } else {
      if (!bulk.isEmpty && bulk.minHeight != 0) throw new Error("Bulk storage doesn't start with genesis header.")
      if (!live.isEmpty && !bulk.isEmpty && bulk.maxHeight + 1 !== live.minHeight) {
        throw new Error('There is a gap or overlap between bulk and live header storage.')
      }
    }
    return { bulk, live }
  }

  private lastActiveMinHeight: number | undefined

  async pruneLiveBlockHeaders(activeTipHeight: number): Promise<void> {
    this.validateHeight(activeTipHeight, 'activeTipHeight')
    await this.makeAvailable()
    try {
      const minHeight = this.lastActiveMinHeight || (await this.findLiveHeightRange()).minHeight

      let totalCount = activeTipHeight - minHeight + 1 - this.liveHeightThreshold
      while (totalCount >= this.bulkMigrationChunkSize) {
        const count = Math.min(totalCount, this.bulkMigrationChunkSize)
        await this.migrateLiveToBulk(count)
        totalCount -= count
        this.lastActiveMinHeight = undefined
      }
    } catch (err: unknown) {
      this.log(err)
      throw err
    }
  }

  async findChainTipHash(): Promise<string> {
    await this.makeAvailable()
    const tip = await this.findChainTipHeader()
    return tip.hash
  }

  async findChainTipWork(): Promise<string> {
    await this.makeAvailable()
    const tip = await this.findChainTipHeader()
    return tip.chainWork
  }

  async findChainWorkForBlockHash(hash: string): Promise<string> {
    this.validateHash(hash)
    await this.makeAvailable()
    const header = await this.findLiveHeaderForBlockHash(hash)
    if (header !== null) return header.chainWork
    throw new Error(`Header with hash of ${hash} was not found in the live headers database.`)
  }

  async findBulkFilesHeaderForHeightOrUndefined(height: number): Promise<BlockHeader | undefined> {
    this.validateHeight(height)
    await this.makeAvailable()
    return await this.bulkManager.findHeaderForHeightOrUndefined(height)
  }

  async findHeaderForHeightOrUndefined(height: number): Promise<LiveBlockHeader | BlockHeader | undefined> {
    this.validateHeight(height)
    await this.makeAvailable()
    const liveHeader = await this.findLiveHeaderForHeight(height)
    if (liveHeader !== null) return liveHeader
    const header = await this.findBulkFilesHeaderForHeightOrUndefined(height)
    return header
  }

  async findHeaderForHeight(height: number): Promise<LiveBlockHeader | BlockHeader> {
    this.validateHeight(height)
    const header = await this.findHeaderForHeightOrUndefined(height)
    if (header != null) return header
    throw new Error(`Header with height of ${height} was not found.`)
  }

  async isMerkleRootActive(merkleRoot: string): Promise<boolean> {
    this.validateHash(merkleRoot, 'merkleRoot')
    await this.makeAvailable()
    const header = await this.findLiveHeaderForMerkleRoot(merkleRoot)
    return header?.isActive ?? false
  }

  private async resolveLiveHeaderReference(header: LiveBlockHeader, name: string): Promise<LiveBlockHeader> {
    if (header == null || typeof header !== 'object') {
      throw new WERR_INVALID_PARAMETER(name, 'a live-header reference')
    }
    this.validateHeaderId(header.headerId, `${name}.headerId`)
    this.validateHash(header.hash, `${name}.hash`)
    const stored = await this.findLiveHeaderForHeaderId(header.headerId)
    if (stored.hash !== header.hash) {
      throw new WERR_INVALID_PARAMETER(name, 'a reference matching the stored live header')
    }
    return stored
  }

  private async findStoredCommonAncestor(header1: LiveBlockHeader, header2: LiveBlockHeader): Promise<LiveBlockHeader> {
    const visited1 = new Set<number>()
    const visited2 = new Set<number>()
    const moveToParent = async (
      header: LiveBlockHeader,
      visited: Set<number>,
      operation: string
    ): Promise<LiveBlockHeader> => {
      this.recordTraversalVisit(visited, header, operation)
      if (header.previousHeaderId == null) {
        throw new WERR_INVALID_OPERATION('reached start of live storage without resolving the reorganization')
      }
      const parent = await this.findLiveHeaderForHeaderId(header.previousHeaderId)
      this.validateStoredParentLink(header, parent)
      return parent
    }

    while (header1.headerId !== header2.headerId) {
      if (header1.height === header2.height) {
        header1 = await moveToParent(header1, visited1, 'walking the first reorganization branch')
        header2 = await moveToParent(header2, visited2, 'walking the second reorganization branch')
      } else if (header1.height > header2.height) {
        header1 = await moveToParent(header1, visited1, 'walking the first reorganization branch')
      } else {
        header2 = await moveToParent(header2, visited2, 'walking the second reorganization branch')
      }
    }
    return { ...header1 }
  }

  async findCommonAncestor(header1: LiveBlockHeader, header2: LiveBlockHeader): Promise<LiveBlockHeader> {
    await this.makeAvailable()
    const stored1 = await this.resolveLiveHeaderReference(header1, 'header1')
    const stored2 = await this.resolveLiveHeaderReference(header2, 'header2')
    return await this.findStoredCommonAncestor(stored1, stored2)
  }

  async findReorgDepth(header1: LiveBlockHeader, header2: LiveBlockHeader): Promise<number> {
    await this.makeAvailable()
    const stored1 = await this.resolveLiveHeaderReference(header1, 'header1')
    const stored2 = await this.resolveLiveHeaderReference(header2, 'header2')
    const ancestor = await this.findStoredCommonAncestor(stored1, stored2)
    return Math.max(stored1.height, stored2.height) - ancestor.height
  }

  private nowMigratingLiveToBulk = false

  async migrateLiveToBulk(count: number, ignoreLimits = false): Promise<void> {
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STORAGE_LIMIT) {
      throw new WERR_INVALID_PARAMETER('count', `an integer from 1 through ${MAX_STORAGE_LIMIT}`)
    }
    if (typeof ignoreLimits !== 'boolean') throw new WERR_INVALID_PARAMETER('ignoreLimits', 'a boolean')
    await this.makeAvailable()
    if (!ignoreLimits && count > this.bulkMigrationChunkSize) return

    if (this.nowMigratingLiveToBulk) {
      this.log('Already migrating live to bulk.')
      return
    }

    try {
      this.nowMigratingLiveToBulk = true

      const headers = await this.liveHeadersForBulk(count)

      await this.addLiveHeadersToBulk(headers)

      await this.deleteOlderLiveBlockHeaders(headers.at(-1)!.height)
    } finally {
      this.nowMigratingLiveToBulk = false
    }
  }

  async addBulkHeaders(
    headers: BlockHeader[],
    bulkRange: HeightRange,
    priorLiveHeaders: BlockHeader[]
  ): Promise<BlockHeader[]> {
    await this.makeAvailable()

    if (
      !Array.isArray(headers) ||
      !Array.isArray(priorLiveHeaders) ||
      Object.keys(headers).length !== headers.length ||
      Object.keys(priorLiveHeaders).length !== priorLiveHeaders.length
    ) {
      throw new WERR_INVALID_PARAMETER('headers/priorLiveHeaders', 'dense arrays')
    }
    if (headers.length === 0 && priorLiveHeaders.length === 0) return []

    const candidateCount = headers.length + (priorLiveHeaders?.length ?? 0)
    if (candidateCount > MAX_BULK_HEADER_CANDIDATES) {
      throw new WERR_INVALID_PARAMETER('headers', `at most ${MAX_BULK_HEADER_CANDIDATES} candidates per bulk admission`)
    }

    // Authenticate every candidate before its declared target contributes to
    // chain selection. Copy only canonical header fields so database metadata
    // on trusted LiveBlockHeaders cannot bypass the exact wire-data checks.
    const validatedHeaders = headers.concat(priorLiveHeaders || []).map(header => {
      const candidate: BlockHeader = {
        version: header.version,
        previousHash: header.previousHash,
        merkleRoot: header.merkleRoot,
        time: header.time,
        bits: header.bits,
        nonce: header.nonce,
        height: header.height,
        hash: header.hash
      }
      validateHeaderFormat(candidate)
      validateHeaderProofOfWork(candidate, this.chain)
      validateAgainstDirtyHashes(candidate.hash)
      return candidate
    })

    // Get the current extent of validated bulk and live block headers.
    const before = await this.getAvailableHeightRanges()

    // Review `headers`, applying the following rules:
    // 1. Height must be outside the current bulk HeightRange.
    // 2. Height must not exceed presentHeight - liveHeightThreshold. If presentHeight is unknown, use maximum height across all headers.
    // 3. Compute chainWork for each header.
    // 4. Verify chain of header hash and previousHash values. One header at each height. Retain chain with most chainWork.

    const minHeight = this.getMinimumBulkHeaderHeight(before.bulk, bulkRange)
    const filteredHeaders = validatedHeaders.filter(h => h.height >= minHeight)
    const sortedHeaders = [...filteredHeaders]
    sortedHeaders.sort((a, b) => a.height - b.height)
    const liveHeaders = sortedHeaders.filter(h => bulkRange.isEmpty || !bulkRange.contains(h.height))

    if (liveHeaders.length === sortedHeaders.length) {
      // All headers are live, no bulk headers to add.
      return liveHeaders
    }

    const chains = this.buildBulkHeaderChains(sortedHeaders, bulkRange)
    const bestChain = chains.reduce(
      (best, chain) => (isMoreWork(chain.chainWork, best.chainWork) ? chain : best),
      chains[0]
    )
    const newBulkHeaderCount = bulkRange.maxHeight - bestChain.headers[0].height + 1
    const newBulkHeaders = bestChain.headers.slice(0, newBulkHeaderCount)

    await this.addBulkHeadersFromBestChain(newBulkHeaders, bestChain)

    return liveHeaders
  }

  private getMinimumBulkHeaderHeight(availableBulk: HeightRange, requestedBulk: HeightRange): number {
    if (!requestedBulk.isEmpty) return requestedBulk.minHeight
    return availableBulk.isEmpty ? 0 : availableBulk.maxHeight + 1
  }

  private buildBulkHeaderChains(sortedHeaders: BlockHeader[], bulkRange: HeightRange): AddBulkHeadersChain[] {
    const chains: AddBulkHeadersChain[] = []
    for (const header of sortedHeaders) {
      this.addHeaderToBulkChains(chains, header, bulkRange)
    }
    return chains
  }

  private addHeaderToBulkChains(chains: AddBulkHeadersChain[], header: BlockHeader, bulkRange: HeightRange): void {
    const duplicate = chains.some(chain => chain.headers.at(-1)!.hash === header.hash)
    if (duplicate) return

    const headerWork = convertBitsToWork(header.bits, this.chain)
    const extendedChain = chains.find(chain => {
      const tip = chain.headers.at(-1)!
      return tip.height + 1 === header.height && tip.hash === header.previousHash
    })
    if (extendedChain != null) {
      extendedChain.headers.push(header)
      extendedChain.chainWork = addWork(extendedChain.chainWork, headerWork)
      if (header.height <= bulkRange.maxHeight) {
        extendedChain.bulkChainWork = extendedChain.chainWork
      }
      return
    }

    // Sorted headers may branch from the parent of an existing chain tip.
    const forkedChain = chains.find(chain => {
      const parent = chain.headers.at(-2)!
      return parent.height + 1 === header.height && parent.hash === header.previousHash
    })
    if (forkedChain != null) {
      const forkHeaders = forkedChain.headers.slice(0, -1)
      forkHeaders.push(header)
      const replacedTipWork = convertBitsToWork(forkedChain.headers.at(-1)!.bits, this.chain)
      const forkWork = addWork(subWork(forkedChain.chainWork, replacedTipWork), headerWork)
      chains.push({
        headers: forkHeaders,
        chainWork: forkWork,
        bulkChainWork: header.height <= bulkRange.maxHeight ? forkWork : undefined
      })
      return
    }

    chains.push({
      headers: [header],
      chainWork: headerWork,
      bulkChainWork: header.height <= bulkRange.maxHeight ? headerWork : undefined
    })
  }

  private async addBulkHeadersFromBestChain(newBulkHeaders: BlockHeader[], bestChain: AddBulkHeadersChain) {
    if (!bestChain.bulkChainWork) {
      throw new WERR_INTERNAL(
        `bulkChainWork is not defined for the best chain with height ${bestChain.headers[0].height}`
      )
    }
    await this.bulkManager.mergeIncrementalBlockHeaders(newBulkHeaders, bestChain.bulkChainWork)
  }

  private async addLiveHeadersToBulk(liveHeaders: LiveBlockHeader[]) {
    if (liveHeaders.length === 0) return
    const lastChainWork = liveHeaders.at(-1)!.chainWork
    const firstHeader = liveHeaders[0]
    const previousWork = subWork(firstHeader.chainWork, convertBitsToWork(liveHeaders[0].bits, this.chain))
    const incrementalWork = subWork(lastChainWork, previousWork)
    await this.bulkManager.mergeIncrementalBlockHeaders(liveHeaders, incrementalWork)
  }
}

interface AddBulkHeadersChain {
  headers: BlockHeader[]
  /**
   * Total chainwork of headers.
   */
  chainWork: string
  /**
   * Total chainwork of headers with height not greater than maxBulkHeight.
   */
  bulkChainWork?: string
}
