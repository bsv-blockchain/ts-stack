import {
  ChaintracksAppendableFileApi,
  ChaintracksFsApi,
  ChaintracksReadableFileApi,
  ChaintracksWritableFileApi
} from '../Api/ChaintracksFsApi'
import { promises as fs } from 'node:fs'
import Path from 'node:path'

const MAX_CHAINTRACKS_FILE_IO_BYTES = 100_000 * 80

function validateFileIoBounds(length: number, offset: number): void {
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > MAX_CHAINTRACKS_FILE_IO_BYTES ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(offset + length)
  ) {
    throw new RangeError(
      `Chaintracks file I/O requires a non-negative safe offset and at most ${MAX_CHAINTRACKS_FILE_IO_BYTES} bytes`
    )
  }
}

export abstract class ChaintracksFsStatics {
  static async delete(path: string): Promise<void> {
    await fs.unlink(path)
  }

  static async writeFile(path: string, data: Uint8Array): Promise<void> {
    if (!(data instanceof Uint8Array)) throw new TypeError('Chaintracks file data must be a Uint8Array')
    validateFileIoBounds(data.byteLength, 0)
    await this.ensureFoldersExist(path)
    await fs.writeFile(path, Buffer.from(data))
  }

  static async readFile(path: string): Promise<Uint8Array> {
    const file = await ChaintracksReadableFile.openAsReadable(path)
    try {
      const length = await file.getLength()
      validateFileIoBounds(length, 0)
      return await file.read(length, 0)
    } finally {
      await file.close()
    }
  }

  static async openReadableFile(path: string): Promise<ChaintracksReadableFileApi> {
    return await ChaintracksReadableFile.openAsReadable(path)
  }

  static async openWritableFile(path: string): Promise<ChaintracksWritableFileApi> {
    return await ChaintracksWritableFile.openAsWritable(path)
  }

  static async openAppendableFile(path: string): Promise<ChaintracksAppendableFileApi> {
    return await ChaintracksAppendableFile.openAsAppendable(path)
  }

  static async ensureFoldersExist(path: string): Promise<void> {
    const parsedPath = Path.parse(path)
    if (parsedPath.dir !== '') await fs.mkdir(parsedPath.dir, { recursive: true })
  }

  static pathJoin(...parts: string[]): string {
    return Path.join(...parts)
  }
}

/**
 * This object is an implementation of the `ChaintracksFsApi` interface
 * using the `fs` package which may not be available in all environments.
 */
export const ChaintracksFs: ChaintracksFsApi = ChaintracksFsStatics

export class ChaintracksReadableFile implements ChaintracksReadableFileApi {
  path: string
  parsedPath: Path.ParsedPath
  f: fs.FileHandle

  protected constructor(path: string, f: fs.FileHandle) {
    this.path = path
    this.f = f
    this.parsedPath = Path.parse(path)
  }

  async close(): Promise<void> {
    await this.f.close()
  }

  async getLength(): Promise<number> {
    const stats = await this.f.stat()
    if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0) {
      throw new Error('Chaintracks readable resource must be a regular file with a safe length')
    }
    return stats.size
  }

  async read(length?: number, offset?: number): Promise<Uint8Array> {
    length ??= 80 * 1024 // Default to 80KB if no length is specified
    offset ??= 0
    validateFileIoBounds(length, offset)
    const buffer = Buffer.alloc(length)
    let bytesRead = 0
    while (bytesRead < length) {
      const result = await this.f.read(buffer, bytesRead, length - bytesRead, offset + bytesRead)
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    const rb = bytesRead < length ? buffer.subarray(0, bytesRead) : buffer
    return Uint8Array.from(rb)
  }

  static async openAsReadable(path: string): Promise<ChaintracksReadableFile> {
    const f = await fs.open(path, 'r')
    const file = new ChaintracksReadableFile(path, f)
    return file
  }
}

abstract class ChaintracksFolderAwareFile extends ChaintracksReadableFile {
  foldersEnsured: boolean = false

  protected constructor(path: string, f: fs.FileHandle) {
    super(path, f)
  }

  async ensureFoldersExist(): Promise<void> {
    if (!this.foldersEnsured) {
      await ChaintracksFsStatics.ensureFoldersExist(this.path)
      this.foldersEnsured = true
    }
  }

  protected async writeAll(data: Uint8Array): Promise<void> {
    if (!(data instanceof Uint8Array)) throw new TypeError('Chaintracks file data must be a Uint8Array')
    validateFileIoBounds(data.length, 0)
    const buffer = Buffer.from(data)
    let bytesWritten = 0
    while (bytesWritten < buffer.length) {
      const result = await this.f.write(buffer, bytesWritten, buffer.length - bytesWritten, null)
      if (result.bytesWritten === 0) throw new Error('Chaintracks file write made no progress')
      bytesWritten += result.bytesWritten
    }
  }
}

export class ChaintracksWritableFile extends ChaintracksFolderAwareFile implements ChaintracksWritableFileApi {
  private constructor(path: string, f: fs.FileHandle) {
    super(path, f)
  }

  static async openAsWritable(path: string): Promise<ChaintracksWritableFile> {
    await ChaintracksFsStatics.ensureFoldersExist(path)
    const f = await fs.open(path, 'w')
    const file = new ChaintracksWritableFile(path, f)
    return file
  }

  async append(data: Uint8Array): Promise<void> {
    await this.writeAll(data)
  }
}

export class ChaintracksAppendableFile extends ChaintracksFolderAwareFile implements ChaintracksAppendableFileApi {
  private constructor(path: string, f: fs.FileHandle) {
    super(path, f)
  }

  static async openAsAppendable(path: string): Promise<ChaintracksAppendableFile> {
    await ChaintracksFsStatics.ensureFoldersExist(path)
    const f = await fs.open(path, 'a+')
    const file = new ChaintracksAppendableFile(path, f)
    return file
  }

  async append(data: Uint8Array): Promise<void> {
    await this.writeAll(data)
  }
}
