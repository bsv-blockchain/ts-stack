#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const SKIPPED_DIRECTORIES = new Set([
  '.git',
  '.next',
  '.pagefind',
  '.stryker-tmp',
  'artifacts',
  'coverage',
  'dist',
  'node_modules',
  'out',
  'reports'
])

const normalize = value => value.split(path.sep).join('/')
const readJson = (root, relativePath) =>
  JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'))

export function governedScopePaths(projects, serviceOperations) {
  return [
    ...new Set([
      ...projects.projects.map(project => project.path),
      ...serviceOperations.services.map(service => service.path)
    ])
  ]
    .filter(projectPath => projectPath !== '.')
    .sort((left, right) => left.localeCompare(right))
}

export function renderPackageAgentPointer(projectPath) {
  const rootInstructions = normalize(path.posix.relative(projectPath, 'AGENTS.md'))
  const rootContributing = normalize(path.posix.relative(projectPath, 'CONTRIBUTING.md'))
  return `# ts-stack agent instructions

This project follows the repository-wide [agent instructions](${rootInstructions})
and [contribution policy](${rootContributing}). Read and follow both files
before changing anything in this directory.

Do not add package-local agent or contribution conventions. Put
package-specific technical information in the package README, \`docs/\`,
\`specs/\`, or the applicable operator guide, and propose shared policy at the
repository root.
`
}

function walk(root, relativeDirectory = '.') {
  const absoluteDirectory = path.join(root, relativeDirectory)
  if (!fs.existsSync(absoluteDirectory)) return []
  const entries = []
  for (const entry of fs.readdirSync(absoluteDirectory, { withFileTypes: true })) {
    if (SKIPPED_DIRECTORIES.has(entry.name)) continue
    const relativePath = normalize(path.join(relativeDirectory, entry.name)).replace(/^\.\//, '')
    entries.push({ path: relativePath, name: entry.name, isDirectory: entry.isDirectory() })
    if (entry.isDirectory()) entries.push(...walk(root, relativePath))
  }
  return entries
}

function requireFile(root, relativePath, errors) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    errors.push(`required contributor-policy file is missing: ${relativePath}`)
    return undefined
  }
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function validateAuthority(root, policy, errors) {
  for (const relativePath of Object.values(policy.authority ?? {})) {
    if (relativePath.endsWith('ISSUE_TEMPLATE')) {
      if (!fs.statSync(path.join(root, relativePath), { throwIfNoEntry: false })?.isDirectory()) {
        errors.push(`required contributor-policy directory is missing: ${relativePath}`)
      }
    } else {
      requireFile(root, relativePath, errors)
    }
  }

  for (const workflow of policy.requiredRootWorkflows ?? []) {
    requireFile(root, workflow, errors)
  }

  const pullRequestTemplate = requireFile(root, policy.authority.pullRequestTemplate, errors)
  if (pullRequestTemplate !== undefined) {
    for (const fragment of policy.requiredPullRequestEvidence ?? []) {
      if (!pullRequestTemplate.toLowerCase().includes(fragment.toLowerCase())) {
        errors.push(
          `${policy.authority.pullRequestTemplate} must require ${JSON.stringify(fragment)}`
        )
      }
    }
  }
}

function validatePointers(root, scopePaths, entries, errors) {
  const expectedAgentPaths = new Set([
    'AGENTS.md',
    ...scopePaths.map(projectPath => `${projectPath}/AGENTS.md`)
  ])
  const actualAgentPaths = entries
    .filter(entry => !entry.isDirectory && entry.name === 'AGENTS.md')
    .map(entry => entry.path)
    .sort((left, right) => left.localeCompare(right))

  for (const projectPath of scopePaths) {
    const relativePath = `${projectPath}/AGENTS.md`
    const source = requireFile(root, relativePath, errors)
    if (source !== undefined && source !== renderPackageAgentPointer(projectPath)) {
      errors.push(`${relativePath} must be the generated root-policy pointer`)
    }
  }

  for (const actualPath of actualAgentPaths) {
    if (!expectedAgentPaths.has(actualPath)) {
      errors.push(`unregistered nested agent policy is forbidden: ${actualPath}`)
    }
  }
}

function validateNoNestedPolicy(root, policy, entries, errors) {
  for (const entry of entries) {
    if (entry.isDirectory && entry.name === '.github' && entry.path !== '.github') {
      errors.push(`nested GitHub configuration is forbidden: ${entry.path}`)
    }
    if (
      !entry.isDirectory &&
      policy.prohibitedNestedPolicyFiles.includes(entry.name) &&
      entry.path !== entry.name
    ) {
      errors.push(`package-local contributor policy is forbidden: ${entry.path}`)
    }
  }

  for (const relativePath of policy.retiredPackageContributionFiles ?? []) {
    if (fs.existsSync(path.join(root, relativePath))) {
      errors.push(`retired package contribution file returned: ${relativePath}`)
    }
  }
}

function validateHistoricalDispositions(root, policy, errors) {
  const files = []
  for (const disposition of policy.historicalGitHubDispositions ?? []) {
    for (const field of ['id', 'decision', 'replacement', 'rationale']) {
      if (typeof disposition[field] !== 'string' || disposition[field].trim() === '') {
        errors.push(`historical GitHub disposition must define ${field}`)
      }
    }
    if (!Array.isArray(disposition.files) || disposition.files.length === 0) {
      errors.push(`${disposition.id ?? '<unknown>'} must inventory retired files`)
      continue
    }
    for (const relativePath of disposition.files) {
      files.push(relativePath)
      if (fs.existsSync(path.join(root, relativePath))) {
        errors.push(`historical nested GitHub file returned: ${relativePath}`)
      }
    }
  }
  const duplicates = files.filter((file, index) => files.indexOf(file) !== index)
  for (const duplicate of new Set(duplicates)) {
    errors.push(`historical GitHub file has multiple dispositions: ${duplicate}`)
  }
}

function validateLegacyAgentConsolidation(root, policy, scopePaths, errors) {
  const consolidation = policy.legacyAgentConsolidation
  if (consolidation === undefined) return

  for (const field of ['decision', 'replacement', 'rationale']) {
    if (typeof consolidation[field] !== 'string' || consolidation[field].trim() === '') {
      errors.push(`legacy agent consolidation must define ${field}`)
    }
  }
  if (!Array.isArray(consolidation.priorFiles) || consolidation.priorFiles.length === 0) {
    errors.push('legacy agent consolidation must inventory prior files')
    return
  }

  const governedAgentPaths = new Set(scopePaths.map(projectPath => `${projectPath}/AGENTS.md`))
  const duplicates = consolidation.priorFiles.filter(
    (file, index) => consolidation.priorFiles.indexOf(file) !== index
  )
  for (const duplicate of new Set(duplicates)) {
    errors.push(`legacy agent file has multiple dispositions: ${duplicate}`)
  }

  for (const relativePath of consolidation.priorFiles) {
    if (!governedAgentPaths.has(relativePath)) {
      errors.push(`legacy agent file is not a governed scope: ${relativePath}`)
      continue
    }
    const projectPath = path.posix.dirname(relativePath)
    const source = requireFile(root, relativePath, errors)
    if (source !== undefined && source !== renderPackageAgentPointer(projectPath)) {
      errors.push(`legacy agent file was not replaced by the generated pointer: ${relativePath}`)
    }
  }
}

export function evaluateContributorPolicy({
  root = REPOSITORY_ROOT,
  policy = readJson(root, 'governance/contributor-policy.json'),
  projects = readJson(root, 'governance/repository-health/projects.json'),
  serviceOperations = readJson(root, 'governance/service-operations.json')
} = {}) {
  const errors = []
  if (policy.schemaVersion !== 1) errors.push('contributor policy schemaVersion must be 1')
  if (typeof policy.owner !== 'string' || policy.owner.trim() === '') {
    errors.push('contributor policy must define an owner')
  }
  const scopePaths = governedScopePaths(projects, serviceOperations)
  const entries = walk(root)
  validateAuthority(root, policy, errors)
  validatePointers(root, scopePaths, entries, errors)
  validateNoNestedPolicy(root, policy, entries, errors)
  validateHistoricalDispositions(root, policy, errors)
  validateLegacyAgentConsolidation(root, policy, scopePaths, errors)
  return {
    errors,
    summary: {
      scopedProjectsAndServices: scopePaths.length,
      historicalGitHubFiles: (policy.historicalGitHubDispositions ?? []).reduce(
        (count, disposition) => count + (disposition.files?.length ?? 0),
        0
      ),
      consolidatedLegacyAgentFiles: policy.legacyAgentConsolidation?.priorFiles?.length ?? 0,
      retiredPackageContributionFiles: policy.retiredPackageContributionFiles?.length ?? 0
    }
  }
}

export function syncPackageAgentPointers(root = REPOSITORY_ROOT) {
  const projects = readJson(root, 'governance/repository-health/projects.json')
  const serviceOperations = readJson(root, 'governance/service-operations.json')
  const scopePaths = governedScopePaths(projects, serviceOperations)
  for (const projectPath of scopePaths) {
    const target = path.join(root, projectPath, 'AGENTS.md')
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, renderPackageAgentPointer(projectPath))
  }
  return scopePaths.length
}

function run() {
  const arguments_ = process.argv.slice(2)
  if (arguments_.some(argument => argument !== '--write')) {
    throw new Error('Usage: node scripts/contributor-policy.mjs [--write]')
  }
  if (arguments_.includes('--write')) {
    const count = syncPackageAgentPointers()
    console.log(`Synchronized ${count} package and service AGENTS.md pointers`)
  }
  const result = evaluateContributorPolicy()
  if (result.errors.length > 0) {
    console.error(`Contributor policy failed (${result.errors.length} finding(s)):`)
    for (const error of result.errors) console.error(`- ${error}`)
    process.exitCode = 1
    return
  }
  console.log(
    `Contributor policy passed: ${result.summary.scopedProjectsAndServices} scoped pointers, ` +
      `${result.summary.consolidatedLegacyAgentFiles} legacy agent guides consolidated, ` +
      `${result.summary.historicalGitHubFiles} historical GitHub files retired, ` +
      `${result.summary.retiredPackageContributionFiles} package policies consolidated`
  )
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
if (isMain) run()
