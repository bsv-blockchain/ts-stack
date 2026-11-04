'use strict'
// Maintainer build preparation only. It compiles a candidate but never executes
// it, edits a runtime pin, publishes, deploys or admits a profile.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const retainedCompilerFailures = new WeakSet()
let compilerGroupRetained = false

class NativeCandidateBuildCleanupError extends Error {
  /** @param {unknown} cause @param {unknown} cleanupError @param {()=>Promise<void>} cleanup */
  constructor(cause, cleanupError, cleanup) {
    super('Native candidate build retains an original file descriptor', { cause })
    this.name = 'NativeCandidateBuildCleanupError'
    this.cleanupError = cleanupError
    this.cleanup = cleanup
    this.complete = false
    /** @type {Promise<void> | undefined} */ this.pending = undefined
  }
  get cleaned() {
    return this.complete
  }
  retryCleanup() {
    if (this.complete) return Promise.resolve()
    if (this.pending !== undefined) return this.pending
    this.pending = Promise.resolve()
      .then(this.cleanup)
      .then(() => {
        this.complete = true
      })
      .finally(() => {
        this.pending = undefined
      })
    return this.pending
  }
}

const {
  sqlite,
  driverSources: sources,
  unixCompilerArguments,
  assertNativeCandidateTarget
} = require('../src/storage/portable/native/source_recipe.cjs')
const flags = unixCompilerArguments('linux', 'arm64')
/** Candidate recipe selection only; actual process and worker owner remain required. */
function targetFlags() {
  return [...unixCompilerArguments(process.platform, process.arch)]
}
/** @param {Uint8Array} bytes */
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

/** Read one actual non-symlink file and reject replacement during its read.
 * @param {string} filename @param {number} maximum */
async function readSource(filename, maximum) {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  /** @type {Buffer | undefined} */ let bytes
  /** @type {unknown} */ let failure
  let failed = false
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum))
      throw new Error('Native build source exceeds its original file bound')
    bytes = Buffer.alloc(Number(before.size))
    for (let offset = 0; offset < bytes.length;) {
      const read = await file.read(bytes, offset, Math.min(65536, bytes.length - offset), offset)
      if (read.bytesRead < 1) throw new Error('Native build source extent changed')
      offset += read.bytesRead
    }
    const after = await file.stat({ bigint: true }),
      tail = Buffer.alloc(1)
    if (
      (await file.read(tail, 0, 1, bytes.length)).bytesRead !== 0 ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      before.mode !== after.mode
    )
      throw new Error('Native build source changed during capture')
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    await file.close()
  } catch (error_) {
    throw new NativeCandidateBuildCleanupError(failed ? failure : undefined, error_, () => file.close())
  }
  if (failed) throw failure
  if (bytes === undefined) throw new Error('Native candidate source capture did not finish')
  return bytes
}

/** Bounded compiler output and real child drainage. No engine execution.
 * @param {string[]} args @param {string} cwd @param {number} milliseconds */
async function compiler(args, cwd, milliseconds) {
  const child = cp.spawn('/usr/bin/cc', args, {
    cwd,
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true
  })
  /** @type {Buffer[]} */ const stdout = []
  /** @type {Buffer[]} */ const stderr = []
  let outputBytes = 0,
    stopped = false
  /** @type {Error | undefined} */ let childError
  /** @type {ReturnType<typeof setTimeout> | undefined} */ let escalation
  /** @param {NodeJS.Signals} signal */
  const signalGroup = signal => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, signal)
    } catch (cause) {
      if (cause.code !== 'ESRCH') childError = cause
    }
  }
  const groupPresent = () => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (cause) {
      if (cause.code === 'ESRCH') return false
      compilerGroupRetained = true
      retainedCompilerFailures.add(cause)
      throw cause
    }
  }
  const stop = () => {
    if (stopped) return
    stopped = true
    signalGroup('SIGTERM')
    escalation = setTimeout(() => {
      signalGroup('SIGKILL')
    }, 5000)
  }
  const timer = setTimeout(stop, milliseconds)
  /** @param {Buffer[]} target @param {Buffer} bytes */
  const collect = (target, bytes) => {
    outputBytes += bytes.length
    if (outputBytes > 65536) stop()
    else target.push(Buffer.from(bytes))
  }
  child.stdout.on('data', bytes => collect(stdout, bytes))
  child.stderr.on('data', bytes => collect(stderr, bytes))
  try {
    /** @type {Promise<{code:number|null,signal:NodeJS.Signals|null}>} */
    const closing = new Promise(resolve => {
      // An error is not physical drainage. The actual close event settles the
      // child and streams; remaining compiler descendants must also disappear.
      child.on('error', error => {
        childError = error
        stop()
      })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const result = await closing
    if (groupPresent()) {
      stopped = true
      signalGroup('SIGKILL')
      const end = performance.now() + 5000
      while (groupPresent() && performance.now() < end) await new Promise(resolve => setTimeout(resolve, 25))
      if (groupPresent()) {
        compilerGroupRetained = true
        const retained = new Error(
          'Native compiler group remains owned; stop and verify the original isolated worker before cleanup'
        )
        retainedCompilerFailures.add(retained)
        throw retained
      }
    }
    if (childError !== undefined || stopped || result.code !== 0 || result.signal !== null)
      throw new Error(
        'Native candidate compiler failed or exceeded its bound: ' + Buffer.concat(stderr).toString('utf8')
      )
    return { stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }
  } finally {
    clearTimeout(timer)
    if (escalation !== undefined) clearTimeout(escalation)
  }
}

/** Build inside a separately authorized isolated native Unix worker. This
 * function does not provision or attest that worker's resource controls.
 * Inputs/results/hashes are DATA; the actual worker owner remains required.
 * @param {{sqliteSource:string,outputDirectory:string}} options */
async function buildBrc38NativeCandidate(options) {
  if (compilerGroupRetained) throw new Error('The original compiler worker still requires physical shutdown')
  const selectedFlags = targetFlags()
  const sqliteBytes = await readSource(options.sqliteSource, sqlite.bytes)
  if (sqliteBytes.length !== sqlite.bytes || sha256(sqliteBytes) !== sqlite.sha256)
    throw new Error('Native candidate SQLite source differs from the fixed recipe')
  const root = await fs.mkdtemp(path.join(path.resolve(options.outputDirectory), 'brc38-candidate-'))
  /** @type {Record<string,{bytes:number,sha256:string}>} */ const inputs = {}
  try {
    await fs.writeFile(path.join(root, 'sqlite3.c'), sqliteBytes, { flag: 'wx', mode: 0o400 })
    inputs['sqlite3.c'] = { bytes: sqliteBytes.length, sha256: sqlite.sha256 }
    let sourceBytes = 0
    for (const name of sources) {
      const bytes = await readSource(path.join(__dirname, '../src/storage/portable/native', name), 1048576)
      sourceBytes += bytes.length
      if (sourceBytes > 2097152) throw new Error('Native candidate source set exceeds its original bound')
      await fs.writeFile(path.join(root, name), bytes, { flag: 'wx', mode: 0o400 })
      inputs[name] = { bytes: bytes.length, sha256: sha256(bytes) }
    }
    const identity = await compiler(['--version'], root, 10000),
      startedAt = new Date().toISOString(),
      output = await compiler(selectedFlags, root, 180000)
    for (const [name, expected] of Object.entries(inputs)) {
      const bytes = await readSource(path.join(root, name), expected.bytes)
      if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256)
        throw new Error('Native candidate frozen source changed during compilation')
    }
    const filename = path.join(root, 'native-candidate')
    await fs.chmod(filename, 0o500)
    const bytes = await readSource(filename, 2097152)
    assertNativeCandidateTarget(bytes, process.platform, process.arch)
    const receipt = {
      protocol: 'brc38-native-candidate-build/v1',
      startedAt,
      finishedAt: new Date().toISOString(),
      platform: process.platform,
      architecture: process.arch,
      sqlite,
      compiler: identity,
      flags: selectedFlags,
      inputs,
      output,
      candidate: { path: filename, bytes: bytes.length, sha256: sha256(bytes) },
      engineExecuted: false,
      qualified: false,
      runtimePinChanged: false,
      publicationOrDeployment: false
    }
    await fs.writeFile(path.join(root, 'build-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o400
    })
    await fs.chmod(root, 0o500)
    return receipt
  } catch (cause) {
    if (cause instanceof NativeCandidateBuildCleanupError)
      throw new NativeCandidateBuildCleanupError(cause, cause.cleanupError, async () => {
        await cause.retryCleanup()
        await fs.rm(root, { recursive: true, force: true })
      })
    if (retainedCompilerFailures.has(cause))
      throw new Error('Native candidate directory remains retained at ' + root, { cause })
    try {
      await fs.rm(root, { recursive: true, force: true })
    } catch (error_) {
      throw new AggregateError([cause, error_], 'Native candidate build retains its original directory cleanup', {
        cause
      })
    }
    throw cause
  }
}
module.exports = { buildBrc38NativeCandidate, NativeCandidateBuildCleanupError, sqlite, sources, flags }
