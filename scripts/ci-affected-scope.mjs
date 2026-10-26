#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]

const PROJECT_REGISTRY_PATH = 'governance/repository-health/projects.json'

const FULL_PACKAGE_CONTROL_PATHS = new Set([
  '.github/workflows/ci.yml',
  'scripts/ci-result-gate.mjs',
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  PROJECT_REGISTRY_PATH,
  'scripts/check-browser-package.mjs',
  'scripts/check-package-artifact.mjs',
  'scripts/run-prebuilt-package-script.mjs',
  'scripts/typescript-toolchain.mjs'
])

// Shared compiler configuration that the root and package tsconfigs extend.
const FULL_PACKAGE_CONTROL_PREFIXES = ['config/typescript/']

export const INFRA_COMPONENTS = [
  { component: 'chaintracks-server', 'native-modules': 'better-sqlite3' },
  { component: 'message-box-server', 'native-modules': 'better-sqlite3' },
  { component: 'overlay-server', 'native-modules': '' },
  { component: 'uhrp-server-basic', 'native-modules': '' },
  { component: 'uhrp-server-cloud-bucket', 'native-modules': 'better-sqlite3' },
  { component: 'uhrp-server-cloud-bucket/notifier', 'native-modules': '' },
  { component: 'wab', 'native-modules': 'better-sqlite3 sqlite3' },
  { component: 'wallet-infra', 'native-modules': 'better-sqlite3' },
  { component: 'webrtpay-relay', 'native-modules': '' }
]

export const RUNTIME_COMPONENTS = [
  { name: 'chaintracks-server', path: 'infra/chaintracks-server', wallet: false },
  { name: 'message-box-server', path: 'infra/message-box-server', wallet: true },
  { name: 'overlay-server', path: 'infra/overlay-server', wallet: true },
  { name: 'uhrp-server-basic', path: 'infra/uhrp-server-basic', wallet: true },
  {
    name: 'uhrp-server-cloud-bucket',
    path: 'infra/uhrp-server-cloud-bucket',
    wallet: true
  },
  { name: 'wab', path: 'infra/wab', wallet: false },
  { name: 'wallet-infra', path: 'infra/wallet-infra', wallet: false },
  { name: 'webrtpay-relay', path: 'infra/webrtpay-relay', wallet: false }
]

const FULL_INFRA_CONTROL_PATHS = new Set([
  '.github/workflows/ci.yml',
  'governance/Dockerfile.container-bases',
  'governance/container-images.json'
])

const FULL_RUNTIME_CONTROL_PATHS = new Set([
  'governance/service-operations.json',
  'scripts/service-operations.mjs',
  'scripts/container-runtime-contract.mjs',
  'scripts/container-runtime-contract.test.mjs'
])

function normalized(value) {
  return value.split(path.sep).join('/').replace(/^\.\//, '')
}

function unquote(value) {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

export function lockfileImporterSections(source) {
  const sections = new Map()
  const lines = source.split(/\r?\n/)
  const importersIndex = lines.indexOf('importers:')
  if (importersIndex === -1) return sections

  let importer
  let body = []
  const flush = () => {
    if (importer !== undefined) sections.set(importer, body.join('\n'))
  }
  for (let index = importersIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^[^\s]/.test(line) && line !== '') break
    const match = /^ {2}(\S.*):$/.exec(line)
    if (match !== null) {
      flush()
      importer = unquote(match[1])
      body = []
    } else if (importer !== undefined) {
      body.push(line)
    }
  }
  flush()
  return sections
}

export function changedLockfileImporters(baseSource, headSource) {
  const base = lockfileImporterSections(baseSource)
  const head = lockfileImporterSections(headSource)
  const importers = new Set([...base.keys(), ...head.keys()])
  return [...importers]
    .filter(importer => base.get(importer) !== head.get(importer))
    .sort((left, right) => left.localeCompare(right))
}

function topLevelSections(source) {
  const sections = new Map()
  let key
  let body = []
  const flush = () => {
    if (key !== undefined) sections.set(key, body.join('\n').trimEnd())
  }
  for (const line of source.split(/\r?\n/)) {
    // Full-line comments carry no settings; they also sit above the next key.
    if (/^\s*#/.test(line)) continue
    const match = /^([A-Za-z][\w-]*):/.exec(line)
    if (match !== null) {
      flush()
      key = match[1]
      body = [line]
    } else if (key !== undefined) {
      body.push(line)
    }
  }
  flush()
  return sections
}

function lockfileEntries(source, header) {
  const entries = new Map()
  const lines = source.split(/\r?\n/)
  const start = lines.indexOf(header)
  if (start === -1) return entries
  let key
  let body = []
  const flush = () => {
    if (key !== undefined) entries.set(key, body.join('\n'))
  }
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\S/.test(line)) break
    const match = /^ {2}(\S.*?):(?: \{\})?$/.exec(line)
    if (match !== null) {
      flush()
      key = unquote(match[1])
      body = []
    } else if (key !== undefined) {
      body.push(line)
    }
  }
  flush()
  return entries
}

// A snapshot key is name@version(peers); an aliased dependency already names
// its target package in the version.
function snapshotKey(name, version) {
  return /^@?[^@(]+@/.test(version) ? version : `${name}@${version}`
}

function snapshotDependencies(body) {
  const keys = []
  for (const line of body.split('\n')) {
    const match = /^ {6}(\S.*?): (\S.*)$/.exec(line)
    if (match !== null) keys.push(snapshotKey(unquote(match[1]), unquote(match[2])))
  }
  return keys
}

function importerDependencies(body) {
  const keys = []
  let name
  for (const line of body.split('\n')) {
    const dependency = /^ {6}(\S.*):$/.exec(line)
    if (dependency !== null) {
      name = unquote(dependency[1])
      continue
    }
    const version = /^ {8}version: (\S.*)$/.exec(line)
    if (version !== null && name !== undefined && !version[1].startsWith('link:'))
      keys.push(snapshotKey(name, unquote(version[1])))
  }
  return keys
}

// Lockfile sections whose effect on installs is fully reflected in importer
// and snapshot entries. A change to any other section (settings, version)
// may change every install, so it selects the whole workspace.
const LOCKFILE_GRAPH_SECTIONS = new Set([
  'importers',
  'packages',
  'snapshots',
  'overrides',
  'patchedDependencies',
  'packageExtensionsChecksum',
  'catalogs'
])

// Importers whose installed dependency graph differs between the lockfiles:
// their own entries changed, or anything they reach, directly or not, did.
// Frozen installs make the lockfile the whole truth about what is installed.
function settingsChanged(baseSource, headSource) {
  const base = topLevelSections(baseSource)
  const head = topLevelSections(headSource)
  return [...new Set([...base.keys(), ...head.keys()])].some(
    key => !LOCKFILE_GRAPH_SECTIONS.has(key) && base.get(key) !== head.get(key)
  )
}

function parseLockfileGraph(source) {
  return {
    importers: lockfileEntries(source, 'importers:'),
    packages: lockfileEntries(source, 'packages:'),
    snapshots: lockfileEntries(source, 'snapshots:')
  }
}

// Snapshots added, removed or edited, plus every snapshot of a package whose
// resolution (tarball integrity) changed under the same version.
function changedSnapshots(base, head) {
  const changed = new Set()
  addSnapshotsChangedFrom(base, head, changed)
  addSnapshotsChangedFrom(head, base, changed)
  return changed
}

function addSnapshotsChangedFrom(from, to, changed) {
  for (const [key, body] of from.snapshots) if (to.snapshots.get(key) !== body) changed.add(key)
  for (const [key, body] of from.packages) {
    if (to.packages.get(key) === body) continue
    for (const snapshot of from.snapshots.keys())
      if (snapshot === key || snapshot.startsWith(`${key}(`)) changed.add(snapshot)
  }
}

// Package importers whose dependency graph reaches a changed snapshot. The root
// importer's own changes select the workspace separately; its tools reached
// only indirectly (formatters, linters, mutation) run in the lint, build and
// artifact jobs on every pull request, while each package's own test toolchain
// sits in that package's closure.
function importersReaching(lockfile, changed) {
  const dependents = new Map()
  for (const [key, body] of lockfile.snapshots) {
    for (const dependency of snapshotDependencies(body)) {
      const set = dependents.get(dependency) ?? new Set()
      set.add(key)
      dependents.set(dependency, set)
    }
  }
  const reaching = closure(changed, dependents)
  return [...lockfile.importers]
    .filter(([importer]) => importer !== '.')
    .filter(([, body]) => importerDependencies(body).some(key => reaching.has(key)))
    .map(([importer]) => importer)
}

export function lockfileAffectedImporters(baseSource, headSource) {
  if (settingsChanged(baseSource, headSource)) return ['.']
  const base = parseLockfileGraph(baseSource)
  const head = parseLockfileGraph(headSource)
  const changed = changedSnapshots(base, head)
  const affected = new Set([
    ...changedLockfileImporters(baseSource, headSource),
    ...importersReaching(base, changed),
    ...importersReaching(head, changed)
  ])
  return sortedNames(affected)
}

// pnpm-workspace.yaml settings that only change dependency resolution, which
// the frozen lockfile then records in full.
const RESOLUTION_ONLY_WORKSPACE_KEYS = new Set([
  'catalog',
  'catalogs',
  'minimumReleaseAge',
  'minimumReleaseAgeExclude',
  'overrides',
  'packageExtensions',
  'patchedDependencies'
])

export function workspaceChangeIsResolutionOnly(baseSource, headSource) {
  const base = topLevelSections(baseSource)
  const head = topLevelSections(headSource)
  return [...new Set([...base.keys(), ...head.keys()])].every(
    key => RESOLUTION_ONLY_WORKSPACE_KEYS.has(key) || base.get(key) === head.get(key)
  )
}

// A change confined to project entries selects those projects; any other
// registry change (profiles, owners, schema) still selects the workspace.
export function projectRegistryChanges(baseSource, headSource) {
  let base
  let head
  try {
    base = JSON.parse(baseSource)
    head = JSON.parse(headSource)
  } catch {
    return { full: true, paths: [] }
  }
  if (!Array.isArray(base?.projects) || !Array.isArray(head?.projects))
    return { full: true, paths: [] }
  const { projects: baseProjects, ...baseRest } = base
  const { projects: headProjects, ...headRest } = head
  if (JSON.stringify(baseRest) !== JSON.stringify(headRest)) return { full: true, paths: [] }
  const before = new Map(baseProjects.map(project => [project.path, JSON.stringify(project)]))
  const paths = headProjects
    .filter(project => before.get(project.path) !== JSON.stringify(project))
    .map(project => normalized(project.path))
  return { full: paths.includes('.'), paths: sortedNames(paths) }
}

// The most specific project that owns an importer, so a nested importer such
// as a mobile build does not also select its parent package.
function importerOwner(projects, importer) {
  let owner
  for (const project of projects) {
    if (project.path === '.') continue
    if (importer === project.path || importer.startsWith(`${project.path}/`)) {
      if (owner === undefined || project.path.length > owner.path.length) owner = project
    }
  }
  return owner
}

function projectOwnsFile(project, file) {
  const roots = [project.path, ...(project.sourceRoots ?? [])]
  return roots.some(root => root !== '.' && (file === root || file.startsWith(`${root}/`)))
}

function documentationOnlyProjectFile(projectPath, file) {
  const relative = file.slice(projectPath.length + 1)
  return (
    relative.endsWith('.md') ||
    relative === 'LICENSE' ||
    relative === 'LICENSE.txt' ||
    relative.startsWith('docs/')
  )
}

function internalDependencies(project, names) {
  const dependencies = new Set()
  for (const field of DEPENDENCY_FIELDS) {
    for (const name of Object.keys(project.manifest[field] ?? {})) {
      if (names.has(name)) dependencies.add(name)
    }
  }
  return dependencies
}

function closure(seed, neighbors) {
  const selected = new Set(seed)
  const queue = [...seed]
  while (queue.length > 0) {
    const name = queue.shift()
    for (const neighbor of neighbors.get(name) ?? []) {
      if (selected.has(neighbor)) continue
      selected.add(neighbor)
      queue.push(neighbor)
    }
  }
  return selected
}

function workspaceEdges(projects) {
  const projectNames = new Set(projects.map(project => project.name))
  const forward = new Map()
  const reverse = new Map()
  for (const project of projects) {
    const dependencies = internalDependencies(project, projectNames)
    forward.set(project.name, dependencies)
    for (const dependency of dependencies) {
      const dependents = reverse.get(dependency) ?? new Set()
      dependents.add(project.name)
      reverse.set(dependency, dependents)
    }
  }
  return { forward, reverse }
}

function sortedNames(values) {
  return [...values].sort((left, right) => left.localeCompare(right))
}

export function dependencyClosure(projects, names) {
  const { forward } = workspaceEdges(projects)
  const known = new Set(projects.map(project => project.name))
  const selected = closure(
    [...names].filter(name => known.has(name)),
    forward
  )
  selected.delete('@bsv/ts-stack')
  return sortedNames(selected)
}

export function mutationTargetProjectNames(projects, targets, ids) {
  const byManifest = new Map(
    projects
      .filter(project => project.path !== '.')
      .map(project => [`${normalized(project.path)}/package.json`, project.name])
  )
  const names = new Set()
  for (const id of ids) {
    const manifest = targets[id]?.manifest
    if (typeof manifest !== 'string') continue
    const name = byManifest.get(normalized(manifest))
    if (name) names.add(name)
  }
  return sortedNames(names)
}

// `narrowed` lists control files whose change was resolved to specific
// projects (`projectPaths`) instead of the whole workspace.
export function selectWorkspaceScope(
  projects,
  changedFiles,
  changedImporters = [],
  { narrowed = [], projectPaths = [] } = {}
) {
  const files = changedFiles.map(normalized).filter(Boolean)
  const nonRootProjects = projects.filter(project => project.path !== '.')
  const full =
    files.some(
      file =>
        (FULL_PACKAGE_CONTROL_PATHS.has(file) && !narrowed.includes(file)) ||
        FULL_PACKAGE_CONTROL_PREFIXES.some(prefix => file.startsWith(prefix))
    ) || changedImporters.includes('.')

  const direct = new Set()
  if (full) {
    for (const project of nonRootProjects) direct.add(project.name)
  } else {
    for (const project of nonRootProjects) {
      if (
        files.some(
          file =>
            projectOwnsFile(project, file) && !documentationOnlyProjectFile(project.path, file)
        ) ||
        projectPaths.includes(project.path)
      ) {
        direct.add(project.name)
      }
    }
    for (const importer of changedImporters) {
      const owner = importerOwner(projects, importer)
      if (owner !== undefined) direct.add(owner.name)
    }
  }

  const { forward, reverse } = workspaceEdges(projects)

  const affected = closure(direct, reverse)
  affected.delete('@bsv/ts-stack')
  const build = closure(affected, forward)
  build.delete('@bsv/ts-stack')

  return {
    direct: sortedNames(direct),
    affected: sortedNames(affected),
    build: sortedNames(build)
  }
}

export function selectInfraComponents(changedFiles) {
  const files = changedFiles.map(normalized).filter(Boolean)
  if (files.some(file => FULL_INFRA_CONTROL_PATHS.has(file))) return INFRA_COMPONENTS
  return INFRA_COMPONENTS.filter(entry =>
    files.some(file => file.startsWith(`infra/${entry.component}/`))
  )
}

export function selectRuntimeComponents(changedFiles) {
  const files = changedFiles.map(normalized).filter(Boolean)
  const full = files.some(file => FULL_RUNTIME_CONTROL_PATHS.has(file))
  if (full) return RUNTIME_COMPONENTS

  const selected = new Set()
  for (const component of RUNTIME_COMPONENTS) {
    if (files.some(file => file.startsWith(`${component.path}/`))) selected.add(component.name)
  }
  if (selected.has('wallet-infra')) {
    for (const component of RUNTIME_COMPONENTS) {
      if (component.wallet) selected.add(component.name)
    }
  }
  return RUNTIME_COMPONENTS.filter(component => selected.has(component.name))
}

export function docsAreAffected(changedFiles) {
  return changedFiles.some(file => {
    const normalizedFile = normalized(file)
    return (
      normalizedFile.startsWith('docs/') ||
      normalizedFile.startsWith('docs-site/') ||
      /(?:^|\/)(?:README|API|CHANGELOG)\.md$/.test(normalizedFile) ||
      normalizedFile === 'scripts/package-documentation.mjs' ||
      normalizedFile === 'scripts/documentation-policy.mjs'
    )
  })
}

export function conformanceIsAffected(changedFiles) {
  return changedFiles.some(file => {
    const normalizedFile = normalized(file)
    return (
      normalizedFile.startsWith('conformance/') ||
      normalizedFile.startsWith('specs/') ||
      normalizedFile === 'scripts/generate-openapi-types.mjs'
    )
  })
}

function parseArguments(arguments_) {
  const result = { all: false, base: '', head: 'HEAD' }
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]
    if (argument === '--all') result.all = true
    else if (argument === '--base') result.base = arguments_[++index] ?? ''
    else if (argument === '--head') result.head = arguments_[++index] ?? ''
    else throw new Error(`Unknown argument: ${argument}`)
  }
  if (result.base === '' && !result.all) throw new Error('--base or --all is required')
  if (result.base !== '' && result.all) throw new Error('--base and --all are mutually exclusive')
  if (result.head === '') throw new Error('--head requires a revision')
  return result
}

function gitText(arguments_) {
  return execFileSync('/usr/bin/git', arguments_, { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
}

// A file missing at the base cannot be narrowed; an empty source fails closed.
function baseText(base, file) {
  try {
    return gitText(['show', `${base}:${file}`])
  } catch {
    return ''
  }
}

function loadProjects() {
  const registry = JSON.parse(
    readFileSync(path.join(REPOSITORY_ROOT, PROJECT_REGISTRY_PATH), 'utf8')
  )
  return registry.projects.map(project => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPOSITORY_ROOT, project.path, 'package.json'), 'utf8')
    )
    return {
      ...project,
      name: manifest.name,
      path: normalized(project.path),
      sourceRoots: (project.sourceRoots ?? []).map(normalized),
      manifest
    }
  })
}

function requiredMutationPackages(projects, base, head) {
  // The classifier imports mutation-testing.mjs, and that module imports this
  // file. Run it in a child process so the cycle stays off module evaluation.
  // Importing it under top-level await also makes Node 24 exit 13.
  const mutation = JSON.parse(
    execFileSync(
      process.execPath,
      [path.join(REPOSITORY_ROOT, 'scripts/ci-mutation-scope.mjs'), '--base', base, '--head', head],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  )
  const targets = buildMutationTargets(REPOSITORY_ROOT)
  return mutationTargetProjectNames(projects, targets, mutation.required)
}

function projectRecords(projects, names) {
  const selected = new Set(names)
  return projects
    .filter(project => selected.has(project.name))
    .map(project => ({ name: project.name, path: path.join(REPOSITORY_ROOT, project.path) }))
    .sort((left, right) => left.name.localeCompare(right.name))
}

function main(arguments_) {
  const { all, base, head } = parseArguments(arguments_)
  const changedFiles = all
    ? gitText(['ls-files']).split(/\r?\n/).filter(Boolean)
    : gitText(['diff', '--name-only', `${base}...${head}`])
        .split(/\r?\n/)
        .filter(Boolean)
  let importers = []
  if (!all && changedFiles.includes('pnpm-lock.yaml')) {
    importers = lockfileAffectedImporters(
      gitText(['show', `${base}:pnpm-lock.yaml`]),
      readFileSync(path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8')
    )
  }
  const narrowed = []
  let projectPaths = []
  if (!all && changedFiles.includes(PROJECT_REGISTRY_PATH)) {
    const registry = projectRegistryChanges(
      baseText(base, PROJECT_REGISTRY_PATH),
      readFileSync(path.join(REPOSITORY_ROOT, PROJECT_REGISTRY_PATH), 'utf8')
    )
    if (!registry.full) {
      narrowed.push(PROJECT_REGISTRY_PATH)
      projectPaths = registry.paths
    }
  }
  if (
    !all &&
    changedFiles.includes('pnpm-workspace.yaml') &&
    workspaceChangeIsResolutionOnly(
      baseText(base, 'pnpm-workspace.yaml'),
      readFileSync(path.join(REPOSITORY_ROOT, 'pnpm-workspace.yaml'), 'utf8')
    )
  ) {
    narrowed.push('pnpm-workspace.yaml')
  }
  const projects = loadProjects()
  const workspace = all
    ? selectWorkspaceScope(projects, ['tsconfig.base.json'])
    : selectWorkspaceScope(projects, changedFiles, importers, { narrowed, projectPaths })
  const buildNames = all
    ? workspace.build
    : dependencyClosure(projects, [
        ...workspace.build,
        ...requiredMutationPackages(projects, base, head)
      ])
  const infrastructure = all ? INFRA_COMPONENTS : selectInfraComponents(changedFiles)
  const runtimeComponents = all ? RUNTIME_COMPONENTS : selectRuntimeComponents(changedFiles)
  const infraEntries = infrastructure.map(entry => ({
    ...entry,
    run: true,
    display: entry.component
  }))

  process.stdout.write(
    JSON.stringify({
      changedFiles,
      changedImporters: importers,
      directProjects: projectRecords(projects, workspace.direct),
      affectedProjects: projectRecords(projects, workspace.affected),
      buildProjects: projectRecords(projects, buildNames),
      infraMatrix: { include: infraEntries },
      runtimeMatrix: {
        include: runtimeComponents.map(component => ({ component }))
      },
      docs: docsAreAffected(changedFiles),
      conformance: conformanceIsAffected(changedFiles)
    })
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
