#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies'
]

const FULL_PACKAGE_CONTROL_PATHS = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'tsconfig.base.json',
  'governance/repository-health/projects.json',
  'scripts/check-browser-package.mjs',
  'scripts/check-package-artifact.mjs',
  'scripts/run-prebuilt-package-script.mjs',
  'scripts/typescript-toolchain.mjs'
])

export const INFRA_COMPONENTS = [
  { component: 'chaintracks-server', 'native-modules': 'better-sqlite3' },
  { component: 'message-box-server', 'native-modules': 'better-sqlite3' },
  { component: 'overlay-server', 'native-modules': '' },
  { component: 'uhrp-server-basic', 'native-modules': '' },
  { component: 'uhrp-server-cloud-bucket', 'native-modules': 'better-sqlite3' },
  { component: 'uhrp-server-cloud-bucket/notifier', 'native-modules': '' },
  { component: 'wab', 'native-modules': 'better-sqlite3 sqlite3' },
  { component: 'wallet-infra', 'native-modules': 'better-sqlite3' }
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
  { name: 'wallet-infra', path: 'infra/wallet-infra', wallet: false }
]

const FULL_INFRA_CONTROL_PATHS = new Set([
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
  const importersIndex = lines.findIndex(line => line === 'importers:')
  if (importersIndex === -1) return sections

  let importer
  let body = []
  const flush = () => {
    if (importer !== undefined) sections.set(importer, body.join('\n'))
  }
  for (let index = importersIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^[^\s]/.test(line) && line !== '') break
    const match = /^  (\S.*):$/.exec(line)
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

function projectOwnsFile(projectPath, file) {
  return projectPath !== '.' && (file === projectPath || file.startsWith(`${projectPath}/`))
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

export function selectWorkspaceScope(projects, changedFiles, changedImporters = []) {
  const files = changedFiles.map(normalized).filter(Boolean)
  const projectNames = new Set(projects.map(project => project.name))
  const nonRootProjects = projects.filter(project => project.path !== '.')
  const full =
    files.some(file => FULL_PACKAGE_CONTROL_PATHS.has(file)) || changedImporters.includes('.')

  const direct = new Set()
  if (full) {
    for (const project of nonRootProjects) direct.add(project.name)
  } else {
    for (const project of nonRootProjects) {
      if (
        files.some(
          file =>
            projectOwnsFile(project.path, file) && !documentationOnlyProjectFile(project.path, file)
        ) ||
        changedImporters.includes(project.path)
      ) {
        direct.add(project.name)
      }
    }
  }

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

  const affected = closure(direct, reverse)
  affected.delete('@bsv/ts-stack')
  const build = closure(affected, forward)
  build.delete('@bsv/ts-stack')

  const sorted = values => [...values].sort((left, right) => left.localeCompare(right))
  return {
    direct: sorted(direct),
    affected: sorted(affected),
    build: sorted(build)
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
  return execFileSync('git', arguments_, { cwd: REPOSITORY_ROOT, encoding: 'utf8' })
}

function loadProjects() {
  const registry = JSON.parse(
    readFileSync(path.join(REPOSITORY_ROOT, 'governance/repository-health/projects.json'), 'utf8')
  )
  return registry.projects.map(project => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPOSITORY_ROOT, project.path, 'package.json'), 'utf8')
    )
    return { name: manifest.name, path: normalized(project.path), manifest }
  })
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
    importers = changedLockfileImporters(
      gitText(['show', `${base}:pnpm-lock.yaml`]),
      readFileSync(path.join(REPOSITORY_ROOT, 'pnpm-lock.yaml'), 'utf8')
    )
  }
  const projects = loadProjects()
  const workspace = all
    ? selectWorkspaceScope(projects, ['tsconfig.base.json'])
    : selectWorkspaceScope(projects, changedFiles, importers)
  const infrastructure = all ? INFRA_COMPONENTS : selectInfraComponents(changedFiles)
  const runtimeComponents = all ? RUNTIME_COMPONENTS : selectRuntimeComponents(changedFiles)
  const infraEntries =
    infrastructure.length === 0
      ? [{ component: '_none', 'native-modules': '', run: false, display: 'no changes' }]
      : infrastructure.map(entry => ({ ...entry, run: true, display: entry.component }))

  process.stdout.write(
    JSON.stringify({
      changedFiles,
      changedImporters: importers,
      directProjects: projectRecords(projects, workspace.direct),
      affectedProjects: projectRecords(projects, workspace.affected),
      buildProjects: projectRecords(projects, workspace.build),
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
