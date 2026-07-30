#!/usr/bin/env node

import { execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

const execFileAsync = promisify(execFile)
export const ROOT = fileURLToPath(new URL('..', import.meta.url))
const POLICY_PATH = path.join(ROOT, 'governance/dependency-release-policy.json')
const PROJECTS_PATH = path.join(ROOT, 'governance/repository-health/projects.json')
const EXCEPTIONS_PATH = path.join(ROOT, 'governance/repository-health/exceptions.json')
const RELEASE_NOTES_PATH = path.join(ROOT, 'governance/package-release-notes.json')
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]
const IGNORED_DIRECTORIES = new Set(['.git', 'coverage', 'dist', 'node_modules', 'out'])
const DEPENDENCY_FILENAMES = new Set([
  'dependabot.yml',
  'go.mod',
  'go.sum',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'uv.lock'
])

const readJson = filePath => JSON.parse(fs.readFileSync(filePath, 'utf8'))
const stableValue = value => JSON.stringify(value)
const relative = filePath => path.relative(ROOT, filePath).split(path.sep).join('/')
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0
const compareText = (left, right) => left.localeCompare(right)

function isDependencyChange(file) {
  const normalized = file.split(path.sep).join('/')
  const filename = path.posix.basename(normalized)
  if (DEPENDENCY_FILENAMES.has(filename)) return true
  if (filename === 'Dockerfile' || filename.startsWith('Dockerfile.')) return true
  return (
    normalized.startsWith('.github/workflows/') &&
    (normalized.endsWith('.yml') || normalized.endsWith('.yaml'))
  )
}

function walk(directory, callback) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue
    const entryPath = path.join(directory, entry.name)
    if (entry.isDirectory()) walk(entryPath, callback)
    else if (entry.isFile()) callback(entryPath)
  }
}

function packageManifestPaths() {
  const manifests = [path.join(ROOT, 'package.json')]
  for (const directory of ['apps', 'conformance', 'docs-site', 'infra', 'packages', 'tools']) {
    walk(path.join(ROOT, directory), filePath => {
      if (path.basename(filePath) === 'package.json') manifests.push(filePath)
    })
  }
  return [...new Set(manifests)].sort(compareText)
}

function parseOverrideEntry(line) {
  if (!line.startsWith('  ') || line.startsWith('   ')) return undefined
  const entry = line.slice(2)
  const separator = entry.indexOf(':')
  if (separator < 1) return undefined
  const rawSelector = entry.slice(0, separator).trim()
  const value = entry.slice(separator + 1).trim()
  if (value === '') return undefined
  const quote = rawSelector[0]
  const quoted =
    rawSelector.length >= 2 && (quote === "'" || quote === '"') && rawSelector.at(-1) === quote
  return {
    selector: quoted ? rawSelector.slice(1, -1) : rawSelector,
    value
  }
}

export function parsePnpmOverrides(source) {
  const overrides = []
  let inside = false
  for (const line of source.split(/\r?\n/)) {
    if (line === 'overrides:') {
      inside = true
      continue
    }
    if (!inside) continue
    if (line.trim() !== '' && !line.startsWith(' ')) break
    const override = parseOverrideEntry(line)
    if (override !== undefined) overrides.push(override)
  }
  return overrides
}

export function collectOverrides(root = ROOT) {
  const entries = []
  const workspacePath = path.join(root, 'pnpm-workspace.yaml')
  for (const override of parsePnpmOverrides(fs.readFileSync(workspacePath, 'utf8'))) {
    entries.push({ source: 'pnpm-workspace.yaml', ...override })
  }
  for (const manifestPath of packageManifestPaths()) {
    const manifest = readJson(manifestPath)
    for (const [selector, value] of Object.entries(manifest.overrides ?? {})) {
      entries.push({ source: relative(manifestPath), selector, value })
    }
  }
  return entries.sort((left, right) =>
    `${left.source}\0${left.selector}`.localeCompare(`${right.source}\0${right.selector}`)
  )
}

function registrationKey(entry) {
  return `${entry.source}\0${entry.selector}\0${stableValue(entry.value)}`
}

function validateRoutinePolicy(policy, errors) {
  const dependabot = fs.readFileSync(
    path.join(ROOT, policy.routineUpdates.dependabotConfig),
    'utf8'
  )
  const group = policy.routineUpdates.multiEcosystemGroup
  if (!dependabot.includes(`${group}:`)) errors.push(`Dependabot does not define ${group}`)
  if (!/interval:\s*monthly/.test(dependabot)) {
    errors.push('Dependabot routine maintenance must run monthly')
  }
  if (!/open-pull-requests-limit:\s*1/.test(dependabot)) {
    errors.push('Dependabot routine version PR concurrency must be one')
  }
  if ((dependabot.match(/applies-to:\s*security-updates/g) ?? []).length < 2) {
    errors.push('Dependabot must group immediate root and infrastructure npm security updates')
  }
  if ((dependabot.match(/dependency-name:\s*['"]?@bsv\/\*/g) ?? []).length < 2) {
    errors.push('Dependabot must leave first-party @bsv/* updates to release synchronization')
  }
}

function validateEvidenceTemplate(policy, errors) {
  const evidence = policy.dependencyPullRequestEvidence
  const template = fs.readFileSync(path.join(ROOT, evidence.template), 'utf8')
  if (!template.includes(`## ${evidence.heading}`)) {
    errors.push(`${evidence.template} must contain ## ${evidence.heading}`)
  }
  for (const field of evidence.requiredFields) {
    if (!template.includes(`${field}:`)) {
      errors.push(`${evidence.template} must require dependency evidence field ${field}`)
    }
  }
}

function validateFirstParty(policy, projects, errors) {
  const projectPolicy = projects.dependencyAutomation?.firstParty
  for (const field of [
    'pattern',
    'owner',
    'dependabotPolicy',
    'updateMechanism',
    'releaseWorkflow',
    'verification'
  ]) {
    if (policy.firstParty[field] !== projectPolicy?.[field]) {
      errors.push(`first-party ${field} differs from repository project ownership`)
    }
  }
  if (!isNonEmptyString(policy.firstParty.publicationHold)) {
    errors.push('first-party publicationHold must explain source candidate ownership')
  }
}

function validateOverrideRegistry(policy, exceptions, errors) {
  const actual = collectOverrides()
  const actualKeys = new Set(actual.map(registrationKey))
  const registeredKeys = new Set(policy.overrideRegistry.map(registrationKey))
  for (const entry of actual) {
    if (!registeredKeys.has(registrationKey(entry))) {
      errors.push(
        `unregistered override ${entry.source} ${entry.selector}=${stableValue(entry.value)}`
      )
    }
  }
  for (const entry of policy.overrideRegistry) {
    if (!actualKeys.has(registrationKey(entry))) {
      errors.push(`stale override registration ${entry.source} ${entry.selector}`)
    }
  }

  const byId = new Map(exceptions.exceptions.map(exception => [exception.id, exception]))
  const today = new Date().toISOString().slice(0, 10)
  for (const registration of policy.overrideRegistry) {
    validateOverrideException(registration, byId, policy.owner, today, errors)
  }
}

function validateOverrideException(registration, exceptionsById, owner, today, errors) {
  const exception = exceptionsById.get(registration.exceptionId)
  if (exception?.category !== 'override') {
    errors.push(
      `${registration.source} ${registration.selector} references missing override exception ${registration.exceptionId}`
    )
    return
  }
  if (exception.owner !== owner) errors.push(`${exception.id} must be owned by ${owner}`)
  if (exception.reviewBy < today) errors.push(`${exception.id} expired on ${exception.reviewBy}`)
  const hasExternalEvidence = (exception.evidence ?? []).some(
    item =>
      item.startsWith('https://github.com/') &&
      item !== 'https://github.com/bsv-blockchain/ts-stack/issues/324'
  )
  if (!hasExternalEvidence) {
    errors.push(`${exception.id} must include an upstream or advisory link`)
  }
  if (!isNonEmptyString(exception.removeWhen)) {
    errors.push(`${exception.id} must define a removal test`)
  }
}

function validateScheduledVerification(policy, errors) {
  const scheduled = policy.scheduledVerification
  const workflow = fs.readFileSync(path.join(ROOT, scheduled.workflow), 'utf8')
  for (const fragment of [
    `cron: '${scheduled.schedule}'`,
    'dependency-release-governance.mjs check',
    'dependency-release-governance.mjs inventory',
    'dependency-release-governance.mjs verify-published',
    'npm audit signatures',
    'docker pull',
    'docs:facts:check'
  ]) {
    if (!workflow.includes(fragment)) {
      errors.push(`${scheduled.workflow} must contain ${JSON.stringify(fragment)}`)
    }
  }
}

export function validateDependencyReleaseGovernance(root = ROOT) {
  if (root !== ROOT) throw new Error('alternate roots are not supported')
  const policy = readJson(POLICY_PATH)
  const projects = readJson(PROJECTS_PATH)
  const exceptions = readJson(EXCEPTIONS_PATH)
  const errors = []
  if (policy.schemaVersion !== 1) errors.push('dependency release policy schemaVersion must be 1')
  if (!isNonEmptyString(policy.owner)) errors.push('dependency release policy must define owner')
  validateRoutinePolicy(policy, errors)
  validateEvidenceTemplate(policy, errors)
  validateFirstParty(policy, projects, errors)
  validateOverrideRegistry(policy, exceptions, errors)
  validateScheduledVerification(policy, errors)
  return errors
}

function dependencyDeclarations() {
  const declarations = []
  for (const manifestPath of packageManifestPaths()) {
    const manifest = readJson(manifestPath)
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, declared] of Object.entries(manifest[field] ?? {})) {
        declarations.push({
          project: manifest.name,
          manifest: relative(manifestPath),
          field,
          name,
          declared
        })
      }
    }
  }
  return declarations
}

async function npmView(name, fields) {
  const { stdout } = await execFileAsync('npm', ['view', `${name}@latest`, ...fields, '--json'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 60_000
  })
  return JSON.parse(stdout)
}

async function mapWithConcurrency(items, limit, operation) {
  const results = Array.from({ length: items.length })
  let next = 0
  async function worker() {
    while (next < items.length) {
      const index = next++
      results[index] = await operation(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker))
  return results
}

function declaredMajor(value) {
  const match = /(?:^|npm:[^@]+@)[~^<>=\s]*(\d+)\./.exec(String(value))
  return match ? Number(match[1]) : undefined
}

export async function createDirectLatestInventory() {
  const declarations = dependencyDeclarations()
  const names = [...new Set(declarations.map(item => item.name))].sort(compareText)
  const metadata = await mapWithConcurrency(names, 8, async name => {
    try {
      const latest = await npmView(name, ['name', 'version'])
      return { name, latest: latest.version, queryStatus: 'ok' }
    } catch (error) {
      return { name, queryStatus: 'unavailable', error: String(error.message).slice(0, 500) }
    }
  })
  const byName = new Map(metadata.map(item => [item.name, item]))
  const rows = declarations.map(declaration => {
    const registry = byName.get(declaration.name)
    const declared = declaredMajor(declaration.declared)
    const latest = declaredMajor(registry.latest)
    let classification = 'current'
    if (declaration.name.startsWith('@bsv/')) classification = 'first-party-release-held'
    else if (declared !== undefined && latest !== undefined && declared < latest) {
      classification = 'major-migration'
    } else if (registry.latest && !String(declaration.declared).includes(registry.latest)) {
      classification = 'compatible-update'
    }
    return { ...declaration, latest: registry.latest, classification }
  })
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    declarations: rows,
    registryQueries: metadata
  }
}

function publishedBaselines(notes) {
  const result = new Map()
  for (const entry of notes.entries ?? []) {
    result.set(entry.name, entry.publishedVersion ?? entry.published ?? entry.baselineVersion)
  }
  return result
}

function publishedStatus(source, latest, baseline) {
  if (source === latest) return 'current'
  if (baseline === latest) return 'first-party-release-held'
  return 'diverged'
}

export async function verifyPublishedPackages() {
  const projects = readJson(PROJECTS_PATH).projects.filter(
    project => project.release === 'npm-oidc'
  )
  const notes = readJson(RELEASE_NOTES_PATH)
  const baselines = publishedBaselines(notes)
  const packages = await mapWithConcurrency(projects, 8, async project => {
    const manifest = readJson(path.join(ROOT, project.path, 'package.json'))
    const metadata = await npmView(project.name, [
      'name',
      'version',
      'dist.integrity',
      'dist.attestations',
      'gitHead'
    ])
    const latest = metadata.version
    const source = manifest.version
    const baseline = baselines.get(project.name)
    return {
      name: project.name,
      sourceVersion: source,
      publishedLatest: latest,
      recordedPublishedBaseline: baseline,
      status: publishedStatus(source, latest, baseline),
      integrity: metadata['dist.integrity'],
      provenance:
        metadata['dist.attestations']?.provenance?.predicateType ===
        'https://slsa.dev/provenance/v1',
      provenanceUrl: metadata['dist.attestations']?.url,
      gitHead: metadata.gitHead
    }
  })
  const errors = []
  for (const item of packages) {
    if (item.status === 'diverged') {
      errors.push(
        `${item.name} source ${item.sourceVersion}, npm latest ${item.publishedLatest}, and recorded baseline ${item.recordedPublishedBaseline} diverge`
      )
    }
    if (!item.integrity)
      errors.push(`${item.name}@${item.publishedLatest} has no registry integrity`)
    if (!item.provenance) {
      errors.push(`${item.name}@${item.publishedLatest} has no SLSA provenance attestation`)
    }
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    packages,
    heldCandidates: packages
      .filter(item => item.status === 'first-party-release-held')
      .map(item => `${item.name}@${item.sourceVersion}`),
    errors
  }
}

function deploymentImageReference(line) {
  let content = line.trim()
  if (content.startsWith('- ')) content = content.slice(2).trimStart()
  if (!content.startsWith('image:')) return undefined
  let value = content.slice('image:'.length).trim()
  const quote = value[0]
  if (quote === "'" || quote === '"') {
    if (value.at(-1) !== quote) return undefined
    value = value.slice(1, -1)
  }
  if (/\s/.test(value)) return undefined
  const separator = value.lastIndexOf('@sha256:')
  if (separator < 1) return undefined
  const digest = value.slice(separator + '@sha256:'.length)
  if (digest.length !== 64 || !/^[0-9a-f]+$/.test(digest)) return undefined
  return value
}

export function immutableDeploymentImages() {
  const references = new Set()
  for (const root of [
    path.join(ROOT, 'infra/overlay-server/deploy'),
    path.join(ROOT, 'infra/wab/deploy'),
    path.join(ROOT, 'infra/wallet-infra/guides/kube_samples')
  ]) {
    walk(root, filePath => {
      if (!/\.ya?ml$/.test(filePath)) return
      for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
        const reference = deploymentImageReference(line)
        if (reference !== undefined) references.add(reference)
      }
    })
  }
  return [...references].sort(compareText)
}

export function validatePullRequestEvidence(body, changedFiles, policy = readJson(POLICY_PATH)) {
  const dependencyChanges = changedFiles.filter(isDependencyChange)
  if (dependencyChanges.length === 0) return []
  const errors = []
  const evidence = policy.dependencyPullRequestEvidence
  const heading = `## ${evidence.heading}`
  const start = body.indexOf(heading)
  if (start === -1) return [`Dependency changes require the ${heading} section`]
  const section = body.slice(start, body.indexOf('\n## ', start + heading.length) || undefined)
  const lines = section.split(/\r?\n/)
  for (const field of evidence.requiredFields) {
    const prefix = `- ${field}:`
    const line = lines.find(item => item.startsWith(prefix))
    const value = line?.slice(prefix.length).trim()
    if (value === undefined || /^(?:n\/a|none|todo|tbd|-|\[fill)/i.test(value)) {
      errors.push(`Dependency evidence must complete ${field}`)
    }
  }
  return errors
}

async function gitChangedFiles(base, head) {
  const { stdout } = await execFileAsync('git', ['diff', '--name-only', `${base}...${head}`], {
    cwd: ROOT,
    encoding: 'utf8'
  })
  return stdout.split(/\r?\n/).filter(Boolean).filter(isDependencyChange)
}

async function writeReport(filePath, report) {
  const value = `${JSON.stringify(report, null, 2)}\n`
  if (filePath) fs.writeFileSync(path.resolve(filePath), value)
  else process.stdout.write(value)
}

function argumentValue(args, name) {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}

function checkGovernance() {
  const errors = validateDependencyReleaseGovernance()
  if (errors.length > 0) throw new Error(errors.join('\n'))
  console.log(
    `Dependency and release governance passed (${collectOverrides().length} overrides registered).`
  )
}

async function preparePublishedInstall(args) {
  const reportPath = argumentValue(args, '--report')
  const directory = argumentValue(args, '--directory')
  if (!reportPath || !directory) {
    throw new Error('prepare-published-install requires --report and --directory')
  }
  const report = readJson(path.resolve(reportPath))
  const installPath = path.resolve(directory)
  fs.mkdirSync(installPath, { recursive: true })
  const dependencies = Object.fromEntries(
    report.packages
      .map(item => [item.name, item.publishedLatest])
      .sort(([left], [right]) => compareText(left, right))
  )
  fs.writeFileSync(
    path.join(installPath, 'package.json'),
    `${JSON.stringify(
      { name: 'ts-stack-published-verification', private: true, dependencies },
      null,
      2
    )}\n`
  )
  await execFileAsync(
    'npm',
    [
      'install',
      '--package-lock-only',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=true'
    ],
    { cwd: installPath, encoding: 'utf8', timeout: 5 * 60_000 }
  )
}

async function verifyPublished(args) {
  const report = await verifyPublishedPackages()
  await writeReport(argumentValue(args, '--output'), report)
  if (report.errors.length > 0) throw new Error(report.errors.join('\n'))
}

async function verifyPullRequestEvidence(args) {
  const base = argumentValue(args, '--base')
  const head = argumentValue(args, '--head')
  if (!base || !head) throw new Error('pr-evidence requires --base and --head')
  const changedFiles = await gitChangedFiles(base, head)
  const errors = validatePullRequestEvidence(process.env.PR_BODY ?? '', changedFiles)
  if (errors.length > 0) {
    throw new Error(`${errors.join('\n')}\nChanged: ${changedFiles.join(', ')}`)
  }
  console.log(
    changedFiles.length === 0
      ? 'No dependency evidence required.'
      : `Dependency evidence passed for ${changedFiles.length} changed dependency file(s).`
  )
}

const commandHandlers = new Map([
  ['check', async () => checkGovernance()],
  [
    'inventory',
    async args =>
      await writeReport(argumentValue(args, '--output'), await createDirectLatestInventory())
  ],
  ['verify-published', verifyPublished],
  ['prepare-published-install', preparePublishedInstall],
  [
    'image-refs',
    async args =>
      await writeReport(argumentValue(args, '--output'), {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        images: immutableDeploymentImages()
      })
  ],
  ['pr-evidence', verifyPullRequestEvidence]
])

async function main(args) {
  const command = args[0] ?? 'check'
  const handler = commandHandlers.get(command)
  if (handler === undefined) {
    throw new Error(`Unknown command ${command}`)
  }
  await handler(args)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
