import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { BulkFileDataCacheApi } from '../Api/BulkFileDataCacheApi'
import type { BulkHeaderFileInfo } from './BulkHeaderFile'

export interface BulkFileDataCacheFsOptions {
  /** Root for immutable content-addressed cache objects. */
  rootFolder: string
  /** Read-only legacy locations consulted during in-place migration. */
  legacyRoots?: string[]
}

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
  private readonly rootFolder: string
  private readonly legacyRoots: string[]

  constructor(rootFolderOrOptions: string | BulkFileDataCacheFsOptions) {
    const options = typeof rootFolderOrOptions === 'string' ? { rootFolder: rootFolderOrOptions } : rootFolderOrOptions
    this.rootFolder = options.rootFolder
    this.legacyRoots = options.legacyRoots ?? []
  }

  private legacyFilePath(root: string, file: Readonly<BulkHeaderFileInfo>): string {
    this.validateFileName(file)
    return path.join(root, file.fileName)
  }

  private validateFileName(file: Readonly<BulkHeaderFileInfo>): void {
    if (path.basename(file.fileName) !== file.fileName || file.fileName === '.' || file.fileName === '..') {
      throw new Error(`Invalid bulk-header cache file name: ${file.fileName}`)
    }
  }

  private digestHex(file: Readonly<BulkHeaderFileInfo>): string {
    if (file.fileHash == null) throw new Error(`Missing bulk-header digest for ${file.fileName}`)
    const digest = Buffer.from(file.fileHash, 'base64')
    if (digest.length !== 32 || digest.toString('base64') !== file.fileHash) {
      throw new Error(`Invalid bulk-header digest for ${file.fileName}`)
    }
    return digest.toString('hex')
  }

  private objectPath(file: Readonly<BulkHeaderFileInfo>): string {
    this.validateFileName(file)
    const digest = this.digestHex(file)
    return path.join(this.rootFolder, 'objects', digest.slice(0, 2), `${digest}.headers`)
  }

  private legacyRejectionMarker(file: Readonly<BulkHeaderFileInfo>): string {
    return path.join(this.rootFolder, 'quarantine', `${this.digestHex(file)}.legacy-rejected.json`)
  }

  async get(file: Readonly<BulkHeaderFileInfo>): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await fs.readFile(this.objectPath(file)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await fs.access(this.legacyRejectionMarker(file))
      return undefined
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const root of this.legacyRoots) {
      try {
        return new Uint8Array(await fs.readFile(this.legacyFilePath(root, file)))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return undefined
  }

  async set(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void> {
    const destination = this.objectPath(file)
    const folder = path.dirname(destination)
    await fs.mkdir(folder, { recursive: true })
    const temporary = path.join(folder, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
    let handle: fs.FileHandle | undefined
    try {
      handle = await fs.open(temporary, 'wx', 0o600)
      await handle.writeFile(data)
      await handle.sync()
      await handle.close()
      handle = undefined
      await fs.rename(temporary, destination)
      await syncDirectory(folder)
    } finally {
      await handle?.close().catch(() => undefined)
      await fs.unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  async promoteValidated(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void> {
    try {
      await fs.access(this.objectPath(file))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      await this.set(file, data)
    }
  }

  async quarantine(file: Readonly<BulkHeaderFileInfo>, reason: string, rejectedData?: Uint8Array): Promise<void> {
    const source = this.objectPath(file)
    const quarantineFolder = path.join(this.rootFolder, 'quarantine')
    const destination = path.join(quarantineFolder, `${this.digestHex(file)}.${Date.now()}.${randomUUID()}.invalid`)
    await fs.mkdir(quarantineFolder, { recursive: true })
    try {
      const candidate = await fs.readFile(source)
      if (rejectedData != null && !candidate.equals(Buffer.from(rejectedData))) return
      await fs.rename(source, destination)
      await syncDirectory(path.dirname(source))
      await syncDirectory(quarantineFolder)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      if (this.legacyRoots.length === 0) return
      // Legacy entries are intentionally read-only. Once replacement succeeds,
      // the content-addressed object takes precedence without destroying the
      // old deployment's only retained bytes.
      await writeAtomicFile(
        this.legacyRejectionMarker(file),
        Buffer.from(JSON.stringify({ fileName: file.fileName, fileHash: file.fileHash, reason }))
      )
    }
  }

  async delete(file: Readonly<BulkHeaderFileInfo>): Promise<void> {
    await this.quarantine(file, 'delete requested through legacy cache contract')
  }
}

async function writeAtomicFile(destination: string, data: Uint8Array): Promise<void> {
  const folder = path.dirname(destination)
  await fs.mkdir(folder, { recursive: true })
  const temporary = path.join(folder, `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`)
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(temporary, 'wx', 0o600)
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = undefined
    await fs.rename(temporary, destination)
    await syncDirectory(folder)
  } finally {
    await handle?.close().catch(() => undefined)
    await fs.unlink(temporary).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    })
  }
}

async function syncDirectory(folder: string): Promise<void> {
  let handle: fs.FileHandle | undefined
  try {
    handle = await fs.open(folder, 'r')
    await handle.sync()
  } finally {
    await handle?.close()
  }
}
