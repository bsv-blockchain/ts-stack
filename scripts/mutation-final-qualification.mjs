#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { calculateMutationMetrics, evaluateMutationReport } from './mutation-testing.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INPUTS = [
  'governance/mutation-testing/targets.mjs',
  'governance/mutation-testing/policy.json',
  'governance/mutation-testing/stryker.config.mjs',
  'scripts/mutation-testing.mjs',
  'scripts/mutation-final-qualification.mjs',
  'scripts/mutation-partitions.mjs',
  'scripts/mutation-partition-evidence.mjs',
  '.github/workflows/mutation-tests.yml',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json'
]
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function compare(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}
const ordered = values => [...values].sort(compare)
const PINNED_ENGINE = '9.6.1'
const quietLogger = { debug() {}, info() {}, warn() {}, isDebugEnabled: () => false }
let enginePromise

async function pinnedEngine() {
  enginePromise ??= (async () => {
    const corePackage = import.meta.resolve('@stryker-mutator/core/package.json')
    const coreRoot = path.dirname(fileURLToPath(corePackage))
    const requireFromCore = createRequire(corePackage)
    const instrumenterPackage = requireFromCore.resolve(
      '@stryker-mutator/instrumenter/package.json'
    )
    for (const file of [fileURLToPath(corePackage), instrumenterPackage]) {
      if (JSON.parse(fs.readFileSync(file, 'utf8')).version !== PINNED_ENGINE)
        throw new Error('Inventory replay requires the reviewed pinned Stryker engine')
    }
    const [{ Instrumenter }, { ProjectReader }, { defaultOptions }] = await Promise.all([
      import(pathToFileURL(requireFromCore.resolve('@stryker-mutator/instrumenter'))),
      import(pathToFileURL(path.join(coreRoot, 'dist/src/fs/project-reader.js'))),
      import(pathToFileURL(path.join(coreRoot, 'dist/src/config/index.js')))
    ])
    return { Instrumenter, ProjectReader, defaultOptions }
  })()
  return enginePromise
}

// Reuse the pinned engine's actual range/glob union and instrumenter, without
// executing tests. Files with no possible mutants legitimately omit reports.
export async function canonicalInventory(directory, sources, mutate) {
  const { Instrumenter, ProjectReader, defaultOptions } = await pinnedEngine()
  const reader = new ProjectReader({}, quietLogger, {
    ...defaultOptions,
    mutate: mutate.map(pattern => path.resolve(directory, pattern))
  })
  const descriptions = reader.resolveFileDescriptions(
    [...sources.keys()].map(file => path.resolve(directory, file))
  )
  const files = Object.entries(descriptions)
    .filter(([, description]) => description.mutate !== false)
    .map(([name, description]) => ({
      name,
      content: sources.get(path.relative(directory, name).split(path.sep).join('/')),
      mutate: description.mutate
    }))
  const result = await new Instrumenter(quietLogger).instrument(files, {
    ...defaultOptions.mutator,
    ignorers: []
  })
  const position = value => ({ line: value.line + 1, column: value.column + 1 })
  return result.mutants.map(mutant => ({
    ...mutant,
    fileName: path.relative(directory, mutant.fileName).split(path.sep).join('/'),
    location: { start: position(mutant.location.start), end: position(mutant.location.end) }
  }))
}

export async function targetEvidence(root, target, targetId, partition = 'whole') {
  const directory = path.resolve(root, target.packageDirectory)
  const sources = targetSources(root, target)
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        'import(process.argv[1]).then(module => console.log(JSON.stringify(module.default)))',
        pathToFileURL(path.join(root, 'governance/mutation-testing/stryker.config.mjs')).href
      ],
      {
        cwd: directory,
        env: {
          ...process.env,
          TS_STACK_MUTATION_TARGET: targetId,
          TS_STACK_MUTATION_PARTITION: partition
        },
        encoding: 'utf8'
      }
    )
  )
  const { defaultOptions } = await pinnedEngine()
  return {
    sources,
    mutants: await canonicalInventory(directory, sources, target.mutate),
    projectRoot: directory,
    config: {
      ...Object.fromEntries(
        [
          'dryRunOnly',
          'incremental',
          'ignoreStatic',
          'force',
          'mutator',
          'ignorers',
          'checkers',
          'appendPlugins',
          'testFiles',
          'testRunnerNodeArgs',
          'checkerNodeArgs',
          'disableTypeChecks',
          'disableBail',
          'allowEmpty',
          'tsconfigFile'
        ].map(key => [key, defaultOptions[key]])
      ),
      ...config,
      reporters: ['json']
    }
  }
}

export function qualificationIdentity(root, environment, targets) {
  const sourceSha = execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8'
  }).trim()
  if (sourceSha !== environment.GITHUB_SHA || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error('Full campaign must check out the exact caller source SHA')
  }
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    if (!/^[1-9]\d*$/.test(environment[key] ?? '')) throw new Error(`Missing immutable ${key}`)
  }
  const dirty = execFileSync('/usr/bin/git', ['status', '--porcelain', '--untracked-files=no'], {
    cwd: root,
    encoding: 'utf8'
  })
  if (dirty.trim()) throw new Error('Tracked source changed during mutation qualification')
  return {
    sourceSha,
    runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT,
    nodeVersion: process.version,
    inputsDigest: digest(
      JSON.stringify(INPUTS.map(file => [file, digest(fs.readFileSync(path.join(root, file)))]))
    ),
    targetsDigest: digest(JSON.stringify(targets)),
    targetIds: ordered(Object.keys(targets))
  }
}

function reportMetrics(report) {
  if (!report.files || typeof report.files !== 'object' || Array.isArray(report.files)) {
    throw new Error('Mutation report has no file evidence')
  }
  const mutants = Object.values(report.files).flatMap(file => {
    if (!Array.isArray(file.mutants)) throw new Error('Mutation file has no mutant evidence')
    return file.mutants
  })
  const statuses = new Set([
    'Killed',
    'Timeout',
    'Survived',
    'NoCoverage',
    'CompileError',
    'RuntimeError',
    'Ignored'
  ])
  if (mutants.some(mutant => !statuses.has(mutant.status)))
    throw new Error('Unknown mutation status')
  const metrics = calculateMutationMetrics(mutants)
  if (metrics.valid === 0)
    throw new Error('Mutation qualification requires nonempty valid mutant evidence')
  return metrics
}

export function targetSources(root, target) {
  const directory = path.resolve(root, target.packageDirectory)
  const sources = new Map()
  for (const specification of target.mutate) {
    if (specification.startsWith('!'))
      throw new Error('Excluded mutation input needs explicit qualification support')
    const pattern = specification.replace(/:\d+(?:-\d+)?$/, '')
    for (const file of fs.globSync(pattern, { cwd: directory })) {
      const location = fs.realpathSync(path.resolve(directory, file))
      if (!location.startsWith(`${fs.realpathSync(root)}${path.sep}`))
        throw new Error('Mutation source escapes repository')
      sources.set(file.split(path.sep).join('/'), fs.readFileSync(location, 'utf8'))
    }
  }
  if (sources.size === 0) throw new Error('Canonical target has no source inventory')
  return sources
}

function requireReportSources(report, sources) {
  if (!(sources instanceof Map) || sources.size === 0)
    throw new Error('Canonical source inventory required')
  const files = Object.entries(report.files ?? {})
  if (files.length === 0) throw new Error('Mutation report has no source evidence')
  for (const [file, result] of files) {
    if (
      !sources.has(file) ||
      typeof result.source !== 'string' ||
      result.source !== sources.get(file)
    ) {
      throw new Error('Mutation report source differs from canonical target bytes')
    }
  }
}

function requireConfiguration(actual, expected, key = 'config') {
  if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual))
      throw new Error(`Mutation execution differs at ${key}`)
    for (const [name, value] of Object.entries(expected))
      requireConfiguration(actual[name], value, `${key}.${name}`)
  } else if (!isDeepStrictEqual(actual, expected)) {
    throw new Error(`Mutation execution differs at ${key}`)
  }
}

function mutantTuple(file, mutant) {
  return JSON.stringify([
    file,
    mutant.location.start.line,
    mutant.location.start.column,
    mutant.location.end.line,
    mutant.location.end.column,
    mutant.mutatorName,
    mutant.replacement,
    mutant.status === 'Ignored' ? mutant.statusReason : null
  ])
}

function requireMutantStructure(mutant, ids) {
  if (typeof mutant.id !== 'string' || mutant.id.length === 0 || ids.has(mutant.id))
    throw new Error('Missing or duplicate mutant ID')
  ids.add(mutant.id)
  const { start, end } = mutant.location ?? {}
  const validCoordinates = [start?.line, start?.column, end?.line, end?.column].every(
    value => Number.isSafeInteger(value) && value > 0
  )
  if (
    !validCoordinates ||
    end.line < start.line ||
    (end.line === start.line && end.column < start.column)
  )
    throw new Error('Invalid mutant structure')
  if (
    typeof mutant.mutatorName !== 'string' ||
    !mutant.mutatorName ||
    typeof mutant.replacement !== 'string'
  )
    throw new Error('Invalid mutant structure')
}

function requireCompleteInventory(report, evidence) {
  if (
    report.schemaVersion !== '1.0' ||
    report.framework?.name !== 'StrykerJS' ||
    report.framework.version !== PINNED_ENGINE
  )
    throw new Error('Unsupported mutation report schema or engine')
  if (report.projectRoot !== evidence.projectRoot)
    throw new Error('Mutation report has a different project root')
  requireConfiguration(report.config, evidence.config)
  const ids = new Set()
  const actual = Object.entries(report.files).flatMap(([file, result]) =>
    result.mutants.map(mutant => {
      requireMutantStructure(mutant, ids)
      return mutantTuple(file, mutant)
    })
  )
  const expected = evidence.mutants.map(mutant => mutantTuple(mutant.fileName, mutant))
  if (!isDeepStrictEqual(ordered(actual), ordered(expected)))
    throw new Error('Mutation report omits or changes canonical mutant inventory')
}

function requireExecution(identity, targetId, reportBytes, policy, mode, execution) {
  if (
    !execution ||
    execution.targetId !== targetId ||
    execution.reportDigest !== digest(reportBytes)
  )
    throw new Error('Missing or different successful mutation execution')
  for (const field of ['sourceSha', 'runId', 'runAttempt', 'nodeVersion']) {
    if (execution[field] !== identity[field])
      throw new Error('Mutation execution has a different source, run, attempt or runtime')
  }
  if (mode !== 'full') return
  const properties = execution.propertyEnvironment
  const runs = properties?.FAST_CHECK_NUM_RUNS
  if (
    !/^[1-9]\d*$/.test(runs ?? '') ||
    Number(runs) < policy.tool.propertyRuns ||
    properties?.FAST_CHECK_SEED !== String(policy.tool.propertySeed) ||
    properties?.FAST_CHECK_PATH !== ''
  )
    throw new Error(
      'Full qualification requires governed property runs, seed and no partial replay'
    )
}

export function inspectMutationEvidence({
  identity,
  targetId,
  reportBytes,
  policy,
  mode,
  evidence,
  executionBytes,
  requireScore = true
}) {
  if (!['full', 'diagnostic'].includes(mode)) throw new Error('Unknown campaign mode')
  if (!identity.targetIds.includes(targetId))
    throw new Error('Target is outside canonical campaign')
  const report = JSON.parse(reportBytes)
  requireExecution(identity, targetId, reportBytes, policy, mode, JSON.parse(executionBytes))
  requireReportSources(report, evidence.sources)
  const metrics = reportMetrics(report)
  requireCompleteInventory(report, evidence)
  const errors = evaluateMutationReport(targetId, metrics, policy, { requireScore })
  if (errors.length) throw new Error(errors.join('\n'))
  return metrics
}

export function makeTargetReceipt(
  identity,
  targetId,
  reportBytes,
  policy,
  mode,
  evidence,
  executionBytes
) {
  const metrics = inspectMutationEvidence({
    identity,
    targetId,
    reportBytes,
    policy,
    mode,
    evidence,
    executionBytes
  })
  return {
    schemaVersion: 1,
    mode,
    targetId,
    identity,
    reportDigest: digest(reportBytes),
    executionDigest: digest(executionBytes),
    metrics
  }
}

function verifyIdentity(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error('Stale or different campaign identity')
}

export function verifyFullCampaign(identity, evidence, policy, sourcesForTarget) {
  const seen = new Set()
  for (const { receipt, reportBytes, executionBytes } of evidence) {
    if (receipt.schemaVersion !== 1 || receipt.mode !== 'full')
      throw new Error('Diagnostic or unknown receipt cannot qualify a full campaign')
    verifyIdentity(receipt.identity, identity)
    if (seen.has(receipt.targetId)) throw new Error('Duplicate target receipt')
    seen.add(receipt.targetId)
    const current = makeTargetReceipt(
      identity,
      receipt.targetId,
      reportBytes,
      policy,
      'full',
      sourcesForTarget(receipt.targetId),
      executionBytes
    )
    if (JSON.stringify(current) !== JSON.stringify(receipt))
      throw new Error('Mutation report or receipt changed')
  }
  if (JSON.stringify(ordered(seen)) !== JSON.stringify(identity.targetIds) || seen.size === 0) {
    throw new Error('Full qualification requires exactly every canonical target')
  }
  return { schemaVersion: 1, kind: 'full-mutation-qualification', identity, targetCount: seen.size }
}

function findReceipts(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const location = path.join(directory, entry.name)
    if (entry.isSymbolicLink()) throw new Error('Symlinks are not qualification evidence')
    if (entry.isDirectory()) return findReceipts(location)
    return entry.name === 'receipt.json' ? [location] : []
  })
}

function argumentsFor(argv) {
  const [command, ...rest] = argv
  if (!['capture', 'verify'].includes(command)) throw new Error('Use capture or verify')
  const result = { command }
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    if (!['--directory', '--target', '--mode'].includes(key) || !rest[index + 1])
      throw new Error('Invalid qualification arguments')
    if (result[key.slice(2)] !== undefined) throw new Error('Duplicate qualification argument')
    result[key.slice(2)] = rest[index + 1]
  }
  if (!result.directory || !['full', 'diagnostic'].includes(result.mode))
    throw new Error('Directory and explicit mode required')
  if (command === 'capture' && !result.target) throw new Error('Capture requires an exact target')
  return result
}

export async function loadCanonicalEvidence(targetIds, load) {
  const canonical = new Map()
  let index = 0
  async function worker() {
    const targetId = targetIds[index++]
    if (targetId === undefined) return
    canonical.set(targetId, await load(targetId))
    return worker()
  }
  await Promise.all(Array.from({ length: Math.min(4, targetIds.length) }, worker))
  return canonical
}

async function main(argv) {
  const options = argumentsFor(argv)
  const targets = buildMutationTargets(ROOT)
  const identity = qualificationIdentity(ROOT, process.env, targets)
  const policy = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'governance/mutation-testing/policy.json'), 'utf8')
  )
  if (options.command === 'capture') {
    const reportBytes = fs.readFileSync(path.join(options.directory, 'mutation.json'), 'utf8')
    const receipt = makeTargetReceipt(
      identity,
      options.target,
      reportBytes,
      policy,
      options.mode,
      await targetEvidence(ROOT, targets[options.target], options.target),
      fs.readFileSync(path.join(options.directory, 'execution.json'), 'utf8')
    )
    fs.writeFileSync(
      path.join(options.directory, 'receipt.json'),
      `${JSON.stringify(receipt, null, 2)}\n`
    )
    return
  }
  if (options.mode !== 'full') {
    console.log('Diagnostic campaign completed; no full qualification issued.')
    return
  }
  const evidence = findReceipts(options.directory).map(file => ({
    receipt: JSON.parse(fs.readFileSync(file, 'utf8')),
    reportBytes: fs.readFileSync(path.join(path.dirname(file), 'mutation.json'), 'utf8'),
    executionBytes: fs.readFileSync(path.join(path.dirname(file), 'execution.json'), 'utf8')
  }))
  const canonical = await loadCanonicalEvidence(identity.targetIds, targetId =>
    targetEvidence(ROOT, targets[targetId], targetId)
  )
  const qualified = verifyFullCampaign(identity, evidence, policy, targetId =>
    canonical.get(targetId)
  )
  fs.writeFileSync(
    path.join(options.directory, 'full-qualification.json'),
    `${JSON.stringify(qualified, null, 2)}\n`
  )
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `qualified-sha=${identity.sourceSha}\n`)
  console.log(
    `Full mutation qualification: ${identity.sourceSha}, ${qualified.targetCount} targets`
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Mutation qualification failed')
    process.exitCode = 1
  }
}
