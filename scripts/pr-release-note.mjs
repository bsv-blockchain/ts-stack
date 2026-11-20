#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const IMPACTS = new Set(['patch', 'minor', 'major', 'initial'])
const FIELDS = ['schemaVersion', 'packages', 'summary', 'migration']
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function readFence(line) {
  const delimiter = line[0]
  if (delimiter !== '`' && delimiter !== '~') return undefined
  let end = 1
  while (line[end] === delimiter) end++
  if (end < 3) return undefined
  return { marker: line.slice(0, end), info: line.slice(end) }
}

function closesFence(match, fence) {
  return (
    match &&
    match.marker[0] === fence[0] &&
    match.marker.length >= fence.length &&
    match.info.trim() === ''
  )
}

function openingFence(line, comments) {
  let hidden = comments.active
  for (const token of line.matchAll(/<!--|-->/g)) {
    if (token[0] === '<!--') hidden = true
    comments.active = token[0] === '<!--'
  }
  return hidden ? undefined : readFence(line)
}

function releaseNoteBlocks(body) {
  const blocks = []
  const comments = { active: false }
  let fence
  let note
  for (const line of body.replaceAll('\r\n', '\n').split('\n')) {
    if (fence === undefined) {
      const match = openingFence(line, comments)
      fence = match?.marker
      note = match?.info.trim() === 'release-note' ? [] : undefined
      continue
    }
    const match = readFence(line)
    if (closesFence(match, fence)) {
      if (note !== undefined) blocks.push(note.join('\n'))
      fence = undefined
      note = undefined
    } else if (note !== undefined) {
      note.push(line)
    }
  }
  if (note !== undefined || blocks.length !== 1)
    throw new Error('Include exactly one closed release-note fenced block in the PR description.')
  return blocks
}

// Only a visible, top-level fence counts. Examples inside another fence or an
// HTML comment do not accidentally satisfy the contract.
export function parseReleaseNote(body) {
  if (typeof body !== 'string' || body.length > 65536)
    throw new Error(
      'PR description must contain one release-note block (at most 65536 characters).'
    )
  const blocks = releaseNoteBlocks(body)
  try {
    return JSON.parse(blocks[0])
  } catch {
    throw new Error(
      'The release-note block must contain valid JSON, without comments or trailing commas.'
    )
  }
}

function validatePackages(note, projects, errors) {
  if (note.packages === 'none') {
    if (note.migration !== 'none')
      errors.push('A no-release-impact note must use migration: "none".')
  } else if (!isObject(note.packages) || Object.keys(note.packages).length === 0) {
    errors.push('Release note packages must map package names to impacts, or be the string "none".')
  } else {
    const publicNames = new Set(
      projects.filter(project => project.release === 'npm-oidc').map(project => project.name)
    )
    for (const [index, [name, impact]] of Object.entries(note.packages).entries()) {
      if (!publicNames.has(name))
        errors.push(`Release note package entry ${index + 1} must name a governed npm package.`)
      if (!IMPACTS.has(impact))
        errors.push(
          `Release note package entry ${index + 1} impact must be patch, minor, major or initial.`
        )
    }
  }
}

export function validateReleaseNote(note, projects) {
  if (!isObject(note)) return ['Release note must be a JSON object.']
  const errors = []
  if (
    Object.keys(note).length !== FIELDS.length ||
    FIELDS.some(field => !Object.hasOwn(note, field))
  )
    errors.push('Release note must contain exactly schemaVersion, packages, summary and migration.')
  if (note.schemaVersion !== 1) errors.push('Release note schemaVersion must be 1.')
  for (const field of ['summary', 'migration']) {
    const value = note[field]
    if (
      typeof value !== 'string' ||
      value.trim() === '' ||
      /^(?:TODO|TBD|N\/A|\.\.\.|<[^>]*>)$/i.test(value.trim())
    )
      errors.push(`Release note ${field} must be nonempty text, not a template placeholder.`)
  }
  if (typeof note.summary === 'string' && note.summary.trim().toLowerCase() === 'none')
    errors.push(
      'Release note summary must describe the change, including when no package is released.'
    )
  validatePackages(note, projects, errors)
  return errors
}

// Fetch on every attempt: an edited description is not reflected in the stored
// event payload when an old workflow run is rerun. No PR text enters a shell.
export async function currentPullRequestBody(env, fetchImpl = fetch) {
  if (
    env.GITHUB_REPOSITORY !== 'bsv-blockchain/ts-stack' ||
    !/^[1-9]\d*$/.test(env.PR_NUMBER ?? '') ||
    !/^[a-f0-9]{40}$/.test(env.PR_HEAD_SHA ?? '') ||
    !env.GH_TOKEN
  )
    throw new Error('Missing or invalid PR identity or read token.')
  const response = await fetchImpl(
    `https://api.github.com/repos/bsv-blockchain/ts-stack/pulls/${env.PR_NUMBER}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${env.GH_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28'
      },
      redirect: 'error',
      signal: AbortSignal.timeout(30000)
    }
  )
  if (!response.ok) throw new Error('Unable to read the current PR description from GitHub.')
  const pr = await response.json()
  if (
    pr.number !== Number(env.PR_NUMBER) ||
    pr.state !== 'open' ||
    pr.base?.repo?.full_name !== env.GITHUB_REPOSITORY ||
    pr.base?.ref !== 'main' ||
    pr.head?.sha !== env.PR_HEAD_SHA
  )
    throw new Error('PR identity or head changed; run CI for the current PR head targeting main.')
  return pr.body
}

export async function checkReleaseNote({
  env = process.env,
  args = process.argv.slice(2),
  fetchImpl = fetch
} = {}) {
  let body
  if (args.length === 2 && args[0] === '--body-file') {
    body = readFileSync(args[1], 'utf8')
  } else if (args.length !== 0) {
    throw new Error('Usage: node scripts/pr-release-note.mjs [--body-file description.md]')
  } else {
    if (env.GITHUB_EVENT_NAME !== 'pull_request')
      return 'PR release note: not a pull_request event.'
    body = await currentPullRequestBody(env, fetchImpl)
  }
  const { projects } = JSON.parse(
    readFileSync(new URL('../governance/repository-health/projects.json', import.meta.url), 'utf8')
  )
  const errors = validateReleaseNote(parseReleaseNote(body), projects)
  if (errors.length > 0) throw new Error(errors.join('\n'))
  return 'PR release note structure passed. Reviewers assess package scope, SemVer, summary and migration accuracy.'
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    console.log(await checkReleaseNote())
  } catch (error) {
    // JSON/parser and remote response text are never echoed into Actions logs.
    console.error(error instanceof Error ? error.message : 'PR release note validation failed.')
    process.exitCode = 1
  }
}
