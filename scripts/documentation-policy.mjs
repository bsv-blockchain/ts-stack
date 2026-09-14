#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  documentationChangedFiles,
  documentationDateFindings,
  documentationIsAffected,
  documentationSources
} from './documentation-freshness.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INVENTORY = join(ROOT, 'governance/repository-health/projects.json')
const POLICY = join(ROOT, 'governance/documentation-policy.json')

const installationHeading =
  /^## (?:Install|Installation|Getting Started|Quick start|Quickstart|Requirements and installation|Using)\b/im
function failure(project, message) {
  return `${project.name} (${project.path}/README.md): ${message}`
}

function frontmatterValue(frontmatter, key) {
  return frontmatter.match(new RegExp(String.raw`^${key}:\s*["']?([^"'\n]+)["']?\s*$`, 'm'))?.[1]
}

async function walkMarkdown(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walkMarkdown(fullPath)))
    else if (entry.name.endsWith('.md')) files.push(fullPath)
  }
  return files
}

const inventory = JSON.parse(await readFile(INVENTORY, 'utf8'))
const policy = JSON.parse(await readFile(POLICY, 'utf8'))
const { services } = JSON.parse(
  await readFile(join(ROOT, 'governance/service-operations.json'), 'utf8')
)
const changedFiles = documentationChangedFiles(ROOT, process.argv.slice(2))
const publicPackages = inventory.projects.filter(project => project.release === 'npm-oidc')
const projectsByName = new Map(inventory.projects.map(project => [project.name, project]))
const failures = []
const documentedProjects = new Set()
let packageDocCount = 0
let freshnessDocCount = 0
let affectedDocCount = 0

for (const project of publicPackages) {
  const packageJsonPath = join(ROOT, project.path, 'package.json')
  const readmePath = join(ROOT, project.path, 'README.md')
  const licensePath = join(ROOT, project.path, policy.publicPackageReadme.requiredLicenseFile)
  const manifest = JSON.parse(await readFile(packageJsonPath, 'utf8'))
  const readme = await readFile(readmePath, 'utf8')

  if (!readme.startsWith('# ')) failures.push(failure(project, 'must start with an H1'))
  if (!readme.includes(manifest.name)) {
    failures.push(failure(project, `must identify the package as ${manifest.name}`))
  }
  if (!installationHeading.test(readme)) {
    failures.push(failure(project, 'needs an installation or getting-started section'))
  }
  if (!readme.includes('```')) {
    failures.push(failure(project, 'needs usable guidance with a fenced example'))
  }
  if (!/^## License\s*$/im.test(readme)) {
    failures.push(failure(project, 'needs a License section'))
  }
  if (!readme.includes('LICENSE.txt')) {
    failures.push(failure(project, 'must link its package-local LICENSE.txt'))
  }
  await readFile(licensePath, 'utf8')
}

const versions = new Map()
for (const project of inventory.projects) {
  const manifest = JSON.parse(
    await readFile(join(ROOT, project.path === '.' ? '' : project.path, 'package.json'), 'utf8')
  )
  versions.set(project.name, manifest.version)
}

for (const docPath of await walkMarkdown(join(ROOT, 'docs/packages'))) {
  packageDocCount += 1
  const document = await readFile(docPath, 'utf8')
  const frontmatter = document.split('---')[1] ?? ''
  const title = frontmatterValue(frontmatter, 'title')
  const project = projectsByName.get(title)
  if (!title || !project) continue
  if (documentedProjects.has(title)) {
    failures.push(`${docPath.slice(ROOT.length + 1)}: duplicate package page for ${title}`)
  }
  documentedProjects.add(title)

  const documented = frontmatterValue(frontmatter, 'version')
  if (documented !== versions.get(title)) {
    failures.push(
      `${docPath.slice(ROOT.length + 1)}: version ${documented ?? '<missing>'} does not match ${title}@${versions.get(title)}`
    )
  }
  const expectedRepository = `https://github.com/bsv-blockchain/ts-stack/tree/main/${project.path}`
  const repository = frontmatterValue(frontmatter, 'repo')
  if (repository !== expectedRepository) {
    failures.push(`${docPath.slice(ROOT.length + 1)}: repo must be ${expectedRepository}`)
  }
  const sourceRepository = frontmatterValue(frontmatter, 'source_repo')
  if (sourceRepository && sourceRepository !== 'bsv-blockchain/ts-stack') {
    failures.push(`${docPath.slice(ROOT.length + 1)}: source_repo must be bsv-blockchain/ts-stack`)
  }
  if (/^source_commit:/m.test(frontmatter)) {
    failures.push(
      `${docPath.slice(ROOT.length + 1)}: source_commit snapshots are not valid current package authority`
    )
  }
  if (project.release !== 'npm-oidc' && /^npm:/m.test(frontmatter)) {
    failures.push(`${docPath.slice(ROOT.length + 1)}: private project must not advertise npm`)
  }
  for (const field of ['last_updated', 'last_verified', 'review_cadence_days']) {
    if (!new RegExp(`^${field}:`, 'm').test(frontmatter)) {
      failures.push(`${docPath.slice(ROOT.length + 1)}: package page is missing ${field}`)
    }
  }
}

for (const project of publicPackages) {
  if (!documentedProjects.has(project.name)) {
    failures.push(`${project.name}: public package is missing a docs/packages page`)
  }
}

const today = new Date()
today.setUTCHours(0, 0, 0, 0)
for (const docPath of await walkMarkdown(join(ROOT, 'docs'))) {
  if (docPath.includes('/_internal/') || docPath.includes('/_schemas/')) continue
  const document = await readFile(docPath, 'utf8')
  const frontmatter = document.split('---')[1] ?? ''
  const updated = frontmatter.match(/^last_updated:\s*["']?(\d{4}-\d{2}-\d{2})/m)?.[1]
  const verified = frontmatter.match(/^last_verified:\s*["']?(\d{4}-\d{2}-\d{2})/m)?.[1]
  const cadence = Number(frontmatter.match(/^review_cadence_days:\s*(\d+)/m)?.[1])
  const relativePath = relative(ROOT, docPath).split('\\').join('/')

  if (!updated || !verified || !Number.isInteger(cadence)) continue
  freshnessDocCount += 1
  const sources = documentationSources(
    relativePath,
    frontmatterValue(frontmatter, 'title'),
    inventory.projects,
    services,
    policy.freshness.sourcePaths
  )
  const affected = documentationIsAffected(relativePath, sources, changedFiles)
  if (affected) affectedDocCount += 1
  for (const finding of documentationDateFindings(updated, verified, cadence, today, affected)) {
    failures.push(`${relativePath}: ${finding}`)
  }
}

if (failures.length > 0) {
  console.error(`Documentation policy failed (${failures.length} finding(s)):`)
  for (const item of failures) console.error(`- ${item}`)
  process.exit(1)
}

console.log(
  `Documentation policy passed: ${publicPackages.length} public package READMEs, ` +
    `${packageDocCount} package docs, ${freshnessDocCount} date records, ` +
    `${affectedDocCount} affected pages checked for review expiry, 0 findings`
)
