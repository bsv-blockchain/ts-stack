/** Internal physical privacy operations. Native metadata is DATA; callers still
 * owe original profile/archive/lease/transaction admission. No privacy verdict
 * is cached. The Windows native library belongs to the trusted installed package
 * code, with a fixed qualified build selected internally, never a caller path. */
import { constants, type BigIntStats } from 'node:fs'
import { lstat, mkdir, open, type FileHandle } from 'node:fs/promises'
import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { Brc38StagingCleanupError } from './Brc38StagingCleanupError'
import { isMainThread } from 'node:worker_threads'

interface NativeIdentity {
  device: string
  inode: string
  bytes: string
}
interface WindowsBoundary {
  inspectPath(filename: string, directory: boolean): NativeIdentity
  inspectDescriptor(fd: number, directory: boolean): NativeIdentity
  createDirectory(filename: string): NativeIdentity
  createFile(filename: string): NativeIdentity
  retryCleanup(): void
  acquireImage(filename: string, fd: number): object
  checkImage(token: object): void
  releaseImage(token: object): void
}
interface BoundaryBuild {
  bytes: number
  sha256: string
}
// Qualification fills exact architecture entries. Candidate receipts/exported
// metadata cannot register code or confer a runtime platform grant.
const windowsBuilds: Readonly<Record<string, BoundaryBuild | undefined>> = Object.freeze({})
let nativeBoundary: WindowsBoundary | undefined
let loadingBoundary: Promise<WindowsBoundary> | undefined
let retainedLoad: Brc38PrivateFilesystemCleanupError | undefined

export class Brc38PrivateFilesystemCleanupError extends Brc38StagingCleanupError {
  #complete = false
  #pending: Promise<void> | undefined
  constructor(
    cause: unknown,
    readonly cleanupError: unknown,
    private readonly closeResource: () => Promise<void>
  ) {
    super([cause, cleanupError], 'Private filesystem retains an original native resource', closeResource)
    this.name = 'Brc38PrivateFilesystemCleanupError'
  }
  get cleaned(): boolean {
    return this.#complete
  }
  override retryCleanup(): Promise<void> {
    if (this.#complete) return Promise.resolve()
    if (this.#pending !== undefined) return this.#pending
    this.#pending = Promise.resolve()
      .then(this.closeResource)
      .then(() => {
        this.#complete = true
      })
      .finally(() => {
        this.#pending = undefined
      })
    return this.#pending
  }
}

async function windowsBoundary(): Promise<WindowsBoundary> {
  if (!isMainThread) throw new Error('Windows private filesystem boundary requires its original Node main thread')
  if (retainedLoad !== undefined && !retainedLoad.cleaned) throw retainedLoad
  if (nativeBoundary !== undefined) return nativeBoundary
  if (loadingBoundary !== undefined) return loadingBoundary
  const build = windowsBuilds[process.arch]
  if (
    process.platform !== 'win32' ||
    build === undefined ||
    !Number.isSafeInteger(build.bytes) ||
    build.bytes < 1 ||
    build.bytes > 2097152 ||
    !/^[0-9a-f]{64}$/.test(build.sha256)
  )
    throw new Error('Windows private filesystem boundary has no qualified fixed build')
  loadingBoundary = (async () => {
    const filename = join(__dirname, 'native', 'brc38_windows.node')
    const file = await open(filename, constants.O_RDONLY)
    let failed = false,
      failure: unknown
    try {
      const before = await file.stat({ bigint: true }),
        named = await lstat(filename, { bigint: true })
      if (
        !before.isFile() ||
        before.nlink !== 1n ||
        before.size !== BigInt(build.bytes) ||
        !named.isFile() ||
        named.isSymbolicLink() ||
        named.dev !== before.dev ||
        named.ino !== before.ino
      )
        throw new Error('Windows native boundary file identity differs')
      const hash = createHash('sha256'),
        buffer = Buffer.alloc(65536)
      for (let offset = 0; offset < build.bytes;) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, build.bytes - offset), offset)
        if (bytesRead === 0) throw new Error('Windows native boundary extent changed')
        hash.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
      if ((await file.read(buffer, 0, 1, build.bytes)).bytesRead || hash.digest('hex') !== build.sha256)
        throw new Error('Windows native boundary differs from its fixed build')
      const after = await file.stat({ bigint: true }),
        current = await lstat(filename, { bigint: true })
      if (
        after.dev !== before.dev ||
        after.ino !== before.ino ||
        after.size !== before.size ||
        after.mtimeNs !== before.mtimeNs ||
        after.ctimeNs !== before.ctimeNs ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.isSymbolicLink()
      )
        throw new Error('Windows native boundary changed during its read')
      // Bypass a caller-shaped require.cache entry. This is fixed installed
      // application code; the library performs actual HANDLE/DACL operations.
      const actualModule = { exports: {} }
      process.dlopen(actualModule, filename)
      const candidate = actualModule.exports as WindowsBoundary
      if (
        typeof candidate.inspectPath !== 'function' ||
        typeof candidate.inspectDescriptor !== 'function' ||
        typeof candidate.createDirectory !== 'function' ||
        typeof candidate.createFile !== 'function' ||
        typeof candidate.retryCleanup !== 'function' ||
        typeof candidate.acquireImage !== 'function' ||
        typeof candidate.checkImage !== 'function' ||
        typeof candidate.releaseImage !== 'function'
      )
        throw new Error('Windows native boundary ABI differs')
      nativeBoundary = candidate
    } catch (cause) {
      failed = true
      failure = cause
    }
    try {
      await file.close()
    } catch (error_) {
      retainedLoad = new Brc38PrivateFilesystemCleanupError(failed ? failure : undefined, error_, async () => {
        await file.close()
      })
      throw retainedLoad
    }
    if (failed) throw failure
    if (nativeBoundary === undefined) throw new Error('Windows native boundary loading did not complete')
    return nativeBoundary
  })().finally(() => {
    loadingBoundary = undefined
  })
  return loadingBoundary
}
function nativeCall<T>(boundary: WindowsBoundary, call: () => T): T {
  try {
    return call()
  } catch (cause) {
    if ((cause as { code?: unknown })?.code === 'BRC38_WINDOWS_CLEANUP_RETAINED')
      throw new Brc38PrivateFilesystemCleanupError(cause, cause, async () => {
        boundary.retryCleanup()
      })
    throw cause
  }
}
function matches(stat: BigIntStats, actual: NativeIdentity, directory: boolean): void {
  if (
    stat.dev.toString() !== actual.device ||
    stat.ino.toString() !== actual.inode ||
    (!directory && stat.size.toString() !== actual.bytes)
  )
    throw new Error('Actual Windows physical identity differs')
}
function unixPrivacy(stat: BigIntStats, directory: boolean): void {
  const uid = process.geteuid?.()
  if (uid === undefined || stat.uid !== BigInt(uid) || (stat.mode & 0o777n) !== (directory ? 0o700n : 0o600n))
    throw new Error('Actual Unix private ownership or mode differs')
}
export async function requirePrivatePath(filename: string, directory: boolean): Promise<BigIntStats> {
  const stat = await lstat(filename, { bigint: true })
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n))
    throw new Error('Actual private file type or link count differs')
  if (process.platform === 'win32') {
    const boundary = await windowsBoundary()
    matches(
      stat,
      nativeCall(boundary, () => boundary.inspectPath(filename, directory)),
      directory
    )
  } else unixPrivacy(stat, directory)
  return stat
}
export async function requirePrivateDescriptor(file: FileHandle, directory = false): Promise<BigIntStats> {
  const stat = await file.stat({ bigint: true })
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n)
    throw new Error('Actual private descriptor type or link count differs')
  if (process.platform === 'win32') {
    if (!Number.isSafeInteger(file.fd) || file.fd < 0) throw new Error('Actual private descriptor is closed')
    const boundary = await windowsBoundary()
    matches(
      stat,
      nativeCall(boundary, () => boundary.inspectDescriptor(file.fd, directory)),
      directory
    )
  } else unixPrivacy(stat, directory)
  return stat
}
export async function createPrivateDirectory(filename: string): Promise<void> {
  if (process.platform === 'win32') {
    const boundary = await windowsBoundary()
    const actual = nativeCall(boundary, () => boundary.createDirectory(filename))
    matches(await requirePrivatePath(filename, true), actual, true)
  } else {
    await mkdir(filename, { mode: 0o700 })
    await requirePrivatePath(filename, true)
  }
}
export async function createPrivateFile(filename: string, readable = false): Promise<FileHandle> {
  let created: NativeIdentity | undefined
  if (process.platform === 'win32') {
    const boundary = await windowsBoundary()
    created = nativeCall(boundary, () => boundary.createFile(filename))
  }
  const file = await open(
    filename,
    process.platform === 'win32' ? (readable ? constants.O_RDWR : constants.O_WRONLY) : readable ? 'wx+' : 'wx',
    0o600
  )
  try {
    const stat = await requirePrivateDescriptor(file)
    if (created !== undefined) matches(stat, created, false)
    const named = await requirePrivatePath(filename, false)
    if (named.dev !== stat.dev || named.ino !== stat.ino) throw new Error('Created private file pathname changed')
    return file
  } catch (cause) {
    try {
      await file.close()
    } catch (error_) {
      throw new Brc38PrivateFilesystemCleanupError(cause, error_, async () => {
        await file.close()
      })
    }
    throw cause
  }
}
/** Private creation from birth on Windows; random names are DATA, never a
 * profile grant. Existing foreign paths are never adopted or permission-fixed. */
export async function createPrivateTemporaryDirectory(prefix: string): Promise<string> {
  for (let attempt = 0; attempt < 16; attempt++) {
    const directory = prefix + randomBytes(18).toString('hex')
    try {
      await createPrivateDirectory(directory)
      return directory
    } catch (cause) {
      const error = cause as { code?: unknown; win32Code?: unknown }
      if (error.code !== 'EEXIST' && error.win32Code !== 183) throw cause
    }
  }
  throw new Error('Private temporary directory names exhausted')
}

export async function closePrivateDescriptor(file: FileHandle): Promise<void> {
  try {
    await file.close()
  } catch (error_) {
    throw new Brc38PrivateFilesystemCleanupError(undefined, error_, async () => {
      await file.close()
    })
  }
}

/** Actual OS image/ancestor locks belong to this factory and remain retained
 * through process exit. Their opaque native token is not an archive/profile
 * grant. A failed physical close blocks fresh use until actual cleanup. */
export async function acquireWindowsNativeImage(
  file: FileHandle,
  filename: string
): Promise<
  Readonly<{
    check(): void
    close(): Promise<void>
  }>
> {
  if (process.platform !== 'win32' || !Number.isSafeInteger(file.fd) || file.fd < 0)
    throw new Error('Windows image requires its original open Node descriptor')
  const boundary = await windowsBoundary(),
    token = nativeCall(boundary, () => boundary.acquireImage(filename, file.fd))
  let closed = false,
    closing = false
  return Object.freeze({
    check(): void {
      if (closed || closing) throw new Error('Windows image is closing or closed')
      nativeCall(boundary, () => boundary.checkImage(token))
    },
    async close(): Promise<void> {
      if (closed) return
      closing = true
      try {
        nativeCall(boundary, () => boundary.releaseImage(token))
        closed = true
      } catch (cause) {
        if (cause instanceof Brc38PrivateFilesystemCleanupError)
          throw new Brc38PrivateFilesystemCleanupError(cause, cause.cleanupError, async () => {
            await cause.retryCleanup()
            closed = true
          })
        throw cause
      }
    }
  })
}

/** Flush the actual private directory handle. Windows needs a writable handle
 * for FlushFileBuffers; an unsupported filesystem/kernel refuses the operation
 * instead of turning directory durability into a successful no-op. Node owns
 * the asynchronous OS I/O, so the SDK flush does not block the JS event loop. */
export async function syncPrivateDirectory(directory: string): Promise<void> {
  const original = await requirePrivatePath(directory, true)
  const file = await open(
    directory,
    process.platform === 'win32' ? constants.O_RDWR : constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
  )
  let failed = false,
    failure: unknown
  try {
    const actual = await requirePrivateDescriptor(file, true)
    if (actual.dev !== original.dev || actual.ino !== original.ino)
      throw new Error('Private directory descriptor differs before flush')
    await file.sync()
    const current = await requirePrivatePath(directory, true)
    if (current.dev !== original.dev || current.ino !== original.ino)
      throw new Error('Private directory pathname changed during flush')
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    await file.close()
  } catch (error_) {
    throw new Brc38PrivateFilesystemCleanupError(failed ? failure : undefined, error_, async () => {
      await file.close()
    })
  }
  if (failed) throw failure
}
