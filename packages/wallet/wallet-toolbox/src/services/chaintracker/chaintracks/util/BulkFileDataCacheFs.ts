import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { BulkFileDataCacheApi } from '../Api/BulkFileDataCacheApi'
import type { BulkHeaderFileInfo } from './BulkHeaderFile'

/**
 * Atomic filesystem implementation of the bulk-header cache contract.
 *
 * This Node-only export is intentionally absent from browser and mobile entry
 * points. Cache contents are untrusted until the manager verifies their exact
 * byte length and SHA-256 digest.
 *
 * @public
 */
export class BulkFileDataCacheFs implements BulkFileDataCacheApi {
  constructor(private readonly rootFolder: string) {}

  private filePath(file: Readonly<BulkHeaderFileInfo>): string {
    if (path.basename(file.fileName) !== file.fileName || file.fileName === '.' || file.fileName === '..') {
      throw new Error(`Invalid bulk-header cache file name: ${file.fileName}`)
    }
    return path.join(this.rootFolder, file.fileName)
  }

  async get(file: Readonly<BulkHeaderFileInfo>): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await fs.readFile(this.filePath(file)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async set(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void> {
    const destination = this.filePath(file)
    await fs.mkdir(this.rootFolder, { recursive: true })
    const temporary = path.join(
      this.rootFolder,
      `.${file.fileName}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    )
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(data)
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temporary, destination)
    } finally {
      await handle?.close().catch(() => undefined)
      await fs.unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  async delete(file: Readonly<BulkHeaderFileInfo>): Promise<void> {
    try {
      await fs.unlink(this.filePath(file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
}
