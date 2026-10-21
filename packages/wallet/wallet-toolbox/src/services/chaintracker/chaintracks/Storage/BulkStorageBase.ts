// /* eslint-disable @typescript-eslint/no-empty-function */
/* eslint-disable @typescript-eslint/no-unused-vars */
import { BulkStorageApi, BulkStorageBaseOptions } from '../Api/BulkStorageApi'

import { ChaintracksStorageBase } from './ChaintracksStorageBase'

import { HeightRange } from '../util/HeightRange'
import { BulkHeaderFileInfo, BulkHeaderFilesInfo } from '../util/BulkHeaderFile'
import { Chain } from '../../../../sdk/types'
import { BlockHeader } from '../Api/BlockHeaderApi'

import { ChaintracksFsApi } from '../Api/ChaintracksFsApi'
import { asArray, asString, asUint8Array } from '../../../../utility/utilityHelpers.noBuffer'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { validateBufferOfHeaders, validateGenesisHeader } from '../util/blockHeaderUtilities'
import { WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../../sdk'

const SUPPORTED_CHAINS = new Set<Chain>(['main', 'test', 'stn', 'ttn', 'tstn', 'regtest', 'mock'])
const SAFE_EXPORT_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]*\.json$/

export abstract class BulkStorageBase implements BulkStorageApi {
  static createBulkStorageBaseOptions(chain: Chain, fs: ChaintracksFsApi): BulkStorageBaseOptions {
    const options: BulkStorageBaseOptions = {
      chain,
      fs
    }
    return options
  }

  chain: Chain
  fs: ChaintracksFsApi
  log: (...args: any[]) => void = () => {}

  constructor(options: BulkStorageBaseOptions) {
    if (options == null || typeof options !== 'object') {
      throw new WERR_INVALID_PARAMETER('options', 'BulkStorageBaseOptions')
    }
    if (!SUPPORTED_CHAINS.has(options.chain)) throw new WERR_INVALID_PARAMETER('chain', 'a supported network')
    if (options.fs == null || typeof options.fs !== 'object') {
      throw new WERR_INVALID_PARAMETER('fs', 'a ChaintracksFsApi implementation')
    }
    this.chain = options.chain
    this.fs = options.fs
  }

  async shutdown(): Promise<void> {
    /* intentional no-op: subclasses override when needed */
  }

  abstract appendHeaders(minHeight: number, count: number, newBulkHeaders: Uint8Array): Promise<void>
  abstract getMaxHeight(): Promise<number>
  abstract headersToBuffer(height: number, count: number): Promise<Uint8Array>
  abstract findHeaderForHeightOrUndefined(height: number): Promise<BlockHeader | undefined>

  async findHeaderForHeight(height: number): Promise<BlockHeader> {
    if (!Number.isSafeInteger(height) || height < 0 || height > 0x7fffffff) {
      throw new WERR_INVALID_PARAMETER('height', 'an integer from 0 through 2147483647')
    }
    const header = await this.findHeaderForHeightOrUndefined(height)
    if (header == null) throw new Error(`No header found for height ${height}`)
    return header
  }

  async getHeightRange(): Promise<HeightRange> {
    const maxHeight = await this.getMaxHeight()
    if (!Number.isSafeInteger(maxHeight) || maxHeight < -1 || maxHeight > 0x7fffffff) {
      throw new WERR_INVALID_OPERATION('bulk storage returned an invalid maximum height')
    }
    return new HeightRange(0, maxHeight)
  }

  async setStorage(storage: ChaintracksStorageBase, log: (...args: any[]) => void): Promise<void> {
    /* intentional no-op: subclasses override when needed */
  }

  async exportBulkHeaders(rootFolder: string, jsonFilename: string, maxPerFile: number): Promise<void> {
    if (typeof rootFolder !== 'string' || rootFolder.length === 0 || rootFolder.length > 4096) {
      throw new WERR_INVALID_PARAMETER('rootFolder', 'a non-empty path no longer than 4096 characters')
    }
    if (
      typeof jsonFilename !== 'string' ||
      jsonFilename.length > 255 ||
      !SAFE_EXPORT_FILE_NAME.test(jsonFilename) ||
      jsonFilename === '.json' ||
      jsonFilename === '..json'
    ) {
      throw new WERR_INVALID_PARAMETER('jsonFilename', 'a safe path-free ASCII .json file name')
    }
    if (!Number.isSafeInteger(maxPerFile) || maxPerFile < 1 || maxPerFile > 100_000) {
      throw new WERR_INVALID_PARAMETER('maxPerFile', 'an integer from 1 through 100000')
    }
    const info: BulkHeaderFilesInfo = {
      rootFolder,
      jsonFilename,
      files: [],
      headersPerFile: maxPerFile
    }
    const maxHeight = await this.getMaxHeight()
    if (!Number.isSafeInteger(maxHeight) || maxHeight < -1 || maxHeight > 0x7fffffff) {
      throw new WERR_INVALID_OPERATION('bulk storage returned an invalid maximum height')
    }
    const baseFilename = jsonFilename.slice(0, -5) // remove ".json"
    let prevHash = '00'.repeat(32)
    let prevChainWork = '00'.repeat(32)
    for (let height = 0; height <= maxHeight; height += maxPerFile) {
      const count = Math.min(maxPerFile, maxHeight - height + 1)
      const file: BulkHeaderFileInfo = {
        fileName: `${baseFilename}_${info.files.length}.headers`,
        firstHeight: height,
        prevHash,
        prevChainWork,
        count,
        lastHash: null,
        fileHash: null,
        lastChainWork: '',
        chain: this.chain
      }
      const buffer = await this.headersToBuffer(height, count)
      if (!(buffer instanceof Uint8Array) || buffer.length !== count * 80) {
        throw new WERR_INVALID_OPERATION(
          `bulk storage returned ${buffer?.length ?? 'non-binary'} bytes for ${count} headers at height ${height}`
        )
      }
      const validation = validateBufferOfHeaders(buffer, prevHash, 0, count, prevChainWork, this.chain)
      if (height === 0) validateGenesisHeader(buffer, this.chain)
      file.fileHash = asString(sha256(asArray(buffer)), 'base64')
      file.lastHash = validation.lastHeaderHash
      file.lastChainWork = validation.lastChainWork!
      await this.fs.writeFile(this.fs.pathJoin(rootFolder, file.fileName), buffer)
      info.files.push(file)
      prevHash = file.lastHash
      prevChainWork = file.lastChainWork
    }
    const bytes = asUint8Array(JSON.stringify(info), 'utf8')
    await this.fs.writeFile(this.fs.pathJoin(rootFolder, jsonFilename), bytes)
  }
}
