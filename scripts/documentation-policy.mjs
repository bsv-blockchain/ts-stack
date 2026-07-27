#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
const publicPackages = inventory.projects.filter(project => project.release === 'npm-oidc')
const projectsByName = new Map(inventory.projects.map(project => [project.name, project]))
const failures = []
const documentedProjects = new Set()
let packageDocCount = 0
let freshnessDocCount = 0

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
  const relativePath = docPath.slice(ROOT.length + 1)

  if (!updated || !verified || !Number.isInteger(cadence)) continue
  freshnessDocCount += 1
  if (updated > verified) {
    failures.push(`${relativePath}: last_verified predates last_updated`)
  }

  const verifiedDate = new Date(`${verified}T00:00:00Z`)
  const staleAfter = new Date(verifiedDate)
  staleAfter.setUTCDate(staleAfter.getUTCDate() + cadence)
  if (staleAfter < today) {
    failures.push(`${relativePath}: verification expired ${staleAfter.toISOString().slice(0, 10)}`)
  }
  if (verifiedDate > today) {
    failures.push(`${relativePath}: last_verified cannot be in the future`)
  }
}

if (failures.length > 0) {
  console.error(`Documentation policy failed (${failures.length} finding(s)):`)
  for (const item of failures) console.error(`- ${item}`)
  process.exit(1)
}

console.log(
  `Documentation policy passed: ${publicPackages.length} public package READMEs, ` +
    `${packageDocCount} package docs, ${freshnessDocCount} freshness records, 0 findings`
)
