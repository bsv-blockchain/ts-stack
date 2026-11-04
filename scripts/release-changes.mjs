#!/usr/bin/env node
/**
 * Pending release changes ("change files").
 *
 * A pull request that changes what a public package publishes adds one new,
 * uniquely named Markdown file under `changes/`. It never edits a package
 * version, `governance/package-release-notes.json`, a package `CHANGELOG.md`,
 * the generated ledgers, or the recorded baseline versions. Distinct new files
 * never conflict, so pull requests merge one after another without rebasing.
 *
 * The `version` command folds every pending change into those shared files in
 * one commit. The version-packages workflow runs it on `main` and keeps one
 * automation pull request current; that pull request is the only writer of
 * public package versions.
 *
 * Usage:
 *   node scripts/release-changes.mjs new <package>:<patch|minor|major> [...] \
 *     --summary "<consumer-visible change>" --migration "<migration decision>" [--slug <name>]
 *   node scripts/release-changes.mjs status
 *   node scripts/release-changes.mjs check [--base <ref> --head <ref>]
 *   node scripts/release-changes.mjs version [--date YYYY-MM-DD]
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
export const CHANGES_DIRECTORY = 'changes'
export const IMPACTS = ['patch', 'minor', 'major']
const RELEASE_NOTES = 'governance/package-release-notes.json'
const PROJECTS = 'governance/repository-health/projects.json'
const BASELINES = 'governance/repository-health/baselines.json'
const MINIMUM_TEXT = 20
const FRAGMENT_NAME = /^\d{8}-[a-z0-9][a-z0-9-]{0,80}\.md$/
const RELEASE_LINE = /^\s+["']?([^"':\s]+)["']?\s*:\s*(\S+)\s*$/

const readJson = (root, path) => JSON.parse(readFileSync(join(root, path), 'utf8'))
const collapse = text => text.replaceAll(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------
// Versions

export const parseVersion = version => {
  const parts = String(version).split('.')
  if (parts.length !== 3 || parts.some(part => !/^\d+$/.test(part))) return undefined
  return parts.map(Number)
}

export const compareVersions = (left, right) => {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

export const releaseTypeBetween = (published, source) => {
  const from = parseVersion(published)
  const to = parseVersion(source)
  if (published === null && to !== undefined) return 'initial'
  if (from === undefined || to === undefined) return undefined
  if (from.every((part, index) => part === to[index])) return 'none'
  if (to[0] !== from[0]) return 'major'
  if (to[1] !== from[1]) return 'minor'
  return 'patch'
}

export const bumpVersion = (version, impact) => {
  const [major, minor, patch] = parseVersion(version)
  if (impact === 'major') return `${major + 1}.0.0`
  if (impact === 'minor') return `${major}.${minor + 1}.0`
  if (impact === 'patch') return `${major}.${minor}.${patch + 1}`
  return version
}

const impactRank = impact => IMPACTS.indexOf(impact)
const strongerImpact = (left, right) => (impactRank(right) > impactRank(left) ? right : left)

/**
 * The next source version. An unpublished candidate already ahead of npm is
 * not bumped twice: the target is computed from the published baseline, and
 * the current source version is kept when it already satisfies it.
 */
export const nextVersion = ({ publishedVersion, currentVersion, impact }) => {
  if (publishedVersion === null) return currentVersion
  const pending = releaseTypeBetween(publishedVersion, currentVersion)
  const wanted = IMPACTS.includes(pending) ? strongerImpact(pending, impact) : impact
  const target = bumpVersion(publishedVersion, wanted)
  return compareVersions(currentVersion, target) >= 0 ? currentVersion : target
}

// ---------------------------------------------------------------------------
// Change files

/**
 * A change file is Markdown with a small frontmatter block:
 *
 *   ---
 *   release:
 *     "@bsv/sdk": minor
 *   ---
 *   Consumer-visible summary.
 *
 *   ## Migration
 *
 *   The migration decision, or "No consumer migration is required."
 */
export function parseChange(text, file = '<change>') {
  const errors = []
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text)
  if (match === null) {
    return { errors: [`${file} must start with a --- frontmatter block`] }
  }
  const [, frontmatter, body] = match
  const release = {}
  let inRelease = false
  for (const line of frontmatter.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    if (/^release:\s*$/.test(line)) {
      inRelease = true
      continue
    }
    const entry = inRelease ? RELEASE_LINE.exec(line) : null
    if (entry === null) {
      errors.push(`${file} has an unsupported frontmatter line: ${line.trim()}`)
      continue
    }
    const [, name, impact] = entry
    if (!IMPACTS.includes(impact)) {
      errors.push(`${file} gives ${name} impact ${impact}; use patch, minor or major`)
    } else if (name in release) {
      errors.push(`${file} names ${name} more than once`)
    } else {
      release[name] = impact
    }
  }
  if (Object.keys(release).length === 0)
    errors.push(`${file} must name at least one package under release:`)
  const sections = body.split(/^##\s+Migration\s*$/m)
  if (sections.length !== 2) errors.push(`${file} must contain exactly one "## Migration" section`)
  const summary = (sections[0] ?? '').trim()
  const migration = (sections[1] ?? '').trim()
  if (collapse(summary).length < MINIMUM_TEXT)
    errors.push(`${file} must provide a substantive summary`)
  if (sections.length === 2 && collapse(migration).length < MINIMUM_TEXT) {
    errors.push(`${file} must provide a substantive migration decision`)
  }
  return { errors, release, summary, migration }
}

export const formatChange = ({ release, summary, migration }) =>
  [
    '---',
    'release:',
    ...Object.entries(release).map(([name, impact]) => `  "${name}": ${impact}`),
    '---',
    summary.trim(),
    '',
    '## Migration',
    '',
    migration.trim(),
    ''
  ].join('\n')

export function listChangeFiles(root = ROOT) {
  const directory = join(root, CHANGES_DIRECTORY)
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter(name => name.endsWith('.md') && name !== 'README.md')
    .sort((a, b) => a.localeCompare(b))
    .map(name => join(CHANGES_DIRECTORY, name))
}

// ---------------------------------------------------------------------------
// Repository model

/** Public packages, with nested packages grouped under their enclosing package. */
export function loadPublicPackages(root = ROOT) {
  const projects = readJson(root, PROJECTS)
    .projects.filter(project => project.release === 'npm-oidc')
    .map(project => ({ name: project.name, path: project.path }))
  const byName = new Map(projects.map(project => [project.name, project]))
  for (const project of projects) {
    const enclosing = projects
      .filter(other => project.path.startsWith(`${other.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0]
    project.groupLeader = enclosing?.name ?? project.name
  }
  return byName
}

const groupOf = (packages, name) => {
  const leader = packages.get(name).groupLeader
  return [...packages.values()].filter(project => project.groupLeader === leader)
}

export function loadChanges(root = ROOT) {
  const packages = loadPublicPackages(root)
  const errors = []
  const changes = []
  for (const file of listChangeFiles(root)) {
    const name = file.slice(CHANGES_DIRECTORY.length + 1)
    if (!FRAGMENT_NAME.test(name)) {
      errors.push(`${file} must be named YYYYMMDD-<lowercase-slug>.md`)
    }
    const change = parseChange(readFileSync(join(root, file), 'utf8'), file)
    errors.push(...change.errors)
    for (const packageName of Object.keys(change.release ?? {})) {
      if (!packages.has(packageName)) {
        errors.push(`${file} names ${packageName}, which is not a public npm package`)
      }
    }
    if (change.errors.length === 0) changes.push({ file, ...change })
  }
  return { packages, changes, errors }
}

/** Combine every pending change into one plan per release group. */
export function planRelease(root = ROOT) {
  const { packages, changes, errors } = loadChanges(root)
  const notes = readJson(root, RELEASE_NOTES)
  const entries = new Map(notes.entries.map(entry => [entry.name, entry]))
  const groups = new Map()
  for (const change of changes) {
    for (const [name, impact] of Object.entries(change.release)) {
      if (!packages.has(name)) continue
      const leader = packages.get(name).groupLeader
      const group = groups.get(leader) ?? { impact, changes: [] }
      group.impact = strongerImpact(group.impact, impact)
      if (!group.changes.includes(change)) group.changes.push(change)
      groups.set(leader, group)
    }
  }
  const plan = []
  for (const [leader, group] of groups) {
    const leaderProject = packages.get(leader)
    const leaderManifest = readJson(root, `${leaderProject.path}/package.json`)
    const leaderEntry = entries.get(leader)
    if (leaderEntry === undefined) {
      errors.push(`${RELEASE_NOTES} has no entry for ${leader}`)
      continue
    }
    const version = nextVersion({
      publishedVersion: leaderEntry.publishedVersion,
      currentVersion: leaderManifest.version,
      impact: group.impact
    })
    for (const project of groupOf(packages, leader)) {
      const entry = entries.get(project.name)
      if (entry === undefined) {
        errors.push(`${RELEASE_NOTES} has no entry for ${project.name}`)
        continue
      }
      const manifest = readJson(root, `${project.path}/package.json`)
      plan.push({
        name: project.name,
        path: project.path,
        leader: project.name === leader,
        impact: group.impact,
        currentVersion: manifest.version,
        version,
        releaseType: releaseTypeBetween(entry.publishedVersion, version),
        changes: group.changes
      })
    }
  }
  plan.sort((a, b) => a.name.localeCompare(b.name))
  return { plan, changes, errors }
}

// ---------------------------------------------------------------------------
// Applying a plan

const setManifestVersion = (text, version) => {
  const updated = text.replace(/^(\s*"version"\s*:\s*)"[^"]*"/m, `$1"${version}"`)
  if (updated === text && !text.includes(`"version": "${version}"`)) {
    throw new Error('package.json has no "version" field to update')
  }
  return updated
}

const changelogBullets = changes =>
  changes
    .map(change => {
      const summary = change.summary.trim().replaceAll('\n', '\n  ')
      const migration = collapse(change.migration)
      return `- ${summary}\n\n  Migration: ${migration}`
    })
    .join('\n\n')

/**
 * Insert a release section into an existing changelog without rewriting it.
 * An existing section for the same version (an unpublished candidate) gains
 * the new bullets. Otherwise the new section goes after a Keep a Changelog
 * "Unreleased" section, or before the first release heading.
 */
export function insertChangelogSection(text, { version, date, changes }) {
  const lines = text.split('\n')
  const headings = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^## /.test(line))
  const bullets = changelogBullets(changes)
  const versionPattern = new RegExp(
    String.raw`(^|[^\d.])${version.replaceAll('.', String.raw`\.`)}(?![\d.])`
  )
  const existing = headings.find(({ line }) => versionPattern.test(line))
  if (existing !== undefined) {
    const next = headings.find(({ index }) => index > existing.index)?.index ?? lines.length
    let end = next
    while (end > existing.index + 1 && lines[end - 1].trim() === '') end--
    lines.splice(end, 0, '', bullets)
    return lines.join('\n')
  }
  const unreleased = headings.find(({ line }) => /^## \[Unreleased\]/i.test(line))
  const firstRelease = headings.find(({ line }) => /\d+\.\d+\.\d+/.test(line))
  let insertAt
  if (unreleased !== undefined) {
    insertAt = headings.find(({ index }) => index > unreleased.index)?.index ?? lines.length
  } else {
    insertAt = firstRelease?.index ?? headings[0]?.index ?? lines.length
  }
  let heading = `## [${version}] - ${date}`
  if (unreleased === undefined && firstRelease !== undefined) {
    const prefix = /^## (?!\[)(.*?)\d+\.\d+\.\d+/.exec(firstRelease.line)?.[1]
    if (prefix !== undefined) heading = `## ${prefix}${version}`
  }
  lines.splice(insertAt, 0, heading, '', bullets, '')
  return lines.join('\n')
}

const frontmatterOf = text => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
const frontmatterField = (frontmatter, key) =>
  new RegExp(String.raw`^${key}:\s*["']?([^"'\n]+)["']?\s*$`, 'm').exec(frontmatter)?.[1]

/** docs/packages pages by the package name in their `title` frontmatter. */
function packagePages(root) {
  const pages = new Map()
  const walk = directory => {
    if (!existsSync(directory)) return
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.md')) {
        const title = frontmatterField(frontmatterOf(readFileSync(path, 'utf8')), 'title')
        if (title) pages.set(title, path)
      }
    }
  }
  walk(join(root, 'docs/packages'))
  return pages
}

/** The documentation policy requires a package page `version` to match the manifest. */
export function setPageVersion(text, version) {
  const frontmatter = frontmatterOf(text)
  const updated = frontmatter.replace(
    /^version:\s*(["']?)[^"'\n]*\1\s*$/m,
    (_line, quote) => `version: ${quote}${version}${quote}`
  )
  return updated === frontmatter ? text : text.replace(frontmatter, updated)
}

const appendNote = (existing, addition, replace) =>
  replace || !existing ? addition : `${collapse(existing)} ${addition}`

export function applyRelease(root = ROOT, { date = new Date().toISOString().slice(0, 10) } = {}) {
  const { plan, changes, errors } = planRelease(root)
  if (errors.length > 0) return { plan, errors }
  if (changes.length === 0) return { plan, errors, changed: false }

  const notesPath = join(root, RELEASE_NOTES)
  const notes = JSON.parse(readFileSync(notesPath, 'utf8'))
  const baselinesPath = join(root, BASELINES)
  const baselines = JSON.parse(readFileSync(baselinesPath, 'utf8'))
  const pages = packagePages(root)

  for (const item of plan) {
    const page = pages.get(item.name)
    if (page !== undefined) {
      writeFileSync(page, setPageVersion(readFileSync(page, 'utf8'), item.version))
    }

    const manifestPath = join(root, item.path, 'package.json')
    writeFileSync(
      manifestPath,
      setManifestVersion(readFileSync(manifestPath, 'utf8'), item.version)
    )

    const entry = notes.entries.find(candidate => candidate.name === item.name)
    const replace = entry.releaseType === 'none'
    entry.summary = appendNote(
      entry.summary,
      collapse(item.changes.map(change => change.summary).join(' ')),
      replace
    )
    entry.migration = appendNote(
      entry.migration,
      collapse(item.changes.map(change => change.migration).join(' ')),
      replace
    )
    entry.releaseType = item.releaseType

    if (baselines.publicPackageVersions && item.name in baselines.publicPackageVersions) {
      baselines.publicPackageVersions[item.name] = item.version
    }

    const changelogPath = join(root, item.path, 'CHANGELOG.md')
    if (item.leader && existsSync(changelogPath)) {
      const text = readFileSync(changelogPath, 'utf8')
      writeFileSync(
        changelogPath,
        insertChangelogSection(text, { version: item.version, date, changes: item.changes })
      )
    }
  }
  notes.lastReviewed = date
  writeFileSync(notesPath, `${JSON.stringify(notes, null, 2)}\n`)
  writeFileSync(baselinesPath, `${JSON.stringify(baselines, null, 2)}\n`)
  for (const change of changes) rmSync(join(root, change.file))
  return { plan, errors, changed: true }
}

// ---------------------------------------------------------------------------
// Pull request guard

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' })

const showJson = (root, revision, path) => {
  try {
    return JSON.parse(git(root, ['show', `${revision}:${path}`]))
  } catch {
    return undefined
  }
}

/**
 * Only the version-packages pull request (which deletes the change files it
 * applies) may move a public package version. Every other pull request
 * records its release impact in a new change file instead.
 */
export function checkDiff(root, base, head) {
  const errors = []
  const warnings = []
  const diff = git(root, ['diff', '--name-status', '--no-renames', `${base}...${head}`])
    .split('\n')
    .filter(Boolean)
    .map(line => line.split('\t'))
  const appliesChanges = diff.some(
    ([status, path]) =>
      status === 'D' &&
      path.startsWith(`${CHANGES_DIRECTORY}/`) &&
      path !== `${CHANGES_DIRECTORY}/README.md`
  )
  if (appliesChanges) return { errors, warnings, appliesChanges }
  const changedPaths = new Set(diff.map(([, path]) => path))
  for (const project of loadPublicPackages(root).values()) {
    const manifest = `${project.path}/package.json`
    if (!changedPaths.has(manifest)) continue
    const before = showJson(root, base, manifest)
    const after = showJson(root, head, manifest)
    if (
      before?.version !== undefined &&
      after?.version !== undefined &&
      before.version !== after.version
    ) {
      errors.push(
        `${manifest} changes version ${before.version} -> ${after.version}. ` +
          'Add a change file instead (pnpm change); the version-packages pull request sets versions.'
      )
    }
    if (changedPaths.has(`${project.path}/CHANGELOG.md`)) {
      warnings.push(
        `${project.path}/CHANGELOG.md is edited directly; prefer a change file so pull requests do not conflict.`
      )
    }
  }
  return { errors, warnings, appliesChanges }
}

// ---------------------------------------------------------------------------
// CLI

const slugify = value =>
  value
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 48)

function optionValues(argv, flag) {
  const values = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === flag && index + 1 < argv.length) values.push(argv[index + 1])
  }
  return values
}

function positional(argv) {
  const result = []
  for (let index = 0; index < argv.length; index++) {
    if (argv[index].startsWith('--')) index++
    else result.push(argv[index])
  }
  return result
}

export function createChange(root, { release, summary, migration, slug, date = new Date() }) {
  const change = { release, summary, migration }
  const file = join(CHANGES_DIRECTORY, 'pending.md')
  const parsed = parseChange(formatChange(change), file)
  const packages = loadPublicPackages(root)
  const errors = [...parsed.errors]
  for (const name of Object.keys(release)) {
    if (!packages.has(name)) errors.push(`${name} is not a public npm package`)
  }
  if (errors.length > 0) return { errors }
  const day = date.toISOString().slice(0, 10).replaceAll('-', '')
  const base = slugify(slug ?? summary.split(/[.\n]/)[0]) || 'change'
  const name = `${day}-${base}-${randomBytes(3).toString('hex')}.md`
  mkdirSync(join(root, CHANGES_DIRECTORY), { recursive: true })
  writeFileSync(join(root, CHANGES_DIRECTORY, name), formatChange(change))
  return { errors, file: join(CHANGES_DIRECTORY, name) }
}

function printPlan(plan) {
  if (plan.length === 0) {
    console.log('No pending release changes.')
    return
  }
  for (const item of plan) {
    const files = item.changes.map(change => relative(CHANGES_DIRECTORY, change.file)).join(', ')
    console.log(
      `${item.name}: ${item.currentVersion} -> ${item.version} (${item.releaseType}) from ${files}`
    )
  }
}

function fail(errors) {
  for (const error of errors) console.error(`error: ${error}`)
  process.exitCode = 1
}

export function main(argv, root = ROOT) {
  const [command, ...rest] = argv
  if (command === 'new') {
    const release = {}
    for (const spec of positional(rest)) {
      const at = spec.lastIndexOf(':')
      if (at <= 0) return fail([`expected <package>:<patch|minor|major>, got ${spec}`])
      release[spec.slice(0, at)] = spec.slice(at + 1)
    }
    const [summary] = optionValues(rest, '--summary')
    const [migration] = optionValues(rest, '--migration')
    const [slug] = optionValues(rest, '--slug')
    const result = createChange(root, {
      release,
      summary: summary ?? '',
      migration: migration ?? '',
      slug
    })
    if (result.errors.length > 0) return fail(result.errors)
    console.log(`Created ${result.file}`)
    return
  }
  if (command === 'status') {
    const { plan, errors } = planRelease(root)
    if (errors.length > 0) return fail(errors)
    printPlan(plan)
    return
  }
  if (command === 'check') {
    const { errors } = planRelease(root)
    const [base] = optionValues(rest, '--base')
    const [head] = optionValues(rest, '--head')
    if (base !== undefined) {
      const diff = checkDiff(root, base, head ?? 'HEAD')
      errors.push(...diff.errors)
      for (const warning of diff.warnings) console.log(`::warning::${warning}`)
    }
    if (errors.length > 0) return fail(errors)
    console.log(`Release change files are valid (${listChangeFiles(root).length} pending).`)
    return
  }
  if (command === 'version') {
    const [date] = optionValues(rest, '--date')
    const result = applyRelease(root, date ? { date } : {})
    if (result.errors.length > 0) return fail(result.errors)
    printPlan(result.plan)
    if (result.changed)
      console.log('Now run `pnpm docs:facts` to regenerate the derived documentation.')
    return
  }
  fail([`usage: release-changes.mjs <new|status|check|version> (got ${command ?? 'nothing'})`])
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2))
}
