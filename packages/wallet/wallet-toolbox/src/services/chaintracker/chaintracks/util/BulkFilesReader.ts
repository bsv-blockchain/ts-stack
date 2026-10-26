import { HeightRange } from './HeightRange'
import { deserializeBaseBlockHeader, validateBufferOfHeaders, validateGenesisHeader } from './blockHeaderUtilities'
import { BaseBlockHeader } from '../../../../sdk/WalletServices.interfaces'
import { asArray, asString, asUint8Array } from '../../../../utility/utilityHelpers.noBuffer'
import { ChaintracksFsApi } from '../Api/ChaintracksFsApi'
import { sha256 } from '@bsv/sdk/primitives/Hash'
import { WERR_INTERNAL, WERR_INVALID_OPERATION, WERR_INVALID_PARAMETER } from '../../../../sdk'
import { ChaintracksStorageBase } from '../Storage/ChaintracksStorageBase'
import { ChaintracksFetchApi } from '../Api/ChaintracksFetchApi'
import {
  BulkHeaderFile,
  BulkHeaderFileFs,
  BulkHeaderFileInfo,
  BulkHeaderFilesInfo,
  BulkHeaderFileStorage
} from './BulkHeaderFile'
import { normalizeBulkHeaderFilesInfo } from './BulkFileDataManager'

const MAX_LOCAL_BULK_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_READER_FILES = 10_000
const MAX_READER_BUFFER_BYTES = 100_000 * 80
const SAFE_LOCAL_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/

function validateLocalFileName(fileName: string, name: string): void {
  if (
    typeof fileName !== 'string' ||
    fileName.length === 0 ||
    fileName.length > 255 ||
    !SAFE_LOCAL_FILE_NAME.test(fileName) ||
    fileName === '.' ||
    fileName === '..'
  ) {
    throw new WERR_INVALID_PARAMETER(name, 'a safe path-free ASCII file name')
  }
}

function validateReaderRange(range: HeightRange): void {
  if (range == null || typeof range !== 'object') throw new WERR_INVALID_PARAMETER('range', 'a HeightRange')
  if (!Number.isSafeInteger(range.minHeight) || range.minHeight < 0 || range.minHeight > 0x7fffffff) {
    throw new WERR_INVALID_PARAMETER('range.minHeight', 'an integer from 0 through 2147483647')
  }
  if (!Number.isSafeInteger(range.maxHeight) || range.maxHeight < -1 || range.maxHeight > 0x7fffffff) {
    throw new WERR_INVALID_PARAMETER('range.maxHeight', 'an integer from -1 through 2147483647')
  }
}

/**
 * Breaks available bulk headers stored in multiple files into a sequence of buffers with
 * limited maximum size.
 */
export class BulkFilesReader {
  /**
   * Previously validated bulk header files which may pull data from backing storage on demand.
   */
  files: BulkHeaderFile[]
  /**
   * Subset of headers currently being "read".
   */
  range: HeightRange
  /**
   * Maximum buffer size returned from `read()` in bytes.
   */
  maxBufferSize = 400 * 80
  /**
   * "Read pointer", the next height to be "read".
   */
  nextHeight: number | undefined

  constructor(files: BulkHeaderFile[], range?: HeightRange, maxBufferSize?: number) {
    if (
      !Array.isArray(files) ||
      files.length > MAX_READER_FILES ||
      Object.keys(files).length !== files.length ||
      files.some(file => !(file instanceof BulkHeaderFile))
    ) {
      throw new WERR_INVALID_PARAMETER('files', `a dense array of at most ${MAX_READER_FILES} bulk-header files`)
    }
    this.files = files
    this.range = HeightRange.empty
    this.setRange(range)
    this.setMaxBufferSize(maxBufferSize ?? 400 * 80)
  }

  protected setRange(range?: HeightRange) {
    this.range = this.heightRange
    if (range != null) {
      validateReaderRange(range)
      this.range = this.range.intersect(new HeightRange(range.minHeight, range.maxHeight))
    }
    this.nextHeight = this.range.isEmpty ? undefined : this.range.minHeight
  }

  setMaxBufferSize(maxBufferSize: number | undefined) {
    this.maxBufferSize = maxBufferSize ?? 400 * 80
    if (
      !Number.isSafeInteger(this.maxBufferSize) ||
      this.maxBufferSize < 80 ||
      this.maxBufferSize > MAX_READER_BUFFER_BYTES ||
      this.maxBufferSize % 80 !== 0
    ) {
      throw new WERR_INVALID_PARAMETER(
        'maxBufferSize',
        `a multiple of 80 bytes from 80 through ${MAX_READER_BUFFER_BYTES}`
      )
    }
  }

  private getLastFile(): BulkHeaderFileInfo | undefined {
    return this.files.at(-1)
  }

  get heightRange(): HeightRange {
    const last = this.getLastFile()
    if (last == null || !this.files) return HeightRange.empty
    const first = this.files[0]
    return new HeightRange(first.firstHeight, last.firstHeight + last.count - 1)
  }

  private getFileForHeight(height: number): BulkHeaderFile | undefined {
    if (!this.files) return undefined
    return this.files.find(file => file.firstHeight <= height && file.firstHeight + file.count > height)
  }

  async readBufferForHeightOrUndefined(height: number): Promise<Uint8Array | undefined> {
    if (!Number.isSafeInteger(height) || height < 0 || height > 0x7fffffff) {
      throw new WERR_INVALID_PARAMETER('height', 'an integer from 0 through 2147483647')
    }
    const file = this.getFileForHeight(height)
    if (file == null) return undefined
    const buffer = await file.readDataFromFile(80, (height - file.firstHeight) * 80)
    return buffer
  }

  async readBufferForHeight(height: number): Promise<Uint8Array> {
    const header = await this.readBufferForHeightOrUndefined(height)
    if (header == null) throw new Error(`Failed to read bulk header buffer at height=${height}`)
    return header
  }

  async readHeaderForHeight(height: number): Promise<BaseBlockHeader> {
    const buffer = await this.readBufferForHeight(height)
    return deserializeBaseBlockHeader(buffer, 0)
  }

  async readHeaderForHeightOrUndefined(height: number): Promise<BaseBlockHeader | undefined> {
    const buffer = await this.readBufferForHeightOrUndefined(height)
    return buffer != null ? deserializeBaseBlockHeader(buffer, 0) : undefined
  }

  /**
   * Returns the Buffer of block headers from the given `file` for the given `range`.
   * If `range` is undefined, the file's full height range is read.
   * The returned Buffer will only contain headers in `file` and in `range`
   * @param file
   * @param range
   */
  private async readBufferFromFile(file: BulkHeaderFile, range?: HeightRange): Promise<Uint8Array | undefined> {
    // Constrain the range to the file's contents...
    let fileRange = file.heightRange
    if (range != null) fileRange = fileRange.intersect(range)
    if (fileRange.isEmpty) return undefined
    const position = (fileRange.minHeight - file.firstHeight) * 80
    const length = fileRange.length * 80
    return await file.readDataFromFile(length, position)
  }

  private nextFile(file: BulkHeaderFile | undefined): BulkHeaderFile | undefined {
    if (file == null) return this.files[0]
    const i = this.files.indexOf(file)
    if (i < 0) throw new WERR_INVALID_PARAMETER('file', 'a valid file from this.files')
    return this.files[i + 1]
  }

  /**
   * @returns an array containing the next `maxBufferSize` bytes of headers from the files.
   */
  async read(): Promise<Uint8Array | undefined> {
    if (this.nextHeight === undefined || !this.range || this.nextHeight > this.range.maxHeight) return undefined
    let lastHeight = this.nextHeight + this.maxBufferSize / 80 - 1
    lastHeight = Math.min(lastHeight, this.range.maxHeight)
    let file = this.getFileForHeight(this.nextHeight)
    if (file == null) throw new WERR_INTERNAL('logic error')
    const readRange = new HeightRange(this.nextHeight, lastHeight)
    const buffers = new Uint8Array(readRange.length * 80)
    let offset = 0
    while (file != null) {
      const buffer = await this.readBufferFromFile(file, readRange)
      if (buffer == null) break
      buffers.set(buffer, offset)
      offset += buffer.length
      file = this.nextFile(file)
    }
    if (!buffers.length || offset !== readRange.length * 80) return undefined
    this.nextHeight = lastHeight + 1
    return buffers
  }

  /**
   * Reset the reading process and adjust the range to be read to a new subset of what's available...
   * @param range new range for subsequent `read` calls to return.
   * @param maxBufferSize optionally update largest buffer size for `read` to return
   */
  resetRange(range: HeightRange, maxBufferSize?: number) {
    this.setRange(range)
    this.setMaxBufferSize(maxBufferSize ?? 400 * 80)
  }

  async validateFiles(): Promise<void> {
    let lastChainWork: string | undefined = '00'.repeat(32)
    let lastHeaderHash = '00'.repeat(32)
    let nextHeight = 0
    const chain = this.files[0]?.chain
    for (const [index, file] of this.files.entries()) {
      if (chain == null || file.chain !== chain) {
        throw new WERR_INVALID_OPERATION(`bulk file ${file.fileName} has a missing or inconsistent chain`)
      }
      if (file.firstHeight !== nextHeight) {
        throw new WERR_INVALID_OPERATION(
          `bulk file ${file.fileName} is not contiguous: expected first height ${nextHeight}, got ${file.firstHeight}`
        )
      }
      if (file.prevChainWork !== lastChainWork) {
        throw new WERR_INVALID_OPERATION(
          `prevChainWork mismatch for file ${file.fileName}: expected ${file.prevChainWork}, got ${lastChainWork}`
        )
      }
      if (file.prevHash !== lastHeaderHash) {
        throw new WERR_INVALID_OPERATION(
          `prevHash mismatch for file ${file.fileName}: expected ${file.prevHash}, got ${lastHeaderHash}`
        )
      }
      const data = await file.ensureData()
      if (data.length !== file.count * 80) {
        throw new WERR_INVALID_OPERATION(
          `data length mismatch for file ${file.fileName}: expected ${file.count * 80} bytes, got ${data.length} bytes`
        )
      }
      const fileHash = await file.computeFileHash()
      if (!file.fileHash) throw new WERR_INVALID_OPERATION(`fileHash missing for file ${file.fileName}`)
      if (file.fileHash !== fileHash) {
        throw new WERR_INVALID_OPERATION(
          `fileHash mismatch for file ${file.fileName}: expected ${file.fileHash}, got ${fileHash}`
        )
      }
      ;({ lastHeaderHash, lastChainWork } = validateBufferOfHeaders(
        data,
        lastHeaderHash,
        0,
        file.count,
        lastChainWork,
        chain
      ))
      if (index === 0) validateGenesisHeader(data, chain)

      if (file.lastHash !== lastHeaderHash) {
        throw new WERR_INVALID_OPERATION(
          `lastHash mismatch for file ${file.fileName}: expected ${file.lastHash}, got ${lastHeaderHash}`
        )
      }
      if (file.lastChainWork !== lastChainWork) {
        throw new WERR_INVALID_OPERATION(
          `lastChainWork mismatch for file ${file.fileName}: expected ${file.lastChainWork}, got ${lastChainWork}`
        )
      }

      file.validated = true
      nextHeight += file.count
    }
  }

  async exportHeadersToFs(toFs: ChaintracksFsApi, toHeadersPerFile: number, toFolder: string): Promise<void> {
    if (!this.files || this.files.length === 0 || this.files[0].count === 0) {
      throw new WERR_INVALID_OPERATION('no headers currently available to export')
    }
    if (!this.files[0].chain) throw new WERR_INVALID_OPERATION('chain is not defined for the first file')

    const chain = this.files[0].chain
    const toFileName = (i: number) => `${chain}Net_${i}.headers`
    const toPath = (i: number) => toFs.pathJoin(toFolder, toFileName(i))
    const toJsonPath = () => toFs.pathJoin(toFolder, `${chain}NetBlockHeaders.json`)

    const toBulkFiles: BulkHeaderFilesInfo = {
      rootFolder: toFolder,
      jsonFilename: `${chain}NetBlockHeaders.json`,
      headersPerFile: toHeadersPerFile,
      files: []
    }

    const bf0 = this.files[0]

    let firstHeight = bf0.firstHeight
    let lastHeaderHash = bf0.prevHash
    let lastChainWork = bf0.prevChainWork

    const reader = new BulkFilesReader(this.files, this.heightRange, toHeadersPerFile * 80)

    let i = -1
    for (;;) {
      i++
      const data = await reader.read()
      if (data == null || data.length === 0) {
        break
      }

      const last = validateBufferOfHeaders(data, lastHeaderHash, 0, undefined, lastChainWork, chain)

      await toFs.writeFile(toPath(i), data)

      const fileHash = asString(sha256(asArray(data)), 'base64')
      const file: BulkHeaderFileInfo = {
        chain,
        count: data.length / 80,
        fileHash,
        fileName: toFileName(i),
        firstHeight,
        lastChainWork: last.lastChainWork!,
        lastHash: last.lastHeaderHash,
        prevChainWork: lastChainWork,
        prevHash: lastHeaderHash
      }
      toBulkFiles.files.push(file)
      firstHeight += file.count
      lastHeaderHash = file.lastHash!
      lastChainWork = file.lastChainWork!
    }

    await toFs.writeFile(toJsonPath(), asUint8Array(JSON.stringify(toBulkFiles), 'utf8'))
  }
}

export class BulkFilesReaderFs extends BulkFilesReader {
  constructor(
    public fs: ChaintracksFsApi,
    files: BulkHeaderFileFs[],
    range?: HeightRange,
    maxBufferSize?: number
  ) {
    super(files, range, maxBufferSize)
  }

  /**
   * Return a BulkFilesReader configured to access the intersection of `range` and available headers.
   * @param rootFolder
   * @param jsonFilename
   * @param range
   * @returns
   */
  static async fromFs(
    fs: ChaintracksFsApi,
    rootFolder: string,
    jsonFilename: string,
    range?: HeightRange,
    maxBufferSize?: number
  ): Promise<BulkFilesReaderFs> {
    validateLocalFileName(jsonFilename, 'jsonFilename')
    const filesInfo = await this.readJsonFile(fs, rootFolder, jsonFilename)
    const readerFiles = filesInfo.files.map(file => new BulkHeaderFileFs(file, fs, rootFolder))
    const reader = new BulkFilesReaderFs(fs, readerFiles, range, maxBufferSize)
    await reader.validateFiles()
    return reader
  }

  static async writeEmptyJsonFile(fs: ChaintracksFsApi, rootFolder: string, jsonFilename: string): Promise<string> {
    validateLocalFileName(jsonFilename, 'jsonFilename')
    const json = JSON.stringify({ files: [], rootFolder, jsonFilename, headersPerFile: 100_000 })
    await fs.writeFile(fs.pathJoin(rootFolder, jsonFilename), asUint8Array(json, 'utf8'))
    return json
  }

  static async readJsonFile(
    fs: ChaintracksFsApi,
    rootFolder: string,
    jsonFilename: string,
    failToEmptyRange: boolean = true
  ): Promise<BulkHeaderFilesInfo> {
    validateLocalFileName(jsonFilename, 'jsonFilename')
    const filePath = (file: string) => fs.pathJoin(rootFolder, file)

    const jsonPath = filePath(jsonFilename)

    let json: string

    try {
      const bytes = await fs.readFile(jsonPath)
      if (bytes.length > MAX_LOCAL_BULK_MANIFEST_BYTES) {
        throw new WERR_INVALID_PARAMETER(
          `${rootFolder}/${jsonFilename}`,
          `no larger than ${MAX_LOCAL_BULK_MANIFEST_BYTES} bytes`
        )
      }
      json = asString(bytes, 'utf8')
    } catch (error: unknown) {
      // Only a definite not-found condition may create an empty index. Permission,
      // corruption, size-limit, and other I/O failures must remain visible.
      const errorCode = (error as { code?: unknown } | null)?.code
      if (!failToEmptyRange || errorCode !== 'ENOENT') {
        if (errorCode !== 'ENOENT') throw error
        throw new WERR_INVALID_PARAMETER(`${rootFolder}/${jsonFilename}`, 'a valid, existing JSON file.')
      }
      json = await this.writeEmptyJsonFile(fs, rootFolder, jsonFilename)
    }

    const parsed = JSON.parse(json) as Record<string, unknown>
    // Older locally generated empty indexes omitted these two descriptive
    // fields. Supply their non-authoritative defaults before strict parsing.
    if (parsed.headersPerFile === undefined) parsed.headersPerFile = 100_000
    if (parsed.jsonFilename === undefined) parsed.jsonFilename = jsonFilename
    const readerFiles = normalizeBulkHeaderFilesInfo(parsed)
    readerFiles.jsonFilename = jsonFilename
    readerFiles.rootFolder = rootFolder
    return readerFiles
  }
}

export class BulkFilesReaderStorage extends BulkFilesReader {
  constructor(
    storage: ChaintracksStorageBase,
    files: BulkHeaderFileStorage[],
    range?: HeightRange,
    maxBufferSize?: number
  ) {
    super(files, range, maxBufferSize)
  }

  static async fromStorage(
    storage: ChaintracksStorageBase,
    fetch?: ChaintracksFetchApi,
    range?: HeightRange,
    maxBufferSize?: number
  ): Promise<BulkFilesReaderStorage> {
    const files = await storage.bulkManager.getBulkFiles(true)
    const readerFiles = files.map(file => new BulkHeaderFileStorage(file, storage, fetch))
    return new BulkFilesReaderStorage(storage, readerFiles, range, maxBufferSize)
  }
}
