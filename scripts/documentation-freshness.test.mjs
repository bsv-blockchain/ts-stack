import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  documentationChangedFiles,
  documentationDateFindings,
  documentationIsAffected,
  documentationSources
} from './documentation-freshness.mjs'

const root = new URL('..', import.meta.url)
const readJson = file => JSON.parse(readFileSync(new URL(file, root), 'utf8'))
const { projects } = readJson('governance/repository-health/projects.json')
const { services } = readJson('governance/service-operations.json')
const { freshness } = readJson('governance/documentation-policy.json')
const sources = (docPath, title) =>
  documentationSources(docPath, title, projects, services, freshness.sourcePaths)
const affected = (docPath, title, files) =>
  documentationIsAffected(docPath, sources(docPath, title), files)

test('a relay change does not inherit unrelated expired documentation', () => {
  const files = ['packages/wallet/ts-wallet-relay/src/server.ts']
  assert.equal(affected('docs/packages/wallet/wallet-relay.md', '@bsv/wallet-relay', files), true)
  for (const doc of [
    'docs/architecture/wallet-utxo-lifecycle.md',
    'docs/infrastructure/chaintracks-server.md',
    'docs/infrastructure/wab.md',
    'docs/reference/service-operations.md'
  ]) {
    assert.equal(affected(doc, undefined, files), false, doc)
  }
})

test('service, architecture, and shared-source pages follow their own code', () => {
  assert.equal(
    affected('docs/infrastructure/chaintracks-server.md', undefined, [
      'infra/chaintracks-server/src/index.ts'
    ]),
    true
  )
  assert.equal(affected('docs/infrastructure/wab.md', undefined, ['infra/wab/src/index.ts']), true)
  assert.equal(
    affected('docs/infrastructure/wab.md', undefined, ['infra/wab-extra/src/index.ts']),
    false
  )
  const walletFiles = ['packages/wallet/wallet-toolbox/src/Wallet.ts']
  for (const [doc, title] of [
    ['docs/architecture/wallet-utxo-lifecycle.md', undefined],
    ['docs/packages/wallet/wallet-toolbox-client.md', '@bsv/wallet-toolbox-client'],
    ['docs/packages/wallet/wallet-toolbox-mobile.md', '@bsv/wallet-toolbox-mobile']
  ]) {
    assert.equal(affected(doc, title, walletFiles), true, doc)
  }
  assert.equal(
    affected('docs/packages/wallet/wallet-relay.md', '@bsv/wallet-relay', [
      'packages/sdk/src/primitives/PrivateKey.ts'
    ]),
    false
  )
})

test('edited pages are selected without expanding root controls or documentation indexes', () => {
  const page = 'docs/architecture/layers.md'
  assert.equal(affected(page, undefined, [page]), true)
  assert.equal(affected(page, undefined, ['docs/index.md']), false)
  assert.equal(affected(page, undefined, []), false)
  assert.equal(affected(page, undefined, null), true)
  for (const file of ['package.json', 'pnpm-lock.yaml', '.github/workflows/ci.yml']) {
    assert.equal(
      affected('docs/packages/wallet/wallet-relay.md', '@bsv/wallet-relay', [file]),
      false
    )
  }
})

test('only selected pages fail on review expiry; date consistency always applies', () => {
  const today = new Date('2026-09-14T00:00:00Z')
  const check = (updated, verified, cadence, selected) =>
    documentationDateFindings(updated, verified, cadence, today, selected)
  assert.deepEqual(check('2026-08-12', '2026-08-12', 30, false), [])
  assert.deepEqual(check('2026-08-12', '2026-08-12', 30, true), ['verification expired 2026-09-11'])
  assert.deepEqual(check('2026-08-15', '2026-08-15', 30, true), [])
  assert.deepEqual(check('2026-09-14', '2026-08-12', 30, false), [
    'last_verified predates last_updated'
  ])
  assert.deepEqual(check('2026-09-15', '2026-09-15', 30, false), [
    'last_verified cannot be in the future'
  ])
})

test('source associations point to current pages and bounded repository paths', () => {
  assert.equal(freshness.scope, 'changed-pages-and-direct-sources')
  for (const [doc, paths] of Object.entries(freshness.sourcePaths)) {
    assert.match(doc, /^docs\/.+\.md$/)
    assert.ok(existsSync(new URL(doc, root)), doc)
    assert.ok(paths.length > 0, doc)
    for (const path of paths) {
      assert.ok(!path.startsWith('/') && !path.split('/').includes('..') && path !== '.', path)
      assert.ok(!path.endsWith('/') && !path.includes('*'), path)
      assert.ok(existsSync(new URL(path, root)), path)
    }
  }
  for (const service of services) {
    assert.ok(existsSync(new URL(`docs/infrastructure/${service.name}.md`, root)))
  }
})

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'documentation-scope-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: directory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim()
  const write = (file, content = file) => writeFileSync(join(directory, file), content)
  const commit = () => {
    git('add', '.')
    git(
      '-c',
      'user.name=Documentation Test',
      '-c',
      'user.email=docs@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture'
    )
    return git('rev-parse', 'HEAD')
  }
  git('init', '--initial-branch=main')
  write('source.ts')
  const base = commit()
  git('update-ref', 'refs/remotes/origin/main', base)
  return { directory, git, write, commit, base }
}

test('PR scope excludes base-branch changes since divergence; push scope includes only its range', t => {
  const { directory, git, write, commit, base } = fixture(t)
  git('switch', '-c', 'topic')
  write('topic.ts')
  const head = commit()
  git('switch', 'main')
  write('unrelated.md')
  const main = commit()
  git('switch', 'topic')
  const eventPath = join(directory, 'event.json')
  write(
    'event.json',
    JSON.stringify({ pull_request: { base: { sha: main }, head: { sha: head } } })
  )
  assert.deepEqual(
    documentationChangedFiles(directory, [], {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'pull_request'
    }),
    ['topic.ts']
  )
  write('event.json', JSON.stringify({ before: base, after: main }))
  assert.deepEqual(
    documentationChangedFiles(directory, [], {
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_EVENT_NAME: 'push'
    }),
    ['unrelated.md']
  )
  assert.deepEqual(documentationChangedFiles(directory, ['--base', main, '--head', head], {}), [
    'topic.ts'
  ])
})

test('local scope includes committed, staged, unstaged, and untracked changes', t => {
  const { directory, git, write, commit } = fixture(t)
  write('committed.ts')
  commit()
  write('staged.ts')
  git('add', 'staged.ts')
  write('source.ts', 'changed')
  write('new page.md')
  assert.deepEqual(documentationChangedFiles(directory, [], {}).sort(), [
    'committed.ts',
    'new page.md',
    'source.ts',
    'staged.ts'
  ])
})

test('renames preserve old and new scope, including filenames with whitespace', t => {
  const { directory, git, commit, base } = fixture(t)
  git('mv', 'source.ts', 'renamed\nsource.ts')
  const head = commit()
  assert.deepEqual(documentationChangedFiles(directory, ['--base', base, '--head', head], {}), [
    'renamed\nsource.ts',
    'source.ts'
  ])
})

test('an initial push selects its files, and an empty push selects none', t => {
  const { directory, write, commit } = fixture(t)
  write('later.ts')
  const head = commit()
  const env = { GITHUB_EVENT_PATH: join(directory, 'event.json'), GITHUB_EVENT_NAME: 'push' }
  write('event.json', JSON.stringify({ before: '0'.repeat(40), after: head }))
  assert.deepEqual(documentationChangedFiles(directory, [], env), ['later.ts', 'source.ts'])
  write('event.json', JSON.stringify({ before: head, after: head }))
  assert.deepEqual(documentationChangedFiles(directory, [], env), [])
})

test('a local checkout without origin/main requires an explicit comparison', t => {
  const { directory, git } = fixture(t)
  git('update-ref', '-d', 'refs/remotes/origin/main')
  assert.throws(() => documentationChangedFiles(directory, [], {}))
  assert.deepEqual(documentationChangedFiles(directory, ['--base', 'HEAD'], {}), [])
})

test('full audit is explicit, and missing or invalid comparisons fail', t => {
  const { directory, write } = fixture(t)
  assert.equal(documentationChangedFiles(directory, ['--all'], {}), null)
  assert.throws(() => documentationChangedFiles(directory, ['--head', 'HEAD'], {}))
  assert.throws(() => documentationChangedFiles(directory, ['--all', '--base', 'HEAD'], {}))
  assert.throws(() => documentationChangedFiles(directory, ['--base', 'missing-ref'], {}))
  assert.throws(() => documentationChangedFiles(directory, ['--unknown'], {}))
  write(
    'event.json',
    JSON.stringify({ pull_request: { base: { sha: 'missing-ref' }, head: { sha: 'HEAD' } } })
  )
  const env = {
    GITHUB_EVENT_PATH: join(directory, 'event.json'),
    GITHUB_EVENT_NAME: 'pull_request'
  }
  assert.throws(() => documentationChangedFiles(directory, [], env))
  assert.deepEqual(
    documentationChangedFiles(directory, [], { ...env, GITHUB_EVENT_NAME: 'workflow_dispatch' }),
    []
  )
})

test('repository policy passes without inheriting elapsed deadlines from an empty change', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/documentation-policy.mjs', '--base', 'HEAD', '--head', 'HEAD'],
    { cwd: root, encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /0 affected pages checked for review expiry/)
})
