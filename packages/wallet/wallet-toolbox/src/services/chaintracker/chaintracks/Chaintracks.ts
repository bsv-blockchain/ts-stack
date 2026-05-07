import { ChaintracksStorageApi, InsertHeaderResult } from './Api/ChaintracksStorageApi'
import { BulkIngestorApi } from './Api/BulkIngestorApi'
import { LiveIngestorApi } from './Api/LiveIngestorApi'

import { validateAgainstDirtyHashes } from './util/dirtyHashes'

import { ChaintracksOptions, ChaintracksManagementApi } from './Api/ChaintracksApi'
import { blockHash, validateHeaderFormat } from './util/blockHeaderUtilities'
import { Chain } from '../../../sdk/types'
import { ChaintracksInfoApi, HeaderListener, ReorgListener } from './Api/ChaintracksClientApi'
import { BaseBlockHeader, BlockHeader, LiveBlockHeader } from './Api/BlockHeaderApi'
import { asString } from '../../../utility/utilityHelpers.noBuffer'
import { HeightRange, HeightRanges } from './util/HeightRange'
import { SingleWriterMultiReaderLock } from './util/SingleWriterMultiReaderLock'
import { ChaintracksFsApi } from './Api/ChaintracksFsApi'
import { randomBytesBase64, wait } from '../../../utility/utilityHelpers'
import { WalletError } from '../../../sdk/WalletError'
export class Chaintracks implements ChaintracksManagementApi {
  static createOptions (chain: Chain): ChaintracksOptions {
    return {
      chain,
      storage: undefined,
      bulkIngestors: [],
      liveIngestors: [],
      addLiveRecursionLimit: 36,
      logging: (...args) => console.log(new Date().toISOString(), ...args),
      readonly: false
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  log: (...args: any[]) => void = () => {}

  readonly chain: Chain
  readonly readonly: boolean

  // Collection of all long running "threads": main thread (liveHeaders consumer / monitor) and each live header ingestor.
  private readonly promises: Array<Promise<void>> = []

  private readonly callbacks: { header: Record<string, HeaderListener | null>, reorg: Record<string, ReorgListener | null> } = { header: {}, reorg: {} }
  private readonly storage: ChaintracksStorageApi
  private readonly bulkIngestors: BulkIngestorApi[]
  private readonly liveIngestors: LiveIngestorApi[]

  private readonly baseHeaders: BaseBlockHeader[] = []
  private readonly liveHeaders: BlockHeader[] = []
  private readonly addLiveRecursionLimit: number = 11

  private available = false
  private startupError: WalletError | null = null

  private subscriberCallbacksEnabled = false
  private stopMainThread = true

  private lastPresentHeight = 0
  private lastPresentHeightMsecs = 0
  private readonly lastPresentHeightMaxAge = 60 * 1000 // 1 minute, in milliseconds

  private readonly lock = new SingleWriterMultiReaderLock()

  constructor (public options: ChaintracksOptions) {
    if (options.storage == null) throw new Error('storage is required.')
    if (!options.bulkIngestors || options.bulkIngestors.length < 1) { throw new Error('At least one bulk ingestor is required.') }
    if (!options.liveIngestors || options.liveIngestors.length < 1) { throw new Error('At least one live ingestor is required.') }
    this.chain = options.chain
    this.readonly = options.readonly
    this.storage = options.storage
    this.bulkIngestors = options.bulkIngestors
    this.liveIngestors = options.liveIngestors

    this.addLiveRecursionLimit = options.addLiveRecursionLimit

    if (options.logging != null) this.log = options.logging
    this.storage.log = this.log

    this.log(`New ChaintracksBase Instance Constructed ${options.chain}Net`)
  }

  async getChain (): Promise<Chain> {
    return this.chain
  }

  /**
   * Caches and returns most recently sourced value if less than one minute old.
   * @returns the current externally available chain height (via bulk ingestors).
   */
  async getPresentHeight (): Promise<number> {
    const now = Date.now()
    if (this.lastPresentHeight && now - this.lastPresentHeightMsecs < this.lastPresentHeightMaxAge) {
      return this.lastPresentHeight
    }
    const presentHeights: number[] = []
    for (const bulk of this.bulkIngestors) {
      try {
        const presentHeight = await bulk.getPresentHeight()
        if (presentHeight) presentHeights.push(presentHeight)
      } catch (uerr: unknown) {
        console.error(uerr)
      }
    }
    const presentHeight = (presentHeights.length > 0) ? Math.max(...presentHeights) : undefined
    if (!presentHeight) throw new Error('At least one bulk ingestor must implement getPresentHeight.')
    this.lastPresentHeight = presentHeight
    this.lastPresentHeightMsecs = now
    return presentHeight
  }

  async currentHeight (): Promise<number> {
    return await this.getPresentHeight()
  }

  async subscribeHeaders (listener: HeaderListener): Promise<string> {
    const ID = randomBytesBase64(8)
    this.callbacks.header[ID] = listener
    return ID
  }

  async subscribeReorgs (listener: ReorgListener): Promise<string> {
    const ID = randomBytesBase64(8)
    this.callbacks.reorg[ID] = listener
    return ID
  }

  async unsubscribe (subscriptionId: string): Promise<boolean> {
    let success = true
    if (this.callbacks.header[subscriptionId]) this.callbacks.header[subscriptionId] = null
    else if (this.callbacks.reorg[subscriptionId]) this.callbacks.reorg[subscriptionId] = null
    else success = false
    return success
  }

  /**
   * Queues a potentially new, unknown header for consideration as an addition to the chain.
   * When the header is considered, if the prior header is unknown, recursive calls to the
   * bulk ingestors will be attempted to resolve the linkage up to a depth of `addLiveRecursionLimit`.
   *
   * Headers are considered in the order they were added.
   *
   * @param header
   */
  async addHeader (header: BaseBlockHeader): Promise<void> {
    this.baseHeaders.push(header)
  }

  /**
   * If not already available, takes a writer lock to queue calls until available.
   * Becoming available starts by initializing ingestors and main thread,
   * and ends when main thread sets `available`.
   * Note that the main thread continues running and takes additional write locks
   * itself when already available.
   *
   * @returns when available for client requests
   */
  async makeAvailable (): Promise<void> {
    if (this.available) return
    await this.lock.withWriteLock(async () => {
      // Only the first call proceeds to initialize...
      if (this.available) return
      // Make sure database schema exists and is updated...
      await this.storage.migrateLatest()
      for (const bulkIn of this.bulkIngestors) await bulkIn.setStorage(this.storage, this.log)
      for (const liveIn of this.liveIngestors) await liveIn.setStorage(this.storage, this.log)

      // Start all live ingestors to push new headers onto liveHeaders... each long running.
      for (const liveIngestor of this.liveIngestors) this.promises.push(liveIngestor.startListening(this.liveHeaders))

      // Start mai loop to shift out liveHeaders...once sync'd, will set `available` true.
      this.promises.push(this.mainThreadShiftLiveHeaders())

      // Wait for the main thread to finish initial sync.
      while (!this.available && (this.startupError == null)) {
        await wait(100)
      }

      if (this.startupError != null) throw this.startupError
    })
  }

  async startPromises (): Promise<void> {
    if (this.promises.length > 0 || !this.stopMainThread) return
  }

  async destroy (): Promise<void> {
    if (!this.available) return
    await this.lock.withWriteLock(async () => {
      if (!this.available || this.stopMainThread) return
      this.log('Shutting Down')
      this.stopMainThread = true
      for (const liveIn of this.liveIngestors) await liveIn.shutdown()
      for (const bulkIn of this.bulkIngestors) await bulkIn.shutdown()
      await Promise.all(this.promises)
      await this.storage.destroy()
      this.available = false
      this.stopMainThread = false
      this.log('Shutdown')
    })
  }

  async listening (): Promise<void> {
    return await this.makeAvailable()
  }

  async isListening (): Promise<boolean> {
    return this.available
  }

  async isSynchronized (): Promise<boolean> {
    await this.makeAvailable()
    return true
  }

  async findHeaderForHeight (height: number): Promise<BlockHeader | undefined> {
    await this.makeAvailable()
    return await this.lock.withReadLock(async () => await this.findHeaderForHeightNoLock(height))
  }

  private async findHeaderForHeightNoLock (height: number): Promise<BlockHeader | undefined> {
    return await this.storage.findHeaderForHeightOrUndefined(height)
  }

  async findHeaderForBlockHash (hash: string): Promise<BlockHeader | undefined> {
    await this.makeAvailable()
    return await this.lock.withReadLock(async () => await this.findHeaderForBlockHashNoLock(hash))
  }

  private async findHeaderForBlockHashNoLock (hash: string): Promise<BlockHeader | undefined> {
    return (await this.storage.findLiveHeaderForBlockHash(hash)) || undefined
  }

  async isValidRootForHeight (root: string, height: number): Promise<boolean> {
    const r = await this.findHeaderForHeight(height)
    if (r == null) return false
    const isValid = root === r.merkleRoot
    return isValid
  }

  async getInfo (): Promise<ChaintracksInfoApi> {
    await this.makeAvailable()
    return await this.lock.withReadLock(async () => await this.getInfoNoLock())
  }

  private async getInfoNoLock (): Promise<ChaintracksInfoApi> {
    const liveRange = await this.storage.findLiveHeightRange()
    const info: ChaintracksInfoApi = {
      chain: this.chain,
      heightBulk: liveRange.minHeight - 1,
      heightLive: liveRange.maxHeight,
      storage: this.storage.constructor.name,
      bulkIngestors: this.bulkIngestors.map(bulkIngestor => bulkIngestor.constructor.name),
      liveIngestors: this.liveIngestors.map(liveIngestor => liveIngestor.constructor.name),
      packages: []
    }
    return info
  }

  async getHeaders (height: number, count: number): Promise<string> {
    await this.makeAvailable()
    return await this.lock.withReadLock(async () => asString(await this.storage.getHeadersUint8Array(height, count)))
  }

  async findChainTipHeader (): Promise<BlockHeader> {
    await this.makeAvailable()
    return await this.lock.withReadLock(async () => await this.storage.findChainTipHeader())
  }

  async findChainTipHash (): Promise<string> {
    await this.makeAvailable()
    return await this.lock.withReadLock(async () => await this.storage.findChainTipHash())
  }

  async findLiveHeaderForBlockHash (hash: string): Promise<LiveBlockHeader | undefined> {
    await this.makeAvailable()
    const header = await this.lock.withReadLock(async () => await this.storage.findLiveHeaderForBlockHash(hash))
    return header || undefined
  }

  async findChainWorkForBlockHash (hash: string): Promise<string | undefined> {
    const header = await this.findLiveHeaderForBlockHash(hash)
    return header?.chainWork
  }

  /**
   * @returns true iff all headers from height zero through current chainTipHeader height can be retreived and form a valid chain.
   */
  async validate (): Promise<boolean> {
    let h = await this.findChainTipHeader()
    while (h.height > 0) {
      const hp = await this.findHeaderForHeight(h.height - 1)
      if (hp?.hash !== h.previousHash) throw new Error(`validation fails at height ${h.height}`)
      h = hp
      if (10000 * Math.floor(h.height / 10000) === h.height) this.log(`height ${h.height}`)
    }
    this.log('validated')
    return true
  }

  async exportBulkHeaders (
    toFolder: string,
    toFs: ChaintracksFsApi,
    sourceUrl?: string,
    toHeadersPerFile?: number,
    maxHeight?: number
  ): Promise<void> {
    toHeadersPerFile ||= 100000
    const bulk = this.storage.bulkManager
    await bulk.exportHeadersToFs(toFs, toHeadersPerFile, toFolder, sourceUrl, maxHeight)
  }

  async startListening (): Promise<void> {
    this.makeAvailable()
  }

  private async syncBulkStorage (presentHeight: number, initialRanges: HeightRanges): Promise<void> {
    await this.lock.withWriteLock(async () => await this.syncBulkStorageNoLock(presentHeight, initialRanges))
  }

  private async syncBulkStorageNoLock (presentHeight: number, initialRanges: HeightRanges): Promise<void> {
    let newLiveHeaders: BlockHeader[] = []
    let before = initialRanges
    let after = before
    let added = HeightRange.empty
    const maxSyncRounds = Math.max(1, this.bulkIngestors.length * 2)

    for (let round = 1; round <= maxSyncRounds; round++) {
      const result = await this.runBulkSyncRound(before, presentHeight, newLiveHeaders)
      after = result.after
      newLiveHeaders = result.newLiveHeaders
      added = after.bulk.above(before.bulk)
      before = after

      if (this.startupError != null) break
      if (result.done) break
      if (!result.madeProgress) {
        this.log(`Bulk sync stalled after round ${round}. Deferring further bulk sync attempts to continue live header processing.`)
        break
      }
      if (round === maxSyncRounds) {
        this.log(`Bulk sync paused after ${maxSyncRounds} rounds to avoid runaway retries. Will retry in a later sync cycle.`)
      }
    }

    if (this.startupError == null) {
      this.liveHeaders.unshift(...newLiveHeaders)
      added = after.bulk.above(initialRanges.bulk)
      this.log(`syncBulkStorage done
  Before sync: bulk ${initialRanges.bulk}, live ${initialRanges.live}
   After sync: bulk ${after.bulk}, live ${after.live}
  ${added.length} headers added to bulk storage
  ${this.liveHeaders.length} headers forwarded to live header storage
`)
    }
  }

  private async runBulkSyncRound (
    before: HeightRanges,
    presentHeight: number,
    newLiveHeaders: BlockHeader[]
  ): Promise<{ after: HeightRanges, newLiveHeaders: BlockHeader[], done: boolean, madeProgress: boolean }> {
    let after = before
    let bulkSyncError: WalletError | undefined
    let madeProgress = false
    let hadSuccess = false
    let done = false

    for (const bulk of this.bulkIngestors) {
      try {
        const beforeBulkMax = before.bulk.maxHeight
        const beforeLiveRange = HeightRange.from(newLiveHeaders)
        const r = await bulk.synchronize(presentHeight, before, newLiveHeaders)
        hadSuccess = true

        newLiveHeaders = r.liveHeaders
        after = await this.storage.getAvailableHeightRanges()
        const added = after.bulk.above(before.bulk)
        const afterLiveRange = HeightRange.from(newLiveHeaders)
        if (after.bulk.maxHeight > beforeBulkMax || afterLiveRange.maxHeight > beforeLiveRange.maxHeight) madeProgress = true
        before = after
        this.log(`Bulk Ingestor: ${added.length} added with ${newLiveHeaders.length} live headers from ${bulk.constructor.name}`)
        if (r.done) { done = true; break }
      } catch (error_: unknown) {
        const e = (bulkSyncError = WalletError.fromUnknown(error_))
        this.log(`bulk sync error: ${e.message}`)
        // During initial startup, bulk ingestors must be available.
        if (!this.available) break
      }
    }

    if (!this.available && (bulkSyncError != null) && !hadSuccess) this.startupError = bulkSyncError
    return { after, newLiveHeaders, done, madeProgress }
  }

  private async getMissingBlockHeader (hash: string): Promise<BlockHeader | undefined> {
    for (const live of this.liveIngestors) {
      const header = await live.getHeaderByHash(hash)
      if (header != null) return header
    }
    return undefined
  }

  private invalidInsertHeaderResult (ihr: InsertHeaderResult): boolean {
    return ihr.noActiveAncestor || ihr.noTip || ihr.badPrev
  }

  private async addLiveHeader (header: BlockHeader): Promise<InsertHeaderResult> {
    validateHeaderFormat(header)
    validateAgainstDirtyHashes(header.hash)

    const ihr = this.available
      ? await this.lock.withWriteLock(async () => await this.storage.insertHeader(header))
      : await this.storage.insertHeader(header)

    if (this.invalidInsertHeaderResult(ihr)) return ihr

    if (this.subscriberCallbacksEnabled && ihr.added && ihr.isActiveTip) {
      this.notifyHeaderListeners(header)
      if (ihr.reorgDepth > 0 && (ihr.priorTip != null)) {
        this.notifyReorgListeners(ihr, header)
      }
    }

    return ihr
  }

  private notifyHeaderListeners (header: BlockHeader): void {
    for (const id in this.callbacks.header) {
      const listener = this.callbacks.header[id]
      if (listener != null) {
        try { listener(header) } catch { /* ignore all errors thrown */ }
      }
    }
  }

  private notifyReorgListeners (ihr: InsertHeaderResult, header: BlockHeader): void {
    const priorTip: BlockHeader = { ...ihr.priorTip! }
    const deactivated: BlockHeader[] = ihr.deactivatedHeaders.map(lbh => ({ ...lbh }))
    for (const id in this.callbacks.reorg) {
      const listener = this.callbacks.reorg[id]
      if (listener != null) {
        try { listener(ihr.reorgDepth, priorTip, header, deactivated) } catch { /* ignore all errors thrown */ }
      }
    }
  }

  /**
   * Long running method terminated by setting `stopMainThread` false.
   *
   * The promise returned by this method is held in the `promises` array.
   *
   * When synchronized (bulk and live storage is valid up to most recent presentHeight),
   * this method will process headers from `baseHeaders` and `liveHeaders` arrays to extend the chain of headers.
   *
   * If a significant gap is detected between bulk+live and presentHeight, `syncBulkStorage` is called to re-establish sync.
   *
   * Periodically CDN bulk ingestor is invoked to check if incremental headers can be migrated to CDN backed files.
   */
  private async mainThreadShiftLiveHeaders (): Promise<void> {
    this.stopMainThread = false
    let lastSyncCheck = 0
    let lastBulkSync = Date.now()
    const cdnSyncRepeatMsecs = 24 * 60 * 60 * 1000 // 24 hours
    const syncCheckRepeatMsecs = 30 * 60 * 1000 // 30 minutes

    while (!this.stopMainThread) {
      try {
        const now = Date.now()
        lastSyncCheck = now
        lastBulkSync = await this.runBulkSyncIfNeeded(now, lastBulkSync, cdnSyncRepeatMsecs)
        await this.processLiveHeaderQueue(lastSyncCheck, syncCheckRepeatMsecs)
      } catch (error_: unknown) {
        const e = WalletError.fromUnknown(error_)
        if (this.available) {
          this.log(`Error occurred during chaintracks main thread processing: ${e.stack || e.message}`)
        } else {
          this.startupError = e
          this.stopMainThread = true
        }
      }
    }
  }

  /** Returns (potentially updated) lastBulkSync timestamp. */
  private async runBulkSyncIfNeeded (now: number, lastBulkSync: number, cdnSyncRepeatMsecs: number): Promise<number> {
    const presentHeight = await this.getPresentHeight()
    const before = await this.storage.getAvailableHeightRanges()

    let skipBulkSync = !before.live.isEmpty && before.live.maxHeight >= presentHeight - this.addLiveRecursionLimit / 2
    // If we haven't re-synced in a long time, do it just to check for a CDN update.
    if (skipBulkSync && now - lastBulkSync > cdnSyncRepeatMsecs) skipBulkSync = false

    this.log(`Chaintracks Update Services: Bulk Header Sync Review
  presentHeight=${presentHeight}   addLiveRecursionLimit=${this.addLiveRecursionLimit}
  Before synchronize: bulk ${before.bulk}, live ${before.live}
  ${skipBulkSync ? 'Skipping' : 'Starting'} syncBulkStorage.
`)

    if (!skipBulkSync) {
      // Once available, the initial write lock is released; take a new one to update bulk storage.
      // While not yet available, the makeAvailable write lock is still held.
      if (this.available) await this.syncBulkStorage(presentHeight, before)
      else await this.syncBulkStorageNoLock(presentHeight, before)
      if (this.startupError != null) throw this.startupError
      return now
    }
    return lastBulkSync
  }

  private async processLiveHeaderQueue (lastSyncCheck: number, syncCheckRepeatMsecs: number): Promise<void> {
    let count = 0
    let liveHeaderDupes = 0
    let needSyncCheck = false

    while (!needSyncCheck && !this.stopMainThread) {
      const liveHeader = this.liveHeaders.shift()
      if (liveHeader != null) {
        const result = await this.processOneLiveHeader(liveHeader)
        if (result.needSyncCheck) { needSyncCheck = true; continue }
        if (result.dupe) liveHeaderDupes++
        if (result.added) count++
      } else {
        const bheader = this.baseHeaders.shift()
        if (bheader != null) {
          const added = await this.processOneBaseHeader(bheader)
          if (added) count++
        } else {
          // No live or base headers queued — idle path.
          if (count > 0) {
            if (liveHeaderDupes > 0) { this.log(`${liveHeaderDupes} duplicate headers ignored.`); liveHeaderDupes = 0 }
            const updated = await this.storage.getAvailableHeightRanges()
            this.log(`After adding ${count} live headers\n   After live: bulk ${updated.bulk}, live ${updated.live}\n`)
            count = 0
          }
          await this.checkAndEnableSubscribers()
          if (!this.available) this.available = true
          needSyncCheck = Date.now() - lastSyncCheck > syncCheckRepeatMsecs
          if (!needSyncCheck) await wait(1000)
        }
      }
    }
  }

  private formatIhrLog (prefix: string, header: BlockHeader, ihr: InsertHeaderResult): string {
    return `${prefix} ${header.height}${ihr.added ? ' added' : ''}${ihr.dupe ? ' dupe' : ''}${ihr.isActiveTip ? ' isActiveTip' : ''}${ihr.reorgDepth ? ' reorg depth ' + ihr.reorgDepth : ''}${ihr.noPrev ? ' noPrev' : ''}${ihr.noActiveAncestor || ihr.noTip || ihr.badPrev ? ' error' : ''}`
  }

  private async processOneLiveHeader (
    startHeader: BlockHeader
  ): Promise<{ needSyncCheck: boolean, dupe: boolean, added: boolean }> {
    let header = startHeader
    let recursions = this.addLiveRecursionLimit

    while (!this.stopMainThread) {
      const ihr = await this.addLiveHeader(header)
      if (this.invalidInsertHeaderResult(ihr)) {
        this.log(`Ignoring liveHeader ${header.height} ${header.hash} due to invalid insert result.`)
        return { needSyncCheck: true, dupe: false, added: false }
      }
      if (ihr.noPrev) {
        // Previous header is unknown; request it by hash from the network and try adding it first.
        if (recursions-- <= 0) {
          this.log(`Ignoring liveHeader ${header.height} ${header.hash} addLiveRecursionLimit=${this.addLiveRecursionLimit} exceeded.`)
          return { needSyncCheck: true, dupe: false, added: false }
        }
        const prevHeader = await this.getMissingBlockHeader(header.previousHash)
        if (prevHeader == null) {
          this.log(`Ignoring liveHeader ${header.height} ${header.hash} failed to find previous header by hash ${asString(header.previousHash)}`)
          return { needSyncCheck: true, dupe: false, added: false }
        }
        // Retry adding prevHeader first; then re-queue current header.
        this.liveHeaders.unshift(header)
        header = prevHeader
      } else {
        if (this.subscriberCallbacksEnabled) this.log(this.formatIhrLog('addLiveHeader', header, ihr))
        return { needSyncCheck: false, dupe: ihr.dupe, added: ihr.added }
      }
    }
    return { needSyncCheck: false, dupe: false, added: false }
  }

  private async processOneBaseHeader (bheader: BaseBlockHeader): Promise<boolean> {
    const prev = await this.storage.findLiveHeaderForBlockHash(bheader.previousHash)
    if (prev == null) {
      // Unknown previous hash — ignore without triggering a re-sync.
      this.log(`Ignoring header with unknown previousHash ${bheader.previousHash} in live storage.`)
      return false
    }
    const header: BlockHeader = { ...bheader, height: prev.height + 1, hash: blockHash(bheader) }
    const ihr = await this.addLiveHeader(header)
    if (this.invalidInsertHeaderResult(ihr)) {
      this.log(`Ignoring invalid baseHeader ${header.height} ${header.hash}.`)
      return false
    }
    if (this.subscriberCallbacksEnabled) this.log(this.formatIhrLog('addBaseHeader', header, ihr))
    return ihr.added
  }

  private async checkAndEnableSubscribers (): Promise<void> {
    if (this.subscriberCallbacksEnabled) return
    const live = await this.storage.findLiveHeightRange()
    if (!live.isEmpty) {
      this.subscriberCallbacksEnabled = true
      this.log(`listening at height of ${live.maxHeight}`)
    }
  }
}
