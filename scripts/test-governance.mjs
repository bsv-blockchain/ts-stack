#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const POLICY_PATH = 'governance/test-quality/policy.json'
const TEST_FILE_PATTERN = /\.(?:test|spec)\.[cm]?[jt]sx?$/
const PROPERTY_TEST_FILE_PATTERN = /\.property\.test\.[cm]?[jt]sx?$/
const MANUAL_SUFFIXES = ['.man.test.ts', '.live.test.ts']
const SKIPPED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules', 'out', 'reports'])

function normalizePath(value) {
  return value.split(path.sep).join('/')
}

function readJson(root, relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))
}

function walkFiles(root, relativeDirectory, predicate) {
  const directory = path.join(root, relativeDirectory)
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue
    const relativePath = path.join(relativeDirectory, entry.name)
    if (entry.isDirectory()) {
      files.push(...walkFiles(root, relativePath, predicate))
    } else if (predicate(entry.name)) {
      files.push(normalizePath(relativePath))
    }
  }
  return files
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length
}

export function findDirectSkips(source) {
  const findings = []
  const patterns = [
    /\b(?:describe|it|test)\.(?:skip|todo)\(\s*(['"`])([^'"`\n]+)\1/g,
    /\b(?:xdescribe|xit|xtest)\(\s*(['"`])([^'"`\n]+)\1/g
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      findings.push({
        title: match[2].trim(),
        line: lineNumberAt(source, match.index)
      })
    }
  }
  return findings.sort((a, b) => a.line - b.line)
}

export function findEmptyTests(source) {
  const findings = []
  const pattern =
    /\b(?:it|test)\(\s*(['"`])([^'"`\n]+)\1\s*,\s*(?:async\s*)?\(\)\s*=>\s*\{\s*\}\s*\)/g
  for (const match of source.matchAll(pattern)) {
    findings.push({
      title: match[2].trim(),
      line: lineNumberAt(source, match.index)
    })
  }
  return findings
}

export function classifyManualFile(relativePath, rules) {
  return rules.filter(
    rule => relativePath.startsWith(rule.pathPrefix) && relativePath.endsWith(rule.suffix)
  )
}

function validateDatedOwner(record, policy, label, errors, today) {
  if (!policy.ownerDefinitions.includes(record.owner)) {
    errors.push(`${label} references unknown owner "${record.owner}"`)
  }
  if (typeof record.reviewBy !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.reviewBy)) {
    errors.push(`${label} must declare reviewBy as YYYY-MM-DD`)
  } else if (record.reviewBy < today) {
    errors.push(`${label} expired on ${record.reviewBy}`)
  }
}

export function collectConformanceSkips(root) {
  const files = walkFiles(root, 'conformance/vectors', name => name.endsWith('.json'))
  const byFile = new Map()
  const errors = []

  for (const relativePath of files) {
    const vectorFile = readJson(root, relativePath)
    const fileParityClass = vectorFile.parity_class ?? 'required'
    const skipped = []
    for (const vector of vectorFile.vectors ?? []) {
      const parityClass = vector.parity_class ?? fileParityClass
      const isSkipped = parityClass === 'intended' || vector.skip === true
      if (!isSkipped) continue

      const reason = vector.skip_reason ?? vectorFile.skip_reason
      if (typeof reason !== 'string' || reason.trim().length < 20) {
        errors.push(`${relativePath} :: ${vector.id ?? 'unknown'} lacks a governed skip reason`)
      }
      if (parityClass === 'intended' && vector.skip === true) {
        errors.push(
          `${relativePath} :: ${vector.id ?? 'unknown'} duplicates intended and explicit skip classification`
        )
      }
      skipped.push(vector.id ?? 'unknown')
    }
    if (skipped.length > 0) byFile.set(relativePath, skipped)
  }

  return { byFile, errors }
}

export function evaluateTestGovernance({
  root = REPOSITORY_ROOT,
  policy = readJson(root, POLICY_PATH),
  today = new Date().toISOString().slice(0, 10)
} = {}) {
  const errors = []
  const testFiles = [
    ...walkFiles(root, 'packages', name => TEST_FILE_PATTERN.test(name)),
    ...walkFiles(root, 'infra', name => TEST_FILE_PATTERN.test(name)),
    ...walkFiles(root, 'docs-site', name => TEST_FILE_PATTERN.test(name))
  ].sort()
  const manualFiles = testFiles.filter(file =>
    MANUAL_SUFFIXES.some(suffix => file.endsWith(suffix))
  )
  const requiredFiles = testFiles.filter(
    file => !MANUAL_SUFFIXES.some(suffix => file.endsWith(suffix))
  )

  const propertyTesting = policy.propertyTesting
  validateDatedOwner(propertyTesting, policy, 'property testing policy', errors, today)
  if (typeof propertyTesting.library !== 'string' || propertyTesting.library.trim() === '') {
    errors.push('property testing policy must declare a library')
  }
  if (typeof propertyTesting.version !== 'string' || propertyTesting.version.trim() === '') {
    errors.push('property testing policy must declare a version')
  }
  if (!Number.isSafeInteger(propertyTesting.minimumRuns) || propertyTesting.minimumRuns < 100) {
    errors.push('property testing policy minimumRuns must be at least 100')
  }
  if (
    !Number.isSafeInteger(propertyTesting.scheduledRuns) ||
    propertyTesting.scheduledRuns < propertyTesting.minimumRuns * 10
  ) {
    errors.push('property testing policy scheduledRuns must be at least 10x minimumRuns')
  }
  if (propertyTesting.rootCommand !== 'pnpm test:property') {
    errors.push('property testing policy rootCommand must be "pnpm test:property"')
  }
  const rootManifest = readJson(root, 'package.json')
  if (typeof rootManifest.scripts?.['test:property'] !== 'string') {
    errors.push('root package.json must declare test:property')
  }
  const requiredReplayEnvironment = ['FAST_CHECK_NUM_RUNS', 'FAST_CHECK_SEED', 'FAST_CHECK_PATH']
  if (
    !Array.isArray(propertyTesting.replayEnvironment) ||
    requiredReplayEnvironment.some(name => !propertyTesting.replayEnvironment.includes(name))
  ) {
    errors.push(
      `property testing policy must declare replay environment ${requiredReplayEnvironment.join(', ')}`
    )
  }

  const manifestPaths = propertyTesting.manifests ?? []
  if (new Set(manifestPaths).size !== manifestPaths.length) {
    errors.push('property testing policy contains duplicate manifests')
  }
  const manifests = new Map()
  for (const manifestPath of manifestPaths) {
    const manifest = readJson(root, manifestPath)
    manifests.set(manifestPath, manifest)
    if (manifest.devDependencies?.[propertyTesting.library] !== propertyTesting.version) {
      errors.push(
        `${manifestPath} must declare ${propertyTesting.library}@${propertyTesting.version}`
      )
    }
    if (typeof manifest.scripts?.['test:property'] !== 'string') {
      errors.push(`${manifestPath} must declare a test:property script`)
    }
  }

  const suitePaths = new Set()
  const suiteManifestPaths = new Set()
  for (const suite of propertyTesting.suites ?? []) {
    if (suitePaths.has(suite.path)) {
      errors.push(`duplicate property suite ${suite.path}`)
    }
    suitePaths.add(suite.path)
    suiteManifestPaths.add(suite.manifest)
    validateDatedOwner(
      { ...propertyTesting, ...suite },
      policy,
      `property suite ${suite.path}`,
      errors,
      today
    )
    if (!requiredFiles.includes(suite.path)) {
      errors.push(`property suite ${suite.path} is missing from required tests`)
      continue
    }
    if (typeof suite.target !== 'string' || suite.target.trim().length < 20) {
      errors.push(`property suite ${suite.path} must declare its target`)
    }
    if (suite.risk !== 'critical' && suite.risk !== 'high') {
      errors.push(`property suite ${suite.path} must declare critical or high risk`)
    }
    if (typeof suite.boundary !== 'string' || suite.boundary.trim().length < 20) {
      errors.push(`property suite ${suite.path} must declare its trust boundary`)
    }
    if (
      !Array.isArray(suite.invariants) ||
      suite.invariants.length < 2 ||
      suite.invariants.some(invariant => typeof invariant !== 'string' || invariant.length < 20)
    ) {
      errors.push(`property suite ${suite.path} must declare at least two concrete invariants`)
    }
    const manifest = manifests.get(suite.manifest)
    if (manifest === undefined) {
      errors.push(`property suite ${suite.path} references unregistered manifest ${suite.manifest}`)
    } else {
      const manifestDirectory = `${normalizePath(path.dirname(suite.manifest))}/`
      if (!suite.path.startsWith(manifestDirectory)) {
        errors.push(`property suite ${suite.path} is outside ${suite.manifest}`)
      }
      if (!manifest.scripts['test:property'].includes(path.basename(suite.path))) {
        errors.push(`${suite.manifest} test:property does not select ${suite.path}`)
      }
    }
    const source = fs.readFileSync(path.join(root, suite.path), 'utf8')
    const importPattern = new RegExp(
      `\\bfrom\\s+['"]${propertyTesting.library.replaceAll('-', '\\-')}['"]`
    )
    if (
      !importPattern.test(source) ||
      !/\bfc\.assert\s*\(/.test(source) ||
      !/\bfc\.configureGlobal\s*\(/.test(source)
    ) {
      errors.push(
        `property suite ${suite.path} must import ${propertyTesting.library}, configure it, and call fc.assert`
      )
    }
    const minimumMatch = source.match(/\bconst\s+MIN_PROPERTY_RUNS\s*=\s*(\d+)/)
    const configuredMinimum =
      minimumMatch === null ? undefined : Number.parseInt(minimumMatch[1], 10)
    if (configuredMinimum !== propertyTesting.minimumRuns) {
      errors.push(
        `property suite ${suite.path} must set MIN_PROPERTY_RUNS to ${propertyTesting.minimumRuns}`
      )
    }
    for (const environmentName of requiredReplayEnvironment) {
      if (!source.includes(`process.env.${environmentName}`)) {
        errors.push(`property suite ${suite.path} must honor ${environmentName}`)
      }
    }
  }
  for (const manifestPath of manifestPaths) {
    if (!suiteManifestPaths.has(manifestPath)) {
      errors.push(`stale property manifest ${manifestPath} has no registered suite`)
    }
  }
  for (const propertyFile of requiredFiles.filter(file => PROPERTY_TEST_FILE_PATTERN.test(file))) {
    if (!suitePaths.has(propertyFile)) {
      errors.push(`${propertyFile} is an unregistered property suite`)
    }
  }

  if (
    typeof propertyTesting.workflow !== 'string' ||
    !fs.existsSync(path.join(root, propertyTesting.workflow))
  ) {
    errors.push('property testing policy workflow is missing')
  } else {
    const workflow = fs.readFileSync(path.join(root, propertyTesting.workflow), 'utf8')
    for (const requiredFragment of [
      'schedule:',
      'workflow_dispatch:',
      'FAST_CHECK_NUM_RUNS',
      'FAST_CHECK_SEED',
      'FAST_CHECK_PATH',
      'pnpm test:property'
    ]) {
      if (!workflow.includes(requiredFragment)) {
        errors.push(
          `property testing workflow ${propertyTesting.workflow} lacks ${requiredFragment}`
        )
      }
    }
  }

  const manualPolicies = new Map(
    policy.manualPolicies.map(manualPolicy => [manualPolicy.id, manualPolicy])
  )
  for (const manualPolicy of policy.manualPolicies) {
    validateDatedOwner(manualPolicy, policy, `manual policy ${manualPolicy.id}`, errors, today)
    for (const field of ['classification', 'expectedResult', 'cleanup', 'cadence', 'invocation']) {
      if (typeof manualPolicy[field] !== 'string' || manualPolicy[field].trim() === '') {
        errors.push(`manual policy ${manualPolicy.id} must declare ${field}`)
      }
    }
    if (!Array.isArray(manualPolicy.prerequisites) || manualPolicy.prerequisites.length === 0) {
      errors.push(`manual policy ${manualPolicy.id} must declare prerequisites`)
    }
  }

  for (const file of manualFiles) {
    const matches = classifyManualFile(file, policy.manualRules)
    if (matches.length !== 1) {
      errors.push(`${file} must match exactly one manual-suite rule; matched ${matches.length}`)
    } else if (!manualPolicies.has(matches[0].policy)) {
      errors.push(`${file} references unknown manual policy ${matches[0].policy}`)
    }
  }
  for (const rule of policy.manualRules) {
    const matches = manualFiles.filter(file => classifyManualFile(file, [rule]).length === 1)
    if (matches.length !== rule.expectedFiles) {
      errors.push(
        `manual rule ${rule.policy} expected ${rule.expectedFiles} files but found ${matches.length}`
      )
    }
  }

  const observedSkips = []
  for (const file of requiredFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8')
    for (const skip of findDirectSkips(source)) {
      observedSkips.push({ path: file, ...skip })
    }
    for (const emptyTest of findEmptyTests(source)) {
      errors.push(
        `${file}:${emptyTest.line} contains assertion-free empty test "${emptyTest.title}"`
      )
    }
  }

  const requiredSkipKey = entry => `${entry.path}\0${entry.title}`
  const registeredSkips = new Map()
  for (const skip of policy.requiredSkips) {
    const key = requiredSkipKey(skip)
    if (registeredSkips.has(key)) {
      errors.push(`duplicate required skip registration for ${skip.path} :: ${skip.title}`)
    }
    registeredSkips.set(key, skip)
    validateDatedOwner(skip, policy, `required skip ${skip.path} :: ${skip.title}`, errors, today)
    for (const field of ['classification', 'reason', 'removeWhen']) {
      if (typeof skip[field] !== 'string' || skip[field].trim().length < 10) {
        errors.push(`required skip ${skip.path} :: ${skip.title} must declare ${field}`)
      }
    }
  }
  const observedSkipKeys = new Set()
  for (const skip of observedSkips) {
    const key = requiredSkipKey(skip)
    observedSkipKeys.add(key)
    if (!registeredSkips.has(key)) {
      errors.push(`${skip.path}:${skip.line} has unregistered skip "${skip.title}"`)
    }
  }
  for (const [key, skip] of registeredSkips) {
    if (!observedSkipKeys.has(key)) {
      errors.push(`stale required skip registration for ${skip.path} :: ${skip.title}`)
    }
  }

  const conformance = collectConformanceSkips(root)
  errors.push(...conformance.errors)
  const registeredConformance = new Map(
    policy.conformanceSkipGroups.map(group => [group.path, group])
  )
  for (const [relativePath, vectorIds] of conformance.byFile) {
    const group = registeredConformance.get(relativePath)
    if (group === undefined) {
      errors.push(`${relativePath} has ${vectorIds.length} unregistered conformance skips`)
    } else if (group.expectedSkips !== vectorIds.length) {
      errors.push(
        `${relativePath} expected ${group.expectedSkips} conformance skips but found ${vectorIds.length}`
      )
    }
  }
  for (const group of policy.conformanceSkipGroups) {
    validateDatedOwner(group, policy, `conformance skip group ${group.path}`, errors, today)
    if (!conformance.byFile.has(group.path)) {
      errors.push(`stale conformance skip group ${group.path}`)
    }
    for (const field of ['classification', 'removeWhen']) {
      if (typeof group[field] !== 'string' || group[field].trim().length < 10) {
        errors.push(`conformance skip group ${group.path} must declare ${field}`)
      }
    }
  }

  return {
    errors,
    summary: {
      requiredTestFiles: requiredFiles.length,
      requiredDirectSkips: observedSkips.length,
      propertySuites: propertyTesting.suites?.length ?? 0,
      propertyPackages: manifestPaths.length,
      manualAndLiveFiles: manualFiles.length,
      conformanceSkipFiles: conformance.byFile.size,
      conformanceSkips: [...conformance.byFile.values()].reduce(
        (sum, vectors) => sum + vectors.length,
        0
      )
    }
  }
}

function run() {
  const result = evaluateTestGovernance()
  if (result.errors.length > 0) {
    console.error(`Test governance failed with ${result.errors.length} finding(s):`)
    for (const error of result.errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }

  const summary = result.summary
  console.log(
    [
      'Test governance passed:',
      `${summary.requiredTestFiles} required test files`,
      `${summary.requiredDirectSkips} governed direct skips`,
      `${summary.propertySuites} governed property suites across ${summary.propertyPackages} packages`,
      `${summary.manualAndLiveFiles} classified manual/live files`,
      `${summary.conformanceSkips} governed conformance skips across ${summary.conformanceSkipFiles} files`
    ].join(' ')
  )
}

const isMain =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) run()
