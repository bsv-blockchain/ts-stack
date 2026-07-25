import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const CDN_ROOT = path.resolve(process.cwd(), 'public/cdn')
export const MAX_OBJECT_ID_LENGTH = 128

const BASE58_OBJECT_ID = /^[1-9A-HJ-NP-Za-km-z]+$/

export function resolveCdnObjectPath(
  objectID: unknown,
  root: string = CDN_ROOT
): string | null {
  if (
    typeof objectID !== 'string' ||
    objectID.length === 0 ||
    objectID.length > MAX_OBJECT_ID_LENGTH ||
    !BASE58_OBJECT_ID.test(objectID)
  ) {
    return null
  }

  const resolvedRoot = path.resolve(root)
  const candidate = path.resolve(resolvedRoot, objectID)
  const rootPrefix = resolvedRoot.endsWith(path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${path.sep}`
  return candidate.startsWith(rootPrefix) && path.dirname(candidate) === resolvedRoot
    ? candidate
    : null
}

export function writeCdnObjectExclusive(
  objectID: unknown,
  data: Uint8Array,
  root: string = CDN_ROOT
): 'stored' | 'exists' | 'invalid' {
  const filePath = resolveCdnObjectPath(objectID, root)
  if (filePath === null) return 'invalid'

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  try {
    fs.writeFileSync(filePath, data, { flag: 'wx' })
    return 'stored'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
    throw error
  }
}

export type StreamWriteResult =
  | { status: 'stored', byteLength: number, hash: number[] }
  | { status: 'exists' | 'invalid' | 'too_large' | 'size_mismatch' }

/**
 * Streams an object into a same-filesystem temporary file, hashes it
 * incrementally, and atomically links it into the public CDN directory.
 * Hard-link creation is exclusive: an existing file or symlink is never
 * overwritten.
 */
export async function writeCdnObjectStreamExclusive(
  objectID: unknown,
  source: AsyncIterable<Uint8Array>,
  expectedBytes: number,
  maximumBytes: number,
  root: string = CDN_ROOT
): Promise<StreamWriteResult> {
  const filePath = resolveCdnObjectPath(objectID, root)
  if (filePath === null) return { status: 'invalid' }
  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes < 0 ||
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 1 ||
    expectedBytes > maximumBytes
  ) {
    return { status: expectedBytes > maximumBytes ? 'too_large' : 'size_mismatch' }
  }

  await fs.promises.mkdir(path.dirname(filePath), { recursive: true })
  try {
    await fs.promises.lstat(filePath)
    return { status: 'exists' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${String(objectID)}.${randomUUID()}.upload`
  )
  const handle = await fs.promises.open(temporaryPath, 'wx', 0o600)
  const hash = createHash('sha256')
  let byteLength = 0

  try {
    for await (const chunk of source) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      byteLength += bytes.byteLength
      if (byteLength > expectedBytes || byteLength > maximumBytes) {
        return { status: 'too_large' }
      }
      hash.update(bytes)
      await handle.write(bytes)
    }
    if (byteLength !== expectedBytes) return { status: 'size_mismatch' }

    await handle.sync()
    await handle.close()
    try {
      await fs.promises.link(temporaryPath, filePath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        return { status: 'exists' }
      }
      throw error
    }
    return {
      status: 'stored',
      byteLength,
      hash: Array.from(hash.digest())
    }
  } finally {
    await handle.close().catch(() => {})
    await fs.promises.unlink(temporaryPath).catch(() => {})
  }
}
