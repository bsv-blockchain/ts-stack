#!/usr/bin/env node

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildMutationTargets } from '../governance/mutation-testing/targets.mjs'
import {
  changedLockfileImporters,
  conformanceIsAffected,
  docsAreAffected,
  selectInfraComponents,
  selectWorkspaceScope
} from './ci-affected-scope.mjs'
import { selectAffectedMutationTargets } from './mutation-testing.mjs'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const GIT_EXECUTABLE =
  process.platform === 'win32' ? String.raw`C:\Program Files\Git\cmd\git.exe` : '/usr/bin/git'
const SINGLE_QUOTE_ESCAPE = String.raw`'\''`
const quote = value => `'${value.replaceAll("'", SINGLE_QUOTE_ESCAPE)}'`
const packageCommand = (name, script) => `pnpm --filter ${quote(name)} run ${script}`

function comparePaths(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function git(root, arguments_) {
  return execFileSync(GIT_EXECUTABLE, arguments_, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024
  })
}

export function localChangedFiles(root, base) {
  if (!base) throw new Error('--base must name the intended PR baseline')
  const baseline = git(root, [
    'rev-parse',
    '--verify',
    '--end-of-options',
    `${base}^{commit}`
  ]).trim()
  // Include both ends of moves, all commits since the merge base, staged and
  // unstaged changes, and authored untracked files. Never inspect ignored builds.
  const changes = [
    git(root, ['diff', '--no-renames', '--name-only', '-z', `${baseline}...HEAD`, '--']),
    git(root, ['diff', '--cached', '--no-renames', '--name-only', '-z', 'HEAD', '--']),
    git(root, ['diff', '--no-renames', '--name-only', '-z', '--']),
    git(root, ['ls-files', '--others', '--exclude-standard', '-z'])
  ]
  return {
    baseline,
    files: [...new Set(changes.flatMap(value => value.split('\0').filter(Boolean)))].sort(
      comparePaths
    )
  }
}

export function localChangedImporters(root, baseline) {
  const before = git(root, ['show', `${baseline}:pnpm-lock.yaml`])
  const versions = [
    git(root, ['show', 'HEAD:pnpm-lock.yaml']),
    git(root, ['show', ':pnpm-lock.yaml']),
    readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8')
  ]
  return [...new Set(versions.flatMap(after => changedLockfileImporters(before, after)))].sort(
    comparePaths
  )
}

function packageChecks(project, direct) {
  const scripts = project.manifest.scripts ?? {}
  const ordinary = direct && scripts['test:coverage'] ? 'test:coverage' : 'test'
  const commands = scripts[ordinary] ? [packageCommand(project.name, ordinary)] : []
  const contracts = ['pack:check', 'test:browser', 'test:mobile', 'test:consumers']
  if (project.criticality === 'tier-0' && scripts['test:property']) contracts.push('test:property')
  return [
    ...commands,
    ...contracts
      .filter(script => scripts[script])
      .map(script => packageCommand(project.name, script))
  ]
}

export function planLocalFeedback(
  projects,
  changedFiles,
  changedImporters = [],
  mutationTargets = []
) {
  const scope = selectWorkspaceScope(projects, changedFiles, changedImporters)
  const affected = projects.filter(project => scope.affected.includes(project.name))
  const build = scope.build.map(name => `--filter ${quote(name)}`).join(' ')
  const beforePush = [
    ...(build ? [`pnpm -r ${build} --if-present run build`] : []),
    'pnpm health:check',
    'pnpm lint',
    'pnpm format:check',
    'pnpm audit:security',
    'pnpm typecheck',
    ...affected.flatMap(project => packageChecks(project, scope.direct.includes(project.name)))
  ]
  if (docsAreAffected(changedFiles)) beforePush.push('pnpm docs:facts:check', 'pnpm docs:build')
  if (conformanceIsAffected(changedFiles)) beforePush.push('pnpm conformance')
  beforePush.push(...mutationTargets.map(target => `pnpm test:mutation --target ${quote(target)}`))
  return {
    changedFiles,
    scope,
    criticalProjects: affected
      .filter(project => project.criticality === 'tier-0')
      .map(project => project.name),
    mutationTargets,
    infrastructure: selectInfraComponents(changedFiles).map(entry => entry.component),
    beforePush: [...new Set(beforePush)],
    limits: [
      'Advisory local plan; it does not authorize remote scope skips or replace exact-head qualification.',
      'Review changed invariants and trust boundaries; path/dependency selection alone cannot prove test completeness.',
      'Use focused negative/regression tests during editing; run the batch checks once before pushing.',
      'Commands validate working-tree bytes: align the index/worktree before treating them as pre-push evidence.',
      'Cold checkout: install frozen dependencies with scripts disabled, rebuild audited tools, and build the workspace before global typecheck.',
      'Run printed command snippets in a POSIX shell; on Windows use Git Bash with the standard Git installation.',
      'Git uses the fixed system installation (/usr/bin/git, or the default Program Files Git on Windows), never a workspace PATH executable.',
      'Package test/consumer commands may build internally; inspect their scripts before measuring setup or claiming a duplicate-build saving.',
      'Local Linux/native/live requirements still follow the affected service/platform profile.'
    ]
  }
}

function loadProjects(root) {
  const registry = JSON.parse(
    readFileSync(path.join(root, 'governance/repository-health/projects.json'), 'utf8')
  )
  return registry.projects.map(project => {
    const manifest = JSON.parse(readFileSync(path.join(root, project.path, 'package.json'), 'utf8'))
    return { ...project, manifest, name: manifest.name }
  })
}

function editChecks(root, files) {
  const existing = files.filter(file => existsSync(path.join(root, file)))
  const formatted = existing.filter(file => /\.(?:[cm]?[jt]sx?|json|md|ya?ml)$/.test(file))
  const linted = existing.filter(file => /\.[cm]?[jt]sx?$/.test(file))
  const tests = [
    ...new Set(
      existing.flatMap(file => {
        if (!file.startsWith('scripts/') || !file.endsWith('.mjs')) return []
        const candidate = file.endsWith('.test.mjs') ? file : file.replace(/\.mjs$/, '.test.mjs')
        return existsSync(path.join(root, candidate)) ? [candidate] : []
      })
    )
  ]
  return [
    ...(tests.length ? [`node --test ${tests.map(quote).join(' ')}`] : []),
    ...(linted.length ? [`pnpm exec oxlint ${linted.map(quote).join(' ')} --deny-warnings`] : []),
    ...(formatted.length ? [`pnpm exec prettier --check ${formatted.map(quote).join(' ')}`] : [])
  ]
}

function localMutationTargets(root, files, importers) {
  const targets = buildMutationTargets(root)
  const controls = new Set([
    'governance/mutation-testing/targets.mjs',
    'governance/mutation-testing/policy.json'
  ])
  return files.some(file => controls.has(file))
    ? Object.keys(targets)
    : selectAffectedMutationTargets(targets, files, { changedImporters: importers })
}

function main(arguments_) {
  const valid = arguments_.length === 2 || (arguments_.length === 3 && arguments_[2] === '--json')
  if (!valid || arguments_[0] !== '--base' || !arguments_[1]) {
    throw new Error('Usage: ci-local-feedback.mjs --base <intended PR base> [--json]')
  }
  const { baseline, files } = localChangedFiles(REPOSITORY_ROOT, arguments_[1])
  const importers = files.includes('pnpm-lock.yaml')
    ? localChangedImporters(REPOSITORY_ROOT, baseline)
    : []
  const plan = {
    baseline,
    ...planLocalFeedback(
      loadProjects(REPOSITORY_ROOT),
      files,
      importers,
      localMutationTargets(REPOSITORY_ROOT, files, importers)
    ),
    editLoop: editChecks(REPOSITORY_ROOT, files)
  }
  if (arguments_.includes('--json')) process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`)
  else {
    process.stdout.write(
      `Local feedback plan: ${files.length} changed paths; ${plan.scope.affected.length} affected projects.\n`
    )
    for (const [heading, commands] of [
      ['During editing', plan.editLoop],
      ['Before the next batch push', plan.beforePush]
    ]) {
      process.stdout.write(`\n${heading}:\n${commands.join('\n')}\n`)
    }
    process.stdout.write(`\n${plan.limits.join('\n')}\n`)
    if (plan.infrastructure.length)
      process.stdout.write(`Affected service profiles: ${plan.infrastructure.join(', ')}\n`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Local feedback planning failed.')
    process.exitCode = 1
  }
}
