#!/usr/bin/env node

// Label open pull requests by the package and infra folders their diff touches.
// A pull request that already has any label this script manages is skipped
// before its files are read. Labels are only added, never removed.

import { existsSync, readdirSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const LABEL_COLOR = 'c5def5'
export const REPOSITORY = 'bsv-blockchain/ts-stack'
const LABEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,49}$/
const MANAGED_DESCRIPTION = /^Touches (?:packages|infra)\/(\S+)$/
const API_ORIGIN = 'https://api.github.com'
const FILE_CAP = 3000
const MAX_ATTEMPTS = 4

const comparePath = (left, right) => left.localeCompare(right)

function assertLabelName(name) {
  if (!LABEL_NAME.test(name)) throw new Error(`Area folder name cannot be a label: ${name}`)
}

function area(path) {
  const label = path.split('/').at(-1)
  assertLabelName(label)
  return { label, path, description: `Touches ${path}` }
}

function readDirectory(path) {
  return readdirSync(path, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name !== 'node_modules')
    .sort((left, right) => comparePath(left.name, right.name))
}

function findPackageRoots(packagesDirectory, directory = packagesDirectory) {
  const entries = readdirSync(directory, { withFileTypes: true })
  const hasManifest = entries.some(entry => entry.isFile() && entry.name === 'package.json')
  if (hasManifest) {
    const relativePath = relative(packagesDirectory, directory).split(sep).join('/')
    return [area(`packages/${relativePath}`)]
  }
  const roots = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue
    roots.push(...findPackageRoots(packagesDirectory, join(directory, entry.name)))
  }
  return roots.sort((left, right) => comparePath(left.path, right.path))
}

function findInfra(infraDirectory) {
  const components = []
  const excluded = []
  for (const entry of readDirectory(infraDirectory)) {
    if (existsSync(join(infraDirectory, entry.name, 'package.json'))) components.push(entry.name)
    else excluded.push(entry.name)
  }
  return { components, excluded }
}

export function discoverAreaCatalog(root) {
  const packagesDirectory = join(root, 'packages')
  const packageRoots = findPackageRoots(packagesDirectory)
  const directPackages = new Set(
    packageRoots
      .filter(item => !item.path.slice('packages/'.length).includes('/'))
      .map(item => item.label)
  )
  const groups = readDirectory(packagesDirectory)
    .map(entry => entry.name)
    .filter(name => !directPackages.has(name))
  const infra = findInfra(join(root, 'infra'))
  const labels = new Set()
  for (const item of packageRoots) {
    if (labels.has(item.label)) throw new Error(`Duplicate area label: ${item.label}`)
    labels.add(item.label)
  }
  const infraComponents = infra.components.map(name => {
    const item = area(`infra/${name}`)
    if (labels.has(item.label)) throw new Error(`Duplicate area label: ${item.label}`)
    labels.add(item.label)
    return item
  })
  return { packageRoots, groups, infraComponents, infraExcluded: infra.excluded, labels }
}

function safeChangedPath(file) {
  if (typeof file !== 'string' || file === '' || file.startsWith('/') || file.includes('\\'))
    return undefined
  if (file.split('/').includes('..')) return undefined
  return file
}

function matchesPrefix(file, prefix) {
  return file === prefix || file.startsWith(`${prefix}/`)
}

function knownPackage(file, catalog) {
  let match
  for (const item of catalog.packageRoots) {
    if (!matchesPrefix(file, item.path)) continue
    if (!match || item.path.length > match.path.length) match = item
  }
  return match
}

function inferredPackage(file, catalog) {
  const parts = file.split('/')
  if (parts[0] !== 'packages' || parts.length < 3) return undefined
  const [group, name] = [parts[1], parts[2]]
  if (catalog.groups.includes(group)) {
    if (parts.length < 4 || !LABEL_NAME.test(name)) return undefined
    return area(`packages/${group}/${name}`)
  }
  if (!LABEL_NAME.test(group)) return undefined
  return area(`packages/${group}`)
}

function infraArea(file, catalog) {
  const parts = file.split('/')
  if (parts[0] !== 'infra' || parts.length < 3) return undefined
  const name = parts[1]
  if (catalog.infraExcluded.includes(name) || !LABEL_NAME.test(name)) return undefined
  return catalog.infraComponents.find(item => item.label === name) ?? area(`infra/${name}`)
}

export function areasForChangedPath(file, catalog) {
  const path = safeChangedPath(file)
  if (!path) return []
  const areas = []
  const packageArea = knownPackage(path, catalog) ?? inferredPackage(path, catalog)
  if (packageArea) areas.push(packageArea)
  const component = infraArea(path, catalog)
  if (component) areas.push(component)
  return areas
}

export function areasForChangedPaths(paths, catalog) {
  const byLabel = new Map()
  for (const file of paths) {
    for (const item of areasForChangedPath(file, catalog)) {
      if (!byLabel.has(item.label)) byLabel.set(item.label, item)
    }
  }
  return [...byLabel.values()].sort((left, right) => comparePath(left.label, right.label))
}

export function changedPaths(files) {
  const paths = []
  for (const file of files) {
    for (const candidate of [file?.filename, file?.previous_filename]) {
      const path = safeChangedPath(candidate)
      if (path) paths.push(path)
    }
  }
  return paths
}

export function isManagedAreaLabel(label, catalog) {
  const name = typeof label === 'string' ? label : label?.name
  if (typeof name !== 'string' || !LABEL_NAME.test(name)) return false
  if (catalog.labels.has(name)) return true
  if (typeof label === 'string') return false
  const described = MANAGED_DESCRIPTION.exec(label.description ?? '')
  return described !== null && described[1].split('/').at(-1) === name
}

export function hasManagedAreaLabel(labels, catalog) {
  return (labels ?? []).some(label => isManagedAreaLabel(label, catalog))
}

function repositoryParts(repository) {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(repository ?? '')
  if (!match || `${match[1]}/${match[2]}` !== REPOSITORY)
    throw new Error('Area labeling runs only for bsv-blockchain/ts-stack.')
  return { owner: match[1], repo: match[2] }
}

function assertGitHubUrl(value, owner, repo) {
  const url = new URL(value)
  const prefix = `/repos/${owner}/${repo}/`
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith(prefix))
    throw new Error('Refusing a URL outside this repository GitHub API.')
  return url
}

function linkTarget(part, relation) {
  const trimmed = part.trim()
  if (!trimmed.startsWith('<')) return undefined
  const close = trimmed.indexOf('>')
  if (close < 2) return undefined
  const parameters = trimmed
    .slice(close + 1)
    .split(';')
    .map(parameter => parameter.trim())
    .filter(parameter => parameter !== '')
  if (!parameters.includes(`rel="${relation}"`)) return undefined
  return trimmed.slice(1, close)
}

function nextPage(link, owner, repo) {
  if (!link) return undefined
  for (const part of link.split(',')) {
    const target = linkTarget(part, 'next')
    if (target) return assertGitHubUrl(target, owner, repo).toString()
  }
  return undefined
}

function retryDelay(response, attempt) {
  const header = Number(response.headers.get('retry-after'))
  if (Number.isFinite(header) && header > 0) return Math.min(header, 30) * 1000
  return Math.min(1000 * 2 ** attempt, 8000)
}

function shouldRetry(response) {
  if (response.status === 429 || response.status === 502 || response.status === 503) return true
  if (response.status !== 403) return false
  return (
    Boolean(response.headers.get('retry-after')) ||
    response.headers.get('x-ratelimit-remaining') === '0'
  )
}

async function github(state, target, options = {}) {
  const url =
    typeof target === 'string' && target.startsWith('https://')
      ? assertGitHubUrl(target, state.owner, state.repo)
      : assertGitHubUrl(`${state.base}${target}`, state.owner, state.repo)
  const method = options.method ?? 'GET'
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const response = await state.fetchImpl(url, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${state.token}`,
        'User-Agent': 'ts-stack-pr-area-labels',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(30_000)
    })
    if (shouldRetry(response) && attempt < MAX_ATTEMPTS - 1) {
      await response.body?.cancel?.()
      await state.sleep(retryDelay(response, attempt))
      continue
    }
    const text = await response.text()
    let body
    if (text) {
      try {
        body = JSON.parse(text)
      } catch {
        body = undefined
      }
    }
    return { status: response.status, ok: response.ok, headers: response.headers, body }
  }
  throw new Error('GitHub request did not finish.')
}

async function listPages(state, next, cap, items = [], pages = 0) {
  if (!next) return items
  if (pages >= 100) throw new Error('GitHub list did not finish within the page limit.')
  const response = await github(state, next)
  if (!response.ok || !Array.isArray(response.body))
    throw new Error(`GitHub list failed with status ${response.status}.`)
  const combined = items.concat(response.body)
  if (cap !== undefined && combined.length > cap)
    throw new Error('Changed-file list exceeded the GitHub 3000-file cap. No labels were added.')
  return listPages(
    state,
    nextPage(response.headers.get('link'), state.owner, state.repo),
    cap,
    combined,
    pages + 1
  )
}

async function ensureLabel(state, item) {
  const lookup = await github(state, `/labels/${encodeURIComponent(item.label)}`)
  if (lookup.status === 200) return
  if (lookup.status !== 404)
    throw new Error(`Unable to read label ${item.label} (${lookup.status}).`)
  const created = await github(state, '/labels', {
    method: 'POST',
    body: { name: item.label, color: LABEL_COLOR, description: item.description }
  })
  if (created.status === 201) return
  if (created.status === 422) {
    const again = await github(state, `/labels/${encodeURIComponent(item.label)}`)
    if (again.status === 200) return
  }
  throw new Error(`Unable to create label ${item.label} (${created.status}).`)
}

async function ensureAreas(state, areas, index = 0) {
  if (index >= areas.length) return
  await ensureLabel(state, areas[index])
  await ensureAreas(state, areas, index + 1)
}

async function labelPullRequest(state, pullRequest) {
  const number = pullRequest?.number
  if (!Number.isInteger(number) || number < 1) throw new Error('Pull request number is invalid.')
  if (hasManagedAreaLabel(pullRequest.labels, state.catalog)) {
    state.log(`#${number} skipped; an area label is already present.`)
    return 'skipped'
  }
  const files = await listPages(state, `${state.base}/pulls/${number}/files?per_page=100`, FILE_CAP)
  const areas = areasForChangedPaths(changedPaths(files), state.catalog)
  if (areas.length === 0) {
    state.log(`#${number} has no package or infra area.`)
    return 'unchanged'
  }
  await ensureAreas(state, areas)
  const added = await github(state, `/issues/${number}/labels`, {
    method: 'POST',
    body: { labels: areas.map(item => item.label) }
  })
  if (!added.ok) throw new Error(`Unable to add labels to #${number} (${added.status}).`)
  state.log(`#${number} labeled ${areas.map(item => item.label).join(', ')}.`)
  return 'labeled'
}

export async function labelOpenPullRequests({
  repository = process.env.GITHUB_REPOSITORY,
  token = process.env.GITHUB_TOKEN,
  root = fileURLToPath(new URL('..', import.meta.url)),
  catalog,
  fetchImpl = globalThis.fetch,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  log = console.log
} = {}) {
  if (!token) throw new Error('GITHUB_TOKEN is required.')
  const { owner, repo } = repositoryParts(repository)
  const state = {
    owner,
    repo,
    token,
    base: `${API_ORIGIN}/repos/${owner}/${repo}`,
    catalog: catalog ?? discoverAreaCatalog(root),
    fetchImpl,
    sleep,
    log
  }
  const pullRequests = await listPages(state, `${state.base}/pulls?state=open&per_page=100`)
  const summary = { open: pullRequests.length, skipped: 0, labeled: 0, unchanged: 0, failed: [] }
  await labelEach(state, pullRequests, 0, summary)
  state.log(
    `Open ${summary.open}; skipped ${summary.skipped}; labeled ${summary.labeled}; unchanged ${summary.unchanged}; failed ${summary.failed.length}.`
  )
  if (summary.failed.length > 0)
    throw new Error(`Area labeling failed for pull requests: ${summary.failed.join(', ')}.`)
  return summary
}

async function labelEach(state, pullRequests, index, summary) {
  if (index >= pullRequests.length) return
  const pullRequest = pullRequests[index]
  try {
    const result = await labelPullRequest(state, pullRequest)
    summary[result] += 1
  } catch (error) {
    const number = pullRequest?.number
    summary.failed.push(number)
    state.log(
      `#${number ?? '?'} failed: ${error instanceof Error ? error.message : 'labeling failed.'}`
    )
  }
  await labelEach(state, pullRequests, index + 1, summary)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    await labelOpenPullRequests()
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Area labeling failed.')
    process.exitCode = 1
  }
}
