import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { calculateMutationMetrics, evaluateMutationReport } from './mutation-testing.mjs'
import { partitionMutationTarget } from './mutation-partitions.mjs'
import { targetEvidence } from './mutation-final-qualification.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const PILOT_CASES = {
  'native-clock': { target: 'private-purchase-native-clock', parts: ['progress-8'] },
  disclosure: { target: 'private-purchase-disclosure', parts: ['auto-3'] },
  'lookup-buyer': { target: 'private-lookup-buyer', parts: ['buyer', 'payment'] }
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: ROOT, encoding: 'utf8' }).trim()
const compare = (left, right) => {
  if (left === right) return 0
  return left < right ? -1 : 1
}
const ordered = values => [...values].sort(compare)
const mutantKey = (file, mutant) =>
  JSON.stringify([
    file,
    mutant.location.start.line,
    mutant.location.start.column,
    mutant.location.end.line,
    mutant.location.end.column,
    mutant.mutatorName,
    mutant.replacement
  ])

function entries(report) {
  assert.equal(report.schemaVersion, '1.0')
  assert.equal(report.framework?.name, 'StrykerJS')
  assert.equal(report.framework.version, '10.1.1')
  const rows = Object.entries(report.files).flatMap(([file, value]) =>
    value.mutants.map(mutant => ({
      key: mutantKey(file, mutant),
      mutant
    }))
  )
  assert(rows.length > 0, 'Empty pilot inventory')
  assert.equal(new Set(rows.map(row => row.key)).size, rows.length, 'Repeated mutant')
  return rows
}

function testIdentities(report) {
  const result = new Map()
  for (const [file, value] of Object.entries(report.testFiles ?? {}))
    for (const [ordinal, test] of value.tests.entries()) {
      assert.equal(typeof test.id, 'string', 'Missing test identity')
      assert(!result.has(test.id), 'Repeated test identity')
      result.set(
        test.id,
        JSON.stringify([file, ordinal, hash(value.source), test.name, test.location])
      )
    }
  return result
}

function tests(report) {
  return ordered(testIdentities(report).values())
}

function configuration(report) {
  const config = structuredClone(report.config)
  delete config.jsonReporter.fileName
  delete config.jest.config.testSequencer
  return config
}

function detectionRegressions(key, mutant, result) {
  const regressions = []
  if (
    mutant.status === 'Survived' &&
    result.status === 'Survived' &&
    mutant.testsCompleted !== result.testsCompleted
  )
    regressions.push({
      key,
      before: mutant.testsCompleted,
      after: 'survivor-execution-count-changed'
    })
  if (result.status === 'Killed' && !['Killed', 'Timeout'].includes(mutant.status))
    regressions.push({ key, before: mutant.status, after: 'new-kill-needs-review' })
  if (mutant.status === 'Killed' && result.status !== 'Killed')
    regressions.push({ key, before: mutant.status, after: result.status })
  if (result.status === 'Timeout' && mutant.status !== 'Timeout')
    regressions.push({ key, before: mutant.status, after: 'new-timeout' })
  if (mutant.status === 'Timeout' && !['Killed', 'Timeout'].includes(result.status))
    regressions.push({ key, before: mutant.status, after: result.status })
  if (['CompileError', 'RuntimeError', 'Ignored'].includes(result.status))
    regressions.push({ key, before: mutant.status, after: result.status })
  assert(
    [
      'Killed',
      'Survived',
      'Timeout',
      'NoCoverage',
      'CompileError',
      'RuntimeError',
      'Ignored'
    ].includes(result.status),
    'Unknown mutant status'
  )
  if (
    result.status === 'Survived' &&
    (!Number.isSafeInteger(result.testsCompleted) || result.testsCompleted <= 0)
  )
    regressions.push({ key, before: mutant.status, after: 'unexecuted' })
  if (result.status === 'NoCoverage' && mutant.status !== 'NoCoverage')
    regressions.push({ key, before: mutant.status, after: 'new-uncovered' })
  return regressions
}

/** This compares diagnostics. It cannot create a publication qualification. */
export function comparePilotReports(baseline, candidate) {
  assert.equal(
    baseline.config.jest.config.testSequencer,
    undefined,
    'Unexpected baseline sequencer'
  )
  assert.match(
    candidate.config.jest.config.testSequencer ?? '',
    /\/governance\/mutation-testing\/fast-failure-sequencer\.cjs$/,
    'Unexpected candidate sequencer'
  )
  const original = entries(baseline)
  const next = new Map(entries(candidate).map(row => [row.key, row.mutant]))
  assert.deepEqual(ordered(original.map(row => row.key)), ordered(next.keys()), 'Inventory changed')
  assert.deepEqual(
    Object.fromEntries(Object.entries(baseline.files).map(([file, value]) => [file, value.source])),
    Object.fromEntries(
      Object.entries(candidate.files).map(([file, value]) => [file, value.source])
    ),
    'Mutated production source changed'
  )
  assert.deepEqual(configuration(baseline), configuration(candidate), 'Execution settings changed')
  assert.deepEqual(tests(baseline), tests(candidate), 'Selected test definitions changed')
  assert(tests(baseline).length > 0, 'Missing complete initial test definitions')
  const beforeTests = testIdentities(baseline)
  const afterTests = testIdentities(candidate)
  const coverage = (mutant, identities) =>
    mutant.coveredBy
      ?.map(id => {
        assert(identities.has(id), 'Unknown covered test')
        return identities.get(id)
      })
      .sort(compare)
  const regressions = []
  const limits = (rows, arm) =>
    rows.flatMap(({ key, mutant }) => {
      const reason = mutant.statusReason ?? ''
      if (mutant.status !== 'Killed') return []
      let kind
      if (/^(?:Error: )?Property interrupted after \d+ tests/m.test(reason))
        kind = 'property-exploration-limit'
      else if (
        /^Error:(?: thrown:)? ["']?Exceeded timeout of \d+ ms for a (?:test|hook)/m.test(reason)
      )
        kind = 'jest-deadline'
      if (!kind) return []
      return [{ key, arm, kind, reportedStatus: mutant.status, reason: reason.split('\n')[0] }]
    })
  const harnessLimitedKills = [
    ...limits(original, 'baseline'),
    ...limits(
      [...next].map(([key, mutant]) => ({ key, mutant })),
      'candidate'
    )
  ]
  for (const { key, mutant } of original) {
    const result = next.get(key)
    assert.deepEqual(
      coverage(mutant, beforeTests),
      coverage(result, afterTests),
      'Per-mutant test coverage changed'
    )
    regressions.push(...detectionRegressions(key, mutant, result))
  }
  return {
    canonicalSites: original.length,
    selectedTests: tests(baseline).length,
    baseline: calculateMutationMetrics(original.map(row => row.mutant)),
    candidate: calculateMutationMetrics([...next.values()]),
    regressions,
    harnessLimitedKills,
    requiresAdjudication: harnessLimitedKills.length > 0,
    noWeaker: regressions.length === 0,
    publicationQualification: false
  }
}

export function requireDeclaredProperty(report, relative, source) {
  const observed = report.testFiles?.[relative]
  assert(
    Array.isArray(observed?.tests) && observed.tests.length > 0,
    'Declared property absent from actual runner report'
  )
  assert.equal(observed.source, source, 'Declared property source differs from the observed tests')
}

export function initialRunEvidence(log) {
  const matches = [
    ...log.matchAll(
      /Initial test run succeeded\. Ran ([1-9]\d*) tests in [^\r\n]+ \(net (\d+) ms, overhead (\d+) ms\)\./g
    )
  ]
  assert.equal(matches.length, 1, 'Expected exactly one successful initial test run')
  return {
    tests: Number(matches[0][1]),
    netMilliseconds: Number(matches[0][2]),
    overheadMilliseconds: Number(matches[0][3])
  }
}

function requireTargetProperty(report, target) {
  const file = path.join(ROOT, target.propertyTest)
  const relative = path
    .relative(path.join(ROOT, target.packageDirectory), file)
    .split(path.sep)
    .join('/')
  requireDeclaredProperty(report, relative, fs.readFileSync(file, 'utf8'))
}

function identity() {
  assert.equal(
    git('status', '--porcelain', '--untracked-files=all'),
    '',
    'Commit pilot inputs first'
  )
  return {
    source: git('rev-parse', 'HEAD'),
    tree: git('rev-parse', 'HEAD^{tree}'),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpuCount: os.availableParallelism(),
    memoryBytes: os.totalmem(),
    cpuModel: os.cpus()[0]?.model,
    hostedRun: process.env.GITHUB_RUN_ID ?? '',
    hostedAttempt: process.env.GITHUB_RUN_ATTEMPT ?? ''
  }
}

// Yielding promises preserves one Stryker child at a time on each measured runner.
async function* serialResults(values, operation) {
  for (const value of values) yield operation(value)
}

async function executePart({
  directory,
  part,
  variant,
  run,
  target,
  targetId,
  partitions,
  policy
}) {
  const destination = path.join(directory, part)
  fs.mkdirSync(destination)
  const start = performance.now()
  console.log(`Starting ${variant} ${targetId}/${part}`)
  const log = fs.openSync(path.join(destination, 'execution.log'), 'wx')
  const env = {
    ...process.env,
    FAST_CHECK_NUM_RUNS: String(policy.tool.propertyRuns),
    FAST_CHECK_SEED: String(policy.tool.propertySeed),
    FAST_CHECK_PATH: '',
    TS_STACK_MUTATION_TARGET: targetId,
    TS_STACK_MUTATION_PARTITION: part,
    TS_STACK_MUTATION_PILOT_VARIANT: variant,
    TS_STACK_MUTATION_PILOT_RUN: run
  }
  delete env.NODE_OPTIONS
  const code = await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(ROOT, 'node_modules/.bin/stryker'),
      ['run', path.join(ROOT, 'governance/mutation-testing/pilot.config.mjs')],
      {
        cwd: path.join(ROOT, target.packageDirectory),
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    for (const [input, output] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr]
    ])
      input?.on('data', bytes => {
        fs.writeSync(log, bytes)
        output.write(bytes)
      })
    // Bound local runs as well as the workflow job. Preserve logs on timeout.
    const stop = () => {
      if (child.pid === undefined) return
      try {
        // The detached POSIX group belongs only to this measured Stryker child.
        process.kill(-child.pid, 'SIGKILL')
      } catch (error) {
        if (error.code !== 'ESRCH') child.kill('SIGKILL')
      }
    }
    const deadline = setTimeout(stop, 180 * 60 * 1000)
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    const cleanup = () => {
      clearTimeout(deadline)
      process.removeListener('SIGTERM', stop)
      process.removeListener('SIGINT', stop)
    }
    child.once('error', error => {
      cleanup()
      reject(error)
    })
    child.once('close', code => {
      cleanup()
      resolve(code)
    })
  }).finally(() => fs.closeSync(log))
  assert.equal(code, 0, `Pilot process failed: ${variant}/${part}; retain execution.log`)
  const elapsedSeconds = (performance.now() - start) / 1000
  const bytes = fs.readFileSync(path.join(destination, 'mutation.json'))
  const report = JSON.parse(bytes)
  requireTargetProperty(report, target)
  const evidence = await targetEvidence(
    ROOT,
    partitions.find(value => value.id === part).target,
    targetId,
    part
  )
  const inventory = ordered(evidence.mutants.map(mutant => mutantKey(mutant.fileName, mutant)))
  assert.deepEqual(
    ordered(entries(report).map(row => row.key)),
    inventory,
    'Noncanonical pilot inventory'
  )
  const metrics = calculateMutationMetrics(entries(report).map(row => row.mutant))
  return {
    part,
    elapsedSeconds,
    reportDigest: hash(bytes),
    canonicalInventoryDigest: hash(JSON.stringify(inventory)),
    metrics
  }
}

export function requirePilotParts(caseName, available) {
  const selected = PILOT_CASES[caseName]
  assert(selected, 'Unknown pilot case')
  const known = new Set(available)
  assert(
    selected.parts.every(part => known.has(part)),
    'Pilot partition moved'
  )
  if (caseName === 'lookup-buyer')
    assert.deepEqual(
      ordered(known),
      ordered(selected.parts),
      'Whole buyer pilot omits a canonical part'
    )
  return selected
}

async function execute(caseName, variant, run) {
  assert(
    ['linux', 'darwin'].includes(process.platform),
    'Pilot requires a POSIX measurement runner'
  )
  const selected = PILOT_CASES[caseName]
  assert(selected, 'Unknown pilot case')
  assert(['baseline', 'candidate'].includes(variant), 'Unknown pilot variant')
  assert.match(run, /^[a-z0-9-]{8,80}$/)
  const target = buildMutationTargets(ROOT)[selected.target]
  const partitions = partitionMutationTarget(selected.target, target)
  requirePilotParts(
    caseName,
    partitions.map(part => part.id)
  )
  const directory = path.join(ROOT, 'artifacts/mutation-pilot', run, selected.target, variant)
  assert(!fs.existsSync(directory), 'Never overwrite a previous arm or failed sample')
  fs.mkdirSync(directory, { recursive: true })
  const source = identity()
  const policy = read(path.join(ROOT, 'governance/mutation-testing/policy.json'))
  const parts = []
  for await (const result of serialResults(selected.parts, part =>
    executePart({
      directory,
      part,
      variant,
      run,
      target,
      targetId: selected.target,
      partitions,
      policy
    })
  ))
    parts.push(result)

  assert(isDeepStrictEqual(identity(), source), 'Source or runtime changed during pilot')
  const metrics = calculateMutationMetrics(
    parts.flatMap(part =>
      entries(read(path.join(directory, part.part, 'mutation.json'))).map(row => row.mutant)
    )
  )
  const wholeTarget = selected.target === 'private-lookup-buyer'
  const gateErrors = evaluateMutationReport(selected.target, metrics, policy, {
    requireScore: wholeTarget
  })
  const receipt = {
    purpose: 'diagnostic-pilot',
    publicationQualification: false,
    caseName,
    target: selected.target,
    wholeTarget,
    variant,
    run,
    identity: source,
    propertyRuns: policy.tool.propertyRuns,
    propertySeed: policy.tool.propertySeed,
    parts,
    metrics,
    gateErrors
  }
  fs.writeFileSync(path.join(directory, 'pilot.json'), `${JSON.stringify(receipt, null, 2)}\n`)
  console.log(JSON.stringify(receipt, null, 2))
}

export function comparePilotRun(directory) {
  const baseline = read(path.join(directory, 'baseline/pilot.json'))
  const candidate = read(path.join(directory, 'candidate/pilot.json'))
  assert.equal(baseline.purpose, 'diagnostic-pilot')
  assert.equal(candidate.purpose, 'diagnostic-pilot')
  const selected = PILOT_CASES[baseline.caseName]
  assert(selected, 'Unknown comparison case')
  assert.equal(baseline.target, selected.target, 'Comparison target changed')
  const target = buildMutationTargets(ROOT)[selected.target]
  requirePilotParts(
    baseline.caseName,
    partitionMutationTarget(selected.target, target).map(part => part.id)
  )
  assert.deepEqual(
    baseline.parts.map(part => part.part),
    selected.parts,
    'Comparison scope omits a pilot part'
  )
  assert.equal(
    baseline.wholeTarget,
    baseline.caseName === 'lookup-buyer',
    'Incorrect whole-target claim'
  )
  assert.equal(baseline.variant, 'baseline')
  assert.equal(candidate.variant, 'candidate')
  for (const key of [
    'caseName',
    'target',
    'wholeTarget',
    'run',
    'identity',
    'propertyRuns',
    'propertySeed'
  ])
    assert.deepEqual(baseline[key], candidate[key], `Paired ${key} changed`)
  assert.deepEqual(
    baseline.parts.map(part => part.part),
    candidate.parts.map(part => part.part)
  )
  const parts = baseline.parts.map(before => {
    const after = candidate.parts.find(part => part.part === before.part)
    const beforeBytes = fs.readFileSync(
      path.join(directory, 'baseline', before.part, 'mutation.json')
    )
    const afterBytes = fs.readFileSync(
      path.join(directory, 'candidate', before.part, 'mutation.json')
    )
    requireTargetProperty(JSON.parse(beforeBytes), target)
    requireTargetProperty(JSON.parse(afterBytes), target)
    assert.equal(hash(beforeBytes), before.reportDigest)
    assert.equal(hash(afterBytes), after.reportDigest)
    assert.equal(before.canonicalInventoryDigest, after.canonicalInventoryDigest)
    const initialRuns = Object.fromEntries(
      ['baseline', 'candidate'].map(arm => [
        arm,
        initialRunEvidence(
          fs.readFileSync(path.join(directory, arm, before.part, 'execution.log'), 'utf8')
        )
      ])
    )
    assert.equal(
      initialRuns.baseline.tests,
      initialRuns.candidate.tests,
      'Initial test count changed'
    )
    return {
      part: before.part,
      ...comparePilotReports(JSON.parse(beforeBytes), JSON.parse(afterBytes)),
      // Jest parameterizations can share a serialized test definition ID.
      // Retain the actual initial-run count separately from selectedTests.
      initialRuns,
      baselineSeconds: before.elapsedSeconds,
      candidateSeconds: after.elapsedSeconds,
      speedup: before.elapsedSeconds / after.elapsedSeconds
    }
  })
  return {
    target: baseline.target,
    wholeTarget: baseline.wholeTarget,
    identity: baseline.identity,
    parts,
    noWeaker: parts.every(part => part.noWeaker),
    requiresAdjudication: parts.some(part => part.requiresAdjudication),
    baselineGateErrors: baseline.gateErrors,
    candidateGateErrors: candidate.gateErrors,
    publicationQualification: false
  }
}

async function main(args) {
  if (args[0] === 'plan' && args.length === 1) return console.log(JSON.stringify(PILOT_CASES))
  if (args[0] === 'run' && args.length === 4) return execute(args[1], args[2], args[3])
  if (args[0] === 'compare' && args.length === 2) {
    const result = comparePilotRun(path.resolve(args[1]))
    fs.writeFileSync(path.join(args[1], 'comparison.json'), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify(result, null, 2))
    assert(result.noWeaker, 'Pilot lost detection or introduced invalid/timeout/unexecuted results')
    assert(
      !result.requiresAdjudication,
      'Runner-limit kills need independent adjudication before acceptance'
    )
    return
  }
  throw new Error('Use plan, run CASE baseline|candidate RUN, or compare DIRECTORY')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
