#!/usr/bin/env node

// Dependabot version updates move direct dependencies only. This refresh
// re-resolves every lockfile entry to the newest release the committed
// manifests already allow, so the grouped maintenance pull request also
// carries transitive patch, minor, and advisory fixes. Manifests never change,
// first-party @bsv/* resolutions stay owned by release synchronization, and no
// lifecycle script runs.

import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = fileURLToPath(new URL('..', import.meta.url))
const POLICY_PATH = path.join(ROOT, 'governance/dependency-release-policy.json')
const GIT_EXECUTABLE =
  process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git'
const isFirstParty = name => name.startsWith('@bsv/')
const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json'])

const packageNameFromLockKey = key => key.split('node_modules/').pop()

// Names of every registry package in an npm lockfile, excluding the root
// project, linked workspaces, and first-party packages.
export function npmRefreshNames(lock) {
  const names = new Set()
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (!key.includes('node_modules/') || entry.link) continue
    const name = packageNameFromLockKey(key)
    if (!isFirstParty(name)) names.add(name)
  }
  return [...names].sort((left, right) => left.localeCompare(right))
}

export function firstPartyResolutionChanges(before, after) {
  const keys = new Set([
    ...Object.keys(before.packages ?? {}),
    ...Object.keys(after.packages ?? {})
  ])
  const changes = []
  for (const key of [...keys].sort((left, right) => left.localeCompare(right))) {
    if (!isFirstParty(packageNameFromLockKey(key)) || !key.includes('node_modules/')) continue
    const previous = before.packages?.[key]?.version
    const next = after.packages?.[key]?.version
    if (previous !== next) changes.push(`${key} ${previous ?? 'absent'} -> ${next ?? 'absent'}`)
  }
  return changes
}

export function nonLockfileChanges(files) {
  return files.filter(file => !LOCKFILES.has(path.posix.basename(file)))
}

function git(args) {
  return execFileSync(GIT_EXECUTABLE, args, { cwd: ROOT, encoding: 'utf8' })
}

function changedFiles(pathspec = []) {
  return git(['diff', '--name-only', 'HEAD', '--', ...pathspec])
    .split(/\r?\n/)
    .filter(Boolean)
}

function restore(files) {
  if (files.length > 0) git(['checkout', 'HEAD', '--', ...files])
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args[0]} exited with ${result.status}`)
}

function npmProjects() {
  return git(['ls-files', '--', 'infra/**/package-lock.json'])
    .split(/\r?\n/)
    .filter(Boolean)
    .map(file => path.posix.dirname(file))
    .sort((left, right) => left.localeCompare(right))
}

// pnpm update raises manifest floors to the resolved versions. Restoring the
// manifests and relocking keeps the newer resolutions, which still satisfy the
// original ranges. pnpm-workspace.yaml supplies the release-age delay and
// trust policy for this graph.
function refreshPnpm() {
  try {
    run('pnpm', ['update', '--recursive', '--lockfile-only', '--ignore-scripts', '!@bsv/*'], ROOT)
    restore(nonLockfileChanges(changedFiles()))
    run('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], ROOT)
  } catch (error) {
    restore(changedFiles())
    throw error
  }
}

// npm cannot exclude packages by pattern, so name every non-first-party
// package explicitly. --before applies the same release-age delay as pnpm.
function refreshNpm(directory, before) {
  const lockPath = `${directory}/package-lock.json`
  const previous = JSON.parse(git(['show', `HEAD:${lockPath}`]))
  try {
    run(
      'npm',
      [
        'update',
        '--package-lock-only',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        `--before=${before}`,
        ...npmRefreshNames(previous)
      ],
      path.join(ROOT, directory)
    )
    const firstParty = firstPartyResolutionChanges(
      previous,
      JSON.parse(fs.readFileSync(path.join(ROOT, lockPath), 'utf8'))
    )
    if (firstParty.length > 0) {
      throw new Error(`first-party resolutions moved:\n${firstParty.join('\n')}`)
    }
    const manifests = nonLockfileChanges(changedFiles([directory]))
    if (manifests.length > 0) throw new Error(`unexpected changes: ${manifests.join(', ')}`)
  } catch (error) {
    restore(changedFiles([directory]))
    throw error
  }
}

function summary(results) {
  const lines = ['## Lockfile refresh', '', '| Target | Result |', '| --- | --- |']
  for (const { target, error } of results) {
    const firstLine = error?.split('\n')[0]
    const result = error ? `failed: ${firstLine}` : 'refreshed'
    lines.push(`| \`${target}\` | ${result} |`)
  }
  const changed = changedFiles()
    .map(file => `\`${file}\``)
    .join(', ')
  lines.push('', changed ? `Changed: ${changed}` : 'No lockfile changes.')
  return `${lines.join('\n')}\n`
}

function main(args) {
  const summaryIndex = args.indexOf('--summary-file')
  const summaryFile = summaryIndex >= 0 ? args[summaryIndex + 1] : undefined
  if (changedFiles().length > 0) throw new Error('lockfile refresh requires a clean working tree')

  const policy = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
  const releaseAgeDays = policy.routineUpdates.lockfileRefresh.releaseAgeDays
  const before = new Date(Date.now() - releaseAgeDays * 86_400_000).toISOString()

  const results = []
  for (const [target, refresh] of [
    ['pnpm-lock.yaml', refreshPnpm],
    ...npmProjects().map(directory => [
      `${directory}/package-lock.json`,
      () => refreshNpm(directory, before)
    ])
  ]) {
    try {
      refresh()
      results.push({ target })
    } catch (error) {
      console.error(`::error title=Lockfile refresh::${target}: ${error.message}`)
      results.push({ target, error: error.message })
    }
  }

  const unexpected = nonLockfileChanges(changedFiles())
  if (unexpected.length > 0) {
    restore(changedFiles())
    throw new Error(`refresh changed non-lockfile paths: ${unexpected.join(', ')}`)
  }
  const report = summary(results)
  if (summaryFile) fs.appendFileSync(summaryFile, report)
  else process.stdout.write(report)
  if (results.some(result => result.error)) process.exitCode = 1
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
