import { WERR_INTERNAL, WERR_INVALID_PARAMETER } from '../../../../sdk'
import { BulkFileDataManager } from './BulkFileDataManager'
import { BulkHeaderFileInfo } from './BulkHeaderFile'
import { HeightRange } from './HeightRange'

export class BulkFileDataReader {
  readonly manager: BulkFileDataManager
  readonly range: HeightRange
  readonly maxBufferSize: number
  nextHeight: number

  constructor(manager: BulkFileDataManager, range: HeightRange, maxBufferSize: number) {
    if (range == null || typeof range !== 'object') throw new WERR_INVALID_PARAMETER('range', 'a HeightRange')
    if (
      !Number.isSafeInteger(range.minHeight) ||
      range.minHeight < 0 ||
      range.minHeight > 0x7fffffff ||
      !Number.isSafeInteger(range.maxHeight) ||
      range.maxHeight < -1 ||
      range.maxHeight > 0x7fffffff
    ) {
      throw new WERR_INVALID_PARAMETER('range', 'supported safe-integer block heights')
    }
    if (
      !Number.isSafeInteger(maxBufferSize) ||
      maxBufferSize < 80 ||
      maxBufferSize > 100_000 * 80 ||
      maxBufferSize % 80 !== 0
    ) {
      throw new WERR_INVALID_PARAMETER('maxBufferSize', 'a multiple of 80 bytes from 80 through 8000000')
    }
    this.manager = manager
    this.range = new HeightRange(range.minHeight, range.maxHeight)
    this.maxBufferSize = maxBufferSize
    this.nextHeight = range.minHeight
  }

  /**
   * Returns the Buffer of block headers from the given `file` for the given `range`.
   * If `range` is undefined, the file's full height range is read.
   * The returned Buffer will only contain headers in `file` and in `range`
   * @param file
   * @param range
   */
  private async readBufferFromFile(file: BulkHeaderFileInfo, range?: HeightRange): Promise<Uint8Array | undefined> {
    // Constrain the range to the file's contents...
    let fileRange = new HeightRange(file.firstHeight, file.firstHeight + file.count - 1)
    if (range != null) fileRange = fileRange.intersect(range)
    if (fileRange.isEmpty) return undefined
    const offset = (fileRange.minHeight - file.firstHeight) * 80
    const length = fileRange.length * 80
    return await this.manager.getDataFromFile(file, offset, length)
  }

  /**
   * @returns an array containing the next `maxBufferSize` bytes of headers from the files.
   */
  async read(): Promise<Uint8Array | undefined> {
    if (this.nextHeight === undefined || !this.range || this.range.isEmpty || this.nextHeight > this.range.maxHeight) {
      return undefined
    }
    let lastHeight = this.nextHeight + this.maxBufferSize / 80 - 1
    lastHeight = Math.min(lastHeight, this.range.maxHeight)
    let file = await this.manager.getFileForHeight(this.nextHeight)
    if (file == null) throw new WERR_INTERNAL('logic error')
    const readRange = new HeightRange(this.nextHeight, lastHeight)
    const buffers = new Uint8Array(readRange.length * 80)
    let offset = 0
    while (file != null) {
      const buffer = await this.readBufferFromFile(file, readRange)
      if (buffer == null) break
      buffers.set(buffer, offset)
      offset += buffer.length
      file = await this.manager.getFileForHeight(file.firstHeight + file.count)
    }
    if (!buffers.length || offset !== readRange.length * 80) return undefined
    this.nextHeight = lastHeight + 1
    return buffers
  }
}
