import { BulkFileDataReader } from './BulkFileDataReader'
import { ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import { BlockHeader, Chain, WERR_INTERNAL, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../../sdk'
import { Hash } from '@bsv/sdk'
import { asArray, asString, asUint8Array } from '../../../../utility/utilityHelpers.noBuffer'
import { BulkHeaderFileInfo, BulkHeaderFilesInfo } from './BulkHeaderFile'
import { isKnownValidBulkHeaderFile, validBulkHeaderFiles } from './validBulkHeaderFilesByFileHash'
import { HeightRange } from './HeightRange'
import {
  addWork,
  convertBitsToWork,
  deserializeBlockHeader,
  serializeBaseBlockHeaders,
  subWork,
  validateBufferOfHeaders,
  validateGenesisHeader
} from './blockHeaderUtilities'
import { ChaintracksStorageBulkFileApi } from '../Api/ChaintracksStorageApi'
import { ChaintracksFetch } from './ChaintracksFetch'
import { ChaintracksFsApi } from '../Api/ChaintracksFsApi'
import { SingleWriterMultiReaderLock } from './SingleWriterMultiReaderLock'

export interface BulkFileDataManagerOptions {
  chain: Chain
  maxPerFile: number
  maxRetained?: number
  fetch?: ChaintracksFetchApi
  fromKnownSourceUrl?: string
}

/**
 * Manages bulk file data (typically 8MB chunks of 100,000 headers each).
 *
 * If not cached in memory,
 * optionally fetches data by `sourceUrl` from CDN on demand,
 * optionally finds data by `fileId` in a database on demand,
 * and retains a limited number of files in memory,
 * subject to the optional `maxRetained` limit.
 */
export class BulkFileDataManager {
  static createDefaultOptions (chain: Chain): BulkFileDataManagerOptions {
    return {
      chain,
      maxPerFile: 100000,
      maxRetained: 2,
      fetch: new ChaintracksFetch(),
      fromKnownSourceUrl: 'https://cdn.projectbabbage.com/blockheaders'
    }
  }

  private log: (...args: any[]) => void = () => {}

  private bfds: BulkFileData[] = []
  private fileHashToIndex: Record<string, number> = {}
  private readonly lock: SingleWriterMultiReaderLock = new SingleWriterMultiReaderLock()
  private storage?: ChaintracksStorageBulkFileApi

  readonly chain: Chain
  readonly maxPerFile: number
  readonly fetch?: ChaintracksFetchApi
  readonly maxRetained?: number
  readonly fromKnownSourceUrl?: string

  constructor (options: BulkFileDataManagerOptions | Chain) {
    const resolvedOptions = typeof options === 'object' ? options : BulkFileDataManager.createDefaultOptions(options)
    this.chain = resolvedOptions.chain
    this.maxPerFile = resolvedOptions.maxPerFile
    this.maxRetained = resolvedOptions.maxRetained
    this.fromKnownSourceUrl = resolvedOptions.fromKnownSourceUrl
    this.fetch = resolvedOptions.fetch

    this.deleteBulkFilesNoLock()
  }

  async deleteBulkFiles (): Promise<void> {
    return await this.lock.withWriteLock(async () => this.deleteBulkFilesNoLock())
  }

  private deleteBulkFilesNoLock (): void {
    this.bfds = []
    this.fileHashToIndex = {}

    if (this.fromKnownSourceUrl) {
      const vbhfs = validBulkHeaderFiles
      const filtered = vbhfs.filter(f => f.sourceUrl === this.fromKnownSourceUrl)
      const files = selectBulkHeaderFiles(filtered, this.chain, this.maxPerFile)
      for (const file of files) {
        this.add({ ...file, fileHash: file.fileHash!, mru: Date.now() })
      }
    }
  }

  /**
   * If `bfds` are going to be backed by persistent storage,
   * must be called before making storage available.
   *
   * Synchronizes bfds and storage files, after which this manager maintains sync.
   * There should be no changes to bulk files by direct access to storage bulk file methods.
   */
  async setStorage (storage: ChaintracksStorageBulkFileApi, log: (...args: any[]) => void): Promise<void> {
    return await this.lock.withWriteLock(async () => await this.setStorageNoLock(storage, log))
  }

  private async setStorageNoLock (storage: ChaintracksStorageBulkFileApi, log: (...args: any[]) => void): Promise<void> {
    this.storage = storage
    this.log = log

    // Get files currently in persistent storage.
    const sfs = await this.storage.getBulkFiles()

    // Sync bfds with storage. Two scenarios supported:

    const bfdsRanges = this.heightRangesFromBulkFiles(this.bfds)
    const sfsRanges = this.heightRangesFromBulkFiles(sfs)

    if (sfsRanges.cdn.length >= bfdsRanges.cdn.length) {
      // Storage win if it has greater or equal CDN coverage
      // Replace all bfds with sfs
      this.bfds = []
      for (const file of sfs) {
        const vbf: BulkFileData = await this.validateFileInfo(file)
        this.bfds.push(vbf)
      }
    } else {
      // Bfds win if they have greater CDN coverage
      // Replace all sfs with bfds
      const reversedFiles = [...sfs]
      reversedFiles.reverse()
      for (const s of reversedFiles) await this.storage.deleteBulkFile(s.fileId!)
      for (const bfd of this.bfds) {
        await this.ensureData(bfd)
        bfd.fileId = await this.storage.insertBulkFile(bfdToInfo(bfd, true))
      }
    }
  }

  heightRangesFromBulkFiles (files: BulkHeaderFileInfo[]): {
    all: HeightRange
    cdn: HeightRange
    incremental: HeightRange
  } {
    const ranges = { all: new HeightRange(0, -1), cdn: new HeightRange(0, -1), incremental: new HeightRange(0, -1) }
    for (const file of files) {
      const range = new HeightRange(file.firstHeight, file.firstHeight + file.count - 1)
      ranges.all = ranges.all.union(range)
      if (isBdfCdn(file)) ranges.cdn = ranges.cdn.union(range)
      if (isBdfIncremental(file)) ranges.incremental = ranges.incremental.union(range)
    }
    return ranges
  }

  async createReader (range?: HeightRange, maxBufferSize?: number): Promise<BulkFileDataReader> {
    range = range || (await this.getHeightRange())
    maxBufferSize = maxBufferSize || 1000000 * 80 // 100,000 headers, 8MB
    return new BulkFileDataReader(this, range, maxBufferSize)
  }

  async updateFromUrl (cdnUrl: string): Promise<void> {
    if (this.fetch == null) throw new WERR_INVALID_OPERATION('fetch is not defined in the BulkFileDataManager.')

    const toUrl = (file: string) => this.fetch!.pathJoin(cdnUrl, file)
    const url = toUrl(`${this.chain}NetBlockHeaders.json`)

    const availableBulkFiles = await this.fetch.fetchJson<BulkHeaderFilesInfo>(url)
    if (!availableBulkFiles) { throw new WERR_INVALID_PARAMETER('cdnUrl', `a valid BulkHeaderFilesInfo JSON resource available from ${url}`) }

    const selectedFiles = selectBulkHeaderFiles(
      availableBulkFiles.files,
      this.chain,
      this.maxPerFile || availableBulkFiles.headersPerFile
    )
    for (const bf of selectedFiles) {
      if (!bf.fileHash) {
        throw new WERR_INVALID_PARAMETER('fileHash', `valid for all files in json downloaded from ${url}`)
      }
      if (!bf.chain || bf.chain !== this.chain) {
        throw new WERR_INVALID_PARAMETER('chain', `"${this.chain}" for all files in json downloaded from ${url}`)
      }
      if (!bf.sourceUrl || bf.sourceUrl !== cdnUrl) bf.sourceUrl = cdnUrl
    }

    const rangeBefore = await this.getHeightRange()
    await this.merge(selectedFiles)
    const rangeAfter = await this.getHeightRange()

    let log = 'BulkDataFileManager.updateFromUrl\n'
    log += `  url: ${url}\n`
    log += `  bulk range before: ${rangeBefore}\n`
    log += `  bulk range after:  ${rangeAfter}\n`
    this.log(log)
  }

  async merge (files: BulkHeaderFileInfo[]): Promise<BulkFileDataManagerMergeResult> {
    return await this.lock.withWriteLock(async () => await this.mergeNoLock(files))
  }

  private async mergeNoLock (files: BulkHeaderFileInfo[]): Promise<BulkFileDataManagerMergeResult> {
    const r: BulkFileDataManagerMergeResult = { inserted: [], updated: [], unchanged: [], dropped: [] }
    for (const file of files) {
      const hbf = this.getBfdForHeight(file.firstHeight)
      if ((hbf != null) && file.fileId) hbf.fileId = file.fileId // Always update fileId if provided
      const lbf = this.getLastBfd()
      if (
        hbf?.fileHash === file.fileHash &&
        hbf.count === file.count &&
        hbf.lastHash === file.lastHash &&
        hbf.lastChainWork === file.lastChainWork
      ) {
        // We already have an identical matching file...
        r.unchanged.push(bfdToInfo(hbf))
        continue
      }
      const vbf: BulkFileData = await this.validateFileInfo(file)
      if (hbf != null) {
        // We have a matching file by firstHeight but count and fileHash differ
        await this.update(vbf, hbf, r)
      } else if (isBdfIncremental(vbf) && (lbf != null) && isBdfIncremental(lbf)) {
        await this.mergeIncremental(lbf, vbf, r)
      } else {
        const added = await this.add(vbf)
        r.inserted.push(added)
      }
    }
    this.log(`BulkFileDataManager.merge:\n${this.toLogString(r)}\n`)
    return r
  }

  private async mergeIncremental (lbf: BulkFileData, vbf: BulkFileData, r: BulkFileDataManagerMergeResult) {
    lbf.count += vbf.count
    lbf.lastHash = vbf.lastHash
    lbf.lastChainWork = vbf.lastChainWork
    await this.ensureData(lbf)
    const newData = new Uint8Array(lbf.data!.length + vbf.data!.length)
    newData.set(lbf.data!)
    newData.set(vbf.data!, lbf.data!.length)
    lbf.data = newData
    delete this.fileHashToIndex[lbf.fileHash]
    lbf.fileHash = asString(Hash.sha256(asArray(newData)), 'base64')
    this.fileHashToIndex[lbf.fileHash] = this.bfds.length - 1
    lbf.mru = Date.now()
    const lbfInfo = bfdToInfo(lbf, true)
    r.updated.push(lbfInfo)
    if ((this.storage != null) && lbf.fileId) {
      await this.storage.updateBulkFile(lbf.fileId, lbfInfo)
    }
  }

  toLogString (what?: BulkFileDataManagerMergeResult | BulkFileData[] | BulkHeaderFileInfo[]): string {
    let log = ''
    if (what == null) {
      log += this.toLogString(this.bfds)
    } else if (what['updated']) {
      what = what as BulkFileDataManagerMergeResult
      for (const { category, bfds } of [
        { category: 'unchanged', bfds: what.unchanged },
        { category: 'dropped', bfds: what.dropped },
        { category: 'updated', bfds: what.updated },
        { category: 'inserted', bfds: what.inserted }
      ]) {
        if (bfds.length > 0) {
          log += `  ${category}:\n`
          log += this.toLogString(bfds)
        }
      }
    } else if (Array.isArray(what)) {
      what = what as BulkHeaderFileInfo[]
      let i = -1
      for (const bfd of what) {
        i++
        log += `  ${i}: ${bfd.fileName} fileId=${bfd.fileId} ${bfd.firstHeight}-${bfd.firstHeight + bfd.count - 1}\n`
      }
    }

    return log
  }

  async mergeIncrementalBlockHeaders (newBulkHeaders: BlockHeader[], incrementalChainWork?: string): Promise<void> {
    if (newBulkHeaders.length === 0) return
    return await this.lock.withWriteLock(async () => {
      const lbf = this.getLastFileNoLock()
      const nextHeight = lbf ? lbf.firstHeight + lbf.count : 0

      // Trim headers that already exist in bulk storage, adjusting chain work accordingly.
      ;({ headers: newBulkHeaders, incrementalChainWork } = trimAlreadyStoredHeaders(newBulkHeaders, nextHeight, incrementalChainWork))

      if (newBulkHeaders.length === 0) return
      if ((lbf == null) || nextHeight !== newBulkHeaders[0].height) { throw new WERR_INVALID_PARAMETER('newBulkHeaders', 'an extension of existing bulk headers') }
      if (!lbf.lastHash) throw new WERR_INTERNAL(`lastHash is not defined for the last bulk file ${lbf.fileName}`)

      const lastChainWork = incrementalChainWork
        ? addWork(incrementalChainWork, lbf.lastChainWork)
        : computeChainWorkFromHeaders(newBulkHeaders, lbf)

      const data = serializeBaseBlockHeaders(newBulkHeaders)
      const fileHash = asString(Hash.sha256(asArray(data)), 'base64')
      const bf: BulkHeaderFileInfo = {
        fileId: undefined,
        chain: this.chain,
        sourceUrl: undefined,
        fileName: 'incremental',
        firstHeight: newBulkHeaders[0].height,
        count: newBulkHeaders.length,
        prevChainWork: lbf.lastChainWork,
        lastChainWork,
        prevHash: lbf.lastHash,
        lastHash: newBulkHeaders.at(-1)!.hash,
        fileHash,
        data
      }
      await this.mergeNoLock([bf])
    })
  }

  async getBulkFiles (keepData?: boolean): Promise<BulkHeaderFileInfo[]> {
    return await this.lock.withReadLock(async () => {
      return this.bfds.map(bfd => bfdToInfo(bfd, keepData))
    })
  }

  async getHeightRange (): Promise<HeightRange> {
    return await this.lock.withReadLock(async () => {
      if (this.bfds.length === 0) return HeightRange.empty
      const first = this.bfds[0]
      const last = this.bfds.at(-1)!
      return new HeightRange(first.firstHeight, last.firstHeight + last.count - 1)
    })
  }

  async getDataFromFile (file: BulkHeaderFileInfo, offset?: number, length?: number): Promise<Uint8Array | undefined> {
    const bfd = this.getBfdForHeight(file.firstHeight)
    if ((bfd == null) || bfd.count < file.count) {
      throw new WERR_INVALID_PARAMETER(
        'file',
        `a match for ${file.firstHeight}, ${file.count} in the BulkFileDataManager.`
      )
    }
    return await this.lock.withReadLock(async () => await this.getDataFromFileNoLock(bfd, offset, length))
  }

  private async getDataFromFileNoLock (
    bfd: BulkFileData,
    offset?: number,
    length?: number
  ): Promise<Uint8Array | undefined> {
    const fileLength = bfd.count * 80
    offset = offset || 0
    if (offset > fileLength - 1) return undefined
    length = length || bfd.count * 80 - offset
    length = Math.min(length, fileLength - offset)
    let data: Uint8Array | undefined
    if (bfd.data != null) {
      data = bfd.data.slice(offset, offset + length)
    } else if (bfd.fileId && (this.storage != null)) {
      data = await this.storage.getBulkFileData(bfd.fileId, offset, length)
    }
    if (data == null) {
      await this.ensureData(bfd)
      if (bfd.data != null) data = bfd.data.slice(offset, offset + length)
    }
    if (data == null) return undefined
    return data
  }

  async findHeaderForHeightOrUndefined (height: number): Promise<BlockHeader | undefined> {
    return await this.lock.withReadLock(async () => {
      if (!Number.isInteger(height) || height < 0) { throw new WERR_INVALID_PARAMETER('height', `a non-negative integer (${height}).`) }
      const file = this.bfds.find(f => f.firstHeight <= height && f.firstHeight + f.count > height)
      if (file == null) return undefined
      const offset = (height - file.firstHeight) * 80
      const data = await this.getDataFromFileNoLock(file, offset, 80)
      if (data == null) return undefined
      const header = deserializeBlockHeader(data, height, 0)
      return header
    })
  }

  async getFileForHeight (height: number): Promise<BulkHeaderFileInfo | undefined> {
    return await this.lock.withReadLock(async () => {
      const bfd = this.getBfdForHeight(height)
      if (bfd == null) return undefined
      return bfdToInfo(bfd)
    })
  }

  private getBfdForHeight (height: number): BulkFileData | undefined {
    if (!Number.isInteger(height) || height < 0) { throw new WERR_INVALID_PARAMETER('height', `a non-negative integer (${height}).`) }
    const file = this.bfds.find(f => f.firstHeight <= height && f.firstHeight + f.count > height)
    return file
  }

  private getLastBfd (fromEnd = 1): BulkFileData | undefined {
    if (this.bfds.length < fromEnd) return undefined
    const bfd = this.bfds[this.bfds.length - fromEnd]
    return bfd
  }

  async getLastFile (fromEnd = 1): Promise<BulkHeaderFileInfo | undefined> {
    return await this.lock.withReadLock(async () => this.getLastFileNoLock(fromEnd))
  }

  private getLastFileNoLock (fromEnd = 1): BulkHeaderFileInfo | undefined {
    const bfd = this.getLastBfd(fromEnd)
    if (bfd == null) return undefined
    return bfdToInfo(bfd)
  }

  private async getDataByFileHash (fileHash: string): Promise<Uint8Array | undefined> {
    const index = this.fileHashToIndex[fileHash]
    if (index === undefined) { throw new WERR_INVALID_PARAMETER('fileHash', `known to the BulkFileDataManager. ${fileHash} is unknown.`) }
    const bfd = this.bfds[index]
    const data = await this.ensureData(bfd)
    return data
  }

  private async getDataByFileId (fileId: number): Promise<Uint8Array | undefined> {
    const bfd = this.bfds.find(f => f.fileId === fileId)
    if (bfd === undefined) { throw new WERR_INVALID_PARAMETER('fileId', `known to the BulkFileDataManager. ${fileId} is unknown.`) }
    const data = await this.ensureData(bfd)
    return data
  }

  private async validateFileInfo (file: BulkHeaderFileInfo): Promise<BulkFileData> {
    if (file.chain !== this.chain) throw new WERR_INVALID_PARAMETER('chain', `${this.chain}`)
    if (file.count <= 0) { throw new WERR_INVALID_PARAMETER('bf.count', `expected count to be greater than 0, but got ${file.count}`) }
    if (file.count > this.maxPerFile && file.fileName !== 'incremental') { throw new WERR_INVALID_PARAMETER('count', `less than or equal to maxPerFile ${this.maxPerFile}`) }
    if (!file.fileHash) throw new WERR_INVALID_PARAMETER('fileHash', 'defined')
    if (!file.sourceUrl && !file.fileId && (file.data == null)) { throw new WERR_INVALID_PARAMETER('data', 'defined when sourceUrl and fileId are undefined') }

    const bfd: BulkFileData = { ...file, fileHash: file.fileHash, mru: Date.now() }

    if (!bfd.validated) {
      await this.validateBfdData(bfd, file.fileHash)
      bfd.validated = true
    }

    return bfd
  }

  private async validateBfdData (bfd: BulkFileData, expectedFileHash: string): Promise<void> {
    await this.ensureData(bfd)

    if ((bfd.data == null) || bfd.data.length !== bfd.count * 80) {
      throw new WERR_INVALID_PARAMETER(
        'file.data',
        `bulk file ${bfd.fileName} data length ${bfd.data?.length} does not match expected count ${bfd.count}`
      )
    }

    bfd.fileHash = asString(Hash.sha256(asArray(bfd.data)), 'base64')
    if (expectedFileHash && expectedFileHash !== bfd.fileHash) {
      throw new WERR_INVALID_PARAMETER('file.fileHash', `expected ${expectedFileHash} but got ${bfd.fileHash}`)
    }

    if (!isKnownValidBulkHeaderFile(bfd)) {
      this.validateBfdHeaders(bfd)
    }
  }

  private validateBfdHeaders (bfd: BulkFileData): void {
    const pbf = bfd.firstHeight > 0 ? this.getBfdForHeight(bfd.firstHeight - 1) : undefined
    const prevHash = pbf?.lastHash ?? '00'.repeat(32)
    const prevChainWork = pbf?.lastChainWork ?? '00'.repeat(32)

    const { lastHeaderHash, lastChainWork } = validateBufferOfHeaders(bfd.data!, prevHash, 0, undefined, prevChainWork)

    if (bfd.lastHash && bfd.lastHash !== lastHeaderHash) {
      throw new WERR_INVALID_PARAMETER('file.lastHash', `expected ${bfd.lastHash} but got ${lastHeaderHash}`)
    }
    if (bfd.lastChainWork && bfd.lastChainWork !== lastChainWork) {
      throw new WERR_INVALID_PARAMETER('file.lastChainWork', `expected ${bfd.lastChainWork} but got ${lastChainWork}`)
    }

    bfd.lastHash = lastHeaderHash
    bfd.lastChainWork = lastChainWork!

    if (bfd.firstHeight === 0) validateGenesisHeader(bfd.data!, bfd.chain!)
  }

  async ReValidate (): Promise<void> {
    return await this.lock.withReadLock(async () => await this.ReValidateNoLock())
  }

  private async ReValidateNoLock (): Promise<void> {
    for (const file of this.bfds) {
      await this.ensureData(file)
      file.validated = false // Reset validation to re-validate on next access
      const bfd = await this.validateFileInfo(file)
      if (!bfd.validated) throw new WERR_INTERNAL(`BulkFileDataManager.ReValidate failed for file ${bfd.fileName}`)
      file.validated = true
    }
  }

  private validateBfdForAdd (bfd: BulkFileData): void {
    if (this.bfds.length === 0 && bfd.firstHeight !== 0) { throw new WERR_INVALID_PARAMETER('firstHeight', '0 for the first file') }
    if (this.bfds.length > 0) {
      const last = this.bfds.at(-1)!
      if (bfd.firstHeight !== last.firstHeight + last.count) { throw new WERR_INVALID_PARAMETER('firstHeight', 'the last file\'s firstHeight + count') }
      if (bfd.prevHash !== last.lastHash || bfd.prevChainWork !== last.lastChainWork) { throw new WERR_INVALID_PARAMETER('prevHash/prevChainWork', 'the last file\'s lastHash/lastChainWork') }
    }
  }

  private async add (bfd: BulkFileData): Promise<BulkHeaderFileInfo> {
    this.validateBfdForAdd(bfd)
    const index = this.bfds.length
    this.bfds.push(bfd)
    this.fileHashToIndex[bfd.fileHash] = index
    this.ensureMaxRetained()
    const info = bfdToInfo(bfd, true)
    if (this.storage != null) {
      info.fileId = bfd.fileId = await this.storage.insertBulkFile(info)
    }
    return info
  }

  private replaceBfdAtIndex (index: number, update: BulkFileData): void {
    const oldBfd = this.bfds[index]
    delete this.fileHashToIndex[oldBfd.fileHash]
    this.bfds[index] = update
    this.fileHashToIndex[update.fileHash] = index
  }

  /**
   * Updating an existing file occurs in two specific contexts:
   *
   * 1. CDN Update: CDN files of a specific `maxPerFile` series typically ends in a partial file
   * which may periodically add more headers until the next file is started.
   * If the CDN update is the second to last file (followed by an incremental file),
   * then the incremental file is updated or deleted and also returned as the result (with a count of zero if deleted).
   *
   * 2. Incremental Update: The last bulk file is almost always an "incremental" file
   * which is not limited by "maxPerFile" and holds all non-CDN bulk headers.
   * If is updated with new bulk headers which come either from non CDN ingestors or from live header migration to bulk.
   *
   * Updating preserves the following properties:
   *
   * - Any existing headers following this update are preserved and must form an unbroken chain.
   * - There can be at most one incremental file and it must be the last file.
   * - The update start conditions (height, prevHash, prevChainWork) must match an existing file which may be either CDN or internal.
   * - The update fileId must match, it may be undefind.
   * - The fileName does not need to match.
   * - The incremental file must always have fileName "incremental" and sourceUrl must be undefined.
   * - The update count must be greater than 0.
   * - The update count must be greater than current count for CDN to CDN update.
   *
   * @param update new validated BulkFileData to update.
   * @param hbf corresponding existing BulkFileData to update.
   */
  private async update (update: BulkFileData, hbf: BulkFileData, r: BulkFileDataManagerMergeResult): Promise<void> {
    if (
      hbf?.firstHeight !== update.firstHeight ||
      hbf?.prevChainWork !== update.prevChainWork ||
      hbf?.prevHash !== update.prevHash
    ) { throw new WERR_INVALID_PARAMETER('file', 'an existing file by height, prevChainWork and prevHash') }
    if (isBdfCdn(update) === isBdfCdn(hbf) && update.count <= hbf.count) { throw new WERR_INVALID_PARAMETER('file.count', `greater than the current count ${hbf.count}`) }

    const { index, truncate, replaced, drop } = await this.resolveUpdatePlan(update, hbf)

    this.replaceBfdAtIndex(index, update)
    if (truncate != null) await this.shiftWork(update, truncate, replaced)
    if (drop != null) this.dropLastBulkFile(drop)

    await this.persistUpdate(update, truncate, replaced, drop)
    this.recordUpdateResults(r, update, truncate, replaced, drop)
    this.ensureMaxRetained()
  }

  private async resolveUpdatePlan (
    update: BulkFileData,
    hbf: BulkFileData
  ): Promise<{ index: number, truncate?: BulkFileData, replaced?: BulkFileData, drop?: BulkFileData }> {
    const lbf = this.getLastBfd()!
    let index = this.bfds.length - 1
    let truncate: BulkFileData | undefined
    let replaced: BulkFileData | undefined
    let drop: BulkFileData | undefined

    if (hbf.firstHeight === lbf.firstHeight) {
      // Update targets the last file — three cases:
      if (isBdfIncremental(update)) {
        // 1. Incremental → incremental extension.
        if (!isBdfIncremental(lbf)) throw new WERR_INVALID_PARAMETER('file', 'an incremental file to update an existing incremental file')
      } else if (isBdfCdn(lbf)) {
        // 2. CDN → CDN replacement (must grow).
        if (update.count <= lbf.count) throw new WERR_INVALID_PARAMETER('update.count', `CDN update must have more headers. ${update.count} <= ${lbf.count}`)
      } else if (update.count < lbf.count) {
        // 3. New CDN partially replaces incremental tail — retain excess incremental headers.
        await this.ensureData(lbf)
        truncate = lbf
      }
    } else {
      // Update targets the second-to-last file — must be CDN replacing CDN, last must be incremental.
      const lbf2 = this.getLastBfd(2)
      if ((lbf2 == null) || hbf.firstHeight !== lbf2.firstHeight) throw new WERR_INVALID_PARAMETER('file', 'an update to last or second to last file')
      if (!isBdfCdn(update) || !isBdfCdn(lbf2) || update.count <= lbf2.count) throw new WERR_INVALID_PARAMETER('file', 'a CDN file update with more headers than the current CDN file')
      if (!isBdfIncremental(lbf)) throw new WERR_INVALID_PARAMETER('file', 'a CDN file update followed by an incremental file')
      if (!update.fileId) update.fileId = lbf2.fileId
      if (update.count >= lbf2.count + lbf.count) {
        drop = lbf
      } else {
        await this.ensureData(lbf)
        truncate = lbf
        replaced = lbf2
      }
      index = index - 1
    }
    return { index, truncate, replaced, drop }
  }

  private async persistUpdate (
    update: BulkFileData,
    truncate: BulkFileData | undefined,
    replaced: BulkFileData | undefined,
    drop: BulkFileData | undefined
  ): Promise<void> {
    if (this.storage == null) return
    if (update.fileId) await this.storage.updateBulkFile(update.fileId, bfdToInfo(update, true))
    if ((truncate != null)) {
      const truncateInfo = bfdToInfo(truncate, true)
      if (replaced != null) {
        await this.storage.updateBulkFile(truncate.fileId!, truncateInfo)
      } else {
        truncateInfo.fileId = undefined
        truncate.fileId = await this.storage.insertBulkFile(truncateInfo)
      }
    }
    if (drop?.fileId) await this.storage.deleteBulkFile(drop.fileId)
  }

  private recordUpdateResults (
    r: BulkFileDataManagerMergeResult,
    update: BulkFileData,
    truncate: BulkFileData | undefined,
    replaced: BulkFileData | undefined,
    drop: BulkFileData | undefined
  ): void {
    if (!r) return
    r.updated.push(bfdToInfo(update, true))
    if (truncate != null) {
      const truncateInfo = bfdToInfo(truncate, true)
      if (replaced != null) r.updated.push(truncateInfo)
      else r.inserted.push(truncateInfo)
    }
    if (drop != null) r.dropped.push(bfdToInfo(drop))
  }

  private dropLastBulkFile (lbf: BulkFileData): void {
    delete this.fileHashToIndex[lbf.fileHash]
    const index = this.bfds.indexOf(lbf)
    if (index === this.bfds.length - 1) {
      this.bfds.pop()
    } else {
      throw new WERR_INTERNAL('dropLastBulkFile requires lbf is the current last file.')
    }
  }

  /**
   * Remove work (and headers) from `truncate` that now exists in `update`.
   * There are two scenarios:
   * 1. `replaced` is undefined: update is a CDN file that splits an incremental file that must be truncated.
   * 2. `replaced` is valid: update is a CDN update that replaced an existing CDN file and splits an incremental file that must be truncated.
   * @param update the new CDN update file.
   * @param truncate the incremental file to be truncated (losing work which now exists in `update`).
   * @param replaced the existing CDN file that was replaced by `update` (if any).
   */
  private async shiftWork (update: BulkFileData, truncate: BulkFileData, replaced?: BulkFileData): Promise<void> {
    const updateIndex = this.fileHashToIndex[update.fileHash]
    // replaced will be valid if the update replaced it and it must become the new last file.
    // truncateIndex will be updateIndex + 1 if the existing last file is being truncated and update is second to last.
    const truncateIndex = this.fileHashToIndex[truncate.fileHash]
    if (truncateIndex != null && truncateIndex !== updateIndex + 1) { throw new WERR_INTERNAL('shiftWork requires update to have replaced truncate or truncate to follow update') }
    if (truncateIndex != null && replaced == null) { throw new WERR_INTERNAL('shiftWork requires valid replaced when update hasn\'t replaced truncate') }

    truncate.prevHash = update.lastHash!
    truncate.prevChainWork = update.lastChainWork
    // truncate.lastChainWork, truncate.lastHash remain unchanged
    let count = update.count
    if (replaced == null) {
      // The truncated file is itself being replaced by the update and must be inserted as a new file.
      truncate.fileId = undefined
      this.bfds.push(truncate) // Add the truncated file as a new entry.
    } else {
      count -= replaced.count
    }
    truncate.count -= count
    truncate.firstHeight += count

    truncate.data = truncate.data?.slice(count * 80)
    delete this.fileHashToIndex[truncate.fileHash]
    truncate.fileHash = asString(Hash.sha256(asArray(truncate.data!)), 'base64')
    this.fileHashToIndex[truncate.fileHash] = updateIndex + 1
  }

  /**
   *
   * @param bfd
   * @returns
   */
  private async ensureData (bfd: BulkFileData): Promise<Uint8Array> {
    if (bfd.data != null) return bfd.data

    if ((this.storage != null) && bfd.fileId) {
      bfd.data = await this.storage.getBulkFileData(bfd.fileId)
      if (bfd.data == null) throw new WERR_INVALID_PARAMETER('fileId', `valid, data not found for fileId ${bfd.fileId}`)
    }

    if ((bfd.data == null) && (this.fetch != null) && bfd.sourceUrl) {
      const url = this.fetch.pathJoin(bfd.sourceUrl, bfd.fileName)

      try {
        bfd.data = await this.fetch.download(url)
      } catch (firstAttemptErr) {
        // First download attempt failed (e.g. transient network error); retry once.
        console.debug(`BulkFileDataManager: first download attempt failed for ${url}, retrying`, firstAttemptErr)
        bfd.data = await this.fetch.download(url)
      }
      if (bfd.data == null) throw new WERR_INVALID_PARAMETER('sourceUrl', `data not found for sourceUrl ${url}`)
    }

    if (bfd.data == null) throw new WERR_INVALID_PARAMETER('data', `defined. Unable to retrieve data for ${bfd.fileName}`)

    bfd.mru = Date.now()

    // Validate retrieved data.
    const fileHash = asString(Hash.sha256(asArray(bfd.data)), 'base64')
    if (fileHash !== bfd.fileHash) { throw new WERR_INVALID_PARAMETER('fileHash', `a match for retrieved data for ${bfd.fileName}`) }

    this.ensureMaxRetained()
    return bfd.data
  }

  private ensureMaxRetained (): void {
    if (this.maxRetained === undefined) return
    const withData = this.bfds.filter(bfd => (bfd.data != null) && (bfd.fileId || bfd.sourceUrl))
    let countToRelease = withData.length - this.maxRetained
    if (countToRelease <= 0) return
    const sorted = [...withData]
    sorted.sort((a, b) => a.mru - b.mru)
    while (countToRelease-- > 0 && sorted.length > 0) {
      const oldest = sorted.shift()!
      // Release the least recently used data
      oldest.data = undefined // Release the data
    }
  }

  async exportHeadersToFs (
    toFs: ChaintracksFsApi,
    toHeadersPerFile: number,
    toFolder: string,
    sourceUrl?: string,
    maxHeight?: number
  ): Promise<void> {
    const chain = this.chain
    const toFileName = (i: number) => `${chain}Net_${i}.headers`
    const toPath = (i: number) => toFs.pathJoin(toFolder, toFileName(i))
    const toJsonPath = () => toFs.pathJoin(toFolder, `${chain}NetBlockHeaders.json`)

    const toBulkFiles: BulkHeaderFilesInfo = {
      rootFolder: sourceUrl || toFolder,
      jsonFilename: `${chain}NetBlockHeaders.json`,
      headersPerFile: toHeadersPerFile,
      files: []
    }

    let range = await this.getHeightRange()
    if (maxHeight) range = range.intersect(new HeightRange(0, maxHeight))
    const reader = await this.createReader(range, toHeadersPerFile * 80)

    let firstHeight = 0
    let lastHeaderHash = '00'.repeat(32)
    let lastChainWork = '00'.repeat(32)

    let i = -1
    for (;;) {
      i++
      const data = await reader.read()
      if ((data == null) || data.length === 0) {
        break
      }

      const last = validateBufferOfHeaders(data, lastHeaderHash, 0, undefined, lastChainWork)

      await toFs.writeFile(toPath(i), data)

      const fileHash = asString(Hash.sha256(asArray(data)), 'base64')
      const file: BulkHeaderFileInfo = {
        chain,
        count: data.length / 80,
        fileHash,
        fileName: toFileName(i),
        firstHeight,
        lastChainWork: last.lastChainWork!,
        lastHash: last.lastHeaderHash,
        prevChainWork: lastChainWork,
        prevHash: lastHeaderHash,
        sourceUrl
      }
      toBulkFiles.files.push(file)
      firstHeight += file.count
      lastHeaderHash = file.lastHash!
      lastChainWork = file.lastChainWork!
    }

    await toFs.writeFile(toJsonPath(), asUint8Array(JSON.stringify(toBulkFiles), 'utf8'))
  }
}

interface BulkFileData extends BulkHeaderFileInfo {
  mru: number
  fileHash: string
}

export function selectBulkHeaderFiles (
  files: BulkHeaderFileInfo[],
  chain: Chain,
  maxPerFile: number
): BulkHeaderFileInfo[] {
  const r: BulkHeaderFileInfo[] = []
  let height = 0
  for (;;) {
    const choices = files.filter(f => f.firstHeight === height && f.count <= maxPerFile && f.chain === chain)
    // Pick the file with the maximum count
    const choice = choices.reduce((a, b) => (a.count > b.count ? a : b), choices[0])
    if (!choice) break // no more files to select
    r.push(choice)
    height += choice.count
  }
  return r
}

function isBdfIncremental (bfd: BulkFileData | BulkHeaderFileInfo): boolean {
  return bfd.fileName === 'incremental' && !bfd.sourceUrl
}

function isBdfCdn (bfd: BulkFileData | BulkHeaderFileInfo): boolean {
  return !isBdfIncremental(bfd)
}

function bfdToInfo (bfd: BulkFileData, keepData?: boolean): BulkHeaderFileInfo {
  return {
    chain: bfd.chain,
    fileHash: bfd.fileHash,
    fileName: bfd.fileName,
    sourceUrl: bfd.sourceUrl,
    fileId: bfd.fileId,
    count: bfd.count,
    prevChainWork: bfd.prevChainWork,
    lastChainWork: bfd.lastChainWork,
    firstHeight: bfd.firstHeight,
    prevHash: bfd.prevHash,
    lastHash: bfd.lastHash,
    validated: bfd.validated || false,
    data: keepData ? bfd.data : undefined
  }
}

export interface BulkFileDataManagerMergeResult {
  unchanged: BulkHeaderFileInfo[]
  inserted: BulkHeaderFileInfo[]
  updated: BulkHeaderFileInfo[]
  dropped: BulkHeaderFileInfo[]
}

/**
 * Drops any headers whose height is already covered by bulk storage,
 * reducing `incrementalChainWork` accordingly (when provided).
 */
function trimAlreadyStoredHeaders (
  headers: BlockHeader[],
  nextHeight: number,
  incrementalChainWork: string | undefined
): { headers: BlockHeader[], incrementalChainWork: string | undefined } {
  if (nextHeight <= 0 || headers.length === 0 || headers[0].height >= nextHeight) {
    return { headers, incrementalChainWork }
  }
  // Avoid mutating the caller's array.
  headers = [...headers]
  while (headers.length > 0 && headers[0].height < nextHeight) {
    const h = headers.shift()
    if ((h != null) && incrementalChainWork) {
      incrementalChainWork = subWork(incrementalChainWork, convertBitsToWork(h.bits))
    }
  }
  return { headers, incrementalChainWork }
}

/**
 * Computes `lastChainWork` for a sequence of new bulk headers extending `lbf`,
 * validating that the sequence is contiguous.
 */
function computeChainWorkFromHeaders (headers: BlockHeader[], lbf: BulkHeaderFileInfo): string {
  let lastHeight = lbf.firstHeight + lbf.count - 1
  let lastHash = lbf.lastHash!
  let lastChainWork = lbf.lastChainWork
  for (const h of headers) {
    if (h.height !== lastHeight + 1 || h.previousHash !== lastHash) {
      throw new WERR_INVALID_PARAMETER(
        'headers',
        `an extension of existing bulk headers, header with height ${h.height} is non-sequential`
      )
    }
    lastChainWork = addWork(lastChainWork, convertBitsToWork(h.bits))
    lastHeight = h.height
    lastHash = h.hash
  }
  return lastChainWork
}

// Re-export BulkFileDataReader for backward compatibility
export { BulkFileDataReader } from './BulkFileDataReader'
