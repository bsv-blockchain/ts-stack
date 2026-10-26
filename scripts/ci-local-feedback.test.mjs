import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  localChangedFiles,
  localChangedImporters,
  planLocalFeedback
} from './ci-local-feedback.mjs'

function project(name, dependencies = {}, criticality = 'tier-1') {
  return {
    name,
    path: `packages/${name}`,
    criticality,
    manifest: {
      dependencies,
      scripts: { test: 'test', 'test:coverage': 'coverage', 'test:property': 'property' }
    }
  }
}

test('local plan separates direct coverage from dependent regression and preserves root checks', () => {
  const plan = planLocalFeedback(
    [project('a', {}, 'tier-0'), project('b', { a: '*' })],
    ['packages/a/src/api.ts'],
    [],
    ['critical-a']
  )
  assert.deepEqual(plan.scope.direct, ['a'])
  assert.deepEqual(plan.scope.affected, ['a', 'b'])
  assert.ok(plan.beforePush.includes("pnpm --filter 'a' run test:coverage"))
  assert.ok(!plan.beforePush.includes("pnpm --filter 'a' run test"))
  assert.ok(plan.beforePush.includes("pnpm --filter 'b' run test"))
  assert.ok(!plan.beforePush.includes("pnpm --filter 'b' run test:coverage"))
  assert.ok(plan.beforePush.includes("pnpm --filter 'a' run test:property"))
  assert.ok(plan.beforePush.includes("pnpm test:mutation --target 'critical-a'"))
  for (const script of ['health:check', 'lint', 'format:check', 'audit:security', 'typecheck']) {
    assert.ok(plan.beforePush.includes(`pnpm ${script}`))
  }
})

test('build prerequisites do not become duplicate regression or coverage obligations', () => {
  const plan = planLocalFeedback(
    [project('a'), project('b', { a: '*' })],
    ['packages/b/src/api.ts']
  )
  assert.deepEqual(plan.scope.build, ['a', 'b'])
  assert.deepEqual(plan.scope.affected, ['b'])
  assert.ok(plan.beforePush[0].includes("--filter 'a' --filter 'b'"))
  assert.ok(!plan.beforePush.includes("pnpm --filter 'a' run test:coverage"))
})

test('documentation avoids unrelated package campaigns; shared controls still select the full graph', () => {
  const projects = [project('a'), project('b')]
  const documentation = planLocalFeedback(projects, ['packages/a/README.md'])
  assert.deepEqual(documentation.scope.affected, [])
  assert.ok(documentation.beforePush.includes('pnpm docs:facts:check'))
  const controls = planLocalFeedback(projects, ['pnpm-workspace.yaml'])
  assert.deepEqual(controls.scope.affected, ['a', 'b'])
  assert.ok(controls.beforePush.includes('pnpm audit:security'))
})

test('working-tree planning includes commit history, both rename endpoints, staged/unstaged/untracked paths', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ts-stack-local-feedback-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = arguments_ => execFileSync('git', arguments_, { cwd: root, stdio: 'pipe' })
  const write = (file, body) => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), body)
  }
  git(['init', '-q'])
  git(['config', 'user.name', 'Local feedback test'])
  git(['config', 'user.email', 'local-feedback@example.test'])
  write('.gitignore', 'build/\n')
  write('packages/a/old.ts', 'export const value = 1\n')
  write('staged.md', 'before\n')
  write('unstaged.md', 'before\n')
  git(['add', '.'])
  git(['commit', '-qm', 'base'])
  const base = git(['rev-parse', 'HEAD']).toString().trim()
  mkdirSync(path.join(root, 'packages/b'), { recursive: true })
  renameSync(path.join(root, 'packages/a/old.ts'), path.join(root, 'packages/b/new.ts'))
  git(['add', '.'])
  git(['commit', '-qm', 'move'])
  write('staged.md', 'staged\n')
  git(['add', 'staged.md'])
  write('unstaged.md', 'unstaged\n')
  write('notes with space.md', 'new\n')
  write('build/ignored.ts', 'generated\n')
  assert.deepEqual(localChangedFiles(root, base).files, [
    'notes with space.md',
    'packages/a/old.ts',
    'packages/b/new.ts',
    'staged.md',
    'unstaged.md'
  ])
  // A writable PATH entry must not replace the planner's system Git executable.
  write('build/git', '#!/bin/sh\nexit 77\n')
  chmodSync(path.join(root, 'build/git'), 0o755)
  const originalPath = process.env.PATH
  try {
    process.env.PATH = `${path.join(root, 'build')}${path.delimiter}${originalPath}`
    assert.ok(localChangedFiles(root, base).files.includes('staged.md'))
  } finally {
    process.env.PATH = originalPath
  }
  assert.throws(() => localChangedFiles(root, ''), /intended PR baseline/)
  assert.throws(() => localChangedFiles(root, 'missing-baseline'))
})

test('staged source and importer edits remain selected when working tree restores HEAD', t => {
  const root = mkdtempSync(path.join(tmpdir(), 'ts-stack-staged-feedback-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = arguments_ => execFileSync('git', arguments_, { cwd: root, stdio: 'pipe' })
  const lock = version => `lockfileVersion: '9.0'
importers:
  packages/a:
    dependencies:
      external:
        specifier: ${version}
        version: ${version}
`
  git(['init', '-q'])
  git(['config', 'user.name', 'Local feedback test'])
  git(['config', 'user.email', 'local-feedback@example.test'])
  writeFileSync(path.join(root, 'tracked.ts'), 'original\n')
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), lock('1.0.0'))
  git(['add', '.'])
  git(['commit', '-qm', 'base'])
  const base = git(['rev-parse', 'HEAD']).toString().trim()
  writeFileSync(path.join(root, 'tracked.ts'), 'staged\n')
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), lock('1.0.1'))
  git(['add', '.'])
  writeFileSync(path.join(root, 'tracked.ts'), 'original\n')
  writeFileSync(path.join(root, 'pnpm-lock.yaml'), lock('1.0.0'))
  assert.deepEqual(localChangedFiles(root, base).files, ['pnpm-lock.yaml', 'tracked.ts'])
  assert.deepEqual(localChangedImporters(root, base), ['packages/a'])
  const plan = planLocalFeedback(
    [project('a')],
    ['pnpm-lock.yaml'],
    localChangedImporters(root, base)
  )
  assert.deepEqual(plan.scope.direct, ['a'])
  assert.ok(plan.limits.some(limit => limit.includes('working-tree bytes')))
})
