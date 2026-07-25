#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
export const REPOSITORY_ROOT = path.resolve(SCRIPT_DIR, '..')
const HEALTH_DIR = path.join(REPOSITORY_ROOT, 'governance/repository-health')
const CONTRACT_BASELINE_PATH = path.join(HEALTH_DIR, 'contract-baseline.json')

const DISCOVERY_ROOTS = ['packages', 'conformance', 'apps', 'docs-site']
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.pagefind',
  'coverage',
  'dist',
  'node_modules',
  'out'
])
const CRITICALITIES = new Set(['tier-0', 'tier-1', 'tier-2', 'tier-3'])
const RELEASES = new Set(['none', 'npm-oidc'])
const EXCEPTION_CATEGORIES = new Set([
  'advisory',
  'coverage',
  'dependency-hold',
  'lint',
  'override',
  'quality-rule',
  'security',
  'skipped-test',
  'toolchain'
])
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

function relativePath(filePath, root = REPOSITORY_ROOT) {
  const relative = path.relative(root, filePath).split(path.sep).join('/')
  return relative === '' ? '.' : relative
}

export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch (error) {
    throw new Error(`Unable to read valid JSON from ${relativePath(filePath)}: ${error.message}`)
  }
}

function findPackageJsonFiles(directory, results) {
  if (!fs.existsSync(directory)) return

  const stat = fs.statSync(directory)
  if (!stat.isDirectory()) return

  const packagePath = path.join(directory, 'package.json')
  if (fs.existsSync(packagePath)) results.add(packagePath)

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || IGNORED_DIRECTORIES.has(entry.name)) continue
    findPackageJsonFiles(path.join(directory, entry.name), results)
  }
}

export function discoverWorkspaceProjects(root = REPOSITORY_ROOT) {
  const packageFiles = new Set([path.join(root, 'package.json')])
  for (const directory of DISCOVERY_ROOTS) {
    findPackageJsonFiles(path.join(root, directory), packageFiles)
  }

  return [...packageFiles]
    .filter(filePath => fs.existsSync(filePath))
    .map(manifestPath => {
      const directory = path.dirname(manifestPath)
      return {
        path: relativePath(directory, root),
        manifestPath,
        manifest: readJson(manifestPath)
      }
    })
    .sort((left, right) => left.path.localeCompare(right.path))
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function isValidDate(value) {
  if (!isNonEmptyString(value) || !DATE_PATTERN.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.valueOf()) && date.toISOString().startsWith(value)
}

function duplicateValues(values) {
  const seen = new Set()
  const duplicates = new Set()
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value)
    seen.add(value)
  }
  return [...duplicates].sort((left, right) =>
    String(left).localeCompare(String(right), undefined, { numeric: true })
  )
}

function validateGeneratedArtifact(artifact, ownerDefinitions) {
  const errors = []
  const prefix = `generated artifact ${artifact?.path ?? '<missing path>'}`
  if (!isNonEmptyString(artifact?.path)) errors.push(`${prefix} must have a path`)
  if (!isNonEmptyString(artifact?.owner) || !ownerDefinitions?.[artifact.owner]) {
    errors.push(`${prefix} references unknown owner ${JSON.stringify(artifact?.owner)}`)
  }
  if (!Array.isArray(artifact?.sourceInputs) || artifact.sourceInputs.length === 0 ||
      artifact.sourceInputs.some(item => !isNonEmptyString(item))) {
    errors.push(`${prefix} must have one or more sourceInputs`)
  }
  for (const field of ['generator', 'reviewPolicy']) {
    if (!isNonEmptyString(artifact?.[field])) errors.push(`${prefix} must have ${field}`)
  }
  if (artifact?.analysisPolicy !== 'exclude-generated') {
    errors.push(`${prefix} analysisPolicy must be "exclude-generated"`)
  }
  return errors
}

function validateGeneratedArtifacts(registry) {
  if (!Array.isArray(registry?.generatedArtifacts)) {
    return ['projects.json generatedArtifacts must be an array']
  }
  const errors = duplicateValues(registry.generatedArtifacts.map(item => item.path))
    .map(duplicate => `projects.json contains duplicate generated artifact path: ${duplicate}`)
  for (const artifact of registry.generatedArtifacts) {
    errors.push(...validateGeneratedArtifact(artifact, registry.ownerDefinitions))
  }
  return errors
}

function validateDependencyAutomation(registry) {
  const policy = registry?.dependencyAutomation?.firstParty
  const prefix = 'projects.json dependencyAutomation.firstParty'
  if (!policy || typeof policy !== 'object') {
    return [`${prefix} must be an object`]
  }

  const errors = []
  const expected = {
    pattern: '@bsv/*',
    dependabotPolicy: 'ignored',
    updateMechanism: 'scripts/sync-versions.mjs',
    releaseWorkflow: '.github/workflows/release.yaml',
    verification: 'scripts/check-versions.mjs'
  }
  for (const [field, value] of Object.entries(expected)) {
    if (policy[field] !== value) {
      errors.push(`${prefix}.${field} must be ${JSON.stringify(value)}`)
    }
  }
  if (!isNonEmptyString(policy.owner) ||
      !registry.ownerDefinitions?.[policy.owner]) {
    errors.push(`${prefix} references unknown owner ${JSON.stringify(policy.owner)}`)
  }
  if (!isNonEmptyString(policy.rationale) ||
      policy.rationale.trim().length < 40) {
    errors.push(`${prefix}.rationale must be at least 40 characters`)
  }
  return errors
}

function validateProjectMetadata(project, registry) {
  const errors = []
  const prefix = `projects.json entry ${project.path ?? '<missing path>'}`
  if (!isNonEmptyString(project.path)) errors.push(`${prefix} must have a path`)
  if (!isNonEmptyString(project.name)) errors.push(`${prefix} must have a name`)
  if (!isNonEmptyString(project.owner) || !registry.ownerDefinitions?.[project.owner]) {
    errors.push(`${prefix} references unknown owner ${JSON.stringify(project.owner)}`)
  }
  if (!isNonEmptyString(project.area)) errors.push(`${prefix} must have an area`)
  if (!isNonEmptyString(project.profile) || !registry.profiles?.[project.profile]) {
    errors.push(`${prefix} references unknown profile ${JSON.stringify(project.profile)}`)
  }
  if (!CRITICALITIES.has(project.criticality)) {
    errors.push(`${prefix} has invalid criticality ${JSON.stringify(project.criticality)}`)
  }
  if (!Array.isArray(project.runtimeTargets) || project.runtimeTargets.length === 0 ||
      project.runtimeTargets.some(target => !isNonEmptyString(target))) {
    errors.push(`${prefix} must have one or more runtimeTargets`)
  }
  if (!RELEASES.has(project.release)) {
    errors.push(`${prefix} has invalid release ${JSON.stringify(project.release)}`)
  }
  return errors
}

function validateProjectManifest(project, actual) {
  const prefix = `projects.json entry ${project.path ?? '<missing path>'}`
  if (!actual) return [`${prefix} has no discovered workspace package.json`]

  const errors = []
  if (actual.manifest.name !== project.name) {
    errors.push(
      `${prefix} name ${JSON.stringify(project.name)} does not match package.json ` +
      `${JSON.stringify(actual.manifest.name)}`
    )
  }
  const isPrivate = actual.manifest.private === true
  if (isPrivate && project.release !== 'none') {
    errors.push(`${prefix} is private but release is ${project.release}`)
  }
  if (!isPrivate && project.release !== 'npm-oidc') {
    errors.push(`${prefix} is public but release is not npm-oidc`)
  }
  return errors
}

function validateConfiguredProjects(registry, discovered) {
  const errors = []
  const discoveredByPath = new Map(discovered.map(project => [project.path, project]))
  for (const project of registry.projects) {
    errors.push(
      ...validateProjectMetadata(project, registry),
      ...validateProjectManifest(project, discoveredByPath.get(project.path))
    )
  }
  return errors
}

export function validateProjectRegistry(registry, discovered) {
  const errors = []
  if (registry?.schemaVersion !== 1) errors.push('projects.json schemaVersion must be 1')
  if (!registry?.ownerDefinitions || typeof registry.ownerDefinitions !== 'object') {
    errors.push('projects.json ownerDefinitions must be an object')
  }
  errors.push(
    ...validateDependencyAutomation(registry),
    ...validateGeneratedArtifacts(registry)
  )
  if (!registry?.profiles || typeof registry.profiles !== 'object') {
    errors.push('projects.json profiles must be an object')
  }
  if (!Array.isArray(registry?.projects)) {
    return [...errors, 'projects.json projects must be an array']
  }

  errors.push(
    ...duplicateValues(registry.projects.map(project => project.path))
      .map(duplicate => `projects.json contains duplicate path: ${duplicate}`),
    ...duplicateValues(registry.projects.map(project => project.name))
      .map(duplicate => `projects.json contains duplicate name: ${duplicate}`),
    ...validateConfiguredProjects(registry, discovered)
  )

  const configuredPaths = new Set(registry.projects.map(project => project.path))
  errors.push(...discovered
    .filter(actual => !configuredPaths.has(actual.path))
    .map(actual => `Discovered workspace project is missing from projects.json: ${actual.path}`))
  return errors
}

function validateExceptionReviewDate(registry, today) {
  if (!isValidDate(registry?.lastReviewed)) {
    return ['exceptions.json lastReviewed must be a real YYYY-MM-DD date']
  }
  const reviewed = new Date(`${registry.lastReviewed}T00:00:00.000Z`)
  const current = new Date(`${today}T00:00:00.000Z`)
  const ageDays = Math.floor((current - reviewed) / 86_400_000)
  if (ageDays < 0) {
    return [`exceptions.json lastReviewed is in the future: ${registry.lastReviewed}`]
  }
  if (ageDays > 31) {
    return [`exceptions.json monthly review is overdue: last reviewed ${registry.lastReviewed}`]
  }
  return []
}

function validateExceptionDates(exception, prefix, today) {
  const errors = []
  for (const field of ['created', 'reviewBy']) {
    if (!isValidDate(exception?.[field])) {
      errors.push(`${prefix} ${field} must be a real YYYY-MM-DD date`)
    }
  }
  if (isValidDate(exception?.created) && isValidDate(exception?.reviewBy) &&
      exception.created > exception.reviewBy) {
    errors.push(`${prefix} reviewBy cannot precede created`)
  }
  if (isValidDate(exception?.reviewBy) && exception.reviewBy < today) {
    errors.push(`${prefix} expired on ${exception.reviewBy}`)
  }
  return errors
}

function validateException(exception, today, ownerDefinitions) {
  const errors = []
  const prefix = `exception ${exception?.id ?? '<missing id>'}`
  if (!isNonEmptyString(exception?.id) || !/^[a-z0-9][a-z0-9-]+$/.test(exception.id)) {
    errors.push(`${prefix} id must use lowercase kebab-case`)
  }
  if (!EXCEPTION_CATEGORIES.has(exception?.category)) {
    errors.push(`${prefix} has invalid category ${JSON.stringify(exception?.category)}`)
  }
  for (const field of ['target', 'owner']) {
    if (!isNonEmptyString(exception?.[field])) errors.push(`${prefix} must have ${field}`)
  }
  if (ownerDefinitions && isNonEmptyString(exception?.owner) &&
      !ownerDefinitions[exception.owner]) {
    errors.push(`${prefix} references unknown owner ${JSON.stringify(exception.owner)}`)
  }
  if (!isNonEmptyString(exception?.reason) || exception.reason.trim().length < 20) {
    errors.push(`${prefix} reason must be at least 20 characters`)
  }
  if (!Array.isArray(exception?.evidence) || exception.evidence.length === 0 ||
      exception.evidence.some(item => !isNonEmptyString(item))) {
    errors.push(`${prefix} must have one or more evidence references`)
  }
  errors.push(...validateExceptionDates(exception, prefix, today))
  if (!isNonEmptyString(exception?.removeWhen) || exception.removeWhen.trim().length < 10) {
    errors.push(`${prefix} removeWhen must be at least 10 characters`)
  }
  return errors
}

export function validateExceptionRegistry(
  registry,
  today = new Date().toISOString().slice(0, 10),
  ownerDefinitions = undefined
) {
  const errors = []
  if (registry?.schemaVersion !== 1) errors.push('exceptions.json schemaVersion must be 1')
  errors.push(...validateExceptionReviewDate(registry, today))
  if (!Array.isArray(registry?.exceptions)) {
    return [...errors, 'exceptions.json exceptions must be an array']
  }

  errors.push(...duplicateValues(registry.exceptions.map(exception => exception.id))
    .map(duplicate => `exceptions.json contains duplicate id: ${duplicate}`))
  for (const exception of registry.exceptions) {
    errors.push(...validateException(exception, today, ownerDefinitions))
  }

  return errors
}

function validateBaselineMetadata(baselines) {
  const errors = []
  if (baselines?.schemaVersion !== 1) errors.push('baselines.json schemaVersion must be 1')
  if (!isValidDate(baselines?.recordedAt)) {
    errors.push('baselines.json recordedAt must be a real YYYY-MM-DD date')
  }
  if (!/^[0-9a-f]{40}$/.test(baselines?.sourceRevision ?? '')) {
    errors.push('baselines.json sourceRevision must be a full Git commit SHA')
  }
  if (!isNonEmptyString(baselines?.tracker)) errors.push('baselines.json tracker must be set')
  return errors
}

function validateBaselineWorkspace(baselines, registry, discovered) {
  const errors = []
  const discoveredPublic = discovered.filter(project => project.manifest.private !== true)
  const packageArea = discovered.filter(project => project.path.startsWith('packages/'))
  const privatePackageArea = packageArea.filter(project => project.manifest.private === true)
  const expectedCounts = {
    projects: discovered.length,
    packageAreaProjects: packageArea.length,
    publicPackages: discoveredPublic.length,
    privatePackageAreaProjects: privatePackageArea.length
  }
  for (const [key, actual] of Object.entries(expectedCounts)) {
    if (baselines?.workspace?.[key] !== actual) {
      errors.push(
        `baselines.json workspace.${key} is ${JSON.stringify(baselines?.workspace?.[key])}; ` +
        `discovered ${actual}`
      )
    }
  }
  if (registry?.projects?.length !== baselines?.workspace?.projects) {
    errors.push('projects.json and baselines.json disagree on workspace project count')
  }
  return errors
}

function validateBaselineVersions(baselines, discovered) {
  const errors = []
  const discoveredPublic = discovered.filter(project => project.manifest.private !== true)
  const versions = baselines?.publicPackageVersions
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) {
    return ['baselines.json publicPackageVersions must be an object']
  }

  const actualNames = new Set(discoveredPublic.map(project => project.manifest.name))
  for (const project of discoveredPublic) {
    const { name, version } = project.manifest
    if (!SEMVER_PATTERN.test(version ?? '')) {
      errors.push(`${project.path} has invalid public package version ${JSON.stringify(version)}`)
    }
    if (versions[name] !== version) {
      errors.push(
        `baselines.json version for ${name} is ${JSON.stringify(versions[name])}; ` +
        `package.json is ${JSON.stringify(version)}`
      )
    }
  }
  for (const name of Object.keys(versions)) {
    if (!actualNames.has(name)) {
      errors.push(`baselines.json has a publicPackageVersions entry for unknown package ${name}`)
    }
  }
  return errors
}

function baselineAlertSets(baselines) {
  return [
    {
      name: 'CodeQL',
      alerts: baselines?.security?.codeqlAlerts,
      total: baselines?.security?.codeqlOpen,
      severities: {
        high: baselines?.security?.codeqlHigh,
        medium: baselines?.security?.codeqlMedium
      }
    },
    {
      name: 'Dependabot',
      alerts: baselines?.security?.dependabotAlerts,
      total: baselines?.security?.dependabotOpen,
      severities: {
        medium: baselines?.security?.dependabotMedium,
        low: baselines?.security?.dependabotLow
      }
    }
  ]
}

function validateBaselineAlertSet(alertSet) {
  if (!Array.isArray(alertSet.alerts)) {
    return [`baselines.json security ${alertSet.name} alerts must be an array`]
  }

  const errors = []
  if (alertSet.alerts.length !== alertSet.total) {
    errors.push(
      `baselines.json security ${alertSet.name} alert total does not match its alert list`
    )
  }
  errors.push(...duplicateValues(alertSet.alerts.map(alert => alert.number))
    .map(duplicate =>
      `baselines.json security ${alertSet.name} contains duplicate alert ${duplicate}`
    ))
  for (const [severity, expected] of Object.entries(alertSet.severities)) {
    const actual = alertSet.alerts.filter(alert => alert.severity === severity).length
    if (actual !== expected) {
      errors.push(
        `baselines.json security ${alertSet.name} ${severity} count is ${expected}; ` +
        `alert list contains ${actual}`
      )
    }
  }
  return errors
}

export function validateBaselines(baselines, registry, discovered) {
  const errors = [
    ...validateBaselineMetadata(baselines),
    ...validateBaselineWorkspace(baselines, registry, discovered),
    ...validateBaselineVersions(baselines, discovered)
  ]
  for (const alertSet of baselineAlertSets(baselines)) {
    errors.push(...validateBaselineAlertSet(alertSet))
  }
  return errors
}

function directoryContainsMatchingFile(directory, pattern) {
  if (!fs.existsSync(directory)) return false
  return fs.readdirSync(directory).some(fileName => pattern.test(fileName))
}

function finding(project, rule, message, detail = '') {
  const suffix = detail === '' ? '' : `::${detail}`
  return {
    id: `${project.path}::${rule}${suffix}`,
    path: project.path,
    name: project.manifest.name,
    rule,
    message
  }
}

function isMutatingCheck(command) {
  if (!isNonEmptyString(command)) return false
  return /(?:^|\s)(?:--fix|--write)(?:\s|$)/.test(command) ||
    /\bprettier\b.*\s-w(?:\s|$)/.test(command)
}

function isPlaceholderCheck(command) {
  if (!isNonEmptyString(command)) return false
  return /\bno test specified\b/i.test(command) ||
    /\bnot implemented\b/i.test(command) ||
    /(?:^|&&|;)\s*exit\s+1(?:\s|$)/.test(command)
}

function collectScriptFindings(project, configured, profile) {
  const findings = []
  const scripts = project.manifest.scripts ?? {}
  for (const scriptName of profile.requiredScripts ?? []) {
    if (!isNonEmptyString(scripts[scriptName])) {
      findings.push(finding(
        project,
        'missing-script',
        `Profile ${configured.profile} requires script ${scriptName}`,
        scriptName
      ))
    }
  }
  for (const scriptName of ['lint', 'format:check']) {
    if (isMutatingCheck(scripts[scriptName])) {
      findings.push(finding(
        project,
        'mutating-check-script',
        `${scriptName} must not modify the working tree`,
        scriptName
      ))
    }
  }
  for (const disabledScript of Object.keys(scripts).filter(name => name.endsWith('-disabled'))) {
    findings.push(finding(
      project,
      'disabled-quality-script',
      `Remove disabled quality escape hatch ${disabledScript}`,
      disabledScript
    ))
  }
  for (const scriptName of profile.requiredScripts ?? []) {
    if (isPlaceholderCheck(scripts[scriptName])) {
      findings.push(finding(
        project,
        'placeholder-quality-script',
        `${scriptName} is a failing placeholder, not a quality check`,
        scriptName
      ))
    }
  }
  return findings
}

function collectFileFindings(project, profile, root) {
  const findings = []
  const directory = path.join(root, project.path === '.' ? '' : project.path)
  if (profile.requiresReadme &&
      !directoryContainsMatchingFile(directory, /^readme(?:\.[^.]+)?$/i)) {
    findings.push(finding(project, 'missing-readme', 'Profile requires a README'))
  }
  if (profile.requiresLicenseFile &&
      !directoryContainsMatchingFile(directory, /^(?:licen[cs]e|copying)(?:\.[^.]+)?$/i)) {
    findings.push(finding(project, 'missing-license-file', 'Profile requires a shipped license file'))
  }
  return findings
}

function publicManifestChecks(manifest) {
  return [
    ['missing-license-field', !isNonEmptyString(manifest.license), 'Public package requires license'],
    ['missing-repository', !manifest.repository, 'Public package requires repository metadata'],
    ['missing-node-engine', !isNonEmptyString(manifest.engines?.node),
      'Public package requires engines.node'],
    ['missing-files-allowlist', !Array.isArray(manifest.files) || manifest.files.length === 0,
      'Public package requires a non-empty files allowlist'],
    ['missing-publish-access', manifest.publishConfig?.access !== 'public',
      'Public package requires publishConfig.access=public'],
    ['missing-side-effects',
      typeof manifest.sideEffects !== 'boolean' &&
        (!Array.isArray(manifest.sideEffects) ||
          manifest.sideEffects.some(item => !isNonEmptyString(item))),
      'Public package requires an explicit sideEffects declaration']
  ]
}

function collectPublicManifestFindings(project, profile) {
  const findings = []
  const manifest = project.manifest
  for (const [rule, failed, message] of publicManifestChecks(manifest)) {
    if (failed) findings.push(finding(project, rule, message))
  }
  if (profile.requiresExports && !manifest.exports) {
    findings.push(finding(project, 'missing-exports', 'Profile requires package exports'))
  }
  if (profile.requiresTypes && !isNonEmptyString(manifest.types ?? manifest.typings)) {
    findings.push(finding(project, 'missing-types', 'Profile requires a types entry'))
  }
  if (profile.requiresBin && !manifest.bin) {
    findings.push(finding(project, 'missing-bin', 'Profile requires a bin entry'))
  }
  return findings
}

function collectProjectFindings(project, configured, profile, root) {
  if (!configured || !profile) return []
  const findings = [
    ...collectScriptFindings(project, configured, profile),
    ...collectFileFindings(project, profile, root)
  ]
  if (project.manifest.private !== true) {
    findings.push(...collectPublicManifestFindings(project, profile))
  }
  return findings
}

export function collectContractFindings(registry, discovered, root = REPOSITORY_ROOT) {
  const configuredByPath = new Map(registry.projects.map(project => [project.path, project]))
  const findings = []
  for (const project of discovered) {
    const configured = configuredByPath.get(project.path)
    const profile = configured ? registry.profiles[configured.profile] : undefined
    findings.push(...collectProjectFindings(project, configured, profile, root))
  }
  return findings.sort((left, right) => left.id.localeCompare(right.id))
}

function summarizeFindings(findings, key) {
  const counts = new Map()
  for (const item of findings) counts.set(item[key], (counts.get(item[key]) ?? 0) + 1)
  return [...counts.entries()].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0])
  )
}

export function createContractBaseline(findings, today = new Date().toISOString().slice(0, 10)) {
  return {
    schemaVersion: 1,
    recordedAt: today,
    findingCount: findings.length,
    findings: findings.map(item => ({
      id: item.id,
      message: item.message
    }))
  }
}

export function compareContractBaseline(baseline, findings) {
  const errors = []
  if (baseline?.schemaVersion !== 1) {
    errors.push('contract-baseline.json schemaVersion must be 1')
    return errors
  }
  if (!isValidDate(baseline?.recordedAt)) {
    errors.push('contract-baseline.json recordedAt must be a real YYYY-MM-DD date')
  }
  if (!Array.isArray(baseline?.findings)) {
    errors.push('contract-baseline.json findings must be an array')
    return errors
  }
  if (baseline.findingCount !== baseline.findings.length) {
    errors.push('contract-baseline.json findingCount does not match findings length')
  }

  const baselineById = new Map(baseline.findings.map(item => [item.id, item]))
  const currentById = new Map(findings.map(item => [item.id, item]))
  for (const duplicate of duplicateValues(baseline.findings.map(item => item.id))) {
    errors.push(`contract-baseline.json contains duplicate id: ${duplicate}`)
  }

  for (const item of findings) {
    const previous = baselineById.get(item.id)
    if (!previous) {
      errors.push(
        `New package-contract finding is not recorded in contract-baseline.json: ` +
        `${item.id} (${item.message})`
      )
    } else if (JSON.stringify(previous) !== JSON.stringify({
      id: item.id,
      message: item.message
    })) {
      errors.push(`Package-contract finding changed without refreshing baseline: ${item.id}`)
    }
  }
  for (const item of baseline.findings) {
    if (!currentById.has(item.id)) {
      errors.push(
        `Resolved package-contract finding remains in contract-baseline.json: ${item.id}; ` +
        `run pnpm health:baseline`
      )
    }
  }

  return errors
}

function escapeTable(value) {
  return String(value).replaceAll('|', String.raw`\|`).replaceAll('\n', ' ')
}

function renderFindingSummary(title, findings, key) {
  const lines = [title, '', '| ' + (key === 'rule' ? 'Rule' : 'Project') + ' | Count |', '|---|---:|']
  for (const [label, count] of summarizeFindings(findings, key)) {
    lines.push(`| \`${escapeTable(label)}\` | ${count} |`)
  }
  if (findings.length === 0) lines.push('| — | 0 |')
  return [...lines, '']
}

function renderDetailedFindings(findings) {
  if (findings.length === 0) return []
  const lines = [
    '## Detailed package-contract findings',
    '',
    '| Project | Rule | Required change |',
    '|---|---|---|'
  ]
  for (const item of findings) {
    lines.push(
      `| \`${escapeTable(item.path)}\` | \`${escapeTable(item.rule)}\` | ` +
      `${escapeTable(item.message)} |`
    )
  }
  return [...lines, '']
}

export function renderMarkdown(result) {
  const lines = [
    '# Repository health',
    '',
    `- Projects: **${result.projects.length}**`,
    `- Public packages: **${result.publicPackages}**`,
    `- Recorded package-contract findings: **${result.findings.length}**`,
    `- Active exceptions: **${result.exceptions.length}**`,
    `- Control errors: **${result.errors.length}**`,
    ''
  ]

  if (result.errors.length > 0) {
    lines.push('## Control errors', '')
    for (const error of result.errors) lines.push(`- ${error}`)
    lines.push('')
  }
  lines.push(
    ...renderFindingSummary('## Findings by rule', result.findings, 'rule'),
    ...renderFindingSummary('## Findings by project', result.findings, 'path'),
    ...renderDetailedFindings(result.findings),
    'Known findings are ratcheted in `governance/repository-health/contract-baseline.json`.',
    'New drift, stale resolved entries, invalid inventory, or expired exceptions fail this check.',
    'Use `pnpm health:baseline` only in the PR that fixes or deliberately reclassifies findings.',
    ''
  )
  return lines.join('\n')
}

export function renderText(result) {
  const lines = [
    `Repository health: ${result.projects.length} projects, ` +
      `${result.publicPackages} public packages, ${result.findings.length} contract findings, ` +
      `${result.exceptions.length} active exceptions, ${result.errors.length} control errors.`
  ]
  for (const error of result.errors) lines.push(`ERROR ${error}`)
  for (const [rule, count] of summarizeFindings(result.findings, 'rule')) {
    lines.push(`FINDINGS ${String(count).padStart(3)} ${rule}`)
  }
  return `${lines.join('\n')}\n`
}

export function evaluateRepositoryHealth({
  root = REPOSITORY_ROOT,
  today = process.env.REPOSITORY_HEALTH_TODAY ?? new Date().toISOString().slice(0, 10),
  skipContractBaseline = false
} = {}) {
  const projectsPath = path.join(root, 'governance/repository-health/projects.json')
  const exceptionsPath = path.join(root, 'governance/repository-health/exceptions.json')
  const baselinesPath = path.join(root, 'governance/repository-health/baselines.json')
  const contractBaselinePath = path.join(root, 'governance/repository-health/contract-baseline.json')
  const discovered = discoverWorkspaceProjects(root)
  const registry = readJson(projectsPath)
  const exceptions = readJson(exceptionsPath)
  const baselines = readJson(baselinesPath)
  const findings = collectContractFindings(registry, discovered, root)
  const errors = [
    ...validateProjectRegistry(registry, discovered),
    ...validateExceptionRegistry(exceptions, today, registry.ownerDefinitions),
    ...validateBaselines(baselines, registry, discovered)
  ]

  if (!skipContractBaseline) {
    if (!fs.existsSync(contractBaselinePath)) {
      errors.push(
        'Missing governance/repository-health/contract-baseline.json; ' +
        'run pnpm health:baseline'
      )
    } else {
      errors.push(...compareContractBaseline(readJson(contractBaselinePath), findings))
    }
  }

  return {
    errors,
    exceptions: exceptions.exceptions ?? [],
    findings,
    projects: discovered,
    publicPackages: discovered.filter(project => project.manifest.private !== true).length,
    today
  }
}

function parseArguments(args) {
  const options = {
    format: 'text',
    strict: false,
    summaryFile: undefined,
    updateContractBaseline: false
  }
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === '--strict') {
      options.strict = true
    } else if (argument === '--update-contract-baseline') {
      options.updateContractBaseline = true
    } else if (argument === '--format') {
      options.format = args[index + 1]
      index += 1
    } else if (argument === '--summary-file') {
      options.summaryFile = args[index + 1]
      index += 1
    } else if (argument === '--help') {
      options.help = true
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (!new Set(['json', 'markdown', 'text']).has(options.format)) {
    throw new Error(`Unsupported format: ${options.format}`)
  }
  return options
}

function renderJson(result) {
  return `${JSON.stringify({
    errors: result.errors,
    exceptions: result.exceptions,
    findingCount: result.findings.length,
    findings: result.findings,
    projectCount: result.projects.length,
    publicPackages: result.publicPackages,
    today: result.today
  }, null, 2)}\n`
}

function renderOutput(result, format) {
  if (format === 'json') return renderJson(result)
  if (format === 'markdown') return `${renderMarkdown(result)}\n`
  return renderText(result)
}

function usage() {
  return [
    'Usage: node scripts/repository-health.mjs [options]',
    '',
    'Options:',
    '  --format <text|markdown|json>   Select stdout format (default: text)',
    '  --summary-file <path>           Append Markdown report to a CI summary file',
    '  --strict                        Fail while any package-contract finding exists',
    '  --update-contract-baseline      Record the current known findings',
    '  --help                          Show this help',
    ''
  ].join('\n')
}

export function runCli(args = process.argv.slice(2)) {
  let options
  try {
    options = parseArguments(args)
  } catch (error) {
    console.error(error.message)
    console.error(usage())
    return 2
  }
  if (options.help) {
    process.stdout.write(usage())
    return 0
  }

  let result
  try {
    result = evaluateRepositoryHealth({
      skipContractBaseline: options.updateContractBaseline
    })
  } catch (error) {
    console.error(error.message)
    return 1
  }

  if (options.updateContractBaseline) {
    if (result.errors.length > 0) {
      for (const error of result.errors) console.error(`ERROR ${error}`)
      return 1
    }
    fs.writeFileSync(
      CONTRACT_BASELINE_PATH,
      `${JSON.stringify(createContractBaseline(result.findings, result.today), null, 2)}\n`
    )
  }

  process.stdout.write(renderOutput(result, options.format))

  if (options.summaryFile) {
    fs.appendFileSync(options.summaryFile, `${renderMarkdown(result)}\n`)
  }
  return result.errors.length > 0 || (options.strict && result.findings.length > 0) ? 1 : 0
}

const isMain = process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) process.exitCode = runCli()
