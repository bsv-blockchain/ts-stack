import { promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import * as path from 'node:path'
import type { BulkFileDataCacheApi } from '../Api/BulkFileDataCacheApi'
import type { BulkHeaderFileInfo } from './BulkHeaderFile'

export interface BulkFileDataCacheFsOptions {
  /** Root for immutable content-addressed cache objects. */
  rootFolder: string
  /** Read-only legacy locations consulted during in-place migration. */
  legacyRoots?: string[]
  /** Maximum wait for a per-object cross-process mutation lock. Default: 30 seconds. */
  lockTimeoutMsecs?: number
  /** Delay between lock attempts. Default: 25 milliseconds. */
  lockRetryMsecs?: number
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
  private static readonly MAX_HEADERS_PER_FILE = 100_000
  private static readonly MAX_LEGACY_ROOTS = 64
  private static readonly SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,254}$/

  private readonly rootFolder: string
  private readonly legacyRoots: string[]
  private readonly lockTimeoutMsecs: number
  private readonly lockRetryMsecs: number

  constructor(rootFolderOrOptions: string | BulkFileDataCacheFsOptions) {
    const options = typeof rootFolderOrOptions === 'string' ? { rootFolder: rootFolderOrOptions } : rootFolderOrOptions
    if (options == null || typeof options !== 'object' || Array.isArray(options)) {
      throw new Error('Bulk-header cache options must be a root path or options object.')
    }
    this.rootFolder = this.validateRoot(options.rootFolder, 'rootFolder')
    this.lockTimeoutMsecs = this.positiveInteger(options.lockTimeoutMsecs ?? 30_000, 'lockTimeoutMsecs')
    this.lockRetryMsecs = this.positiveInteger(options.lockRetryMsecs ?? 25, 'lockRetryMsecs')
    if (this.lockRetryMsecs > this.lockTimeoutMsecs) {
      throw new Error('lockRetryMsecs must be no greater than lockTimeoutMsecs.')
    }
    const legacyRoots = options.legacyRoots ?? []
    if (!Array.isArray(legacyRoots) || legacyRoots.length > BulkFileDataCacheFs.MAX_LEGACY_ROOTS) {
      throw new Error(`legacyRoots must be an array of no more than ${BulkFileDataCacheFs.MAX_LEGACY_ROOTS} paths.`)
    }
    this.legacyRoots = []
    for (let index = 0; index < legacyRoots.length; index++) {
      if (!Object.hasOwn(legacyRoots, index)) throw new Error('legacyRoots must be a dense array of paths.')
      this.legacyRoots.push(this.validateRoot(legacyRoots[index], `legacyRoots[${index}]`))
    }
  }

  private legacyFilePath(root: string, file: Readonly<BulkHeaderFileInfo>): string {
    this.validateFileName(file)
    return path.join(root, file.fileName)
  }

  private validateFileName(file: Readonly<BulkHeaderFileInfo>): void {
    if (
      typeof file.fileName !== 'string' ||
      !BulkFileDataCacheFs.SAFE_FILE_NAME.test(file.fileName) ||
      path.basename(file.fileName) !== file.fileName ||
      file.fileName === '.' ||
      file.fileName === '..'
    ) {
      throw new Error(`Invalid bulk-header cache file name: ${file.fileName}`)
    }
  }

  private validateRoot(value: unknown, name: string): string {
    if (typeof value !== 'string' || value.trim() === '' || /[\r\n]/.test(value) || value.includes('\u0000')) {
      throw new Error(`${name} must be a non-empty filesystem path without control lines.`)
    }
    const resolved = path.resolve(value)
    if (resolved === path.parse(resolved).root) throw new Error(`${name} cannot be a filesystem root.`)
    return resolved
  }

  private expectedBytes(file: Readonly<BulkHeaderFileInfo>): number {
    if (!Number.isSafeInteger(file.count) || file.count < 1 || file.count > BulkFileDataCacheFs.MAX_HEADERS_PER_FILE) {
      throw new Error(`Invalid bulk-header count for ${file.fileName}`)
    }
    return file.count * 80
  }

  private validateData(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): void {
    if (!(data instanceof Uint8Array)) throw new Error(`Invalid bulk-header data for ${file.fileName}`)
    if (data.byteLength !== this.expectedBytes(file)) {
      throw new Error(`Invalid bulk-header data length for ${file.fileName}`)
    }
    if (createHash('sha256').update(data).digest('base64') !== file.fileHash) {
      throw new Error(`Invalid bulk-header data digest for ${file.fileName}`)
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
    file = this.snapshotFile(file)
    try {
      return await this.readBoundedFile(this.objectPath(file), file)
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
        return await this.readBoundedFile(this.legacyFilePath(root, file), file)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
    return undefined
  }

  async set(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void> {
    file = this.snapshotFile(file)
    const ownedData = data instanceof Uint8Array ? data.slice() : data
    this.validateData(file, ownedData)
    await this.withObjectLock(file, async () => await this.setNoLock(file, ownedData))
  }

  private async setNoLock(file: Readonly<BulkHeaderFileInfo>, data: Uint8Array): Promise<void> {
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
    file = this.snapshotFile(file)
    const ownedData = data instanceof Uint8Array ? data.slice() : data
    this.validateData(file, ownedData)
    await this.withObjectLock(file, async () => {
      try {
        await fs.access(this.objectPath(file))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await this.setNoLock(file, ownedData)
      }
    })
  }

  async quarantine(file: Readonly<BulkHeaderFileInfo>, reason: string, rejectedData?: Uint8Array): Promise<void> {
    file = this.snapshotFile(file)
    if (typeof reason !== 'string' || reason.length > 4096 || /[\r\n]/.test(reason) || reason.includes('\u0000')) {
      throw new Error('Bulk-header quarantine reason must be a single-line string no longer than 4096 characters.')
    }
    if (rejectedData !== undefined && !(rejectedData instanceof Uint8Array)) {
      throw new Error('Rejected bulk-header data exceeds the bounded cache-object size.')
    }
    rejectedData = rejectedData?.slice()
    if (rejectedData !== undefined && rejectedData.byteLength > this.expectedBytes(file) + 1) {
      throw new Error('Rejected bulk-header data exceeds the bounded cache-object size.')
    }
    await this.withObjectLock(file, async () => await this.quarantineNoLock(file, reason, rejectedData))
  }

  private async quarantineNoLock(
    file: Readonly<BulkHeaderFileInfo>,
    reason: string,
    rejectedData?: Uint8Array
  ): Promise<void> {
    const source = this.objectPath(file)
    const quarantineFolder = path.join(this.rootFolder, 'quarantine')
    const destination = path.join(quarantineFolder, `${this.digestHex(file)}.${Date.now()}.${randomUUID()}.invalid`)
    await fs.mkdir(quarantineFolder, { recursive: true })
    try {
      const candidate = await this.readBoundedFile(source, file)
      if (rejectedData != null && !Buffer.from(candidate).equals(Buffer.from(rejectedData))) return
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

  private async readBoundedFile(source: string, file: Readonly<BulkHeaderFileInfo>): Promise<Uint8Array> {
    const maximum = this.expectedBytes(file)
    const handle = await fs.open(source, 'r')
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error(`Bulk-header cache object is not a regular file: ${file.fileName}`)
      const requested = stat.size > maximum ? maximum + 1 : stat.size
      const data = new Uint8Array(requested)
      let offset = 0
      while (offset < data.length) {
        const { bytesRead } = await handle.read(data, offset, data.length - offset, offset)
        if (bytesRead === 0) break
        offset += bytesRead
      }
      let result = offset === data.length ? data : data.slice(0, offset)
      if (result.length <= maximum) {
        const extra = new Uint8Array(1)
        const { bytesRead } = await handle.read(extra, 0, 1, result.length)
        if (bytesRead > 0) {
          const grown = new Uint8Array(result.length + 1)
          grown.set(result)
          grown[result.length] = extra[0]
          result = grown
        }
      }
      return result
    } finally {
      await handle.close()
    }
  }

  private positiveInteger(value: unknown, name: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 60 * 60 * 1000) {
      throw new Error(`${name} must be an integer from 1 through 3600000.`)
    }
    return value as number
  }

  private snapshotFile(file: Readonly<BulkHeaderFileInfo>): Readonly<BulkHeaderFileInfo> {
    if (file == null || typeof file !== 'object' || Array.isArray(file)) {
      throw new Error('Bulk-header cache metadata must be a data object.')
    }
    const values: Record<string, unknown> = {}
    for (const name of ['fileName', 'fileHash', 'count'] as const) {
      const descriptor = Object.getOwnPropertyDescriptor(file, name)
      if (descriptor == null || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        throw new Error(`Bulk-header cache metadata ${name} must be an own data property.`)
      }
      values[name] = descriptor.value
    }
    return values as unknown as Readonly<BulkHeaderFileInfo>
  }

  private async withObjectLock<T>(file: Readonly<BulkHeaderFileInfo>, work: () => Promise<T>): Promise<T> {
    const destination = this.objectPath(file)
    const lockFolder = `${destination}.lock`
    const ownerFile = path.join(lockFolder, 'owner')
    const token = randomUUID()
    const startedAt = Date.now()
    await fs.mkdir(path.dirname(destination), { recursive: true })
    for (;;) {
      try {
        await fs.mkdir(lockFolder, { mode: 0o700 })
        try {
          await fs.writeFile(ownerFile, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
        } catch (error) {
          await fs.rmdir(lockFolder).catch(() => undefined)
          throw error
        }
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (Date.now() - startedAt >= this.lockTimeoutMsecs) {
          throw new Error(
            `Timed out acquiring bulk-header cache lock ${lockFolder}. ` +
              'The lock is never reclaimed automatically after a crash; verify that no writer is active before removing it.'
          )
        }
        await new Promise(resolve => setTimeout(resolve, this.lockRetryMsecs))
      }
    }

    let outcome: { ok: true; value: T } | { ok: false; error: unknown }
    try {
      outcome = { ok: true, value: await work() }
    } catch (error) {
      outcome = { ok: false, error }
    }
    let releaseError: unknown
    try {
      let owner: string | undefined
      try {
        owner = await fs.readFile(ownerFile, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      if (owner === token) {
        await fs.unlink(ownerFile)
        await fs.rmdir(lockFolder)
      }
    } catch (error) {
      releaseError = error
    }
    if (!outcome.ok) throw outcome.error
    if (releaseError != null) throw releaseError
    return outcome.value
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
