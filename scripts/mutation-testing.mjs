#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import { changedLockfileImporters } from './ci-affected-scope.mjs'

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG_PATH = path.join(REPOSITORY_ROOT, 'governance/mutation-testing/stryker.config.mjs')
const POLICY_PATH = path.join(REPOSITORY_ROOT, 'governance/mutation-testing/policy.json')
const CONTROL_PATH_PREFIXES = [
  '.github/workflows/mutation-tests.yml',
  'governance/mutation-testing/stryker.config.mjs'
]
const CONTROL_PATHS = new Set(['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json'])

function normalized(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '')
}

export function calculateMutationMetrics(mutants) {
  const counts = {}
  for (const mutant of mutants) counts[mutant.status] = (counts[mutant.status] ?? 0) + 1
  const detected = (counts.Killed ?? 0) + (counts.Timeout ?? 0)
  const undetected = (counts.Survived ?? 0) + (counts.NoCoverage ?? 0)
  const valid = detected + undetected
  return {
    counts,
    detected,
    undetected,
    valid,
    score: valid === 0 ? 100 : (detected / valid) * 100
  }
}

function globPattern(pattern) {
  let expression = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      expression += '.*'
      index += 1
    } else if (character === '*') expression += '[^/]*'
    else if (character === '?') expression += '[^/]'
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${expression}$`)
}

function targetInputPatterns(target) {
  const packageDirectory = normalized(target.packageDirectory)
  const patterns = []
  for (const mutate of target.mutate ?? []) {
    patterns.push(`${packageDirectory}/${mutate.replace(/:\d+(?:-\d+)?$/, '')}`)
  }
  if (typeof target.propertyTest === 'string') patterns.push(normalized(target.propertyTest))
  const jest = target.runnerOptions?.jest
  const vitest = target.runnerOptions?.vitest
  const configFile = jest?.configFile ?? vitest?.configFile
  if (typeof configFile === 'string') patterns.push(`${packageDirectory}/${configFile}`)
  for (const match of jest?.config?.testMatch ?? []) {
    patterns.push(`${packageDirectory}/${match.replace(/^<rootDir>\//, '')}`)
  }
  return patterns.map(globPattern)
}

function packageWideTarget(target) {
  return (
    target.runnerOptions?.jest?.config?.testMatch === undefined &&
    target.runnerOptions?.vitest?.related !== true
  )
}

export function selectAffectedMutationTargets(
  targets,
  changedFiles,
  { changedTargetIds = [], changedImporters = [] } = {}
) {
  const files = changedFiles.map(normalized).filter(Boolean)
  const globalChange = files.some(
    file =>
      CONTROL_PATHS.has(file) ||
      CONTROL_PATH_PREFIXES.some(prefix =>
        prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix
      )
  )
  if (globalChange) return Object.keys(targets)

  return Object.entries(targets)
    .filter(([id, target]) => {
      if (
        changedTargetIds.includes(id) ||
        changedImporters.includes(normalized(target.packageDirectory))
      ) {
        return true
      }
      const patterns = targetInputPatterns(target)
      if (files.some(file => patterns.some(pattern => pattern.test(file)))) return true
      if (!packageWideTarget(target)) return false
      const prefix = `${normalized(target.packageDirectory)}/`
      return files.some(
        file =>
          file.startsWith(prefix) &&
          file !== normalized(target.manifest) &&
          !file.endsWith('.md') &&
          !file.includes('/docs/')
      )
    })
    .map(([id]) => id)
}

function changedPolicyTargets(base) {
  const currentPolicy = readPolicy()
  if (currentPolicy === undefined) return []
  const basePolicy = JSON.parse(
    execFileSync('git', ['show', `${base}:governance/mutation-testing/policy.json`], {
      cwd: REPOSITORY_ROOT,
      encoding: 'utf8'
    })
  )
  const currentById = new Map(currentPolicy.targets.map(target => [target.id, target]))
  const baseById = new Map(basePolicy.targets.map(target => [target.id, target]))
  return [...new Set([...currentById.keys(), ...baseById.keys()])].filter(
    id => JSON.stringify(currentById.get(id)) !== JSON.stringify(baseById.get(id))
  )
}

async function changedConfiguredTargets(base, currentTargets) {
  const source = execFileSync('git', ['show', `${base}:governance/mutation-testing/targets.mjs`], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8'
  })
  const module = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  )
  const baseTargets = module.buildMutationTargets(REPOSITORY_ROOT)
  return [...new Set([...Object.keys(currentTargets), ...Object.keys(baseTargets)])].filter(
    id => JSON.stringify(currentTargets[id]) !== JSON.stringify(baseTargets[id])
  )
}

function readPolicy() {
  if (!fs.existsSync(POLICY_PATH)) return undefined
  return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
}

function readReport(targetName) {
  const reportPath = path.join(REPOSITORY_ROOT, 'artifacts/mutation', targetName, 'mutation.json')
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  const mutants = Object.values(report.files).flatMap(file => file.mutants)
  return { metrics: calculateMutationMetrics(mutants), reportPath }
}

function policyTarget(policy, targetName) {
  return policy?.targets?.find(target => target.id === targetName)
}

export function evaluateMutationReport(targetName, metrics, policy) {
  const targetPolicy = policyTarget(policy, targetName)
  if (targetPolicy === undefined) {
    return [`mutation target ${targetName} is absent from the governed policy`]
  }

  const errors = []
  if (metrics.score + Number.EPSILON < targetPolicy.minimumScore) {
    errors.push(
      `${targetName} mutation score ${metrics.score.toFixed(2)} is below ${targetPolicy.minimumScore}`
    )
  }
  const noCoverage = metrics.counts.NoCoverage ?? 0
  if (noCoverage > targetPolicy.maximumNoCoverage) {
    errors.push(
      `${targetName} has ${noCoverage} no-coverage mutants; maximum is ${targetPolicy.maximumNoCoverage}`
    )
  }
  const invalid = (metrics.counts.RuntimeError ?? 0) + (metrics.counts.CompileError ?? 0)
  if (invalid > targetPolicy.maximumInvalid) {
    errors.push(
      `${targetName} has ${invalid} invalid mutants; maximum is ${targetPolicy.maximumInvalid}`
    )
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

async function runTarget(targetName, target, policy) {
  const stryker = path.join(REPOSITORY_ROOT, 'node_modules/.bin/stryker')
  const reporters = process.env.MUTATION_VERBOSE === '1' ? 'clear-text,json' : 'json'
  const exitCode = await runCommand(stryker, ['run', CONFIG_PATH, '--reporters', reporters], {
    cwd: path.join(REPOSITORY_ROOT, target.packageDirectory),
    env: {
      ...process.env,
      FAST_CHECK_NUM_RUNS: process.env.FAST_CHECK_NUM_RUNS ?? String(policy.tool.propertyRuns),
      FAST_CHECK_SEED: process.env.FAST_CHECK_SEED ?? String(policy.tool.propertySeed),
      FAST_CHECK_PATH: process.env.FAST_CHECK_PATH ?? '',
      TS_STACK_MUTATION_TARGET: targetName
    }
  })
  if (exitCode !== 0) throw new Error(`${targetName} mutation process exited ${exitCode}`)

  const { metrics, reportPath } = readReport(targetName)
  const counts = Object.entries(metrics.counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([status, count]) => `${status}=${count}`)
    .join(', ')
  console.log(`${targetName}: ${metrics.score.toFixed(2)}% (${counts})`)
  console.log(`  report: ${path.relative(REPOSITORY_ROOT, reportPath)}`)
  const errors = evaluateMutationReport(targetName, metrics, policy)
  if (errors.length > 0) throw new Error(errors.join('\n'))
}

export function parseArguments(arguments_) {
  const result = { all: false, list: false, targets: [], affectedFile: undefined, base: undefined }
  for (let index = 0; index < arguments_.length; index++) {
    const argument = arguments_[index]
    if (argument === '--all') result.all = true
    else if (argument === '--list') result.list = true
    else if (argument === '--target') {
      const target = arguments_[++index]
      if (target === undefined || target.startsWith('--')) {
        throw new Error('--target requires an exact target ID')
      }
      result.targets.push(target)
    } else if (argument === '--affected-file') {
      const affectedFile = arguments_[++index]
      if (affectedFile === undefined || affectedFile.startsWith('--')) {
        throw new Error('--affected-file requires a path')
      }
      result.affectedFile = affectedFile
    } else if (argument === '--base') {
      const base = arguments_[++index]
      if (base === undefined || base.startsWith('--')) {
        throw new Error('--base requires an exact revision')
      }
      result.base = base
    } else throw new Error(`Unknown argument ${argument}`)
  }
  const modes = [
    result.all,
    result.list,
    result.targets.length > 0,
    result.affectedFile !== undefined
  ].filter(Boolean).length
  if (modes > 1) throw new Error('Select exactly one mutation command mode')
  if (result.base !== undefined && result.affectedFile === undefined) {
    throw new Error('--base is valid only with --affected-file')
  }
  return result
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  const targets = buildMutationTargets(REPOSITORY_ROOT)

  if (options.list) {
    console.log(Object.keys(targets).join('\n'))
    return
  }
  if (options.affectedFile !== undefined) {
    const changedFiles = fs.readFileSync(options.affectedFile, 'utf8').split(/\r?\n/)
    let changedTargetIds = []
    let changedImporters = []
    if (options.base !== undefined) {
      if (changedFiles.includes('governance/mutation-testing/policy.json')) {
        changedTargetIds.push(...changedPolicyTargets(options.base))
      }
      if (changedFiles.includes('governance/mutation-testing/targets.mjs')) {
        changedTargetIds.push(...(await changedConfiguredTargets(options.base, targets)))
      }
      if (changedFiles.includes('pnpm-lock.yaml')) {
        changedImporters = changedLockfileImporters(
          execFileSync('git', ['show', `${options.base}:pnpm-lock.yaml`], {
            cwd: REPOSITORY_ROOT,
            encoding: 'utf8'
          }),
          fs.readFileSync(path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8')
        )
      }
    }
    console.log(
      JSON.stringify(
        selectAffectedMutationTargets(targets, changedFiles, {
          changedTargetIds: [...new Set(changedTargetIds)],
          changedImporters
        })
      )
    )
    return
  }

  const selected = options.all ? Object.keys(targets) : options.targets
  if (selected.length === 0) {
    throw new Error('Select --all, --list, --affected-file <path>, or at least one --target <id>')
  }
  if (new Set(selected).size !== selected.length) throw new Error('Duplicate mutation target')

  const policy = readPolicy()
  if (policy === undefined) throw new Error('Mutation policy is missing')
  for (const targetName of selected) {
    const target = targets[targetName]
    if (target === undefined) throw new Error(`Unknown mutation target ${targetName}`)
    await runTarget(targetName, target, policy)
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
