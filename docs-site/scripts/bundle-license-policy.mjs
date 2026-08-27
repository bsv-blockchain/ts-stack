#!/usr/bin/env node

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url))
export const DOCS_SITE_ROOT = path.resolve(SCRIPT_DIRECTORY, '..')
export const REPOSITORY_ROOT = path.resolve(DOCS_SITE_ROOT, '..')
export const REGISTRY_PATH = path.join(
  REPOSITORY_ROOT,
  'governance/docs-site-bundled-materials.json'
)
const DIST_DIRECTORY = path.join(DOCS_SITE_ROOT, 'dist')

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function isSafeRelativePath(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value.includes('\\') &&
    !value.split('/').some(segment => segment === '' || segment === '..')
  )
}

function walkFiles(directory, predicate = () => true) {
  if (!fs.existsSync(directory)) return []
  const files = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(target, predicate))
    else if (entry.isFile() && predicate(target)) files.push(target)
  }
  return files
}

function packageRootCandidates(name) {
  const relativeManifest = path.join(...name.split('/'), 'package.json')
  const candidates = [
    path.join(DOCS_SITE_ROOT, 'node_modules', relativeManifest),
    path.join(REPOSITORY_ROOT, 'node_modules', relativeManifest)
  ]
  const pnpmRoot = path.join(REPOSITORY_ROOT, 'node_modules/.pnpm')
  if (fs.existsSync(pnpmRoot)) {
    for (const entry of fs.readdirSync(pnpmRoot)) {
      candidates.push(path.join(pnpmRoot, entry, 'node_modules', relativeManifest))
    }
  }
  return candidates
}

function resolvePackageRoot(component) {
  const matches = []
  for (const manifest of packageRootCandidates(component.name)) {
    if (!fs.existsSync(manifest)) continue
    let candidate
    try {
      candidate = readJson(manifest)
    } catch {
      continue
    }
    if (candidate.name === component.name && candidate.version === component.version) {
      matches.push(path.dirname(manifest))
    }
  }
  return [...new Set(matches)][0]
}

function packageForSource(mapFile, source) {
  if (typeof source !== 'string' || !source.includes('node_modules')) return null
  let directory = path.dirname(path.resolve(path.dirname(mapFile), source))
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, 'package.json')
    if (fs.existsSync(manifest)) {
      try {
        const value = readJson(manifest)
        if (typeof value.name === 'string' && typeof value.version === 'string') {
          return `${value.name}@${value.version}`
        }
      } catch {
        // Continue upward when a package manifest is malformed or synthetic.
      }
    }
    directory = path.dirname(directory)
  }
  return null
}

export function discoverViteBundleComponents(directory = DIST_DIRECTORY) {
  const identities = new Set()
  const sourceMaps = walkFiles(directory, file => file.endsWith('.map'))
  if (sourceMaps.length === 0) {
    throw new Error('docs client build produced no source maps for license inventory')
  }
  for (const sourceMap of sourceMaps) {
    const value = readJson(sourceMap)
    for (const source of value.sources ?? []) {
      const identity = packageForSource(sourceMap, source)
      if (identity !== null) identities.add(identity)
    }
  }
  return [...identities].sort((left, right) => left.localeCompare(right))
}

function licenseAssetName(component, licenseFile) {
  const packageSlug = component.name
    .replace(/^@/, '')
    .replaceAll('/', '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
  const sourceSlug = path
    .basename(licenseFile.path)
    .replace(/\.(?:md|txt)$/i, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
  return `${packageSlug}-${component.version}-${sourceSlug}.txt`
}

function componentLicenseSource(component, licenseFile, packageRoot) {
  if (component.kind === 'repository') return path.join(REPOSITORY_ROOT, licenseFile.path)
  return path.join(packageRoot, licenseFile.path)
}

function validateRegistryMetadata(registry, errors) {
  if (registry.schemaVersion !== 1) errors.push('docs bundle registry schemaVersion must be 1')
  if (registry.distribution !== 'docs-site/dist') {
    errors.push('docs bundle registry must target docs-site/dist')
  }
}

function validateComponentMetadata(component, identity, errors) {
  if (!['vite', 'pagefind', 'repository'].includes(component.kind)) {
    errors.push(`${identity} has invalid kind ${component.kind}`)
  }
  if (typeof component.licenseExpression !== 'string' || component.licenseExpression === '') {
    errors.push(`${identity} has no license expression`)
  }
  if (typeof component.source !== 'string' || !component.source.startsWith('https://')) {
    errors.push(`${identity} has no HTTPS source`)
  }
}

function resolveRegisteredPackage(component, identity, errors) {
  if (component.kind === 'repository') return null
  const packageRoot = resolvePackageRoot(component)
  if (packageRoot === undefined) {
    errors.push(`${identity} is not installed at its registered version`)
    return undefined
  }
  const manifest = readJson(path.join(packageRoot, 'package.json'))
  const actualLicense = manifest.license ?? null
  if (actualLicense !== component.packageLicense) {
    errors.push(
      `${identity} package license is ${JSON.stringify(actualLicense)}, expected ${JSON.stringify(component.packageLicense)}`
    )
  }
  return packageRoot
}

function validateComponentLicenseFiles(component, identity, packageRoot, errors) {
  for (const licenseFile of component.licenseFiles) {
    if (!isSafeRelativePath(licenseFile.path)) {
      errors.push(`${identity} has unsafe license path ${JSON.stringify(licenseFile.path)}`)
      continue
    }
    const source = componentLicenseSource(component, licenseFile, packageRoot)
    if (!fs.existsSync(source)) {
      errors.push(`${identity} license file is missing: ${licenseFile.path}`)
      continue
    }
    const actual = sha256(fs.readFileSync(source))
    if (actual !== licenseFile.sha256) {
      errors.push(
        `${identity} ${licenseFile.path} hash is ${actual}, expected ${licenseFile.sha256}`
      )
    }
  }
}

function validateRegistry(registry) {
  const errors = []
  validateRegistryMetadata(registry, errors)
  if (!Array.isArray(registry.components) || registry.components.length === 0) {
    return [...errors, 'docs bundle registry has no components']
  }
  const identities = new Set()
  let previous = ''
  for (const component of registry.components) {
    const identity = `${component.name}@${component.version}`
    if (identities.has(identity)) errors.push(`docs bundle registry repeats ${identity}`)
    identities.add(identity)
    if (previous !== '' && previous.localeCompare(identity) > 0) {
      errors.push('docs bundle registry components are not sorted')
    }
    previous = identity
    validateComponentMetadata(component, identity, errors)
    if (!Array.isArray(component.licenseFiles) || component.licenseFiles.length === 0) {
      errors.push(`${identity} has no license files`)
      continue
    }
    const packageRoot = resolveRegisteredPackage(component, identity, errors)
    if (packageRoot === undefined) continue
    validateComponentLicenseFiles(component, identity, packageRoot, errors)
  }
  return errors
}

export function renderBundledNotice(registry) {
  const lines = [
    '<!-- Generated by docs-site/scripts/bundle-license-policy.mjs. Do not edit by hand. -->',
    '',
    '# Third-Party Notices for the TS Stack Documentation Site',
    '',
    'The TS Stack documentation and first-party site code are provided under the',
    'Open BSV License Version 6 in `LICENSE.txt`. The deployed static site also',
    'bundles the components below. Their own terms and notices remain applicable.',
    '',
    'This inventory is derived from the client build source maps and separately',
    'accounts for the Pagefind-generated JavaScript and WebAssembly search runtime.',
    ''
  ]
  for (const component of registry.components) {
    lines.push(
      `## ${component.name} (${component.version})`,
      '',
      `- License: \`${component.licenseExpression}\``,
      `- Source: ${component.source}`,
      '- License files:'
    )
    for (const licenseFile of component.licenseFiles) {
      const target = licenseAssetName(component, licenseFile)
      lines.push(`  - [${target}](./LICENSES/${target})`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

function assertExactViteInventory(registry) {
  const expected = registry.components
    .filter(component => component.kind === 'vite')
    .map(component => `${component.name}@${component.version}`)
    .sort((left, right) => left.localeCompare(right))
  const actual = discoverViteBundleComponents()
  const missing = expected.filter(identity => !actual.includes(identity))
  const unregistered = actual.filter(identity => !expected.includes(identity))
  if (missing.length > 0 || unregistered.length > 0) {
    const lines = ['docs client bundle differs from its governed license inventory']
    if (missing.length > 0) lines.push(`missing from bundle: ${missing.join(', ')}`)
    if (unregistered.length > 0) lines.push(`unregistered in bundle: ${unregistered.join(', ')}`)
    throw new Error(lines.join('\n'))
  }
}

function assertPagefindRuntime() {
  const required = [
    '_pagefind/pagefind-highlight.js',
    '_pagefind/pagefind.js',
    '_pagefind/wasm.en.pagefind'
  ]
  for (const file of required) {
    if (!fs.existsSync(path.join(DIST_DIRECTORY, file))) {
      throw new Error(`Pagefind output is missing ${file}`)
    }
  }
  const highlighter = fs.readFileSync(
    path.join(DIST_DIRECTORY, '_pagefind/pagefind-highlight.js'),
    'utf8'
  )
  for (const notice of ['mark.js v8.11.1', 'Copyright (c) 2014–2018, Julian Kühnel']) {
    if (!highlighter.includes(notice)) {
      throw new Error(`Pagefind highlighter no longer preserves ${notice}`)
    }
  }
}

function writeDistributionFiles(registry) {
  assertExactViteInventory(registry)
  assertPagefindRuntime()
  const licensesDirectory = path.join(DIST_DIRECTORY, 'LICENSES')
  fs.rmSync(licensesDirectory, { recursive: true, force: true })
  fs.mkdirSync(licensesDirectory, { recursive: true })
  for (const component of registry.components) {
    const packageRoot = component.kind === 'repository' ? null : resolvePackageRoot(component)
    for (const licenseFile of component.licenseFiles) {
      fs.copyFileSync(
        componentLicenseSource(component, licenseFile, packageRoot),
        path.join(licensesDirectory, licenseAssetName(component, licenseFile))
      )
    }
  }
  fs.copyFileSync(
    path.join(DOCS_SITE_ROOT, 'LICENSE.txt'),
    path.join(DIST_DIRECTORY, 'LICENSE.txt')
  )
  fs.writeFileSync(
    path.join(DIST_DIRECTORY, 'THIRD_PARTY_NOTICES.md'),
    renderBundledNotice(registry)
  )
  for (const sourceMap of walkFiles(DIST_DIRECTORY, file => file.endsWith('.map'))) {
    fs.rmSync(sourceMap)
  }
}

export function checkBundledLicensePolicy() {
  const registry = readJson(REGISTRY_PATH)
  return { registry, errors: validateRegistry(registry) }
}

function main() {
  const writeDistribution = process.argv.includes('--write-dist')
  const { registry, errors } = checkBundledLicensePolicy()
  if (errors.length > 0) {
    console.error(errors.join('\n'))
    process.exitCode = 1
    return
  }
  if (writeDistribution) writeDistributionFiles(registry)
  console.log(
    `Verified ${registry.components.length} governed components for the docs-site bundle${writeDistribution ? ' and wrote deployment notices' : ''}.`
  )
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
