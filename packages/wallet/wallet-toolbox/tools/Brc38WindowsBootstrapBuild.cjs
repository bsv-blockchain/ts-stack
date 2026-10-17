'use strict'
// First-artifact build only, inside an independently controlled isolated worker.
// The external owner must enforce compiler-tree resources and physically stop
// that original worker before candidate qualification. Child close is not tree
// drainage. No generated addon/supervisor/engine is loaded or run by this tool.
const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const cp = require('node:child_process')
const { windowsSupervisorPolicy } = require('./Brc38WindowsCandidateBuild.cjs')
const { copyNativeSourceInput, NativeSourceCleanupError } = require('../src/storage/portable/native/prepare_source.cjs')
const {
  driverSources,
  windowsAddonSources,
  sqlite,
  assertNativeCandidateTarget
} = require('../src/storage/portable/native/source_recipe.cjs')
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
let retainedWorker = false

function bootstrapInputPlan(options) {
  if (!['arm64', 'x64'].includes(options.architecture)) throw new Error('Windows bootstrap architecture differs')
  const policy = windowsSupervisorPolicy(options.toolchain),
    names = new Set()
  if (!Array.isArray(options.nodeHeaders) || options.nodeHeaders.length < 5 || options.nodeHeaders.length > 64)
    throw new Error('Windows bootstrap Node header cohort differs')
  let total = 0
  const headers = options.nodeHeaders.map(input => {
    if (
      typeof input.path !== 'string' ||
      input.path.length > 512 ||
      !/^[A-Za-z0-9_/-]+\.h$/.test(input.path) ||
      input.path.startsWith('/') ||
      input.path
        .split('/')
        .some(part => !part || part === '..' || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) ||
      names.has(input.path.toLowerCase()) ||
      !Number.isSafeInteger(input.bytes) ||
      input.bytes < 1 ||
      input.bytes > 2097152 ||
      !/^[0-9a-f]{64}$/.test(input.sha256) ||
      (total += input.bytes) > 16777216
    )
      throw new Error('Windows bootstrap Node header cohort differs')
    names.add(input.path.toLowerCase())
    return Object.freeze({ path: input.path, bytes: input.bytes, sha256: input.sha256 })
  })
  for (const name of ['node_api.h', 'node_api_types.h', 'js_native_api.h', 'js_native_api_types.h', 'node_version.h'])
    if (!headers.some(input => input.path === name))
      throw new Error('Windows bootstrap Node header cohort is incomplete')
  const library = options.nodeImportLibrary
  if (
    !library ||
    !Number.isSafeInteger(library.bytes) ||
    library.bytes < 1 ||
    library.bytes > 33554432 ||
    !/^[0-9a-f]{64}$/.test(library.sha256)
  )
    throw new Error('Windows bootstrap Node import library differs')
  return Object.freeze({
    architecture: options.architecture,
    policy,
    headers: Object.freeze(headers),
    library: Object.freeze({ bytes: library.bytes, sha256: library.sha256 })
  })
}

// Windows compiler and authored OS-helper invocation only. The explicit caller
// supplies a fixed recipe, never a shell string. Resource/job/tree qualification
// remains the independently admitted outer worker's responsibility.
async function invoke(program, args, cwd, env, milliseconds, maximum = 65536) {
  if (retainedWorker) throw new Error('Original Windows bootstrap worker requires physical shutdown')
  const child = cp.spawn(program, args, {
    cwd,
    env,
    windowsHide: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const chunks = []
  let bytes = 0,
    stopped = false,
    failure
  const stop = cause => {
    stopped = true
    retainedWorker = true
    failure = cause
    child.kill()
  }
  const timer = setTimeout(() => stop(new Error('Windows bootstrap child exceeded its deadline')), milliseconds)
  const collect = chunk => {
    bytes += chunk.length
    if (bytes > maximum) stop(new Error('Windows bootstrap child exceeded its output bound'))
    else chunks.push(Buffer.from(chunk))
  }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  child.on('error', cause => stop(cause))
  const exit = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
  clearTimeout(timer)
  if (stopped || failure || exit.code !== 0 || exit.signal !== null) {
    retainedWorker = true
    throw new Error('Windows bootstrap child failed; original isolated worker and build root remain retained', {
      cause: failure
    })
  }
  return {
    ...exit,
    output: Buffer.concat(chunks).toString('utf8'),
    childCloseObserved: true,
    compilerTreeDrained: false
  }
}
function windowsEnvironment(root, policy) {
  const systemRoot = process.env.SystemRoot
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\Windows$/i.test(systemRoot))
    throw new Error('Windows bootstrap requires the controlled worker system directory')
  return { INCLUDE: policy.include, LIB: policy.lib, PATH: policy.path, SystemRoot: systemRoot, TEMP: root, TMP: root }
}
async function windowsDirectory(mode, directory, policy) {
  const env = windowsEnvironment(directory, policy),
    program = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = await invoke(
    program,
    [
      '-NoProfile',
      '-NonInteractive',
      '-File',
      path.join(__dirname, 'Brc38WindowsBootstrapDirectory.ps1'),
      '-Mode',
      mode,
      '-Directory',
      directory
    ],
    directory,
    env,
    10000,
    8192
  )
  const actual = JSON.parse(result.output)
  if (
    actual.protocol !== 'brc38-windows-bootstrap-directory/v1' ||
    actual.protectedActorOnly !== true ||
    actual.runtimeIdentityAuthority !== false ||
    !/^S-1-5-\d+(?:-\d+)*$/.test(actual.actorSid) ||
    (mode === 'Inspect'
      ? actual.directory !== directory
      : path.dirname(actual.directory) !== directory ||
        !/^brc38-windows-bootstrap-[0-9a-f]{32}$/.test(path.basename(actual.directory)))
  )
    throw new Error('Windows bootstrap directory readback differs')
  return actual
}
async function writeBootstrapBytes(filename, bytes, mode = 0o600) {
  const file = await fs.open(filename, 'wx', mode)
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
    throw new NativeSourceCleanupError(failed ? [failure, cause] : [cause], () => file.close())
  }
  if (failed) throw failure
}
async function writeRecord(filename, value) {
  await writeBootstrapBytes(filename, Buffer.from(JSON.stringify(value, null, 2) + '\n'))
}

/** Pure source capture on every host: no compiler or OS helper runs here.
 * Actual compilation separately creates protected Windows build storage. */
async function prepareWindowsBootstrapSource(options) {
  const plan = bootstrapInputPlan(options),
    coordinates = sourceCoordinates(options),
    directory = await fs.mkdtemp(path.join(path.resolve(options.outputDirectory), 'brc38-windows-bootstrap-'))
  return captureBootstrapSource(coordinates, plan, directory)
}
function sourceCoordinates(options) {
  const result = {
    sqliteSource: options.sqliteSource,
    nodeHeaderDirectory: options.nodeHeaderDirectory,
    nodeImportFilename: options.nodeImportLibrary.filename
  }
  if (Object.values(result).some(value => typeof value !== 'string' || !path.isAbsolute(value)))
    throw new Error('Windows bootstrap dependency coordinates differ')
  return Object.freeze(result)
}
async function captureBootstrapSource(coordinates, plan, directory) {
  const { sqliteSource, nodeHeaderDirectory, nodeImportFilename } = coordinates
  const inputs = []
  try {
    const capture = async (from, name, maximum, expected) => {
      const copied = await copyNativeSourceInput(from, path.join(directory, name), maximum, expected)
      inputs.push({ path: name, bytes: copied.bytes, sha256: copied.sha256 })
    }
    for (const name of [...driverSources, ...windowsAddonSources])
      await capture(path.join(__dirname, '../src/storage/portable/native', name), name, 1048576)
    await capture(sqliteSource, 'sqlite3.c', sqlite.bytes, sqlite)
    await fs.mkdir(path.join(directory, 'node-headers'))
    for (const input of plan.headers) {
      await fs.mkdir(path.dirname(path.join(directory, 'node-headers', input.path)), { recursive: true })
      await capture(path.join(nodeHeaderDirectory, input.path), 'node-headers/' + input.path, input.bytes, input)
    }
    const version = await fs.readFile(path.join(directory, 'node-headers/node_version.h'), 'utf8')
    for (const [name, value] of [
      ['NODE_MAJOR_VERSION', 24],
      ['NODE_MINOR_VERSION', 18],
      ['NODE_PATCH_VERSION', 0],
      ['NODE_MODULE_VERSION', 137]
    ])
      if (!new RegExp('^\\s*#\\s*define\\s+' + name + '\\s+' + value + '\\s*(?://[^\\n]*)?$', 'm').test(version))
        throw new Error('Windows bootstrap captured Node version or ABI differs')
    await capture(nodeImportFilename, 'node.lib', plan.library.bytes, plan.library)
    const header = Buffer.from(plan.policy.header)
    await writeBootstrapBytes(path.join(directory, 'brc38_build_policy.h'), header, 0o400)
    inputs.push({ path: 'brc38_build_policy.h', bytes: header.length, sha256: sha(header) })
    const source = {
      protocol: 'brc38-windows-bootstrap-source/v1',
      platform: 'win32',
      architecture: plan.architecture,
      nodeVersion: '24.18.0',
      nodeModules: '137',
      inputs,
      policySha256: plan.policy.sha256,
      compiler: plan.policy.policy,
      supervisorArguments: plan.policy.supervisorArguments,
      addonArguments: plan.policy.addonArguments,
      compiled: false,
      engineOrAddonExecuted: false,
      qualified: false,
      runtimePinChanged: false
    }
    await writeRecord(path.join(directory, 'bootstrap-source.json'), source)
    return Object.freeze({ directory, source })
  } catch (cause) {
    const cleanup = async () => {
      if (cause instanceof NativeSourceCleanupError) await cause.retryCleanup()
      await fs.rm(directory, { recursive: true })
    }
    if (cause instanceof NativeSourceCleanupError) throw new NativeSourceCleanupError([cause], cleanup)
    try {
      await cleanup()
    } catch (error_) {
      throw new NativeSourceCleanupError([cause, error_], cleanup)
    }
    throw cause
  }
}
async function checkInputs(directory, source) {
  for (let i = 0; i < source.inputs.length; i++) {
    const input = source.inputs[i],
      destination = path.join(directory, 'bootstrap-readback-' + i)
    await copyNativeSourceInput(path.join(directory, input.path), destination, input.bytes, input)
    await fs.unlink(destination)
  }
}
/** Actual Windows compilation only; independently isolate/enforce/stop the
 * original worker. Root is retained even on success until that real shutdown.
 * Newly compiled supervisor/addon candidates are NEVER run by this function. */
async function buildWindowsBootstrap(options) {
  if (
    retainedWorker ||
    process.platform !== 'win32' ||
    !['arm64', 'x64'].includes(process.arch) ||
    options.architecture !== process.arch ||
    process.version !== 'v24.18.0' ||
    process.versions.modules !== '137'
  )
    throw new Error('Windows bootstrap requires its original isolated Windows Node24.18.0 ABI137 worker')
  const plan = bootstrapInputPlan(options),
    coordinates = sourceCoordinates(options),
    parent = path.resolve(options.outputDirectory),
    directory = (await windowsDirectory('Create', parent, plan.policy.policy)).directory,
    { source } = await captureBootstrapSource(coordinates, plan, directory),
    candidates = []
  try {
    for (const [kind, filename, args] of [
      ['driver', 'brc38-build-supervisor.exe', source.supervisorArguments],
      ['addon', 'brc38_windows.node', source.addonArguments]
    ]) {
      await windowsDirectory('Inspect', directory, source.compiler)
      await checkInputs(directory, source)
      const compiler = await invoke(
        source.compiler.compiler,
        [...args],
        directory,
        windowsEnvironment(directory, source.compiler),
        180000
      )
      const staged = path.join(directory, 'bootstrap-image-readback'),
        actual = await copyNativeSourceInput(path.join(directory, filename), staged, 2097152)
      const bytes = await fs.readFile(staged)
      if (bytes.length !== actual.bytes || sha(bytes) !== actual.sha256)
        throw new Error('Windows bootstrap image changed during target readback')
      assertNativeCandidateTarget(bytes, 'win32', process.arch, kind)
      await fs.unlink(staged)
      await checkInputs(directory, source)
      candidates.push({ path: filename, bytes: actual.bytes, sha256: actual.sha256, compiler })
    }
    const receipt = {
      protocol: 'brc38-windows-bootstrap-build/v1',
      finishedAt: new Date().toISOString(),
      source,
      candidates,
      candidatesCompiled: true,
      engineOrAddonOrSupervisorExecuted: false,
      compilerTreeDrained: false,
      originalWorkerPhysicalShutdownRequired: true,
      outerWorkerAttested: false,
      qualified: false,
      runtimePinChanged: false,
      publicationOrDeployment: false
    }
    await writeRecord(path.join(directory, 'bootstrap-build-receipt.json'), receipt)
    return Object.freeze({ directory, receipt })
  } catch (cause) {
    retainedWorker = true
    throw new Error('Windows bootstrap build failed; original worker and source root retained at ' + directory, {
      cause
    })
  }
}
module.exports = Object.freeze({ bootstrapInputPlan, prepareWindowsBootstrapSource, buildWindowsBootstrap })
