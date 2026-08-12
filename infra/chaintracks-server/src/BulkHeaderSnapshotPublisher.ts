import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import * as path from 'node:path'
import { pipeline } from 'node:stream/promises'

interface BulkHeaderManifestFile {
  fileName: string
  count: number
  fileHash: string
  firstHeight: number
}

interface BulkHeaderManifest {
  files: BulkHeaderManifestFile[]
}

export interface BulkHeaderSnapshotPublisherOptions {
  rootFolder: string
  chain: string
  maxGenerations?: number
}

export interface PublishedBulkHeaderSnapshot {
  generation: string
  folder: string
  fileCount: number
  maxHeight: number
}

/**
 * Publishes complete CDN generations behind one atomically replaced symlink.
 * A failed export or crash before the pointer swap leaves the previous
 * generation byte-for-byte active.
 */
export class BulkHeaderSnapshotPublisher {
  readonly activeFolder: string
  private readonly generationsFolder: string
  private readonly manifestName: string
  private readonly maxGenerations: number

  constructor(private readonly options: BulkHeaderSnapshotPublisherOptions) {
    this.activeFolder = path.join(options.rootFolder, 'current')
    this.generationsFolder = path.join(options.rootFolder, 'generations')
    this.manifestName = `${options.chain}NetBlockHeaders.json`
    this.maxGenerations = positiveInteger(options.maxGenerations ?? 3, 'maxGenerations')
  }

  async publish(exportTo: (folder: string) => Promise<void>): Promise<PublishedBulkHeaderSnapshot> {
    await fs.mkdir(this.generationsFolder, { recursive: true })
    const nonce = `${Date.now()}-${randomUUID()}`
    const staging = path.join(this.generationsFolder, `.staging-${nonce}`)
    const generation = `generation-${nonce}`
    const published = path.join(this.generationsFolder, generation)
    await fs.mkdir(staging, { recursive: false })

    try {
      await exportTo(staging)
      const manifest = await this.validateAndFlushGeneration(staging)
      await fs.rename(staging, published)
      await syncDirectory(this.generationsFolder)
      await this.switchActivePointer(published)
      await this.collectOldGenerations(generation)
      return {
        generation,
        folder: published,
        fileCount: manifest.files.length,
        maxHeight: manifestMaxHeight(manifest)
      }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true })
      throw error
    }
  }

  async currentMaxHeight(): Promise<number | undefined> {
    try {
      const manifest = await this.readManifest(path.join(this.activeFolder, this.manifestName))
      return manifestMaxHeight(manifest)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private async validateAndFlushGeneration(folder: string): Promise<BulkHeaderManifest> {
    const manifestPath = path.join(folder, this.manifestName)
    const manifest = await this.readManifest(manifestPath)
    let expectedFirstHeight = 0
    for (const file of manifest.files) {
      if (path.basename(file.fileName) !== file.fileName || !file.fileName.endsWith('.headers')) {
        throw new Error(`Invalid bulk-header snapshot file name: ${file.fileName}`)
      }
      if (
        !Number.isSafeInteger(file.count) ||
        file.count < 1 ||
        file.firstHeight !== expectedFirstHeight
      ) {
        throw new Error(`Invalid bulk-header snapshot range for ${file.fileName}`)
      }
      const digest = Buffer.from(file.fileHash, 'base64')
      if (digest.length !== 32 || digest.toString('base64') !== file.fileHash) {
        throw new Error(`Invalid bulk-header snapshot digest for ${file.fileName}`)
      }
      const filePath = path.join(folder, file.fileName)
      const handle = await fs.open(filePath, 'r')
      try {
        const stat = await handle.stat()
        if (stat.size !== file.count * 80) {
          throw new Error(`Invalid bulk-header snapshot length for ${file.fileName}`)
        }
        await handle.sync()
      } finally {
        await handle.close()
      }
      const digestVerifier = createHash('sha256')
      await pipeline(createReadStream(filePath), digestVerifier)
      if (digestVerifier.digest('base64') !== file.fileHash) {
        throw new Error(`Invalid bulk-header snapshot digest for ${file.fileName}`)
      }
      expectedFirstHeight += file.count
    }
    const manifestHandle = await fs.open(manifestPath, 'r')
    try {
      await manifestHandle.sync()
    } finally {
      await manifestHandle.close()
    }
    await syncDirectory(folder)
    return manifest
  }

  private async readManifest(manifestPath: string): Promise<BulkHeaderManifest> {
    const parsed: unknown = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
    if (
      parsed == null ||
      typeof parsed !== 'object' ||
      !Array.isArray((parsed as BulkHeaderManifest).files)
    ) {
      throw new Error('Invalid bulk-header snapshot manifest')
    }
    return parsed as BulkHeaderManifest
  }

  private async switchActivePointer(published: string): Promise<void> {
    const temporary = path.join(
      this.options.rootFolder,
      `.current.${process.pid}.${randomUUID()}.tmp`
    )
    await fs.mkdir(this.options.rootFolder, { recursive: true })
    try {
      await fs.symlink(published, temporary, 'dir')
      await fs.rename(temporary, this.activeFolder)
      await syncDirectory(this.options.rootFolder)
    } finally {
      await fs.unlink(temporary).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
    }
  }

  private async collectOldGenerations(activeGeneration: string): Promise<void> {
    const entries = await fs.readdir(this.generationsFolder, { withFileTypes: true })
    const generations = entries
      .filter(entry => entry.isDirectory() && entry.name.startsWith('generation-'))
      .map(entry => entry.name)
      .sort()
      .reverse()
    const retained = new Set(generations.slice(0, this.maxGenerations))
    retained.add(activeGeneration)
    for (const generation of generations) {
      if (!retained.has(generation)) {
        await fs.rm(path.join(this.generationsFolder, generation), { recursive: true, force: true })
      }
    }
    await syncDirectory(this.generationsFolder)
  }
}

function manifestMaxHeight(manifest: BulkHeaderManifest): number {
  const last = manifest.files[manifest.files.length - 1]
  return last == null ? -1 : last.firstHeight + last.count - 1
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`${name} must be a positive safe integer`)
  return value
}

async function syncDirectory(folder: string): Promise<void> {
  const handle = await fs.open(folder, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
