#!/usr/bin/env node

import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'

import { createCommandRunner } from './lib/command-runner.mjs'
import {
  EXPECTED_LICENSE_SHA256,
  LICENSE_FILE,
  LICENSE_VERSION,
  REPOSITORY_ROOT
} from './package-license-policy.mjs'

const ARTIFACT_SCHEMA_VERSION = 1
const CYCLONEDX_SPEC_VERSION = '1.5'
const EXPECTED_REPOSITORY = 'bsv-blockchain/ts-stack'
const EXPECTED_WORKFLOW = '.github/workflows/release.yaml'
const POLICY_PATH = path.join(REPOSITORY_ROOT, 'governance/npm-package-supply-chain.json')
const COMMAND_TIMEOUT_MS = 10 * 60_000
const MAX_BUFFER_BYTES = 64 * 1024 * 1024
const REGISTRY_RETRY_ATTEMPTS = 20
const REGISTRY_RETRY_DELAY_MS = 15_000
const URL_NAMESPACE_UUID = '6ba7b811-9dad-11d1-80b4-00c04fd430c8'
const PACKED_MANIFEST_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta'
]
const execFileAsync = promisify(execFile)
const registryLicenseCache = new Map()
const run = createCommandRunner({
  timeoutMs: COMMAND_TIMEOUT_MS,
  maxBufferBytes: MAX_BUFFER_BYTES,
  maxErrorOutputCharacters: 20_000
})

function posixPath(value) {
  return value.split(path.sep).join('/')
}

function optionValues(arguments_, name) {
  const values = []
  for (let index = 0; index < arguments_.length; index += 1) {
    if (arguments_[index] === name) {
      const value = arguments_[index + 1]
      if (!value || value.startsWith('--')) {
        throw new Error(`${name} requires a value`)
      }
      values.push(value)
      index += 1
    }
  }
  return values
}

function optionValue(arguments_, name, fallback = '') {
  const values = optionValues(arguments_, name)
  if (values.length > 1) throw new Error(`${name} may only be supplied once`)
  return values[0] ?? fallback
}

function packageSlug(name) {
  return name
    .replace(/^@/, '')
    .replaceAll('/', '-')
    .replace(/[^a-z0-9._-]/gi, '-')
    .toLowerCase()
}

function packagePurl(name, version) {
  const encodedName = name.startsWith('@')
    ? `%40${name.slice(1).split('/').map(encodeURIComponent).join('/')}`
    : encodeURIComponent(name)
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`
}

function compareStrings(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function uuidBytes(value) {
  return Buffer.from(value.replaceAll('-', ''), 'hex')
}

export function deterministicUuid(seed) {
  const digest = crypto
    .createHash('sha256')
    .update(uuidBytes(URL_NAMESPACE_UUID))
    .update(seed)
    .digest()
    .subarray(0, 16)
  // RFC 9562 UUID v8 reserves the payload for application-defined data.
  digest[6] = (digest[6] & 0x0f) | 0x80
  digest[8] = (digest[8] & 0x3f) | 0x80
  const hex = digest.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20)
  ].join('-')
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

async function fileDigests(filePath) {
  const value = await fs.readFile(filePath)
  return {
    sha256: sha256(value),
    integrity: `sha512-${crypto.createHash('sha512').update(value).digest('base64')}`,
    size: value.length
  }
}

function parseJson(value, context) {
  try {
    return JSON.parse(value)
  } catch (error) {
    throw new Error(`${context} is not valid JSON: ${error.message}`)
  }
}

function versionParts(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value)
  if (!match) throw new Error(`invalid semantic version ${JSON.stringify(value)}`)
  return match.slice(1).map(Number)
}

function versionAtLeast(actual, minimum) {
  const actualParts = versionParts(actual)
  const minimumParts = versionParts(minimum)
  for (let index = 0; index < actualParts.length; index += 1) {
    if (actualParts[index] !== minimumParts[index]) {
      return actualParts[index] > minimumParts[index]
    }
  }
  return true
}

async function readJson(filePath) {
  return parseJson(await fs.readFile(filePath, 'utf8'), filePath)
}

async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`)
}

function governedProjects(registry) {
  return registry.projects.filter(project => project.release === 'npm-oidc')
}

async function loadGovernedProjects() {
  const registry = await readJson(
    path.join(REPOSITORY_ROOT, 'governance/repository-health/projects.json')
  )
  const projects = governedProjects(registry)
  if (projects.length !== 30) {
    throw new Error(`expected 30 governed npm packages, found ${projects.length}`)
  }
  return await Promise.all(
    projects.map(async project => {
      const directory = path.join(REPOSITORY_ROOT, project.path)
      const manifest = await readJson(path.join(directory, 'package.json'))
      if (manifest.name !== project.name || manifest.private === true) {
        throw new Error(`${project.path} does not match its public package registry entry`)
      }
      return { ...project, directory, manifest }
    })
  )
}

function dependencyNames(project) {
  return new Set([
    ...Object.keys(project.manifest.dependencies ?? {}),
    ...Object.keys(project.manifest.optionalDependencies ?? {}),
    ...Object.keys(project.manifest.peerDependencies ?? {})
  ])
}

export function topologicallyOrderProjects(projects) {
  const byName = new Map(projects.map(project => [project.name, project]))
  const remainingDependencies = new Map(
    projects.map(project => [
      project.name,
      new Set([...dependencyNames(project)].filter(name => byName.has(name)))
    ])
  )
  const ordered = []
  while (remainingDependencies.size > 0) {
    const ready = [...remainingDependencies]
      .filter(([, dependencies]) => dependencies.size === 0)
      .map(([name]) => name)
      .toSorted(compareStrings)
    if (ready.length === 0) {
      const cycleMembers = [...remainingDependencies.keys()].toSorted(compareStrings)
      throw new Error(`npm package dependency cycle: ${cycleMembers.join(', ')}`)
    }
    for (const name of ready) {
      ordered.push(byName.get(name))
      remainingDependencies.delete(name)
      for (const dependencies of remainingDependencies.values()) dependencies.delete(name)
    }
  }
  return ordered
}

function validateRequestedPackages(requested, projects) {
  const byName = new Map(projects.map(project => [project.name, project]))
  const byPath = new Map(projects.map(project => [project.path, project]))
  const selected = []
  for (const request of requested) {
    const normalized = request.replace(/^\.\//, '').replace(/\/$/, '')
    const project = byName.get(request) ?? byPath.get(normalized)
    if (!project) throw new Error(`unknown governed npm package ${JSON.stringify(request)}`)
    if (!selected.includes(project)) selected.push(project)
  }
  return selected
}

async function projectsForFilter(filter, projects) {
  const arguments_ = ['--recursive']
  if (filter) arguments_.push('--filter', filter)
  arguments_.push('list', '--depth=-1', '--json')
  const { stdout } = await run('pnpm', arguments_, { cwd: REPOSITORY_ROOT })
  const selectedNames = new Set(
    parseJson(stdout, 'pnpm workspace selection')
      .filter(item => item.private !== true)
      .map(item => item.name)
  )
  const governedNames = new Set(projects.map(project => project.name))
  const unknown = [...selectedNames].filter(name => !governedNames.has(name))
  if (unknown.length > 0) {
    throw new Error(
      `pnpm selected ungoverned public packages: ${unknown.toSorted(compareStrings).join(', ')}`
    )
  }
  return projects.filter(project => selectedNames.has(project.name))
}

async function registryMetadata(name, version) {
  try {
    const { stdout } = await execFileAsync(
      'npm',
      ['view', `${name}@${version}`, 'name', 'version', 'dist.integrity', '--json'],
      {
        cwd: REPOSITORY_ROOT,
        encoding: 'utf8',
        maxBuffer: 2 * 1024 * 1024,
        timeout: 60_000
      }
    )
    const metadata = parseJson(stdout, `npm registry metadata for ${name}@${version}`)
    return {
      published: true,
      name: metadata.name,
      version: metadata.version,
      integrity: metadata['dist.integrity']
    }
  } catch (error) {
    const details = `${error.stderr ?? ''}\n${error.stdout ?? ''}\n${error.message ?? ''}`
    if (/\bE404\b|404 Not Found/i.test(details)) return { published: false }
    throw new Error(`could not query npm for ${name}@${version}: ${details.trim()}`)
  }
}

async function mapWithConcurrency(items, concurrency, operation) {
  const results = Array.from({ length: items.length })
  let nextIndex = 0
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      results[index] = await operation(items[index], index)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker())
  )
  return results
}

async function unpublishedProjects(projects) {
  const metadata = await mapWithConcurrency(projects, 8, project =>
    registryMetadata(project.name, project.manifest.version)
  )
  return projects.filter((_, index) => !metadata[index].published)
}

async function ensureEmptyOutputDirectory(outputDirectory) {
  try {
    const entries = await fs.readdir(outputDirectory)
    if (entries.length > 0) {
      throw new Error(`output directory must be empty: ${outputDirectory}`)
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await fs.mkdir(outputDirectory, { recursive: true })
  }
}

function validatePackResult(packResult, project) {
  const errors = []
  if (packResult.name !== project.name) {
    errors.push(`packed name ${packResult.name} does not match ${project.name}`)
  }
  if (packResult.version !== project.manifest.version) {
    errors.push(`packed version ${packResult.version} does not match ${project.manifest.version}`)
  }
  const files = packResult.files?.map(file => file.path) ?? []
  for (const required of [LICENSE_FILE, 'package.json']) {
    if (files.filter(file => file === required).length !== 1) {
      errors.push(`tarball must contain exactly one root ${required}`)
    }
  }
  if (!files.some(file => /^readme(?:\.[^.]+)?$/i.test(file))) {
    errors.push('tarball must contain a root README')
  }
  if (errors.length > 0) throw new Error(`${project.name}: ${errors.join('; ')}`)
}

export function canonicalizePackedManifest(manifest) {
  const canonical = structuredClone(manifest)
  for (const field of PACKED_MANIFEST_DEPENDENCY_FIELDS) {
    const entries = Object.entries(canonical[field] ?? {})
    if (entries.length > 0) {
      canonical[field] = Object.fromEntries(
        entries.toSorted(([left], [right]) => compareStrings(left, right))
      )
    }
  }
  return canonical
}

function packedFilePaths(packResult) {
  return (packResult.files ?? []).map(file => file.path).toSorted(compareStrings)
}

async function packDirectory(directory, destination, project) {
  const { stdout } = await run('pnpm', ['pack', '--json', '--pack-destination', destination], {
    cwd: directory,
    env: { ...process.env, npm_config_ignore_scripts: 'true' }
  })
  const packResult = parseJson(stdout, `pnpm pack result for ${project.name}`)
  validatePackResult(packResult, project)
  const tarballPath = path.resolve(directory, packResult.filename)
  if (path.dirname(tarballPath) !== destination) {
    throw new Error(`${project.name} packed outside ${destination}`)
  }
  return { packResult, tarballPath }
}

async function stageTarball(project, packagesDirectory) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-stack-npm-pack-'))
  try {
    const provisionalDirectory = path.join(temporaryDirectory, 'provisional')
    const extractedDirectory = path.join(temporaryDirectory, 'extracted')
    await Promise.all([
      fs.mkdir(provisionalDirectory, { recursive: true }),
      fs.mkdir(extractedDirectory, { recursive: true })
    ])
    const provisional = await packDirectory(project.directory, provisionalDirectory, project)
    await run('tar', ['-xzf', provisional.tarballPath, '-C', extractedDirectory], {
      cwd: REPOSITORY_ROOT
    })
    const packageDirectory = path.join(extractedDirectory, 'package')
    const manifestPath = path.join(packageDirectory, 'package.json')
    await writeJson(manifestPath, canonicalizePackedManifest(await readJson(manifestPath)))
    const staged = await packDirectory(packageDirectory, packagesDirectory, project)
    if (
      JSON.stringify(packedFilePaths(staged.packResult)) !==
      JSON.stringify(packedFilePaths(provisional.packResult))
    ) {
      throw new Error(`${project.name} canonical staging changed the publishable file set`)
    }
    const digests = await fileDigests(staged.tarballPath)
    if (staged.packResult.integrity && staged.packResult.integrity !== digests.integrity) {
      throw new Error(`${project.name} pack metadata does not match the staged tarball`)
    }
    return {
      project,
      tarballPath: staged.tarballPath,
      tarball: posixPath(path.relative(path.dirname(packagesDirectory), staged.tarballPath)),
      ...digests
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function runtimeDependencyNames(manifest) {
  return [
    ...new Set(
      ['dependencies', 'optionalDependencies', 'peerDependencies'].flatMap(field =>
        Object.keys(manifest[field] ?? {})
      )
    )
  ].toSorted(compareStrings)
}

function stagedRuntimeClosure(manifest, stagedByName) {
  const queued = runtimeDependencyNames(manifest)
  const visited = new Set()
  const closure = new Set()
  while (queued.length > 0) {
    const name = queued.shift()
    if (visited.has(name)) continue
    visited.add(name)
    if (name === manifest.name) continue
    const staged = stagedByName.get(name)
    if (!staged) continue
    closure.add(name)
    queued.push(...runtimeDependencyNames(staged.project.manifest))
    queued.sort(compareStrings)
  }
  return [...closure].toSorted(compareStrings)
}

function rewriteDirectStagedDependencies(manifest, stagedByName) {
  for (const field of ['dependencies', 'optionalDependencies']) {
    if (!manifest[field]) continue
    for (const name of Object.keys(manifest[field])) {
      const staged = stagedByName.get(name)
      if (staged) manifest[field][name] = `file:${staged.tarballPath}`
    }
  }
}

function promotePeerDependencies(manifest, stagedByName) {
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (manifest.dependencies?.[name] || manifest.optionalDependencies?.[name]) continue
    const field = manifest.peerDependenciesMeta?.[name]?.optional
      ? 'optionalDependencies'
      : 'dependencies'
    manifest[field] ??= {}
    const staged = stagedByName.get(name)
    manifest[field][name] = staged ? `file:${staged.tarballPath}` : range
  }
}

function injectStagedClosure(manifest, stagedByName, injectedNames) {
  for (const name of injectedNames) {
    manifest.dependencies ??= {}
    manifest.dependencies[name] = `file:${stagedByName.get(name).tarballPath}`
  }
}

export function prepareSbomManifest(manifest, stagedByName) {
  const rewritten = structuredClone(manifest)
  rewriteDirectStagedDependencies(rewritten, stagedByName)
  promotePeerDependencies(rewritten, stagedByName)
  const directRuntimeNames = new Set(runtimeDependencyNames(manifest))
  const stagedClosure = stagedRuntimeClosure(manifest, stagedByName)
  const injectedNames = stagedClosure.filter(name => !directRuntimeNames.has(name))
  injectStagedClosure(rewritten, stagedByName, injectedNames)
  delete rewritten.devDependencies
  delete rewritten.scripts
  return { manifest: rewritten, injectedNames, stagedNames: stagedClosure }
}

function lockfilePackageName(location) {
  return location.match(/(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)$/)?.[1]
}

export function validateStagedLockfile(lockfile, stagedByName, stagedNames) {
  const expected = new Set(stagedNames)
  const locallyResolved = new Set()
  for (const [location, installed] of Object.entries(lockfile.packages ?? {})) {
    const name = lockfilePackageName(location)
    if (!expected.has(name)) continue
    const staged = stagedByName.get(name)
    const linkedPackage =
      installed.link === true && typeof installed.resolved === 'string'
        ? lockfile.packages?.[installed.resolved]
        : undefined
    const installedVersion = linkedPackage?.version ?? installed.version
    const resolvedLocally =
      Boolean(linkedPackage) ||
      (typeof installed.resolved === 'string' && installed.resolved.startsWith('file:'))
    if (installedVersion !== staged.project.manifest.version || !resolvedLocally) {
      throw new Error(`${name} resolved outside its staged tarball at ${location}`)
    }
    locallyResolved.add(name)
  }
  for (const name of expected) {
    if (!locallyResolved.has(name)) {
      throw new Error(`${name} is missing from the staged package lockfile`)
    }
  }
}

function normalizeRootComponent(component, record, manifest) {
  const properties = (component.properties ?? []).filter(
    property => !property.name.startsWith('org.bsvblockchain.')
  )
  const peerDependencies = Object.entries(manifest.peerDependencies ?? {}).toSorted(
    ([left], [right]) => compareStrings(left, right)
  )
  for (const [name, value] of peerDependencies) {
    properties.push({
      name: 'org.bsvblockchain.npm.peer-dependency',
      value: `${name}@${value}`
    })
  }
  properties.push(
    { name: 'org.bsvblockchain.source.path', value: record.project.path },
    { name: 'org.bsvblockchain.artifact.path', value: record.tarball },
    { name: 'org.bsvblockchain.artifact.sha512', value: record.integrity }
  )
  return {
    ...component,
    'bom-ref': `${manifest.name}@${manifest.version}`,
    name: manifest.name,
    version: manifest.version,
    purl: packagePurl(manifest.name, manifest.version),
    hashes: [{ alg: 'SHA-256', content: record.sha256 }],
    licenses: [
      {
        license: {
          name: `Open BSV License Version ${LICENSE_VERSION}`
        }
      }
    ],
    properties
  }
}

function normalizeBomDependencyRefs(bom, originalRootRef, normalizedRootRef) {
  return (bom.dependencies ?? []).map(dependency => ({
    ref: dependency.ref === originalRootRef ? normalizedRootRef : dependency.ref,
    dependsOn: (dependency.dependsOn ?? []).map(reference =>
      reference === originalRootRef ? normalizedRootRef : reference
    )
  }))
}

export function removeInjectedRootDependencies(dependencies, rootRef, injectedReferences) {
  if (injectedReferences.size === 0) return dependencies
  return dependencies.map(dependency =>
    dependency.ref === rootRef
      ? {
          ...dependency,
          dependsOn: (dependency.dependsOn ?? []).filter(
            reference => !injectedReferences.has(reference)
          )
        }
      : dependency
  )
}

function normalizeGovernedComponentLicenses(components, governedNames, internalLicense) {
  return components.map(component =>
    governedNames.has(component.name)
      ? {
          ...component,
          licenses: [{ license: { name: internalLicense } }]
        }
      : component
  )
}

export function removeLocalFileReferences(components) {
  return components.map(component => {
    const existingReferences = component.externalReferences ?? []
    const externalReferences = existingReferences.filter(
      reference => typeof reference.url !== 'string' || !reference.url.startsWith('file:')
    )
    if (externalReferences.length === existingReferences.length) return component
    const sanitized = { ...component }
    if (externalReferences.length > 0) sanitized.externalReferences = externalReferences
    else delete sanitized.externalReferences
    return sanitized
  })
}

function normalizedRegistryLicenses(metadata) {
  const values = []
  const add = value => {
    if (typeof value === 'string' && value.trim()) values.push(value.trim())
    else if (value && typeof value === 'object') add(value.type ?? value.name)
  }
  if (Array.isArray(metadata)) {
    for (const license of metadata) add(license)
  } else if (typeof metadata === 'string') {
    add(metadata)
  } else {
    add(metadata.license)
    for (const license of Array.isArray(metadata.licenses) ? metadata.licenses : []) add(license)
  }
  return [...new Set(values)].toSorted(compareStrings)
}

async function registryLicenses(name, version) {
  const key = `${name}@${version}`
  if (!registryLicenseCache.has(key)) {
    registryLicenseCache.set(
      key,
      (async () => {
        const { stdout } = await run('npm', ['view', key, 'license', 'licenses', '--json'], {
          cwd: REPOSITORY_ROOT
        })
        if (!stdout.trim()) return []
        return normalizedRegistryLicenses(parseJson(stdout, `npm license metadata for ${key}`))
      })()
    )
  }
  return await registryLicenseCache.get(key)
}

async function supplementRegistryLicenses(components) {
  return await mapWithConcurrency(components, 8, async component => {
    if (componentLicenseValues(component).length > 0) return component
    if (!component.name || !component.version) return component
    const licenses = await registryLicenses(component.name, component.version)
    if (licenses.length === 0) return component
    return {
      ...component,
      licenses: licenses.map(value => ({
        license: /^[A-Za-z0-9-.+]+$/.test(value) ? { id: value } : { name: value }
      })),
      properties: [
        ...(component.properties ?? []),
        {
          name: 'org.bsvblockchain.license.metadata-source',
          value: 'npm-registry'
        }
      ]
    }
  })
}

async function generatePackageSbom(
  record,
  stagedByName,
  sbomDirectory,
  source,
  governedNames,
  internalLicense
) {
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ts-stack-npm-sbom-'))
  try {
    await run('tar', ['-xzf', record.tarballPath, '-C', temporaryDirectory], {
      cwd: REPOSITORY_ROOT
    })
    const packageDirectory = path.join(temporaryDirectory, 'package')
    const manifestPath = path.join(packageDirectory, 'package.json')
    const manifest = await readJson(manifestPath)
    if (
      manifest.name !== record.project.name ||
      manifest.version !== record.project.manifest.version
    ) {
      throw new Error(`${record.project.name} staged package identity changed after extraction`)
    }
    const licenseDigest = sha256(await fs.readFile(path.join(packageDirectory, LICENSE_FILE)))
    if (licenseDigest !== EXPECTED_LICENSE_SHA256) {
      throw new Error(
        `${record.project.name} tarball does not contain the canonical Open BSV license`
      )
    }

    const preparedManifest = prepareSbomManifest(manifest, stagedByName)
    await writeJson(manifestPath, preparedManifest.manifest)
    await run(
      'npm',
      [
        'install',
        '--package-lock-only',
        '--ignore-scripts',
        '--omit=dev',
        '--no-audit',
        '--no-fund'
      ],
      { cwd: packageDirectory }
    )
    validateStagedLockfile(
      await readJson(path.join(packageDirectory, 'package-lock.json')),
      stagedByName,
      preparedManifest.stagedNames
    )
    const { stdout } = await run(
      'npm',
      [
        'sbom',
        '--package-lock-only',
        '--omit=dev',
        '--sbom-format=cyclonedx',
        '--sbom-type=library'
      ],
      { cwd: packageDirectory }
    )
    const bom = parseJson(stdout, `CycloneDX SBOM for ${record.project.name}`)
    if (bom.bomFormat !== 'CycloneDX' || bom.specVersion !== CYCLONEDX_SPEC_VERSION) {
      throw new Error(`${record.project.name} produced an unsupported CycloneDX document`)
    }
    const originalRootRef = bom.metadata?.component?.['bom-ref']
    const rootComponent = normalizeRootComponent(bom.metadata?.component ?? {}, record, manifest)
    const normalizedComponents = removeLocalFileReferences(
      normalizeGovernedComponentLicenses(bom.components ?? [], governedNames, internalLicense)
    )
    const injectedNames = new Set(preparedManifest.injectedNames)
    const injectedReferences = new Set(
      normalizedComponents
        .filter(
          component =>
            injectedNames.has(component.name) &&
            component.version === stagedByName.get(component.name)?.project.manifest.version
        )
        .map(component => component['bom-ref'])
        .filter(Boolean)
    )
    const normalized = {
      ...bom,
      serialNumber: `urn:uuid:${deterministicUuid(
        `${record.project.name}@${manifest.version}:${record.sha256}`
      )}`,
      metadata: {
        ...bom.metadata,
        timestamp: source.created,
        component: rootComponent
      },
      components: await supplementRegistryLicenses(normalizedComponents),
      dependencies: removeInjectedRootDependencies(
        normalizeBomDependencyRefs(bom, originalRootRef, rootComponent['bom-ref']),
        rootComponent['bom-ref'],
        injectedReferences
      )
    }
    const sbomPath = path.join(sbomDirectory, `${packageSlug(record.project.name)}.cdx.json`)
    await writeJson(sbomPath, normalized)
    const sbomDigests = await fileDigests(sbomPath)
    return {
      ...record,
      rootBomRef: rootComponent['bom-ref'],
      sbomPath,
      sbom: posixPath(path.relative(path.dirname(sbomDirectory), sbomPath)),
      sbomSha256: sbomDigests.sha256,
      sbomSize: sbomDigests.size,
      bom: normalized
    }
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function componentLicenseValues(component) {
  return (component.licenses ?? [])
    .flatMap(item => [item.expression, item.license?.id, item.license?.name])
    .filter(value => typeof value === 'string' && value.trim() !== '')
}

export function createLicenseInventory(aggregate, policy) {
  const denied = policy.licensePolicy.denied.map(item => ({
    ...item,
    expression: new RegExp(item.pattern, 'i')
  }))
  const components = aggregate.components.map(component => {
    const licenses = [...new Set(componentLicenseValues(component))].toSorted(compareStrings)
    const findings = []
    if (licenses.length === 0 && policy.licensePolicy.requireDeclaredLicense) {
      findings.push({
        severity: 'HIGH',
        reason: 'missing license declaration',
        license: null
      })
    }
    for (const license of licenses) {
      for (const rule of denied) {
        if (rule.expression.test(license)) {
          findings.push({
            severity: rule.severity,
            reason: rule.reason,
            license
          })
        }
      }
    }
    return {
      bomRef: component['bom-ref'],
      name: component.name,
      version: component.version ?? null,
      licenses,
      findings
    }
  })
  const findings = components.flatMap(component =>
    component.findings.map(finding => ({
      component: component.bomRef,
      ...finding
    }))
  )
  return {
    schemaVersion: 1,
    componentCount: components.length,
    components,
    findings
  }
}

function mergeComponent(existing, incoming) {
  if (!existing) return incoming
  const hashes = new Map(
    [...(existing.hashes ?? []), ...(incoming.hashes ?? [])].map(hash => [
      `${hash.alg}:${hash.content}`,
      hash
    ])
  )
  const licenses = new Map(
    [...(existing.licenses ?? []), ...(incoming.licenses ?? [])].map(license => [
      JSON.stringify(license),
      license
    ])
  )
  return {
    ...existing,
    ...incoming,
    ...(hashes.size > 0 ? { hashes: [...hashes.values()] } : {}),
    ...(licenses.size > 0 ? { licenses: [...licenses.values()] } : {})
  }
}

export function mergeCycloneDxDocuments(records, source) {
  const components = new Map()
  const dependencyMap = new Map()
  for (const record of records) {
    for (const component of [record.bom.metadata.component, ...(record.bom.components ?? [])]) {
      const reference = component['bom-ref']
      if (!reference) throw new Error('CycloneDX component is missing bom-ref')
      components.set(reference, mergeComponent(components.get(reference), component))
    }
    for (const dependency of record.bom.dependencies ?? []) {
      if (!dependencyMap.has(dependency.ref)) dependencyMap.set(dependency.ref, new Set())
      for (const reference of dependency.dependsOn ?? []) {
        dependencyMap.get(dependency.ref).add(reference)
      }
    }
  }

  const releaseReference = `pkg:github/${EXPECTED_REPOSITORY}@${source.commit}`
  dependencyMap.set(releaseReference, new Set(records.map(record => record.rootBomRef)))
  const seed = records
    .map(record => `${record.project.name}:${record.sha256}`)
    .toSorted(compareStrings)
    .join('\n')
  const releaseUuidSeed = `${source.commit}\n${seed}`
  return {
    bomFormat: 'CycloneDX',
    specVersion: CYCLONEDX_SPEC_VERSION,
    serialNumber: `urn:uuid:${deterministicUuid(releaseUuidSeed)}`,
    version: 1,
    metadata: {
      timestamp: source.created,
      tools: [
        {
          vendor: 'npm, Inc.',
          name: 'npm',
          version: source.npm
        },
        {
          vendor: 'BSV Blockchain Association',
          name: 'ts-stack package-release-artifacts',
          version: String(ARTIFACT_SCHEMA_VERSION)
        }
      ],
      component: {
        'bom-ref': releaseReference,
        type: 'application',
        group: 'bsv-blockchain',
        name: 'ts-stack npm release',
        version: source.commit,
        purl: releaseReference,
        externalReferences: [
          {
            type: 'vcs',
            url: `https://github.com/${EXPECTED_REPOSITORY}/tree/${source.commit}`
          }
        ]
      }
    },
    components: [...components.values()].sort((left, right) =>
      left['bom-ref'].localeCompare(right['bom-ref'])
    ),
    dependencies: [...dependencyMap]
      .map(([ref, dependsOn]) => ({
        ref,
        dependsOn: [...dependsOn].toSorted(compareStrings)
      }))
      .sort((left, right) => left.ref.localeCompare(right.ref))
  }
}

export function validateBuildRuntime(source, policy) {
  if (source.node !== `v${policy.buildRuntime.node}`) {
    throw new Error(
      `Node.js ${source.node} does not match release policy v${policy.buildRuntime.node}`
    )
  }
  if (!versionAtLeast(source.npm, policy.buildRuntime.npmMinimum)) {
    throw new Error(
      `npm ${source.npm} is below trusted publishing minimum ${policy.buildRuntime.npmMinimum}`
    )
  }
  if (source.pnpm !== policy.buildRuntime.pnpm) {
    throw new Error(`pnpm ${source.pnpm} does not match release policy ${policy.buildRuntime.pnpm}`)
  }
}

async function sourceMetadata(policy) {
  const [{ stdout: commit }, { stdout: created }, { stdout: npm }, { stdout: pnpm }] =
    await Promise.all([
      run('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT }),
      run('git', ['show', '-s', '--format=%cI', 'HEAD'], { cwd: REPOSITORY_ROOT }),
      run('npm', ['--version'], { cwd: REPOSITORY_ROOT }),
      run('pnpm', ['--version'], { cwd: REPOSITORY_ROOT })
    ])
  const source = {
    repository: EXPECTED_REPOSITORY,
    commit: commit.trim(),
    created: created.trim(),
    node: process.version,
    npm: npm.trim(),
    pnpm: pnpm.trim()
  }
  validateBuildRuntime(source, policy)
  return source
}

function manifestPackage(record) {
  return {
    name: record.project.name,
    version: record.project.manifest.version,
    sourcePath: record.project.path,
    tarball: record.tarball,
    sha256: record.sha256,
    integrity: record.integrity,
    size: record.size,
    sbom: record.sbom,
    sbomSha256: record.sbomSha256,
    sbomSize: record.sbomSize
  }
}

async function appendGitHubOutput(name, value) {
  if (!process.env.GITHUB_OUTPUT) return
  await fs.appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}\n`)
}

async function stageArtifacts(arguments_) {
  const outputOption = optionValue(arguments_, '--output')
  if (!outputOption) throw new Error('stage requires --output')
  const outputDirectory = path.resolve(REPOSITORY_ROOT, outputOption)
  const filter = optionValue(arguments_, '--filter')
  const requested = optionValues(arguments_, '--package')
  if (filter && requested.length > 0) {
    throw new Error('--filter and --package cannot be used together')
  }
  const [governed, policy] = await Promise.all([loadGovernedProjects(), readJson(POLICY_PATH)])
  const source = await sourceMetadata(policy)
  await ensureEmptyOutputDirectory(outputDirectory)
  const governedNames = new Set(governed.map(project => project.name))
  let candidates
  if (requested.length > 0) {
    candidates = validateRequestedPackages(requested, governed)
  } else if (filter) {
    candidates = await projectsForFilter(filter, governed)
  } else {
    candidates = governed
  }
  const selected = arguments_.includes('--include-published')
    ? candidates
    : await unpublishedProjects(candidates)
  const ordered = topologicallyOrderProjects(selected)
  const packagesDirectory = path.join(outputDirectory, 'packages')
  const sbomDirectory = path.join(outputDirectory, 'sbom')
  await Promise.all([
    fs.mkdir(packagesDirectory, { recursive: true }),
    fs.mkdir(sbomDirectory, { recursive: true })
  ])

  const stagedTarballs = []
  for (const project of ordered) {
    stagedTarballs.push(await stageTarball(project, packagesDirectory))
  }
  const stagedByName = new Map(stagedTarballs.map(record => [record.project.name, record]))
  const records = await mapWithConcurrency(stagedTarballs, 4, record =>
    generatePackageSbom(
      record,
      stagedByName,
      sbomDirectory,
      source,
      governedNames,
      policy.licensePolicy.internalLicense
    )
  )
  const aggregate = mergeCycloneDxDocuments(records, source)
  const aggregatePath = path.join(outputDirectory, 'release.cdx.json')
  await writeJson(aggregatePath, aggregate)
  const aggregateDigests = await fileDigests(aggregatePath)
  const licenseInventory = {
    ...createLicenseInventory(aggregate, policy),
    sourceCommit: source.commit
  }
  if (licenseInventory.findings.length > 0) {
    throw new Error(
      `npm release license policy rejected ${licenseInventory.findings.length} finding(s):\n` +
        licenseInventory.findings
          .map(
            finding =>
              `${finding.severity} ${finding.component}: ${finding.reason}` +
              (finding.license ? ` (${finding.license})` : '')
          )
          .join('\n')
    )
  }
  const licenseInventoryPath = path.join(outputDirectory, 'licenses.json')
  await writeJson(licenseInventoryPath, licenseInventory)
  const licenseInventoryDigests = await fileDigests(licenseInventoryPath)
  const checksumLines = records.map(record => `${record.sha256} *${record.tarball}`)
  await fs.writeFile(
    path.join(outputDirectory, 'checksums.sha256'),
    checksumLines.length > 0 ? `${checksumLines.join('\n')}\n` : ''
  )
  const manifest = {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    source,
    selection: {
      filter: filter || null,
      requestedPackages: requested,
      includePublished: arguments_.includes('--include-published'),
      candidateCount: candidates.length,
      artifactCount: records.length
    },
    aggregateSbom: {
      path: 'release.cdx.json',
      sha256: aggregateDigests.sha256,
      size: aggregateDigests.size,
      format: 'CycloneDX',
      specVersion: CYCLONEDX_SPEC_VERSION
    },
    licenseInventory: {
      path: 'licenses.json',
      sha256: licenseInventoryDigests.sha256,
      size: licenseInventoryDigests.size,
      componentCount: licenseInventory.componentCount
    },
    checksums: 'checksums.sha256',
    packages: records.map(manifestPackage)
  }
  const manifestPath = path.join(outputDirectory, 'manifest.json')
  await writeJson(manifestPath, manifest)
  await appendGitHubOutput('count', records.length)
  await appendGitHubOutput('manifest', posixPath(path.relative(REPOSITORY_ROOT, manifestPath)))
  console.log(
    `Staged ${records.length} exact npm release artifact(s) from ` +
      `${candidates.length} candidate package(s) in ${outputDirectory}.`
  )
  for (const record of records) {
    console.log(`  ${record.project.name}@${record.project.manifest.version} ${record.sha256}`)
  }
  return manifest
}

export function validateRelativeArtifactPath(value) {
  if (
    typeof value !== 'string' ||
    value === '' ||
    path.isAbsolute(value) ||
    value.includes('\\') ||
    value.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`invalid release artifact path ${JSON.stringify(value)}`)
  }
  return value
}

function resolveArtifactPath(root, relative) {
  validateRelativeArtifactPath(relative)
  const resolved = path.resolve(root, relative)
  if (path.relative(root, resolved).startsWith('..')) {
    throw new Error(`artifact escapes release root: ${relative}`)
  }
  return resolved
}

async function verifyDigest(filePath, expected, description) {
  const actual = await fileDigests(filePath)
  if (actual.sha256 !== expected) {
    throw new Error(
      `${description} SHA-256 mismatch: expected ${expected}, received ${actual.sha256}`
    )
  }
  return actual
}

function validateManifestEnvelope(manifest, currentCommit, policy) {
  if (manifest.schemaVersion !== ARTIFACT_SCHEMA_VERSION) {
    throw new Error(`unsupported release artifact schema ${manifest.schemaVersion}`)
  }
  if (manifest.source?.repository !== EXPECTED_REPOSITORY) {
    throw new Error(`unexpected source repository ${manifest.source?.repository}`)
  }
  if (manifest.source.commit !== currentCommit) {
    throw new Error(
      `release source ${manifest.source.commit} does not match checked-out commit ${currentCommit}`
    )
  }
  validateBuildRuntime(manifest.source, policy)
}

function addUniqueValue(values, value, description) {
  if (values.has(value)) throw new Error(`duplicate ${description} ${value}`)
  values.add(value)
}

function validateGovernedPackage(item, governedByName) {
  const governedProject = governedByName.get(item.name)
  if (
    !governedProject ||
    governedProject.path !== item.sourcePath ||
    governedProject.manifest.version !== item.version
  ) {
    throw new Error(
      `${item.name}@${item.version} is not the governed package at ${item.sourcePath}`
    )
  }
}

function validatePackedManifest(item, packedManifest) {
  if (
    packedManifest.name !== item.name ||
    packedManifest.version !== item.version ||
    packedManifest.private === true ||
    packedManifest.publishConfig?.access !== 'public'
  ) {
    throw new Error(`${item.tarball} has an invalid publish identity or access policy`)
  }
  const runtimeSpecifications = ['dependencies', 'optionalDependencies', 'peerDependencies']
    .flatMap(field => Object.values(packedManifest[field] ?? {}))
    .filter(specification => typeof specification === 'string')
  if (runtimeSpecifications.some(specification => specification.startsWith('workspace:'))) {
    throw new Error(`${item.tarball} retains an unresolved workspace dependency`)
  }
}

async function verifyPackageArtifact(item, context) {
  const { governedByName, names, releaseRoot, sboms, tarballs } = context
  validateGovernedPackage(item, governedByName)
  addUniqueValue(names, item.name, 'package')
  addUniqueValue(tarballs, item.tarball, 'tarball')
  addUniqueValue(sboms, item.sbom, 'package SBOM')

  const tarballPath = resolveArtifactPath(releaseRoot, item.tarball)
  const tarballDigest = await verifyDigest(tarballPath, item.sha256, item.tarball)
  if (tarballDigest.integrity !== item.integrity || tarballDigest.size !== item.size) {
    throw new Error(`${item.tarball} digest metadata does not match`)
  }

  const [{ stdout: packedManifestSource }, { stdout: packedLicense }] = await Promise.all([
    run('tar', ['-xOf', tarballPath, 'package/package.json'], { cwd: releaseRoot }),
    run('tar', ['-xOf', tarballPath, `package/${LICENSE_FILE}`], { cwd: releaseRoot })
  ])
  const packedManifest = parseJson(packedManifestSource, `${item.tarball} package manifest`)
  validatePackedManifest(item, packedManifest)
  if (sha256(Buffer.from(packedLicense)) !== EXPECTED_LICENSE_SHA256) {
    throw new Error(`${item.tarball} does not contain the canonical Open BSV license`)
  }

  const sbomPath = resolveArtifactPath(releaseRoot, item.sbom)
  const sbomDigest = await verifyDigest(sbomPath, item.sbomSha256, item.sbom)
  if (sbomDigest.size !== item.sbomSize) {
    throw new Error(`${item.sbom} size does not match`)
  }
  const bom = await readJson(sbomPath)
  if (
    bom.bomFormat !== 'CycloneDX' ||
    bom.specVersion !== CYCLONEDX_SPEC_VERSION ||
    bom.metadata?.component?.purl !== packagePurl(item.name, item.version)
  ) {
    throw new Error(`${item.sbom} does not describe ${item.name}@${item.version}`)
  }
  return `${item.sha256} *${item.tarball}`
}

async function verifyAggregateSbom(manifest, releaseRoot, policy) {
  const aggregatePath = resolveArtifactPath(releaseRoot, manifest.aggregateSbom.path)
  const aggregateDigest = await verifyDigest(
    aggregatePath,
    manifest.aggregateSbom.sha256,
    manifest.aggregateSbom.path
  )
  if (aggregateDigest.size !== manifest.aggregateSbom.size) {
    throw new Error('aggregate SBOM size does not match')
  }
  const aggregate = await readJson(aggregatePath)
  if (aggregate.bomFormat !== 'CycloneDX' || aggregate.specVersion !== CYCLONEDX_SPEC_VERSION) {
    throw new Error('aggregate SBOM format does not match policy')
  }
  const expectedLicenseInventory = {
    ...createLicenseInventory(aggregate, policy),
    sourceCommit: manifest.source.commit
  }
  if (expectedLicenseInventory.findings.length > 0) {
    throw new Error('aggregate SBOM violates the npm release license policy')
  }
  return expectedLicenseInventory
}

async function verifyLicenseInventory(manifest, releaseRoot, expectedLicenseInventory) {
  const licenseInventoryPath = resolveArtifactPath(releaseRoot, manifest.licenseInventory.path)
  const licenseInventoryDigest = await verifyDigest(
    licenseInventoryPath,
    manifest.licenseInventory.sha256,
    manifest.licenseInventory.path
  )
  if (
    licenseInventoryDigest.size !== manifest.licenseInventory.size ||
    manifest.licenseInventory.componentCount !== expectedLicenseInventory.componentCount
  ) {
    throw new Error('license inventory metadata does not match')
  }
  const actualLicenseInventory = await readJson(licenseInventoryPath)
  if (JSON.stringify(actualLicenseInventory) !== JSON.stringify(expectedLicenseInventory)) {
    throw new Error('license inventory does not exactly match the aggregate SBOM')
  }
}

async function verifyChecksumFile(manifest, releaseRoot, checksumLines) {
  const checksumPath = resolveArtifactPath(releaseRoot, manifest.checksums)
  const expectedChecksums = checksumLines.length > 0 ? `${checksumLines.join('\n')}\n` : ''
  const actualChecksums = await fs.readFile(checksumPath, 'utf8')
  if (actualChecksums !== expectedChecksums) {
    throw new Error('checksums.sha256 does not exactly match the package manifest')
  }
}

async function verifyArtifacts(manifestOption) {
  if (!manifestOption) throw new Error('verify requires a manifest path')
  const manifestPath = path.resolve(REPOSITORY_ROOT, manifestOption)
  const releaseRoot = path.dirname(manifestPath)
  const manifest = await readJson(manifestPath)
  const [{ stdout: currentCommit }, governed, policy] = await Promise.all([
    run('git', ['rev-parse', 'HEAD'], { cwd: REPOSITORY_ROOT }),
    loadGovernedProjects(),
    readJson(POLICY_PATH)
  ])
  validateManifestEnvelope(manifest, currentCommit.trim(), policy)

  const context = {
    governedByName: new Map(governed.map(project => [project.name, project])),
    names: new Set(),
    releaseRoot,
    sboms: new Set(),
    tarballs: new Set()
  }
  const checksumLines = []
  for (const item of manifest.packages ?? []) {
    checksumLines.push(await verifyPackageArtifact(item, context))
  }
  if (manifest.selection?.artifactCount !== context.names.size) {
    throw new Error('manifest artifact count does not match package records')
  }
  const expectedLicenseInventory = await verifyAggregateSbom(manifest, releaseRoot, policy)
  await verifyLicenseInventory(manifest, releaseRoot, expectedLicenseInventory)
  await verifyChecksumFile(manifest, releaseRoot, checksumLines)

  console.log(`Verified ${context.names.size} staged npm artifact(s) and their CycloneDX evidence.`)
  return { manifest, manifestPath, releaseRoot }
}

function validatePublishEnvironment() {
  const workflowReference = process.env.GITHUB_WORKFLOW_REF ?? ''
  if (
    process.env.GITHUB_ACTIONS !== 'true' ||
    process.env.GITHUB_REPOSITORY !== EXPECTED_REPOSITORY ||
    !workflowReference.includes(`/${EXPECTED_WORKFLOW}@`)
  ) {
    throw new Error(
      `publication is restricted to ${EXPECTED_REPOSITORY}/${EXPECTED_WORKFLOW} on GitHub Actions`
    )
  }
}

async function waitForPublishedArtifact(item) {
  for (let attempt = 1; attempt <= REGISTRY_RETRY_ATTEMPTS; attempt += 1) {
    const metadata = await registryMetadata(item.name, item.version)
    if (metadata.published && metadata.integrity === item.integrity) {
      console.log(`Verified npm registry bytes for ${item.name}@${item.version}.`)
      return
    }
    if (metadata.published && metadata.integrity) {
      throw new Error(
        `${item.name}@${item.version} exists on npm with bytes that differ from the staged artifact`
      )
    }
    if (attempt < REGISTRY_RETRY_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, REGISTRY_RETRY_DELAY_MS))
    }
  }
  throw new Error(`npm did not expose ${item.name}@${item.version} with the staged digest`)
}

async function publishArtifacts(manifestOption, dryRun) {
  const { manifest, releaseRoot } = await verifyArtifacts(manifestOption)
  if (!dryRun) validatePublishEnvironment()
  for (const item of manifest.packages) {
    const tarballPath = resolveArtifactPath(releaseRoot, item.tarball)
    if (dryRun) {
      await run(
        'npm',
        ['publish', tarballPath, '--access', 'public', '--ignore-scripts', '--dry-run', '--force'],
        { cwd: REPOSITORY_ROOT }
      )
      console.log(`Dry-run verified npm publication for ${item.name}@${item.version}.`)
      continue
    }
    const existing = await registryMetadata(item.name, item.version)
    if (existing.published) {
      if (existing.integrity !== item.integrity) {
        throw new Error(
          `${item.name}@${item.version} is already published with different immutable bytes`
        )
      }
      console.log(`${item.name}@${item.version} is already published with the staged digest.`)
      continue
    }
    await run(
      'npm',
      ['publish', tarballPath, '--access', 'public', '--ignore-scripts', '--provenance'],
      { cwd: REPOSITORY_ROOT }
    )
    await waitForPublishedArtifact(item)
  }
  if (!dryRun) await appendGitHubOutput('published', manifest.packages.length)
}

async function main(arguments_) {
  const [command, ...options] = arguments_
  if (command === 'stage') {
    await stageArtifacts(options)
    return
  }
  if (command === 'verify') {
    await verifyArtifacts(options[0])
    return
  }
  if (command === 'publish') {
    await publishArtifacts(
      options.find(argument => !argument.startsWith('--')),
      options.includes('--dry-run')
    )
    return
  }
  throw new Error(
    'usage: package-release-artifacts.mjs ' +
      'stage --output <directory> [--filter <pnpm-filter> | --package <name>] ' +
      '[--include-published] | verify <manifest> | publish <manifest> [--dry-run]'
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
