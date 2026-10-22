'use strict'
// Maintainer-only candidate build. All implementation must be complete and
// fresh Windows worker/toolchain/resource admission agreed before invocation.
// Bootstrap qualification binds the exact addon and build supervisor first;
// this recipe never treats candidate bytes or a caller receipt as a pin.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { sources, sqlite, NativeCandidateBuildCleanupError } = require('./Brc38NativeCandidateBuild.cjs')
const { copyNativeSourceInput, NativeSourceCleanupError } = require('../src/storage/portable/native/prepare_source.cjs')
// tsc and the artifact copier must finish before this compiled Node boundary
// is available. It creates protected actor DACLs before source bytes exist.
const physical = () => require('../out/src/storage/portable/Brc38PrivateFilesystemNode.js')
const executable = () => require('../out/src/storage/portable/Brc38NativeExecutable.cjs')
const stagingCleanup = () => require('../out/src/storage/portable/Brc38StagingCleanupError.js').Brc38StagingCleanupError
// Qualification fills exact architecture/Node/toolchain source entries here.
// Exported hashes and candidate build receipts cannot mutate this table.
const toolchains = Object.freeze({})
let retainedWorker = false
const {
  windowsAddonSources: addonSources,
  assertNativeCandidateTarget
} = require('../src/storage/portable/native/source_recipe.cjs')
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex')

/** Pure bootstrap source DATA. A fresh isolated worker/controller must review
 * these exact MSVC/SDK paths and compile/qualify the addon and supervisor under
 * its own agreed limits before fixed registry entries can be committed. This
 * function runs no compiler and populates no qualification/runtime table. */
function windowsSupervisorPolicy(selected) {
  const policy = Object.freeze({
    compiler: selected.compiler,
    include: selected.include,
    lib: selected.lib,
    path: selected.path
  })
  const valid = value =>
    typeof value === 'string' &&
    value.length > 3 &&
    value.length < 8192 &&
    value
      .split(';')
      .every(
        name => /^[A-Za-z]:\\[\x20-\x7e]+$/.test(name) && !/["<>|?*]/.test(name) && !name.split('\\').includes('..')
      )
  if (
    !valid(policy.compiler) ||
    policy.compiler.includes(';') ||
    !policy.compiler.toLowerCase().endsWith('\\cl.exe') ||
    !valid(policy.include) ||
    !valid(policy.lib) ||
    !valid(policy.path)
  )
    throw new Error('Windows bootstrap toolchain source paths differ')
  const sha256 = digest(Buffer.from(JSON.stringify(policy))),
    header =
      '#define BRC38_BUILD_COMPILER L' +
      JSON.stringify(policy.compiler) +
      '\n' +
      '#define BRC38_BUILD_INCLUDE L' +
      JSON.stringify(policy.include) +
      '\n' +
      '#define BRC38_BUILD_LIB L' +
      JSON.stringify(policy.lib) +
      '\n' +
      '#define BRC38_BUILD_PATH L' +
      JSON.stringify(policy.path) +
      '\n' +
      '#define BRC38_BUILD_POLICY_SHA256 "' +
      sha256 +
      '"\n'
  return Object.freeze({
    policy,
    sha256,
    header,
    compiled: false,
    qualified: false,
    supervisorArguments: Object.freeze([
      '/nologo',
      '/O2',
      '/std:c11',
      '/W4',
      '/WX',
      '/MT',
      '/DUNICODE',
      '/D_UNICODE',
      '/D_WIN32_WINNT=0x0602',
      'windows_build_supervisor.c',
      '/Fe:brc38-build-supervisor.exe',
      '/link',
      'advapi32.lib'
    ]),
    addonArguments: Object.freeze([
      '/nologo',
      '/O2',
      '/std:c11',
      '/W4',
      '/WX',
      '/LD',
      '/MD',
      '/DUNICODE',
      '/D_UNICODE',
      '/D_WIN32_WINNT=0x0602',
      '/DNAPI_VERSION=8',
      '/Inode-headers',
      'windows_bridge.c',
      'node.lib',
      '/Fe:brc38_windows.node',
      '/link',
      'advapi32.lib',
      'shell32.lib'
    ])
  })
}

function selectedToolchain() {
  const fixed = toolchains[process.arch]
  if (
    process.platform !== 'win32' ||
    !['x64', 'arm64'].includes(process.arch) ||
    fixed === undefined ||
    fixed.nodeVersion !== process.versions.node ||
    fixed.nodeModules !== process.versions.modules ||
    !/^[0-9a-f]{64}$/.test(fixed.policySha256) ||
    fixed.nodeHeaders.length < 1 ||
    fixed.nodeHeaders.length > 64
  )
    throw new Error('Windows candidate build has no exact qualified Node/toolchain entry')
  return fixed
}
async function controller(root, target, fixed) {
  const owner = executable(),
    file = await owner.openPinnedWindowsBuildSupervisor(fixed.supervisorFilename)
  let child,
    timer,
    outputBytes = 0,
    stopped = false,
    failure,
    operationFailed = false,
    result
  const chunks = []
  try {
    const launch = await owner.pinnedNativeLaunchPath(file)
    child = cp.spawn(launch, ['--' + target, root], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ignore', file.fd],
      env: {}
    })
    const stop = () => {
      stopped = true
      retainedWorker = true
      child.kill()
    }
    const collect = bytes => {
      outputBytes += bytes.length
      if (outputBytes > 65536) stop()
      else chunks.push(Buffer.from(bytes))
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    timer = setTimeout(stop, 200000)
    const exit = await new Promise(resolve => {
      child.on('error', error => {
        failure = error
        stop()
      })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    const output = Buffer.concat(chunks).toString('utf8'),
      marker = '\nBRC38_WINDOWS_BUILD_DRAINED:' + fixed.policySha256 + ':' + target + '\n'
    if (failure !== undefined || stopped || exit.code !== 0 || exit.signal !== null || !output.endsWith(marker)) {
      retainedWorker = true
      throw new Error('Windows compiler worker requires original physical shutdown; no successful job-drain receipt', {
        cause: failure
      })
    }
    result = output
  } catch (cause) {
    failure = cause
    operationFailed = true
  } finally {
    clearTimeout(timer)
  }
  // Keep image and ancestor HANDLEs until the real supervisor close event.
  // A rejected original close retains a concrete retry, never a guessed PID.
  try {
    await owner.closePinnedNativeExecutable(file)
  } catch (error_) {
    retainedWorker = true
    throw new NativeCandidateBuildCleanupError(failure, error_, async () => {
      await error_.retryCleanup()
    })
  }
  if (operationFailed) throw failure
  return result
}
async function copyHeaderDirectories(root, relative, created) {
  const segments = relative.split('/')
  let directory = path.join(root, 'node-headers')
  for (const segment of segments.slice(0, -1)) {
    directory = path.join(directory, segment)
    if (!created.has(directory)) {
      await physical().createPrivateDirectory(directory)
      created.add(directory)
    }
  }
}
/** Source and candidate outputs remain inside one actual private owned root.
 * Fixed toolchain header/import-library identities are separate from SQLite
 * and the exact authored driver/addon inputs. No artifact is executed/adopted.
 * @param {{sqliteSource:string,nodeHeaders:string,nodeImportLibrary:string,outputDirectory:string}} options */
async function buildBrc38WindowsCandidates(options) {
  if (retainedWorker) throw new Error('The original Windows compiler worker remains retained')
  const fixed = selectedToolchain(),
    boundary = physical(),
    startedAt = new Date().toISOString(),
    parent = path.resolve(options.outputDirectory)
  await boundary.requirePrivatePath(parent, true)
  const root = await boundary.createPrivateTemporaryDirectory(path.join(parent, 'brc38-windows-candidate-')),
    identity = await boundary.requirePrivatePath(root, true),
    records = [],
    outputs = []
  const dispose = async () => {
    const actual = await boundary.requirePrivatePath(root, true)
    if (actual.dev !== identity.dev || actual.ino !== identity.ino)
      throw new Error('Windows candidate root was replaced')
    await fs.rm(root, { recursive: true })
  }
  try {
    const copiedSqlite = await copyNativeSourceInput(
      options.sqliteSource,
      path.join(root, 'sqlite3.c'),
      sqlite.bytes,
      sqlite
    )
    records.push({ path: 'sqlite3.c', ...copiedSqlite })
    for (const name of [...sources, ...addonSources]) {
      const copied = await copyNativeSourceInput(
        path.join(__dirname, '../src/storage/portable/native', name),
        path.join(root, name),
        1048576
      )
      records.push({ path: name, ...copied })
    }
    await boundary.createPrivateDirectory(path.join(root, 'node-headers'))
    const created = new Set([path.join(root, 'node-headers')])
    let headerBytes = 0
    for (const input of fixed.nodeHeaders) {
      if (
        !/^[a-zA-Z0-9_/-]+\.h$/.test(input.path) ||
        input.path.includes('..') ||
        input.path.startsWith('/') ||
        !Number.isSafeInteger(input.bytes) ||
        input.bytes < 1 ||
        input.bytes > 2097152 ||
        !/^[0-9a-f]{64}$/.test(input.sha256) ||
        (headerBytes += input.bytes) > 16777216
      )
        throw new Error('Fixed Node header cohort differs from its bound')
      await copyHeaderDirectories(root, input.path, created)
      const copied = await copyNativeSourceInput(
        path.join(options.nodeHeaders, input.path),
        path.join(root, 'node-headers', input.path),
        input.bytes,
        input
      )
      records.push({ path: 'node-headers/' + input.path, ...copied })
    }
    if (
      !Number.isSafeInteger(fixed.nodeImportLibrary.bytes) ||
      fixed.nodeImportLibrary.bytes < 1 ||
      fixed.nodeImportLibrary.bytes > 33554432 ||
      !/^[0-9a-f]{64}$/.test(fixed.nodeImportLibrary.sha256)
    )
      throw new Error('Fixed Node import-library input differs')
    const library = await copyNativeSourceInput(
      options.nodeImportLibrary,
      path.join(root, 'node.lib'),
      33554432,
      fixed.nodeImportLibrary
    )
    records.push({ path: 'node.lib', ...library })
    for (const [target, filename] of [
      ['driver', 'native-candidate.exe'],
      ['addon', 'brc38_windows.node']
    ]) {
      const output = await controller(root, target, fixed)
      const staged = path.join(root, target + '-candidate-readback')
      const actual = await copyNativeSourceInput(path.join(root, filename), staged, 2097152)
      const image = await fs.readFile(staged)
      if (image.length !== actual.bytes || digest(image) !== actual.sha256)
        throw new Error('Windows candidate image changed during target readback')
      assertNativeCandidateTarget(image, 'win32', process.arch, target)
      await fs.unlink(staged)
      outputs.push({ target, path: filename, bytes: actual.bytes, sha256: actual.sha256, output })
    }
    // Independently reread every original frozen source after BOTH builds.
    for (let i = 0; i < records.length; i++) {
      const record = records[i],
        staged = path.join(root, 'input-readback-' + i)
      await copyNativeSourceInput(path.join(root, record.path), staged, record.bytes, record)
      await fs.unlink(staged)
    }
    const receipt = {
      protocol: 'brc38-windows-candidates/v1',
      platform: 'win32',
      architecture: process.arch,
      nodeVersion: process.versions.node,
      nodeModules: process.versions.modules,
      policySha256: fixed.policySha256,
      startedAt,
      finishedAt: new Date().toISOString(),
      source: records,
      candidates: outputs,
      engineOrAddonExecuted: false,
      qualified: false,
      runtimePinChanged: false,
      publishedOrDeployed: false
    }
    const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n'),
      file = await boundary.createPrivateFile(path.join(root, 'build-receipt.json'))
    try {
      await file.writeFile(bytes)
      await file.sync()
    } finally {
      await boundary.closePrivateDescriptor(file)
    }
    return Object.freeze({ directory: root, sha256: digest(bytes), receipt })
  } catch (cause) {
    if (retainedWorker)
      throw new Error('Windows build root and original isolated worker remain retained at ' + root, { cause })
    const cleanup = async () => {
      if (
        cause instanceof NativeSourceCleanupError ||
        cause instanceof NativeCandidateBuildCleanupError ||
        cause instanceof stagingCleanup()
      )
        await cause.retryCleanup()
      await dispose()
    }
    try {
      await cleanup()
    } catch (error_) {
      throw new NativeCandidateBuildCleanupError(cause, error_, cleanup)
    }
    throw cause
  }
}
module.exports = Object.freeze({ buildBrc38WindowsCandidates, windowsSupervisorPolicy })
