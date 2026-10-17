'use strict'
// Maintainer bootstrap process only. The external Windows controller owns the
// real Job; a serialized result never provides process/runtime authority.
const fs = require('node:fs/promises')
const { constants } = require('node:fs')
const path = require('node:path')
const { bootstrapInputPlan, buildWindowsBootstrap } = require('./Brc38WindowsBootstrapBuild.cjs')
const { NativeSourceCleanupError } = require('../src/storage/portable/native/prepare_source.cjs')
const controllerInputs = Object.freeze([
  'tools/Brc38WindowsBootstrapWorker.cjs',
  'tools/Brc38WindowsBootstrapController.ps1',
  'tools/Brc38WindowsBootstrapJob.cs',
  'tools/Brc38WindowsBootstrapBuild.cjs',
  'tools/Brc38WindowsBootstrapDirectory.ps1',
  'tools/Brc38WindowsCandidateBuild.cjs',
  'tools/Brc38NativeCandidateBuild.cjs',
  'src/storage/portable/native/prepare_source.cjs',
  'src/storage/portable/native/source_recipe.cjs'
])
const limits = Object.freeze({
  memoryBytes: 12884901888,
  processCount: 512,
  maximumCPUCount: 4,
  nodeHeapMiB: 1536,
  deadlineMilliseconds: 600000,
  drainMilliseconds: 10000
})
function windowsCoordinate(value) {
  if (
    typeof value !== 'string' ||
    value.length > 2048 ||
    !/^[A-Za-z]:\\/.test(value) ||
    /["<>|?*]/.test(value) ||
    Array.from(value).some(character => character.charCodeAt(0) < 32) ||
    path.win32.normalize(value) !== value ||
    value
      .slice(3)
      .split('\\')
      .some(
        part =>
          !part ||
          /[. ]$/.test(part) ||
          part.includes(':') ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)
      )
  )
    throw new Error('Windows bootstrap worker coordinate differs')
  return value
}
function fixedInput(input, maximum) {
  if (
    !input ||
    !Number.isSafeInteger(input.bytes) ||
    input.bytes < 1 ||
    input.bytes > maximum ||
    !/^[0-9a-f]{64}$/.test(input.sha256)
  )
    throw new Error('Windows bootstrap worker input differs')
  return Object.freeze({ bytes: input.bytes, sha256: input.sha256 })
}
/** Pure immutable recipe DATA, not host or Job admission. */
function bootstrapWorkerPlan(configuration) {
  const bootstrap = configuration.bootstrap,
    architecture = configuration.architecture
  if (!['arm64', 'x64'].includes(architecture) || bootstrap.architecture !== architecture)
    throw new Error('Windows bootstrap worker target differs')
  const input = bootstrapInputPlan(bootstrap),
    node = configuration.nodeExecutable
  const source = configuration.controllerInputs
  if (
    !Array.isArray(source) ||
    source.length !== controllerInputs.length ||
    source.some((entry, index) => entry.path !== controllerInputs[index])
  )
    throw new Error('Windows bootstrap controller cohort differs')
  const executable = windowsCoordinate(node.filename)
  if (path.win32.basename(executable).toLowerCase() !== 'node.exe')
    throw new Error('Windows bootstrap Node executable differs')
  return Object.freeze({
    protocol: 'brc38-windows-bootstrap-worker-plan/v1',
    architecture,
    nodeExecutable: Object.freeze({ filename: executable, ...fixedInput(node, 134217728) }),
    controllerInputs: Object.freeze(
      source.map(entry => Object.freeze({ path: entry.path, ...fixedInput(entry, 1048576) }))
    ),
    bootstrap: Object.freeze({
      architecture,
      toolchain: input.policy.policy,
      nodeHeaders: input.headers,
      nodeHeaderDirectory: windowsCoordinate(bootstrap.nodeHeaderDirectory),
      nodeImportLibrary: Object.freeze({
        filename: windowsCoordinate(bootstrap.nodeImportLibrary.filename),
        ...input.library
      }),
      sqliteSource: windowsCoordinate(bootstrap.sqliteSource),
      outputDirectory: windowsCoordinate(bootstrap.outputDirectory)
    }),
    limits,
    compiled: false,
    qualified: false,
    runtimePinChanged: false
  })
}
/** Validate exported observation DATA only. Actual original controller handles
 * must provide these observations; passing this function never enrolls a host. */
function inspectBootstrapWorkerResult(result) {
  const job = result.job
  const affinity =
    typeof job?.AffinityMaskHex === 'string' && /^[0-9a-f]{16}$/.test(job.AffinityMaskHex)
      ? BigInt('0x' + job.AffinityMaskHex)
      : 0n
  const CPUCount = affinity.toString(2).replaceAll('0', '').length
  if (
    result.protocol !== 'brc38-windows-bootstrap-controller/v1' ||
    !job ||
    affinity === 0n ||
    CPUCount > limits.maximumCPUCount ||
    job.Success !== true ||
    job.AssignedBeforeResume !== true ||
    job.LimitsReadBack !== true ||
    job.NonInheritedJobHandle !== true ||
    job.WorkerExitObserved !== true ||
    job.ZeroActiveProcessesObserved !== true ||
    job.AllHandlesClosed !== true ||
    job.OriginalProcessWorkerStopped !== true ||
    job.DeadlineExpired !== false ||
    job.WorkerExitCode !== 0 ||
    job.MemoryLimitBytes !== limits.memoryBytes ||
    job.ProcessLimit !== limits.processCount ||
    job.MaximumCPUCount !== limits.maximumCPUCount ||
    job.DeadlineMilliseconds !== limits.deadlineMilliseconds ||
    !Array.isArray(job.Errors) ||
    job.Errors.length !== 0 ||
    job.Qualified !== false ||
    job.VMShutdownObserved !== false ||
    result.controllerFilesClosed !== true ||
    !Array.isArray(result.controllerErrors) ||
    result.controllerErrors.length !== 0 ||
    result.VMShutdownObserved !== false ||
    result.qualified !== false ||
    result.runtimePinChanged !== false ||
    result.engineOrAddonExecuted !== false ||
    result.worker?.protocol !== 'brc38-windows-bootstrap-worker/v1' ||
    result.worker.success !== true ||
    result.worker.qualified !== false ||
    result.worker.runtimePinChanged !== false ||
    !Array.isArray(result.candidates) ||
    result.candidates.length !== 2 ||
    result.candidates.some((entry, i) => entry.path !== ['brc38-build-supervisor.exe', 'brc38_windows.node'][i])
  )
    throw new Error('Windows bootstrap controller DATA is incomplete or failed')
  return Object.freeze({
    candidates: Object.freeze(
      result.candidates.map(entry => Object.freeze({ path: entry.path, ...fixedInput(entry, 2097152) }))
    ),
    originalProcessTreeShutdownObserved: true,
    VMShutdownObserved: false,
    qualified: false,
    runtimePinChanged: false
  })
}
async function withOriginalFile(filename, flags, operation) {
  const file = await fs.open(filename, flags)
  let value,
    failure,
    failed = false
  try {
    value = await operation(file)
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
  return value
}
/** Bounded configuration capture only; callable on every host without an OS
 * helper, compiler or native engine. Descriptor failures retain exact retry. */
async function readBootstrapWorkerConfiguration(filename) {
  const bytes = await withOriginalFile(filename, constants.O_RDONLY | constants.O_NOFOLLOW, async file => {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size < 1 || stat.size > 1048576) throw new Error('Bootstrap options extent differs')
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = await file.read(bytes, offset, bytes.length - offset, offset)
      if (!read.bytesRead) throw new Error('Bootstrap options truncated during capture')
      offset += read.bytesRead
    }
    const extra = await file.read(Buffer.alloc(1), 0, 1, offset),
      after = await file.stat()
    if (extra.bytesRead || after.size !== stat.size) throw new Error('Bootstrap options changed during capture')
    return bytes
  })
  return bootstrapWorkerPlan(JSON.parse(bytes.toString('utf8')))
}
async function runBootstrapWorker(filename) {
  if (
    process.platform !== 'win32' ||
    !['arm64', 'x64'].includes(process.arch) ||
    process.version !== 'v24.18.0' ||
    process.versions.modules !== '137'
  )
    throw new Error('Bootstrap process requires Windows Node24.18.0 ABI137')
  const root = process.cwd()
  if (filename !== path.join(root, 'worker-options.json'))
    throw new Error('Bootstrap options are outside original root')
  const plan = await readBootstrapWorkerConfiguration(filename)
  if (plan.architecture !== process.arch || plan.bootstrap.outputDirectory !== root)
    throw new Error('Bootstrap worker target or owned root differs')
  let result
  try {
    const build = await buildWindowsBootstrap(plan.bootstrap)
    result = {
      protocol: 'brc38-windows-bootstrap-worker/v1',
      success: true,
      directory: build.directory,
      receipt: build.receipt,
      qualified: false,
      runtimePinChanged: false
    }
  } catch (cause) {
    process.exitCode = 1
    result = {
      protocol: 'brc38-windows-bootstrap-worker/v1',
      success: false,
      failure: { name: cause.name, message: cause.message },
      qualified: false,
      runtimePinChanged: false
    }
  }
  const output = Buffer.from(JSON.stringify(result) + '\n')
  if (output.length > 1048576) throw new Error('Bootstrap worker result extent differs')
  await withOriginalFile(path.join(root, 'worker-result.json'), 'wx', async written => {
    await written.writeFile(output)
    await written.sync()
  })
  return result
}
module.exports = Object.freeze({
  controllerInputs,
  limits,
  bootstrapWorkerPlan,
  inspectBootstrapWorkerResult,
  readBootstrapWorkerConfiguration,
  runBootstrapWorker
})
if (require.main === module)
  runBootstrapWorker(process.argv[2]).catch(() => {
    process.exitCode = 1
  })
