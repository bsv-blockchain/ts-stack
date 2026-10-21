import {
  ChaintracksStorageBaseOptions,
  ChaintracksStorageBulkFileApi,
  InsertHeaderResult
} from '../Api/ChaintracksStorageApi'
import { ChaintracksStorageBase } from './ChaintracksStorageBase'
import { LiveBlockHeader } from '../Api/BlockHeaderApi'
import { addWork, convertBitsToWork, isMoreWork } from '../util/blockHeaderUtilities'

import { HeightRange } from '../util/HeightRange'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../../sdk/WERR_errors'
import { BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { IDBPDatabase, IDBPTransaction, openDB } from 'idb'

import { BulkHeaderFileInfo } from '../util/BulkHeaderFile'
import { normalizeBulkHeaderFileInfo, normalizeBulkHeaderFileSequence } from '../util/BulkFileDataManager'

export interface ChaintracksStorageIdbOptions extends ChaintracksStorageBaseOptions {}

type IdbWriteTransaction = IDBPTransaction<ChaintracksStorageIdbSchema, string[], 'readwrite'>

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

export class ChaintracksStorageIdb extends ChaintracksStorageBase implements ChaintracksStorageBulkFileApi {
  dbName: string

  db?: IDBPDatabase<ChaintracksStorageIdbSchema>

  whenLastAccess?: Date

  allStores: string[] = ['live_headers', 'bulk_headers']

  constructor(options: ChaintracksStorageIdbOptions) {
    super(options)
    this.dbName = `chaintracks-${this.chain}net`
  }

  override async makeAvailable(): Promise<void> {
    if (this.isAvailable && this.hasMigrated) return
    // Not a base class policy, but we want to ensure migrations are run before getting to business.
    if (!this.hasMigrated) {
      await this.migrateLatest()
    }
    if (!this.isAvailable) {
      await super.makeAvailable()
      // Connect the bulk data file manager to the table provided by this storage class.
      await this.bulkManager.setStorage(this, this.log)
    }
  }

  override async migrateLatest(): Promise<void> {
    if (this.db != null) return
    this.db = await this.initDB()
    await super.migrateLatest()
  }

  override async destroy(): Promise<void> {
    /* intentional no-op: IDB cleanup handled by openDB */
  }

  override async deleteLiveBlockHeaders(): Promise<void> {
    await this.makeAvailable()
    await this.db?.clear('live_headers')
  }

  /**
   * Delete live headers with height less or equal to `maxHeight`
   *
   * Set existing headers with previousHeaderId value set to the headerId value of
   * a header which is to be deleted to null.
   *
   * @param maxHeight delete all records with less or equal `height`
   * @returns number of deleted records
   */
  override async deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number> {
    this.validateHeight(maxHeight, 'maxHeight')
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')
    const previousHeaderIdIndex = store.index('previousHeaderId')

    // Get all headers with height <= maxHeight
    const range = IDBKeyRange.upperBound(maxHeight)
    const headersToDelete: LiveBlockHeader[] = await heightIndex.getAll(range)
    const headerIdsToDelete = new Set(headersToDelete.map(header => header.headerId))
    const deletedCount = headersToDelete.length

    for (const id of headerIdsToDelete) {
      const headersToUpdate = await previousHeaderIdIndex.getAll(id)
      for (const headerToUpdate of headersToUpdate) {
        await store.put({ ...headerToUpdate, previousHeaderId: null })
      }
    }

    // Delete the headers
    for (const id of headerIdsToDelete) {
      await store.delete(id)
    }

    await trx.done
    return deletedCount
  }

  /**
   * @returns the active chain tip header
   * @throws an error if there is no tip.
   */
  override async findChainTipHeader(): Promise<LiveBlockHeader> {
    const header = await this.findChainTipHeaderOrUndefined()
    if (header == null) throw new Error('Database contains no active chain tip header.')
    return header
  }

  /**
   *
   * @returns the active chain tip header
   * @throws an error if there is no tip.
   */
  override async findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined> {
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const activeTipIndex = store.index('activeTip')
    const headers = (await activeTipIndex.getAll([1, 1])).map(header => this.repairStoredLiveHeader(header)!)
    await trx.done
    if (headers.length > 1) throw new WERR_INVALID_OPERATION('multiple active chain tips exist in IndexedDB')
    return headers[0]
  }

  override async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null> {
    this.validateHash(hash)
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const hashIndex = store.index('hash')
    let header = await hashIndex.get(hash)
    header = this.repairStoredLiveHeader(header)
    await trx.done
    return header
  }

  override async findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader> {
    if (!Number.isSafeInteger(headerId) || headerId < 1) {
      throw new WERR_INVALID_PARAMETER('headerId', 'a positive safe integer')
    }
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    let header = await store.get(headerId)
    header = this.repairStoredLiveHeader(header)
    await trx.done
    return header
  }

  override async findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null> {
    this.validateHeight(height)
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')
    const headers = (await heightIndex.getAll(height))
      .map(header => this.repairStoredLiveHeader(header)!)
      .filter(header => header.isActive)
    await trx.done
    if (headers.length > 1) throw new WERR_INVALID_OPERATION(`multiple active headers exist at height ${height}`)
    return headers[0] ?? null
  }

  override async findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null> {
    this.validateHash(merkleRoot, 'merkleRoot')
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const merkleRootIndex = store.index('merkleRoot')
    const headers = (await merkleRootIndex.getAll(merkleRoot)).map(header => this.repairStoredLiveHeader(header)!)
    await trx.done
    return headers.find(header => header.isActive) ?? headers[0] ?? null
  }

  override async findLiveHeightRange(): Promise<HeightRange> {
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const active = (await store.getAll()).map(header => this.repairStoredLiveHeader(header)!).filter(h => h.isActive)
    const range =
      active.length === 0
        ? HeightRange.empty
        : new HeightRange(
            Math.min(...active.map(header => header.height)),
            Math.max(...active.map(header => header.height))
          )

    await trx.done
    return range
  }

  override async findMaxHeaderId(): Promise<number> {
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')

    const maxCursor = await store.openKeyCursor(null, 'prev')
    const maxValue: number = maxCursor != null ? Number(maxCursor.key) : 0
    await trx.done
    return maxValue
  }

  override async liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
      throw new WERR_INVALID_PARAMETER('count', 'an integer from 1 through 100000')
    }
    await this.makeAvailable()

    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')

    let cursor = await heightIndex.openCursor(null, 'next')
    const headers: LiveBlockHeader[] = []

    while (cursor != null && count > 0) {
      const header = this.repairStoredLiveHeader(cursor.value)
      if (header?.isActive) {
        count--
        headers.push(header)
      }
      cursor = await cursor.continue()
    }

    await trx.done
    return headers
  }

  override async getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]> {
    this.validateRange(range)
    if (range.isEmpty) return []
    await this.makeAvailable()

    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')

    let cursor = await heightIndex.openCursor(IDBKeyRange.bound(range.minHeight, range.maxHeight), 'next')
    const headers: LiveBlockHeader[] = []

    while (cursor != null) {
      const header = this.repairStoredLiveHeader(cursor.value)
      if (header?.isActive) {
        headers.push(header)
      }
      cursor = await cursor.continue()
    }

    await trx.done
    return headers
  }

  private async insertFirstHeader(
    trx: IdbWriteTransaction,
    header: BlockHeader,
    result: InsertHeaderResult
  ): Promise<boolean> {
    const store = trx.objectStore('live_headers')
    if ((await store.count()) !== 0) return false
    const lastBulkFile = await this.bulkManager.getLastFile()
    if (lastBulkFile == null) {
      throw new WERR_INVALID_OPERATION('bulk headers must exist before first live header can be added')
    }
    if (
      header.previousHash !== lastBulkFile.lastHash ||
      header.height !== lastBulkFile.firstHeight + lastBulkFile.count
    ) {
      return false
    }
    const newHeader: LiveBlockHeader = {
      ...header,
      headerId: 0,
      previousHeaderId: null,
      chainWork: addWork(lastBulkFile.lastChainWork, convertBitsToWork(header.bits, this.chain)),
      isChainTip: true,
      isActive: true
    }
    newHeader.headerId = Number(await store.add(this.prepareStoredLiveHeader(newHeader, true)))
    result.isActiveTip = true
    result.added = true
    return true
  }

  private async findActiveAncestor(
    trx: IdbWriteTransaction,
    oneBack: LiveBlockHeader,
    result: InsertHeaderResult
  ): Promise<LiveBlockHeader | undefined> {
    const store = trx.objectStore('live_headers')
    let activeAncestor = oneBack
    const visited = new Set<number>()
    while (!activeAncestor.isActive) {
      this.recordTraversalVisit(visited, activeAncestor, 'finding the active ancestor')
      if (activeAncestor.previousHeaderId == null) {
        result.noActiveAncestor = true
        return undefined
      }
      const previousHeader = this.repairStoredLiveHeader(await store.get(activeAncestor.previousHeaderId!))
      if (previousHeader == null) {
        result.noActiveAncestor = true
        return undefined
      }
      this.validateStoredParentLink(activeAncestor, previousHeader)
      activeAncestor = previousHeader
    }
    return activeAncestor
  }

  private async applyReorganization(
    trx: IdbWriteTransaction,
    oneBack: LiveBlockHeader,
    activeAncestor: LiveBlockHeader,
    result: InsertHeaderResult
  ): Promise<void> {
    if (activeAncestor.headerId === oneBack.headerId) return
    const store = trx.objectStore('live_headers')
    const activeTipIndex = store.index('activeTip')
    const activeTips = (await activeTipIndex.getAll([1, 1])).map(header => this.repairStoredLiveHeader(header)!)
    if (activeTips.length !== 1) {
      throw new WERR_INVALID_OPERATION(`expected one active chain tip, found ${activeTips.length}`)
    }
    let headerToDeactivate = activeTips[0]
    const deactivated = new Set<number>()
    while (headerToDeactivate != null && headerToDeactivate.headerId !== activeAncestor.headerId) {
      this.recordTraversalVisit(deactivated, headerToDeactivate, 'deactivating the prior active chain')
      result.deactivatedHeaders.push(headerToDeactivate)
      await store.put(
        this.prepareStoredLiveHeader({
          ...headerToDeactivate,
          isActive: false
        })
      )
      if (headerToDeactivate.previousHeaderId == null) {
        throw new WERR_INVALID_OPERATION('active chain does not reach the selected reorganization ancestor')
      }
      const previousHeader = this.repairStoredLiveHeader(await store.get(headerToDeactivate.previousHeaderId))
      if (previousHeader == null) {
        throw new WERR_INVALID_OPERATION('active chain contains a missing parent header')
      }
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
      await store.put(this.prepareStoredLiveHeader({ ...headerToActivate, isActive: true }))
      if (headerToActivate.previousHeaderId == null) {
        throw new WERR_INVALID_OPERATION('replacement chain does not reach the selected reorganization ancestor')
      }
      const previousHeader = this.repairStoredLiveHeader(await store.get(headerToActivate.previousHeaderId))
      if (previousHeader == null) {
        throw new WERR_INVALID_OPERATION('replacement chain contains a missing parent header')
      }
      this.validateStoredParentLink(headerToActivate, previousHeader)
      headerToActivate = previousHeader
    }
  }

  private async prepareActiveTip(
    trx: IdbWriteTransaction,
    header: BlockHeader,
    oneBack: LiveBlockHeader,
    result: InsertHeaderResult
  ): Promise<boolean> {
    if (!result.isActiveTip) return true
    const activeAncestor = await this.findActiveAncestor(trx, oneBack, result)
    if (activeAncestor == null) return false
    if (!(oneBack.isActive && oneBack.isChainTip)) {
      result.reorgDepth = Math.min(result.priorTip!.height, header.height) - activeAncestor.height
    }
    await this.applyReorganization(trx, oneBack, activeAncestor, result)
    return true
  }

  override async insertHeader(header: BlockHeader): Promise<InsertHeaderResult> {
    header = this.validateIncomingHeader(header)
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    const hashIndex = store.index('hash')
    const activeTipIndex = store.index('activeTip')

    const r = createInsertHeaderResult()
    try {
      // Check for duplicate
      if (await hashIndex.get(header.hash)) {
        r.dupe = true
        await trx.done
        return r
      }

      // let all = await store.getAll()
      // console.log(`idb store length: ${all.length} last: ${all[all.length - 1]?.height}`)
      // let allHash = await hashIndex.getAll()

      // Find previous header
      const oneBack: LiveBlockHeader | undefined = this.repairStoredLiveHeader(await hashIndex.get(header.previousHash))

      if (oneBack == null) {
        if (await this.insertFirstHeader(trx, header, r)) {
          await trx.done
          return r
        }
        r.noPrev = true
        await trx.done
        return r
      }

      if (oneBack.height + 1 !== header.height) {
        r.badPrev = true
        await trx.done
        return r
      }

      if (oneBack.isActive && oneBack.isChainTip) {
        r.priorTip = oneBack
      } else {
        const activeTips = (await activeTipIndex.getAll([1, 1])).map(tip => this.repairStoredLiveHeader(tip)!)
        if (activeTips.length > 1) {
          trx.abort()
          throw new WERR_INVALID_OPERATION('multiple active chain tips exist in IndexedDB')
        }
        r.priorTip = activeTips[0]
      }

      if (r.priorTip == null) {
        // No active chain tip found. This is a logic error in state of live headers.
        r.noTip = true
        await trx.done
        return r
      }

      // We have an acceptable new live header...and live headers has an active chain tip.

      const chainWork = addWork(oneBack.chainWork, convertBitsToWork(header.bits, this.chain))

      r.isActiveTip = isMoreWork(chainWork, r.priorTip.chainWork)

      const newHeader: LiveBlockHeader = {
        ...header,
        headerId: 0,
        previousHeaderId: oneBack.headerId,
        chainWork,
        isChainTip: r.isActiveTip,
        isActive: r.isActiveTip
      }

      if (!(await this.prepareActiveTip(trx, header, oneBack, r))) {
        await trx.done
        return r
      }

      if (oneBack.isChainTip) {
        await store.put(this.prepareStoredLiveHeader({ ...oneBack, isChainTip: false }))
      }

      await store.put(this.prepareStoredLiveHeader(newHeader, true))
      r.added = true

      // all = await store.getAll()
      // console.log(`idb store length: ${all.length} last: ${all[all.length - 1]?.height}`)

      if (r.added && r.isActiveTip) {
        // this.pruneLiveBlockHeaders(newHeader.height)
      }

      await trx.done
      return r
    } catch (error: unknown) {
      try {
        trx.abort()
      } catch {
        // The transaction may already have aborted because an IndexedDB
        // request failed. Either way, never mask the original failure.
      }
      await trx.done.catch(() => {})
      throw error
    }
  }

  async deleteBulkFile(fileId: number): Promise<number> {
    if (!Number.isSafeInteger(fileId) || fileId < 1) {
      throw new WERR_INVALID_PARAMETER('fileId', 'a positive safe integer')
    }
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')
    const existed = (await store.get(fileId)) != null
    await store.delete(fileId)
    await trx.done
    return existed ? 1 : 0
  }

  async insertBulkFile(file: BulkHeaderFileInfo): Promise<number> {
    await this.makeAvailable()

    const canonical = normalizeBulkHeaderFileInfo(file, true)
    if (canonical.chain !== this.chain) throw new WERR_INVALID_PARAMETER('file.chain', this.chain)

    const trx = this.toDbTrxReadWrite(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')
    const fileObj: Record<string, unknown> = { ...canonical }
    delete fileObj['fileId']
    const fileId = Number(await store.put(fileObj))
    await trx.done
    return fileId
  }

  async updateBulkFile(fileId: number, file: BulkHeaderFileInfo): Promise<number> {
    if (!Number.isSafeInteger(fileId) || fileId < 1) {
      throw new WERR_INVALID_PARAMETER('fileId', 'a positive safe integer')
    }
    await this.makeAvailable()

    const canonical = normalizeBulkHeaderFileInfo(file, true)
    if (canonical.chain !== this.chain) throw new WERR_INVALID_PARAMETER('file.chain', this.chain)
    if (canonical.fileId !== undefined && canonical.fileId !== fileId) {
      throw new WERR_INVALID_PARAMETER('file.fileId', 'undefined or equal to fileId')
    }

    const trx = this.toDbTrxReadWrite(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')
    await store.put({ ...canonical, fileId })
    await trx.done
    // return number of records affected
    return 1
  }

  async replaceBulkFiles(files: BulkHeaderFileInfo[]): Promise<BulkHeaderFileInfo[]> {
    const canonical = normalizeBulkHeaderFileSequence(files, true).map(value => {
      if (value.chain !== this.chain) throw new WERR_INVALID_PARAMETER('file.chain', this.chain)
      return value
    })
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')
    try {
      const current = await store.getAll()
      const currentById = new Map<number, BulkHeaderFileInfo>()
      for (const file of current) {
        const value = normalizeBulkHeaderFileInfo(file, true)
        if (value.fileId === undefined || currentById.has(value.fileId)) {
          throw new WERR_INVALID_OPERATION('IndexedDB contains an invalid or duplicate bulk-file id')
        }
        currentById.set(value.fileId, value)
      }

      const retainedIds = new Set<number>()
      const committed: BulkHeaderFileInfo[] = []
      for (const file of canonical) {
        let fileId = file.fileId
        if (fileId !== undefined) {
          const prior = currentById.get(fileId)
          if (prior == null || retainedIds.has(fileId)) {
            throw new WERR_INVALID_PARAMETER('file.fileId', 'a unique id belonging to the current bulk-file set')
          }
          const stored = { ...file, data: file.data ?? prior.data, fileId }
          await store.put(stored)
        } else {
          const stored: Record<string, unknown> = { ...file }
          delete stored.fileId
          fileId = Number(await store.add(stored))
          if (!Number.isSafeInteger(fileId) || fileId < 1) {
            throw new WERR_INVALID_OPERATION('IndexedDB returned an invalid bulk-file id')
          }
        }
        retainedIds.add(fileId)
        committed.push({ ...file, fileId })
      }

      for (const fileId of currentById.keys()) {
        if (!retainedIds.has(fileId)) await store.delete(fileId)
      }
      await trx.done
      return committed
    } catch (error) {
      try {
        trx.abort()
      } catch {
        // The transaction may already have aborted. Preserve the first error.
      }
      await trx.done.catch(() => {})
      throw error
    }
  }

  async getBulkFiles(): Promise<BulkHeaderFileInfo[]> {
    await this.makeAvailable()

    const trx = this.toDbTrxReadOnly(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')

    const files = (await store.getAll()).map(file => normalizeBulkHeaderFileInfo(file, true))
    files.sort((a, b) => a.firstHeight - b.firstHeight)
    for (const file of files) file.data = undefined
    return files
  }

  async getBulkFileData(fileId: number, offset?: number, length?: number): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(fileId) || fileId < 1) {
      throw new WERR_INVALID_PARAMETER('fileId', 'a positive safe integer bulk_files fileId')
    }
    const hasOffset = offset !== undefined
    const hasLength = length !== undefined
    if (hasOffset !== hasLength) {
      throw new WERR_INVALID_PARAMETER('offset and length', 'both defined or both undefined')
    }
    if (
      hasOffset &&
      (!Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset! < 0 ||
        length! < 0 ||
        !Number.isSafeInteger(offset! + length!))
    ) {
      throw new WERR_INVALID_PARAMETER('offset and length', 'non-negative safe integers with a safe sum')
    }
    await this.makeAvailable()

    const trx = this.toDbTrxReadOnly(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')

    const info: BulkHeaderFileInfo | undefined = await store.get(fileId)
    if (info == null) throw new WERR_INVALID_PARAMETER('fileId', `an existing record. ${fileId} not found`)

    let data: Uint8Array | undefined

    if (info.data == null) {
      await trx.done
      return undefined
    }

    if (hasOffset) {
      data = info.data.slice(offset!, offset! + length!)
    } else {
      data = info.data
    }
    await trx.done
    return data
  }

  /**
   * IndexedDB does not do indices of boolean properties.
   * So true is stored as a 1, and false is stored as no property value (delete v['property'])
   *
   * This function restores these property values to true and false.
   *
   * @param header
   * @returns copy of header with updated properties
   */
  protected repairStoredLiveHeader(header?: LiveBlockHeader): LiveBlockHeader | undefined {
    if (header == null) return undefined
    if (
      ![undefined, true, 1].includes(header.isActive as unknown as undefined | true | 1) ||
      ![undefined, true, 1].includes(header.isChainTip as unknown as undefined | true | 1)
    ) {
      throw new WERR_INVALID_OPERATION('IndexedDB contains a non-canonical live-header boolean')
    }
    const h: LiveBlockHeader = {
      ...header,
      isActive: header.isActive === true || (header.isActive as unknown) === 1,
      isChainTip: header.isChainTip === true || (header.isChainTip as unknown) === 1
    }
    return this.validateLiveHeaderRecord(h)
  }

  private prepareStoredLiveHeader(header: LiveBlockHeader, forInsert?: boolean): object {
    const h: Record<string, unknown> = { ...header }
    if (forInsert) delete h['headerId']

    if (header.isActive) h['isActive'] = 1
    else delete h['isActive']
    if (header.isChainTip) h['isChainTip'] = 1
    else delete h['isChainTip']

    return h
  }

  async insertLiveHeader(header: LiveBlockHeader): Promise<LiveBlockHeader> {
    await this.makeAvailable()
    const canonical = this.validateLiveHeaderRecord(header, true)
    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')

    const h = this.prepareStoredLiveHeader(canonical, true)

    canonical.headerId = Number(await store.add(h))

    await trx.done

    return canonical
  }

  async initDB(): Promise<IDBPDatabase<ChaintracksStorageIdbSchema>> {
    const db = await openDB<ChaintracksStorageIdbSchema>(this.dbName, 1, {
      upgrade(db, _oldVersion, _newVersion, _transaction) {
        if (!db.objectStoreNames.contains('live_headers')) {
          const liveHeadersStore = db.createObjectStore('live_headers', {
            keyPath: 'headerId',
            autoIncrement: true
          })
          liveHeadersStore.createIndex('hash', 'hash', { unique: true })
          liveHeadersStore.createIndex('height', 'height', { unique: false })
          liveHeadersStore.createIndex('previousHeaderId', 'previousHeaderId', { unique: false })
          liveHeadersStore.createIndex('merkleRoot', 'merkleRoot', { unique: false })
          liveHeadersStore.createIndex('activeTip', ['isActive', 'isChainTip'], { unique: false })
        }

        if (!db.objectStoreNames.contains('bulk_headers')) {
          db.createObjectStore('bulk_headers', {
            keyPath: 'fileId',
            autoIncrement: true
          })
        }
      }
    })
    return db
  }

  toDbTrxReadOnly(stores: string[]): IDBPTransaction<ChaintracksStorageIdbSchema, string[], 'readonly'> {
    if (this.db == null) throw new Error('not initialized')
    const db = this.db
    const trx = db.transaction(stores || this.allStores, 'readonly')
    this.whenLastAccess = new Date()
    return trx
  }

  toDbTrxReadWrite(stores: string[]): IDBPTransaction<ChaintracksStorageIdbSchema, string[], 'readwrite'> {
    if (this.db == null) throw new Error('not initialized')
    const db = this.db
    const trx = db.transaction(stores || this.allStores, 'readwrite')
    this.whenLastAccess = new Date()
    return trx
  }
}

export interface ChaintracksStorageIdbSchema {
  liveHeaders: {
    key: number
    value: LiveBlockHeader
    indexes: {
      hash: string
      previousHash: string
      previousHeaderId: number | null
      isActive: boolean
      activeTip: [boolean, boolean]
      height: number
    }
  }
  bulkHeaders: {
    key: number
    value: BulkHeaderFileInfo
    indexes: {
      firstHeight: number
    }
  }
}
