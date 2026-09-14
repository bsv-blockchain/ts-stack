import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function revision(root, ref) {
  return git(root, 'rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`).trim()
}

function changedBetween(root, base, head, mergeBase) {
  const range = `${revision(root, base)}${mergeBase ? '...' : '..'}${revision(root, head)}`
  return git(root, 'diff', '--name-only', '--no-renames', '-z', range, '--')
    .split('\0')
    .filter(Boolean)
}

function githubChangedFiles(root, env) {
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'))
  if (env.GITHUB_EVENT_NAME === 'pull_request') {
    return changedBetween(root, event.pull_request.base.sha, event.pull_request.head.sha, true)
  }
  if (env.GITHUB_EVENT_NAME === 'push') {
    if (/^0+$/.test(event.before)) {
      return git(root, 'ls-tree', '--name-only', '-r', '-z', revision(root, event.after), '--')
        .split('\0')
        .filter(Boolean)
    }
    return changedBetween(root, event.before, event.after, false)
  }
  // Release, scheduled, and manual runs have no PR scope. Structural and
  // generated-content checks still run; --all opts into the maintenance audit.
  return []
}

// null is the explicit full audit; an empty array means no affected pages.
export function documentationChangedFiles(root, args = [], env = process.env) {
  const { values } = parseArgs({
    args,
    options: {
      all: { type: 'boolean' },
      base: { type: 'string' },
      head: { type: 'string' }
    }
  })
  if ((values.all && (values.base || values.head)) || (values.head && !values.base)) {
    throw new Error('Use --all or --base <ref> [--head <ref>]')
  }
  if (values.all) return null
  if (values.base) return changedBetween(root, values.base, values.head ?? 'HEAD', true)
  if (env.GITHUB_EVENT_PATH) return githubChangedFiles(root, env)

  // Include committed branch changes, staged/unstaged edits, and new local pages.
  return [
    ...new Set(
      [
        ...changedBetween(root, 'origin/main', 'HEAD', true),
        ...git(root, 'diff', '--name-only', '--no-renames', '-z', 'HEAD', '--').split('\0'),
        ...git(root, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')
      ].filter(Boolean)
    )
  ]
}

function under(file, source) {
  return file === source || file.startsWith(`${source}/`)
}

export function documentationSources(docPath, title, projects, services, sourcePaths) {
  const sources = [...(sourcePaths[docPath] ?? [])]
  const project = projects.find(item => item.name === title && item.path !== '.')
  if (docPath.startsWith('docs/packages/') && project) {
    sources.push(project.path, ...(project.sourceRoots ?? []))
  }
  for (const service of services) {
    if (docPath === `docs/infrastructure/${service.name}.md` || docPath === service.operatorGuide) {
      sources.push(service.path)
    }
  }
  return sources
}

export function documentationIsAffected(docPath, sources, changedFiles) {
  return (
    changedFiles === null ||
    changedFiles.some(file => file === docPath || sources.some(source => under(file, source)))
  )
}

export function documentationDateFindings(updated, verified, cadence, today, affected) {
  const findings = []
  if (updated > verified) findings.push('last_verified predates last_updated')
  const verifiedDate = new Date(`${verified}T00:00:00Z`)
  const staleAfter = new Date(verifiedDate)
  staleAfter.setUTCDate(staleAfter.getUTCDate() + cadence)
  if (affected && staleAfter < today) {
    findings.push(`verification expired ${staleAfter.toISOString().slice(0, 10)}`)
  }
  if (verifiedDate > today) findings.push('last_verified cannot be in the future')
  return findings
}
