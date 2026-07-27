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

function collectTestInventory(root) {
  const testFiles = [
    ...walkFiles(root, 'packages', name => TEST_FILE_PATTERN.test(name)),
    ...walkFiles(root, 'infra', name => TEST_FILE_PATTERN.test(name)),
    ...walkFiles(root, 'docs-site', name => TEST_FILE_PATTERN.test(name))
  ].sort((left, right) => left.localeCompare(right))
  const manualFiles = testFiles.filter(file =>
    MANUAL_SUFFIXES.some(suffix => file.endsWith(suffix))
  )
  const requiredFiles = testFiles.filter(
    file => !MANUAL_SUFFIXES.some(suffix => file.endsWith(suffix))
  )
  return { manualFiles, requiredFiles }
}

function validatePropertyPolicy(root, propertyTesting, policy, errors, today) {
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
}

function validateReplayEnvironment(propertyTesting, errors) {
  const requiredEnvironment = ['FAST_CHECK_NUM_RUNS', 'FAST_CHECK_SEED', 'FAST_CHECK_PATH']
  if (
    !Array.isArray(propertyTesting.replayEnvironment) ||
    requiredEnvironment.some(name => !propertyTesting.replayEnvironment.includes(name))
  ) {
    errors.push(
      `property testing policy must declare replay environment ${requiredEnvironment.join(', ')}`
    )
  }
  return requiredEnvironment
}

function loadPropertyManifests(root, propertyTesting, errors) {
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
  return { manifestPaths, manifests }
}

function validatePropertyExclusion(
  root,
  propertyTesting,
  propertyManifestSet,
  policy,
  errors,
  today,
  exclusion
) {
  const label = `property exclusion ${exclusion.manifest}`
  validateDatedOwner({ ...propertyTesting, ...exclusion }, policy, label, errors, today)
  if (propertyManifestSet.has(exclusion.manifest)) {
    errors.push(`${exclusion.manifest} cannot be both a property manifest and an exclusion`)
  }
  if (exclusion.kind !== 'adapter-or-composition' && exclusion.kind !== 'example-or-platform') {
    errors.push(`${label} must declare adapter-or-composition or example-or-platform`)
  }
  if (typeof exclusion.rationale !== 'string' || exclusion.rationale.trim().length < 40) {
    errors.push(`${label} must declare a concrete rationale`)
  }
  if (
    typeof exclusion.manifest !== 'string' ||
    !exclusion.manifest.startsWith('packages/') ||
    !fs.existsSync(path.join(root, exclusion.manifest))
  ) {
    errors.push(`${label} does not reference an existing package manifest`)
    return
  }
  const manifest = readJson(root, exclusion.manifest)
  if (typeof manifest.scripts?.['test:property'] === 'string') {
    errors.push(`${label} has a test:property command and must be registered as a suite`)
  }
}

function validatePropertyClassificationCoverage(
  root,
  propertyManifestPaths,
  excludedManifestPaths,
  errors
) {
  const discoveredManifestPaths = walkFiles(root, 'packages', name => name === 'package.json')
  const classifications = new Set([...propertyManifestPaths, ...excludedManifestPaths])
  for (const manifestPath of discoveredManifestPaths) {
    if (!classifications.has(manifestPath)) {
      errors.push(`${manifestPath} lacks a property suite or governed exclusion`)
    }
  }
  for (const manifestPath of classifications) {
    if (!discoveredManifestPaths.includes(manifestPath)) {
      errors.push(`stale property classification references ${manifestPath}`)
    }
  }
}

function validatePropertyExclusions(
  root,
  propertyTesting,
  propertyManifestPaths,
  policy,
  errors,
  today
) {
  const exclusions = propertyTesting.exclusions ?? []
  const excludedManifestPaths = exclusions.map(exclusion => exclusion.manifest)
  if (new Set(excludedManifestPaths).size !== excludedManifestPaths.length) {
    errors.push('property testing policy contains duplicate exclusions')
  }
  const propertyManifestSet = new Set(propertyManifestPaths)
  for (const exclusion of exclusions) {
    validatePropertyExclusion(
      root,
      propertyTesting,
      propertyManifestSet,
      policy,
      errors,
      today,
      exclusion
    )
  }
  validatePropertyClassificationCoverage(root, propertyManifestPaths, excludedManifestPaths, errors)

  return excludedManifestPaths
}

function validatePropertySuiteMetadata(suite, propertyTesting, policy, errors, today) {
  validateDatedOwner(
    { ...propertyTesting, ...suite },
    policy,
    `property suite ${suite.path}`,
    errors,
    today
  )
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
}

function validatePropertySuiteManifest(suite, manifest, errors) {
  if (manifest === undefined) {
    errors.push(`property suite ${suite.path} references unregistered manifest ${suite.manifest}`)
    return
  }
  const manifestDirectory = `${normalizePath(path.dirname(suite.manifest))}/`
  if (!suite.path.startsWith(manifestDirectory)) {
    errors.push(`property suite ${suite.path} is outside ${suite.manifest}`)
  }
  if (!manifest.scripts['test:property'].includes(path.basename(suite.path))) {
    errors.push(`${suite.manifest} test:property does not select ${suite.path}`)
  }
}

function validatePropertySuiteSource(root, suite, propertyTesting, requiredEnvironment, errors) {
  const source = fs.readFileSync(path.join(root, suite.path), 'utf8')
  const importsLibrary =
    source.includes(`from '${propertyTesting.library}'`) ||
    source.includes(`from "${propertyTesting.library}"`)
  if (
    !importsLibrary ||
    !/\bfc\.assert\s*\(/.test(source) ||
    !/\bfc\.configureGlobal\s*\(/.test(source)
  ) {
    errors.push(
      `property suite ${suite.path} must import ${propertyTesting.library}, configure it, and call fc.assert`
    )
  }
  const minimumMatch = source.match(/\bconst\s+MIN_PROPERTY_RUNS\s*=\s*(\d+)/)
  const configuredMinimum = minimumMatch === null ? undefined : Number.parseInt(minimumMatch[1], 10)
  if (configuredMinimum !== propertyTesting.minimumRuns) {
    errors.push(
      `property suite ${suite.path} must set MIN_PROPERTY_RUNS to ${propertyTesting.minimumRuns}`
    )
  }
  for (const environmentName of requiredEnvironment) {
    if (!source.includes(`process.env.${environmentName}`)) {
      errors.push(`property suite ${suite.path} must honor ${environmentName}`)
    }
  }
}

function validatePropertySuite(root, suite, context, propertyTesting, policy, errors, today) {
  if (context.suitePaths.has(suite.path)) {
    errors.push(`duplicate property suite ${suite.path}`)
  }
  context.suitePaths.add(suite.path)
  context.suiteManifestPaths.add(suite.manifest)
  validatePropertySuiteMetadata(suite, propertyTesting, policy, errors, today)
  if (!context.requiredFiles.includes(suite.path)) {
    errors.push(`property suite ${suite.path} is missing from required tests`)
    return
  }
  validatePropertySuiteManifest(suite, context.manifests.get(suite.manifest), errors)
  validatePropertySuiteSource(root, suite, propertyTesting, context.requiredEnvironment, errors)
}

function validatePropertyRegistrations(context, manifestPaths, errors) {
  for (const manifestPath of manifestPaths) {
    if (!context.suiteManifestPaths.has(manifestPath)) {
      errors.push(`stale property manifest ${manifestPath} has no registered suite`)
    }
  }
  const propertyFiles = context.requiredFiles.filter(file => PROPERTY_TEST_FILE_PATTERN.test(file))
  for (const propertyFile of propertyFiles) {
    if (!context.suitePaths.has(propertyFile)) {
      errors.push(`${propertyFile} is an unregistered property suite`)
    }
  }
}

function validatePropertyWorkflow(root, propertyTesting, errors) {
  if (
    typeof propertyTesting.workflow !== 'string' ||
    !fs.existsSync(path.join(root, propertyTesting.workflow))
  ) {
    errors.push('property testing policy workflow is missing')
    return
  }
  const workflow = fs.readFileSync(path.join(root, propertyTesting.workflow), 'utf8')
  const requiredFragments = [
    'schedule:',
    'workflow_dispatch:',
    'FAST_CHECK_NUM_RUNS',
    'FAST_CHECK_SEED',
    'FAST_CHECK_PATH',
    'pnpm test:property'
  ]
  for (const requiredFragment of requiredFragments) {
    if (!workflow.includes(requiredFragment)) {
      errors.push(`property testing workflow ${propertyTesting.workflow} lacks ${requiredFragment}`)
    }
  }
}

function validatePropertyTesting(root, requiredFiles, propertyTesting, policy, errors, today) {
  validatePropertyPolicy(root, propertyTesting, policy, errors, today)
  const requiredEnvironment = validateReplayEnvironment(propertyTesting, errors)
  const { manifestPaths, manifests } = loadPropertyManifests(root, propertyTesting, errors)
  const context = {
    manifests,
    requiredEnvironment,
    requiredFiles,
    suiteManifestPaths: new Set(),
    suitePaths: new Set()
  }
  for (const suite of propertyTesting.suites ?? []) {
    validatePropertySuite(root, suite, context, propertyTesting, policy, errors, today)
  }
  validatePropertyRegistrations(context, manifestPaths, errors)
  const excludedManifestPaths = validatePropertyExclusions(
    root,
    propertyTesting,
    manifestPaths,
    policy,
    errors,
    today
  )
  validatePropertyWorkflow(root, propertyTesting, errors)
  return { excludedManifestPaths, manifestPaths }
}

function validateManualPolicies(policy, errors, today) {
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
  return manualPolicies
}

function validateManualFiles(manualFiles, policy, manualPolicies, errors) {
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
}

function collectRequiredTestSkips(root, requiredFiles, errors) {
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
  return observedSkips
}

const requiredSkipKey = entry => `${entry.path}\0${entry.title}`

function registerRequiredSkips(policy, errors, today) {
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
  return registeredSkips
}

function compareRequiredSkips(observedSkips, registeredSkips, errors) {
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
}

function validateConformanceGroups(root, policy, errors, today) {
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
  validateRegisteredConformanceGroups(conformance, policy, errors, today)
  return conformance
}

function validateRegisteredConformanceGroups(conformance, policy, errors, today) {
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
}

export function evaluateTestGovernance({
  root = REPOSITORY_ROOT,
  policy = readJson(root, POLICY_PATH),
  today = new Date().toISOString().slice(0, 10)
} = {}) {
  const errors = []
  const { manualFiles, requiredFiles } = collectTestInventory(root)
  const propertyTesting = policy.propertyTesting
  const { excludedManifestPaths, manifestPaths } = validatePropertyTesting(
    root,
    requiredFiles,
    propertyTesting,
    policy,
    errors,
    today
  )
  const manualPolicies = validateManualPolicies(policy, errors, today)
  validateManualFiles(manualFiles, policy, manualPolicies, errors)
  const observedSkips = collectRequiredTestSkips(root, requiredFiles, errors)
  const registeredSkips = registerRequiredSkips(policy, errors, today)
  compareRequiredSkips(observedSkips, registeredSkips, errors)
  const conformance = validateConformanceGroups(root, policy, errors, today)

  return {
    errors,
    summary: {
      requiredTestFiles: requiredFiles.length,
      requiredDirectSkips: observedSkips.length,
      propertySuites: propertyTesting.suites?.length ?? 0,
      propertyPackages: manifestPaths.length,
      propertyExcludedPackages: excludedManifestPaths.length,
      propertyClassifiedPackages: manifestPaths.length + excludedManifestPaths.length,
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
      `${summary.propertyExcludedPackages} governed property exclusions`,
      `${summary.manualAndLiveFiles} classified manual/live files`,
      `${summary.conformanceSkips} governed conformance skips across ${summary.conformanceSkipFiles} files`
    ].join(' ')
  )
}

const isMain =
  process.argv[1] !== undefined &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) run()
