#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'

import { buildFuzzTargets } from '../governance/fuzzing/targets.mjs'

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const POLICY_PATH = path.join(REPOSITORY_ROOT, 'governance/fuzzing/policy.json')
const TEST_POLICY_PATH = path.join(REPOSITORY_ROOT, 'governance/test-quality/policy.json')
const CONTROL_PATH_PREFIXES = [
  '.github/workflows/ci.yml',
  '.github/workflows/fuzz-tests.yml',
  'fuzz/',
  'governance/fuzzing/',
  'governance/test-quality/',
  'scripts/fuzzing.mjs',
  'scripts/fuzzing.test.mjs'
]
const CONTROL_PATHS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'tsconfig.base.json'
])
const VALID_MODES = new Set(['regression', 'fuzzing'])

function normalized(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '')
}

function isControlPath(file) {
  return (
    CONTROL_PATHS.has(file) ||
    CONTROL_PATH_PREFIXES.some(prefix =>
      prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix
    )
  )
}

export function selectAffectedFuzzTargets(targets, changedFiles) {
  const files = changedFiles.map(normalized).filter(Boolean)
  if (files.some(file => isControlPath(file) || file.startsWith('packages/sdk/'))) {
    return Object.keys(targets)
  }

  return Object.entries(targets)
    .filter(([, target]) =>
      files.some(file =>
        target.packageDirectories.some(packageDirectory =>
          file.startsWith(`${normalized(packageDirectory)}/`)
        )
      )
    )
    .map(([id]) => id)
}

function requiredValue(arguments_, index, option) {
  const value = arguments_[index + 1]
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${option} requires a value`)
  }
  return value
}

export function parseArguments(arguments_) {
  const result = {
    all: false,
    list: false,
    validate: false,
    targets: [],
    affectedFile: undefined,
    mode: 'regression',
    seconds: undefined,
    corpusDirectory: undefined,
    coverage: false
  }
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]
    if (argument === '--all') result.all = true
    else if (argument === '--list') result.list = true
    else if (argument === '--validate') result.validate = true
    else if (argument === '--coverage') result.coverage = true
    else if (argument === '--target') {
      result.targets.push(requiredValue(arguments_, index, '--target'))
      index++
    } else if (argument === '--affected-file') {
      result.affectedFile = requiredValue(arguments_, index, '--affected-file')
      index++
    } else if (argument === '--mode') {
      result.mode = requiredValue(arguments_, index, '--mode')
      index++
    } else if (argument === '--seconds') {
      const value = requiredValue(arguments_, index, '--seconds')
      result.seconds = Number(value)
      index++
    } else if (argument === '--corpus-dir') {
      result.corpusDirectory = requiredValue(arguments_, index, '--corpus-dir')
      index++
    } else {
      throw new Error(`Unknown argument ${argument}`)
    }
  }

  if (!VALID_MODES.has(result.mode)) {
    throw new Error('--mode must be regression or fuzzing')
  }
  if (
    result.seconds !== undefined &&
    (!Number.isInteger(result.seconds) || result.seconds < 1 || result.seconds > 3_600)
  ) {
    throw new Error('--seconds must be an integer from 1 through 3600')
  }
  const commands = [
    result.all,
    result.list,
    result.validate,
    result.targets.length > 0,
    result.affectedFile !== undefined
  ].filter(Boolean).length
  if (commands > 1) throw new Error('Select exactly one fuzzing command mode')
  if (
    (result.list || result.validate || result.affectedFile !== undefined) &&
    (result.coverage ||
      result.mode !== 'regression' ||
      result.seconds !== undefined ||
      result.corpusDirectory !== undefined)
  ) {
    throw new Error('Run options require --all or --target')
  }
  if (result.mode === 'regression' && result.seconds !== undefined) {
    throw new Error('--seconds is only valid in fuzzing mode')
  }
  return result
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function pathWithin(repositoryRoot, relativePath) {
  const absolutePath = path.resolve(repositoryRoot, relativePath)
  const relative = path.relative(repositoryRoot, absolutePath)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function directoryFiles(directory) {
  return fs.existsSync(directory)
    ? fs
        .readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => entry.name)
    : []
}

export function validateFuzzPolicy({
  policy,
  propertyPolicy,
  rootPackage,
  targets,
  repositoryRoot = REPOSITORY_ROOT
}) {
  const errors = []
  const targetIds = Object.keys(targets)
  const expectedIds = policy.targets ?? []
  if (new Set(expectedIds).size !== expectedIds.length) {
    errors.push('fuzz policy contains duplicate target IDs')
  }
  if (JSON.stringify(targetIds) !== JSON.stringify(expectedIds)) {
    errors.push('fuzz policy target IDs or order do not match the target registry')
  }
  if (targetIds.length < policy.coverage.minimumTargets) {
    errors.push(
      `fuzz registry has ${targetIds.length} targets; minimum is ${policy.coverage.minimumTargets}`
    )
  }

  const criticalTargets = Object.values(targets).filter(target => target.risk === 'critical')
  if (criticalTargets.length < policy.coverage.minimumCriticalTargets) {
    errors.push(
      `fuzz registry has ${criticalTargets.length} critical targets; minimum is ${policy.coverage.minimumCriticalTargets}`
    )
  }
  const areas = new Set(Object.values(targets).map(target => target.area))
  for (const area of policy.coverage.requiredAreas) {
    if (!areas.has(area)) errors.push(`fuzz registry does not cover required area ${area}`)
  }

  const implementationPackages = new Set(
    Object.values(targets).flatMap(target => target.packageDirectories)
  )
  if (implementationPackages.size < policy.coverage.minimumImplementationPackages) {
    errors.push(
      `fuzz registry covers ${implementationPackages.size} packages; minimum is ${policy.coverage.minimumImplementationPackages}`
    )
  }
  const governedPackages = new Set(
    propertyPolicy.propertyTesting.manifests.map(manifest => path.posix.dirname(manifest))
  )
  for (const packageDirectory of governedPackages) {
    if (!implementationPackages.has(packageDirectory)) {
      errors.push(`governed implementation package lacks a fuzz target: ${packageDirectory}`)
    }
  }
  for (const packageDirectory of implementationPackages) {
    if (!governedPackages.has(packageDirectory)) {
      errors.push(`fuzz target package is absent from property governance: ${packageDirectory}`)
    }
  }

  if (rootPackage.devDependencies?.[policy.tool.package] !== policy.tool.version) {
    errors.push(`${policy.tool.package} must be pinned to ${policy.tool.version}`)
  }
  if (rootPackage.scripts?.['test:fuzz'] !== `node ${policy.tool.runner}`) {
    errors.push(`root test:fuzz command must execute ${policy.tool.runner}`)
  }

  for (const [id, target] of Object.entries(targets)) {
    if (target.id !== id) errors.push(`fuzz target key ${id} does not match its id`)
    if (!['critical', 'high'].includes(target.risk)) {
      errors.push(`${id} must declare critical or high risk`)
    }
    if (typeof target.boundary !== 'string' || target.boundary.trim() === '') {
      errors.push(`${id} must describe its trust boundary`)
    }
    if (!Array.isArray(target.oracles) || target.oracles.length === 0) {
      errors.push(`${id} must declare at least one semantic oracle`)
    }
    if (
      !Number.isInteger(target.maximumInputBytes) ||
      target.maximumInputBytes < 1 ||
      target.maximumInputBytes > policy.campaign.maximumInputBytes
    ) {
      errors.push(`${id} has an invalid maximum input size`)
    }
    if (
      !Number.isInteger(target.timeoutMilliseconds) ||
      target.timeoutMilliseconds < 1 ||
      target.timeoutMilliseconds > policy.campaign.targetTimeoutMilliseconds
    ) {
      errors.push(`${id} has an invalid execution timeout`)
    }
    if (
      !Number.isInteger(target.scheduledSeconds) ||
      target.scheduledSeconds < policy.campaign.scheduledSecondsPerTarget
    ) {
      errors.push(`${id} has an insufficient scheduled campaign duration`)
    }
    for (const relativePath of [
      target.targetModule,
      target.seedCorpus,
      target.dictionary,
      ...target.packageDirectories
    ]) {
      if (!pathWithin(repositoryRoot, relativePath)) {
        errors.push(`${id} references a path outside the repository: ${relativePath}`)
      }
    }

    const targetModule = path.join(repositoryRoot, target.targetModule)
    if (!fs.existsSync(targetModule)) {
      errors.push(`${id} target module is missing: ${target.targetModule}`)
    } else if (
      !/\bexport\s+(?:async\s+)?function\s+fuzz\s*\(/.test(fs.readFileSync(targetModule, 'utf8'))
    ) {
      errors.push(`${id} target module must export a fuzz function`)
    }
    const corpus = path.join(repositoryRoot, target.seedCorpus)
    if (directoryFiles(corpus).length < 2) {
      errors.push(`${id} must have at least two committed seed corpus entries`)
    }
    if (!fs.existsSync(path.join(repositoryRoot, target.dictionary))) {
      errors.push(`${id} dictionary is missing: ${target.dictionary}`)
    }
    for (const packageDirectory of target.packageDirectories) {
      if (!fs.existsSync(path.join(repositoryRoot, packageDirectory, 'package.json'))) {
        errors.push(`${id} package manifest is missing: ${packageDirectory}/package.json`)
      }
    }
    for (const sourceInclude of target.sourceIncludes) {
      if (!sourceInclude.endsWith('/')) {
        errors.push(`${id} source include must end in a slash: ${sourceInclude}`)
      }
      if (!pathWithin(repositoryRoot, sourceInclude)) {
        errors.push(`${id} source include escapes the repository: ${sourceInclude}`)
      }
    }
  }
  return errors
}

function runCommand(command, arguments_, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { ...options, stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal !== null) reject(new Error(`${command} exited from signal ${signal}`))
      else resolve(code ?? 1)
    })
  })
}

export function buildJazzerArguments({
  target,
  mode,
  seconds,
  corpusDirectory,
  coverage,
  repositoryRoot = REPOSITORY_ROOT
}) {
  const targetModule = path.join(repositoryRoot, target.targetModule)
  const committedCorpus = path.join(repositoryRoot, target.seedCorpus)
  const findingsDirectory = path.join(repositoryRoot, 'artifacts/fuzz', target.id, 'findings')
  const coverageDirectory = path.join(repositoryRoot, 'artifacts/fuzz', target.id, 'coverage')
  const arguments_ = [targetModule]

  if (mode === 'fuzzing') {
    arguments_.push(path.join(corpusDirectory, target.id), committedCorpus)
  } else {
    arguments_.push(committedCorpus)
  }
  for (const include of target.sourceIncludes) arguments_.push('-i', include)
  arguments_.push('--mode', mode, '--timeout', String(target.timeoutMilliseconds))
  if (target.sync) arguments_.push('--sync')
  if (coverage) {
    arguments_.push('--coverage', '--coverageDirectory', coverageDirectory)
  }

  arguments_.push(
    '--',
    `-max_len=${target.maximumInputBytes}`,
    `-timeout=${Math.ceil(target.timeoutMilliseconds / 1000)}`,
    `-rss_limit_mb=4096`,
    `-dict=${path.join(repositoryRoot, target.dictionary)}`,
    `-artifact_prefix=${findingsDirectory}${path.sep}`,
    '-print_final_stats=1'
  )
  if (mode === 'fuzzing') arguments_.push(`-max_total_time=${seconds}`)
  return { arguments_, coverageDirectory, findingsDirectory }
}

async function assertBuiltTarget(target, repositoryRoot) {
  for (const include of target.sourceIncludes) {
    if (!fs.existsSync(path.join(repositoryRoot, include))) {
      throw new Error(`${target.id} build output is missing: ${include}`)
    }
  }
  let targetModule
  try {
    targetModule = await import(`${pathToFileURL(path.join(repositoryRoot, target.targetModule))}`)
  } catch (error) {
    throw new Error(
      `${target.id} could not load its built implementation: ${
        error instanceof Error ? error.message : error
      }`
    )
  }
  if (typeof targetModule.fuzz !== 'function') {
    throw new Error(`${target.id} target module does not export fuzz`)
  }
}

async function runTarget(target, options, policy) {
  await assertBuiltTarget(target, REPOSITORY_ROOT)
  const corpusDirectory = path.resolve(
    REPOSITORY_ROOT,
    options.corpusDirectory ?? policy.campaign.cumulativeCorpus
  )
  const seconds = options.seconds ?? target.scheduledSeconds
  const { arguments_, coverageDirectory, findingsDirectory } = buildJazzerArguments({
    target,
    mode: options.mode,
    seconds,
    corpusDirectory,
    coverage: options.coverage
  })
  fs.mkdirSync(findingsDirectory, { recursive: true })
  if (options.coverage) fs.mkdirSync(coverageDirectory, { recursive: true })
  if (options.mode === 'fuzzing') {
    fs.mkdirSync(path.join(corpusDirectory, target.id), { recursive: true })
  }

  console.log(
    `${target.id}: ${options.mode}${options.mode === 'fuzzing' ? ` for ${seconds}s` : ''}`
  )
  const jazzer = path.join(REPOSITORY_ROOT, 'node_modules/.bin/jazzer')
  const exitCode = await runCommand(jazzer, arguments_, { cwd: REPOSITORY_ROOT })
  if (exitCode !== 0) throw new Error(`${target.id} fuzzing process exited ${exitCode}`)
}

function validateRepository(policy, targets) {
  const errors = validateFuzzPolicy({
    policy,
    propertyPolicy: readJson(TEST_POLICY_PATH),
    rootPackage: readJson(path.join(REPOSITORY_ROOT, 'package.json')),
    targets
  })
  if (errors.length > 0) throw new Error(errors.join('\n'))
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const targets = buildFuzzTargets()
  const policy = readJson(POLICY_PATH)

  if (options.list) {
    console.log(Object.keys(targets).join('\n'))
    return
  }
  if (options.validate) {
    validateRepository(policy, targets)
    console.log(
      `${Object.keys(targets).length} governed coverage-guided targets across ${
        new Set(Object.values(targets).flatMap(target => target.packageDirectories)).size
      } implementation packages`
    )
    return
  }
  if (options.affectedFile !== undefined) {
    const changedFiles = fs.readFileSync(options.affectedFile, 'utf8').split(/\r?\n/)
    console.log(JSON.stringify(selectAffectedFuzzTargets(targets, changedFiles)))
    return
  }

  validateRepository(policy, targets)
  const selected = options.all ? Object.keys(targets) : options.targets
  if (selected.length === 0) {
    throw new Error(
      'Select --all, --list, --validate, --affected-file <path>, or at least one --target <id>'
    )
  }
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate fuzz target')
  for (const targetName of selected) {
    const target = targets[targetName]
    if (target === undefined) throw new Error(`Unknown fuzz target ${targetName}`)
    await runTarget(target, options, policy)
  }
}

const isMain =
  process.argv[1] !== undefined &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    await main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
