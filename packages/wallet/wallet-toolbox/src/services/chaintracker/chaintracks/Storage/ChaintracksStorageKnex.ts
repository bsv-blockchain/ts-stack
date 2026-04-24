import { Knex } from 'knex'
import { ChaintracksKnexMigrations } from './ChaintracksKnexMigrations'
import { InsertHeaderResult, ChaintracksStorageBaseOptions } from '../Api/ChaintracksStorageApi'
import { ChaintracksStorageBase } from './ChaintracksStorageBase'
import { LiveBlockHeader } from '../Api/BlockHeaderApi'
import { BlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { addWork, convertBitsToWork, isMoreWork } from '../util/blockHeaderUtilities'
import { verifyOneOrNone } from '../../../../utility/utilityHelpers'
import { DBType } from '../../../../storage/StorageReader'
import { BulkHeaderFileInfo } from '../util/BulkHeaderFile'
import { HeightRange } from '../util/HeightRange'
import { ChaintracksStorageBulkFileApi } from '../Api/ChaintracksStorageApi'
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
  headerTableName: string = `live_headers`

  constructor(options: ChaintracksStorageKnexOptions) {
    super(options)
    if (!options.knex) throw new Error('The knex options property is required.')
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
      try {
        const r = await this.knex.migrate.down(config)
        if (!r) {
          console.error(`Migration returned falsy result await this.knex.migrate.down(config)`)
          break
        }
      } catch (eu: unknown) {
        break
      }
    }
    this.hasMigrated = false
    await super.dropAllData()
  }

  override async destroy(): Promise<void> {
    await this.knex.destroy()
  }

  override async findLiveHeightRange(): Promise<HeightRange> {
    return new HeightRange(
      ((await this.knex(this.headerTableName).where({ isActive: true }).min('height as v')).pop()?.v as number) || 0,
      ((await this.knex(this.headerTableName).where({ isActive: true }).max('height as v')).pop()?.v as number) || -1
    )
  }

  override async findLiveHeaderForHeaderId(headerId: number): Promise<LiveBlockHeader> {
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ headerId: headerId })
    if (!header) throw new Error(`HeaderId ${headerId} not found in live header database.`)
    return header
  }

  override async findChainTipHeader(): Promise<LiveBlockHeader> {
    const [tip] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ isActive: true, isChainTip: true })
    if (!tip) throw new Error('Database contains no active chain tip header.')
    return tip
  }

  override async findChainTipHeaderOrUndefined(): Promise<LiveBlockHeader | undefined> {
    const [tip] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ isActive: true, isChainTip: true })
    return tip
  }

  async findLiveHeaderForHeight(height: number): Promise<LiveBlockHeader | null> {
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ height: height, isActive: true })
    return header ? header : null
  }

  async findLiveHeaderForBlockHash(hash: string): Promise<LiveBlockHeader | null> {
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ hash: hash })
    const result = header ? header : null
    return result
  }

  async findLiveHeaderForMerkleRoot(merkleRoot: string): Promise<LiveBlockHeader | null> {
    const [header] = await this.knex<LiveBlockHeader>(this.headerTableName).where({ merkleRoot: merkleRoot })
    return header
  }

  async deleteBulkFile(fileId: number): Promise<number> {
    const count = await this.knex(this.bulkFilesTableName).where({ fileId: fileId }).del()
    return count
  }

  async insertBulkFile(file: BulkHeaderFileInfo): Promise<number> {
    if (!file.fileId) delete file.fileId
    const [id] = await this.knex(this.bulkFilesTableName).insert(file)
    file.fileId = id
    return id
  }
  async updateBulkFile(fileId: number, file: BulkHeaderFileInfo): Promise<number> {
    const n = await this.knex(this.bulkFilesTableName).where({ fileId: fileId }).update(file)
    return n
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
    return files
  }

  dbTypeSubstring(source: string, fromOffset: number, forLength?: number) {
    if (this.dbtype === 'MySQL') return `substring(${source} from ${fromOffset} for ${forLength!})`
    return `substr(${source}, ${fromOffset}, ${forLength})`
  }

  async getBulkFileData(fileId: number, offset?: number, length?: number): Promise<Uint8Array | undefined> {
    await this.makeAvailable()
    if (!Number.isInteger(fileId)) throw new WERR_INVALID_PARAMETER('fileId', 'a valid, integer bulk_files fileId')
    let data: Uint8Array | undefined = undefined
    if (Number.isInteger(offset) && Number.isInteger(length)) {
      let rs: { data: Buffer | null }[] = await this.knex.raw(
        `select ${this.dbTypeSubstring('data', offset! + 1, length)} as data from ${this.bulkFilesTableName} where fileId = '${fileId}'`
      )
      if (this.dbtype === 'MySQL') rs = (rs as unknown as { data: Buffer | null }[][])[0]
      const r = verifyOneOrNone(rs)
      if (r && r.data) {
        data = Uint8Array.from(r.data)
      }
    } else {
      const r = verifyOneOrNone(await this.knex(this.bulkFilesTableName).where({ fileId: fileId }).select('data'))
      if (r.data) data = Uint8Array.from(r.data)
    }
    return data
  }

  /**
   * @param header Header to attempt to add to live storage.
   * @returns details of conditions found attempting to insert header
   */
  async insertHeader(header: BlockHeader): Promise<InsertHeaderResult> {
    const table = this.headerTableName

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

    await this.knex.transaction(async trx => {
      /*
              We ensure the header does not already exist. This needs to be done
              inside the transaction to avoid inserting multiple headers. If an
              identical header is found, there is no need to insert a new header.
            */
      const [dupeCheck] = await trx(table).where({ hash: header.hash }).count()
      if (dupeCheck['count(*)']) {
        r.dupe = true
        return
      }

      // This is the existing previous header to the one being inserted...
      let [oneBack] = await trx<LiveBlockHeader>(table).where({ hash: header.previousHash })

      if (!oneBack) {
        // Check if this is first live header...
        const cr = await trx(table).count()
        const count = Number(cr[0]['count(*)'])
        if (count === 0) {
          // If this is the first live header, the last bulk header (if there is one) is the previous header.
          const lbf = await this.bulkManager.getLastFile()
          if (!lbf) throw new WERR_INVALID_OPERATION('bulk headers must exist before first live header can be added')
          if (header.previousHash === lbf.lastHash && header.height === lbf.firstHeight + lbf.count) {
            // Valid first live header. Add it.
            const chainWork = addWork(lbf.lastChainWork, convertBitsToWork(header.bits))
            r.isActiveTip = true
            const newHeader = {
              ...header,
              previousHeaderId: null,
              chainWork,
              isChainTip: r.isActiveTip,
              isActive: r.isActiveTip
            }
            // Success
            await trx<LiveBlockHeader>(table).insert(newHeader)
            r.added = true
            return
          }
        }
        // Failure without a oneBack
        // First live header that does not follow last bulk header or
        // Not the first live header and live headers doesn't include a previousHash header.
        r.noPrev = true
        return
      }

      // This header's previousHash matches an existing live header's hash, if height isn't +1, reject it.
      if (oneBack.height + 1 != header.height) {
        r.badPrev = true
        return
      }

      if (oneBack.isActive && oneBack.isChainTip) {
        r.priorTip = oneBack
      } else {
        ;[r.priorTip] = await trx<LiveBlockHeader>(table).where({ isActive: true, isChainTip: true })
      }

      if (!r.priorTip) {
        // No active chain tip found. This is a logic error in state of live headers.
        r.noTip = true
        return
      }

      // We have an acceptable new live header...and live headers has an active chain tip.

      const chainWork = addWork(oneBack.chainWork, convertBitsToWork(header.bits))

      r.isActiveTip = isMoreWork(chainWork, r.priorTip.chainWork)

      const newHeader = {
        ...header,
        previousHeaderId: oneBack.headerId,
        chainWork,
        isChainTip: r.isActiveTip,
        isActive: r.isActiveTip
      }

      if (r.isActiveTip) {
        // Find newHeader's first active ancestor
        let activeAncestor = oneBack
        while (!activeAncestor.isActive) {
          const [previousHeader] = await trx<LiveBlockHeader>(table).where({
            headerId: activeAncestor.previousHeaderId || -1
          })
          if (!previousHeader) {
            // live headers doesn't contain an active ancestor. This is a live header's logic error.
            r.noActiveAncestor = true
            return
          }
          activeAncestor = previousHeader
        }

        if (!(oneBack.isActive && oneBack.isChainTip))
          // If this is the new active chain tip, and oneBack was not, this is a reorg.
          r.reorgDepth = Math.min(r.priorTip.height, header.height) - activeAncestor.height

        if (activeAncestor.headerId !== oneBack.headerId) {
          // Deactivate headers from the current active chain tip up to but excluding our activeAncestor:
          let [headerToDeactivate] = await trx<LiveBlockHeader>(table).where({ isChainTip: true, isActive: true })
          while (headerToDeactivate.headerId !== activeAncestor.headerId) {
            // Headers are deactivated until we reach the activeAncestor
            r.deactivatedHeaders.push(headerToDeactivate)
            await trx<LiveBlockHeader>(table)
              .where({ headerId: headerToDeactivate.headerId })
              .update({ isActive: false })
            const [previousHeader] = await trx<LiveBlockHeader>(table).where({
              headerId: headerToDeactivate.previousHeaderId || -1
            })
            headerToDeactivate = previousHeader
          }

          // The first header to activate is one before the one we are about to insert
          let headerToActivate = oneBack
          while (headerToActivate.headerId !== activeAncestor.headerId) {
            // Headers are activated until we reach the active ancestor
            await trx<LiveBlockHeader>(table).where({ headerId: headerToActivate.headerId }).update({ isActive: true })
            const [previousHeader] = await trx<LiveBlockHeader>(table).where({
              headerId: headerToActivate.previousHeaderId || -1
            })
            headerToActivate = previousHeader
          }
        }
      }

      if (oneBack.isChainTip) {
        // Deactivate the old chain tip
        await trx<LiveBlockHeader>(table).where({ headerId: oneBack.headerId }).update({ isChainTip: false })
      }

      await trx<LiveBlockHeader>(table).insert(newHeader)
      r.added = true
    })

    if (r.added && r.isActiveTip) this.pruneLiveBlockHeaders(header.height)

    return r
  }

  async findMaxHeaderId(): Promise<number> {
    return ((await this.knex(this.headerTableName).max('headerId as v')).pop()?.v as number) || -1
    //const [resultrow] = await this.knex(this.headerTableName).max('headerId as maxHeaderId')
    //return resultrow?.maxHeaderId || 0
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
    await this.knex.transaction(async trx => {
      await trx<BulkHeaderFileInfo>(table).del()
    })
  }

  async deleteOlderLiveBlockHeaders(maxHeight: number): Promise<number> {
    return this.knex.transaction(async trx => {
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

  async getLiveHeaders(range: HeightRange): Promise<LiveBlockHeader[]> {
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
    const headers = await this.knex<LiveBlockHeader>(this.headerTableName)
      .where({ isActive: true })
      .limit(count)
      .orderBy('height')
    return headers
  }
}
