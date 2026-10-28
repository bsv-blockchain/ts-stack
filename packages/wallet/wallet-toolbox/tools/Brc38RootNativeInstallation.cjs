'use strict'
// Maintainer file preparation only. No engine is executed and no returned
// object can grant an SDK descriptor. The isolated worker owner must bound
// filesystem I/O and stop the original worker on unproved physical cleanup.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { assertNativeCandidateTarget } = require('../src/storage/portable/native/source_recipe.cjs')
const { NativeCandidateBuildCleanupError } = require('./Brc38NativeCandidateBuild.cjs')
const retained = new Set()

function parseDarwinInstallationArguments(args) {
  if (args.length !== 2 || args[0] !== '--source') throw new Error('Usage: --source /absolute/native-candidate')
  normalized(args[1])
  return Object.freeze({ source: args[1] })
}
function normalized(filename) {
  if (
    typeof filename !== 'string' ||
    !path.isAbsolute(filename) ||
    path.normalize(filename) !== filename ||
    filename.includes('\0')
  )
    throw new Error('Root native preparation requires normalized absolute paths')
}
/** Pure role/target DATA; never permission to run an installation. */
function planDarwinInstallationHost(platform, architecture, node, abi, uid, euid) {
  if (
    platform !== 'darwin' ||
    !['arm64', 'x64'].includes(architecture) ||
    node !== 'v24.18.0' ||
    abi !== '137' ||
    uid !== 0 ||
    euid !== 0
  )
    throw new Error('Darwin native installation requires its actual root Node24.18.0 ABI137 worker')
  return Object.freeze({ platform, architecture, nodeVersion: node, nodeABI: abi, uid, euid })
}
/** Path comparison DATA. Actual callers separately select the static registry. */
function darwinNativeInstallationPath(pin) {
  if (
    pin?.platform !== 'darwin' ||
    !['arm64', 'x64'].includes(pin.architecture) ||
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes < 64 ||
    pin.bytes > 2097152 ||
    !/^[a-f0-9]{64}$/.test(pin.sha256)
  )
    throw new Error('Darwin native installation requires an exact component build')
  return `/Library/Application Support/BSV Wallet/native/${pin.architecture}/${pin.sha256}/native-contract`
}
function actualPin() {
  const pin = require('../out/src/storage/portable/Brc38NativeExecutable.cjs').qualifiedNativeComponentBuild()
  if (
    pin === undefined ||
    pin.platform !== process.platform ||
    pin.architecture !== process.arch ||
    !Number.isSafeInteger(pin.bytes) ||
    pin.bytes < 64 ||
    pin.bytes > 2097152 ||
    !/^[a-f0-9]{64}$/.test(pin.sha256)
  )
    throw new Error('Root native preparation component platform is not qualified')
  return pin
}
function inspectDarwinInstallationHost() {
  const host = planDarwinInstallationHost(
      process.platform,
      process.arch,
      process.version,
      process.versions.modules,
      process.getuid?.(),
      process.geteuid?.()
    ),
    pin = actualPin()
  return Object.freeze({ ...host, pin, destination: darwinNativeInstallationPath(pin) })
}
const same = (a, b, fields) => fields.every(key => a[key] === b[key])
const directoryFields = ['dev', 'ino', 'uid', 'mode']
const fileFields = ['dev', 'ino', 'uid', 'mode', 'size', 'nlink', 'mtimeNs', 'ctimeNs']
async function rootDirectory(filename, expected) {
  const s = await fs.lstat(filename, { bigint: true })
  if (
    !s.isDirectory() ||
    s.isSymbolicLink() ||
    s.uid !== 0n ||
    (s.mode & 0o022n) !== 0n ||
    (expected && !same(s, expected, directoryFields))
  )
    throw new Error('Root native preparation directory identity or ordinary mode differs')
  return s
}

/** Actual exclusive file-copy primitive, also exercised on private Linux root
 * fixtures. Root UID, actual target and immutable registry are read internally.
 * POSIX/root ownership is not a Darwin ACL verdict; the ordinary wallet actor
 * must subsequently use the original SDK protected-path checks and contracts.
 * Failed files remain as evidence; this function never unlinks a pathname.
 * @param {string} source @param {string} directory */
async function copyPinnedRootOwnedExecutable(source, directory) {
  if (retained.size !== 0) throw new Error('Original root native installation descriptors remain retained')
  if (
    !['linux', 'darwin'].includes(process.platform) ||
    process.version !== 'v24.18.0' ||
    process.versions.modules !== '137' ||
    process.getuid?.() !== 0 ||
    process.geteuid?.() !== 0
  )
    throw new Error('Root native preparation requires its actual supported root Node worker')
  const pin = actualPin()
  normalized(source)
  normalized(directory)
  const destination = path.join(directory, 'native-contract'),
    originalDirectory = await rootDirectory(directory),
    handles = new Set()
  let failure,
    result,
    failed = false
  try {
    const parent = await fs.open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    handles.add(parent)
    if (!same(await parent.stat({ bigint: true }), originalDirectory, directoryFields))
      throw new Error('Root native preparation parent capture differs')
    const input = await fs.open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    handles.add(input)
    const before = await input.stat({ bigint: true })
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size !== BigInt(pin.bytes) ||
      (before.mode & 0o222n) !== 0n ||
      (before.mode & 0o111n) === 0n
    )
      throw new Error('Root native preparation requires its immutable exact source file')
    await rootDirectory(directory, originalDirectory)
    const output = await fs.open(
      destination,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o500
    )
    handles.add(output)
    const created = await output.stat({ bigint: true }),
      hash = crypto.createHash('sha256'),
      buffer = Buffer.alloc(Math.min(65536, pin.bytes)),
      header = Buffer.alloc(64)
    for (let offset = 0; offset < pin.bytes;) {
      const read = await input.read(buffer, 0, Math.min(buffer.length, pin.bytes - offset), offset)
      if (read.bytesRead === 0) throw new Error('Root native preparation source was truncated')
      hash.update(buffer.subarray(0, read.bytesRead))
      if (offset < header.length) buffer.copy(header, offset, 0, Math.min(read.bytesRead, header.length - offset))
      for (let written = 0; written < read.bytesRead;) {
        const w = await output.write(buffer, written, read.bytesRead - written, offset + written)
        if (w.bytesWritten === 0) throw new Error('Root native preparation target write made no progress')
        written += w.bytesWritten
      }
      offset += read.bytesRead
    }
    if (
      (await input.read(Buffer.alloc(1), 0, 1, pin.bytes)).bytesRead !== 0 ||
      hash.digest('hex') !== pin.sha256 ||
      !same(before, await input.stat({ bigint: true }), fileFields)
    )
      throw new Error('Root native preparation source differs from its exact fixed build')
    assertNativeCandidateTarget(header, process.platform, process.arch)
    const copied = await output.stat({ bigint: true })
    if (
      !copied.isFile() ||
      copied.uid !== 0n ||
      copied.nlink !== 1n ||
      copied.size !== BigInt(pin.bytes) ||
      copied.dev !== created.dev ||
      copied.ino !== created.ino ||
      (copied.mode & 0o777n) !== 0o500n
    )
      throw new Error('Root native preparation exclusive target identity differs')
    const posthash = crypto.createHash('sha256')
    for (let offset = 0; offset < pin.bytes;) {
      const read = await output.read(buffer, 0, Math.min(buffer.length, pin.bytes - offset), offset)
      if (read.bytesRead === 0) throw new Error('Root native preparation target was truncated')
      posthash.update(buffer.subarray(0, read.bytesRead))
      offset += read.bytesRead
    }
    if ((await output.read(Buffer.alloc(1), 0, 1, pin.bytes)).bytesRead !== 0 || posthash.digest('hex') !== pin.sha256)
      throw new Error('Root native preparation actual target bytes differ')
    await output.sync()
    await rootDirectory(directory, originalDirectory)
    await output.chmod(0o555)
    await output.sync()
    await parent.sync()
    await rootDirectory(directory, originalDirectory)
    const actual = await fs.lstat(destination, { bigint: true }),
      final = await output.stat({ bigint: true })
    if (!same(actual, final, fileFields) || actual.uid !== 0n || (actual.mode & 0o777n) !== 0o555n)
      throw new Error('Root native preparation final original file differs')
    result = Object.freeze({
      protocol: 'brc38-root-native-copy/v1',
      destination,
      pin,
      bytes: Number(actual.size),
      sha256: pin.sha256,
      rootOwned: true,
      mode: 0o555,
      engineExecuted: false,
      runtimeAdmitted: false,
      runtimePinChanged: false,
      darwinACLQualified: false,
      hostEnrolled: false,
      providerQualified: false,
      fullSystemQualified: false
    })
  } catch (cause) {
    failed = true
    failure = cause
  }
  const close = async () => {
    const errors = []
    for (const h of [...handles].reverse()) {
      try {
        await h.close()
        handles.delete(h)
      } catch (cause) {
        errors.push(cause)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Original root native installation descriptor close failed')
  }
  try {
    await close()
  } catch (error_) {
    let owner
    owner = new NativeCandidateBuildCleanupError(failure, error_, async () => {
      await close()
      retained.delete(owner)
    })
    retained.add(owner)
    throw owner
  }
  if (failed) throw failure
  return result
}

async function installDarwinNativeCandidate(options) {
  const host = inspectDarwinInstallationHost()
  normalized(options.source)
  const directories = [
      '/',
      '/Library',
      '/Library/Application Support',
      '/Library/Application Support/BSV Wallet',
      '/Library/Application Support/BSV Wallet/native',
      `/Library/Application Support/BSV Wallet/native/${host.architecture}`,
      path.dirname(host.destination)
    ],
    captured = []
  for (const directory of directories) {
    // Only create missing directories below the fixed product installation.
    if (directories.indexOf(directory) >= 3) {
      try {
        await fs.mkdir(directory, { mode: 0o755 })
      } catch (cause) {
        if (cause.code !== 'EEXIST') throw cause
      }
    }
    captured.push(await rootDirectory(directory))
  }
  const result = await copyPinnedRootOwnedExecutable(options.source, path.dirname(host.destination))
  for (let n = 0; n < directories.length; n++) await rootDirectory(directories[n], captured[n])
  return result
}
module.exports = {
  parseDarwinInstallationArguments,
  planDarwinInstallationHost,
  darwinNativeInstallationPath,
  inspectDarwinInstallationHost,
  copyPinnedRootOwnedExecutable,
  installDarwinNativeCandidate
}
