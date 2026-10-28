'use strict'

// Additive build artifact preparation only, after ordinary tsc succeeds.
// No compilation, native process, SDK/SQLite import, engine pin or qualification
// runs here. A receipt identifies bytes only; each consumer remains qualified
// independently from the exact source/runtime/controller/actor admission.
const fs = require('node:fs/promises')
const path = require('node:path')
const { copyNativeSourceInput, NativeSourceCleanupError } = require('./prepare_source.cjs')
const { driverSources, windowsAddonSources } = require('./source_recipe.cjs')
const assets = Object.freeze([
  'NativeProfileSqlite.cjs',
  'Brc38NativeExecutable.cjs',
  'native/prepare_source.cjs',
  'native/source_recipe.cjs',
  ...[...driverSources, ...windowsAddonSources].map(name => 'native/' + name)
])
const compiled = Object.freeze([
  'Brc38NativeBlobProtocol.js',
  'Brc38PrivateChunkPipe.js',
  'Brc38PrivateFilesystemNode.js',
  'Brc38StagingCleanupError.js'
])
/** Never follow a destination directory or artifact symlink. All operations
 * affect fixed public build paths; private SQLite/native runtime files are not
 * build assets and never enter this whitelist.
 * @param {string} directory */
async function directory(directory) {
  try {
    await fs.mkdir(directory)
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
  }
  const actual = await fs.lstat(directory)
  if (!actual.isDirectory() || actual.isSymbolicLink()) throw new Error('Native build destination directory differs')
}
/** @param {string} filename */
async function existingFile(filename) {
  try {
    const actual = await fs.lstat(filename)
    if (!actual.isFile() || actual.isSymbolicLink()) throw new Error('Native build destination artifact differs')
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}
/** @param {string} [packageRoot] */
async function copyWalletNativeArtifacts(packageRoot = path.resolve(__dirname, '../../../..')) {
  const root = path.resolve(packageRoot),
    source = path.join(root, 'src/storage/portable'),
    output = path.join(root, 'out/src/storage/portable')
  // These actual tsc outputs must already exist. Inspect/copy their complete
  // bounded bytes without loading their SDK dependencies or executing them.
  for (const name of ['', 'out', 'out/src', 'out/src/storage', 'out/src/storage/portable']) {
    const parent = await fs.lstat(path.join(root, name))
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Ordinary compiled wallet output is required')
  }
  const stage = await fs.mkdtemp(path.join(output, '.native-artifact-source-'))
  let manifestHandle,
    manifestClosed = true
  const dispose = async () => {
    if (!manifestClosed) {
      await manifestHandle.close()
      manifestClosed = true
    }
    await fs.rm(stage, { recursive: true, force: true })
  }
  try {
    const records = [],
      runtime = []
    for (let index = 0; index < compiled.length; index++) {
      const input = compiled[index],
        copied = await copyNativeSourceInput(path.join(output, input), path.join(stage, 'compiled-' + index), 262144)
      runtime.push(Object.freeze({ path: input, bytes: copied.bytes, sha256: copied.sha256 }))
    }
    for (let index = 0; index < assets.length; index++) {
      const input = assets[index],
        copied = await copyNativeSourceInput(path.join(source, input), path.join(stage, 'asset-' + index), 131072)
      await fs.chmod(path.join(stage, 'asset-' + index), 0o644)
      records.push(Object.freeze({ path: input, bytes: copied.bytes, sha256: copied.sha256 }))
    }
    const receipt = Object.freeze({
        protocol: 'brc38-native-source-artifacts/v1',
        compiled: Object.freeze(runtime),
        assets: Object.freeze(records),
        engineCompiled: false,
        engineExecuted: false,
        qualified: false
      }),
      text = JSON.stringify(receipt) + '\n',
      manifest = path.join(output, 'native/source-artifacts.json')
    if (Buffer.byteLength(text) > 16384) throw new Error('Native source artifact receipt exceeds its fixed bound')
    await directory(path.join(output, 'native'))
    await existingFile(manifest)
    // A partially installed cohort carries no successful final receipt. All
    // inputs were staged and independently hashed before the first replacement.
    await fs.rm(manifest, { force: true })
    for (let index = 0; index < assets.length; index++) {
      const destination = path.join(output, assets[index])
      await existingFile(destination)
      await fs.rename(path.join(stage, 'asset-' + index), destination)
    }
    // Independently reread actual installed files and compiled siblings. A
    // recorded source digest alone proves no successful package postimage.
    for (const [index, record] of [...runtime, ...records].entries()) {
      const actual = await copyNativeSourceInput(
        path.join(output, record.path),
        path.join(stage, 'postimage-' + index),
        262144
      )
      if (actual.bytes !== record.bytes || actual.sha256 !== record.sha256)
        throw new Error('Native source artifact postimage changed during installation')
    }
    manifestHandle = await fs.open(path.join(stage, 'source-artifacts.json'), 'wx', 0o644)
    manifestClosed = false
    await manifestHandle.writeFile(text)
    await manifestHandle.sync()
    await manifestHandle.close()
    manifestClosed = true
    await fs.rename(path.join(stage, 'source-artifacts.json'), manifest)
    await dispose()
    return receipt
  } catch (cause) {
    const cleanup = async () => {
      if (cause instanceof NativeSourceCleanupError) await cause.retryCleanup()
      await dispose()
    }
    try {
      await cleanup()
    } catch (error_) {
      throw new NativeSourceCleanupError([cause, error_], cleanup)
    }
    throw cause
  }
}
module.exports = Object.freeze({ copyWalletNativeArtifacts, assets, compiled })
if (require.main === module)
  copyWalletNativeArtifacts().catch(async error => {
    if (error instanceof NativeSourceCleanupError) {
      try {
        await error.retryCleanup()
      } catch (error_) {
        process.stderr.write(String(error_) + '\n')
      }
    }
    process.stderr.write(String(error) + '\n')
    process.exitCode = 1
  })
