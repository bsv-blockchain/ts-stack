'use strict'
const { constants } = require('node:fs')
const fs = require('node:fs/promises')
const crypto = require('node:crypto')
const path = require('node:path')
const { runInSeries } = require('../../utility/runInSeries.js')
const { acquireWindowsNativeImage } = require('./Brc38PrivateFilesystemNode.js')
const { Brc38StagingCleanupError } = require('./Brc38StagingCleanupError.js')
// Exact Linux ARM64/x64 component builds qualified by the original native runtime,
// WAL/DELETE, profile, private-stage, range and committed-writer recovery
// contracts plus independent shared-quota, cell-comparison and old/new local
// observer/pointer-group guard, rollback and drain contracts.
// This is not a cross-platform release policy, complete provider
// qualification or a profile/inventory activation grant.
const componentBuild = Object.freeze({
  platform: 'linux',
  architecture: 'arm64',
  bytes: 1353552,
  sha256: '295ae7b2511b7565dd49ed352ba9e8de5cf6b924c89cb021e1d9ec5bcac929dd'
})
// Only qualified exact builds belong here. Candidate build receipts cannot
// populate this registry at runtime or replace a missing platform entry.
/** @type {Readonly<Record<string, typeof componentBuild | undefined>>} */
const componentBuilds = Object.freeze({
  'linux/arm64': componentBuild,
  'linux/x64': Object.freeze({
    platform: 'linux',
    architecture: 'x64',
    bytes: 1381576,
    sha256: '4ae3984e9c4a89dd3628ae9ff86613f61c3813f281ac6c16dedbe98279dd4af1'
  })
})
/** Read-only build metadata for maintainer preflight, never executable admission.
 * Only the original file factory can capture a runtime launch descriptor.
 * @param {string} platform @param {string} architecture */
function qualifiedNativeComponentBuild(platform = process.platform, architecture = process.arch) {
  return componentBuilds[`${platform}/${architecture}`]
}
// Independently qualified compiler supervisor, never the wallet kernel. Empty
// until fresh Windows toolchain/controller qualification binds exact bytes.
/** @type {Readonly<Record<string, typeof componentBuild | undefined>>} */
const supervisorBuilds = Object.freeze({})
/** @type {WeakMap<import('node:fs/promises').FileHandle,
 * {filename:string,original:import('node:fs').BigIntStats,build:typeof componentBuild,
 * registry:typeof componentBuilds,
 * image?:Readonly<{check():void,close():Promise<void>}>,imageClosed?:boolean}>} */
const openedExecutables = new WeakMap()

/** Check effective ordinary-user access too: ACLs can grant writes even when
 * POSIX group/other mode bits are clear. Any other access error fails closed.
 * @param {string} filename */
async function denyCurrentUserWrite(filename) {
  let writable = true
  try {
    await fs.access(filename, constants.W_OK)
  } catch (cause) {
    if (/** @type {NodeJS.ErrnoException} */ (cause).code !== 'EACCES') throw cause
    writable = false
  }
  if (writable) throw new Error('Native macOS installation is writable through the current user or ACL')
}

/** Darwin has no Linux proc-fd execution path. Its pathname launch requires
 * an independently installed root-owned chain that the non-root wallet user
 * cannot rename, replace or write. Never fall back to a writable package path.
 * @param {string} filename @param {import('node:fs').BigIntStats} original */
async function protectedDarwinPath(filename, original) {
  const uid = process.geteuid?.()
  if (
    uid === undefined ||
    uid === 0 ||
    uid !== process.getuid?.() ||
    original.uid !== 0n ||
    !filename.startsWith('/Library/Application Support/BSV Wallet/native/') ||
    !path.isAbsolute(filename) ||
    path.normalize(filename) !== filename
  )
    throw new Error('Native macOS executable requires its protected root-owned installation')
  const actual = await fs.lstat(filename, { bigint: true })
  if (
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    actual.dev !== original.dev ||
    actual.ino !== original.ino ||
    actual.mode !== original.mode ||
    actual.uid !== 0n ||
    actual.nlink !== 1n ||
    actual.size !== original.size ||
    actual.mtimeNs !== original.mtimeNs ||
    actual.ctimeNs !== original.ctimeNs
  )
    throw new Error('Native macOS executable pathname differs from its original descriptor')
  await denyCurrentUserWrite(filename)
  let directory = path.dirname(filename)
  for (let count = 0; count < 32; count++) {
    const entry = await fs.lstat(directory, { bigint: true })
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0n || (entry.mode & 0o022n) !== 0n)
      throw new Error('Native macOS executable has a replaceable pathname ancestor')
    await denyCurrentUserWrite(directory)
    const parent = path.dirname(directory)
    if (parent === directory) return filename
    directory = parent
  }
  throw new Error('Native macOS executable pathname exceeds its fixed ancestry bound')
}
/** @param {string} filename @param {typeof componentBuilds} registry */
async function openFixedExecutable(filename, registry) {
  const build = registry[`${process.platform}/${process.arch}`]
  if (build === undefined) throw new Error('Native component platform is not qualified')
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  /** @type {Readonly<{check():void,close():Promise<void>}> | undefined} */
  let image
  try {
    const before = await file.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(build.bytes) ||
      (process.platform !== 'win32' && ((before.mode & 0o222n) !== 0n || (before.mode & 0o111n) === 0n))
    )
      throw new Error('Native component requires its immutable executable file')
    if (process.platform === 'win32') image = await acquireWindowsNativeImage(file, filename)
    const bytes = Buffer.alloc(build.bytes)
    let offset = 0
    function* remainingReads() {
      while (offset < bytes.length) yield offset
    }
    await runInSeries(remainingReads(), async () => {
      const read = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset)
      if (read.bytesRead === 0) throw new Error('Native component executable extent differs')
      offset += read.bytesRead
    })
    const tail = Buffer.alloc(1)
    if ((await file.read(tail, 0, 1, bytes.length)).bytesRead !== 0)
      throw new Error('Native component executable extent differs')
    const after = await file.stat({ bigint: true })
    if (
      bytes.length !== build.bytes ||
      crypto.createHash('sha256').update(bytes).digest('hex') !== build.sha256 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.mode !== after.mode
    )
      throw new Error('Native component executable differs from its fixed build')
    if (process.platform === 'darwin') await protectedDarwinPath(filename, after)
    image?.check()
    openedExecutables.set(file, { filename, original: after, build, registry, image, imageClosed: false })
    return file
  } catch (error) {
    const cleanup = async () => {
      if (error instanceof Brc38StagingCleanupError) await error.retryCleanup()
      await image?.close()
      await file.close()
    }
    try {
      await cleanup()
    } catch (error_) {
      throw new Brc38StagingCleanupError(
        [error, error_],
        'Native executable retains actual image/descriptor cleanup',
        cleanup
      )
    }
    throw error
  }
}
/** @param {string} filename */
async function openPinnedNativeExecutable(filename) {
  return await openFixedExecutable(filename, componentBuilds)
}
/** Build preparation has a separate fixed artifact role and no wallet grant.
 * @param {string} filename */
async function openPinnedWindowsBuildSupervisor(filename) {
  if (process.platform !== 'win32') throw new Error('Windows compiler supervisor requires its original Windows worker')
  return await openFixedExecutable(filename, supervisorBuilds)
}
/** Select a launch mechanism only for this factory's actual still-open file.
 * The original caller keeps the descriptor until the actual child exit.
 * @param {import('node:fs/promises').FileHandle} file */
async function pinnedNativeLaunchPath(file) {
  const owned = openedExecutables.get(file)
  if (owned === undefined) throw new Error('Native launch requires its original pinned executable descriptor')
  const actual = await file.stat({ bigint: true }),
    original = owned.original
  if (
    file.fd < 0 ||
    actual.dev !== original.dev ||
    actual.ino !== original.ino ||
    actual.size !== original.size ||
    actual.mode !== original.mode ||
    actual.mtimeNs !== original.mtimeNs ||
    actual.ctimeNs !== original.ctimeNs ||
    actual.nlink !== 1n ||
    owned.build !== owned.registry[`${process.platform}/${process.arch}`]
  )
    throw new Error('Native pinned executable changed before launch')
  if (process.platform === 'linux') return '/proc/self/fd/4'
  if (process.platform === 'darwin') return await protectedDarwinPath(owned.filename, actual)
  if (process.platform === 'win32' && owned.image !== undefined && !owned.imageClosed) {
    owned.image.check()
    return owned.filename
  }
  throw new Error('Native pinned executable has no owned platform launch mechanism')
}
/** Original image/ancestor locks survive until the real child close event.
 * Failed teardown retains the concrete original objects for retry.
 * @param {import('node:fs/promises').FileHandle} file */
async function closePinnedNativeExecutable(file) {
  const owned = openedExecutables.get(file)
  if (owned === undefined) throw new Error('Native executable close requires its original factory descriptor')
  /** @type {import('./Brc38StagingCleanupError.js').Brc38StagingCleanupError | undefined} */
  let pending
  const cleanup = async () => {
    if (pending !== undefined) {
      await pending.retryCleanup()
      owned.imageClosed = true
      pending = undefined
    }
    if (owned.image !== undefined && !owned.imageClosed) {
      try {
        await owned.image.close()
        owned.imageClosed = true
      } catch (cause) {
        if (cause instanceof Brc38StagingCleanupError) pending = cause
        throw cause
      }
    }
    await file.close()
    openedExecutables.delete(file)
  }
  try {
    await cleanup()
  } catch (cause) {
    throw new Brc38StagingCleanupError([cause], 'Native executable retains original close ownership', cleanup)
  }
}
module.exports = {
  openPinnedNativeExecutable,
  openPinnedWindowsBuildSupervisor,
  pinnedNativeLaunchPath,
  closePinnedNativeExecutable,
  qualifiedNativeComponentBuild,
  componentBuild
}
