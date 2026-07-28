#!/usr/bin/env node

import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUTPUT = join(ROOT, 'docs/reference/package-api-migrations.md')
const RELEASE_TYPES = new Set(['none', 'patch', 'minor', 'major'])

const readJson = async (root, path) => JSON.parse(await readFile(join(root, path), 'utf8'))
const escapeCell = value =>
  String(value ?? '—')
    .replaceAll('|', String.raw`\|`)
    .replaceAll('\n', ' ')

const markdownFiles = async directory => {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await markdownFiles(path)))
    else if (entry.isFile() && entry.name.endsWith('.md')) files.push(path)
  }
  return files
}

const frontmatterValue = (document, key) => {
  const frontmatter = document.split('---')[1] ?? ''
  return frontmatter.match(new RegExp(String.raw`^${key}:\s*["']?([^"'\n]+)["']?\s*$`, 'm'))?.[1]
}

const parseVersion = version => {
  const parts = String(version).split('.')
  if (parts.length !== 3 || parts.some(part => !/^\d+$/.test(part))) return undefined
  return parts.map(Number)
}

const releaseTypeBetween = (published, source) => {
  const from = parseVersion(published)
  const to = parseVersion(source)
  if (from === undefined || to === undefined) return undefined
  if (from.every((part, index) => part === to[index])) return 'none'
  if (to[0] !== from[0]) return 'major'
  if (to[1] !== from[1]) return 'minor'
  return 'patch'
}

const declarationTargets = value => {
  if (typeof value === 'string' || value === null) return []
  if (Array.isArray(value)) return value.flatMap(declarationTargets)
  if (typeof value !== 'object') return []
  return Object.entries(value).flatMap(([condition, target]) => {
    if (condition === 'types' && typeof target === 'string') return [target]
    return declarationTargets(target)
  })
}

const runtimeTargets = value => {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap(runtimeTargets)
  return Object.entries(value).flatMap(([condition, target]) =>
    condition === 'types' ? [] : runtimeTargets(target)
  )
}

const exportedEntries = manifest => {
  if (manifest.exports === undefined) {
    const runtime = [manifest.main, manifest.module].filter(value => typeof value === 'string')
    const declarations = typeof manifest.types === 'string' ? [manifest.types] : []
    return [{ subpath: '.', runtime, declarations }]
  }
  if (
    typeof manifest.exports === 'string' ||
    Array.isArray(manifest.exports) ||
    Object.keys(manifest.exports).every(key => !key.startsWith('.'))
  ) {
    return [
      {
        subpath: '.',
        runtime: runtimeTargets(manifest.exports),
        declarations: [
          ...(typeof manifest.types === 'string' ? [manifest.types] : []),
          ...declarationTargets(manifest.exports)
        ]
      }
    ]
  }
  return Object.entries(manifest.exports).map(([subpath, value]) => ({
    subpath,
    runtime: runtimeTargets(value),
    declarations: declarationTargets(value)
  }))
}

const validateEntry = (root, entry, project, manifest, errors) => {
  const prefix = `${entry.name}`
  if (!RELEASE_TYPES.has(entry.releaseType)) {
    errors.push(`${prefix} has unsupported releaseType ${entry.releaseType}`)
  }
  const expectedType = releaseTypeBetween(entry.publishedVersion, manifest.version)
  if (expectedType === undefined) {
    errors.push(`${prefix} versions must be exact MAJOR.MINOR.PATCH values`)
  } else if (entry.releaseType !== expectedType) {
    errors.push(
      `${prefix} releaseType ${entry.releaseType} disagrees with ` +
        `${entry.publishedVersion} -> ${manifest.version} (${expectedType})`
    )
  }
  for (const field of ['summary', 'migration']) {
    if (typeof entry[field] !== 'string' || entry[field].trim().length < 20) {
      errors.push(`${prefix} must provide a substantive ${field}`)
    }
  }
  if (!existsSync(join(root, project.path, 'README.md'))) {
    errors.push(`${prefix} is missing its package README`)
  }
}

export async function loadPackageDocumentation(root = ROOT) {
  const [inventory, releaseNotes] = await Promise.all([
    readJson(root, 'governance/repository-health/projects.json'),
    readJson(root, 'governance/package-release-notes.json')
  ])
  const publicProjects = inventory.projects
    .filter(project => project.release === 'npm-oidc')
    .sort((a, b) => a.name.localeCompare(b.name))
  const docsByName = new Map()
  for (const path of await markdownFiles(join(root, 'docs/packages'))) {
    const document = await readFile(path, 'utf8')
    const name = frontmatterValue(document, 'title')
    if (name) docsByName.set(name, relative(root, path))
  }
  const entriesByName = new Map(releaseNotes.entries.map(entry => [entry.name, entry]))
  const errors = []
  if (releaseNotes.schemaVersion !== 1) {
    errors.push('package-release-notes schemaVersion must be 1')
  }
  if (entriesByName.size !== releaseNotes.entries.length) {
    errors.push('package-release-notes package names must be unique')
  }
  const expectedNames = publicProjects.map(project => project.name)
  const actualNames = [...entriesByName.keys()].sort((a, b) => a.localeCompare(b))
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    errors.push('package-release-notes must exactly cover the public-package inventory')
  }
  const packages = []
  for (const project of publicProjects) {
    const manifest = await readJson(root, `${project.path}/package.json`)
    const entry = entriesByName.get(project.name)
    if (entry === undefined) continue
    validateEntry(root, entry, project, manifest, errors)
    const docsPath = docsByName.get(project.name)
    if (docsPath === undefined) errors.push(`${project.name} is missing its docs/packages page`)
    packages.push({
      ...project,
      ...entry,
      sourceVersion: manifest.version,
      docsPath,
      entries: exportedEntries(manifest),
      bin: manifest.bin
    })
  }
  return { errors, lastReviewed: releaseNotes.lastReviewed, packages }
}

const docsLink = path => `../${path.slice('docs/'.length)}`

export function renderPackageDocumentation({ lastReviewed, packages }) {
  const summaryRows = packages
    .map(
      pkg =>
        `| \`${escapeCell(pkg.name)}\` | \`${pkg.publishedVersion}\` | ` +
        `\`${pkg.sourceVersion}\` | ${pkg.releaseType} | ` +
        `[API and usage](${docsLink(pkg.docsPath)}) | ${escapeCell(pkg.migration)} |`
    )
    .join('\n')
  const details = packages
    .map(pkg => {
      const exportRows =
        pkg.entries.length === 0
          ? '| — | — | — |'
          : pkg.entries
              .map(
                entry =>
                  `| \`${escapeCell(entry.subpath)}\` | ` +
                  `${entry.runtime.map(target => `\`${escapeCell(target)}\``).join('<br>') || '—'} | ` +
                  `${
                    entry.declarations.map(target => `\`${escapeCell(target)}\``).join('<br>') ||
                    '—'
                  } |`
              )
              .join('\n')
      const bin =
        pkg.bin === undefined
          ? ''
          : `\nCLI entry points: \`${escapeCell(
              typeof pkg.bin === 'string' ? pkg.bin : JSON.stringify(pkg.bin)
            )}\`.\n`
      return `## ${pkg.name}

- Package documentation: [${pkg.docsPath}](${docsLink(pkg.docsPath)})
- Source: [${pkg.path}](https://github.com/bsv-blockchain/ts-stack/tree/main/${pkg.path})
- Release note: ${pkg.summary}
- Migration: ${pkg.migration}
${bin}
| Public subpath | Runtime target(s) | Declaration target(s) |
|---|---|---|
${exportRows}
`
    })
    .join('\n')

  return `---
id: package-api-migrations
title: 'Package API, Declarations, and Migration Ledger'
kind: reference
version: '1.0.0'
last_updated: '${lastReviewed}'
last_verified: '${lastReviewed}'
review_cadence_days: 30
status: stable
tags: [reference, packages, api, declarations, migrations, release-notes]
---

# Package API, Declarations, and Migration Ledger

This page is generated from all 30 public manifests, package documentation, and
\`governance/package-release-notes.json\`. It records source candidates without
publishing them. CI rejects a version change unless its release classification,
summary, and migration guidance are updated at the same time.

The declaration targets below describe the packed manifest contract. The
package pages remain the human API and usage authority; generated declarations
and clean-consumer tests remain the executable type authority.

## Current release boundary

| Package | npm baseline | Source | Candidate | API | Migration |
|---|---|---|---|---|---|
${summaryRows}

\`none\` means the source manifest matches the recorded npm baseline. Any other
value is an unpublished candidate. Publication, tags, releases, registry
reconciliation, and infrastructure dependency synchronization remain separate,
explicitly authorized operations.

## Package entry points

${details}
## Change procedure

1. Change the public package and select the SemVer impact from its packed API,
   runtime, wire, persistence, and declaration changes.
2. Bump only affected package manifests and first-party dependents whose packed
   contract changes.
3. Update the matching entry in
   \`governance/package-release-notes.json\`, including explicit migration
   guidance even when no consumer action is required.
4. Run \`pnpm docs:packages\`, \`pnpm docs:packages:check\`,
   \`pnpm check-versions\`, packed-consumer checks, and the full release gates.
5. After an authorized publication, update \`publishedVersion\` to the registry
   result and set \`releaseType\` to \`none\` only when source and npm match.
`
}

async function run() {
  const check = process.argv.includes('--check')
  if (process.argv.slice(2).some(argument => argument !== '--check')) {
    throw new Error('Usage: node scripts/package-documentation.mjs [--check]')
  }
  const model = await loadPackageDocumentation()
  if (model.errors.length > 0) throw new Error(model.errors.join('\n'))
  const { format, resolveConfig } = await import('prettier')
  const prettierConfig = (await resolveConfig(OUTPUT)) ?? {}
  const content = await format(renderPackageDocumentation(model), {
    ...prettierConfig,
    filepath: OUTPUT
  })
  if (check) {
    const committed = await readFile(OUTPUT, 'utf8')
    if (committed !== content) {
      throw new Error('package API and migration documentation is stale')
    }
    console.log(`Verified ${relative(ROOT, OUTPUT)} for ${model.packages.length} packages`)
  } else {
    await writeFile(OUTPUT, content)
    console.log(`Generated ${relative(ROOT, OUTPUT)} for ${model.packages.length} packages`)
  }
}

const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (isMain) await run()
