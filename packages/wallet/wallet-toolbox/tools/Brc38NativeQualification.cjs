'use strict'
// Maintainer qualification/delivery only. The caller must provision and attest
// the isolated worker. This tool never enrolls a wallet, changes a runtime pin,
// publishes, deploys, or treats component checks as full provider qualification.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { NativeCandidateBuildCleanupError, sources, sqlite } = require('./Brc38NativeCandidateBuild.cjs')
const { assertNativeCandidateTarget } = require('../src/storage/portable/native/source_recipe.cjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))

/** Bounded failure DATA for inspection; never a candidate or authority grant. */
function qualificationFailureData(cause) {
  const seen = new Set()
  let remaining = 8
  const visit = (value, depth) => {
    if (value === undefined) return undefined
    if (value === null || typeof value !== 'object') return String(value).slice(-1024)
    if (depth > 4 || remaining-- <= 0 || seen.has(value)) return '[diagnostic bound]'
    seen.add(value)
    const data = {}
    for (const key of ['name', 'message', 'stack', 'stdout', 'stderr'])
      if (typeof value[key] === 'string') data[key] = value[key].slice(-2048)
    for (const key of ['code', 'signal', 'processGroup', 'processGroupGone', 'stopped', 'bytes', 'seconds'])
      if (['string', 'number', 'boolean'].includes(typeof value[key])) data[key] = value[key]
    for (const key of ['cause', 'failure', 'record'])
      if (value[key] !== undefined) data[key] = visit(value[key], depth + 1)
    if (Array.isArray(value.errors)) data.errors = value.errors.slice(0, 4).map(error => visit(error, depth + 1))
    return data
  }
  return visit(cause, 0)
}

function parseQualificationArguments(args) {
  if (args.length !== 4 || args[0] !== '--sqlite-source' || args[2] !== '--destination')
    throw new Error('Usage: --sqlite-source /absolute/sqlite3.c --destination /private/absolute/native-contract')
  for (const value of [args[1], args[3]])
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0'))
      throw new Error('Qualification paths must be normalized absolute paths')
  if (args[1] === args[3]) throw new Error('Qualification destination must differ from its SQLite input')
  return Object.freeze({ sqliteSource: args[1], destination: args[3] })
}

function parseBootstrapQualificationArguments(args) {
  if (args.length !== 4 || args[0] !== '--sqlite-source' || args[2] !== '--output-parent')
    throw new Error('Usage: --sqlite-source /absolute/sqlite3.c --output-parent /private/absolute/directory')
  for (const value of [args[1], args[3]])
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value || value.includes('\0'))
      throw new Error('Bootstrap paths must be normalized absolute paths')
  if (args[1] === args[3]) throw new Error('Bootstrap output parent must differ from its SQLite input')
  return Object.freeze({ sqliteSource: args[1], outputParent: args[3] })
}

/** Maintainer standalone-test ownership only. This private factory is never
 * used by the installed wallet or its qualified executable registry. A build
 * receipt supplies comparison DATA; the actual original inode is captured,
 * hashed and retained independently before any contract process is launched. */
function standaloneContractOwner(build, root) {
  const host = planUnixBootstrapHost(process.platform, process.arch, process.version, process.versions.modules)
  if (
    build.protocol !== 'brc38-native-candidate-build/v1' ||
    build.platform !== host.platform ||
    build.architecture !== host.architecture ||
    build.engineExecuted !== false ||
    build.qualified !== false ||
    build.runtimePinChanged !== false ||
    build.publicationOrDeployment !== false ||
    !Number.isSafeInteger(build.candidate?.bytes) ||
    build.candidate.bytes < 64 ||
    build.candidate.bytes > 2097152 ||
    !/^[a-f0-9]{64}$/.test(build.candidate.sha256) ||
    typeof build.candidate.path !== 'string' ||
    !path.isAbsolute(build.candidate.path) ||
    path.normalize(build.candidate.path) !== build.candidate.path ||
    path.dirname(path.dirname(build.candidate.path)) !== root ||
    path.basename(build.candidate.path) !== 'native-candidate'
  )
    throw new Error('Standalone contract build DATA differs from its owned Unix source build')
  const expected = Object.freeze({ ...build.candidate }),
    files = new WeakMap()
  const fields = ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeNs', 'ctimeNs']
  const originalFile = async file => {
    const owned = files.get(file)
    if (owned === undefined) throw new Error('Standalone contract requires its original captured descriptor')
    const original = owned.original
    const actual = await file.stat({ bigint: true })
    if (file.fd < 0 || fields.some(key => actual[key] !== original[key]) || actual.nlink !== 1n)
      throw new Error('Standalone contract executable identity changed')
    return original
  }
  const postimage = async file => {
    await originalFile(file)
    const hash = crypto.createHash('sha256'),
      chunk = Buffer.alloc(Math.min(65536, expected.bytes)),
      header = Buffer.alloc(64)
    let offset = 0
    while (offset < expected.bytes) {
      const read = await file.read(chunk, 0, Math.min(chunk.length, expected.bytes - offset), offset)
      if (read.bytesRead === 0) throw new Error('Standalone contract executable was truncated')
      if (offset < header.length) chunk.copy(header, offset, 0, Math.min(read.bytesRead, header.length - offset))
      hash.update(chunk.subarray(0, read.bytesRead))
      offset += read.bytesRead
    }
    if (
      (await file.read(Buffer.alloc(1), 0, 1, expected.bytes)).bytesRead !== 0 ||
      hash.digest('hex') !== expected.sha256
    )
      throw new Error('Standalone contract executable bytes differ from its actual source build')
    assertNativeCandidateTarget(header, host.platform, host.architecture)
    await originalFile(file)
    return Object.freeze({ bytes: expected.bytes, sha256: expected.sha256 })
  }
  const close = async file => {
    if (!files.has(file)) throw new Error('Standalone close requires its original captured descriptor')
    const cleanup = async () => {
      await file.close()
      files.delete(file)
    }
    try {
      await cleanup()
    } catch (cause) {
      throw new NativeCandidateBuildCleanupError(undefined, cause, cleanup)
    }
  }
  return Object.freeze({
    async open(filename) {
      if (filename !== expected.path) throw new Error('Standalone capture requires its actual original build path')
      const directory = await privateDirectory(path.dirname(filename))
      const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const original = await file.stat({ bigint: true })
        if (
          !original.isFile() ||
          original.nlink !== 1n ||
          original.uid !== BigInt(process.getuid()) ||
          original.size !== BigInt(expected.bytes) ||
          (original.mode & 0o222n) !== 0n ||
          (original.mode & 0o111n) === 0n
        )
          throw new Error('Standalone contract requires its immutable owned executable inode')
        files.set(file, { original, directory })
        await postimage(file)
        return file
      } catch (cause) {
        const cleanup = async () => {
          await file.close()
          files.delete(file)
        }
        try {
          await cleanup()
        } catch (error_) {
          throw new NativeCandidateBuildCleanupError(cause, error_, cleanup)
        }
        throw cause
      }
    },
    async launchPath(file) {
      await originalFile(file)
      if (host.platform === 'linux') return '/proc/self/fd/4'
      // Darwin has no proc-fd launch. This private candidate belongs only to
      // the original isolated maintainer worker. It cannot satisfy the wallet's
      // protected root-owned installation contract or grant runtime admission.
      return await standaloneBuildPath(file, expected.path, files.get(file).directory)
    },
    close,
    postimage
  })
}

/** A failed metadata write/close retains the concrete original descriptor. */
async function writeQualificationRecord(filename, record) {
  const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n')
  if (bytes.length > 1048576) throw new Error('Qualification metadata exceeds its bounded receipt extent')
  const file = await fs.open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o400
  )
  let failed = false,
    failure
  try {
    await file.writeFile(bytes)
    await file.sync()
  } catch (cause) {
    failed = true
    failure = cause
  }
  try {
    await file.close()
  } catch (cause) {
    throw new NativeCandidateBuildCleanupError(failed ? failure : undefined, cause, () => file.close())
  }
  if (failed) throw failure
}

/** Pure worker-target DATA. Callers cannot pass this plan to admit a host.
 * Actual qualification always reads the original process and static registry. */
function planLinuxQualificationHost(platform, architecture, nodeVersion, nodeABI) {
  if (
    platform !== 'linux' ||
    !['arm64', 'x64'].includes(architecture) ||
    nodeVersion !== 'v24.18.0' ||
    nodeABI !== '137'
  )
    throw new Error('Native qualification requires its admitted Linux ARM64/x64 Node24.18.0 ABI137 worker')
  return Object.freeze({
    platform,
    architecture,
    nodeVersion,
    nodeABI,
    dockerPlatform: architecture === 'arm64' ? 'linux/arm64' : 'linux/amd64'
  })
}

/** Pure target DATA for reviewed first-artifact contracts, not host admission.
 * Linux keeps its actual Docker target; Darwin uses a private build pathname
 * under the independent worker owner's isolation, never a wallet install path. */
function planUnixBootstrapHost(platform, architecture, nodeVersion, nodeABI) {
  if (platform === 'linux')
    return Object.freeze({
      ...planLinuxQualificationHost(platform, architecture, nodeVersion, nodeABI),
      launchMechanism: 'captured-linux-proc-fd'
    })
  if (
    platform !== 'darwin' ||
    !['arm64', 'x64'].includes(architecture) ||
    nodeVersion !== 'v24.18.0' ||
    nodeABI !== '137'
  )
    throw new Error('Native bootstrap requires its controlled Unix ARM64/x64 Node24.18.0 ABI137 worker')
  return Object.freeze({ platform, architecture, nodeVersion, nodeABI, launchMechanism: 'private-darwin-build-path' })
}

/** Standalone pathname comparison only. It conveys no wallet executable
 * authority and no atomic protection against another actor with the worker's
 * UID. The original isolated worker owner must exclude such actors. */
async function standaloneBuildPath(file, filename, expectedDirectory) {
  if (file.fd < 0) throw new Error('Standalone build pathname requires its still-open original descriptor')
  await privateDirectory(path.dirname(filename), expectedDirectory)
  const original = await file.stat({ bigint: true }),
    actual = await fs.lstat(filename, { bigint: true })
  if (
    !original.isFile() ||
    !actual.isFile() ||
    actual.isSymbolicLink() ||
    ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeNs', 'ctimeNs'].some(key => actual[key] !== original[key]) ||
    actual.nlink !== 1n ||
    actual.uid !== BigInt(process.getuid()) ||
    (actual.mode & 0o222n) !== 0n ||
    (actual.mode & 0o111n) === 0n
  )
    throw new Error('Standalone build pathname differs from its captured immutable inode')
  return filename
}

/** Preflight before filesystem, dependency download or compiler work. This
 * checks the real Node target and existing immutable registry only; it cannot
 * attest worker isolation or manufacture a missing platform build. */
function inspectNativeQualificationHost() {
  const host = planLinuxQualificationHost(process.platform, process.arch, process.version, process.versions.modules),
    owner = require('../out/src/storage/portable/Brc38NativeExecutable.cjs'),
    pin = owner.qualifiedNativeComponentBuild()
  if (pin === undefined || pin.platform !== host.platform || pin.architecture !== host.architecture)
    throw new Error('Native qualification component platform is not qualified')
  return Object.freeze({ ...host, pin, outerWorkerAttested: false, fullSystemQualified: false })
}

/** Pure ordinary-actor plan, not host or installation attestation. */
function planDarwinInstalledQualificationHost(platform, architecture, node, abi, uid, euid) {
  const plan = planUnixBootstrapHost(platform, architecture, node, abi)
  if (platform !== 'darwin' || !Number.isSafeInteger(uid) || uid <= 0 || uid !== euid)
    throw new Error('Installed Darwin qualification requires its ordinary non-root wallet actor')
  return Object.freeze({ ...plan, uid, euid, launchMechanism: 'protected-darwin-installed-path' })
}
function inspectDarwinInstalledQualificationHost() {
  const host = planDarwinInstalledQualificationHost(
      process.platform,
      process.arch,
      process.version,
      process.versions.modules,
      process.getuid?.(),
      process.geteuid?.()
    ),
    pin = require('../out/src/storage/portable/Brc38NativeExecutable.cjs').qualifiedNativeComponentBuild()
  if (pin === undefined || pin.platform !== host.platform || pin.architecture !== host.architecture)
    throw new Error('Installed Darwin component platform is not qualified')
  const destination = require('./Brc38RootNativeInstallation.cjs').darwinNativeInstallationPath(pin)
  return Object.freeze({
    ...host,
    pin,
    installedExecutable: destination,
    outerWorkerAttested: false,
    fullSystemQualified: false
  })
}

/** One bounded actual file, not a pathname verdict or build-receipt grant. */
async function readActual(filename, maximum, digestOnly = false) {
  const file = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  let failed = false,
    failure,
    bytes
  try {
    const before = await file.stat({ bigint: true })
    if (!before.isFile() || before.nlink !== 1n || before.size < 1n || before.size > BigInt(maximum))
      throw new Error('Qualification file extent or identity differs')
    const extent = Number(before.size),
      hash = crypto.createHash('sha256')
    bytes = Buffer.alloc(digestOnly ? Math.min(65536, extent) : extent)
    for (let offset = 0; offset < extent;) {
      const current = await file.read(bytes, digestOnly ? 0 : offset, Math.min(65536, extent - offset), offset)
      if (current.bytesRead === 0) throw new Error('Qualification file truncated during read')
      if (digestOnly) hash.update(bytes.subarray(0, current.bytesRead))
      offset += current.bytesRead
    }
    const after = await file.stat({ bigint: true })
    if (
      ['dev', 'ino', 'size', 'mode', 'mtimeNs', 'ctimeNs', 'nlink'].some(key => before[key] !== after[key]) ||
      (await file.read(Buffer.alloc(1), 0, 1, extent)).bytesRead !== 0
    )
      throw new Error('Qualification file changed during read')
    if (digestOnly) bytes = { bytes: extent, sha256: hash.digest('hex') }
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
  return bytes
}

/** Keep compilation buffers outside the component-launch parent. The original
 * worker owner must physically stop the worker if a build is interrupted;
 * killing this preparation group alone does not prove compiler-tree drainage. */
async function isolatedBuild(sqliteSource, root, calendar) {
  calendar.check()
  const child = cp.spawn(
    process.execPath,
    ['--max-old-space-size=1536', path.join(__dirname, 'Brc38NativeCandidateBuildWorker.cjs'), sqliteSource, root],
    {
      cwd: root,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
    }
  )
  let stdout = '',
    stderr = '',
    bytes = 0,
    failure,
    stopped = false
  const present = () => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (cause) {
      if (cause.code === 'ESRCH') return false
      throw cause
    }
  }
  const stop = cause => {
    stopped = true
    if (cause !== undefined) failure = cause
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch (error) {
      if (error.code !== 'ESRCH') failure = error
    }
  }
  const timer = setTimeout(() => stop(new Error('Original native preparation deadline exceeded')), 180000)
  const utc = setInterval(() => {
    try {
      calendar.check()
    } catch (cause) {
      stop(cause)
    }
  }, 100)
  const collect = stream => chunk => {
    bytes += chunk.length
    if (bytes > 16777216) stop(new Error('Original native preparation output bound exceeded'))
    else if (stream === 'stdout') stdout += chunk
    else stderr += chunk
  }
  child.stdout.on('data', collect('stdout'))
  child.stderr.on('data', collect('stderr'))
  child.on('error', stop)
  const result = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  clearTimeout(timer)
  clearInterval(utc)
  if (present()) {
    stop(new Error('Original preparation process group remains'))
    const deadline = performance.now() + 5000
    while (present() && performance.now() < deadline) await delay(25)
  }
  const processGroupGone = !present()
  if (stopped || failure || !processGroupGone || result.code !== 0 || result.signal !== null)
    throw new Error('Native preparation failed; original worker shutdown required', {
      cause: {
        failure,
        record: { ...result, stdout, stderr, bytes, stopped, processGroup: child.pid, processGroupGone }
      }
    })
  calendar.check()
  const receipt = JSON.parse(stdout)
  if (
    receipt.protocol !== 'brc38-native-candidate-build/v1' ||
    typeof receipt.candidate?.path !== 'string' ||
    path.dirname(path.dirname(receipt.candidate.path)) !== root ||
    path.basename(receipt.candidate.path) !== 'native-candidate'
  )
    throw new Error('Original preparation build data differs')
  return { ...receipt, preparation: { processGroup: child.pid, processGroupGone } }
}

async function privateDirectory(directory, expected) {
  const actual = await fs.lstat(directory, { bigint: true })
  if (
    !actual.isDirectory() ||
    actual.isSymbolicLink() ||
    actual.uid !== BigInt(process.getuid()) ||
    (actual.mode & 0o077n) !== 0n ||
    (expected && ['dev', 'ino', 'mode', 'uid'].some(key => actual[key] !== expected[key]))
  )
    throw new Error('Qualification requires its original private directory')
  return actual
}

/** Runs the original pinned inode, retaining its descriptor until real close.
 * A timeout/error is never interpreted as drainage or intentional writer loss. */
async function originalComponent(owner, file, cwd, name, args, calendar, committedKill = false) {
  calendar.check()
  const launchParentPeakRSSBytes = process.resourceUsage().maxRSS * 1024
  const launch = await owner.launchPath(file),
    child = cp.spawn(launch, args, {
      cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', file.fd],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }
    }),
    started = performance.now()
  let bytes = 0,
    stdout = '',
    stderr = '',
    committedInput = '',
    stopped = false,
    failure,
    intentionalKill = false
  const signal = value => {
    if (child.pid === undefined) return
    try {
      process.kill(-child.pid, value)
    } catch (cause) {
      if (cause.code !== 'ESRCH') failure = cause
    }
  }
  const present = () => {
    if (child.pid === undefined) return false
    try {
      process.kill(-child.pid, 0)
      return true
    } catch (cause) {
      if (cause.code === 'ESRCH') return false
      throw cause
    }
  }
  const stop = cause => {
    stopped = true
    if (cause !== undefined) failure = cause
    signal('SIGKILL')
  }
  const timer = setTimeout(() => stop(new Error('Original component deadline exceeded')), 30000)
  const utc = setInterval(() => {
    try {
      calendar.check()
    } catch (cause) {
      stop(cause)
    }
  }, 100)
  child.stdout.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 16777216) {
      stop(new Error('Original component output bound exceeded'))
      return
    }
    stdout += chunk
    if (committedKill && !intentionalKill && !stopped) {
      committedInput += chunk
      const lines = committedInput.split('\n')
      committedInput = lines.pop()
      try {
        for (const line of lines) {
          const record = JSON.parse(line)
          if (record.phase !== 'committed' || record.value !== 41 || record.pid !== child.pid)
            throw new Error('Independent committed writer identity differs')
          if (intentionalKill) throw new Error('Independent committed writer repeated its acknowledgement')
          intentionalKill = true
          signal('SIGKILL')
        }
      } catch (cause) {
        stop(cause)
      }
    }
  })
  child.stderr.on('data', chunk => {
    bytes += chunk.length
    if (bytes > 16777216) stop(new Error('Original component output bound exceeded'))
    else stderr += chunk
  })
  const result = await new Promise(resolve => {
    child.on('error', cause => stop(cause))
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  clearTimeout(timer)
  clearInterval(utc)
  if (present()) {
    stopped = true
    signal('SIGKILL')
    const deadline = performance.now() + 5000
    while (present() && performance.now() < deadline) await delay(25)
  }
  const processGroupGone = !present(),
    passed =
      !stopped &&
      failure === undefined &&
      processGroupGone &&
      !/SIGSEGV|SIGBUS|SIGABRT|Segmentation fault|Bus error|Illegal instruction|core dumped/.test(stdout + stderr) &&
      (committedKill
        ? intentionalKill && result.code === null && result.signal === 'SIGKILL'
        : result.code === 0 && result.signal === null),
    record = {
      name,
      args,
      launchParentPeakRSSBytes,
      processGroup: child.pid,
      ...result,
      stdout,
      stderr,
      bytes,
      stopped,
      intentionalKill,
      processGroupGone,
      seconds: performance.now() / 1000 - started / 1000,
      passed
    }
  if (!passed) throw new Error('Original native component failed: ' + name, { cause: { failure, record } })
  calendar.check()
  await owner.launchPath(file)
  return record
}

/** Both maintainer modes build the actual reviewed source and share all thirteen
 * original contracts. Delivery additionally requires the existing static pin;
 * bootstrap evidence cannot enroll a runtime artifact or install one. */
async function runNativeQualification(options, mode) {
  const bootstrap = mode === true,
    installed = mode === 'installed'
  const host = installed
      ? inspectDarwinInstalledQualificationHost()
      : bootstrap
        ? Object.freeze({
            ...planUnixBootstrapHost(process.platform, process.arch, process.version, process.versions.modules),
            outerWorkerAttested: false,
            fullSystemQualified: false
          })
        : inspectNativeQualificationHost(),
    parsed =
      bootstrap || installed
        ? parseBootstrapQualificationArguments([
            '--sqlite-source',
            options.sqliteSource,
            '--output-parent',
            options.outputParent
          ])
        : parseQualificationArguments(['--sqlite-source', options.sqliteSource, '--destination', options.destination]),
    parent = bootstrap || installed ? parsed.outputParent : path.dirname(parsed.destination),
    parentIdentity = await privateDirectory(parent),
    utcDeadline = Date.now() + 360000,
    monotonicDeadline = performance.now() + 360000,
    calendar = {
      check() {
        if (Date.now() >= utcDeadline || performance.now() >= monotonicDeadline)
          throw new Error('Native qualification original finite calendar exceeded')
      }
    }
  // Existing and dangling-symlink destinations refuse before compilation.
  if (!bootstrap && !installed) {
    try {
      await fs.lstat(parsed.destination)
      throw new Error('Native qualification destination already exists')
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause
    }
  }
  const runtimeFactory = bootstrap ? undefined : require('../out/src/storage/portable/Brc38NativeExecutable.cjs'),
    pin = bootstrap ? undefined : host.pin
  const inputs = { sqliteSource: { filename: parsed.sqliteSource, bytes: sqlite.bytes, sha256: sqlite.sha256 } }
  for (const name of sources) {
    const filename = path.join(__dirname, '../src/storage/portable/native', name),
      digest = await readActual(filename, 1048576, true)
    inputs[name] = { filename, ...digest }
  }
  const checkInputs = async () => {
    calendar.check()
    await privateDirectory(parent, parentIdentity)
    for (const input of Object.values(inputs)) {
      const digest = await readActual(input.filename, input.bytes, true)
      if (digest.bytes !== input.bytes || digest.sha256 !== input.sha256)
        throw new Error('Native qualification original source changed')
    }
  }
  await checkInputs()
  const root = await fs.mkdtemp(path.join(parent, 'brc38-qualification-')),
    rootIdentity = await privateDirectory(root),
    fixture = path.join(root, 'fixtures')
  await fs.mkdir(fixture, { mode: 0o700 })
  const fixtureIdentity = await privateDirectory(fixture)
  let executable,
    owner,
    build,
    failed = false,
    failure,
    delivered,
    pendingTarget
  const records = []
  try {
    // Refuse a missing or unsafe installation before compiling. Keep the actual
    // original SDK descriptor through preparation and all thirteen contracts.
    if (installed) {
      owner = Object.freeze({
        open: filename => runtimeFactory.openPinnedNativeExecutable(filename),
        launchPath: file => runtimeFactory.pinnedNativeLaunchPath(file),
        close: file => runtimeFactory.closePinnedNativeExecutable(file)
      })
      executable = await owner.open(host.installedExecutable)
      await owner.launchPath(executable)
    }
    build = await isolatedBuild(parsed.sqliteSource, root, calendar)
    if (
      !bootstrap &&
      (build.candidate.bytes !== pin.bytes ||
        build.candidate.sha256 !== pin.sha256 ||
        build.engineExecuted !== false ||
        build.runtimePinChanged !== false)
    )
      throw new Error('Native candidate differs from the independently qualified static pin')
    for (const [name, input] of Object.entries(build.inputs)) {
      const original = name === 'sqlite3.c' ? inputs.sqliteSource : inputs[name]
      if (!original || input.bytes !== original.bytes || input.sha256 !== original.sha256)
        throw new Error('Native build captured different original source')
    }
    if (Object.keys(build.inputs).length !== sources.length + 1)
      throw new Error('Native build source cohort is incomplete')
    await checkInputs()
    owner = installed
      ? owner
      : bootstrap
        ? standaloneContractOwner(build, root)
        : Object.freeze({
            open: filename => runtimeFactory.openPinnedNativeExecutable(filename),
            launchPath: file => runtimeFactory.pinnedNativeLaunchPath(file),
            close: file => runtimeFactory.closePinnedNativeExecutable(file)
          })
    if (!installed) executable = await owner.open(build.candidate.path)
    records.push(
      await originalComponent(owner, executable, fixture, 'original-runtime', ['--runtime-contract'], calendar)
    )
    if (!records[0].stdout.includes('PASS native runtime resource contracts'))
      throw new Error('Original runtime assertion receipt differs')
    records.push(
      await originalComponent(owner, executable, fixture, 'original-wal-delete-memory-descriptor', [], calendar)
    )
    records.push(
      await originalComponent(owner, executable, fixture, 'original-profile-families', ['--profile'], calendar)
    )
    records.push(
      await originalComponent(
        owner,
        executable,
        fixture,
        'original-private-stage-recovery-purpose',
        ['--private-stage-contract'],
        calendar
      )
    )
    records.push(await originalComponent(owner, executable, fixture, 'original-native-range', ['--range'], calendar))
    records.push(
      await originalComponent(
        owner,
        executable,
        fixture,
        'healthy-committed-writer-loss',
        ['--process-loss-writer'],
        calendar,
        true
      )
    )
    records.push(
      await originalComponent(
        owner,
        executable,
        fixture,
        'independent-committed-wal-recovery',
        ['--process-loss-recovery'],
        calendar
      )
    )
    const wal = records[1].stdout.trim().split('\n').map(JSON.parse),
      recovered = records[6].stdout.trim().split('\n').map(JSON.parse)
    // The original descriptor exhaustion loop checks each synthetic close.
    // Our still-open executable at fd4 consumes one slot compared with the
    // independently qualified pathname launch (358). All fixed assertions and
    // the original 32-FD bound remain unchanged; require exactly this launch.
    const walAssertionsWithRetainedExecutable = 358 - 1
    if (
      !wal.some(
        record =>
          record.assertions === walAssertionsWithRetainedExecutable &&
          record.wal === true &&
          record.rollback === true &&
          record.descriptorIdentity === true &&
          record.fixturesDrained === true
      ) ||
      !records[2].stdout.includes(
        'PASS profile checks=1196 unchangedAggregate=1048576 unchangedWrapperHandles=8 families=3'
      ) ||
      !records[3].stdout.includes('private-stage owner/VFS checks=215 synthetic-only') ||
      !records[4].stdout
        .trim()
        .split('\n')
        .map(JSON.parse)
        .some(
          record =>
            record.stage === 'native-original-range-contract' && record.assertions === 70 && record.passed === true
        ) ||
      !recovered.some(
        record =>
          record.phase === 'recovered' &&
          record.assertions === 25 &&
          record.value === 42 &&
          record.fixturesDrained === true
      )
    )
      throw new Error('Original independent component assertion receipts differ')
    records.push(
      await originalComponent(
        owner,
        executable,
        fixture,
        'shared-quota-dispatch',
        ['--shared-quota-contract'],
        calendar
      )
    )
    if (records[7].stdout !== 'PASS shared-quota dispatch independent guards and rollback checks=306\n')
      throw new Error('Independent shared quota dispatch receipt differs')
    records.push(
      await originalComponent(
        owner,
        executable,
        fixture,
        'independent-cell-change',
        ['--cell-change-contract'],
        calendar
      )
    )
    if (records[8].stdout !== 'PASS independent cell comparison checks=1152 argumentLimit=1000 fixturesDrained=true\n')
      throw new Error('Independent native contract receipt differs: independent-cell-change')
    records.push(
      await originalComponent(
        owner,
        executable,
        fixture,
        'independent-local-observer',
        ['--local-observer-contract'],
        calendar
      )
    )
    if (records[9].stdout !== 'PASS independent local observer forms checks=93 fixturesDrained=true\n')
      throw new Error('Independent native contract receipt differs: independent-local-observer')
    records.push(
      await originalComponent(
        owner,
        executable,
        fixture,
        'independent-local-pointer-projection',
        ['--local-pointer-projection-contract'],
        calendar
      )
    )
    if (
      records[10].stdout !==
      'PASS independent pointer projection coordinates=20 transitions=40 checks=641 fixturesDrained=true\n'
    )
      throw new Error('Independent native contract receipt differs: independent-local-pointer-projection')
    records.push(
      await originalComponent(
        owner,
        executable,
        fixture,
        'independent-local-pointer-group',
        ['--local-pointer-group-contract'],
        calendar
      )
    )
    if (
      records[11].stdout !==
      'PASS independent grouped pointers coordinates=32 transitions=64 checks=994 fixturesDrained=true\n'
    )
      throw new Error('Independent native contract receipt differs: independent-local-pointer-group')
    records.push(
      await originalComponent(
        owner,
        executable,
        fixture,
        'independent-local-observer-names',
        ['--local-observer-names-contract'],
        calendar
      )
    )
    if (
      records[12].stdout !==
      'PASS independent compact observer names sources=47 transitions=423 checks=2784 fixturesDrained=true\n'
    )
      throw new Error('Independent native contract receipt differs: independent-local-observer-names')
    await checkInputs()
    await privateDirectory(root, rootIdentity)
    await privateDirectory(fixture, fixtureIdentity)
    if ((await fs.readdir(fixture)).length !== 0) throw new Error('Original native fixtures remain owned')
    if (bootstrap) {
      const candidate = await owner.postimage(executable)
      await owner.close(executable)
      executable = undefined
      const receipt = {
        protocol: 'brc38-native-standalone-bootstrap/v1',
        finishedAt: new Date().toISOString(),
        inputs,
        build,
        host,
        candidate,
        records,
        originalRuntimePassed: true,
        originalContractsPassed: 13,
        originalFixturesDrained: true,
        candidateDescriptorClosed: true,
        runtimeQualified: false,
        runtimePinChanged: false,
        executableDelivered: false,
        hostEnrolled: false,
        outerWorkerAttested: false,
        physicalRSSQualified: false,
        providerQualified: false,
        fullSystemQualified: false,
        publicationOrDeployment: false
      }
      await writeQualificationRecord(path.join(root, 'bootstrap-contract-receipt.json'), receipt)
      await checkInputs()
      return receipt
    }
    if (installed) {
      const candidate = await readActual(build.candidate.path, pin.bytes, true)
      if (candidate.bytes !== pin.bytes || candidate.sha256 !== pin.sha256)
        throw new Error('Installed Darwin source candidate postimage differs from the fixed component')
      await owner.launchPath(executable)
      await owner.close(executable)
      executable = undefined
      const receipt = {
        protocol: 'brc38-darwin-installed-component/v1',
        finishedAt: new Date().toISOString(),
        inputs,
        build,
        pin,
        host,
        records,
        installedExecutable: host.installedExecutable,
        originalRuntimePassed: true,
        originalContractsPassed: 13,
        originalFixturesDrained: true,
        originalSDKProtectedLaunchUsed: true,
        installedDescriptorClosed: true,
        executableCreatedOrReplaced: false,
        runtimePinChanged: false,
        hostEnrolled: false,
        outerWorkerAttested: false,
        physicalRSSQualified: false,
        providerQualified: false,
        fullSystemQualified: false,
        publicationOrDeployment: false
      }
      await writeQualificationRecord(path.join(root, 'installed-component-receipt.json'), receipt)
      await checkInputs()
      return receipt
    }
    const bytes = await readActual(build.candidate.path, pin.bytes)
    if (bytes.length !== pin.bytes || sha(bytes) !== pin.sha256) throw new Error('Native candidate postimage differs')
    await owner.close(executable)
    executable = undefined
    const target = await fs.open(
      parsed.destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o500
    )
    pendingTarget = target
    delivered = await target.stat({ bigint: true })
    let writeFailed = false,
      writeFailure
    try {
      await target.writeFile(bytes)
      await target.sync()
      const actual = await target.stat({ bigint: true })
      if (
        actual.ino !== delivered.ino ||
        actual.dev !== delivered.dev ||
        actual.nlink !== 1n ||
        actual.size !== BigInt(pin.bytes)
      )
        throw new Error('Native exclusive delivery inode differs')
      delivered = actual
    } catch (cause) {
      writeFailed = true
      writeFailure = cause
    }
    try {
      await target.close()
      pendingTarget = undefined
    } catch (error_) {
      throw new NativeCandidateBuildCleanupError(writeFailed ? writeFailure : undefined, error_, () => target.close())
    }
    if (writeFailed) throw writeFailure
    executable = await owner.open(parsed.destination)
    await owner.close(executable)
    executable = undefined
    await checkInputs()
    const receipt = {
      protocol: 'brc38-native-component-delivery/v1',
      finishedAt: new Date().toISOString(),
      inputs,
      build,
      pin,
      host,
      records,
      originalRuntimePassed: true,
      originalComponentsPassed: 6,
      additionalSharedQuotaPassed: true,
      additionalSharedQuotaChecks: 306,
      additionalCellChangePassed: true,
      additionalCellChangeChecks: 1152,
      additionalLocalObserverPassed: true,
      additionalLocalObserverChecks: 93,
      additionalPointerProjectionPassed: true,
      additionalPointerProjectionCoordinates: 20,
      additionalPointerProjectionChecks: 641,
      additionalPointerGroupPassed: true,
      additionalPointerGroupCoordinates: 32,
      additionalPointerGroupChecks: 994,
      additionalObserverNamesPassed: true,
      additionalObserverNamesSources: 47,
      additionalObserverNamesTransitions: 423,
      additionalObserverNamesChecks: 2784,
      originalFixturesDrained: true,
      destination: parsed.destination,
      destinationSha256: pin.sha256,
      outerWorkerAttested: false,
      wholeOsProcessTreeQualified: false,
      physicalRSSQualified: false,
      providerQualified: false,
      fullSystemQualified: false,
      runtimePinChanged: false,
      publicationOrDeployment: false
    }
    await fs.writeFile(path.join(root, 'component-delivery-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o400
    })
    return receipt
  } catch (cause) {
    failed = true
    failure = cause
  }
  const cleanup = []
  if (pendingTarget !== undefined) {
    try {
      await pendingTarget.close()
      pendingTarget = undefined
    } catch (cause) {
      const retained = pendingTarget
      cleanup.push(new NativeCandidateBuildCleanupError(undefined, cause, () => retained.close()))
    }
  }
  if (executable !== undefined) {
    try {
      await owner.close(executable)
    } catch (cause) {
      cleanup.push(cause)
    }
  }
  if (delivered !== undefined && pendingTarget === undefined && cleanup.length === 0) {
    try {
      await privateDirectory(parent, parentIdentity)
      const actual = await fs.lstat(parsed.destination, { bigint: true })
      if (actual.isSymbolicLink() || actual.dev !== delivered.dev || actual.ino !== delivered.ino)
        throw new Error('Failed native delivery path was replaced; original worker cleanup required')
      await fs.unlink(parsed.destination)
    } catch (cause) {
      cleanup.push(cause)
    }
  }
  // Retain the source/build/fixture root on failure for the original worker's
  // physical shutdown and inspection; never delete a possibly live subtree.
  try {
    await privateDirectory(root, rootIdentity)
    await fs.writeFile(
      path.join(root, 'component-delivery-failure.json'),
      JSON.stringify(
        {
          protocol: 'brc38-native-component-delivery-failure/v1',
          inputs,
          build,
          pin,
          records,
          failure: qualificationFailureData(failure),
          cleanup: cleanup.map(qualificationFailureData),
          delivered: false,
          providerQualified: false,
          fullSystemQualified: false
        },
        null,
        2
      ) + '\n',
      { flag: 'wx', mode: 0o400 }
    )
  } catch (cause) {
    cleanup.push(cause)
  }
  if (failed)
    throw new AggregateError(
      [failure, ...cleanup],
      'Native qualification failed; original evidence retained at ' + root,
      { cause: failure }
    )
}

async function qualifyBrc38NativeCandidate(options) {
  return await runNativeQualification(options, false)
}
async function qualifyInstalledDarwinCandidate(options) {
  return await runNativeQualification(options, 'installed')
}
async function bootstrapBrc38NativeCandidate(options) {
  return await runNativeQualification(options, true)
}

module.exports = {
  parseQualificationArguments,
  parseBootstrapQualificationArguments,
  standaloneContractOwner,
  writeQualificationRecord,
  planLinuxQualificationHost,
  planUnixBootstrapHost,
  standaloneBuildPath,
  inspectNativeQualificationHost,
  planDarwinInstalledQualificationHost,
  inspectDarwinInstalledQualificationHost,
  qualifyInstalledDarwinCandidate,
  qualifyBrc38NativeCandidate,
  bootstrapBrc38NativeCandidate,
  qualificationFailureData
}
if (require.main === module) {
  Promise.resolve()
    .then(() => {
      const args = process.argv.slice(2)
      if (args.length === 1 && args[0] === '--check-host') return inspectNativeQualificationHost().dockerPlatform
      return qualifyBrc38NativeCandidate(parseQualificationArguments(args))
    })
    .then(receipt => process.stdout.write((typeof receipt === 'string' ? receipt : JSON.stringify(receipt)) + '\n'))
    .catch(cause => {
      process.stderr.write(JSON.stringify(qualificationFailureData(cause)) + '\n')
      process.exitCode = 1
    })
}
