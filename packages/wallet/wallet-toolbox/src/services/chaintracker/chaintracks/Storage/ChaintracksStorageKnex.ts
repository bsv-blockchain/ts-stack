import { Knex } from 'knex'
import { ChaintracksKnexMigrations } from './ChaintracksKnexMigrations'
import {
  InsertHeaderResult,
  ChaintracksStorageBaseOptions,
  ChaintracksStorageBulkFileApi
} from '../Api/ChaintracksStorageApi'
import { ChaintracksStorageBase } from './ChaintracksStorageBase'
import { LiveBlockHeader } from '../Api/BlockHeaderApi'
import { BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { addWork, convertBitsToWork, isMoreWork } from '../util/blockHeaderUtilities'
import { verifyOneOrNone } from '../../../../utility/utilityHelpers'
import { DBType } from '../../../../storage/StorageReader'
import { BulkHeaderFileInfo } from '../util/BulkHeaderFile'
import { HeightRange } from '../util/HeightRange'
import { Chain } from '../../../../sdk/types'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER, WERR_NOT_IMPLEMENTED } from '../../../../sdk/WERR_errors'
import { determineDBType } from '../../../../storage/schema/KnexMigrations'
import { normalizeBulkHeaderFileInfo, normalizeBulkHeaderFileSequence } from '../util/BulkFileDataManager'

export interface ChaintracksStorageKnexOptions extends ChaintracksStorageBaseOptions {
  /**
   * Required.
   *
   * Knex.js database interface initialized with valid connection configuration.
   */
  knex: Knex | undefined
}

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

function toKnexBulkFileRow(file: BulkHeaderFileInfo): Record<string, unknown> {
  const row = Object.fromEntries(Object.entries(file).filter(([, value]) => value !== undefined))
  if (file.data != null) row.data = Buffer.from(file.data)
  return row
}

/**
 * Implements the ChaintracksStorageApi using Knex.js for both MySql and Sqlite support.
 * Also see `chaintracksStorageMemory` which leverages Knex support for an in memory database.
 */
export class ChaintracksStorageKnex extends ChaintracksStorageBase implements ChaintracksStorageBulkFileApi {
  static createStorageKnexOptions(chain: Chain, knex?: Knex): ChaintracksStorageKnexOptions {
    const options: ChaintracksStorageKnexOptions = {
      ...ChaintracksStorageBase.createStorageBaseOptions(chain),
      knex
    }
    return options
  }

  knex: Knex
  _dbtype?: DBType
  bulkFilesTableName: string = 'bulk_files'
  headerTableName: string = 'live_headers'
  stateTableName: string = 'chaintracks_state'

  constructor(options: ChaintracksStorageKnexOptions) {
    super(options)
    if (options.knex == null) throw new Error('The knex options property is required.')
    this.knex = options.knex
  }

  get dbtype(): DBType {
    if (!this._dbtype) throw new WERR_INVALID_OPERATION('must call makeAvailable first')
    return this._dbtype
  }

  override async shutdown(): Promise<void> {
    try {
      await this.knex.destroy()
    } catch {
      /* ignore */
    }
  }

  override async makeAvailable(): Promise<void> {
    if (this.isAvailable && this.hasMigrated) return
    // Not a base class policy, but we want to ensure migrations are run before getting to business.
    if (!this.hasMigrated) {
      await this.migrateLatest()
    }
    if (!this.isAvailable) {
      this._dbtype = await determineDBType(this.knex)
      // Chaintracks storage supports SQLite and MySQL only.
      if (this._dbtype === 'Postgres')
        throw new WERR_NOT_IMPLEMENTED('ChaintracksStorageKnex does not support Postgres.')
      await super.makeAvailable()
      // Connect the bulk data file manager to the table provided by this storage class.
      await this.bulkManager.setStorage(this, this.log)
    }
  }

  override async migrateLatest(): Promise<void> {
    if (this.hasMigrated) return
    await this.knex.migrate.latest({ migrationSource: new ChaintracksKnexMigrations(this.chain) })
    await super.migrateLatest()
  }

  override async dropAllData(): Promise<void> {
    // Only using migrations to migrate down, don't need valid properties for settings table.
    const config = {
      migrationSource: new ChaintracksKnexMigrations('test')
    }
    const count = Object.keys(config.migrationSource.migrations).length
    for (let i = 0; i < count; i++) {
      if ((await this.knex.migrate.currentVersion(config)) === 'none') break
      const result = await this.knex.migrate.down(config)
      if (result == null) throw new WERR_INVALID_OPERATION('database migration rollback returned no result')
    }
    this.hasMigrated = false
    await super.dropAllData()
  }

  override async destroy(): Promise<void> {
    await this.knex.destroy()
  }

  override async findLiveHeightRange(): Promise<HeightRange> {
    const min = (await this.knex(this.headerTableName).where({ isActive: true }).min('height as v')).pop()?.v
    const max = (await this.knex(this.headerTableName).where({ isActive: true }).max('height as v')).pop()?.v
    if (min == null || max == null) return HeightRange.empty
    const minHeight = Number(min)
    const maxHeight = Number(max)
    this.validateHeight(minHeight, 'stored minimum height')
    this.validateHeight(maxHeight, 'stored maximum height')
    return new HeightRange(minHeight, maxHeight)
  }

  override async findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader> {
    if (!Number.isSafeInteger(headerId) || headerId < 1) {
      throw new WERR_INVALID_PARAMETER('headerId', 'a positive safe integer')
    }
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ headerId })
    if (!header) throw new Error(`HeaderId ${headerId} not found in live header database.`)
    return header
  }

  override async findChainTipHeader(): Promise<LiveBlockHeader> {
    const tips = await this.knex<LiveBlockHeader>(this.headerTableName)
      .where({ isActive: true, isChainTip: true })
      .limit(2)
    if (tips.length > 1) throw new WERR_INVALID_OPERATION('multiple active chain tips exist in the database')
    const [tip] = tips
    if (!tip) throw new Error('Database contains no active chain tip header.')
    return tip
  }

  override async findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined> {
    const tips = await this.knex<LiveBlockHeader>(this.headerTableName)
      .where({ isActive: true, isChainTip: true })
      .limit(2)
    if (tips.length > 1) throw new WERR_INVALID_OPERATION('multiple active chain tips exist in the database')
    return tips[0]
  }

  async findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null> {
    this.validateHeight(height)
    const headers = await this.knex<LiveBlockHeader>(this.headerTableName).where({ height, isActive: true }).limit(2)
    if (headers.length > 1) throw new WERR_INVALID_OPERATION(`multiple active headers exist at height ${height}`)
    return headers[0] || null
  }

  async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null> {
    this.validateHash(hash)
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ hash })
    const result = header || null
    return result
  }

  async findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null> {
    this.validateHash(merkleRoot, 'merkleRoot')
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName)
      .where({ merkleRoot })
      .orderBy('isActive', 'desc')
      .limit(1)
    return header || null
  }

  private async withBulkFileLock<T>(work: (trx: Knex.Transaction) => Promise<T>): Promise<T> {
    return await this.knex.transaction(async trx => {
      const lockQuery = trx(this.stateTableName).where({ stateId: 1 })
      const state = this.dbtype === 'MySQL' ? await lockQuery.forUpdate().first() : await lockQuery.first()
      if (state == null) throw new WERR_INVALID_OPERATION('Chaintracks bulk-file transaction lock row is missing')
      return await work(trx)
    })
  }

  async deleteBulkFile(fileId: number): Promise<number> {
    if (!Number.isSafeInteger(fileId) || fileId < 1) {
      throw new WERR_INVALID_PARAMETER('fileId', 'a positive safe integer')
    }
    return await this.withBulkFileLock(async trx => await trx(this.bulkFilesTableName).where({ fileId }).del())
  }

  async insertBulkFile(file: BulkHeaderFileInfo): Promise<number> {
    const canonical = normalizeBulkHeaderFileInfo(file, true)
    if (canonical.chain !== this.chain) throw new WERR_INVALID_PARAMETER('file.chain', this.chain)
    delete canonical.fileId
    return await this.withBulkFileLock(async trx => {
      const [id] = await trx(this.bulkFilesTableName).insert(toKnexBulkFileRow(canonical))
      const fileId = Number(id)
      if (!Number.isSafeInteger(fileId) || fileId < 1) {
        throw new WERR_INVALID_OPERATION('database returned an invalid bulk-file id')
      }
      return fileId
    })
  }

  async updateBulkFile(fileId: number, file: BulkHeaderFileInfo): Promise<number> {
    if (!Number.isSafeInteger(fileId) || fileId < 1) {
      throw new WERR_INVALID_PARAMETER('fileId', 'a positive safe integer')
    }
    const canonical = normalizeBulkHeaderFileInfo(file, true)
    if (canonical.chain !== this.chain) throw new WERR_INVALID_PARAMETER('file.chain', this.chain)
    if (canonical.fileId !== undefined && canonical.fileId !== fileId) {
      throw new WERR_INVALID_PARAMETER('file.fileId', 'undefined or equal to fileId')
    }
    delete canonical.fileId
    return await this.withBulkFileLock(
      async trx => await trx(this.bulkFilesTableName).where({ fileId }).update(toKnexBulkFileRow(canonical))
    )
  }

  async replaceBulkFiles(files: BulkHeaderFileInfo[]): Promise<BulkHeaderFileInfo[]> {
    const canonical = normalizeBulkHeaderFileSequence(files, true).map(value => {
      if (value.chain !== this.chain) throw new WERR_INVALID_PARAMETER('file.chain', this.chain)
      return value
    })

    return await this.withBulkFileLock(async trx => {
      const currentRows = await trx(this.bulkFilesTableName).select('fileId')
      const currentIds = new Set<number>()
      for (const row of currentRows) {
        const fileId = Number(row.fileId)
        if (!Number.isSafeInteger(fileId) || fileId < 1 || currentIds.has(fileId)) {
          throw new WERR_INVALID_OPERATION('database contains an invalid or duplicate bulk-file id')
        }
        currentIds.add(fileId)
      }

      const retainedIds = new Set<number>()
      const committed: BulkHeaderFileInfo[] = []
      for (const file of canonical) {
        const row = toKnexBulkFileRow(file)
        delete row.fileId
        let fileId = file.fileId
        if (fileId !== undefined) {
          if (!currentIds.has(fileId) || retainedIds.has(fileId)) {
            throw new WERR_INVALID_PARAMETER('file.fileId', 'a unique id belonging to the current bulk-file set')
          }
          const affected = await trx(this.bulkFilesTableName).where({ fileId }).update(row)
          if (affected !== 1) throw new WERR_INVALID_OPERATION(`failed to replace bulk file ${fileId}`)
        } else {
          const [inserted] = await trx(this.bulkFilesTableName).insert(row)
          fileId = Number(inserted)
          if (!Number.isSafeInteger(fileId) || fileId < 1) {
            throw new WERR_INVALID_OPERATION('database returned an invalid bulk-file id')
          }
        }
        retainedIds.add(fileId)
        committed.push({ ...file, fileId })
      }

      const deleteIds = [...currentIds].filter(fileId => !retainedIds.has(fileId))
      if (deleteIds.length > 0) {
        const deleted = await trx(this.bulkFilesTableName).whereIn('fileId', deleteIds).del()
        if (deleted !== deleteIds.length)
          throw new WERR_INVALID_OPERATION('failed to replace the complete bulk-file set')
      }
      return committed
    })
  }

  async getBulkFiles(): Promise<BulkHeaderFileInfo[]> {
    const files = await this.knex<BulkHeaderFileInfo>(this.bulkFilesTableName)
      .select(
        'fileId',
        'chain',
        'fileName',
        'firstHeight',
        'count',
        'prevHash',
        'lastHash',
        'fileHash',
        'prevChainWork',
        'lastChainWork',
        'validated',
        'sourceUrl'
      )
      .orderBy('firstHeight', 'asc')
    return files.map(file => normalizeBulkHeaderFileInfo(file, true))
  }

  async getBulkFileData(fileId: number, offset?: number, length?: number): Promise<Uint8Array | undefined> {
    await this.makeAvailable()
    if (!Number.isSafeInteger(fileId) || fileId < 1) {
      throw new WERR_INVALID_PARAMETER('fileId', 'a positive safe-integer bulk_files fileId')
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
    let data: Uint8Array | undefined
    if (hasOffset) {
      const sql = this.dbtype === 'MySQL' ? 'substring(?? from ? for ?)' : 'substr(??, ?, ?)'
      const slice = this.knex.raw(sql, ['data', offset! + 1, length!])
      const r = verifyOneOrNone(await this.knex(this.bulkFilesTableName).select({ data: slice }).where({ fileId })) as
        { data: Buffer | null } | undefined
      if (r?.data != null) {
        data = Uint8Array.from(r.data)
      }
    } else {
      const r = verifyOneOrNone(await this.knex(this.bulkFilesTableName).where({ fileId }).select('data'))
      if (r?.data) data = Uint8Array.from(r.data)
    }
    return data
  }

  /**
   * @param header Header to attempt to add to live storage.
   * @returns details of conditions found attempting to insert header
   */
  private async insertFirstHeader(
    trx: Knex.Transaction,
    table: string,
    header: BlockHeader,
    result: InsertHeaderResult
  ): Promise<boolean> {
    const countRows = await trx(table).count()
    if (Number(countRows[0]['count(*)']) !== 0) return false
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
    await trx<LiveBlockHeader>(table).insert({
      ...header,
      previousHeaderId: null,
      chainWork: addWork(lastBulkFile.lastChainWork, convertBitsToWork(header.bits)),
      isChainTip: true,
      isActive: true
    })
    result.isActiveTip = true
    result.added = true
    return true
  }

  private async findActiveAncestor(
    trx: Knex.Transaction,
    table: string,
    oneBack: LiveBlockHeader,
    result: InsertHeaderResult
  ): Promise<LiveBlockHeader | undefined> {
    let activeAncestor = oneBack
    const visited = new Set<number>()
    while (!activeAncestor.isActive) {
      this.recordTraversalVisit(visited, activeAncestor, 'finding the active ancestor')
      if (activeAncestor.previousHeaderId == null) {
        result.noActiveAncestor = true
        return undefined
      }
      const [previousHeader] = await trx<LiveBlockHeader>(table).where({
        headerId: activeAncestor.previousHeaderId
      })
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
    trx: Knex.Transaction,
    table: string,
    oneBack: LiveBlockHeader,
    activeAncestor: LiveBlockHeader,
    result: InsertHeaderResult
  ): Promise<void> {
    if (activeAncestor.headerId === oneBack.headerId) return
    const activeTips = await trx<LiveBlockHeader>(table).where({ isChainTip: true, isActive: true }).limit(2)
    if (activeTips.length !== 1) {
      throw new WERR_INVALID_OPERATION(`expected one active chain tip, found ${activeTips.length}`)
    }
    let headerToDeactivate = activeTips[0]
    const deactivated = new Set<number>()
    while (headerToDeactivate.headerId !== activeAncestor.headerId) {
      this.recordTraversalVisit(deactivated, headerToDeactivate, 'deactivating the prior active chain')
      result.deactivatedHeaders.push(headerToDeactivate)
      await trx<LiveBlockHeader>(table).where({ headerId: headerToDeactivate.headerId }).update({ isActive: false })
      if (headerToDeactivate.previousHeaderId == null) {
        throw new WERR_INVALID_OPERATION('active chain does not reach the selected reorganization ancestor')
      }
      const [previousHeader] = await trx<LiveBlockHeader>(table).where({
        headerId: headerToDeactivate.previousHeaderId
      })
      if (previousHeader == null) throw new WERR_INVALID_OPERATION('active chain contains a missing parent header')
      this.validateStoredParentLink(headerToDeactivate, previousHeader)
      headerToDeactivate = previousHeader
    }
    let headerToActivate = oneBack
    const activated = new Set<number>()
    while (headerToActivate.headerId !== activeAncestor.headerId) {
      this.recordTraversalVisit(activated, headerToActivate, 'activating the replacement chain')
      await trx<LiveBlockHeader>(table).where({ headerId: headerToActivate.headerId }).update({ isActive: true })
      if (headerToActivate.previousHeaderId == null) {
        throw new WERR_INVALID_OPERATION('replacement chain does not reach the selected reorganization ancestor')
      }
      const [previousHeader] = await trx<LiveBlockHeader>(table).where({
        headerId: headerToActivate.previousHeaderId
      })
      if (previousHeader == null) throw new WERR_INVALID_OPERATION('replacement chain contains a missing parent header')
      this.validateStoredParentLink(headerToActivate, previousHeader)
      headerToActivate = previousHeader
    }
  }

  private async prepareActiveTip(
    trx: Knex.Transaction,
    table: string,
    header: BlockHeader,
    oneBack: LiveBlockHeader,
    result: InsertHeaderResult
  ): Promise<boolean> {
    if (!result.isActiveTip) return true
    const activeAncestor = await this.findActiveAncestor(trx, table, oneBack, result)
    if (activeAncestor == null) return false
    if (!(oneBack.isActive && oneBack.isChainTip)) {
      result.reorgDepth = Math.min(result.priorTip!.height, header.height) - activeAncestor.height
    }
    await this.applyReorganization(trx, table, oneBack, activeAncestor, result)
    return true
  }

  private async insertHeaderWithinTransaction(
    trx: Knex.Transaction,
    table: string,
    header: BlockHeader,
    result: InsertHeaderResult
  ): Promise<void> {
    const [dupeCheck] = await trx(table).where({ hash: header.hash }).count()
    if (dupeCheck['count(*)']) {
      result.dupe = true
      return
    }
    const [oneBack] = await trx<LiveBlockHeader>(table).where({
      hash: header.previousHash
    })
    if (oneBack == null) {
      if (await this.insertFirstHeader(trx, table, header, result)) return
      result.noPrev = true
      return
    }
    if (oneBack.height + 1 != header.height) {
      result.badPrev = true
      return
    }
    if (oneBack.isActive && oneBack.isChainTip) {
      result.priorTip = oneBack
    } else {
      const activeTips = await trx<LiveBlockHeader>(table)
        .where({
          isActive: true,
          isChainTip: true
        })
        .limit(2)
      if (activeTips.length > 1) {
        throw new WERR_INVALID_OPERATION('multiple active chain tips exist in the database')
      }
      ;[result.priorTip] = activeTips
    }
    if (result.priorTip == null) {
      result.noTip = true
      return
    }
    const chainWork = addWork(oneBack.chainWork, convertBitsToWork(header.bits))
    result.isActiveTip = isMoreWork(chainWork, result.priorTip.chainWork)
    const newHeader = {
      ...header,
      previousHeaderId: oneBack.headerId,
      chainWork,
      isChainTip: result.isActiveTip,
      isActive: result.isActiveTip
    }
    if (!(await this.prepareActiveTip(trx, table, header, oneBack, result))) {
      return
    }
    if (oneBack.isChainTip) {
      await trx<LiveBlockHeader>(table).where({ headerId: oneBack.headerId }).update({ isChainTip: false })
    }
    await trx<LiveBlockHeader>(table).insert(newHeader)
    result.added = true
  }

  async insertHeader(header: BlockHeader): Promise<InsertHeaderResult> {
    header = this.validateIncomingHeader(header)
    await this.makeAvailable()
    const table = this.headerTableName
    const r = createInsertHeaderResult()
    await this.knex.transaction(async trx => {
      const lockQuery = trx(this.stateTableName).where({ stateId: 1 })
      const state = this.dbtype === 'MySQL' ? await lockQuery.forUpdate().first() : await lockQuery.first()
      if (state == null) throw new WERR_INVALID_OPERATION('Chaintracks insertion lock row is missing')
      await this.insertHeaderWithinTransaction(trx, table, header, r)
    })

    if (r.added && r.isActiveTip) await this.pruneLiveBlockHeaders(header.height)

    return r
  }

  async findMaxHeaderId(): Promise<number> {
    const value = (await this.knex(this.headerTableName).max('headerId as v')).pop()?.v
    if (value == null) return -1
    const headerId = Number(value)
    if (!Number.isSafeInteger(headerId) || headerId < 1) {
      throw new WERR_INVALID_OPERATION('database contains an invalid maximum headerId')
    }
    return headerId
  }

  override async deleteLiveBlockHeaders(): Promise<void> {
    const table = this.headerTableName
    await this.knex.transaction(async trx => {
      await trx<LiveBlockHeader>(table).update({ previousHeaderId: null })
      await trx<LiveBlockHeader>(table).del()
    })
  }

  override async deleteBulkBlockHeaders(): Promise<void> {
    const table = this.bulkFilesTableName
    await this.withBulkFileLock(async trx => {
      await trx<BulkHeaderFileInfo>(table).del()
    })
  }

  async deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number> {
    this.validateHeight(maxHeight, 'maxHeight')
    return await this.knex.transaction(async trx => {
      const tableName = this.headerTableName
      await trx(tableName)
        .whereIn('previousHeaderId', function () {
          this.select('headerId').from(tableName).where('height', '<=', maxHeight)
        })
        .update({ previousHeaderId: null })

      const deleted = await trx(tableName).where('height', '<=', maxHeight).del()
      return Number(deleted ?? 0)
    })
  }

  async getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]> {
    this.validateRange(range)
    if (range.isEmpty) return []
    const headers = await this.knex<LiveBlockHeader>(this.headerTableName)
      .where({ isActive: true })
      .andWhere('height', '>=', range.minHeight)
      .andWhere('height', '<=', range.maxHeight)
      .orderBy('height')
    return headers
  }

  concatSerializedHeaders(bufs: number[][]): number[] {
    const r: number[] = [bufs.length * 80]
    for (const bh of bufs) {
      for (const b of bh) {
        r.push(b)
      }
    }
    return r
  }

  async liveHeadersForBulk(count: number): Promise<LiveBlockHeader[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100_000) {
      throw new WERR_INVALID_PARAMETER('count', 'an integer from 1 through 100000')
    }
    const headers = await this.knex<LiveBlockHeader>(this.headerTableName)
      .where({ isActive: true })
      .limit(count)
      .orderBy('height')
    return headers
  }
}
