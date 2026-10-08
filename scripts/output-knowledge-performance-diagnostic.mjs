import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { validateMonotonicTiming } from './output-knowledge-monotonic-timing.mjs'

const MAX_LOG = 16 * 1024 * 1024
const MAX_PROFILE = 64 * 1024 * 1024
const CPU_SAMPLING_INTERVAL_MICROSECONDS = 10000
const MAX_COUNT_FILES = 16
const MAX_COUNT_ROWS = 8192
const markers = [
  'Segmentation fault',
  'Bus error',
  'Illegal instruction',
  'core dumped',
  'SIGSEGV',
  'SIGBUS',
  'SIGABRT',
  'double free',
  'free():',
  'malloc():',
  'Fatal Python error'
]

/** Boolean triage only. Raw diagnostic output never enters the public report. */
export function triageDiagnostic(bytes, code) {
  const text = bytes.subarray(0, MAX_LOG + 1).toString('utf8')
  return {
    knownNativeFaultMarker:
      [-11, -7, -6, 132, 134, 135, 139].includes(code) ||
      markers.some(marker => text.includes(marker)),
    boundedTriageExceeded: bytes.length > MAX_LOG,
    testCaseTimeoutMarker: text.includes('Exceeded timeout of '),
    rawPayloadPrinted: false
  }
}

function indexProfileFrames(profile, checkDeadline) {
  const nodes = new Map(),
    parents = new Map(),
    frames = new Map(),
    frameKeys = new Map()
  for (const node of profile.nodes) {
    checkDeadline()
    assert.ok(Number.isSafeInteger(node.id) && !nodes.has(node.id), 'profile-frame-identity')
    assert.ok(
      node.callFrame &&
        typeof node.callFrame.functionName === 'string' &&
        typeof node.callFrame.url === 'string' &&
        Number.isSafeInteger(node.callFrame.lineNumber),
      'profile-frame-shape'
    )
    nodes.set(node.id, node)
    const key = JSON.stringify([
      node.callFrame.functionName,
      node.callFrame.url,
      node.callFrame.lineNumber
    ])
    frameKeys.set(node.id, key)
    frames.set(key, { callFrame: node.callFrame })
    for (const child of node.children ?? []) {
      assert.ok(Number.isSafeInteger(child) && !parents.has(child), 'profile-parent-identity')
      parents.set(child, node.id)
    }
  }
  for (const [child, parent] of parents) {
    checkDeadline()
    assert.ok(nodes.has(child) && nodes.has(parent), 'profile-parent-reference')
  }
  return { nodes, parents, frames, frameKeys }
}

function profileSampleOrder(profile, nodes, checkDeadline) {
  const timestamps = new Float64Array(profile.samples.length)
  let timestamp = 0,
    negativeDeltas = 0
  for (let index = 0; index < profile.samples.length; index++) {
    if (index % 1024 === 0) checkDeadline()
    assert.ok(nodes.has(profile.samples[index]), 'profile-sample-reference')
    const delta = profile.timeDeltas[index]
    assert.ok(Number.isFinite(delta), 'profile-time-delta')
    timestamp += delta
    assert.ok(Number.isFinite(timestamp) && timestamp >= 0, 'profile-time-delta')
    timestamps[index] = timestamp
    if (delta < 0) negativeDeltas++
  }
  const order = Array.from({ length: profile.samples.length }, (_, index) => index)
  // V8 records relative timestamps. Chromium pairs samples with reconstructed
  // timestamps and sorts observations before deriving nonnegative durations.
  // Preserve every observation; never clamp, omit or invent a sample.
  if (negativeDeltas > 0) {
    checkDeadline()
    order.sort((left, right) => timestamps[left] - timestamps[right] || left - right)
    checkDeadline()
  }
  return { timestamps, order, negativeDeltas }
}

/** Extract call-frame timing, never raw profiles, arguments or application values. */
export function summarizeCPUProfile(profile) {
  const deadline = performance.now() + 30000
  assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0, 'profile-node-array')
  assert.ok(
    Array.isArray(profile.samples) && Array.isArray(profile.timeDeltas),
    'profile-sample-arrays'
  )
  assert.equal(profile.samples.length, profile.timeDeltas.length, 'profile-sample-length')
  assert.ok(profile.samples.length <= 2000000, 'profile-sample-bound')
  assert.ok(profile.nodes.length <= 500000, 'profile-node-bound')
  const checkDeadline = () => assert.ok(performance.now() < deadline, 'Profile summary deadline')
  const { nodes, parents, frames, frameKeys } = indexProfileFrames(profile, checkDeadline),
    self = new Map(),
    inclusive = new Map(),
    selfByFunction = new Map(),
    inclusiveByFunction = new Map()
  const { timestamps, order, negativeDeltas } = profileSampleOrder(profile, nodes, checkDeadline)
  let total = 0,
    previous = 0,
    reorderedSamples = 0
  for (let index = 0; index < profile.samples.length; index++) {
    if (index % 1024 === 0) checkDeadline()
    const sourceIndex = order[index],
      id = profile.samples[sourceIndex],
      us = timestamps[sourceIndex] - previous
    previous = timestamps[sourceIndex]
    if (sourceIndex !== index) reorderedSamples++
    assert.ok(nodes.has(id), 'profile-sample-reference')
    assert.ok(Number.isFinite(us) && us >= 0, 'profile-time-delta')
    total += us
    self.set(id, (self.get(id) ?? 0) + us)
    const key = frameKeys.get(id)
    selfByFunction.set(key, (selfByFunction.get(key) ?? 0) + us)
    const seen = new Set(),
      seenFrames = new Set()
    let cursor = id
    while (cursor !== undefined) {
      assert.ok(!seen.has(cursor), 'Cyclic profile tree')
      assert.ok(seen.size < 1024, 'Profile stack exceeds bounded depth')
      seen.add(cursor)
      inclusive.set(cursor, (inclusive.get(cursor) ?? 0) + us)
      const frameKey = frameKeys.get(cursor)
      // Each function receives the sample once even if it occurs recursively.
      if (!seenFrames.has(frameKey)) {
        seenFrames.add(frameKey)
        inclusiveByFunction.set(frameKey, (inclusiveByFunction.get(frameKey) ?? 0) + us)
      }
      cursor = parents.get(cursor)
    }
  }
  const clean = value => value.replace(/[^\x20-\x7e]/g, '?').slice(0, 240)
  const rows = (map, lookup = nodes, selfTimes = self, inclusiveTimes = inclusive) => {
    checkDeadline()
    const sorted = [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([id]) => {
        const frame = lookup.get(id).callFrame
        return {
          function: clean(frame.functionName),
          source: clean(frame.url),
          line: frame.lineNumber + 1,
          selfMilliseconds: Math.round((selfTimes.get(id) ?? 0) / 1000),
          inclusiveMilliseconds: Math.round((inclusiveTimes.get(id) ?? 0) / 1000)
        }
      })
    checkDeadline()
    return sorted
  }
  return {
    samples: profile.samples.length,
    totalMilliseconds: Math.round(total / 1000),
    negativeDeltas,
    reorderedSamples,
    topSelf: rows(self),
    topInclusive: rows(inclusive),
    functions: frames.size,
    topSelfByFunction: rows(selfByFunction, frames, selfByFunction, inclusiveByFunction),
    topInclusiveByFunction: rows(inclusiveByFunction, frames, selfByFunction, inclusiveByFunction),
    rawProfilePrinted: false,
    applicationValuesPrinted: false
  }
}

/** Read the checked descriptor through a fixed byte budget. A changed size,
 * symlink, non-file or over-budget profile never reaches the JSON parser. */
export function readBoundedProfile(file, maximum, report, checkDeadline) {
  checkDeadline()
  const reader = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(reader)
    assert.ok(stat.isFile(), 'profile-file-kind')
    report.profileBytes = stat.size
    assert.ok(stat.size <= maximum, 'Profile exceeds bounded metadata budget')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      checkDeadline()
      const count = fs.readSync(reader, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    assert.equal(length, stat.size, 'Profile changed during bounded read')
    report.phase = 'profile-json'
    return JSON.parse(bytes.subarray(0, length).toString('utf8'))
  } finally {
    fs.closeSync(reader)
  }
}

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function groupAbsent(pid) {
  try {
    process.kill(-pid, 0)
    return false
  } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
}
async function waitForGroupAbsence(pid, deadline) {
  if (groupAbsent(pid)) return true
  if (performance.now() >= deadline) return false
  await delay(20)
  return waitForGroupAbsence(pid, deadline)
}
async function stopGroup(pid, signal) {
  if (groupAbsent(pid)) return true
  try {
    process.kill(-pid, signal)
  } catch (error) {
    if (error.code === 'ESRCH') return true
    throw error
  }
  return waitForGroupAbsence(pid, performance.now() + 5000)
}
async function drain(pid) {
  if (await stopGroup(pid, 'SIGTERM')) return true
  return stopGroup(pid, 'SIGKILL')
}
async function watchDiagnosticChild(child, read, deadline, aborted, state) {
  if (state.spawnError) return { stopReason: 'spawn-error', timedOut: false }
  const cancellation = aborted()
  if (cancellation) return { stopReason: cancellation, timedOut: false }
  const flags = read()
  if (flags.knownNativeFaultMarker || flags.boundedTriageExceeded || flags.testCaseTimeoutMarker)
    return { stopReason: 'fault-case-or-output-guard', timedOut: false }
  if (child.signalCode) return { stopReason: 'child-signal', timedOut: false }
  if (child.exitCode !== null) return { stopReason: null, timedOut: false }
  if (performance.now() >= deadline) return { stopReason: 'child-deadline', timedOut: true }
  await delay(100)
  return watchDiagnosticChild(child, read, deadline, aborted, state)
}
async function supervise(arguments_, cwd, logfile, seconds, env, aborted) {
  const descriptor = fs.openSync(logfile, 'wx'),
    started = performance.now()
  let child,
    stopReason = null,
    timedOut = false,
    gone = false
  const read = () => {
    const reader = fs.openSync(logfile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
    try {
      const size = fs.fstatSync(reader).size,
        bytes = Buffer.alloc(Math.min(size, MAX_LOG + 1))
      fs.readSync(reader, bytes, 0, bytes.length, 0)
      return triageDiagnostic(bytes, child?.exitCode)
    } finally {
      fs.closeSync(reader)
    }
  }
  try {
    child = spawn(process.execPath, arguments_, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', descriptor, descriptor]
    })
    const state = { spawnError: false }
    child.once('error', () => {
      state.spawnError = true
    })
    const observed = await watchDiagnosticChild(
      child,
      read,
      started + seconds * 1000,
      aborted,
      state
    )
    stopReason = observed.stopReason
    timedOut = observed.timedOut
  } catch {
    stopReason ??= 'supervisor-error'
  } finally {
    if (child?.pid) {
      try {
        gone = await drain(child.pid)
      } catch {
        stopReason ??= 'unproved-drain'
      }
    }
    fs.closeSync(descriptor)
  }
  if (performance.now() - started >= seconds * 1000) timedOut = true
  const code = child?.exitCode ?? null,
    signal = child?.signalCode ?? null
  const flags = read()
  flags.knownNativeFaultMarker ||= ['SIGSEGV', 'SIGBUS', 'SIGABRT', 'SIGILL'].includes(signal)
  const result = {
    exitCode: code,
    signal,
    seconds: (performance.now() - started) / 1000,
    deadlineSeconds: seconds,
    timedOut,
    stopReason,
    processGroup: child?.pid ?? null,
    processGroupGone: gone,
    ...flags
  }
  return result
}

/** A timing-file refusal cannot replace coverage. Only an otherwise safe,
 * drained property measurement permits the ordinary artifact validation to continue.
 * Source/calendar guards must still pass immediately before returning. */
export function diagnosticMayContinueValidation(phase, property) {
  const timingOnly = new Set([
    'profile-file-bound',
    'profile-json',
    'profile-summary',
    'monotonic-file-bound',
    'monotonic-summary',
    'function-count-file-bound',
    'function-count-summary'
  ])
  return (
    timingOnly.has(phase) &&
    property?.processGroupGone === true &&
    property.timedOut === false &&
    property.stopReason === null &&
    property.signal === null &&
    [0, 1].includes(property.exitCode) &&
    property.knownNativeFaultMarker === false &&
    property.boundedTriageExceeded === false &&
    property.testCaseTimeoutMarker === false
  )
}

function functionCountSources(root) {
  const sources = new Map()
  const add = relative => {
    const absolute = path.join(root, relative)
    sources.set(absolute, relative)
    sources.set(pathToFileURL(absolute).href, relative)
  }
  for (const name of ['OutputProtocolJSON', 'OutputProtocolSchema']) {
    add(`packages/sdk/src/overlay-tools/${name}.ts`)
    for (const format of ['esm', 'cjs'])
      add(`packages/sdk/dist/${format}/src/overlay-tools/${name}.js`)
  }
  for (const name of [
    'ProtectedLedgerCodec',
    'SQLiteProtectedLedger',
    'NodeProtectedPayloadCodec',
    'SQLitePrivatePurchaseStore',
    'SQLitePrivatePurchaseAliases',
    'SQLitePrivatePurchaseAliasStore',
    'PrivatePurchaseAliasCoordinator',
    'PrivatePurchaseAliasDisclosure'
  ]) {
    add(`packages/application/output-knowledge/src/private/${name}.ts`)
    add(`packages/application/output-knowledge/dist/private/${name}.js`)
  }
  return sources
}

/** Independent V8 function-range entry counts, never CPU samples or timings.
 * Only fixed repository modules and bounded scalar identities enter the result.
 * Counts combine emitted coverage snapshots/isolates, not completed operations. */
export function summarizeFunctionEntries(coverages, root, checkDeadline) {
  assert.ok(
    Array.isArray(coverages) && coverages.length > 0 && coverages.length <= MAX_COUNT_FILES,
    'function-count-file-bound'
  )
  const sources = functionCountSources(root),
    rows = new Map()
  let scripts = 0,
    functions = 0,
    ranges = 0
  for (const coverage of coverages) {
    checkDeadline()
    assert.ok(Array.isArray(coverage.result), 'function-count-shape')
    for (const script of coverage.result) {
      checkDeadline()
      assert.ok(++scripts <= 16384, 'function-count-script-bound')
      assert.ok(
        typeof script.url === 'string' && Array.isArray(script.functions),
        'function-count-shape'
      )
      functions += script.functions.length
      assert.ok(functions <= 200000, 'function-count-function-bound')
      const source = sources.get(script.url)
      if (!source) continue
      for (const fn of script.functions) {
        checkDeadline()
        assert.ok(
          typeof fn.functionName === 'string' &&
            fn.functionName.length <= 128 &&
            /^(?:(?:get|set) )?[#A-Za-z_$][A-Za-z0-9_$#]*$|^$/.test(fn.functionName) &&
            typeof fn.isBlockCoverage === 'boolean' &&
            Array.isArray(fn.ranges) &&
            fn.ranges.length > 0,
          'function-count-shape'
        )
        ranges += fn.ranges.length
        assert.ok(ranges <= 1000000, 'function-count-range-bound')
        const outer = fn.ranges[0]
        for (const range of fn.ranges) {
          checkDeadline()
          assert.ok(
            Number.isSafeInteger(range.startOffset) &&
              Number.isSafeInteger(range.endOffset) &&
              range.startOffset >= 0 &&
              range.startOffset < range.endOffset &&
              range.endOffset <= MAX_PROFILE &&
              range.startOffset >= outer.startOffset &&
              range.endOffset <= outer.endOffset &&
              Number.isSafeInteger(range.count) &&
              range.count >= 0 &&
              range.count <= 1000000000,
            'function-count-range'
          )
        }
        const key = JSON.stringify([source, fn.functionName, outer.startOffset, outer.endOffset]),
          existing = rows.get(key)
        if (existing) {
          existing.entries += outer.count
          assert.ok(existing.entries <= 1000000000, 'function-count-total-bound')
        } else {
          assert.ok(rows.size < MAX_COUNT_ROWS, 'function-count-row-bound')
          rows.set(key, {
            source,
            functionName: fn.functionName,
            startOffset: outer.startOffset,
            endOffset: outer.endOffset,
            entries: outer.count
          })
        }
      }
    }
  }
  assert.ok(rows.size > 0, 'function-count-empty')
  checkDeadline()
  return {
    coverageFiles: coverages.length,
    countSemantics: 'outer-function-range-entries-across-emitted-snapshots-and-isolates',
    transformedOffsets: true,
    timingCollected: false,
    fullFunctionalQualified: false,
    fullCampaignQualified: false,
    rows: [...rows.values()].sort(
      (left, right) =>
        right.entries - left.entries ||
        left.source.localeCompare(right.source) ||
        left.startOffset - right.startOffset ||
        left.functionName.localeCompare(right.functionName)
    )
  }
}

/** Read only an owned, drained directory, with an aggregate 64 MiB bound.
 * Raw coverage, including source maps, is never returned or uploaded. */
export function readFunctionEntries(directory, root, checkDeadline) {
  checkDeadline()
  const stat = fs.lstatSync(directory)
  assert.ok(stat.isDirectory() && !stat.isSymbolicLink(), 'function-count-directory')
  const files = fs.readdirSync(directory)
  assert.ok(files.length > 0 && files.length <= MAX_COUNT_FILES, 'function-count-file-bound')
  let bytes = 0
  const coverages = []
  for (const name of files.sort()) {
    checkDeadline()
    assert.match(name, /^coverage-[0-9]+-[0-9]+-[0-9]+\.json$/, 'function-count-file-name')
    const file = path.join(directory, name),
      metadata = {}
    coverages.push(readBoundedProfile(file, MAX_PROFILE - bytes, metadata, checkDeadline))
    bytes += metadata.profileBytes
    assert.ok(Number.isSafeInteger(bytes) && bytes <= MAX_PROFILE, 'function-count-file-bound')
  }
  return summarizeFunctionEntries(coverages, root, checkDeadline)
}

/** Only scalar results from a safe, drained, bounded property measurement.
 * A passing exit supplies no inferred count or qualification claim. */
export function summarizePropertyExecution(bytes, measured) {
  assert.ok(
    diagnosticMayContinueValidation('profile-summary', measured),
    'Unsafe property execution metadata'
  )
  const flags = triageDiagnostic(bytes, measured.exitCode)
  assert.ok(
    !flags.knownNativeFaultMarker && !flags.boundedTriageExceeded && !flags.testCaseTimeoutMarker,
    'Unsafe property execution metadata'
  )
  const matches = bytes
    .toString('utf8')
    .matchAll(
      /^[ \t]*(?:Error: )?Property (interrupted|failed) after (0|[1-9]\d*) tests[ \t]*\r?$/gm
    )
  const first = matches.next(),
    second = matches.next()
  if (!first.done && second.done && measured.exitCode === 1) {
    const completedCases = Number(first.value[2])
    if (Number.isSafeInteger(completedCases) && completedCases <= 300)
      return {
        outcome: first.value[1] === 'interrupted' ? 'interrupted' : 'counterexample',
        completedCases
      }
  }
  return {
    outcome: measured.exitCode === 0 && first.done ? 'passed' : 'other-failure',
    completedCases: null
  }
}

function readPropertyExecution(file, measured, checkDeadline) {
  assert.ok(
    diagnosticMayContinueValidation('profile-summary', measured),
    'Unsafe property execution metadata'
  )
  checkDeadline()
  const reader = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try {
    const stat = fs.fstatSync(reader)
    assert.ok(stat.isFile() && stat.size <= MAX_LOG, 'Unsafe property execution log')
    const bytes = Buffer.alloc(stat.size + 1)
    let length = 0
    while (length < bytes.length) {
      checkDeadline()
      const count = fs.readSync(reader, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    assert.equal(length, stat.size, 'Property execution log changed during bounded read')
    return summarizePropertyExecution(bytes.subarray(0, length), measured)
  } finally {
    fs.closeSync(reader)
  }
}

/** Fixed diagnostic selectors only; neither replaces complete qualification. */
export function applicationDiagnosticSelection(kind = 'property') {
  assert.ok(
    ['property', 'coordinator-property', 'native-http'].includes(kind),
    'Unknown application diagnostic selector'
  )
  if (kind === 'native-http')
    return Object.freeze({
      kind: 'native-http',
      minimumPropertyRuns: null,
      seed: null,
      interruptAsFailureMilliseconds: null,
      packageDirectory: 'packages/overlays/overlay-express',
      selector: 'src/__tests__/PrivatePurchaseProfileAliasNative.integration.test.ts',
      phase: 'unchanged-native-http-with-coverage',
      profile: 'native-http.cpuprofile',
      outputPrefix: 'performance-diagnostic-native-http',
      deadlineSeconds: 600,
      testCaseMilliseconds: 120000,
      nativeCases: 4,
      requiresMongo: true
    })
  const coordinator = kind === 'coordinator-property'
  return Object.freeze({
    kind,
    minimumPropertyRuns: 300,
    seed: 3242026,
    interruptAsFailureMilliseconds: 150000,
    packageDirectory: 'packages/application/output-knowledge',
    selector: coordinator
      ? 'test/private-purchase-alias-coordinator.property.test.ts'
      : 'test/private-purchase-alias-disclosure.property.test.ts',
    phase: 'unchanged-property-with-coverage',
    profile: coordinator ? 'coordinator-property.cpuprofile' : 'property.cpuprofile',
    outputPrefix: coordinator ? 'performance-diagnostic-coordinator' : 'performance-diagnostic',
    deadlineSeconds: 210,
    testCaseMilliseconds: 180000,
    nativeCases: null,
    requiresMongo: false
  })
}

function validateDiagnosticSource(root, cwd, selection) {
  const testSource = fs.readFileSync(path.join(cwd, selection.selector), 'utf8')
  if (!selection.requiresMongo) {
    assert.match(testSource, /MIN_PROPERTY_RUNS = 300/)
    assert.match(testSource, /seed : 3242026/)
    assert.match(testSource, /interruptAfterTimeLimit: 150000/)
    assert.match(testSource, /markInterruptAsFailure: true/)
    assert.match(testSource, /}, 180000\)/)
    return
  }
  assert.equal(testSource.match(/}, 120000\)/g)?.length, selection.nativeCases)
  assert.match(
    fs.readFileSync(
      path.join(cwd, 'src/__tests__/PrivatePurchaseProfileAliasNative.fixture.ts'),
      'utf8'
    ),
    /createMongoReplicaFixture\(\)/
  )
  assert.match(
    fs.readFileSync(
      path.join(root, 'packages/overlays/overlay/src/__tests/mongo/MongoReplicaFixture.ts'),
      'utf8'
    ),
    /binary: \{ version: '8\.2\.6' \}/
  )
}

function freezeNativeDiagnosticRuntime(root, selection, walk, freeze) {
  if (!selection.requiresMongo) return null
  for (const directory of [
    'packages/overlays/overlay/dist',
    'packages/overlays/overlay-express/dist',
    'packages/content/lch/dist'
  ])
    walk(path.join(root, directory))
  assert.ok(process.env.RUNNER_TEMP, 'Hosted native runtime directory is required')
  const cache = path.join(process.env.RUNNER_TEMP, 'mongodb-binaries')
  assert.equal(process.env.MONGOMS_DOWNLOAD_DIR, cache, 'Unselected Mongo runtime directory')
  assert.equal(fs.realpathSync(cache), cache, 'Mongo runtime directory must be owned')
  const candidates = fs.readdirSync(cache).filter(name => /^mongod.*8\.2\.6$/.test(name))
  assert.equal(candidates.length, 1, 'Exactly one cached fixed Mongo binary is required')
  const binary = path.join(cache, candidates[0]),
    stat = fs.lstatSync(binary)
  assert.ok(stat.isFile() && (stat.mode & 0o111) !== 0, 'Mongo runtime must be an executable file')
  freeze(binary)
  return binary
}

function selectionFromArguments(args) {
  assert.ok(
    args.length === 2 ||
      (args.length === 3 && ['--native-http', '--coordinator'].includes(args[2])),
    'Only fixed unchanged diagnostic selectors are permitted'
  )
  if (args.length === 2) return applicationDiagnosticSelection()
  return applicationDiagnosticSelection(
    args[2] === '--native-http' ? 'native-http' : 'coordinator-property'
  )
}

function diagnosticEnvironment(mongoBinary, monotonicFile, countDirectory) {
  const env = {
    ...process.env,
    FAST_CHECK_NUM_RUNS: '300',
    FAST_CHECK_SEED: '3242026',
    FAST_CHECK_PATH: '',
    NODE_OPTIONS: '',
    OUTPUT_KNOWLEDGE_MONOTONIC_FILE: monotonicFile,
    NODE_V8_COVERAGE: countDirectory ?? ''
  }
  if (mongoBinary) {
    env.MONGOMS_SYSTEM_BINARY = mongoBinary
    env.MONGOMS_SYSTEM_BINARY_VERSION_CHECK = 'true'
    env.MONGOMS_RUNTIME_DOWNLOAD = 'false'
    env.MONGOMS_DOWNLOAD_DIR = path.dirname(mongoBinary)
  }
  return env
}

function collectPropertyExecution(selection, directory, measured, report, guard, checkWindow) {
  if (selection.requiresMongo) return
  report.phase = 'property-execution-metadata'
  report.propertyExecution = readPropertyExecution(
    path.join(directory, 'property.log'),
    measured,
    checkWindow
  )
  guard()
}

async function main() {
  assert.equal(process.platform, 'linux', 'Application diagnostics require hosted Linux')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/)
  assert.match(process.env.OUTPUT_KNOWLEDGE_SOURCE_HEAD ?? '', /^[0-9a-f]{40}$/)
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/)
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d*$/)
  const selection = selectionFromArguments(process.argv)
  const started = performance.now(),
    until = Date.now() + 900000
  let cancelled = false
  const aborted = () => {
    if (cancelled) return 'operator-cancelled'
    if (performance.now() - started >= 900000 || Date.now() >= until)
      return 'diagnostic-calendar-expired'
    return null
  }
  const checkWindow = () =>
    assert.equal(aborted(), null, 'Diagnostic calendar or cancellation guard')
  const root = fileURLToPath(new URL('..', import.meta.url)),
    cwd = path.join(root, selection.packageDirectory),
    selector = selection.selector
  validateDiagnosticSource(root, cwd, selection)
  assert.equal(
    execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    process.env.GITHUB_SHA
  )
  execFileSync(
    '/usr/bin/git',
    ['merge-base', '--is-ancestor', process.env.OUTPUT_KNOWLEDGE_SOURCE_HEAD, 'HEAD'],
    { cwd: root, stdio: 'pipe' }
  )
  const files = execFileSync('/usr/bin/git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean)
  const frozen = new Map()
  const freeze = file => {
    checkWindow()
    frozen.set(file, hash(file))
  }
  for (const file of files) freeze(path.join(root, file))
  frozen.set(process.execPath, hash(process.execPath))
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name)
      assert.ok(!entry.isSymbolicLink(), 'Runtime source must be owned files')
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile()) freeze(file)
    }
  }
  for (const directory of [
    'packages/sdk/dist',
    'packages/wallet/wallet-toolbox/out',
    'packages/application/output-knowledge/dist'
  ])
    walk(path.join(root, directory))
  const mongoBinary = freezeNativeDiagnosticRuntime(root, selection, walk, freeze)
  const guard = () => {
    for (const [file, expected] of frozen) {
      checkWindow()
      assert.equal(hash(file), expected)
    }
  }
  const identity = {
    source: process.env.GITHUB_SHA,
    sourceHead: process.env.OUTPUT_KNOWLEDGE_SOURCE_HEAD,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    node: process.version,
    architecture: process.arch,
    selector,
    diagnosticKind: selection.kind,
    calendarUntil: new Date(until).toISOString(),
    calendarSeconds: 900,
    propertySHA256: hash(path.join(cwd, selector)),
    minimumPropertyRuns: selection.minimumPropertyRuns,
    seed: selection.seed,
    interruptAsFailureMilliseconds: selection.interruptAsFailureMilliseconds,
    testCaseMilliseconds: selection.testCaseMilliseconds,
    nativeCases: selection.nativeCases,
    mongo: mongoBinary
      ? { version: '8.2.6', binary: path.basename(mongoBinary), sha256: frozen.get(mongoBinary) }
      : null,
    frozenInputDigest: createHash('sha256')
      .update(JSON.stringify([...frozen]))
      .digest('hex'),
    profilingOverheadIncluded: true,
    functionEntryCoverageOverheadIncluded: true,
    samplingIntervalMicroseconds: CPU_SAMPLING_INTERVAL_MICROSECONDS,
    fullFunctionalQualified: false,
    fullCampaignQualified: false
  }
  const output = path.join(
    root,
    '.coverage-output',
    `${selection.outputPrefix}-${identity.run}-${identity.attempt}`
  )
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.mkdirSync(output)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'output-knowledge-profile-')),
    results = [],
    report = {
      phase: 'sqlite-health',
      refusal: null,
      timingCollected: false,
      monotonicCollected: false,
      functionEntriesCollected: false,
      propertyExecution: null
    },
    env = diagnosticEnvironment(mongoBinary, path.join(directory, 'monotonic-timing.json'))
  const write = () =>
    fs.writeFileSync(
      path.join(output, 'diagnostic.json'),
      JSON.stringify({ identity, results, report, rawPayloadPrinted: false }, null, 2)
    )
  const safe = result =>
    result.processGroupGone &&
    !result.timedOut &&
    result.stopReason === null &&
    !result.knownNativeFaultMarker &&
    !result.boundedTriageExceeded &&
    !result.testCaseTimeoutMarker
  let measured
  const cancel = () => {
    cancelled = true
  }
  process.on('SIGTERM', cancel)
  process.on('SIGINT', cancel)
  try {
    checkWindow()
    guard()
    const health = await supervise(
      [
        '--input-type=module',
        '-e',
        "import assert from 'node:assert/strict'; import {DatabaseSync} from 'node:sqlite'; const db=new DatabaseSync(':memory:'); assert.equal(db.prepare('SELECT 1 AS n').get().n,1); db.close(); console.log('Owned built-in SQLite health check passed')"
      ],
      cwd,
      path.join(directory, 'health.log'),
      30,
      env,
      aborted
    )
    results.push({ phase: 'sqlite-health', ...health })
    write()
    assert.ok(safe(health) && health.exitCode === 0, 'Driver health is not qualified')
    guard()
    report.phase = selection.phase
    measured = await supervise(
      [
        '--cpu-prof',
        `--cpu-prof-interval=${CPU_SAMPLING_INTERVAL_MICROSECONDS}`,
        `--cpu-prof-dir=${directory}`,
        `--cpu-prof-name=${selection.profile}`,
        '--import',
        path.join(root, 'scripts/output-knowledge-monotonic-preload.mjs'),
        '--experimental-vm-modules',
        'node_modules/jest/bin/jest.js',
        '--runInBand',
        '--watchman=false',
        '--config',
        'jest.config.js',
        ...(selection.requiresMongo ? ['--selectProjects', 'private-esm'] : []),
        '--coverage',
        `--coverageDirectory=${path.join(directory, 'coverage')}`,
        '--runTestsByPath',
        selector
      ],
      cwd,
      path.join(directory, 'property.log'),
      selection.deadlineSeconds,
      diagnosticEnvironment(
        mongoBinary,
        path.join(directory, 'monotonic-timing.json'),
        path.join(directory, 'function-counts')
      ),
      aborted
    )
    results.push({ phase: selection.phase, ...measured })
    write()
    assert.ok(
      safe(measured) && [0, 1].includes(measured.exitCode),
      'Fault, case timeout, source change or missing drain forbids profile inspection'
    )
    report.phase = 'post-property-source-guard'
    guard()
    collectPropertyExecution(selection, directory, measured, report, guard, checkWindow)
    report.phase = 'function-count-file-bound'
    const functionEntries = readFunctionEntries(
      path.join(directory, 'function-counts'),
      root,
      checkWindow
    )
    report.phase = 'function-count-summary'
    guard()
    fs.writeFileSync(
      path.join(output, 'function-entries.json'),
      JSON.stringify({ identity, ...functionEntries }, null, 2)
    )
    report.functionEntriesCollected = true
    report.phase = 'monotonic-file-bound'
    const monotonic = readBoundedProfile(
      path.join(directory, 'monotonic-timing.json'),
      32768,
      {},
      checkWindow
    )
    report.phase = 'monotonic-summary'
    validateMonotonicTiming(monotonic)
    assert.deepEqual(monotonic.rows.map(row => row.method).sort(), [
      'DatabaseSync.close',
      'DatabaseSync.exec',
      'DatabaseSync.prepare',
      'Hash.digest',
      'Hash.update',
      'StatementSync.all',
      'StatementSync.get',
      'StatementSync.iterate',
      'StatementSync.run',
      'crypto.createCipheriv',
      'crypto.createDecipheriv',
      'crypto.createHash',
      'crypto.hkdfSync'
    ])
    guard()
    fs.writeFileSync(
      path.join(output, 'monotonic-timing.json'),
      JSON.stringify({ identity, ...monotonic }, null, 2)
    )
    report.monotonicCollected = true
    report.phase = 'profile-file-bound'
    const parsed = readBoundedProfile(
      path.join(directory, selection.profile),
      MAX_PROFILE,
      report,
      checkWindow
    )
    report.phase = 'profile-summary'
    report.profileNodes = Array.isArray(parsed.nodes) ? parsed.nodes.length : null
    report.profileSamples = Array.isArray(parsed.samples) ? parsed.samples.length : null
    const summary = summarizeCPUProfile(parsed)
    report.phase = 'final-source-guard'
    guard()
    fs.writeFileSync(
      path.join(output, 'function-timing.json'),
      JSON.stringify({ identity, ...summary }, null, 2)
    )
    report.phase = 'timing-collected'
    report.timingCollected = true
    console.log(
      'Bounded function timing collected; the full ordinary coverage run remains mandatory.'
    )
  } catch (error) {
    const reasons = new Set([
      'profile-frame-identity',
      'profile-frame-shape',
      'profile-parent-identity',
      'profile-parent-reference',
      'profile-node-array',
      'profile-sample-arrays',
      'profile-sample-length',
      'profile-sample-bound',
      'profile-node-bound',
      'profile-sample-reference',
      'profile-time-delta',
      'Cyclic profile tree',
      'Profile stack exceeds bounded depth',
      'Profile summary deadline',
      'Profile exceeds bounded metadata budget',
      'profile-file-kind',
      'Profile changed during bounded read'
    ])
    report.refusal =
      error instanceof Error && reasons.has(error.message.split('\n', 1)[0])
        ? error.message.split('\n', 1)[0]
        : 'unclassified-refusal'
    const code = error?.code
    report.fileAbsent = report.phase === 'profile-file-bound' && code === 'ENOENT'
    if (diagnosticMayContinueValidation(report.phase, measured)) {
      guard()
      console.log(
        'Timing extraction refused; the safe drained measurement does not qualify anything and complete artifact validation continues; ordinary coverage remains independently required.'
      )
      return
    }
    throw error
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
    write()
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main()
  } catch {
    console.error('Application performance diagnostic refused; inspect Boolean metadata only.')
    process.exitCode = 1
  }
}
