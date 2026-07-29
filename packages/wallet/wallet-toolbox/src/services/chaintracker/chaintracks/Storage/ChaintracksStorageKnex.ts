import { Knex } from 'knex'
import { ChaintracksKnexMigrations } from './ChaintracksKnexMigrations'
import { InsertHeaderResult, ChaintracksStorageBaseOptions, ChaintracksStorageBulkFileApi } from '../Api/ChaintracksStorageApi'
import { ChaintracksStorageBase } from './ChaintracksStorageBase'
import { LiveBlockHeader } from '../Api/BlockHeaderApi'
import { BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { addWork, convertBitsToWork, isMoreWork } from '../util/blockHeaderUtilities'
import { verifyOneOrNone } from '../../../../utility/utilityHelpers'
import { DBType } from '../../../../storage/StorageReader'
import { BulkHeaderFileInfo } from '../util/BulkHeaderFile'
import { HeightRange } from '../util/HeightRange'
import { Chain } from '../../../../sdk/types'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../../sdk/WERR_errors'
import { determineDBType } from '../../../../storage/schema/KnexMigrations'

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

/**
 * Implements the ChaintracksStorageApi using Knex.js for both MySql and Sqlite support.
 * Also see `chaintracksStorageMemory` which leverages Knex support for an in memory database.
 */
export class ChaintracksStorageKnex extends ChaintracksStorageBase implements ChaintracksStorageBulkFileApi {
  static createStorageKnexOptions (chain: Chain, knex?: Knex): ChaintracksStorageKnexOptions {
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

  constructor (options: ChaintracksStorageKnexOptions) {
    super(options)
    if (options.knex == null) throw new Error('The knex options property is required.')
    this.knex = options.knex
  }

  get dbtype (): DBType {
    if (!this._dbtype) throw new WERR_INVALID_OPERATION('must call makeAvailable first')
    return this._dbtype
  }

  override async shutdown (): Promise<void> {
    try {
      await this.knex.destroy()
    } catch {
      /* ignore */
    }
  }

  override async makeAvailable (): Promise<void> {
    if (this.isAvailable && this.hasMigrated) return
    // Not a base class policy, but we want to ensure migrations are run before getting to business.
    if (!this.hasMigrated) {
      await this.migrateLatest()
    }
    if (!this.isAvailable) {
      this._dbtype = await determineDBType(this.knex)
      await super.makeAvailable()
      // Connect the bulk data file manager to the table provided by this storage class.
      await this.bulkManager.setStorage(this, this.log)
    }
  }

  override async migrateLatest (): Promise<void> {
    if (this.hasMigrated) return
    await this.knex.migrate.latest({ migrationSource: new ChaintracksKnexMigrations(this.chain) })
    await super.migrateLatest()
  }

  override async dropAllData (): Promise<void> {
    // Only using migrations to migrate down, don't need valid properties for settings table.
    const config = {
      migrationSource: new ChaintracksKnexMigrations('test')
    }
    const count = Object.keys(config.migrationSource.migrations).length
    for (let i = 0; i < count; i++) {
      try {
        const r = await this.knex.migrate.down(config)
        if (!r) {
          console.error('Migration returned falsy result await this.knex.migrate.down(config)')
          break
        }
      } catch (migrationError: unknown) {
        // migrate.down throws when there are no more migrations to roll back — this is
        // the expected terminal condition, so we stop iterating rather than propagating.
        console.debug('migrate.down stopped (no more migrations or error):', migrationError)
        break
      }
    }
    this.hasMigrated = false
    await super.dropAllData()
  }

  override async destroy (): Promise<void> {
    await this.knex.destroy()
  }

  override async findLiveHeightRange (): Promise<HeightRange> {
    return new HeightRange(
      ((await this.knex(this.headerTableName).where({ isActive: true }).min('height as v')).pop()?.v as number) || 0,
      ((await this.knex(this.headerTableName).where({ isActive: true }).max('height as v')).pop()?.v as number) || -1
    )
  }

  override async findLiveHeaderForHeaderId (headerId: number): Promise<LiveBlockHeader> {
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ headerId })
    if (!header) throw new Error(`HeaderId ${headerId} not found in live header database.`)
    return header
  }

  override async findChainTipHeader (): Promise<LiveBlockHeader> {
    const [tip] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ isActive: true, isChainTip: true })
    if (!tip) throw new Error('Database contains no active chain tip header.')
    return tip
  }

  override async findChainTipHeaderOrUndefined (): Promise<LiveBlockHeader | undefined> {
    const [tip] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ isActive: true, isChainTip: true })
    return tip
  }

  async findLiveHeaderForHeight (height: number): Promise<LiveBlockHeader | null> {
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ height, isActive: true })
    return header || null
  }

  async findLiveHeaderForBlockHash (hash: string): Promise<LiveBlockHeader | null> {
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ hash })
    const result = header || null
    return result
  }

  async findLiveHeaderForMerkleRoot (merkleRoot: string): Promise<LiveBlockHeader | null> {
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ merkleRoot })
    return header
  }

  async deleteBulkFile (fileId: number): Promise<number> {
    const count = await this.knex(this.bulkFilesTableName).where({ fileId }).del()
    return count
  }

  async insertBulkFile (file: BulkHeaderFileInfo): Promise<number> {
    if (!file.fileId) delete file.fileId
    const [id] = await this.knex(this.bulkFilesTableName).insert(file)
    file.fileId = id
    return id
  }

  async updateBulkFile (fileId: number, file: BulkHeaderFileInfo): Promise<number> {
    const n = await this.knex(this.bulkFilesTableName).where({ fileId }).update(file)
    return n
  }

  async getBulkFiles (): Promise<BulkHeaderFileInfo[]> {
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
    return files
  }

  dbTypeSubstring (source: string, fromOffset: number, forLength?: number) {
    if (this.dbtype === 'MySQL') return `substring(${source} from ${fromOffset} for ${forLength!})`
    return `substr(${source}, ${fromOffset}, ${forLength})`
  }

  async getBulkFileData (fileId: number, offset?: number, length?: number): Promise<Uint8Array | undefined> {
    await this.makeAvailable()
    if (!Number.isInteger(fileId)) throw new WERR_INVALID_PARAMETER('fileId', 'a valid, integer bulk_files fileId')
    let data: Uint8Array | undefined
    if (Number.isInteger(offset) && Number.isInteger(length)) {
      let rs: Array<{ data: Buffer | null }> = await this.knex.raw(
        `select ${this.dbTypeSubstring('data', offset! + 1, length)} as data from ${this.bulkFilesTableName} where fileId = '${fileId}'`
      )
      if (this.dbtype === 'MySQL') rs = (rs as unknown as Array<Array<{ data: Buffer | null }>>)[0]
      const r = verifyOneOrNone(rs)
      if (r?.data != null) {
        data = Uint8Array.from(r.data)
      }
    } else {
      const r = verifyOneOrNone(await this.knex(this.bulkFilesTableName).where({ fileId }).select('data'))
      if (r.data) data = Uint8Array.from(r.data)
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
      throw new WERR_INVALID_OPERATION(
        'bulk headers must exist before first live header can be added'
      )
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
      chainWork: addWork(
        lastBulkFile.lastChainWork,
        convertBitsToWork(header.bits)
      ),
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
    while (!activeAncestor.isActive) {
      const [previousHeader] = await trx<LiveBlockHeader>(table).where({
        headerId: activeAncestor.previousHeaderId || -1
      })
      if (previousHeader == null) {
        result.noActiveAncestor = true
        return undefined
      }
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
    let [headerToDeactivate] = await trx<LiveBlockHeader>(table).where({
      isChainTip: true,
      isActive: true
    })
    while (headerToDeactivate.headerId !== activeAncestor.headerId) {
      result.deactivatedHeaders.push(headerToDeactivate)
      await trx<LiveBlockHeader>(table)
        .where({ headerId: headerToDeactivate.headerId })
        .update({ isActive: false })
      ;[headerToDeactivate] = await trx<LiveBlockHeader>(table).where({
        headerId: headerToDeactivate.previousHeaderId || -1
      })
    }
    let headerToActivate = oneBack
    while (headerToActivate.headerId !== activeAncestor.headerId) {
      await trx<LiveBlockHeader>(table)
        .where({ headerId: headerToActivate.headerId })
        .update({ isActive: true })
      ;[headerToActivate] = await trx<LiveBlockHeader>(table).where({
        headerId: headerToActivate.previousHeaderId || -1
      })
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
    const activeAncestor = await this.findActiveAncestor(
      trx,
      table,
      oneBack,
      result
    )
    if (activeAncestor == null) return false
    if (!(oneBack.isActive && oneBack.isChainTip)) {
      result.reorgDepth =
        Math.min(result.priorTip!.height, header.height) - activeAncestor.height
    }
    await this.applyReorganization(
      trx,
      table,
      oneBack,
      activeAncestor,
      result
    )
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
      ;[result.priorTip] = await trx<LiveBlockHeader>(table).where({
        isActive: true,
        isChainTip: true
      })
    }
    if (result.priorTip == null) {
      result.noTip = true
      return
    }
    const chainWork = addWork(
      oneBack.chainWork,
      convertBitsToWork(header.bits)
    )
    result.isActiveTip = isMoreWork(chainWork, result.priorTip.chainWork)
    const newHeader = {
      ...header,
      previousHeaderId: oneBack.headerId,
      chainWork,
      isChainTip: result.isActiveTip,
      isActive: result.isActiveTip
    }
    if (
      !(await this.prepareActiveTip(trx, table, header, oneBack, result))
    ) {
      return
    }
    if (oneBack.isChainTip) {
      await trx<LiveBlockHeader>(table)
        .where({ headerId: oneBack.headerId })
        .update({ isChainTip: false })
    }
    await trx<LiveBlockHeader>(table).insert(newHeader)
    result.added = true
  }

  async insertHeader (header: BlockHeader): Promise<InsertHeaderResult> {
    const table = this.headerTableName
    const r = createInsertHeaderResult()
    await this.knex.transaction(async trx =>
      this.insertHeaderWithinTransaction(trx, table, header, r)
    )

    if (r.added && r.isActiveTip) this.pruneLiveBlockHeaders(header.height)

    return r
  }

  async findMaxHeaderId (): Promise<number> {
    return ((await this.knex(this.headerTableName).max('headerId as v')).pop()?.v as number) || -1
  }

  override async deleteLiveBlockHeaders (): Promise<void> {
    const table = this.headerTableName
    await this.knex.transaction(async trx => {
      await trx<LiveBlockHeader>(table).update({ previousHeaderId: null })
      await trx<LiveBlockHeader>(table).del()
    })
  }

  override async deleteBulkBlockHeaders (): Promise<void> {
    const table = this.bulkFilesTableName
    await this.knex.transaction(async trx => {
      await trx<BulkHeaderFileInfo>(table).del()
    })
  }

  async deleteOlderLiveBlockHeaders (maxHeight: number): Promise<number> {
    return await this.knex.transaction(async trx => {
      try {
        const tableName = this.headerTableName
        await trx(tableName)
          .whereIn('previousHeaderId', function () {
            this.select('headerId').from(tableName).where('height', '<=', maxHeight)
          })
          .update({ previousHeaderId: null })

        const deletedCount = await trx(tableName).where('height', '<=', maxHeight).del()

        // Commit transaction
        await trx.commit()
        return deletedCount
      } catch (error) {
        // Rollback on error
        await trx.rollback()
        throw error
      }
    })
  }

  async getLiveHeaders (range: HeightRange): Promise<LiveBlockHeader[]> {
    const headers = await this.knex<LiveBlockHeader>(this.headerTableName)
      .where({ isActive: true })
      .andWhere('height', '>=', range.minHeight)
      .andWhere('height', '<=', range.maxHeight)
      .orderBy('height')
    return headers
  }

  concatSerializedHeaders (bufs: number[][]): number[] {
    const r: number[] = [bufs.length * 80]
    for (const bh of bufs) {
      for (const b of bh) {
        r.push(b)
      }
    }
    return r
  }

  async liveHeadersForBulk (count: number): Promise<LiveBlockHeader[]> {
    const headers = await this.knex<LiveBlockHeader>(this.headerTableName)
      .where({ isActive: true })
      .limit(count)
      .orderBy('height')
    return headers
  }
}
