#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const OUTPUT = join(ROOT, 'docs/reference/stack-facts.md')
const CHECK_MODE = process.argv.includes('--check')

if (process.argv.slice(2).some(arg => arg !== '--check')) {
  throw new Error('Usage: node scripts/generate-stack-facts.mjs [--check]')
}

async function readJson(path) {
  return JSON.parse(await readFile(join(ROOT, path), 'utf8'))
}

function escapeCell(value) {
  return String(value === undefined || value === null || value === '' ? '—' : value)
    .replaceAll('|', String.raw`\|`)
    .replaceAll('\n', ' ')
}

function table(headers, rows) {
  const header = `| ${headers.join(' | ')} |`
  const separator = `| ${headers.map(() => '---').join(' | ')} |`
  return [header, separator, ...rows.map(row => `| ${row.map(escapeCell).join(' | ')} |`)].join(
    '\n'
  )
}

function repositoryLink(project) {
  if (project.path === '.') {
    return '[repository root](https://github.com/bsv-blockchain/ts-stack)'
  }
  return `[${project.path}](https://github.com/bsv-blockchain/ts-stack/tree/main/${project.path})`
}

const [rootManifest, inventory, containerPolicy, policy, meta, parity, baseline] =
  await Promise.all([
    readJson('package.json'),
    readJson('governance/repository-health/projects.json'),
    readJson('governance/container-images.json'),
    readJson('governance/documentation-policy.json'),
    readJson('conformance/META.json'),
    readJson('conformance/PARITY_MATRIX.json'),
    readJson('governance/repository-health/baselines.json')
  ])

const projects = await Promise.all(
  inventory.projects.map(async project => {
    const manifest = await readJson(
      project.path === '.' ? 'package.json' : `${project.path}/package.json`
    )
    return { ...project, version: manifest.version, engines: manifest.engines ?? {} }
  })
)
const publicPackages = projects
  .filter(project => project.release === 'npm-oidc')
  .sort((a, b) => a.area.localeCompare(b.area) || a.name.localeCompare(b.name))
const infrastructure = (
  await Promise.all(
    containerPolicy.components.map(async component => {
      const manifest = await readJson(`${component.path}/package.json`)
      return {
        ...component,
        packageName: manifest.name,
        version: manifest.version,
        engines: manifest.engines ?? {},
        runtimeTargets: ['node', containerPolicy.platform]
      }
    })
  )
).sort((a, b) => a.name.localeCompare(b.name))
const sdk = projects.find(project => project.name === '@bsv/sdk')
if (!sdk) throw new Error('Governed project inventory is missing @bsv/sdk')
const sdkManifest = await readJson(`${sdk.path}/package.json`)
const publicNodeRanges = [...new Set(publicPackages.map(project => project.engines.node))]
const infrastructureNodeRanges = [...new Set(infrastructure.map(project => project.engines.node))]

if (publicPackages.length !== baseline.workspace.publicPackages) {
  throw new Error('Public-package inventory and repository-health baseline disagree')
}
if (
  meta.stats.total_files !== parity.summary.total_files ||
  meta.stats.total_vectors !== parity.summary.total_vectors ||
  meta.stats.total_files !== baseline.conformance.vectorFiles ||
  meta.stats.total_vectors !== baseline.conformance.total
) {
  throw new Error('Conformance metadata, parity matrix, and governed baseline disagree')
}

const content = `---
id: stack-facts
title: 'Generated Stack Facts'
kind: reference
version: '1.0.0'
last_updated: '${policy.lastReviewed}'
last_verified: '${policy.lastReviewed}'
review_cadence_days: 30
status: stable
tags: [reference, packages, versions, runtimes, conformance, generated]
---

# Generated Stack Facts

This page is generated from committed manifests and governance records. Edit the source
manifests, \`governance/repository-health/projects.json\`,
\`governance/documentation-policy.json\`, or conformance metadata, then run
\`pnpm docs:facts\`. CI runs \`pnpm docs:facts:check\` and rejects drift.

## Support and toolchain

${table(
  ['Profile', 'Current contract', 'Authority'],
  [
    [
      'Repository contributors, CI, releases',
      `Node.js ${rootManifest.engines.node}; pnpm ${rootManifest.engines.pnpm} (${rootManifest.packageManager})`,
      'root package.json'
    ],
    [
      'Published npm packages',
      `${publicNodeRanges.join(', ')} for Node consumers; browser/mobile targets remain package-specific`,
      'public package manifests'
    ],
    [
      'Standalone infrastructure',
      infrastructureNodeRanges.join(', '),
      'service manifests and digest-pinned Dockerfiles'
    ],
    [
      'TypeScript compiler',
      `${sdkManifest.devDependencies['@typescript/native']} compiler; ${sdkManifest.devDependencies.typescript} tooling API`,
      '@bsv/sdk package.json and TypeScript toolchain policy'
    ]
  ]
)}

Node engine declarations on browser and React Native packages govern package tooling and
Node consumers; they do not require a browser or mobile device to provide Node APIs.

## Public package manifest

The release graph currently contains **${publicPackages.length} public packages**. Versions
below are source-manifest versions; registry publication is a separate, explicitly
authorized release action.

${table(
  ['Area', 'Package', 'Source version', 'Profile', 'Runtime targets', 'Node engine', 'Source'],
  publicPackages.map(project => [
    project.area,
    `\`${project.name}\``,
    `\`${project.version}\``,
    project.profile,
    project.runtimeTargets.join(', '),
    `\`${project.engines.node}\``,
    repositoryLink(project)
  ])
)}

## Standalone infrastructure manifests

These versions identify the checked-in service manifests; production identity is
the separately released and verified image digest.

${table(
  ['Service', 'Package', 'Manifest version', 'Node engine', 'Runtime targets', 'Release', 'Source'],
  infrastructure.map(project => [
    project.title,
    `\`${project.packageName}\``,
    `\`${project.version}\``,
    `\`${project.engines.node}\``,
    project.runtimeTargets.join(', '),
    project.release,
    repositoryLink(project)
  ])
)}

## Governed project and release inventory

${table(
  ['Metric', 'Count'],
  [
    ['Governed projects', projects.length],
    ['Package-area projects', baseline.workspace.packageAreaProjects],
    ['Public npm packages', publicPackages.length],
    ['Private package-area projects', baseline.workspace.privatePackageAreaProjects],
    ['Standalone infrastructure projects', infrastructure.length]
  ]
)}

Public packages use the \`npm-oidc\` release route. Other workspace projects are
private packages or documentation/conformance tooling. Standalone infrastructure
components are governed separately by \`governance/container-images.json\` and use their
recorded container release route; they are not published by the public-package job.

## Conformance corpus

${table(
  ['Metric', 'Current value'],
  [
    ['Vector files', meta.stats.total_files],
    ['Vectors', meta.stats.total_vectors],
    ['Structurally passed', baseline.conformance.passed],
    ['Governed skips', baseline.conformance.skipped],
    ['Required parity vectors', parity.summary.vectors_by_status.required],
    ['Intended parity vectors', parity.summary.vectors_by_status.intended],
    ['Explicitly skipped vector entries', parity.summary.vectors_by_status.skipped],
    ['Corpus metadata revision', meta.stats.last_updated]
  ]
)}

Structural runner pass/skip results and parity classifications answer different questions:
the former is the current runner outcome, while the latter records cross-language
implementation intent. Neither count may be silently presented as the other.

## Change procedure

1. Change source manifests or vector files.
2. Update the governed inventory or \`conformance/META.json\` when its declared facts change.
3. Run \`pnpm docs:facts\`.
4. Run \`pnpm docs:facts:check\`, \`pnpm health:check\`, and the relevant package,
   conformance, documentation, and release checks.
5. Review generated diffs together with the source change. Do not hand-edit this page or
   \`conformance/PARITY_MATRIX.json\`.

See [Versioning Policy](../about/versioning.md),
[Dependency and Release Policy](./dependency-policy.md), and
[Conformance Testing](../conformance/index.md) for the operational meaning of these facts.
`

if (CHECK_MODE) {
  const committed = await readFile(OUTPUT, 'utf8')
  if (committed !== content) {
    throw new Error('docs/reference/stack-facts.md is stale; run `pnpm docs:facts`')
  }
  console.log(`Verified ${OUTPUT}`)
} else {
  await writeFile(OUTPUT, content)
  console.log(`Generated ${OUTPUT}`)
}
