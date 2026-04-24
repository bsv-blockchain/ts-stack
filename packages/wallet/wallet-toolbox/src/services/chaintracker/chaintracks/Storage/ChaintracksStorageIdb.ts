import {
  ChaintracksStorageBaseOptions,
  ChaintracksStorageBulkFileApi,
  InsertHeaderResult
} from '../Api/ChaintracksStorageApi'
import { ChaintracksStorageBase } from './ChaintracksStorageBase'
import { LiveBlockHeader } from '../Api/BlockHeaderApi'
import { addWork, convertBitsToWork, isMoreWork, serializeBaseBlockHeader } from '../util/blockHeaderUtilities'
import { HeightRange } from '../util/HeightRange'
import { BulkFilesReaderStorage } from '../util/BulkFilesReader'
import { ChaintracksFetch } from '../util/ChaintracksFetch'
import { Chain } from '../../../../sdk/types'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../../sdk/WERR_errors'
import { BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { IDBPDatabase, IDBPObjectStore, IDBPTransaction, openDB } from 'idb'
import { BulkHeaderFileInfo } from '../util/BulkHeaderFile'

interface ChaintracksIdbData {
  chain: Chain
  liveHeaders: Map<number, LiveBlockHeader>
  maxHeaderId: number
  tipHeaderId: number
  hashToHeaderId: Map<string, number>
}

export interface ChaintracksStorageIdbOptions extends ChaintracksStorageBaseOptions {}

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
    if (this.db) return
    this.db = await this.initDB()
    await super.migrateLatest()
  }

  override async destroy(): Promise<void> {}

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
      const headerToUpdate = await previousHeaderIdIndex.get(id)
      await store.put({ ...headerToUpdate, previousHeaderId: null })
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
    if (!header) throw new Error('Database contains no active chain tip header.')
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
    let header = await activeTipIndex.get([1, 1])
    header = this.repairStoredLiveHeader(header)
    await trx.done
    return header
  }

  override async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null> {
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
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    let header = await store.get(headerId)
    header = this.repairStoredLiveHeader(header)
    await trx.done
    return header
  }

  override async findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null> {
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')
    let header = await heightIndex.get(height)
    header = this.repairStoredLiveHeader(header)
    await trx.done
    return header || null
  }

  override async findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null> {
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const merkleRootIndex = store.index('merkleRoot')
    let header = await merkleRootIndex.get(merkleRoot)
    header = this.repairStoredLiveHeader(header)
    await trx.done
    return header || null
  }

  override async findLiveHeightRange(): Promise<HeightRange> {
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')

    const minCursor = await heightIndex.openCursor(null, 'next')
    const minValue = minCursor ? minCursor.value.height : null

    const maxCursor = await heightIndex.openCursor(null, 'prev')
    const maxValue = maxCursor ? maxCursor.value.height : null

    const range = minValue === null || maxValue === null ? HeightRange.empty : new HeightRange(minValue, maxValue)

    await trx.done
    return range
  }

  override async findMaxHeaderId(): Promise<number> {
    await this.makeAvailable()
    const trx = this.toDbTrxReadOnly(['live_headers'])
    const store = trx.objectStore('live_headers')

    const maxCursor = await store.openKeyCursor(null, 'prev')
    const maxValue: number = maxCursor ? Number(maxCursor.key) : 0
    await trx.done
    return maxValue
  }

  override async liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]> {
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')

    let cursor = await heightIndex.openCursor(null, 'next')
    const headers: LiveBlockHeader[] = []

    while (cursor && count > 0) {
      const header = this.repairStoredLiveHeader(cursor.value)
      if (header && header.isActive) {
        count--
        headers.push(header)
      }
      cursor = await cursor.continue()
    }

    await trx.done
    return headers
  }

  override async getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]> {
    if (range.isEmpty) return []
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    const heightIndex = store.index('height')

    let cursor = await heightIndex.openCursor(null, 'next')
    const headers: LiveBlockHeader[] = []

    while (cursor) {
      const header = this.repairStoredLiveHeader(cursor.value)
      if (header && range.contains(header.height)) {
        headers.push(header)
      }
      cursor = await cursor.continue()
    }

    await trx.done
    return headers
  }

  override async insertHeader(header: BlockHeader): Promise<InsertHeaderResult> {
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')
    const hashIndex = store.index('hash')
    const activeTipIndex = store.index('activeTip')

    const r: InsertHeaderResult = {
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

    // Check for duplicate
    if (await hashIndex.get(header.hash)) {
      r.dupe = true
      await trx.done
      return r
    }

    //let all = await store.getAll()
    //console.log(`idb store length: ${all.length} last: ${all[all.length - 1]?.height}`)
    //let allHash = await hashIndex.getAll()

    // Find previous header
    let oneBack: LiveBlockHeader | undefined = this.repairStoredLiveHeader(await hashIndex.get(header.previousHash))

    if (!oneBack) {
      // Check if this is first live header
      const count = await store.count()
      if (count === 0) {
        // If this is the first live header, the last bulk header (if there is one) is the previous header.
        const lbf = await this.bulkManager.getLastFile()
        if (!lbf) throw new WERR_INVALID_OPERATION('bulk headers must exist before first live header can be added')
        if (header.previousHash === lbf.lastHash && header.height === lbf.firstHeight + lbf.count) {
          // Valid first live header. Add it.
          const chainWork = addWork(lbf.lastChainWork, convertBitsToWork(header.bits))
          r.isActiveTip = true
          const newHeader: LiveBlockHeader = {
            ...header,
            headerId: 0,
            previousHeaderId: null,
            chainWork,
            isChainTip: r.isActiveTip,
            isActive: r.isActiveTip
          }
          const h = this.prepareStoredLiveHeader(newHeader, true)
          newHeader.headerId = Number(await store.add(h))
          r.added = true
          await trx.done
          return r
        }
      }
      // Failure without a oneBack
      // First live header that does not follow last bulk header or
      // Not the first live header and live headers doesn't include a previousHash header.
      r.noPrev = true
      await trx.done
      return r
    }

    if (oneBack.isActive && oneBack.isChainTip) {
      r.priorTip = oneBack
    } else {
      r.priorTip = this.repairStoredLiveHeader(await activeTipIndex.get([1, 1]))
    }

    if (!r.priorTip) {
      // No active chain tip found. This is a logic error in state of live headers.
      r.noTip = true
      await trx.done
      return r
    }

    // We have an acceptable new live header...and live headers has an active chain tip.

    const chainWork = addWork(oneBack.chainWork, convertBitsToWork(header.bits))

    r.isActiveTip = isMoreWork(chainWork, r.priorTip.chainWork)

    const newHeader: LiveBlockHeader = {
      ...header,
      headerId: 0,
      previousHeaderId: oneBack.headerId,
      chainWork,
      isChainTip: r.isActiveTip,
      isActive: r.isActiveTip
    }

    if (r.isActiveTip) {
      let activeAncestor = oneBack
      while (!activeAncestor.isActive) {
        const previousHeader = this.repairStoredLiveHeader(await store.get(activeAncestor.previousHeaderId!))
        if (!previousHeader) {
          r.noActiveAncestor = true
          await trx.done
          return r
        }
        activeAncestor = previousHeader
      }

      if (!(oneBack.isActive && oneBack.isChainTip)) {
        r.reorgDepth = Math.min(r.priorTip.height, header.height) - activeAncestor.height
      }

      if (activeAncestor.headerId !== oneBack.headerId) {
        // Deactivate reorg'ed headers
        let headerToDeactivate = this.repairStoredLiveHeader(await activeTipIndex.get([1, 1]))!
        while (headerToDeactivate && headerToDeactivate.headerId !== activeAncestor.headerId) {
          r.deactivatedHeaders.push(headerToDeactivate)
          await store.put(this.prepareStoredLiveHeader({ ...headerToDeactivate, isActive: false }))
          headerToDeactivate = this.repairStoredLiveHeader(await store.get(headerToDeactivate.previousHeaderId!))!
        }

        let headerToActivate = oneBack
        while (headerToActivate.headerId !== activeAncestor.headerId) {
          await store.put(this.prepareStoredLiveHeader({ ...headerToActivate, isActive: true }))
          headerToActivate = this.repairStoredLiveHeader(await store.get(headerToActivate.previousHeaderId!))!
        }
      }
    }

    if (oneBack.isChainTip) {
      await store.put(this.prepareStoredLiveHeader({ ...oneBack, isChainTip: false }))
    }

    await store.put(this.prepareStoredLiveHeader(newHeader, true))
    r.added = true

    //all = await store.getAll()
    //console.log(`idb store length: ${all.length} last: ${all[all.length - 1]?.height}`)

    if (r.added && r.isActiveTip) {
      //this.pruneLiveBlockHeaders(newHeader.height)
    }

    await trx.done
    return r
  }

  async deleteBulkFile(fileId: number): Promise<number> {
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')
    await store.delete(fileId)
    await trx.done
    // return number of records affected
    return 1
  }

  async insertBulkFile(file: BulkHeaderFileInfo): Promise<number> {
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')
    const fileObj: object = { ...file }
    delete fileObj['fileId']
    file.fileId = Number(await store.put(fileObj))
    await trx.done
    return file.fileId
  }

  async updateBulkFile(fileId: number, file: BulkHeaderFileInfo): Promise<number> {
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')
    file.fileId = fileId
    await store.put(file)
    await trx.done
    // return number of records affected
    return 1
  }

  async getBulkFiles(): Promise<BulkHeaderFileInfo[]> {
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')

    const files: BulkHeaderFileInfo[] = await store.getAll()
    files.sort((a, b) => a.firstHeight - b.firstHeight)
    for (const file of files) file.data = undefined
    return files
  }

  async getBulkFileData(fileId: number, offset?: number, length?: number): Promise<Uint8Array | undefined> {
    if (!Number.isInteger(fileId)) throw new WERR_INVALID_PARAMETER('fileId', 'a valid, integer bulk_files fileId')
    await this.makeAvailable()

    const trx = this.toDbTrxReadWrite(['bulk_headers'])
    const store = trx.objectStore('bulk_headers')

    const info: BulkHeaderFileInfo | undefined = await store.get(fileId)
    if (!info) throw new WERR_INVALID_PARAMETER(`fileId`, `an existing record. ${fileId} not found`)

    let data: Uint8Array | undefined = undefined

    if (!info.data) return undefined

    if (offset !== undefined && length !== undefined && Number.isInteger(offset) && Number.isInteger(length)) {
      data = info.data.slice(offset, offset + length)
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
  private repairStoredLiveHeader(header?: LiveBlockHeader): LiveBlockHeader | undefined {
    if (!header) return undefined
    const h: LiveBlockHeader = {
      ...header,
      isActive: !!header['isActive'],
      isChainTip: !!header['isChainTip']
    }
    return h
  }

  private prepareStoredLiveHeader(header: LiveBlockHeader, forInsert?: boolean): object {
    const h: object = { ...header }
    if (forInsert) delete h['headerId']

    if (header.isActive) h['isActive'] = 1
    else delete h['isActive']
    if (header.isChainTip) h['isChainTip'] = 1
    else delete h['isChainTip']

    return h
  }

  async insertLiveHeader(header: LiveBlockHeader): Promise<LiveBlockHeader> {
    const trx = this.toDbTrxReadWrite(['live_headers'])
    const store = trx.objectStore('live_headers')

    const h = this.prepareStoredLiveHeader(header, true)

    header.headerId = Number(await store.add(h))

    await trx.done

    return header
  }

  async initDB(): Promise<IDBPDatabase<ChaintracksStorageIdbSchema>> {
    const db = await openDB<ChaintracksStorageIdbSchema>(this.dbName, 1, {
      upgrade(db, oldVersion, newVersion, transaction) {
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
          const bulkHeadersStore = db.createObjectStore('bulk_headers', {
            keyPath: 'fileId',
            autoIncrement: true
          })
        }
      }
    })
    return db
  }

  toDbTrxReadOnly(stores: string[]): IDBPTransaction<ChaintracksStorageIdbSchema, string[], 'readonly'> {
    if (!this.db) throw new Error('not initialized')
    const db = this.db
    const trx = db.transaction(stores || this.allStores, 'readonly')
    this.whenLastAccess = new Date()
    return trx
  }

  toDbTrxReadWrite(stores: string[]): IDBPTransaction<ChaintracksStorageIdbSchema, string[], 'readwrite'> {
    if (!this.db) throw new Error('not initialized')
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
