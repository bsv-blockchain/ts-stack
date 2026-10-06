import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MAX_LOG = 16 * 1024 * 1024
const MAX_PROFILE = 64 * 1024 * 1024
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

/** Extract call-frame timing, never raw profiles, arguments or application values. */
export function summarizeCPUProfile(profile) {
  const deadline = performance.now() + 30000
  assert.ok(Array.isArray(profile.nodes) && profile.nodes.length > 0)
  assert.ok(Array.isArray(profile.samples) && Array.isArray(profile.timeDeltas))
  assert.equal(profile.samples.length, profile.timeDeltas.length)
  assert.ok(profile.samples.length <= 2000000)
  assert.ok(profile.nodes.length <= 500000)
  const checkDeadline = () => assert.ok(performance.now() < deadline, 'Profile summary deadline')
  const nodes = new Map(),
    parents = new Map(),
    self = new Map(),
    inclusive = new Map()
  for (const node of profile.nodes) {
    checkDeadline()
    assert.ok(Number.isSafeInteger(node.id) && !nodes.has(node.id))
    assert.ok(
      node.callFrame &&
        typeof node.callFrame.functionName === 'string' &&
        typeof node.callFrame.url === 'string' &&
        Number.isSafeInteger(node.callFrame.lineNumber)
    )
    nodes.set(node.id, node)
    for (const child of node.children ?? []) {
      assert.ok(Number.isSafeInteger(child) && !parents.has(child))
      parents.set(child, node.id)
    }
  }
  for (const [child, parent] of parents) {
    checkDeadline()
    assert.ok(nodes.has(child) && nodes.has(parent))
  }
  let total = 0
  for (let index = 0; index < profile.samples.length; index++) {
    if (index % 1024 === 0) checkDeadline()
    const id = profile.samples[index],
      us = profile.timeDeltas[index]
    assert.ok(nodes.has(id) && Number.isFinite(us) && us >= 0)
    total += us
    self.set(id, (self.get(id) ?? 0) + us)
    const seen = new Set()
    let cursor = id
    while (cursor !== undefined) {
      assert.ok(!seen.has(cursor), 'Cyclic profile tree')
      assert.ok(seen.size < 1024, 'Profile stack exceeds bounded depth')
      seen.add(cursor)
      inclusive.set(cursor, (inclusive.get(cursor) ?? 0) + us)
      cursor = parents.get(cursor)
    }
  }
  const clean = value => value.replace(/[^\x20-\x7e]/g, '?').slice(0, 240)
  const rows = map => {
    checkDeadline()
    const sorted = [...map]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 50)
      .map(([id]) => {
        const frame = nodes.get(id).callFrame
        return {
          function: clean(frame.functionName),
          source: clean(frame.url),
          line: frame.lineNumber + 1,
          selfMilliseconds: Math.round((self.get(id) ?? 0) / 1000),
          inclusiveMilliseconds: Math.round((inclusive.get(id) ?? 0) / 1000)
        }
      })
    checkDeadline()
    return sorted
  }
  return {
    samples: profile.samples.length,
    totalMilliseconds: Math.round(total / 1000),
    topSelf: rows(self),
    topInclusive: rows(inclusive),
    rawProfilePrinted: false,
    applicationValuesPrinted: false
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
async function drain(pid) {
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    if (groupAbsent(pid)) return true
    try {
      process.kill(-pid, signal)
    } catch (error) {
      if (error.code !== 'ESRCH') throw error
    }
    const deadline = performance.now() + 5000
    while (performance.now() < deadline) {
      if (groupAbsent(pid)) return true
      await delay(20)
    }
  }
  return groupAbsent(pid)
}
async function supervise(arguments_, cwd, logfile, seconds, env, aborted) {
  const descriptor = fs.openSync(logfile, 'wx'),
    started = performance.now()
  let child,
    stopReason = null,
    timedOut = false,
    code = null,
    signal = null,
    gone = false
  const read = () => {
    const size = fs.statSync(logfile).size,
      bytes = Buffer.alloc(Math.min(size, MAX_LOG + 1))
    const reader = fs.openSync(logfile, 'r')
    try {
      fs.readSync(reader, bytes, 0, bytes.length, 0)
    } finally {
      fs.closeSync(reader)
    }
    return triageDiagnostic(bytes, code)
  }
  try {
    child = spawn(process.execPath, arguments_, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', descriptor, descriptor]
    })
    let ended = false,
      spawnError = false
    child.on('error', () => {
      spawnError = true
      ended = true
    })
    child.on('exit', (value, reason) => {
      code = value
      signal = reason
      ended = true
    })
    while (!ended) {
      if (aborted()) {
        stopReason = aborted()
        break
      }
      const flags = read()
      if (
        flags.knownNativeFaultMarker ||
        flags.boundedTriageExceeded ||
        flags.testCaseTimeoutMarker
      ) {
        stopReason = 'fault-case-or-output-guard'
        break
      }
      if (performance.now() - started >= seconds * 1000) {
        timedOut = true
        stopReason = 'child-deadline'
        break
      }
      await delay(100)
    }
    if (spawnError) stopReason = 'spawn-error'
    if (signal) stopReason ??= 'child-signal'
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

async function main() {
  assert.equal(process.platform, 'linux', 'Application diagnostics require hosted Linux')
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.match(process.env.GITHUB_SHA ?? '', /^[0-9a-f]{40}$/)
  assert.match(process.env.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/)
  assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^[1-9]\d*$/)
  assert.equal(process.argv.length, 2, 'This diagnostic has one fixed unchanged property selector')
  const started = performance.now(),
    until = Date.now() + 900000
  let cancelled = false
  const aborted = () =>
    cancelled
      ? 'operator-cancelled'
      : performance.now() - started >= 900000 || Date.now() >= until
        ? 'diagnostic-calendar-expired'
        : null
  const checkWindow = () =>
    assert.equal(aborted(), null, 'Diagnostic calendar or cancellation guard')
  const root = fileURLToPath(new URL('..', import.meta.url)),
    cwd = path.join(root, 'packages/application/output-knowledge'),
    selector = 'test/private-purchase-alias-disclosure.property.test.ts',
    testSource = fs.readFileSync(path.join(cwd, selector), 'utf8')
  assert.match(testSource, /MIN_PROPERTY_RUNS = 300/)
  assert.match(testSource, /seed : 3242026/)
  assert.match(testSource, /interruptAfterTimeLimit: 150000/)
  assert.match(testSource, /markInterruptAsFailure: true/)
  assert.match(testSource, /}, 180000\)/)
  assert.equal(
    execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    process.env.GITHUB_SHA
  )
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
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
  const guard = () => {
    for (const [file, expected] of frozen) {
      checkWindow()
      assert.equal(hash(file), expected)
    }
  }
  const identity = {
    source: process.env.GITHUB_SHA,
    run: process.env.GITHUB_RUN_ID,
    attempt: process.env.GITHUB_RUN_ATTEMPT,
    node: process.version,
    architecture: process.arch,
    selector,
    calendarUntil: new Date(until).toISOString(),
    calendarSeconds: 900,
    propertySHA256: hash(path.join(cwd, selector)),
    minimumPropertyRuns: 300,
    seed: 3242026,
    interruptAsFailureMilliseconds: 150000,
    testCaseMilliseconds: 180000,
    frozenInputDigest: createHash('sha256')
      .update(JSON.stringify([...frozen]))
      .digest('hex'),
    profilingOverheadIncluded: true,
    fullFunctionalQualified: false,
    fullCampaignQualified: false
  }
  const output = path.join(
    root,
    '.coverage-output',
    `performance-diagnostic-${identity.run}-${identity.attempt}`
  )
  fs.mkdirSync(path.dirname(output), { recursive: true })
  fs.mkdirSync(output)
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'output-knowledge-profile-')),
    results = [],
    env = {
      ...process.env,
      FAST_CHECK_NUM_RUNS: '300',
      FAST_CHECK_SEED: '3242026',
      FAST_CHECK_PATH: '',
      NODE_OPTIONS: ''
    }
  const write = () =>
    fs.writeFileSync(
      path.join(output, 'diagnostic.json'),
      JSON.stringify({ identity, results, rawPayloadPrinted: false }, null, 2)
    )
  const safe = result =>
    result.processGroupGone &&
    !result.timedOut &&
    result.stopReason === null &&
    !result.knownNativeFaultMarker &&
    !result.boundedTriageExceeded &&
    !result.testCaseTimeoutMarker
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
    const measured = await supervise(
      [
        '--cpu-prof',
        `--cpu-prof-dir=${directory}`,
        '--cpu-prof-name=property.cpuprofile',
        '--experimental-vm-modules',
        'node_modules/jest/bin/jest.js',
        '--runInBand',
        '--watchman=false',
        '--config',
        'jest.config.js',
        '--coverage',
        `--coverageDirectory=${path.join(directory, 'coverage')}`,
        '--runTestsByPath',
        selector
      ],
      cwd,
      path.join(directory, 'property.log'),
      210,
      env,
      aborted
    )
    results.push({ phase: 'unchanged-property-with-coverage', ...measured })
    write()
    assert.ok(
      safe(measured) && [0, 1].includes(measured.exitCode),
      'Fault, case timeout, source change or missing drain forbids profile inspection'
    )
    guard()
    const profile = path.join(directory, 'property.cpuprofile')
    assert.ok(fs.statSync(profile).size <= MAX_PROFILE, 'Profile exceeds bounded metadata budget')
    const summary = summarizeCPUProfile(JSON.parse(fs.readFileSync(profile, 'utf8')))
    fs.writeFileSync(
      path.join(output, 'function-timing.json'),
      JSON.stringify({ identity, ...summary }, null, 2)
    )
    guard()
    console.log(
      'Bounded function timing collected; the full ordinary coverage run remains mandatory.'
    )
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
    write()
    process.removeListener('SIGTERM', cancel)
    process.removeListener('SIGINT', cancel)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(() => {
    console.error('Application performance diagnostic refused; inspect Boolean metadata only.')
    process.exitCode = 1
  })
}
