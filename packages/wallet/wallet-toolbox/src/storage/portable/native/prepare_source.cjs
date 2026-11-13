'use strict'

// Internal build-source preparation only. This module never compiles, launches
// a native engine, advertises capability or qualifies a wallet. The admitted
// Linux supervisor must separately bind source/runtime/controller/resources,
// execute the compiler and validate/pin each resulting platform artifact.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { driverSources, windowsAddonSources, sqliteFiles, unixCompilerArguments } = require('./source_recipe.cjs')
const ownFiles = Object.freeze([...driverSources, ...windowsAddonSources])
/** Failed disposal retains its actual descriptors/directory and an awaited
 * retry. It is never a successful build receipt or a claimed physical drain. */
class NativeSourceCleanupError extends AggregateError {
  #busy = false
  #done = false
  /** @param {unknown[]} causes @param {()=>Promise<void>} cleanup */
  constructor(causes, cleanup) {
    super(causes, 'Native source preparation retains physical cleanup')
    this.cleanup = cleanup
  }
  async retryCleanup() {
    if (this.#done) return
    if (this.#busy) throw new Error('Native source disposal is already owned')
    this.#busy = true
    try {
      await this.cleanup()
      this.#done = true
    } finally {
      this.#busy = false
    }
  }
}
/** @param {import('node:fs/promises').FileHandle[]} files
 * @param {{error:unknown}|undefined} failure */
async function closeDescriptors(files, failure) {
  const pending = [],
    errors = []
  for (const file of files) {
    try {
      await file.close()
    } catch (error) {
      pending.push(file)
      errors.push(error)
    }
  }
  if (errors.length)
    throw new NativeSourceCleanupError(
      failure ? [failure.error, ...errors] : errors,
      async () => await closeDescriptors(pending, undefined)
    )
}
/** @param {string} from @param {string} to @param {number} maximum
 * @param {Readonly<{bytes:number,sha256:string}>} [expected]
 */
async function copyInput(from, to, maximum, expected) {
  const source = await fs.open(from, constants.O_RDONLY | constants.O_NOFOLLOW)
  let target, failure
  try {
    const before = await source.stat({ bigint: true })
    if (!before.isFile() || before.size < 1n || before.size > BigInt(maximum))
      throw new Error('Native build source extent differs')
    target = await fs.open(to, 'wx', 0o600)
    const digest = crypto.createHash('sha256'),
      buffer = Buffer.alloc(65536)
    let offset = 0
    while (offset < Number(before.size)) {
      const read = await source.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset)
      if (read.bytesRead < 1) throw new Error('Native build source truncated during preparation')
      digest.update(buffer.subarray(0, read.bytesRead))
      let written = 0
      while (written < read.bytesRead) {
        const result = await target.write(buffer, written, read.bytesRead - written, offset + written)
        if (result.bytesWritten < 1) throw new Error('Native build source copy made no progress')
        written += result.bytesWritten
      }
      offset += read.bytesRead
    }
    const after = await source.stat({ bigint: true }),
      sha256 = digest.digest('hex')
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      (expected && (offset !== expected.bytes || sha256 !== expected.sha256))
    )
      throw new Error('Native build source changed or differs from pinned dependency data')
    await target.sync()
    await target.chmod(0o400)
    return Object.freeze({ name: path.basename(to), bytes: offset, sha256 })
  } catch (error) {
    failure = { error }
    throw error
  } finally {
    await closeDescriptors(target ? [target, source] : [source], failure)
  }
}
/** Prepares immutable bounded source files in an owned temporary directory.
 * Returned compiler arguments are a PLAN: no compiler/engine runs here.
 * @param {string} sqliteDirectory @param {string} parentDirectory
 * @param {{platform:string,architecture:string}} [target]
 */
async function prepareNativeSource(sqliteDirectory, parentDirectory, target) {
  const selectedTarget = target === undefined ? { platform: process.platform, architecture: process.arch } : target
  const argumentsPlan = unixCompilerArguments(selectedTarget.platform, selectedTarget.architecture)
  const directory = await fs.mkdtemp(path.join(parentDirectory, 'wallet-native-source-'))
  try {
    await fs.chmod(directory, 0o700)
    const inputs = []
    for (const name of ownFiles)
      inputs.push(await copyInput(path.join(__dirname, name), path.join(directory, name), 131072))
    for (const input of sqliteFiles)
      inputs.push(
        await copyInput(path.join(sqliteDirectory, input.name), path.join(directory, input.name), input.bytes, input)
      )
    const source = {
      protocol: 'brc38-native-build-source/v2',
      abi: 2,
      platform: selectedTarget.platform,
      architecture: selectedTarget.architecture,
      inputs: Object.freeze(inputs),
      compiled: false,
      engineExecuted: false,
      qualified: false,
      compiler: Object.freeze({
        program: 'cc',
        cwd: directory,
        arguments: argumentsPlan
      })
    }
    const manifest = JSON.stringify(source),
      manifestSha256 = crypto.createHash('sha256').update(manifest).digest('hex')
    const handle = await fs.open(path.join(directory, 'source.json'), 'wx', 0o600)
    let manifestFailure
    try {
      await handle.writeFile(manifest)
      await handle.sync()
      await handle.chmod(0o400)
    } catch (error) {
      manifestFailure = { error }
      throw error
    } finally {
      await closeDescriptors([handle], manifestFailure)
    }
    return Object.freeze({ directory, manifestSha256, source: Object.freeze(source) })
  } catch (error) {
    const dispose = async () => {
      if (error instanceof NativeSourceCleanupError) await error.retryCleanup()
      await fs.rm(directory, { recursive: true })
    }
    if (error instanceof NativeSourceCleanupError) throw new NativeSourceCleanupError([error], dispose)
    try {
      await dispose()
    } catch (error_) {
      throw new NativeSourceCleanupError([error, error_], dispose)
    }
    throw error
  }
}
// Internal bounded file DATA copier, also used by package artifact preparation.
// Exporting it grants no compiler/runtime/source/profile admission.
module.exports = Object.freeze({ prepareNativeSource, NativeSourceCleanupError, copyNativeSourceInput: copyInput })
